/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { AgentHostClaudeAgentEnabledSettingId, AgentHostCodexAgentEnabledSettingId, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { CLAUDE_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ITerminalLaunchError, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { resolveSessionCommandTarget } from '../../../../workbench/contrib/sessions/browser/sessionCommandTarget.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ICodexAccountService, getCodexAccountPlanName } from '../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IAgentSdkSetupService } from '../../../../workbench/services/agentHost/browser/agentSdkSetupService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { AgentHostDevinExecutableSettingId, DevinSubscriptionProviderId } from '../../../../platform/agentHost/common/devinAgentConfiguration.js';
import { IDevinSubscriptionConnection } from './devinSubscriptionConnection.js';
import { AgentsWindowMenus } from '../../../browser/agentsWindowMenus.js';

export const CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING = 'agents.subscriptions.claudeExecutable';
export const DEVIN_SUBSCRIPTION_EXECUTABLE_SETTING = AgentHostDevinExecutableSettingId;
export const DEVIN_SUBSCRIPTION_AUTH_PROVIDER = DevinSubscriptionProviderId;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agents.subscriptions',
	title: localize('subscriptions.settingsTitle', "Agent Subscriptions"),
	properties: {
		[CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING]: {
			type: 'string', default: 'claude',
			scope: ConfigurationScope.MACHINE, restricted: true,
			description: localize('subscriptions.claudeExecutable', "Path to the official Claude Code executable used for your Claude subscription. Sign-in is handled by Claude Code."),
		},
	},
});

/** Leaves authentication and credential storage with the provider's own client. */
export async function connectCodexSubscription(accessor: ServicesAccessor): Promise<void> {
	const configuration = accessor.get(IConfigurationService);
	const notifications = accessor.get(INotificationService);
	if (configuration.inspect<boolean>(AgentHostCodexAgentEnabledSettingId)?.policyValue === false) {
		notifications.info(localize('subscriptions.codexPolicyDisabled', "Codex is disabled by your organization's settings."));
		return;
	}
	const account = accessor.get(ICodexAccountService);
	await configuration.updateValue(AgentHostCodexAgentEnabledSettingId, true, ConfigurationTarget.USER);
	if (account.account.status === 'signedIn') {
		notifications.info(localize('subscriptions.codexReady', "Codex is enabled with your {0}. Choose Codex in the agent picker to start a session.", getCodexAccountPlanName(account.account)));
	} else {
		account.signIn();
	}
}

/** Enables the existing native provider without implementing another Claude account flow. */
export async function enableClaudeAgent(accessor: ServicesAccessor): Promise<void> {
	const configuration = accessor.get(IConfigurationService);
	const notifications = accessor.get(INotificationService);
	if (configuration.inspect<boolean>(AgentHostClaudeAgentEnabledSettingId)?.policyValue === false) {
		notifications.info(localize('subscriptions.claudePolicyDisabled', "Claude is disabled by your organization's settings."));
		return;
	}
	if (accessor.get(IWorkbenchEnvironmentService).remoteAuthority) {
		notifications.info(localize('subscriptions.claudeLocalAgentRequired', "Open a local Signal-C window to connect the native Claude agent to this computer's Claude Code configuration."));
		return;
	}
	const host = accessor.get(IAgentHostService);
	const setup = accessor.get(IAgentSdkSetupService);
	if (configuration.inspect<boolean>(AgentHostClaudeAgentEnabledSettingId)?.policyValue !== true && configuration.getValue<boolean>(AgentHostClaudeAgentEnabledSettingId) !== true) {
		await configuration.updateValue(AgentHostClaudeAgentEnabledSettingId, true, ConfigurationTarget.USER);
	}
	if (configuration.inspect<boolean>(AgentHostClaudeAgentEnabledSettingId)?.policyValue === false || configuration.getValue<boolean>(AgentHostClaudeAgentEnabledSettingId) === false) {
		notifications.info(localize('subscriptions.claudeEnablementChanged', "Claude could not be enabled under the current settings."));
		return;
	}
	const root = host.rootState.value;
	if (root && !(root instanceof Error) && root.agents.some(agent => agent.provider === CLAUDE_AGENT_PROVIDER_ID)) {
		setup.requestReload(CLAUDE_AGENT_PROVIDER_ID);
		notifications.info(localize('subscriptions.claudeEnabled', "Claude is enabled in the agent workspace. Its configured account and model catalog are being checked. Choose Claude and an Anthropic model when setup is ready."));
	} else {
		// Registering a disabled provider needs a new host; leave active chats alone until the user chooses it.
		notifications.prompt(Severity.Info, localize('subscriptions.claudeRestartRequired', "Claude is enabled. Restart the local agent host to make it available; running agent turns will be interrupted."), [{
			label: localize('subscriptions.restartAgentHost', "Restart Agent Host"),
			run: async () => {
				if (configuration.inspect<boolean>(AgentHostClaudeAgentEnabledSettingId)?.policyValue === false || configuration.getValue<boolean>(AgentHostClaudeAgentEnabledSettingId) === false) { return; }
				await host.restartAgentHost();
				// The newly constructed provider enumerates its account/models during startup.
			},
		}]);
	}
}

function refreshClaudeAfterSignIn(terminal: ITerminalInstance, configuration: IConfigurationService, setup: IAgentSdkSetupService): void {
	if (terminal.isDisposed) { return; }
	const listeners = new DisposableStore();
	let settled = false;
	const exited = (code: number | ITerminalLaunchError | undefined) => {
		if (settled) { return; }
		settled = true;
		listeners.dispose();
		if (code === 0 && configuration.getValue<boolean>(AgentHostClaudeAgentEnabledSettingId) !== false && configuration.inspect<boolean>(AgentHostClaudeAgentEnabledSettingId)?.policyValue !== false && setup.setups.some(info => info.agent === CLAUDE_AGENT_PROVIDER_ID)) {
			setup.requestReload(CLAUDE_AGENT_PROVIDER_ID);
		}
	};
	listeners.add(terminal.onDisposed(() => { settled = true; listeners.dispose(); }));
	listeners.add(terminal.onExit(exited));
	if (terminal.isDisposed) { listeners.dispose(); return; }
	// A fast login or launch failure may have exited before createTerminal returned.
	if (terminal.exitCode !== undefined) { exited(terminal.exitCode); }
}

export async function openSubscriptionClient(accessor: ServicesAccessor, provider: 'claude' | 'devin', signIn: boolean): Promise<void> {
	const target = resolveSessionCommandTarget(accessor, []);
	const folder = (target?.chat ?? target?.session?.mainChat.get())?.workspace.get()?.folders[0]?.workingDirectory
		?? accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri;
	if (!folder || folder.scheme !== Schemas.file) {
		accessor.get(INotificationService).info(localize('subscriptions.localFolderRequired', "Select a local workspace before opening a subscription client."));
		return;
	}
	const setting = provider === 'claude' ? CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING : DEVIN_SUBSCRIPTION_EXECUTABLE_SETTING;
	const configuration = accessor.get(IConfigurationService);
	const executable = configuration.getValue<string>(setting)?.trim() || provider;
	const claudeSetup = provider === 'claude' && signIn ? accessor.get(IAgentSdkSetupService) : undefined;
	const name = provider === 'claude' ? localize('subscriptions.claudeTerminal', "Claude Code · Subscription") : localize('subscriptions.devinTerminal', "Devin CLI");
	const terminals = accessor.get(ITerminalService);
	const terminal = await terminals.createTerminal({
		config: {
			name, executable, args: signIn ? ['auth', 'login'] : [], cwd: folder,
			// Subscription entry points must not silently select inherited API billing.
			env: provider === 'claude' ? { ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null } : { WINDSURF_API_KEY: null },
			waitOnExit: true,
		},
		location: TerminalLocation.Editor,
	});
	if (claudeSetup) { refreshClaudeAfterSignIn(terminal, configuration, claudeSetup); }
	terminals.setActiveInstance(terminal);
	await terminals.revealTerminal(terminal);
}

export class AgentSubscriptionsAction extends Action2 {
	static readonly ID = 'sessions.manageAgentSubscriptions';
	constructor() {
		super({
			id: AgentSubscriptionsAction.ID,
			title: localize2('subscriptions.manage', "Agent Subscriptions"),
			icon: Codicon.account,
			f1: true,
			precondition: ContextKeyExpr.and(IsSessionsWindowContext, IsWebContext.negate()),
			menu: [
				{ id: AgentsWindowMenus.AccountMenu, group: '1_account', order: 0, when: IsWebContext.negate() },
				{ id: AgentsWindowMenus.TitleBarCenterRight, group: 'navigation', order: 80, when: ContextKeyExpr.and(IsSessionsWindowContext, IsWebContext.negate()) },
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const instantiation = accessor.get(IInstantiationService);
		const devin = accessor.get(IDevinSubscriptionConnection);
		const notifications = accessor.get(INotificationService);
		const codex = accessor.get(ICodexAccountService).account;
		const devinStatus = devin.status.get();
		const devinDescriptions = {
			checking: localize('subscriptions.devinChecking', "Checking connection"),
			signedOut: localize('subscriptions.devinSignedOut', "Not signed in"),
			signingIn: localize('subscriptions.devinSigningIn', "Browser sign-in in progress"),
			connecting: localize('subscriptions.devinConnecting', "Sign-in saved · connecting"),
			unavailable: localize('subscriptions.devinUnavailable', "Sign-in saved · agent unavailable"),
			failed: localize('subscriptions.devinFailed', "Connection needs attention"),
			ready: devinStatus.kind === 'ready' ? localize('subscriptions.devinModelsReady', "{0} models ready", devinStatus.modelCount) : '',
		};
		const provider = await quickInput.pick([
			{ id: 'codex' as const, label: localize('subscriptions.codex', "Codex"), description: codex.status === 'signedIn' ? getCodexAccountPlanName(codex) : localize('subscriptions.chatGPT', "ChatGPT subscription"), detail: localize('subscriptions.codexDetail', "Connect your ChatGPT account to the native Codex agent.") },
			{ id: 'claude' as const, label: localize('subscriptions.claude', "Anthropic"), description: localize('subscriptions.claudePlan', "Claude subscription"), detail: localize('subscriptions.claudeDetail', "Sign in with official Claude Code, or enable the native Claude agent using its configured account.") },
			{ id: 'devin-subscription' as const, label: localize('subscriptions.devinSubscription', "Devin Subscription"), description: devinDescriptions[devinStatus.kind], detail: devinStatus.kind === 'unavailable' ? localize('subscriptions.devinUnavailableDetail', "Check the Devin executable setting and restart the local agent host. Your saved sign-in will be reused.") : localize('subscriptions.devinSubscriptionDetail', "Connect your Devin account and load its models into the native Devin Subscription agent. Select again to retry; a saved sign-in is reused.") },
			{ id: 'devin' as const, label: localize('subscriptions.devinCLI', "Devin CLI"), description: localize('subscriptions.devinClient', "Official command-line client"), detail: localize('subscriptions.devinDetail', "Open the installed Devin CLI using its own account sign-in.") },
		], { title: localize('subscriptions.title', "Agent Subscriptions"), placeHolder: localize('subscriptions.chooseProvider', "Choose the subscription you want to use"), matchOnDescription: true, matchOnDetail: true });
		if (!provider) { return; }
		if (provider.id === 'devin-subscription') {
			await devin.connect();
			const status = devin.status.get();
			if (status.kind === 'ready') {
				notifications.info(localize('subscriptions.devinConnected', "Devin Subscription has {0} models ready. Choose Devin Subscription in the agent picker, then select a model.", status.modelCount));
			} else if (status.kind === 'signedOut') {
				notifications.info(localize('subscriptions.devinDisconnected', "Devin Subscription is signed out. Open Agent Subscriptions to sign in."));
			} else {
				notifications.info(localize('subscriptions.devinPending', "Devin models have not appeared yet. Reopen Agent Subscriptions to check the connection or retry."));
			}
			return;
		}
		if (provider.id === 'codex') {
			await instantiation.invokeFunction(connectCodexSubscription);
			return;
		}
		const action = await quickInput.pick([
			...(provider.id === 'claude' ? [{ id: 'native', label: localize('subscriptions.claudeNative', "Use in Agent Workspace"), detail: localize('subscriptions.claudeNativeDetail', "Enable the native Claude agent. It uses your local Claude Code configuration; API keys or cloud-provider settings can affect billing.") }] : []),
			{ id: 'open', label: localize('subscriptions.openClient', "Open {0}", provider.id === 'claude' ? 'Claude Code' : 'Devin CLI'), detail: localize('subscriptions.openDetail', "Continue in the official client using its saved sign-in.") },
			{ id: 'signIn', label: localize('subscriptions.signIn', "Sign in"), detail: localize('subscriptions.signInDetail', "Open the provider's own account sign-in flow.") },
		], { title: provider.label });
		if (action?.id === 'native') { await instantiation.invokeFunction(enableClaudeAgent); }
		else if (action) { await instantiation.invokeFunction(openSubscriptionClient, provider.id, action.id === 'signIn'); }
	}
}

registerAction2(AgentSubscriptionsAction);
