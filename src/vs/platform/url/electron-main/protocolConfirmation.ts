/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../base/common/network.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';

const protocolConfirmationSettings = {
	[Schemas.file]: 'security.promptForLocalFileProtocolHandling',
	[Schemas.vscodeRemote]: 'security.promptForRemoteFileProtocolHandling',
};

/** Apply the existing destination-specific confirmation policy to an external editor request. */
export async function shouldBlockProtocolRequest(scheme: string, message: string, configurationService: IConfigurationService, windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService, editorRequest = false): Promise<boolean> {
	// New external authorities must enter a destination's confirmation gate or confirm inside the window.
	if (scheme !== Schemas.file && scheme !== Schemas.vscodeRemote) { return false; }

	const askForConfirmation = configurationService.getValue<unknown>(protocolConfirmationSettings[scheme]);
	if (askForConfirmation === false) {
		return false; // not blocked via settings
	}

	const { response, checkboxChecked } = await dialogMainService.showMessageBox({
		type: 'warning',
		buttons: [
			localize({ key: 'open', comment: ['&& denotes a mnemonic'] }, "&&Yes"),
			localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&No")
		],
		message,
		detail: localize('confirmOpenDetail', "If you did not initiate this request, it may represent an attempted attack on your system. Unless you took an explicit action to initiate this request, you should press 'No'"),
		checkboxLabel: editorRequest
			? scheme === Schemas.file ? localize('doNotAskAgainLocalEditor', "Allow local paths and chats without asking") : localize('doNotAskAgainRemoteEditor', "Allow remote paths and chats without asking")
			: scheme === Schemas.file ? localize('doNotAskAgainLocal', "Allow opening local paths without asking") : localize('doNotAskAgainRemote', "Allow opening remote paths without asking"),
		cancelId: 1
	});

	if (response !== 0) {
		return true; // blocked by user choice
	}

	if (checkboxChecked) {
		// Due to https://github.com/microsoft/vscode/issues/195436, we can only
		// update settings from within a window. But we do not know if a window
		// is about to open or can already handle the request, so we have to send
		// to any current window and any newly opening window.
		const request = { channel: 'vscode:disablePromptForProtocolHandling', args: scheme === Schemas.file ? 'local' : 'remote' };
		windowsMainService.sendToFocused(request.channel, request.args);
		windowsMainService.sendToOpeningWindow(request.channel, request.args);
	}

	return false; // not blocked by user choice
}
