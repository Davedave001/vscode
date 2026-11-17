/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationSession, Disposable, InputBoxOptions } from 'vscode';
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
	shared?: SharedSecrets;
}

class SharedSecrets {
	readonly values = new Map<string, string>();
	private readonly listeners = new Set<(event: { key: string }) => void>();
	readonly onDidChange = (listener: (event: { key: string }) => void): Disposable => {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	};
	async get(key: string): Promise<string | undefined> { return this.values.get(key); }
	async store(key: string, value: string): Promise<void> { this.values.set(key, value); this.fire(key); }
	async delete(key: string): Promise<void> { this.values.delete(key); this.fire(key); }
	private fire(key: string): void { for (const listener of this.listeners) { listener({ key }); } }
}

interface SessionChanges {
	added: readonly AuthenticationSession[];
	changed: readonly AuthenticationSession[];
	removed: readonly AuthenticationSession[];
}

interface SignInUI {
	chooseMethod?: (signal: AbortSignal) => Promise<{ manual: boolean } | undefined>;
	readCode?: (options: InputBoxOptions, signal: AbortSignal) => Promise<string | undefined>;
}

function activateProvider(signIn: (options: SignInOptions) => Promise<string>, storageHooks: StorageHooks = {}, ui: SignInUI = {}) {
	const originalLoad = Module._load;
	const shared = storageHooks.shared ?? new SharedSecrets();
	const secrets = shared.values;
	const events: SessionChanges[] = [];
	const progressMessages: string[] = [];
	let provider: TestProvider | undefined;
	let cancellation: () => void = () => assert.fail('No progress cancellation was registered');
	const context = {
		subscriptions: [] as Disposable[],
		secrets: {
			get: async (key: string) => { await storageHooks.beforeGet?.(); return shared.get(key); },
			store: async (key: string, value: string) => { await shared.store(key, value); await storageHooks.afterStore?.(value); },
			delete: async (key: string) => { await shared.delete(key); },
			onDidChange: shared.onDidChange,
		},
	};
	const vscode = {
		EventEmitter: class { event() { } fire(event: SessionChanges) { events.push(event); } dispose() { } },
		CancellationError: class extends Error { constructor() { super('Cancelled'); this.name = 'Canceled'; } },
		CancellationTokenSource: class { private readonly controller = new AbortController(); readonly token = this.controller.signal; cancel() { this.controller.abort(); } dispose() { } },
		l10n: { t: (value: string) => value }, ProgressLocation: { Notification: 15 },
		window: {
			showQuickPick: async (_items: object[], _options: object, signal: AbortSignal) => ui.chooseMethod ? ui.chooseMethod(signal) : { manual: false },
			showInputBox: ui.readCode ?? (async () => assert.fail('No code input was expected')),
			withProgress: async (_options: object, callback: (progress: { report(value: { message: string }): void }, cancellation: { onCancellationRequested(listener: () => void): Disposable }) => Promise<AuthenticationSession>) => callback({ report: value => progressMessages.push(value.message) }, { onCancellationRequested: listener => { cancellation = listener; return { dispose() { } }; } }),
		},
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

test('two windows observe shared sign-in and sign-out exactly once', async () => {
	const shared = new SharedSecrets();
	const agents = activateProvider(async () => 'test-agents-token', { shared });
	const ide = activateProvider(async () => assert.fail('the other window must not launch sign-in'), { shared });
	try {
		const session = await agents.provider.createSession([]);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(await ide.provider.getSessions(), [session]);
		assert.deepStrictEqual(agents.events, [{ added: [session], changed: [], removed: [] }]);
		assert.deepStrictEqual(ide.events, agents.events);
		await ide.provider.removeSession(session.id);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(await agents.provider.getSessions(), []);
		assert.deepStrictEqual(agents.events, [
			{ added: [session], changed: [], removed: [] },
			{ added: [], changed: [], removed: [session] },
		]);
		assert.deepStrictEqual(ide.events, agents.events);
	} finally { agents.dispose(); ide.dispose(); }
});

test('a window opened with an account observes its replacement without a startup event', async () => {
	const shared = new SharedSecrets();
	let calls = 0;
	const agents = activateProvider(async () => `test-token-${++calls}`, { shared });
	let ide: ReturnType<typeof activateProvider> | undefined;
	try {
		const first = await agents.provider.createSession([]);
		ide = activateProvider(async () => assert.fail('must reuse shared state'), { shared });
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(await ide.provider.getSessions(), [first]);
		assert.deepStrictEqual(ide.events, []);
		const next = await agents.provider.createSession([]);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(ide.events, [{ added: [next], changed: [], removed: [first] }]);
		ide.dispose();
		await agents.provider.removeSession(next.id);
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(ide.events.length, 1);
	} finally { agents.dispose(); ide?.dispose(); }
});

test('shared storage changes distinguish updates, invalidation and unrelated secrets', async () => {
	const shared = new SharedSecrets();
	const setup = activateProvider(async () => 'test-first-token', { shared });
	try {
		const first = await setup.provider.createSession([]);
		await new Promise(resolve => setImmediate(resolve));
		const next = { ...first, accessToken: 'test-updated-token' };
		await shared.store('devin.subscription.session.v1', JSON.stringify(next));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(setup.events[1], { added: [], removed: [], changed: [next] });
		await shared.store('unrelated-test-secret', 'unrelated-test-value');
		await shared.store('devin.subscription.session.v1', JSON.stringify(next));
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(setup.events.length, 2);
		await shared.store('devin.subscription.session.v1', '{invalid data');
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(setup.events[2], { added: [], removed: [next], changed: [] });
		assert.deepStrictEqual(await setup.provider.getSessions(), []);
	} finally { setup.dispose(); }
});

for (const stage of ['method', 'code']) {
	test(`sign-out in another window cancels pending ${stage} input and permits a fresh sign-in`, async () => {
		const shared = new SharedSecrets();
		const agents = activateProvider(async () => 'test-agents-token', { shared });
		const first = await agents.provider.createSession([]);
		const started = deferred<AbortSignal>();
		let waiting = true;
		const waitForCancellation = async (signal: AbortSignal) => {
			started.resolve(signal);
			return new Promise<undefined>(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
		};
		const ide = activateProvider(options => signInToDevin({ ...options, request: async () => Response.json({ session_token: 'test-ide-token' }) }), { shared }, {
			chooseMethod: async signal => waiting && stage === 'method' ? waitForCancellation(signal) : { manual: true },
			readCode: async (_options, signal) => waiting ? waitForCancellation(signal) : 'test-ide-code',
		});
		try {
			await new Promise(resolve => setImmediate(resolve));
			const attempt = ide.provider.createSession([]);
			const rejected = assert.rejects(attempt, { name: 'Canceled' });
			const signal = await started.promise;
			await agents.provider.removeSession(first.id);
			await rejected;
			assert.strictEqual(signal.aborted, true);
			assert.deepStrictEqual(await ide.provider.getSessions(), []);
			assert.deepStrictEqual(ide.events, [{ added: [], changed: [], removed: [first] }]);
			waiting = false;
			const replacement = await ide.provider.createSession([]);
			await new Promise(resolve => setImmediate(resolve));
			assert.strictEqual(replacement.accessToken, 'test-ide-token');
			assert.deepStrictEqual(await agents.provider.getSessions(), [replacement]);
			assert.deepStrictEqual(agents.events.at(-1), { added: [replacement], changed: [], removed: [] });
		} finally { agents.dispose(); ide.dispose(); }
	});
}

test('sign-out in another window wins while the replacement reads the current account', async () => {
	const shared = new SharedSecrets();
	const agents = activateProvider(async () => 'test-original-token', { shared });
	const first = await agents.provider.createSession([]);
	const reading = deferred();
	const release = deferred();
	let hold = false;
	const ide = activateProvider(async () => { hold = true; return 'test-replacement-token'; }, {
		shared,
		beforeGet: async () => { if (hold) { reading.resolve(); await release.promise; } },
	});
	try {
		await new Promise(resolve => setImmediate(resolve));
		const replacing = ide.provider.createSession([]);
		const rejected = assert.rejects(replacing, { name: 'Canceled' });
		await reading.promise;
		await agents.provider.removeSession(first.id);
		release.resolve();
		await rejected;
		hold = false;
		assert.deepStrictEqual(await ide.provider.getSessions(), []);
		assert.deepStrictEqual(await agents.provider.getSessions(), []);
		assert.strictEqual(ide.events.some(event => event.added.length > 0), false);
	} finally { release.resolve(); agents.dispose(); ide.dispose(); }
});

test('coalesces concurrent sign-in requests and assigns a new account id on reauthentication', async () => {
	let calls = 0;
	let release!: (token: string) => void;
	const setup = activateProvider(async () => { calls++; return new Promise<string>(resolve => { release = resolve; }); });
	try {
		const first = setup.provider.createSession([]);
		const second = setup.provider.createSession([]);
		await new Promise(resolve => setImmediate(resolve));
		release('test-first-token');
		const [a, b] = await Promise.all([first, second]);
		assert.strictEqual(calls, 1);
		assert.strictEqual(a.id, b.id);
		const again = setup.provider.createSession([]);
		await new Promise(resolve => setImmediate(resolve));
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

test('manual code sign-in uses private input and saves through the existing provider', async () => {
	const setup = activateProvider(options => signInToDevin({
		...options,
		request: async (_url, request) => {
			assert.ok(request && typeof request.body === 'string');
			assert.strictEqual(JSON.parse(request.body).code, 'test-private-code');
			return Response.json({ session_token: 'test-private-token' });
		},
	}), {}, {
		chooseMethod: async () => ({ manual: true }),
		readCode: async (options, signal) => {
			assert.strictEqual(options.password, true);
			assert.strictEqual(options.ignoreFocusOut, true);
			assert.strictEqual(signal.aborted, false);
			assert.ok(options.validateInput);
			assert.ok(await options.validateInput('not a code'));
			assert.strictEqual(await options.validateInput('test-private-code'), undefined);
			return 'test-private-code';
		},
	});
	try {
		const session = await setup.provider.createSession([]);
		assert.deepStrictEqual(await setup.provider.getSessions(), [session]);
		assert.strictEqual(session.accessToken, 'test-private-token');
		assert.strictEqual(setup.events.length, 1);
		assert.ok(setup.progressMessages[0].includes('paste its authorization code'));
		assert.strictEqual(setup.progressMessages.some(message => /test-private/.test(message)), false);
	} finally { setup.dispose(); }
});

test('cancelled manual input preserves a saved account and permits another sign-in', async () => {
	let manual = false;
	let code: string | undefined;
	const setup = activateProvider(async options => {
		if (options.readAuthorizationCode) { await options.readAuthorizationCode(options.signal); options.signal.throwIfAborted(); }
		return 'test-account-token';
	}, {}, { chooseMethod: async () => ({ manual }), readCode: async () => code });
	try {
		const original = await setup.provider.createSession([]);
		manual = true;
		await assert.rejects(setup.provider.createSession([]), { name: 'Canceled' });
		assert.deepStrictEqual(await setup.provider.getSessions(), [original]);
		assert.strictEqual(setup.events.length, 1);
		code = 'test-retry-code';
		const replacement = await setup.provider.createSession([]);
		assert.notStrictEqual(replacement.id, original.id);
		assert.strictEqual(setup.events.length, 2);
	} finally { setup.dispose(); }
});

for (const mode of ['cancel', 'timeout', 'dispose']) {
	test(`${mode} closes manual input without storing a credential`, async () => {
		const started = deferred<AbortSignal>();
		const setup = activateProvider(options => signInToDevin({ ...options, timeoutMs: mode === 'timeout' ? 25 : 5000, request: async () => assert.fail('must not exchange') }), {}, {
			chooseMethod: async () => ({ manual: true }),
			readCode: async (_options, signal) => {
				started.resolve(signal);
				return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
			},
		});
		try {
			const result = setup.provider.createSession([]);
			const rejected = assert.rejects(result, mode === 'timeout' ? /timed out/ : { name: 'Canceled' });
			const signal = await started.promise;
			if (mode === 'cancel') { setup.cancel(); }
			if (mode === 'dispose') { setup.dispose(); }
			await rejected;
			assert.strictEqual(signal.aborted, true);
			assert.strictEqual(setup.secrets.size, 0);
			assert.strictEqual(setup.events.length, 0);
		} finally { if (mode !== 'dispose') { setup.dispose(); } }
	});
}

test('dismissal or disposal during method selection never launches authentication', async () => {
	for (const disposed of [false, true]) {
		const choice = deferred<{ manual: boolean } | undefined>();
		const setup = activateProvider(async () => assert.fail('must not launch after dismissal or disposal'), {}, { chooseMethod: () => choice.promise });
		try {
			const result = setup.provider.createSession([]);
			if (disposed) { setup.dispose(); }
			choice.resolve(disposed ? { manual: true } : undefined);
			await assert.rejects(result, { name: 'Canceled' });
			assert.strictEqual(setup.secrets.size, 0);
		} finally { if (!disposed) { setup.dispose(); } }
	}
});

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
		await new Promise(resolve => setImmediate(resolve));
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
