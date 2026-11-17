/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { signInToDevin } from './auth';

const PROVIDER_ID = 'devin-subscription';
const SESSION_KEY = 'devin.subscription.session.v1';

class DevinSubscriptionAuthentication implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this.changeEmitter.event;
	private pending: Promise<vscode.AuthenticationSession> | undefined;
	private readonly controllers = new Set<AbortController>();

	constructor(private readonly secrets: vscode.SecretStorage) { }

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
		if (scopes.length) { throw new Error(vscode.l10n.t('Devin subscription sign-in does not support custom scopes.')); }
		if (this.pending) { return this.pending; }
		this.pending = this.signIn();
		try { return await this.pending; } finally { this.pending = undefined; }
	}

	private async signIn(): Promise<vscode.AuthenticationSession> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Signing in to Devin Subscription…'), cancellable: true }, async (_progress, cancellation) => {
			const controller = new AbortController();
			this.controllers.add(controller);
			const disposable = cancellation.onCancellationRequested(() => controller.abort());
			try {
				const token = await signInToDevin({ openExternal: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))), signal: controller.signal });
				controller.signal.throwIfAborted();
				const previous = await this.getSessions();
				const id = previous[0]?.id ?? randomUUID();
				const session: vscode.AuthenticationSession = { id, accessToken: token, account: { id, label: vscode.l10n.t('Devin account') }, scopes: [] };
				await this.secrets.store(SESSION_KEY, JSON.stringify(session));
				this.changeEmitter.fire({ added: previous.length ? [] : [session], changed: previous.length ? [session] : [], removed: [] });
				return session;
			} finally {
				disposable.dispose();
				this.controllers.delete(controller);
			}
		});
	}

	async removeSession(id: string): Promise<void> {
		const sessions = await this.getSessions();
		const removed = sessions.filter(session => session.id === id);
		if (removed.length) {
			await this.secrets.delete(SESSION_KEY);
			this.changeEmitter.fire({ added: [], changed: [], removed });
		}
	}

	dispose(): void {
		for (const controller of this.controllers) { controller.abort(); }
		this.changeEmitter.dispose();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new DevinSubscriptionAuthentication(context.secrets);
	context.subscriptions.push(provider, vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, 'Devin Subscription', provider, { supportsMultipleAccounts: false }));
}
