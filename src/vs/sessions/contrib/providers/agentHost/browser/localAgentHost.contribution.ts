/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { AgentHostContribution } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.js';
import { AgentHostTerminalContribution } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostTerminalContribution.js';
import { AgentHostCopilotCliSettingsContribution } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostCopilotCliSettingsContribution.js';
import { AgentHostSignedOutCompatibilityContribution } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSignedOutCompatibilityContribution.js';
import { AgentHostSdkSetupNotificationContribution } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSdkSetupNotification.js';
import { AgentHostSignedOutModelsNotificationContribution } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSignedOutModelsNotification.js';
import './codexCustomizationSettings.contribution.js';
import { registerLocalAgentHostSessionsProvider } from '../../../../../workbench/contrib/sessions/providers/agentHost/browser/localAgentHostSessionsProviderRegistration.js';

/** Registers the local agent host sessions provider of the Agents window. */
class LocalAgentHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.localAgentHostContribution';

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._register(instantiationService.invokeFunction(registerLocalAgentHostSessionsProvider));
	}
}

// Agent discovery, model registration and cached sessions are needed by the
// initial composer. Do not leave them behind the background idle queue.
registerWorkbenchContribution2(AgentHostContribution.ID, AgentHostContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AgentHostTerminalContribution.ID, AgentHostTerminalContribution, WorkbenchPhase.BlockRestore);
// Forwards the `chat.agentHost.copilot.*` settings into the host's root config. Without it those
// gates never reach the host here, so features like the Auto routing-profile picker stay off.
registerWorkbenchContribution2(AgentHostCopilotCliSettingsContribution.ID, AgentHostCopilotCliSettingsContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AgentHostSignedOutCompatibilityContribution.ID, AgentHostSignedOutCompatibilityContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AgentHostSignedOutModelsNotificationContribution.ID, AgentHostSignedOutModelsNotificationContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AgentHostSdkSetupNotificationContribution.ID, AgentHostSdkSetupNotificationContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(LocalAgentHostContribution.ID, LocalAgentHostContribution, WorkbenchPhase.BlockRestore);
