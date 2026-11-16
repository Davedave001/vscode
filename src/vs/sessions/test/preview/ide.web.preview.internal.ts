/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/workbench.web.main.js';
import { BrowserMain } from '../../../workbench/browser/web.main.js';
import { IWorkbenchConstructionOptions } from '../../../workbench/browser/web.api.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { IFileService } from '../../../platform/files/common/files.js';
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
	}
	const main = store.add(new PreviewIDEBrowserMain(element, options));
	const workbench = main.open();
	store.add(toDisposable(() => { void workbench.then(instance => instance.shutdown()); }));
	return store;
}

export { URI };
