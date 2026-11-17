/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// These endpoints match SimpleRAG and Devin's current public browser flow.
// The installed official client exchanges only a code and PKCE verifier.
export const DEVIN_AUTHORIZE_URL = 'https://app.devin.ai/auth/cli/continue';
export const DEVIN_TOKEN_URL = 'https://api.devin.ai/auth/cli/token';

export interface SignInOptions {
	readonly openExternal: (url: string) => Promise<boolean>;
	readonly signal: AbortSignal;
	readonly timeoutMs?: number;
	readonly request?: typeof fetch;
}

export async function signInToDevin(options: SignInOptions): Promise<string> {
	const verifier = randomBytes(32).toString('base64url');
	const state = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	const timer = setTimeout(() => controller.abort(new Error('Devin sign-in timed out.')), options.timeoutMs ?? 600_000);
	const server = createServer();
	let rejectCallback: ((reason: unknown) => void) | undefined;
	const onAbort = () => rejectCallback?.(signal.reason ?? new Error('Devin sign-in cancelled.'));
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
		});
		const port = (server.address() as AddressInfo).port;
		const redirectUri = `http://127.0.0.1:${port}/callback`;
		const callback = new Promise<string>((resolve, reject) => {
			rejectCallback = reject;
			server.once('error', reject);
			server.on('request', (request, response) => {
				response.setHeader('Content-Type', 'text/plain; charset=utf-8');
				response.setHeader('Cache-Control', 'no-store');
				response.setHeader('X-Content-Type-Options', 'nosniff');
				response.setHeader('Content-Security-Policy', 'default-src \'none\'; frame-ancestors \'none\'');
				let url: URL;
				try { url = new URL(request.url ?? '/', redirectUri); } catch {
					response.writeHead(400).end('Invalid callback URL.');
					return;
				}
				if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== '/callback') {
					response.writeHead(404).end('Not found.');
					return;
				}
				if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
					response.writeHead(400).end('Invalid sign-in state. Return to the original sign-in page.');
					return;
				}
				if (url.searchParams.has('error')) {
					response.writeHead(400).end('Sign-in was declined. Return to Agent Workspace.');
					reject(new Error('Devin sign-in was declined.'));
					return;
				}
				const code = url.searchParams.get('code');
				if (!code || code.length > 8192 || url.searchParams.getAll('code').length !== 1) {
					response.writeHead(400).end('No valid authorization code was received.');
					return;
				}
				response.writeHead(200).end('Authorization received. Return to Agent Workspace to check the sign-in result.');
				resolve(code);
			});
		});
		// Browser failures/cancellation can win before we start awaiting the code.
		void callback.catch(() => { });
		signal.throwIfAborted();
		const authorize = new URL(DEVIN_AUTHORIZE_URL);
		for (const [key, value] of Object.entries({ response_type: 'code', redirect_uri: redirectUri, state, prompt: 'select_account', code_challenge: challenge, code_challenge_method: 'S256', cli_pkce_marker: '1' })) {
			authorize.searchParams.set(key, value);
		}
		if (!await options.openExternal(authorize.toString())) {
			throw new Error('The Devin sign-in page could not be opened.');
		}
		const code = await callback;
		const response = await (options.request ?? fetch)(DEVIN_TOKEN_URL, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
			body: JSON.stringify({ code, code_verifier: verifier }),
		});
		if (!response.ok) {
			throw new Error(`Devin token exchange failed (HTTP ${response.status}).`);
		}
		const data: unknown = await response.json();
		if (!data || typeof data !== 'object' || Object.hasOwn(data, 'error')) {
			throw new Error('Devin did not return a valid sign-in response.');
		}
		const record = data as Record<string, unknown>;
		const token = record.session_token;
		if (typeof token !== 'string' || !token.trim()) {
			throw new Error('Devin did not return a session token.');
		}
		return token;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', onAbort);
		rejectCallback?.(new Error('Devin sign-in ended.'));
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}
