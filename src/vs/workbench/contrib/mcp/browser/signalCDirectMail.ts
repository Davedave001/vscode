/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableFromEvent } from '../../../../base/common/observable.js';
import { isNative } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid, isUUID } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { asJson, IRequestService, isSuccess, NO_FETCH_TELEMETRY } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AuthenticationSession, IAuthenticationService, signalCMailOAuth, signalCMailOAuthPrefix, SignalCMailProvider } from '../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { signalCDirectMailConnections } from '../common/signalCAppConnections.js';

const MAIL_STORAGE_PREFIX = 'signalC.directMail.';
const mailProviders = ['gmail', 'outlook'] as const;

interface IMailbox {
	readonly account: string;
	readonly registration?: string;
}

interface IGooglePart {
	readonly mimeType?: string;
	readonly body?: { readonly data?: string };
	readonly filename?: string;
	readonly parts?: readonly IGooglePart[];
	readonly headers?: readonly { readonly name: string; readonly value: string }[];
}

interface IGoogleMessage {
	readonly id: string;
	readonly snippet?: string;
	readonly payload?: IGooglePart;
}

interface IGraphMessage {
	readonly id: string;
	readonly subject?: string;
	readonly from?: { readonly emailAddress?: { readonly address?: string } };
	readonly toRecipients?: readonly { readonly emailAddress?: { readonly address?: string } }[];
	readonly receivedDateTime?: string;
	readonly sentDateTime?: string;
	readonly bodyPreview?: string;
	readonly body?: { readonly contentType?: string; readonly content?: string };
	readonly webLink?: string;
}

export interface ISignalCDirectMailConnection {
	readonly id: string;
	readonly provider: SignalCMailProvider;
	readonly label: string;
	readonly needsSignIn: boolean;
}

export const ISignalCDirectMail = createDecorator<ISignalCDirectMail>('signalCDirectMail');

export interface ISignalCDirectMail {
	readonly _serviceBrand: undefined;
	readonly connections: IObservable<readonly ISignalCDirectMailConnection[]>;
	manage(provider: SignalCMailProvider): Promise<void>;
	read(connection: ISignalCDirectMailConnection, args: Record<string, unknown>, token: CancellationToken): Promise<string>;
}

function googlePlainText(part: IGooglePart | undefined, depth = 0): string | undefined {
	if (!part || part.filename || depth > 5) { return undefined; }
	if (part.mimeType === 'text/plain' && part.body?.data) {
		try { return decodeBase64(part.body.data.slice(0, 32000)).toString().slice(0, 6000); } catch { return undefined; }
	}
	for (const child of part.parts?.slice(0, 20) ?? []) {
		const text = googlePlainText(child, depth + 1);
		if (text) { return text; }
	}
	return undefined;
}

function googleResult(message: IGoogleMessage, full: boolean): object {
	const header = (name: string) => message.payload?.headers?.find(item => item.name.toLowerCase() === name)?.value.slice(0, 400);
	return {
		id: message.id, subject: header('subject'), from: header('from'), to: header('to'), date: header('date'),
		preview: message.snippet?.slice(0, 400), body: full ? googlePlainText(message.payload) : undefined,
		url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
	};
}

function graphResult(message: IGraphMessage, full: boolean): object {
	return {
		id: message.id, subject: message.subject?.slice(0, 400), from: message.from?.emailAddress?.address,
		to: message.toRecipients?.slice(0, 8).map(recipient => recipient.emailAddress?.address),
		received: message.receivedDateTime, sent: message.sentDateTime, preview: message.bodyPreview?.slice(0, 400),
		body: full && message.body?.contentType === 'text' ? message.body.content?.slice(0, 6000) : undefined,
		url: message.webLink?.startsWith('https://') ? message.webLink : undefined,
	};
}

class MailUnauthorizedError extends Error {}

export class SignalCDirectMail extends Disposable implements ISignalCDirectMail {
	declare readonly _serviceBrand: undefined;
	private readonly operations = new SequencerByKey<SignalCMailProvider>();
	private readonly tokenRequests = new SequencerByKey<SignalCMailProvider>();
	readonly connections: IObservable<readonly ISignalCDirectMailConnection[]>;

	constructor(
		@IAuthenticationService private readonly authentication: IAuthenticationService,
		@IDynamicAuthenticationProviderStorageService private readonly grants: IDynamicAuthenticationProviderStorageService,
		@IStorageService private readonly storage: IStorageService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
		@IQuickInputService private readonly input: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IRequestService private readonly requests: IRequestService,
		@IProductService private readonly product: IProductService,
	) {
		super();
		this.connections = observableFromEvent(this, storage.onDidChangeValue(StorageScope.PROFILE, undefined, this._store), () => mailProviders.flatMap(provider => {
			const account = this.account(provider);
			return account ? [{ id: this.connectionId(provider, account), provider, label: signalCDirectMailConnections[provider].name, needsSignIn: this.needsSignIn(provider) }] : [];
		}));
	}

	manage(provider: SignalCMailProvider): Promise<void> {
		return this.operations.queue(provider, async () => {
			if (!isNative) { throw new Error(localize('directMail.desktopOnly', "Direct mail sign-in is available in the Signal-C desktop app.")); }
			const app = signalCDirectMailConnections[provider];
			const key = MAIL_STORAGE_PREFIX + provider;
			const before = this.storage.get(key, StorageScope.PROFILE);
			const mailbox = this.mailbox(provider);
			const baseId = this.baseProviderId(provider);
			const id = this.providerId(provider, mailbox?.registration);
			const registration = await this.grants.getClientRegistration(id);
			const bundledId = this.product.signalCOutlookOAuthClientId;
			const bundled = provider === 'outlook' && bundledId && isUUID(bundledId) ? { clientId: bundledId } : undefined;
			const defaultRegistration = mailbox && registration?.clientId ? registration : bundled ?? registration;
			const { result } = await this.dialogs.prompt({
				type: 'info', custom: true,
				message: localize('directMail.title', "Connect {0}", app.name),
				detail: mailbox && !this.needsSignIn(provider)
					? localize('directMail.connectedDetail', "Assistant can read this mailbox. You can sign in again or use a different OAuth app. The current connection stays available until the new sign-in is verified.")
					: bundled ? localize('directMail.outlookConfiguredApp', "Sign in with a personal Microsoft account or a work or school account to read Outlook mail. Signal-C supplies the OAuth app for this sign-in.") : app.setup,
				buttons: [
					{ label: mailbox ? localize('directMail.reconnect', "Sign In Again") : bundled ? localize('directMail.microsoftSignIn', "Sign In with Microsoft") : localize('directMail.signIn', "Connect with OAuth"), run: () => 'connect' as const },
					...(mailbox && bundled && defaultRegistration?.clientId !== bundled.clientId ? [{
						label: localize('directMail.useBundledOutlookApp', "Use Built-In Microsoft Sign-In"), run: () => 'bundled' as const,
					}] : []),
					...(registration?.clientId || bundled ? [{
						label: localize('directMail.changeApp', "Use Different OAuth App"), run: () => 'replace' as const,
					}] : []),
					...(mailbox || registration?.clientId ? [{
						label: mailbox ? localize('directMail.disconnect', "Disconnect") : localize('directMail.reset', "Reset OAuth Setup"), run: () => 'disconnect' as const,
					}] : []),
					{ label: localize('directMail.guide', "Open Setup Guide"), run: () => 'guide' as const },
				],
				cancelButton: true,
			});
			if (result === 'guide') { await this.opener.open(URI.parse(app.documentation)); return; }
			const stillCurrent = () => baseId === this.baseProviderId(provider) && this.storage.get(key, StorageScope.PROFILE) === before;
			if (!stillCurrent()) { return; }
			if (result === 'disconnect') {
				await this.tokenRequests.queue(provider, async () => {
					if (!stillCurrent()) { return; }
					this.storage.remove(key, StorageScope.PROFILE);
					this.setSignInRequired(provider, false);
					await this.removeProvider(id);
				});
				return;
			}
			if (result !== 'connect' && result !== 'replace' && result !== 'bundled') { return; }
			const selectedRegistration = result === 'connect' ? defaultRegistration : result === 'bundled' ? bundled : undefined;
			const useNewProvider = !!mailbox || result === 'replace' || !!registration?.clientId && selectedRegistration?.clientId !== registration.clientId;
			await this.connect(provider, id, { registration: selectedRegistration, useNewProvider, stillCurrent });
		});
	}

	private async connect(provider: SignalCMailProvider, currentId: string, { registration: saved, useNewProvider, stillCurrent }: {
		readonly registration?: { clientId?: string; clientSecret?: string };
		readonly useNewProvider: boolean;
		readonly stillCurrent: () => boolean;
	}): Promise<void> {
		const name = signalCDirectMailConnections[provider].name;
		const candidate = useNewProvider ? generateUuid() : undefined;
		const id = this.providerId(provider, candidate);
		const clientId = saved?.clientId ?? (await this.input.input({
			title: localize('directMail.clientTitle', "{0} OAuth Client ID", name),
			prompt: localize('directMail.clientPrompt', "Enter the OAuth client ID from your app registration."),
			ignoreFocusLost: true,
			validateInput: async value => (provider === 'gmail' ? /^[a-z0-9.-]+\.apps\.googleusercontent\.com$/i : /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i).test(value.trim())
				? undefined : localize('directMail.clientInvalid', "Enter the public OAuth client ID."),
		}))?.trim();
		if (!clientId) { return; }
		const secret = provider === 'gmail' ? saved?.clientSecret ?? (await this.input.input({
			title: localize('directMail.secretTitle', "Gmail Desktop Client Secret"),
			password: true, ignoreFocusLost: true,
			validateInput: async value => value.trim() ? undefined : localize('directMail.secretRequired', "Enter the Google Desktop client secret."),
		}))?.trim() : undefined;
		if ((provider === 'gmail' && !secret) || !stillCurrent()) { return; }
		let session: AuthenticationSession | undefined;
		let previous: readonly AuthenticationSession[] = [];
		try {
			await this.ensureProvider(provider, id, { clientId, clientSecret: secret });
			if (!candidate) { previous = await this.authentication.getSessions(id); }
			session = await this.authentication.createSession(id, this.scopes(provider));
			if (session.account.id === 'unknown') {
				throw new Error(localize('directMail.noAccount', "Sign-in did not identify a mailbox account. Check that the app supports OpenID Connect."));
			}
			const url = new URL(provider === 'gmail' ? 'gmail/v1/users/me/profile' : 'v1.0/me/mailFolders/inbox/messages?$top=1&$select=id', signalCMailOAuth[provider].resource);
			await this.get(url, session.accessToken, CancellationToken.None);
			const account = session.account.id;
			await this.tokenRequests.queue(provider, async () => {
				if (!stillCurrent()) { throw new CancellationError(); }
				const value = candidate ? JSON.stringify({ account, registration: candidate } satisfies IMailbox) : account;
				this.storage.store(MAIL_STORAGE_PREFIX + provider, value, StorageScope.PROFILE, StorageTarget.MACHINE);
				this.setSignInRequired(provider, false);
			});
		} catch (error) {
			if (candidate) {
				await this.removeProvider(id).catch(() => this.notifyCleanupFailure(name));
			} else if (session) {
				await this.authentication.removeSession(id, session.id).catch(() => this.notifyCleanupFailure(name));
			}
			throw error;
		}
		try {
			if (candidate) {
				await this.removeProvider(currentId);
			} else {
				for (const old of previous) {
					if (old.id !== session.id) { await this.authentication.removeSession(id, old.id); }
				}
			}
		} catch {
			this.notifyCleanupFailure(name);
		}
		this.notifications.info(localize('directMail.verified', "{0} mailbox access verified.", name));
	}

	async read(connection: ISignalCDirectMailConnection, args: Record<string, unknown>, token: CancellationToken): Promise<string> {
		const { provider } = connection;
		const mailbox = this.mailbox(provider);
		const account = mailbox?.account;
		if (!account || connection.id !== this.connectionId(provider, account) || this.needsSignIn(provider)) { throw this.signInRequired(provider); }
		const id = this.providerId(provider, mailbox.registration);
		const isCurrent = () => {
			const current = this.mailbox(provider);
			return current?.account === account && this.providerId(provider, current.registration) === id;
		};
		const session = await this.tokenRequests.queue(provider, async () => {
			if (token.isCancellationRequested || !isCurrent()) { throw new CancellationError(); }
			const saved = await this.grants.getClientRegistration(id);
			if (!saved?.clientId) { return undefined; }
			await this.ensureProvider(provider, id, { clientId: saved.clientId, clientSecret: saved.clientSecret });
			return (await this.authentication.getSessions(id, this.scopes(provider), { silent: true })).find(current => current.account.id === account);
		});
		if (!isCurrent() || token.isCancellationRequested) { throw new CancellationError(); }
		if (!session) {
			this.setSignInRequired(provider, true);
			throw this.signInRequired(provider);
		}
		try {
			const result = await this.readMailbox(provider, session, args, token);
			if (!isCurrent() || token.isCancellationRequested) { throw new CancellationError(); }
			return result;
		} catch (error) {
			if (!(error instanceof MailUnauthorizedError)) { throw error; }
			if (!isCurrent()) { throw new CancellationError(); }
			this.setSignInRequired(provider, true);
			throw this.signInRequired(provider);
		}
	}

	private async readMailbox(provider: SignalCMailProvider, session: AuthenticationSession, args: Record<string, unknown>, token: CancellationToken): Promise<string> {
		const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
		if (messageId && !/^[\w+/=-]{1,1024}$/.test(messageId)) { throw new Error(localize('directMail.invalidMessage', "Use a message ID returned by the mail tool.")); }
		const query = typeof args.query === 'string' ? args.query.trim().slice(0, 400) : '';
		const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(10, Math.max(1, Math.floor(args.limit))) : 5;
		const folder = args.folder === 'sent' ? 'sent' : args.folder === 'all' ? 'all' : 'inbox';
		const get = <T>(url: URL) => this.get<T>(url, session.accessToken, token);
		const base = signalCMailOAuth[provider].resource;
		if (provider === 'gmail') {
			const path = 'gmail/v1/users/me/messages';
			const url = new URL(path, base);
			const getMessage = (id: string, full: boolean) => {
				const messageUrl = new URL(path + '/' + encodeURIComponent(id), base);
				if (!full) { messageUrl.searchParams.set('fields', 'id,snippet,payload(headers)'); }
				messageUrl.searchParams.set('format', 'full');
				return get<IGoogleMessage>(messageUrl);
			};
			if (messageId) { return JSON.stringify(googleResult(await getMessage(messageId, true), true)); }
			url.searchParams.set('maxResults', String(limit));
			if (folder !== 'all') { url.searchParams.set('labelIds', folder === 'sent' ? 'SENT' : 'INBOX'); }
			if (query) { url.searchParams.set('q', query); }
			const listed = await get<{ messages?: readonly { id: string }[] }>(url);
			const messages = await Promise.all((listed.messages ?? []).slice(0, limit).map(({ id }) => getMessage(id, false)));
			return JSON.stringify({ messages: messages.map(message => googleResult(message, false)) });
		}
		const graphFields = 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,webLink';
		const url = new URL(messageId ? `v1.0/me/messages/${encodeURIComponent(messageId)}`
			: folder === 'all' ? 'v1.0/me/messages' : `v1.0/me/mailFolders/${folder === 'sent' ? 'sentitems' : 'inbox'}/messages`, base);
		url.searchParams.set('$select', messageId ? graphFields + ',body' : graphFields);
		if (messageId) { return JSON.stringify(graphResult(await get<IGraphMessage>(url), true)); }
		url.searchParams.set('$top', String(limit));
		if (query) {
			url.searchParams.set('$search', `"${query.replace(/["\\]/g, ' ')}"`);
		} else {
			url.searchParams.set('$orderby', folder === 'sent' ? 'sentDateTime desc' : 'receivedDateTime desc');
		}
		const response = await get<{ value: readonly IGraphMessage[] }>(url);
		return JSON.stringify({ messages: response.value.slice(0, limit).map(message => graphResult(message, false)) });
	}

	private async get<T>(url: URL, accessToken: string, token: CancellationToken): Promise<T> {
		const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
		if (url.origin === 'https://graph.microsoft.com') { headers.Prefer = 'outlook.body-content-type="text"'; }
		let response;
		try {
			response = await this.requests.request({
				url: url.href, type: 'GET', headers, followRedirects: 0, timeout: 20_000,
				disableCache: true, logUrl: false, callSite: NO_FETCH_TELEMETRY,
			}, token);
		} catch (error) {
			if (isCancellationError(error)) { throw error; }
			if (token.isCancellationRequested) { throw new CancellationError(); }
			throw new Error(localize('directMail.requestFailed', "The mailbox read failed. Check the connection and mailbox permissions."));
		}
		if (response.res.statusCode === 401) { throw new MailUnauthorizedError(localize('directMail.unauthorized', "The mailbox authorization was rejected.")); }
		if (!isSuccess(response)) { throw new Error(localize('directMail.httpStatus', "The mail provider returned HTTP {0}. Check mailbox permissions and setup.", response.res.statusCode)); }
		const data = await asJson<T>(response).catch(() => undefined);
		if (token.isCancellationRequested) { throw new CancellationError(); }
		if (data) { return data; }
		throw new Error(localize('directMail.invalidResponse', "The mail provider returned an invalid response."));
	}

	private async ensureProvider(provider: SignalCMailProvider, id: string, registration: { clientId: string; clientSecret?: string }): Promise<void> {
		if (this.authentication.isAuthenticationProviderRegistered(id)) { return; }
		const config = signalCMailOAuth[provider];
		const registrationResult = await this.authentication.createDynamicAuthenticationProvider(
			URI.parse(config.issuer),
			{ issuer: config.issuer, authorization_endpoint: config.authorize, token_endpoint: config.token, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] },
			{ resource: config.resource, resource_name: signalCDirectMailConnections[provider].name },
			registration.clientId, registration.clientSecret, id
		);
		if (!registrationResult) { throw new Error(localize('directMail.authUnavailable', "The desktop sign-in host is unavailable. Try again after Signal-C finishes opening.")); }
	}

	private scopes(provider: SignalCMailProvider): string[] {
		return [signalCMailOAuth[provider].scope, 'openid', ...(provider === 'gmail' ? ['email'] : ['profile', 'offline_access'])];
	}

	private baseProviderId(provider: SignalCMailProvider): string {
		return `${signalCMailOAuthPrefix}${provider}:${encodeURIComponent(this.profiles.currentProfile.id)}`;
	}

	private providerId(provider: SignalCMailProvider, registration?: string): string {
		const base = this.baseProviderId(provider);
		return registration ? `${base}:${registration}` : base;
	}

	private async removeProvider(id: string): Promise<void> {
		if (this.authentication.isAuthenticationProviderRegistered(id)) { this.authentication.unregisterAuthenticationProvider(id); }
		await this.grants.removeDynamicProvider(id);
	}

	private notifyCleanupFailure(name: string): void {
		this.notifications.warn(localize('directMail.cleanupFailed', "Could not remove unused {0} OAuth credentials.", name));
	}

	private connectionId(provider: SignalCMailProvider, account: string): string {
		return JSON.stringify(['signal-c-direct-mail', provider, account]);
	}

	private account(provider: SignalCMailProvider): string | undefined {
		return this.mailbox(provider)?.account;
	}

	private mailbox(provider: SignalCMailProvider): IMailbox | undefined {
		const value = this.storage.get(MAIL_STORAGE_PREFIX + provider, StorageScope.PROFILE);
		if (!value) { return undefined; }
		if (value.startsWith('{')) {
			try {
				const stored = JSON.parse(value) as Partial<IMailbox> | undefined;
				if (typeof stored?.account === 'string' && stored.account && typeof stored.registration === 'string' && isUUID(stored.registration)) {
					return { account: stored.account, registration: stored.registration };
				}
			} catch {
				// Older versions stored the provider subject as plain text.
			}
		}
		return { account: value };
	}

	private needsSignIn(provider: SignalCMailProvider): boolean {
		return this.storage.getBoolean(MAIL_STORAGE_PREFIX + provider + '.needsSignIn', StorageScope.PROFILE, false);
	}

	private setSignInRequired(provider: SignalCMailProvider, value: boolean): void {
		this.storage.store(MAIL_STORAGE_PREFIX + provider + '.needsSignIn', value, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private signInRequired(provider: SignalCMailProvider): Error {
		return new Error(localize('directMail.signInRequired', "Sign in to {0} from Assistant’s Connections and try again.", signalCDirectMailConnections[provider].name));
	}
}

registerSingleton(ISignalCDirectMail, SignalCDirectMail, InstantiationType.Delayed);
