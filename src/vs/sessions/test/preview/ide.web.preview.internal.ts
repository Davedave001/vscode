/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/workbench.web.main.js';
import { BrowserMain } from '../../../workbench/browser/web.main.js';
import { IWorkbenchConstructionOptions } from '../../../workbench/browser/web.api.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { WORKSPACE_MODE_SWITCH_KEYBINDING } from '../../../workbench/browser/parts/titlebar/workspaceModeSwitch.js';
import { registerPreviewWorkspace } from '../browser/previewWorkspace.js';

class PreviewIDEBrowserMain extends BrowserMain {
	protected override async createWorkspaceConfigAndStorageServices(...args: Parameters<BrowserMain['createWorkspaceConfigAndStorageServices']>): ReturnType<BrowserMain['createWorkspaceConfigAndStorageServices']> {
		this._register(await registerPreviewWorkspace(args[0].get(IFileService) as IFileService));
		return super.createWorkspaceConfigAndStorageServices(...args);
	}
}

export function create(element: HTMLElement, options: IWorkbenchConstructionOptions) {
	const store = new DisposableStore();
	for (const command of options.commands ?? []) {
		store.add(CommandsRegistry.registerCommand(command.id, (_accessor, ...args) => command.handler(...args)));
		if (command.id === 'preview.switchToAgents') {
			store.add(KeybindingsRegistry.registerKeybindingRule({ id: command.id, primary: WORKSPACE_MODE_SWITCH_KEYBINDING, weight: KeybindingWeight.WorkbenchContrib }));
			store.add(MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: command.id, title: command.label ?? localize('preview.returnToAgents', "Return to Agents") } }));
		}
	}
	const main = store.add(new PreviewIDEBrowserMain(element, options));
	const workbench = main.open();
	store.add(toDisposable(() => { void workbench.then(instance => instance.shutdown()); }));
	return store;
}

export { URI };
