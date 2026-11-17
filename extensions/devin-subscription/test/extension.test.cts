/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationSession, Disposable } from 'vscode';
import type { SignInOptions } from '../src/auth.ts';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const Module: { _load(this: unknown, name: string, parent?: NodeModule, isMain?: boolean): unknown } = require('node:module');
const { test }: typeof import('node:test') = require('node:test');
const { signInToDevin }: typeof import('../src/auth.ts') = require('../out/auth.js');

interface TestProvider extends Disposable {
	getSessions(scopes?: readonly string[]): Promise<AuthenticationSession[]>;
	createSession(scopes: readonly string[]): Promise<AuthenticationSession>;
	removeSession(id: string): Promise<void>;
}

interface StorageHooks {
	beforeGet?: () => Promise<void>;
	afterStore?: (value: string) => Promise<void>;
}

interface SessionChanges {
	added: readonly AuthenticationSession[];
	changed: readonly AuthenticationSession[];
	removed: readonly AuthenticationSession[];
}

function activateProvider(signIn: (options: SignInOptions) => Promise<string>, storageHooks: StorageHooks = {}) {
	const originalLoad = Module._load;
	const secrets = new Map<string, string>();
	const events: SessionChanges[] = [];
	const progressMessages: string[] = [];
	let provider: TestProvider | undefined;
	let cancellation: () => void = () => assert.fail('No progress cancellation was registered');
	const context = {
		subscriptions: [] as Disposable[],
		secrets: {
			get: async (key: string) => { await storageHooks.beforeGet?.(); return secrets.get(key); },
			store: async (key: string, value: string) => { secrets.set(key, value); await storageHooks.afterStore?.(value); },
			delete: async (key: string) => { secrets.delete(key); },
		},
	};
	const vscode = {
		EventEmitter: class { event() { } fire(event: SessionChanges) { events.push(event); } dispose() { } },
		CancellationError: class extends Error { constructor() { super('Cancelled'); this.name = 'Canceled'; } },
		l10n: { t: (value: string) => value }, ProgressLocation: { Notification: 15 },
		window: { withProgress: async (_options: object, callback: (progress: { report(value: { message: string }): void }, cancellation: { onCancellationRequested(listener: () => void): Disposable }) => Promise<AuthenticationSession>) => callback({ report: value => progressMessages.push(value.message) }, { onCancellationRequested: listener => { cancellation = listener; return { dispose() { } }; } }) },
		env: { openExternal: async () => true }, Uri: { parse: (value: string) => value },
		authentication: { registerAuthenticationProvider: (id: string, label: string, instance: TestProvider) => { assert.strictEqual(id, 'devin-subscription'); assert.strictEqual(label, 'Devin Subscription'); provider = instance; return { dispose() { } }; } },
	};
	Module._load = function (this: unknown, name: string, ...args: [NodeModule?, boolean?]) {
		if (name === 'vscode') { return vscode; }
		if (name === './auth' && args[0]?.filename === require.resolve('../out/extension.js')) { return { signInToDevin: signIn }; }
		return originalLoad.call(this, name, ...args);
	};
	delete require.cache[require.resolve('../out/extension.js')];
	try { require('../out/extension.js').activate(context); } finally { Module._load = originalLoad; }
	assert.ok(provider);
	return { provider, secrets, events, progressMessages, cancel: () => cancellation(), dispose: () => { for (const item of context.subscriptions) { item.dispose(); } } };
}

test('reports browser approval and secure storage phases without displaying credentials', async () => {
	const setup = activateProvider(async options => {
		assert.ok(options.onProgress);
		options.onProgress('waitingForBrowser');
		options.onProgress('exchangingCode');
		return 'test-private-token';
	});
	try {
		await setup.provider.createSession([]);
		assert.deepStrictEqual(setup.progressMessages, [
			'Waiting for approval in the Devin browser page. Keep this window open.',
			'Browser approval received. Connecting to Devin…',
			'Saving Devin sign-in securely…',
		]);
	} finally { setup.dispose(); }
});

test('stores a browser session in SecretStorage and removes only the requested account', async () => {
	const setup = activateProvider(async () => 'test-secret-token');
	try {
		assert.deepStrictEqual(await setup.provider.getSessions(), []);
		const session = await setup.provider.createSession([]);
		assert.strictEqual(session.accessToken, 'test-secret-token');
		assert.strictEqual(setup.secrets.size, 1);
		assert.deepStrictEqual(await setup.provider.getSessions(), [session]);
		await setup.provider.removeSession('different-account');
		assert.strictEqual(setup.secrets.size, 1);
		await setup.provider.removeSession(session.id);
		assert.strictEqual(setup.secrets.size, 0);
		assert.strictEqual(setup.events[0].added[0].id, session.id);
		assert.strictEqual(setup.events[1].removed[0].id, session.id);
	} finally { setup.dispose(); }
});

test('coalesces concurrent sign-in requests and assigns a new account id on reauthentication', async () => {
	let calls = 0;
	let release!: (token: string) => void;
	const setup = activateProvider(async () => { calls++; return new Promise<string>(resolve => { release = resolve; }); });
	try {
		const first = setup.provider.createSession([]);
		const second = setup.provider.createSession([]);
		release('test-first-token');
		const [a, b] = await Promise.all([first, second]);
		assert.strictEqual(calls, 1);
		assert.strictEqual(a.id, b.id);
		const again = setup.provider.createSession([]);
		release('test-next-token');
		const replacement = await again;
		assert.notStrictEqual(replacement.account.id, a.account.id);
		assert.notStrictEqual(replacement.id, a.id);
		assert.strictEqual(setup.events[1].added[0].accessToken, 'test-next-token');
		assert.strictEqual(setup.events[1].removed[0].id, a.id);
		assert.deepStrictEqual(setup.events[1].changed, []);
	} finally { setup.dispose(); }
});

function deferred<T = void>() {
	return Promise.withResolvers<T>();
}

test('a cancelled pending browser launch releases the provider for a fresh sign-in', async () => {
	const started = deferred();
	const firstBrowser = deferred<boolean>();
	let opens = 0;
	let first: Promise<AuthenticationSession> | undefined;
	const setup = activateProvider(options => signInToDevin({
		...options,
		openExternal: async value => {
			if (++opens === 1) { started.resolve(); return firstBrowser.promise; }
			const authorize = new URL(value);
			const redirectUri = authorize.searchParams.get('redirect_uri');
			const state = authorize.searchParams.get('state');
			assert.ok(redirectUri && state);
			const callback = new URL(redirectUri);
			callback.searchParams.set('state', state);
			callback.searchParams.set('code', 'test-retry-code');
			assert.strictEqual((await fetch(callback)).status, 200);
			return true;
		},
		request: async () => Response.json({ session_token: 'test-retry-session-token' }),
	}));
	try {
		first = setup.provider.createSession([]);
		const cancelled = first.then(() => 'unexpected success', error => error.name);
		await started.promise;
		setup.cancel();
		assert.strictEqual(await Promise.race([cancelled, new Promise(resolve => setTimeout(() => resolve('still pending'), 200))]), 'Canceled');
		assert.deepStrictEqual({ secrets: setup.secrets.size, events: setup.events.length }, { secrets: 0, events: 0 });
		const session = await setup.provider.createSession([]);
		firstBrowser.resolve(true);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual({ opens, sessions: await setup.provider.getSessions(), token: session.accessToken, events: setup.events.length }, { opens: 2, sessions: [session], token: 'test-retry-session-token', events: 1 });
	} finally {
		firstBrowser.resolve(true);
		setup.dispose();
		await first?.catch(() => {});
	}
});

test('cancellation while reading the previous session preserves the original account', { timeout: 2000 }, async () => {
	const reading = deferred();
	const release = deferred();
	let hold = false;
	let calls = 0;
	const setup = activateProvider(async () => ++calls === 1 ? 'first-token' : 'replacement-token', {
		beforeGet: async () => { if (hold) { reading.resolve(); await release.promise; } },
	});
	try {
		const original = await setup.provider.createSession([]);
		hold = true;
		const replacement = setup.provider.createSession([]);
		await reading.promise;
		setup.cancel();
		release.resolve();
		await assert.rejects(replacement, { name: 'Canceled' });
		hold = false;
		assert.deepStrictEqual(await setup.provider.getSessions(), [original]);
		assert.strictEqual(setup.events.length, 1);
	} finally { release.resolve(); setup.dispose(); }
});

test('sign-out wins against an in-progress credential write without resurrecting the account', { timeout: 2000 }, async () => {
	const writing = deferred();
	const release = deferred();
	let calls = 0;
	const setup = activateProvider(async () => ++calls === 1 ? 'first-token' : 'replacement-token', {
		afterStore: async value => { if (JSON.parse(value).accessToken === 'replacement-token') { writing.resolve(); await release.promise; } },
	});
	try {
		const original = await setup.provider.createSession([]);
		const replacement = setup.provider.createSession([]);
		await writing.promise;
		const removal = setup.provider.removeSession(original.id);
		release.resolve();
		await assert.rejects(replacement, { name: 'Canceled' });
		await removal;
		assert.deepStrictEqual(await setup.provider.getSessions(), []);
		assert.strictEqual(setup.events.length, 2);
		assert.deepStrictEqual(setup.events[1].removed, [original]);
		assert.deepStrictEqual(setup.events[1].added, []);
	} finally { release.resolve(); setup.dispose(); }
});

test('does not persist a session when cancellation wins the token-return race', async () => {
	let release!: (token: string) => void;
	const setup = activateProvider(async () => new Promise<string>(resolve => { release = resolve; }));
	try {
		const result = setup.provider.createSession([]);
		setup.cancel();
		release('must-not-persist');
		await assert.rejects(result);
		assert.strictEqual(setup.secrets.size, 0);
		assert.strictEqual(setup.events.length, 0);
	} finally { setup.dispose(); }
});

test('ignores malformed stored data and rejects unsupported scopes without a browser launch', async () => {
	const setup = activateProvider(async () => { assert.fail('must not sign in'); });
	try {
		for (const value of ['{bad json', 'null', JSON.stringify({ id: 'id', accessToken: '', account: { id: 'id', label: 'account' }, scopes: [] })]) {
			setup.secrets.set('devin.subscription.session.v1', value);
			assert.deepStrictEqual(await setup.provider.getSessions(), []);
		}
		await assert.rejects(setup.provider.createSession(['unsupported']), /custom scopes/);
	} finally { setup.dispose(); }
});
