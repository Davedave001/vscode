/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../sessions.web.main.js';
import '../web.test.terminal.js';
import { IWorkbenchConstructionOptions } from '../../../workbench/browser/web.api.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { TestSessionsBrowserMain } from '../web.test.js';
import { create as createTestWorkbench } from '../web.test.factory.js';
import { registerPreviewWorkspace } from '../browser/previewWorkspace.js';

class PreviewSessionsBrowserMain extends TestSessionsBrowserMain {
	protected override async createWorkspaceConfigAndStorageServices(...args: Parameters<TestSessionsBrowserMain['createWorkspaceConfigAndStorageServices']>): ReturnType<TestSessionsBrowserMain['createWorkspaceConfigAndStorageServices']> {
		this._register(await registerPreviewWorkspace(args[0].get(IFileService) as IFileService));
		return super.createWorkspaceConfigAndStorageServices(...args);
	}
}

export function create(element: HTMLElement, options: IWorkbenchConstructionOptions) {
	return createTestWorkbench(element, options, undefined, PreviewSessionsBrowserMain);
}

export { URI };
