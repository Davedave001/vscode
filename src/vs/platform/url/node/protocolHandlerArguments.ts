/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { win32 } from '../../../base/common/path.js';
import type { INativeEnvironmentService } from '../../environment/common/environment.js';

export const SIGNAL_C_PROTOCOL = 'signal-c';
const previewProtocolPrefix = `${SIGNAL_C_PROTOCOL}-preview-`;

export function getWindowsPreviewProtocol(userDataPath: string): string {
	const profile = win32.normalize(userDataPath).replace(/[\\/]+$/, '').toLowerCase();
	return previewProtocolPrefix + createHash('sha256').update(profile).digest('hex').slice(0, 16);
}

/** Arguments registered with Electron for Windows protocol launches. */
export function getWindowsProtocolHandlerArguments(environment: Pick<INativeEnvironmentService, 'isBuilt' | 'appRoot' | 'args' | 'userDataPath' | 'extensionsPath' | 'appSharedDataHome'>, protocol?: string): string[] {
	// Electron quotes each registered argument itself, including spaces and trailing backslashes.
	const args = environment.isBuilt ? [] : [environment.appRoot];
	const preview = protocol?.startsWith(previewProtocolPrefix);
	if (preview) { args.push('--agent-workspace-preview'); }
	if (preview || environment.args['user-data-dir']) { args.push('--user-data-dir', environment.userDataPath); }
	if (environment.args['extensions-dir']) { args.push('--extensions-dir', environment.extensionsPath); }
	if (environment.args['shared-data-dir']) { args.push('--shared-data-dir', environment.appSharedDataHome.fsPath); }
	for (const argument of ['agent-codex-home', 'agent-claude-config-dir', 'agent-cli-fallback-dir'] as const) {
		const value = environment.args[argument];
		if (value) { args.push(`--${argument}`, value); }
	}
	args.push('--open-url', '--');
	return args;
}
