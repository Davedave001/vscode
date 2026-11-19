/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getCaseInsensitive } from '../../../base/common/objects.js';
import { win32 } from '../../../base/common/path.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';

export const DevinSubscriptionProviderId = 'devin-subscription';
export const DevinSubscriptionResource = 'https://api.devin.ai';
export const AgentHostDevinExecutableSettingId = 'agents.subscriptions.devinExecutable';
export const AgentHostDevinExecutableEnvVar = 'VSCODE_AGENT_HOST_DEVIN_EXECUTABLE';

/** A Start menu launch can inherit a PATH from before Devin CLI was installed. */
export function getWindowsDevinExecutable(environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const localAppData = getCaseInsensitive(environment, 'LOCALAPPDATA');
	return typeof localAppData === 'string' && win32.isAbsolute(localAppData)
		? win32.join(localAppData, 'devin', 'cli', 'bin', 'devin.exe')
		: undefined;
}

export function buildDevinAgentEnvironment(configuration: Pick<IConfigurationService, 'getValue'>, inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const executable = configuration.getValue<string>(AgentHostDevinExecutableSettingId)?.trim();
	return executable && inherited[AgentHostDevinExecutableEnvVar] === undefined ? { [AgentHostDevinExecutableEnvVar]: executable } : {};
}
