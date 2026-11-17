/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ICodeWindow } from '../../window/electron-main/window.js';

/** Queue a chat handoff only when the open request selected one unambiguous editor. */
export function sendChatSessionToWindow(windows: readonly ICodeWindow[], resource: UriComponents | undefined): void {
	if (resource && windows.length === 1) {
		windows[0].sendWhenReady('vscode:openChatSession', CancellationToken.None, URI.revive(resource).toString());
	}
}
