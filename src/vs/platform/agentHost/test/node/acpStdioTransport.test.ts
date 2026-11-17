/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import { once } from 'events';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AcpClient } from '../../node/acp/acpClient.js';
import { AcpStdioTransport } from '../../node/acp/acpStdioTransport.js';

suite('ACP Stdio Transport', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('reassembles split UTF-8 messages from an actual child and drains stderr', async () => {
		const child = spawn(process.execPath, ['-e', String.raw`process.stderr.write('x'.repeat(128*1024)); const b=Buffer.from(JSON.stringify({text:'hello 🌍'})+'\n'); const i=b.indexOf(Buffer.from('🌍'))+1; process.stdout.write(b.subarray(0,i)); setImmediate(()=>{process.stdout.write(b.subarray(i));process.stdin.resume();});`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', windowsHide: true });
		const exited = once(child, 'exit');
		const transport = store.add(new AcpStdioTransport(child));
		const message = await Event.toPromise(transport.onMessage);
		assert.deepStrictEqual(message, { text: 'hello 🌍' });
		transport.dispose();
		await exited;
	});

	test('rejects malformed child output without echoing the output into the error', async () => {
		const child = spawn(process.execPath, ['-e', String.raw`process.stdin.once('data',()=>process.stdout.write('private-diagnostic\n'));`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', windowsHide: true });
		const exited = once(child, 'exit');
		const client = store.add(new AcpClient(new AcpStdioTransport(child)));
		await assert.rejects(client.request('initialize', {}), error => error instanceof Error && error.message === 'Invalid ACP JSON message');
		await exited;
	});
});
