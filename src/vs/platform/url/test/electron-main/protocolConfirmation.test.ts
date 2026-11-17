/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../base/common/network.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { IDialogMainService } from '../../../dialogs/electron-main/dialogMainService.js';
import { IWindowsMainService } from '../../../windows/electron-main/windows.js';
import { shouldBlockProtocolRequest } from '../../electron-main/protocolConfirmation.js';

suite('External editor protocol confirmation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const [scheme, setting, destination] of [
		[Schemas.file, 'security.promptForLocalFileProtocolHandling', 'local'],
		[Schemas.vscodeRemote, 'security.promptForRemoteFileProtocolHandling', 'remote'],
	] as const) {
		function fixture(value: boolean | undefined, response = 0, checkboxChecked = false) {
			const prompts: Electron.MessageBoxOptions[] = [];
			const persisted: { target: string; channel: string; scope: unknown }[] = [];
			const configuration = new TestConfigurationService(value === undefined ? {} : { [setting]: value });
			const dialogs = upcastPartial<IDialogMainService>({ showMessageBox: async options => { prompts.push(options); return { response, checkboxChecked }; } });
			const windows = upcastPartial<IWindowsMainService>({
				sendToFocused: (channel, scope) => { persisted.push({ target: 'focused', channel, scope }); },
				sendToOpeningWindow: (channel, scope) => { persisted.push({ target: 'opening', channel, scope }); },
			});
			return { prompts, persisted, check: (editorRequest = true) => shouldBlockProtocolRequest(scheme, 'External editor request', configuration, windows, dialogs, editorRequest) };
		}

		test(`honors an explicit ${destination} confirmation opt-out without prompting or persisting`, async () => {
			const f = fixture(false);
			assert.strictEqual(await f.check(), false);
			assert.deepStrictEqual([f.prompts, f.persisted], [[], []]);
		});

		test(`prompts by default and blocks a declined ${destination} request without changing preferences`, async () => {
			const f = fixture(undefined, 1, true);
			assert.strictEqual(await f.check(), true);
			assert.strictEqual(f.prompts.length, 1);
			assert.strictEqual(f.prompts[0].cancelId, 1);
			assert.strictEqual(f.prompts[0].message, 'External editor request');
			assert.match(f.prompts[0].checkboxLabel ?? '', /paths and chats/);
			assert.deepStrictEqual(f.persisted, []);
		});

		test(`only persists an accepted ${destination} request with an explicitly checked preference`, async () => {
			const once = fixture(true);
			assert.strictEqual(await once.check(), false);
			assert.deepStrictEqual(once.persisted, []);
			const remembered = fixture(true, 0, true);
			assert.strictEqual(await remembered.check(), false);
			assert.deepStrictEqual(remembered.persisted, ['focused', 'opening'].map(target => ({ target, channel: 'vscode:disablePromptForProtocolHandling', scope: destination })));
		});

		test(`preserves the existing ${destination} path confirmation presentation`, async () => {
			const f = fixture(true);
			await f.check(false);
			assert.strictEqual(f.prompts[0].checkboxLabel, `Allow opening ${destination} paths without asking`);
		});
	}
});
