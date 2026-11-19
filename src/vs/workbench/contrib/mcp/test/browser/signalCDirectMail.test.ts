/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer, bufferToStream } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { AuthenticationSession, IAuthenticationProvider, IAuthenticationService, isSignalCMailOAuth, signalCMailOAuth } from '../../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { SignalCDirectMail } from '../../browser/signalCDirectMail.js';

suite('Signal-C direct mail', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	for (const provider of ['gmail', 'outlook'] as const) {
		test(`verifies ${provider} over REST, reads sent mail and recovers from a rejected grant`, async () => {
			const config = signalCMailOAuth[provider];
			const bundledOutlookId = '4aaa0011-bbbb-4ccc-8ddd-eeee12345678';
			const storage = disposables.add(new InMemoryStorageService());
			const token = 'fixture-access-token';
			const session = { id: 'fixture', accessToken: token, account: { id: 'subject-1', label: 'Fixture' }, scopes: [config.scope] };
			const requests: URL[] = [];
			let responseStatus = 200;
			let registeredId: string | undefined;
			let sessionCreated = false;
			let savedCleared = false;
			let manageChoice: 'connect' | 'disconnect' = 'connect';
			const build = () => disposables.add(new SignalCDirectMail(
				upcastPartial<IAuthenticationService>({
					isAuthenticationProviderRegistered: id => id === registeredId,
					createDynamicAuthenticationProvider: async (issuer, metadata, resource, client, _secret, id) => {
						assert.ok(id && isSignalCMailOAuth(id, issuer, metadata, resource?.resource));
						assert.ok(id.endsWith(':test-profile'));
						assert.strictEqual(client, provider === 'outlook' ? bundledOutlookId : 'fixture-client-id');
						registeredId = id;
						return upcastPartial<IAuthenticationProvider>({ id });
					},
					getSessions: async (_id, scopes, options) => {
						if (scopes) {
							assert.ok(Array.isArray(scopes) && scopes.includes(config.scope));
							assert.strictEqual(options?.silent, true);
						}
						return sessionCreated ? [session] : [];
					},
					createSession: async (_id, scopes) => {
						assert.ok(Array.isArray(scopes) && scopes.includes(config.scope));
						assert.ok(Array.isArray(scopes) && scopes.includes('openid'));
						sessionCreated = true;
						return session;
					},
					unregisterAuthenticationProvider: () => { registeredId = undefined; },
				}),
				upcastPartial<IDynamicAuthenticationProviderStorageService>({
					getClientRegistration: async () => provider === 'outlook'
						? (sessionCreated ? { clientId: bundledOutlookId } : undefined)
						: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' },
					removeDynamicProvider: async () => { savedCleared = true; },
				}),
				storage,
				upcastPartial<IUserDataProfileService>({ currentProfile: { id: 'test-profile' } as IUserDataProfileService['currentProfile'] }),
				upcastPartial<IQuickInputService>({}),
				upcastPartial<IDialogService>({
					prompt: async options => {
						if (provider === 'outlook' && manageChoice === 'connect') {
							assert.strictEqual(options.buttons?.[0].label, 'Sign In with Microsoft');
						}
						return { result: manageChoice as never };
					},
				}),
				upcastPartial<IOpenerService>({}),
				upcastPartial<INotificationService>({ info: () => undefined }),
				upcastPartial<IRequestService>({
					request: async options => {
						assert.ok(options.url);
						const url = new URL(options.url);
						requests.push(url);
						assert.strictEqual(url.origin, new URL(config.resource).origin);
						assert.strictEqual(options.type, 'GET');
						assert.strictEqual(options.followRedirects, 0);
						assert.strictEqual(options.disableCache, true);
						assert.strictEqual(options.logUrl, false);
						assert.strictEqual(options.headers?.Authorization, `Bearer ${token}`);
						const graphMail = { id: 'msg1', subject: 'A recent message', bodyPreview: 'Fixture preview', body: { contentType: 'text', content: 'Fixture body' } };
						const data = provider === 'outlook' ? url.pathname.endsWith('/msg1') ? graphMail : { value: [graphMail] }
							: url.pathname.endsWith('/profile') ? { messagesTotal: 1 }
								: url.pathname.endsWith('/messages') ? { messages: [{ id: 'msg1' }] }
									: { id: 'msg1', snippet: 'Fixture preview', payload: { mimeType: 'text/plain', body: { data: 'Rml4dHVyZSBib2R5' }, headers: [{ name: 'Subject', value: 'A recent message' }] } };
						return { res: { statusCode: responseStatus, headers: {} }, stream: bufferToStream(VSBuffer.fromString(JSON.stringify(data))) };
					},
				}),
				upcastPartial<IProductService>({ signalCOutlookOAuthClientId: bundledOutlookId }),
			));
			const mail = build();
			await mail.manage(provider);
			assert.strictEqual(mail.connections.get()[0]?.needsSignIn, false);
			assert.match(requests[0].pathname, provider === 'gmail' ? /\/me\/profile$/ : /\/me\/mailFolders\/inbox\/messages$/);
			assert.ok(!storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE).some(key => storage.get(key, StorageScope.PROFILE)?.includes(token)));

			registeredId = undefined;
			const reopened = build();
			const connection = reopened.connections.get()[0];
			const result = JSON.parse(await reopened.read(connection, { folder: 'sent', query: 'invoice', limit: 2 }, CancellationToken.None));
			assert.strictEqual(result.messages[0].subject, 'A recent message');
			assert.ok(!JSON.stringify(result).includes(token));
			assert.strictEqual(requests[1].searchParams.get(provider === 'gmail' ? 'q' : '$search'), provider === 'gmail' ? 'invoice' : '"invoice"');
			if (provider === 'gmail') {
				assert.strictEqual(requests[1].searchParams.get('labelIds'), 'SENT');
				assert.strictEqual(requests[2].pathname, '/gmail/v1/users/me/messages/msg1');
			} else {
				assert.strictEqual(requests[1].pathname, '/v1.0/me/mailFolders/sentitems/messages');
			}
			assert.strictEqual(JSON.parse(await reopened.read(connection, { messageId: 'msg1' }, CancellationToken.None)).body, 'Fixture body');

			responseStatus = 401;
			await assert.rejects(reopened.read(connection, {}, CancellationToken.None), /Sign in to/);
			assert.strictEqual(reopened.connections.get()[0].needsSignIn, true);
			const afterUnauthorized = requests.length;
			await assert.rejects(reopened.read(connection, {}, CancellationToken.None), /Sign in to/);
			assert.strictEqual(requests.length, afterUnauthorized);

			manageChoice = 'disconnect';
			await reopened.manage(provider);
			assert.deepStrictEqual(reopened.connections.get(), []);
			assert.ok(savedCleared);
		});

		test(`keeps the verified ${provider} mailbox until an OAuth app replacement is verified`, async () => {
			const storage = disposables.add(new InMemoryStorageService());
			const baseId = `signal-c-mail:${provider}:test-profile`;
			const mailboxKey = `signalC.directMail.${provider}`;
			const scope = signalCMailOAuth[provider].scope;
			const original = { id: 'original', accessToken: 'old-fixture', account: { id: 'subject', label: 'Fixture' }, scopes: [scope] };
			storage.store(mailboxKey, original.account.id, StorageScope.PROFILE, StorageTarget.MACHINE);
			const registrations = new Map([[baseId, { clientId: 'original-client', clientSecret: provider === 'gmail' ? 'original-fixture-secret' : undefined }]]);
			const sessions = new Map<string, AuthenticationSession>([[baseId, original]]);
			const registered = new Set([baseId]);
			const removed: string[] = [];
			const checkedTokens: string[] = [];
			const inputValues = [provider === 'gmail' ? 'fixture.apps.googleusercontent.com' : '4aaa0011-bbbb-4ccc-8ddd-eeee12345678', 'new-fixture-secret'];
			let inputIndex = 0;
			let choice: 'replace' | 'connect' | 'disconnect' = 'replace';
			let cancelSignIn = true;
			let nextStatus = 403;
			const delayedOldRead = { started: new DeferredPromise<void>(), finish: new DeferredPromise<void>() };
			let blockOldRead = false;
			const mail = disposables.add(new SignalCDirectMail(
				upcastPartial<IAuthenticationService>({
					isAuthenticationProviderRegistered: id => registered.has(id),
					createDynamicAuthenticationProvider: async (issuer, metadata, resource, clientId, clientSecret, id) => {
						assert.ok(id && clientId && isSignalCMailOAuth(id, issuer, metadata, resource?.resource));
						assert.ok(id.startsWith(baseId + ':'));
						registrations.set(id, { clientId, clientSecret });
						registered.add(id);
						return upcastPartial<IAuthenticationProvider>({ id });
					},
					getSessions: async id => sessions.has(id) ? [sessions.get(id)!] : [],
					createSession: async id => {
						if (cancelSignIn) { throw new CancellationError(); }
						const session = { ...original, id, accessToken: 'replacement-fixture' };
						sessions.set(id, session);
						return session;
					},
					unregisterAuthenticationProvider: id => { registered.delete(id); },
				}),
				upcastPartial<IDynamicAuthenticationProviderStorageService>({
					getClientRegistration: async id => registrations.get(id),
					removeDynamicProvider: async id => { removed.push(id); registrations.delete(id); sessions.delete(id); },
				}),
				storage,
				upcastPartial<IUserDataProfileService>({ currentProfile: { id: 'test-profile' } as IUserDataProfileService['currentProfile'] }),
				upcastPartial<IQuickInputService>({
					input: async options => {
						assert.strictEqual(!!options?.password, inputIndex === 1);
						const value = inputValues[inputIndex++];
						assert.strictEqual(await options?.validateInput?.(value), undefined);
						return value;
					},
				}),
				upcastPartial<IDialogService>({
					prompt: async options => {
						if (choice === 'replace') { assert.ok(options.buttons?.some(button => button.label === 'Use Different OAuth App')); }
						return { result: choice as never };
					},
				}),
				upcastPartial<IOpenerService>({}),
				upcastPartial<INotificationService>({ info: () => undefined }),
				upcastPartial<IRequestService>({
					request: async options => {
						const authorization = options.headers?.Authorization;
						assert.ok(typeof authorization === 'string');
						checkedTokens.push(authorization);
						let status = authorization === 'Bearer replacement-fixture' ? nextStatus : 200;
						if (authorization === 'Bearer old-fixture' && blockOldRead) {
							await delayedOldRead.started.complete();
							await delayedOldRead.finish.p;
							status = 401;
						}
						return { res: { statusCode: status, headers: {} }, stream: bufferToStream(VSBuffer.fromString('{"value":[],"messages":[]}')) };
					},
				}),
				upcastPartial<IProductService>({}),
			));
			const connection = mail.connections.get()[0];
			await assert.rejects(mail.manage(provider), CancellationError);
			await mail.read(connection, {}, CancellationToken.None);
			assert.deepStrictEqual([...registrations.keys()], [baseId]);
			assert.strictEqual(checkedTokens.at(-1), 'Bearer old-fixture');

			cancelSignIn = false;
			choice = 'connect';
			await assert.rejects(mail.manage(provider), /HTTP 403/);
			assert.deepStrictEqual([...registrations.keys()], [baseId]);
			assert.strictEqual(storage.get(mailboxKey, StorageScope.PROFILE), original.account.id);
			assert.deepStrictEqual(mail.connections.get()[0], connection);

			choice = 'replace';
			inputIndex = 0;
			blockOldRead = true;
			const oldRead = assert.rejects(mail.read(connection, {}, CancellationToken.None), CancellationError);
			await delayedOldRead.started.p;
			nextStatus = 200;
			await mail.manage(provider);
			await delayedOldRead.finish.complete();
			await oldRead;
			assert.strictEqual(mail.connections.get()[0].needsSignIn, false);
			assert.strictEqual(mail.connections.get()[0].id, connection.id);
			assert.strictEqual(removed.at(-1), baseId);
			const [replacementId] = registrations.keys();
			assert.ok(replacementId.startsWith(baseId + ':'));
			assert.notStrictEqual(replacementId, baseId);
			assert.strictEqual(registrations.get(replacementId)?.clientId, inputValues[0]);
			await mail.read(connection, {}, CancellationToken.None);
			assert.strictEqual(checkedTokens.at(-1), 'Bearer replacement-fixture');
			assert.ok(!storage.get(mailboxKey, StorageScope.PROFILE)?.includes('fixture-secret'));

			choice = 'disconnect';
			await mail.manage(provider);
			assert.deepStrictEqual(mail.connections.get(), []);
			assert.deepStrictEqual([...registrations.keys()], []);
		});
	}
});
