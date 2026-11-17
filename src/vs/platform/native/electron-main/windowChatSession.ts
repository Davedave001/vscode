/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IOpenEmptyWindowOptions } from '../../window/common/window.js';
import { IOpenEmptyConfiguration, IWindowsMainService } from '../../windows/electron-main/windows.js';
import { findWindowForEmptyHandoff } from '../../windows/electron-main/windowsFinder.js';

/** Open or reuse a folderless editor, then hand the conversation to its single selected window. */
export async function openEmptyWindowWithChat(windowsService: IWindowsMainService, configuration: IOpenEmptyConfiguration, options?: IOpenEmptyWindowOptions): Promise<ICodeWindow[]> {
	const windows = await windowsService.openEmptyWindow(configuration, options);
	// Startup may also recover hot-exit backups. Keep those windows open, but
	// choose one ordinary editor on the requested host for this explicit handoff.
	const target = configuration.initialStartup && options?.reuseExistingWindow && windows.length > 1
		? findWindowForEmptyHandoff(windows, options.remoteAuthority || undefined)
		: undefined;
	sendChatSessionToWindow(target ? [target] : windows, options?.chatSessionToOpen);
	return windows;
}

/** Queue a chat handoff only when the open request selected one unambiguous editor. */
export function sendChatSessionToWindow(windows: readonly ICodeWindow[], resource: UriComponents | undefined): void {
	if (resource && windows.length === 1) {
		windows[0].sendWhenReady('vscode:openChatSession', CancellationToken.None, URI.revive(resource).toString());
	}
}
