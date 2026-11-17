/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICodeWindow } from '../../../window/electron-main/window.js';
import { openEmptyWindowWithChat, sendChatSessionToWindow } from '../../electron-main/windowChatSession.js';
import { IWindowsMainService, OpenContext } from '../../../windows/electron-main/windows.js';

suite('Native window chat handoff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('awaits the selected editor and passes its host and reuse options without alteration', async () => {
		const opening = new DeferredPromise<ICodeWindow[]>();
		const configuration = { context: OpenContext.LINK, initialStartup: true };
		const options = { remoteAuthority: 'ssh-remote+host', reuseExistingWindow: true, chatSessionToOpen: URI.parse('agent-host-copilotcli:/folderless#chat') };
		const calls: string[] = [];
		const window = upcastPartial<ICodeWindow>({ sendWhenReady: (_channel, _token, resource) => { assert.ok(typeof resource === 'string'); calls.push(resource); } });
		const service = upcastPartial<IWindowsMainService>({ openEmptyWindow: async (actualConfiguration, actualOptions) => { assert.strictEqual(actualConfiguration, configuration); assert.strictEqual(actualOptions, options); return opening.p; } });
		const request = openEmptyWindowWithChat(service, configuration, options);
		assert.deepStrictEqual(calls, []);
		await opening.complete([window]);
		assert.deepStrictEqual(await request, [window]);
		assert.deepStrictEqual(calls, [options.chatSessionToOpen.toString()]);
	});

	test('propagates an editor-open failure without substituting another window', async () => {
		const error = new Error('Editor open failed');
		const service = upcastPartial<IWindowsMainService>({ openEmptyWindow: async () => { throw error; } });
		await assert.rejects(openEmptyWindowWithChat(service, { context: OpenContext.LINK }), actual => actual === error);
	});

	for (const remoteAuthority of [undefined, 'ssh-remote+host']) {
		test(`selects one same-host editor during ${remoteAuthority ? 'remote' : 'local'} startup while preserving recovered windows`, async () => {
			const calls: number[] = [];
			const windows = [
				{ remoteAuthority, lastFocusTime: 1 },
				{ remoteAuthority, lastFocusTime: 2 },
				{ remoteAuthority: 'ssh-remote+other', lastFocusTime: 5 },
				{ remoteAuthority, lastFocusTime: 6, isSessionsWindow: true },
			].map((options, index) => upcastPartial<ICodeWindow>({
				remoteAuthority: options.remoteAuthority, lastFocusTime: options.lastFocusTime,
				config: upcastPartial<NonNullable<ICodeWindow['config']>>({ isSessionsWindow: options.isSessionsWindow }),
				sendWhenReady: () => { calls.push(index); },
			}));
			const service = upcastPartial<IWindowsMainService>({ openEmptyWindow: async () => windows });
			const result = await openEmptyWindowWithChat(service, { context: OpenContext.LINK, initialStartup: true }, { remoteAuthority, reuseExistingWindow: true, chatSessionToOpen: URI.parse('agent-host-copilotcli:/retained') });
			assert.strictEqual(result, windows);
			assert.deepStrictEqual(calls, [1]);
		});
	}

	test('does not resolve an ambiguous ordinary request using startup recovery rules', async () => {
		const windows = [1, 2].map(lastFocusTime => upcastPartial<ICodeWindow>({ config: upcastPartial<NonNullable<ICodeWindow['config']>>({}), lastFocusTime, sendWhenReady: () => assert.fail('The ambiguous handoff must not dispatch') }));
		const service = upcastPartial<IWindowsMainService>({ openEmptyWindow: async () => windows });
		await openEmptyWindowWithChat(service, { context: OpenContext.LINK }, { reuseExistingWindow: true, chatSessionToOpen: URI.parse('agent-host-copilotcli:/retained') });
	});
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
