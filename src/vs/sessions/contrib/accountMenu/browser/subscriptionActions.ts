/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { AgentHostCodexAgentEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { resolveSessionCommandTarget } from '../../../../workbench/contrib/sessions/browser/sessionCommandTarget.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ICodexAccountService, getCodexAccountPlanName } from '../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { AgentsWindowMenus } from '../../../browser/agentsWindowMenus.js';

export const CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING = 'agents.subscriptions.claudeExecutable';
export const DEVIN_SUBSCRIPTION_EXECUTABLE_SETTING = 'agents.subscriptions.devinExecutable';
export const DEVIN_SUBSCRIPTION_AUTH_PROVIDER = 'devin-subscription';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agents.subscriptions',
	title: localize('subscriptions.settingsTitle', "Agent Subscriptions"),
	properties: {
		[CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING]: {
			type: 'string', default: 'claude',
			scope: ConfigurationScope.MACHINE, restricted: true,
			description: localize('subscriptions.claudeExecutable', "Path to the official Claude Code executable used for your Claude subscription. Sign-in is handled by Claude Code."),
		},
		[DEVIN_SUBSCRIPTION_EXECUTABLE_SETTING]: {
			type: 'string', default: 'devin',
			scope: ConfigurationScope.MACHINE, restricted: true,
			description: localize('subscriptions.devinExecutable', "Path to the official Devin CLI executable used for your Devin subscription. Sign-in is handled by Devin CLI."),
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

export async function openSubscriptionClient(accessor: ServicesAccessor, provider: 'claude' | 'devin', signIn: boolean): Promise<void> {
	const target = resolveSessionCommandTarget(accessor, []);
	const folder = (target?.chat ?? target?.session?.mainChat.get())?.workspace.get()?.folders[0]?.workingDirectory
		?? accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri;
	if (!folder || folder.scheme !== Schemas.file) {
		accessor.get(INotificationService).info(localize('subscriptions.localFolderRequired', "Select a local workspace before opening a subscription client."));
		return;
	}
	const setting = provider === 'claude' ? CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING : DEVIN_SUBSCRIPTION_EXECUTABLE_SETTING;
	const executable = accessor.get(IConfigurationService).getValue<string>(setting)?.trim() || provider;
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
		const authentication = accessor.get(IAuthenticationService);
		const notifications = accessor.get(INotificationService);
		const codex = accessor.get(ICodexAccountService).account;
		const provider = await quickInput.pick([
			{ id: 'codex' as const, label: localize('subscriptions.codex', "Codex"), description: codex.status === 'signedIn' ? getCodexAccountPlanName(codex) : localize('subscriptions.chatGPT', "ChatGPT subscription"), detail: localize('subscriptions.codexDetail', "Connect your ChatGPT account to the native Codex agent.") },
			{ id: 'claude' as const, label: localize('subscriptions.claude', "Anthropic"), description: localize('subscriptions.claudePlan', "Claude subscription"), detail: localize('subscriptions.claudeDetail', "Use the official Claude Code client with your Claude account.") },
			{ id: 'devin-subscription' as const, label: localize('subscriptions.devinSubscription', "Devin Subscription"), description: localize('subscriptions.devinBrowser', "Browser account sign-in"), detail: localize('subscriptions.devinSubscriptionDetail', "Connect a Devin account separately. Credentials are saved in this editor's secret storage; native chat integration is still in development.") },
			{ id: 'devin' as const, label: localize('subscriptions.devinCLI', "Devin CLI"), description: localize('subscriptions.devinClient', "Official command-line client"), detail: localize('subscriptions.devinDetail', "Open the installed Devin CLI using its own account sign-in.") },
		], { title: localize('subscriptions.title', "Agent Subscriptions"), placeHolder: localize('subscriptions.chooseProvider', "Choose the subscription you want to use"), matchOnDescription: true, matchOnDetail: true });
		if (!provider) { return; }
		if (provider.id === 'devin-subscription') {
			await authentication.createSession(DEVIN_SUBSCRIPTION_AUTH_PROVIDER, []);
			notifications.info(localize('subscriptions.devinConnected', "Devin account connected and saved in this editor. Native Devin chat integration is still in development. Devin CLI remains available separately."));
			return;
		}
		if (provider.id === 'codex') {
			await instantiation.invokeFunction(connectCodexSubscription);
			return;
		}
		const action = await quickInput.pick([
			{ id: 'open', label: localize('subscriptions.openClient', "Open {0}", provider.id === 'claude' ? 'Claude Code' : 'Devin CLI'), detail: localize('subscriptions.openDetail', "Continue in the official client using its saved sign-in.") },
			{ id: 'signIn', label: localize('subscriptions.signIn', "Sign in"), detail: localize('subscriptions.signInDetail', "Open the provider's own account sign-in flow.") },
		], { title: provider.label });
		if (action) { await instantiation.invokeFunction(openSubscriptionClient, provider.id, action.id === 'signIn'); }
	}
}

registerAction2(AgentSubscriptionsAction);
