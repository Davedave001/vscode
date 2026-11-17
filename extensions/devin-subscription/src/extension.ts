/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { signInToDevin } from './auth';

const PROVIDER_ID = 'devin-subscription';
const SESSION_KEY = 'devin.subscription.session.v1';

function sameSession(first: vscode.AuthenticationSession, second: vscode.AuthenticationSession): boolean {
	return first.id === second.id && first.accessToken === second.accessToken && first.account.id === second.account.id && first.account.label === second.account.label;
}

class DevinSubscriptionAuthentication implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this.changeEmitter.event;
	private pending: Promise<vscode.AuthenticationSession> | undefined;
	private readonly controllers = new Set<AbortController>();
	private storageMutation: Promise<void> = Promise.resolve();
	private disposed = false;
	private sessionsSnapshot: readonly vscode.AuthenticationSession[] = [];
	private readonly secretListener: vscode.Disposable;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.storageMutation = this.getSessions().then(sessions => { this.sessionsSnapshot = sessions; }, () => { });
		this.secretListener = secrets.onDidChange(event => {
			if (event.key !== SESSION_KEY) { return; }
			void this.mutateStorage(async () => {
				if (this.disposed) { return; }
				const sessions = await this.getSessions();
				this.publishSessions(sessions, true);
			}).catch(() => console.warn('[Devin Subscription] Shared sign-in state could not be refreshed.'));
		});
	}

	async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		if (scopes?.length) { return []; }
		const stored = await this.secrets.get(SESSION_KEY);
		if (!stored) { return []; }
		try {
			const session: vscode.AuthenticationSession = JSON.parse(stored);
			return typeof session.id === 'string' && typeof session.accessToken === 'string' && !!session.accessToken && typeof session.account?.id === 'string' && typeof session.account.label === 'string' && Array.isArray(session.scopes) && session.scopes.length === 0 ? [session] : [];
		} catch { return []; }
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		if (this.disposed) { throw new vscode.CancellationError(); }
		if (scopes.length) { throw new Error(vscode.l10n.t('Devin subscription sign-in does not support custom scopes.')); }
		if (this.pending) { return this.pending; }
		this.pending = this.signIn();
		try { return await this.pending; } finally { this.pending = undefined; }
	}

	private async signIn(): Promise<vscode.AuthenticationSession> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Signing in to Devin Subscription…'), cancellable: true }, async (progress, cancellation) => {
			const controller = new AbortController();
			this.controllers.add(controller);
			const disposable = cancellation.onCancellationRequested(() => controller.abort());
			const selectionCancellation = new vscode.CancellationTokenSource();
			const cancelSelection = () => selectionCancellation.cancel();
			controller.signal.addEventListener('abort', cancelSelection, { once: true });
			try {
				const method = await vscode.window.showQuickPick([
					{ label: vscode.l10n.t('Browser Sign-In'), description: vscode.l10n.t('Return automatically to Signal-C'), manual: false },
					{ label: vscode.l10n.t('Browser Code'), description: vscode.l10n.t('Use if the browser opens but sign-in does not finish'), manual: true },
				], { title: vscode.l10n.t('Devin Subscription'), placeHolder: vscode.l10n.t('Choose how to complete browser sign-in') }, selectionCancellation.token);
				if (!method || this.disposed) { throw new vscode.CancellationError(); }
				const initialSessions = await this.getSessions();
				controller.signal.throwIfAborted();
				const token = await signInToDevin({
					openExternal: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
					signal: controller.signal,
					readAuthorizationCode: method.manual ? async signal => {
						const inputCancellation = new vscode.CancellationTokenSource();
						const cancel = () => inputCancellation.cancel();
						signal.addEventListener('abort', cancel, { once: true });
						if (signal.aborted) { inputCancellation.cancel(); }
						try {
							const code = await vscode.window.showInputBox({
								title: vscode.l10n.t('Devin Subscription — Browser Code'),
								prompt: vscode.l10n.t('Finish sign-in in the Devin browser page, then paste the authorization code shown there.'),
								password: true, ignoreFocusOut: true,
								validateInput: value => !value || value.length > 8192 || /\s/.test(value) ? vscode.l10n.t('Paste only the authorization code shown by Devin.') : undefined,
							}, inputCancellation.token);
							if (code === undefined && !signal.aborted) { controller.abort(); }
							return code;
						} finally {
							signal.removeEventListener('abort', cancel);
							inputCancellation.dispose();
						}
					} : undefined,
					onProgress: stage => {
						const message = stage === 'waitingForBrowser'
							? vscode.l10n.t('Waiting for approval in the Devin browser page. Keep this window open.')
							: stage === 'waitingForCode'
								? vscode.l10n.t('Complete browser sign-in, then paste its authorization code into Signal-C.')
								: vscode.l10n.t('Browser approval received. Connecting to Devin…');
						progress.report({ message });
						// Record phases only; callback URLs, authorization codes and tokens are private.
						console.info(`[Devin Subscription] ${stage}`);
					},
				});
				progress.report({ message: vscode.l10n.t('Saving Devin sign-in securely…') });
				return await this.mutateStorage(async () => {
					controller.signal.throwIfAborted();
					const previous = await this.getSessions();
					// Storage notifications can be queued behind this mutation. Re-read the account
					// before writing so a sign-out/replacement already visible in storage wins.
					if (previous.length !== initialSessions.length || previous.some((session, index) => !sameSession(session, initialSessions[index]))) { controller.abort(); }
					controller.signal.throwIfAborted();
					// The response does not identify the account. A new login may be
					// another person, so never inherit the previous account's grants.
					const id = randomUUID();
					const session: vscode.AuthenticationSession = { id, accessToken: token, account: { id, label: vscode.l10n.t('Devin account') }, scopes: [] };
					await this.secrets.store(SESSION_KEY, JSON.stringify(session));
					if (controller.signal.aborted) {
						if (previous.length) { await this.secrets.store(SESSION_KEY, JSON.stringify(previous[0])); } else { await this.secrets.delete(SESSION_KEY); }
						controller.signal.throwIfAborted();
					}
					this.publishSessions([session]);
					return session;
				});
			} catch (error) {
				if (controller.signal.aborted) { throw new vscode.CancellationError(); }
				throw error;
			} finally {
				controller.signal.removeEventListener('abort', cancelSelection);
				selectionCancellation.dispose();
				disposable.dispose();
				this.controllers.delete(controller);
			}
		});
	}

	async removeSession(id: string): Promise<void> {
		for (const controller of this.controllers) { controller.abort(); }
		await this.mutateStorage(async () => {
			const sessions = await this.getSessions();
			const removed = sessions.filter(session => session.id === id);
			if (removed.length) {
				await this.secrets.delete(SESSION_KEY);
				this.publishSessions(sessions.filter(session => session.id !== id));
			}
		});
	}

	private mutateStorage<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.storageMutation.then(operation);
		this.storageMutation = result.then(() => { }, () => { });
		return result;
	}

	private publishSessions(sessions: readonly vscode.AuthenticationSession[], cancelPending = false): void {
		if (this.disposed) { return; }
		const previous = this.sessionsSnapshot;
		const added = sessions.filter(session => !previous.some(old => old.id === session.id));
		const removed = previous.filter(session => !sessions.some(next => next.id === session.id));
		const changed = sessions.filter(session => previous.some(old => old.id === session.id && !sameSession(old, session)));
		this.sessionsSnapshot = sessions;
		if (!added.length && !removed.length && !changed.length) { return; }
		if (cancelPending) {
			// An account change in another window supersedes this window's pending attempt.
			for (const controller of this.controllers) { controller.abort(); }
		}
		this.changeEmitter.fire({ added, changed, removed });
	}

	dispose(): void {
		this.disposed = true;
		this.secretListener.dispose();
		for (const controller of this.controllers) { controller.abort(); }
		this.changeEmitter.dispose();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new DevinSubscriptionAuthentication(context.secrets);
	context.subscriptions.push(provider, vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, 'Devin Subscription', provider, { supportsMultipleAccounts: false }));
}
