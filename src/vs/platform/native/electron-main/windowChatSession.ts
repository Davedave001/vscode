/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IEditorWindowLink, IOpenEmptyWindowOptions } from '../../window/common/window.js';
import { IOpenConfiguration, IOpenEmptyConfiguration, IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { findWindowForEmptyHandoff } from '../../windows/electron-main/windowsFinder.js';

/** Restore every requested workspace root through the normal workspace matching and chat-target selection. */
export function openEditorWindowLink(windowsService: IWindowsMainService, cli: IOpenConfiguration['cli'], link: IEditorWindowLink, initialStartup = false): Promise<ICodeWindow[]> {
	if (link.folders?.length) {
		return windowsService.open({
			context: OpenContext.LINK, cli, initialStartup,
			urisToOpen: link.folders.map(folderUri => ({ folderUri })),
			forceNewWindow: true, reuseWorkspaceContainingFolder: true,
			chatSessionToOpen: link.chatSessionToOpen ? { kind: 'resource', resource: link.chatSessionToOpen.toString() } : undefined,
		});
	}
	return openEmptyWindowWithChat(windowsService, { context: OpenContext.LINK, initialStartup }, { remoteAuthority: link.remoteAuthority ?? null, reuseExistingWindow: true, chatSessionToOpen: link.chatSessionToOpen });
}

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
