/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { INativeEnvironmentService } from '../../environment/common/environment.js';

/** Arguments registered with Electron for Windows protocol launches. */
export function getWindowsProtocolHandlerArguments(environment: Pick<INativeEnvironmentService, 'isBuilt' | 'appRoot' | 'args' | 'userDataPath' | 'extensionsPath' | 'appSharedDataHome'>): string[] {
	// Electron quotes each registered argument itself, including spaces and trailing backslashes.
	const args = environment.isBuilt ? [] : [environment.appRoot];
	if (environment.args['user-data-dir']) { args.push('--user-data-dir', environment.userDataPath); }
	if (environment.args['extensions-dir']) { args.push('--extensions-dir', environment.extensionsPath); }
	if (environment.args['shared-data-dir']) { args.push('--shared-data-dir', environment.appSharedDataHome.fsPath); }
	args.push('--open-url', '--');
	return args;
}
