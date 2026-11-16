/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Action } from '../../../../../base/common/actions.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkspaceModeSwitch } from '../../../../browser/parts/titlebar/workspaceModeSwitch.js';
import { workbenchInstantiationService } from '../../workbenchTestServices.js';

suite('Workspace Mode Switch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const mode of ['agents', 'ide'] as const) {
		test(`shows ${mode} as the active mode and preserves the toolbar action`, async () => {
			const instantiation = workbenchInstantiationService(undefined, store);
			let runs = 0;
			const action = store.add(new Action('switchMode', 'Switch Mode', undefined, true, async () => { runs++; }));
			const element = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
			store.add(toDisposable(() => element.remove()));
			const bar = store.add(new ActionBar(element, {
				actionViewItemProvider: (item, options) => instantiation.createInstance(WorkspaceModeSwitch, item, options, mode, action.id),
			}));
			bar.push(action);
			bar.focus(0);
			const control = element.querySelector<HTMLElement>('[role="switch"]')!;
			control.click();
			assert.deepStrictEqual({
				checked: control.getAttribute('aria-checked'), label: control.getAttribute('aria-label'),
				active: control.querySelector('.active-mode')?.textContent, focused: mainWindow.document.activeElement === control, runs,
			}, { checked: String(mode === 'ide'), label: 'IDE mode', active: mode === 'ide' ? 'IDE' : 'Agents', focused: true, runs: 1 });
			for (const [key, keyCode] of [['Enter', 13], [' ', 32]] as const) {
				for (const type of ['keydown', 'keyup']) {
					control.dispatchEvent(new mainWindow.KeyboardEvent(type, { key, keyCode, bubbles: true, cancelable: true }));
				}
			}
			action.enabled = false;
			control.click();
			assert.deepStrictEqual({ disabled: control.getAttribute('aria-disabled'), runs }, { disabled: 'true', runs: 3 });
		});
	}
});
