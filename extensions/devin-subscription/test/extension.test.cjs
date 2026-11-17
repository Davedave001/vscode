/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

function activateProvider(signIn, storageHooks = {}) {
	const originalLoad = Module._load;
	const secrets = new Map();
	const events = [];
	let provider;
	let cancellation;
	const context = {
		subscriptions: [],
		secrets: {
			get: async key => { await storageHooks.beforeGet?.(); return secrets.get(key); },
			store: async (key, value) => { secrets.set(key, value); await storageHooks.afterStore?.(value); },
			delete: async key => { secrets.delete(key); },
		},
	};
	const vscode = {
		EventEmitter: class { event() { } fire(event) { events.push(event); } dispose() { } },
		CancellationError: class extends Error { constructor() { super('Cancelled'); this.name = 'Canceled'; } },
		l10n: { t: value => value }, ProgressLocation: { Notification: 15 },
		window: { withProgress: async (_options, callback) => callback({}, { onCancellationRequested: listener => { cancellation = listener; return { dispose() { } }; } }) },
		env: { openExternal: async () => true }, Uri: { parse: value => value },
		authentication: { registerAuthenticationProvider: (id, label, instance) => { assert.strictEqual(id, 'devin-subscription'); assert.strictEqual(label, 'Devin Subscription'); provider = instance; return { dispose() { } }; } },
	};
	Module._load = function (name, ...args) {
		if (name === 'vscode') { return vscode; }
		if (name === './auth' && args[0]?.filename === require.resolve('../out/extension.js')) { return { signInToDevin: signIn }; }
		return originalLoad.call(this, name, ...args);
	};
	delete require.cache[require.resolve('../out/extension.js')];
	try { require('../out/extension.js').activate(context); } finally { Module._load = originalLoad; }
	return { provider, secrets, events, cancel: () => cancellation(), dispose: () => { for (const item of context.subscriptions) { item.dispose(); } } };
}

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
	let release;
	const setup = activateProvider(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
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

function deferred() {
	let resolve;
	const promise = new Promise(complete => { resolve = complete; });
	return { promise, resolve };
}

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
	let release;
	const setup = activateProvider(async () => new Promise(resolve => { release = resolve; }));
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
