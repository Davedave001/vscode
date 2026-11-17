/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { autorun } from '../../../../../base/common/observable.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { DevinSubscriptionProviderId, DevinSubscriptionResource } from '../../../../../platform/agentHost/common/devinAgentConfiguration.js';
import { RootState } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationService } from '../../../../../workbench/services/authentication/common/authentication.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { DevinSubscriptionConnection } from '../../browser/devinSubscriptionConnection.js';

suite('Devin Subscription Connection', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	function fixture(registered = true, modelCount = 1, signedIn = true) {
		const changes = store.add(new Emitter<{ providerId: string; label: string; event: AuthenticationSessionsChangeEvent }>());
		const starts = store.add(new Emitter<void>());
		const rootChanges = store.add(new Emitter<RootState>());
		const forwarded = store.add(new Emitter<string>());
		let sessions: AuthenticationSession[] = signedIn ? [{ id: 'browser-session', accessToken: 'browser-token', scopes: [], account: { id: 'account', label: 'Devin account' } }] : [];
		let createSession = async (): Promise<AuthenticationSession> => { throw new Error('Sign-in should not be needed'); };
		let signIns = 0;
		const tokens: string[] = [];
		const agent: RootState['agents'][number] = { provider: DevinSubscriptionProviderId, displayName: 'Devin Subscription', description: '', models: Array.from({ length: modelCount }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}`, provider: DevinSubscriptionProviderId })), protectedResources: [{ resource: DevinSubscriptionResource }] };
		const root: RootState = { agents: registered ? [agent] : [] };
		let authenticate = async (_token: string) => ({ authenticated: true });
		const authentication = upcastPartial<IAuthenticationService>({
			onDidChangeSessions: changes.event,
			getSessions: async () => sessions,
			createSession: async () => {
				signIns++;
				const session = await createSession();
				const removed = sessions;
				sessions = [session];
				changes.fire({ providerId: DevinSubscriptionProviderId, label: 'Devin Subscription', event: { added: [session], removed, changed: [] } });
				return session;
			},
		});
		const host = upcastPartial<IAgentHostService>({
			onAgentHostStart: starts.event,
			rootState: upcastPartial<IAgentHostService['rootState']>({ value: root, onDidChange: rootChanges.event }),
			authenticate: async request => { assert.strictEqual(request.resource, DevinSubscriptionResource); tokens.push(request.token); forwarded.fire(request.token); return authenticate(request.token); },
		});
		const connection = store.add(new DevinSubscriptionConnection(authentication, host, upcastPartial<IExtensionService>({ whenInstalledExtensionsRegistered: async () => true }), new NullLogService()));
		return {
			connection, tokens, forwarded, starts, get signIns() { return signIns; },
			setAuthenticate: (handler: typeof authenticate) => { authenticate = handler; },
			setCreateSession: (handler: typeof createSession) => { createSession = handler; },
			setModels: (count: number) => { agent.models = Array.from({ length: count }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}`, provider: DevinSubscriptionProviderId })); rootChanges.fire(root); },
			setRegistered: (registered: boolean) => { root.agents = registered ? [agent] : []; rootChanges.fire(root); },
			signOut: () => { const removed = sessions; sessions = []; changes.fire({ providerId: DevinSubscriptionProviderId, label: 'Devin Subscription', event: { removed, added: [], changed: [] } }); },
		};
	}

	test('reuses the saved browser account and publishes it to the native provider once', async () => {
		const f = fixture();
		await f.connection.connect();
		await f.connection.connect();
		assert.strictEqual(f.signIns, 0);
		assert.deepStrictEqual(f.tokens, ['browser-token']);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'ready', modelCount: 1 });
	});

	test('can replace a saved browser sign-in after the host rejects its connection', async () => {
		const f = fixture();
		f.setAuthenticate(async () => ({ authenticated: false }));
		await assert.rejects(f.connection.connect(), /Restart the agent host/);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'failed' });
		const started = new DeferredPromise<void>();
		const replacement = new DeferredPromise<AuthenticationSession>();
		f.setCreateSession(async () => { await started.complete(); return replacement.p; });
		const connecting = f.connection.connect({ forceSignIn: true });
		await started.p;
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'signingIn' });
		f.setAuthenticate(async () => ({ authenticated: true }));
		await replacement.complete({ id: 'replacement', accessToken: 'replacement-token', account: { id: 'replacement', label: 'Replacement account' }, scopes: [] });
		await connecting;
		assert.strictEqual(f.signIns, 1);
		assert.strictEqual(f.tokens.at(-1), 'replacement-token');
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'ready', modelCount: 1 });
	});

	for (const reason of ['Sign-in cancelled', 'Browser sign-in failed']) {
		test(`preserves a saved connection when reauthentication ends with ${reason}`, async () => {
			const f = fixture();
			await f.connection.connect();
			f.setCreateSession(async () => { throw new Error(reason); });
			await assert.rejects(f.connection.connect({ forceSignIn: true }), error => error instanceof Error && error.message === reason);
			await f.connection.connect();
			assert.strictEqual(f.signIns, 1);
			assert.deepStrictEqual(f.tokens, ['browser-token']);
			assert.deepStrictEqual(f.connection.status.get(), { kind: 'ready', modelCount: 1 });
		});
	}

	test('withdraws an unknown host credential when signed out, including after restart', async () => {
		const f = fixture(true, 1, false);
		const initial = Event.toPromise(f.forwarded.event);
		assert.strictEqual(await initial, '');
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'signedOut' });
		const restarted = Event.toPromise(f.forwarded.event);
		f.starts.fire();
		assert.strictEqual(await restarted, '');
		assert.deepStrictEqual(f.tokens, ['', '']);
		assert.strictEqual(f.signIns, 0);
	});

	test('reports browser sign-in in progress and returns to signed-out status after cancellation', async () => {
		const f = fixture(true, 1, false);
		await Event.toPromise(f.forwarded.event);
		const started = new DeferredPromise<void>();
		const signIn = new DeferredPromise<AuthenticationSession>();
		f.setCreateSession(async () => { await started.complete(); return signIn.p; });
		const connecting = f.connection.connect();
		const rejected = assert.rejects(connecting, /Sign-in cancelled/);
		await started.p;
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'signingIn' });
		await signIn.error(new Error('Sign-in cancelled'));
		await rejected;
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'signedOut' });
		assert.strictEqual(f.signIns, 1);
	});

	test('does not forward a token to a host that has not advertised the Devin provider', async () => {
		const f = fixture(false);
		await assert.rejects(f.connection.connect(), /has not loaded Devin Subscription/);
		assert.deepStrictEqual(f.tokens, []);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'unavailable' });
	});

	test('waits for the root model catalog and lets an explicit retry refresh an empty catalog', async () => {
		const f = fixture(true, 0);
		await f.connection.connect();
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'connecting' });
		const previous = f.tokens.length;
		await f.connection.connect();
		assert.strictEqual(f.tokens.length, previous + 1);
		assert.strictEqual(f.signIns, 0);
		f.setModels(3);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'ready', modelCount: 3 });
		f.setModels(0);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'connecting' });
	});

	test('a catalog alone does not mark a rejected credential ready and retry reuses sign-in', async () => {
		const f = fixture();
		f.setAuthenticate(async () => ({ authenticated: false }));
		await assert.rejects(f.connection.connect(), /Restart the agent host/);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'failed' });
		f.setAuthenticate(async () => ({ authenticated: true }));
		await f.connection.connect();
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'ready', modelCount: 1 });
		assert.strictEqual(f.signIns, 0);
	});

	for (const change of ['restart', 'signOut', 'providerRemoved'] as const) {
		test(`ignores an acknowledgment invalidated by ${change}`, async () => {
			const f = fixture();
			const pending = new DeferredPromise<{ authenticated: boolean }>();
			const next = new DeferredPromise<{ authenticated: boolean }>();
			let requests = 0;
			f.setAuthenticate(async () => ++requests === 1 ? pending.p : next.p);
			const initial = Event.toPromise(f.forwarded.event);
			const connected = f.connection.connect();
			await initial;
			if (change === 'restart') { f.starts.fire(); }
			else if (change === 'signOut') { f.signOut(); }
			else { f.setRegistered(false); }
			const states: string[] = [];
			store.add(autorun(reader => states.push(f.connection.status.read(reader).kind)));
			const forwarded = change === 'providerRemoved' ? undefined : Event.toPromise(f.forwarded.event);
			await pending.complete({ authenticated: true });
			if (forwarded) { await forwarded; }
			assert.ok(!states.includes('ready'));
			await next.complete({ authenticated: true });
			if (change === 'providerRemoved') {
				await assert.rejects(connected, /has not loaded Devin Subscription/);
				assert.deepStrictEqual(f.connection.status.get(), { kind: 'unavailable' });
			} else {
				await connected;
				assert.deepStrictEqual(f.connection.status.get(), change === 'signOut' ? { kind: 'signedOut' } : { kind: 'ready', modelCount: 1 });
			}
		});
	}

	test('forwards again after the provider disappears and returns without a host-start event', async () => {
		const f = fixture();
		await f.connection.connect();
		f.setRegistered(false);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'unavailable' });
		f.setRegistered(true);
		await f.connection.connect();
		assert.deepStrictEqual(f.tokens, ['browser-token', 'browser-token']);
		assert.deepStrictEqual(f.connection.status.get(), { kind: 'ready', modelCount: 1 });
	});

	test('withdraws credentials on sign-out and forwards a saved account after host restart', async () => {
		const f = fixture();
		await f.connection.connect();
		const restarted = Event.toPromise(f.forwarded.event);
		f.starts.fire();
		assert.strictEqual(await restarted, 'browser-token');
		const signedOut = Event.toPromise(f.forwarded.event);
		f.signOut();
		assert.strictEqual(await signedOut, '');
		assert.deepStrictEqual(f.tokens, ['browser-token', 'browser-token', '']);
	});
});
