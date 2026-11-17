/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CLAUDE_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { readAgentModelCatalogStatus } from '../../../../platform/agentHost/common/agentModelCatalogStatus.js';
import { readAgentSdkSetupInfos } from '../../../../platform/agentHost/common/agentSdkSetup.js';
import { CLAUDE_PROVIDER_ANTHROPIC } from '../../../../platform/agentHost/common/claudeProviders.js';
import type { RootState } from '../../../../platform/agentHost/common/state/protocol/state.js';

/** Presents the host's published setup and catalog without inferring subscription entitlement. */
export function getClaudeSubscriptionPresentation(state: {
	readonly root: RootState | Error | undefined;
	readonly enabled: boolean;
	readonly policyDisabled: boolean;
	readonly remote: boolean;
}): { description: string; detail: string } {
	if (state.policyDisabled) {
		return { description: localize('claude.policyDisabled', "Disabled by organization"), detail: localize('claude.policyDetail', "Your organization's settings disable the native Claude agent.") };
	}
	if (state.remote) {
		return { description: localize('claude.localWindowRequired', "Local window required"), detail: localize('claude.localWindowDetail', "Open a local Signal-C window to use this computer's Claude Code configuration with the native agent.") };
	}
	if (!state.enabled) {
		return { description: localize('claude.disabled', "Native agent disabled"), detail: localize('claude.disabledDetail', "Choose Use in Agent Workspace to enable Claude, then check its configured account and models.") };
	}
	if (state.root instanceof Error) {
		return { description: localize('claude.hostUnavailable', "Agent host unavailable"), detail: localize('claude.hostUnavailableDetail', "The local agent host could not be reached. Choose Use in Agent Workspace for restart options.") };
	}
	if (!state.root) {
		return { description: localize('claude.checkingHost', "Checking agent host"), detail: localize('claude.checkingHostDetail', "Reopen Agent Subscriptions after the local agent host has started.") };
	}
	const agent = state.root.agents.find(agent => agent.provider === CLAUDE_AGENT_PROVIDER_ID);
	if (!agent) {
		return { description: localize('claude.agentUnavailable', "Native agent unavailable"), detail: localize('claude.agentUnavailableDetail', "Choose Use in Agent Workspace to restart the host and register the enabled Claude agent.") };
	}
	const setup = readAgentSdkSetupInfos(state.root).find(setup => setup.agent === CLAUDE_AGENT_PROVIDER_ID);
	if (setup?.download === 'downloading') {
		return { description: localize('claude.downloading', "Preparing Claude runtime"), detail: localize('claude.downloadingDetail', "The native runtime is downloading. Account and model checks follow when it is available.") };
	}
	if (setup?.download === 'notDownloaded' || setup?.download === 'downloadOnUse') {
		return { description: localize('claude.runtimeNeeded', "Claude runtime setup needed"), detail: localize('claude.runtimeNeededDetail', "Finish Claude runtime setup in the agent workspace before checking the configured account and models.") };
	}
	const catalog = readAgentModelCatalogStatus(state.root, CLAUDE_AGENT_PROVIDER_ID);
	if (catalog === 'pending') {
		return { description: localize('claude.checkingModels', "Checking account and models"), detail: localize('claude.checkingModelsDetail', "Claude is refreshing its configured account and model catalog. Reopen Agent Subscriptions to check the result.") };
	}
	if (catalog === 'error') {
		return { description: localize('claude.catalogError', "Model refresh needs attention"), detail: localize('claude.catalogErrorDetail', "A model source could not be checked. Previously loaded models may remain available. Choose Use in Agent Workspace to retry.") };
	}
	// Copilot-routed Claude models are a different connection and cannot establish native setup.
	const nativeModels = agent.models.filter(model => model.provider === CLAUDE_PROVIDER_ANTHROPIC).length;
	if (nativeModels > 0) {
		return {
			description: nativeModels === 1 ? localize('claude.oneModel', "1 Anthropic model available") : localize('claude.models', "{0} Anthropic models available", nativeModels),
			detail: localize('claude.modelsDetail', "Choose Claude and an Anthropic model in the agent workspace. It uses your local Claude Code account configuration; API keys or cloud-provider settings can affect billing."),
		};
	}
	if (!setup && !catalog) {
		return { description: localize('claude.checkingSetup', "Waiting for Claude setup"), detail: localize('claude.checkingSetupDetail', "The host has not reported Claude setup yet. Choose Use in Agent Workspace to check again.") };
	}
	return { description: localize('claude.noNativeModels', "No Anthropic models available"), detail: localize('claude.noNativeModelsDetail', "Sign in with official Claude Code or check its local account configuration, then choose Use in Agent Workspace to refresh.") };
}
