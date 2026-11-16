/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMenu, IMenuService, MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import '../../browser/sessionWorkspaceActions.js';

suite('Session Workspace Actions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const becomesUnavailable of [false, true]) {
		test(becomesUnavailable ? 'rechecks tool availability before executing a picked action' : 'offers native enabled tools and runs the selected action', async () => {
			const instantiation = store.add(new TestInstantiationService());
			let enabled = true;
			let runs = 0;
			let disposed = false;
			const notifications: string[] = [];
			const tools = [
				upcastPartial<MenuItemAction>({ id: 'files', label: 'Files', get enabled() { return enabled; }, run: async () => { runs++; } }),
				upcastPartial<MenuItemAction>({ id: 'blocked', label: 'Unavailable', enabled: false }),
			];
			const menu = upcastPartial<IMenu>({ getActions: () => [['navigation', tools]], dispose: () => { disposed = true; } });
			instantiation.stub(IMenuService, upcastPartial<IMenuService>({ createMenu: () => menu }));
			instantiation.stub(IContextKeyService, upcastPartial<IContextKeyService>({}));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: message => { notifications.push(String(message)); } }));
			const quickInput = new TestQuickInputService();
			const pick = sinon.stub(quickInput, 'pick').callsFake(async () => {
				enabled = !becomesUnavailable;
				return { id: 'files', label: 'Files' };
			});
			instantiation.stub(IQuickInputService, quickInput);
			try {
				await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.openSessionTools')!.handler(accessor));
				assert.deepStrictEqual({ offered: pick.firstCall.args[0], runs, disposed, notices: notifications.length }, {
					offered: [{ id: 'files', label: 'Files' }], runs: becomesUnavailable ? 0 : 1, disposed: true, notices: becomesUnavailable ? 1 : 0,
				});
			} finally {
				pick.restore();
			}
		});
	}
});
