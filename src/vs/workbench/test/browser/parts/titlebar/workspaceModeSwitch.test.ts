/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Action, ActionRunner } from '../../../../../base/common/actions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkspaceModeSwitch } from '../../../../browser/parts/titlebar/workspaceModeSwitch.js';
import { workbenchInstantiationService } from '../../workbenchTestServices.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';

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
			const clicked = Event.toPromise(bar.onDidRun);
			control.click();
			await clicked;
			assert.deepStrictEqual({
				checked: control.getAttribute('aria-checked'), label: control.getAttribute('aria-label'),
				active: control.querySelector('.active-mode')?.textContent, focused: mainWindow.document.activeElement === control, runs,
			}, { checked: String(mode === 'ide'), label: 'IDE mode', active: mode === 'ide' ? 'IDE' : 'Agents', focused: true, runs: 1 });
			for (const [key, keyCode] of [['Enter', 13], [' ', 32]] as const) {
				const completed = Event.toPromise(bar.onDidRun);
				for (const type of ['keydown', 'keyup']) {
					control.dispatchEvent(new mainWindow.KeyboardEvent(type, { key, keyCode, bubbles: true, cancelable: true }));
				}
				await completed;
			}
			action.enabled = false;
			control.click();
			assert.deepStrictEqual({ disabled: control.getAttribute('aria-disabled'), runs }, { disabled: 'true', runs: 3 });
		});
	}

	test('ignores repeated mouse and keyboard activation until the handoff finishes', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const pending = new DeferredPromise<void>();
		let runs = 0;
		const action = store.add(new Action('switchMode', 'Switch Mode', undefined, true, async () => { runs++; await pending.p; }));
		const element = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => element.remove()));
		const bar = store.add(new ActionBar(element, { actionViewItemProvider: (item, options) => instantiation.createInstance(WorkspaceModeSwitch, item, options, 'agents', action.id) }));
		bar.push(action);
		bar.focus(0);
		const control = element.querySelector<HTMLElement>('[role="switch"]')!;
		const completed = Event.toPromise(bar.onDidRun);
		control.click();
		control.click();
		for (const [key, keyCode] of [['Enter', 13], [' ', 32]] as const) {
			for (const type of ['keydown', 'keyup']) { control.dispatchEvent(new mainWindow.KeyboardEvent(type, { key, keyCode, bubbles: true, cancelable: true })); }
		}
		assert.strictEqual(runs, 1);
		assert.deepStrictEqual({ busy: control.getAttribute('aria-busy'), disabled: control.getAttribute('aria-disabled'), checked: control.getAttribute('aria-checked'), enabled: action.enabled, focused: mainWindow.document.activeElement === control }, { busy: 'true', disabled: 'true', checked: 'false', enabled: true, focused: true });
		await pending.complete();
		await completed;
		assert.deepStrictEqual({ busy: control.getAttribute('aria-busy'), disabled: control.getAttribute('aria-disabled') }, { busy: 'false', disabled: 'false' });
		const retried = Event.toPromise(bar.onDidRun);
		control.click();
		await retried;
		assert.strictEqual(runs, 2);
	});

	test('keeps an external disabled state after a pending handoff completes', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const pending = new DeferredPromise<void>();
		const action = store.add(new Action('switchMode', 'Switch Mode', undefined, true, () => pending.p));
		const element = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => element.remove()));
		const bar = store.add(new ActionBar(element, { actionViewItemProvider: (item, options) => instantiation.createInstance(WorkspaceModeSwitch, item, options, 'ide', action.id) }));
		bar.push(action);
		const control = element.querySelector<HTMLElement>('[role="switch"]')!;
		const completed = Event.toPromise(bar.onDidRun);
		control.click();
		action.enabled = false;
		await pending.complete();
		await completed;
		assert.strictEqual(action.enabled, false);
		assert.strictEqual(control.getAttribute('aria-disabled'), 'true');
		action.enabled = true;
		assert.strictEqual(control.getAttribute('aria-disabled'), 'false');
	});

	test('reports a failed handoff through the toolbar runner and allows retry', async () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const pending = new DeferredPromise<void>();
		let runs = 0;
		const action = store.add(new Action('switchMode', 'Switch Mode', undefined, true, async () => { if (++runs === 1) { await pending.p; } }));
		const element = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => element.remove()));
		const bar = store.add(new ActionBar(element, { actionViewItemProvider: (item, options) => instantiation.createInstance(WorkspaceModeSwitch, item, options, 'agents', action.id) }));
		bar.push(action);
		const control = element.querySelector<HTMLElement>('[role="switch"]')!;
		const completed = Event.toPromise(bar.onDidRun);
		control.click();
		const failure = new Error('Could not open the editor');
		await pending.error(failure);
		assert.strictEqual((await completed).error, failure);
		assert.deepStrictEqual({ busy: control.getAttribute('aria-busy'), disabled: control.getAttribute('aria-disabled') }, { busy: 'false', disabled: 'false' });
		const retried = Event.toPromise(bar.onDidRun);
		control.click();
		assert.strictEqual((await retried).error, undefined);
		assert.strictEqual(runs, 2);
	});

	for (const fails of [false, true]) {
		test(`preserves the runner result when the switch is disposed before ${fails ? 'failure' : 'completion'}`, async () => {
			const instantiation = workbenchInstantiationService(undefined, store);
			const pending = new DeferredPromise<void>();
			const action = store.add(new Action('switchMode', 'Switch Mode', undefined, true, () => pending.p));
			const element = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
			store.add(toDisposable(() => element.remove()));
			const runner = store.add(new ActionRunner());
			const view = store.add(instantiation.createInstance(WorkspaceModeSwitch, action, undefined, 'agents', action.id));
			view.actionRunner = runner;
			view.render(element);
			const completed = Event.toPromise(runner.onDidRun);
			element.click();
			view.dispose();
			const failure = fails ? new Error('Could not open the editor') : undefined;
			if (failure) { await pending.error(failure); } else { await pending.complete(); }
			assert.strictEqual((await completed).error, failure);
			assert.strictEqual(action.enabled, true);
		});
	}

	test('refreshes the accessible shortcut description after remapping or removing a binding', () => {
		const changed = store.add(new Emitter<void>());
		let shortcut: string | undefined = 'Ctrl+K Ctrl+Shift+A';
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IKeybindingService, new class extends MockKeybindingService {
			override get onDidUpdateKeybindings() { return changed.event; }
			override appendKeybinding(label: string) { return shortcut ? `${label} (${shortcut})` : label; }
		}());
		const action = store.add(new Action('switchMode', 'Switch Mode'));
		const element = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => element.remove()));
		const control = store.add(instantiation.createInstance(WorkspaceModeSwitch, action, undefined, 'agents', action.id));
		control.render(element);
		assert.ok(element.getAttribute('aria-description')?.includes('Ctrl+K Ctrl+Shift+A'));
		shortcut = 'F9';
		changed.fire();
		assert.strictEqual(element.getAttribute('aria-description'), 'Switch to IDE with This Session\'s Workspace (F9)');
		shortcut = undefined;
		changed.fire();
		assert.strictEqual(element.getAttribute('aria-description'), 'Switch to IDE with This Session\'s Workspace');
	});
});
