/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICodeWindow } from '../../../window/electron-main/window.js';
import { sendChatSessionToWindow } from '../../electron-main/windowChatSession.js';

suite('Native window chat handoff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const count of [0, 1, 2]) {
		test(`sends a revived chat identity only to a single selected window (${count} targets)`, () => {
			const calls: { window: number; channel: string; resource: string }[] = [];
			const windows = Array.from({ length: count }, (_, window) => upcastPartial<ICodeWindow>({
				sendWhenReady: (channel, token, resource) => {
					assert.strictEqual(token, CancellationToken.None);
					assert.ok(typeof resource === 'string');
					calls.push({ window, channel, resource });
				},
			}));
			const resource = URI.from({ scheme: 'agent-host-copilotcli', path: '/folderless chat', fragment: 'nested&chat' });
			sendChatSessionToWindow(windows, resource.toJSON());
			assert.deepStrictEqual(calls, count === 1 ? [{ window: 0, channel: 'vscode:openChatSession', resource: resource.toString() }] : []);
		});
	}

	test('does not request a conversation when the handoff has no chat identity', () => {
		const window = upcastPartial<ICodeWindow>({ sendWhenReady: () => assert.fail('No chat should be opened') });
		sendChatSessionToWindow([window], undefined);
	});
});
