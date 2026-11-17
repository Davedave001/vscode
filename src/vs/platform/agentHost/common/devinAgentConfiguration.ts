/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '../../configuration/common/configuration.js';

export const DevinSubscriptionProviderId = 'devin-subscription';
export const DevinSubscriptionResource = 'https://api.devin.ai';
export const AgentHostDevinExecutableSettingId = 'agents.subscriptions.devinExecutable';
export const AgentHostDevinExecutableEnvVar = 'VSCODE_AGENT_HOST_DEVIN_EXECUTABLE';

export function buildDevinAgentEnvironment(configuration: Pick<IConfigurationService, 'getValue'>, inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const executable = configuration.getValue<string>(AgentHostDevinExecutableSettingId)?.trim();
	return executable && inherited[AgentHostDevinExecutableEnvVar] === undefined ? { [AgentHostDevinExecutableEnvVar]: executable } : {};
}
