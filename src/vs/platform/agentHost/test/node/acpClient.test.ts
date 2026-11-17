/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AcpClient, AcpRpcError, initializeAcp } from '../../node/acp/acpClient.js';
import { TestAcpTransport } from './acpTestUtils.js';

suite('ACP Client', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('correlates concurrent responses and separates agent requests using the same id', async () => {
		const transport = new TestAcpTransport();
		const client = store.add(new AcpClient(transport));
		store.add(client.registerRequestHandler('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' } })));
		const first = client.request('session/prompt', {}, { timeoutMs: 0 });
		const second = client.request('session/new', {});
		transport.receive({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: {} });
		transport.reply(transport.sent[1], { sessionId: 'native' });
		assert.deepStrictEqual(await second, { sessionId: 'native' });
		await Promise.resolve();
		assert.deepStrictEqual(transport.sent[2], { jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'cancelled' } } });
		transport.reply(transport.sent[0], { stopReason: 'end_turn' });
		assert.deepStrictEqual(await first, { stopReason: 'end_turn' });
	});

	test('refuses unimplemented filesystem and terminal methods', async () => {
		const transport = new TestAcpTransport();
		store.add(new AcpClient(transport));
		for (const method of ['fs/read_text_file', 'terminal/create']) {
			transport.receive({ jsonrpc: '2.0', id: method, method, params: {} });
		}
		assert.deepStrictEqual(transport.sent.map(message => message.error), [
			{ code: -32601, message: 'Unsupported ACP client method' }, { code: -32601, message: 'Unsupported ACP client method' },
		]);
	});

	test('cancels a local wait without inventing an agent cancellation request', async () => {
		const transport = new TestAcpTransport();
		const client = store.add(new AcpClient(transport));
		const cancellation = store.add(new CancellationTokenSource());
		const pending = client.request('session/prompt', {}, { token: cancellation.token, timeoutMs: 0 });
		cancellation.cancel();
		await assert.rejects(pending, { name: 'Canceled' });
		transport.reply(transport.sent[0], {});
		assert.strictEqual(transport.sent.length, 1);
	});

	test('rejects all pending requests when the peer exits', async () => {
		const transport = new TestAcpTransport();
		const client = store.add(new AcpClient(transport));
		const first = assert.rejects(client.request('first', {}), /peer exited/);
		const second = assert.rejects(client.request('second', {}), /peer exited/);
		transport.close();
		await Promise.all([first, second]);
	});

	test('propagates protocol errors and fails closed on malformed envelopes', async () => {
		const transport = new TestAcpTransport();
		const client = store.add(new AcpClient(transport));
		const failed = client.request('first', {});
		transport.receive({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth required' } });
		await assert.rejects(failed, error => error instanceof AcpRpcError && error.code === -32000 && error.message === 'first: auth required');
		const malformed = client.request('second', {});
		transport.receive({ jsonrpc: '2.0', id: 2, result: {}, error: {} });
		await assert.rejects(malformed, /Invalid ACP response/);
	});

	test('negotiates version 1 without advertising client file or terminal access', async () => {
		const transport = new TestAcpTransport();
		const client = store.add(new AcpClient(transport));
		transport.handle = request => transport.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
		await initializeAcp(client, { name: 'test', version: '1' });
		assert.deepStrictEqual(transport.sent[0].params, { protocolVersion: 1, clientInfo: { name: 'test', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
	});
});
