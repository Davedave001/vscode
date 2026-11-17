/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { signInToDevin, DEVIN_AUTHORIZE_URL, DEVIN_TOKEN_URL } = require('../out/auth.js');

function callbackUrl(authorize, changes = {}) {
	const url = new URL(authorize.searchParams.get('redirect_uri'));
	url.searchParams.set('state', authorize.searchParams.get('state'));
	url.searchParams.set('code', 'test-authorization-code');
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) { url.searchParams.delete(key); } else { url.searchParams.set(key, value); }
	}
	return url;
}

test('uses the browser PKCE flow and fixed HTTPS token endpoint without starting a CLI', async () => {
	let authorize;
	let redirect;
	const token = await signInToDevin({
		signal: new AbortController().signal,
		openExternal: async value => {
			authorize = new URL(value);
			assert.strictEqual(authorize.origin + authorize.pathname, DEVIN_AUTHORIZE_URL);
			assert.strictEqual(authorize.searchParams.get('code_challenge_method'), 'S256');
			assert.strictEqual(authorize.searchParams.has('token'), false);
			assert.strictEqual(authorize.searchParams.has('code_verifier'), false);
			redirect = callbackUrl(authorize);
			const response = await fetch(redirect);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(response.headers.get('cache-control'), 'no-store');
			return true;
		},
		request: async (url, options) => {
			assert.strictEqual(url, DEVIN_TOKEN_URL);
			assert.strictEqual(options.method, 'POST');
			assert.strictEqual(options.redirect, 'error');
			const body = JSON.parse(options.body);
			assert.strictEqual(body.code, 'test-authorization-code');
			assert.deepStrictEqual(Object.keys(body).sort(), ['code', 'code_verifier']);
			assert.strictEqual(createHash('sha256').update(body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
			return Response.json({ session_token: 'test-session-token' });
		},
	});
	assert.strictEqual(token, 'test-session-token');
	await assert.rejects(fetch(redirect), /fetch failed/);
});

test('ignores missing or wrong state and unrelated paths until the valid callback arrives', async () => {
	let exchanges = 0;
	await signInToDevin({
		signal: new AbortController().signal,
		openExternal: async value => {
			const authorize = new URL(value);
			for (const state of [null, 'wrong-state']) {
				assert.strictEqual((await fetch(callbackUrl(authorize, { state }))).status, 400);
			}
			const unrelated = callbackUrl(authorize);
			unrelated.pathname = '/favicon.ico';
			assert.strictEqual((await fetch(unrelated)).status, 404);
			const duplicate = callbackUrl(authorize);
			duplicate.searchParams.append('state', authorize.searchParams.get('state'));
			assert.strictEqual((await fetch(duplicate)).status, 400);
			assert.strictEqual(exchanges, 0);
			assert.strictEqual((await fetch(callbackUrl(authorize))).status, 200);
			return true;
		},
		request: async () => { exchanges++; return Response.json({ session_token: 'test-session-token' }); },
	});
	assert.strictEqual(exchanges, 1);
});

test('cancellation closes the loopback listener without exchanging credentials', async () => {
	const controller = new AbortController();
	let redirect;
	const result = signInToDevin({
		signal: controller.signal,
		openExternal: async value => { redirect = callbackUrl(new URL(value)); queueMicrotask(() => controller.abort(new Error('user cancelled'))); return true; },
		request: async () => { assert.fail('must not exchange after cancellation'); },
	});
	await assert.rejects(result, /user cancelled/);
	await assert.rejects(fetch(redirect), /fetch failed/);
});

test('timeout closes the listener and does not report successful sign-in', async () => {
	let redirect;
	await assert.rejects(signInToDevin({
		signal: new AbortController().signal, timeoutMs: 50,
		openExternal: async value => { redirect = callbackUrl(new URL(value)); return true; },
	}), /timed out/);
	await assert.rejects(fetch(redirect), /fetch failed/);
});

test('a browser launch failure releases the listener', async () => {
	let redirect;
	await assert.rejects(signInToDevin({
		signal: new AbortController().signal,
		openExternal: async value => { redirect = callbackUrl(new URL(value)); return false; },
	}), /could not be opened/);
	await assert.rejects(fetch(redirect), /fetch failed/);
});

test('provider denial does not expose its description or exchange a code', async () => {
	await assert.rejects(signInToDevin({
		signal: new AbortController().signal,
		openExternal: async value => { await fetch(callbackUrl(new URL(value), { error: 'access_denied', error_description: 'private provider details' })); return true; },
		request: async () => { assert.fail('must not exchange a denied callback'); },
	}), error => error.message === 'Devin sign-in was declined.');
});

for (const [name, response, expected] of [
	['HTTP failure', new Response('private response contents', { status: 401 }), /HTTP 401/],
	['error response', Response.json({ error: 'private error details' }), /valid sign-in response/],
	['missing token', Response.json({ nested: { arbitrary_session: 'must-not-be-used' } }), /session token/],
	['unrelated token field', Response.json({ access_token: 'must-not-be-used' }), /session token/],
]) {
	test(`rejects ${name} without treating it as a connected account`, async () => {
		await assert.rejects(signInToDevin({
			signal: new AbortController().signal,
			openExternal: async value => { await fetch(callbackUrl(new URL(value))); return true; },
			request: async () => response,
		}), expected);
	});
}
