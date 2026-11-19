/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { getWindowId } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { ServicesAccessor } from '../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { IAgentHostConnectionsService } from '../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IRemoteAgentHostLocationPreferenceService } from '../../../platform/agentHost/common/remoteAgentHostLocationPreference.js';
import { ISSHRemoteAgentHostService } from '../../../platform/agentHost/common/sshRemoteAgentHost.js';
import { ITunnelAgentHostService } from '../../../platform/agentHost/common/tunnelAgentHost.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IsLinuxContext } from '../../../platform/contextkey/common/contextkeys.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { EditorAreaFocusContext, IsAuxiliaryWindowContext, IsSessionsWindowContext, LayoutModeContext } from '../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../workbench/contrib/sessions/common/contextkeys.js';
import { logSessionsInteraction } from '../../../workbench/contrib/sessions/common/sessionsTelemetry.js';
import { AgentsWindowMenus } from '../../browser/agentsWindowMenus.js';
import { resolveSessionCommandTarget } from '../../../workbench/contrib/sessions/browser/sessionCommandTarget.js';
import { ISessionsProvidersService } from '../../../workbench/contrib/sessions/browser/sessionsProvidersService.js';
import { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { onDidChangeWorkspaceModeSwitch, OPEN_IN_EDITOR_SEARCH_ALIAS, SWITCH_TO_IDE_TITLE, WorkspaceModeSwitch, WorkspaceModeSwitchGuard, WORKSPACE_MODE_SWITCH_SETTING, WORKSPACE_MODE_SWITCH_KEYBINDING } from '../../../workbench/browser/parts/titlebar/workspaceModeSwitch.js';
import { OpenInVSCodeTitleBarWidget } from '../../browser/widget/openInVSCodeWidget.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { getChatSessionToOpenInEditor, getEditorWindowSessionResource, notifyEditorWindowSessionUnsupported, resolveRemoteAuthority, resolveRemoteFolderUri } from '../../../workbench/contrib/sessions/browser/openInVSCodeUtils.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IFolderToOpen, IOpenedMainWindow } from '../../../platform/window/common/window.js';
import { ILabelService, Verbosity } from '../../../platform/label/common/label.js';
import { OPEN_VSCODE_WINDOW_COMMAND_ID, RETURN_TO_VSCODE_EDITOR_COMMAND_ID, SHOULD_SHOW_RETURN_TO_VSCODE_EDITOR_COMMAND_ID } from '../../../workbench/contrib/sessions/common/sessionCommands.js';
import { IChat, ISession } from '../../../workbench/services/sessions/common/session.js';
import { AGENT_HOST_SCHEME } from '../../../platform/agentHost/common/agentHostUri.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';
import { ICustomViewService } from '../../../workbench/contrib/sessions/browser/customView.js';
import { ASSISTANT_CUSTOM_VIEW_ID } from '../../../workbench/contrib/sessions/common/chatConstants.js';
import { assistantWorktreeError, getAssistantEditorFolders, IAssistantAgentChats } from '../../contrib/sessions/browser/assistantAgentChats.js';

interface IOpenSessionInVSCodeContext {
	readonly session: ISession;
	readonly chat: IChat;
}

const switchToEditor = new WorkspaceModeSwitchGuard();

export class OpenSessionInVSCodeAction extends Action2 {
	static readonly ID = 'agents.openSessionInVSCode';

	constructor() {
		super({
			id: OpenSessionInVSCodeAction.ID,
			title: SWITCH_TO_IDE_TITLE,
			searchAlias: OPEN_IN_EDITOR_SEARCH_ALIAS,
			f1: true,
			keybinding: { primary: WORKSPACE_MODE_SWITCH_KEYBINDING, weight: KeybindingWeight.SessionsContrib, when: ContextKeyExpr.and(IsSessionsWindowContext, IsPhoneLayoutContext.negate()) },
			icon: Codicon.vscodeInsiders,
			precondition: ContextKeyExpr.and(ContextKeyExpr.or(IsAuxiliaryWindowContext.toNegated(), LayoutModeContext)!, SessionsWelcomeVisibleContext.toNegated()),
			menu: [{
				id: AgentsWindowMenus.TitleBarLeftLayout,
				group: 'navigation',
				order: -100,
				when: ContextKeyExpr.and(ContextKeyExpr.or(IsAuxiliaryWindowContext.toNegated(), LayoutModeContext)!, SessionsWelcomeVisibleContext.toNegated(), IsPhoneLayoutContext.negate()),
			}]
		});
	}

	override run(accessor: ServicesAccessor, context?: IOpenSessionInVSCodeContext): Promise<void> {
		const openEditor = () => this.openEditor(accessor, context);
		return context?.session ? openEditor() : switchToEditor.run(openEditor);
	}

	private async openEditor(accessor: ServicesAccessor, context?: IOpenSessionInVSCodeContext): Promise<void> {
		const telemetryService = accessor.get(ITelemetryService);
		logSessionsInteraction(telemetryService, 'openInVSCode');

		const instantiationService = accessor.get(IInstantiationService);
		if (!context?.session) {
			const customViews = accessor.get(ICustomViewService);
			if (customViews.activeCustomView.get()?.id === ASSISTANT_CUSTOM_VIEW_ID) {
				const assistant = accessor.get(IAssistantAgentChats);
				const notifications = accessor.get(INotificationService);
				const target = assistant.target;
				if (target?.worktree) {
					const error = assistantWorktreeError(await assistant.getWorktreeStatus(target.worktree));
					if (assistant.target !== target || customViews.activeCustomView.get()?.id !== ASSISTANT_CUSTOM_VIEW_ID) { return; }
					if (error) { notifications.warn(error); return; }
				}
				return instantiationService.invokeFunction(openWorkspaceInVSCode, getAssistantEditorFolders(target), {
					providerId: target?.providerId,
					requireAllFolders: true,
				});
			}
		}

		// The session of the window it is invoked from, such as from the title row of a chat window, else of the focused window.
		const target = context?.session ? context : instantiationService.invokeFunction(accessor => resolveSessionCommandTarget(accessor, []));
		return instantiationService.invokeFunction(openSessionInVSCode, target?.session, target?.chat);
	}
}

export async function openSessionInVSCode(accessor: ServicesAccessor, session: ISession | undefined, chat?: IChat): Promise<void> {
	const folders = (chat ?? session?.mainChat.get())?.workspace.get()?.folders ?? [];
	return openWorkspaceInVSCode(accessor, folders.map(folder => folder.workingDirectory), session && {
		providerId: session.providerId,
		chatSessionToOpen: getChatSessionToOpenInEditor(session, chat),
	});
}

async function openWorkspaceInVSCode(accessor: ServicesAccessor, folders: readonly URI[], context?: {
	readonly providerId?: string;
	readonly chatSessionToOpen?: URI;
	readonly requireAllFolders?: boolean;
}): Promise<void> {
	const nativeHostService = accessor.get(INativeHostService);
	const sessionsProvidersService = accessor.get(ISessionsProvidersService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const agentHostConnectionsService = accessor.get(IAgentHostConnectionsService);
	const tunnelAgentHostService = accessor.get(ITunnelAgentHostService);
	const notificationService = accessor.get(INotificationService);
	const labelService = accessor.get(ILabelService);
	const ambientRemoteAuthority = accessor.get(IWorkbenchEnvironmentService).remoteAuthority;

	if (!context) {
		return nativeHostService.openWindow({ remoteAuthority: ambientRemoteAuthority ?? null, reuseExistingWindow: true });
	}

	const { providerId, chatSessionToOpen, requireAllFolders } = context;
	const notifyUnsupportedWorkspace = () => notificationService.info(localize('openInEditor.unsupportedWorkspaceHosts', "This workspace cannot be opened in one editor window because its folders use unsupported or different remote connections."));
	// Check wrapped ownership before remote resolution can map every root onto the session's host.
	if (new Set(folders.filter(folder => folder.scheme === AGENT_HOST_SCHEME).map(folder => folder.authority)).size > 1) {
		notifyUnsupportedWorkspace();
		return;
	}
	const foldersToOpen: IFolderToOpen[] = [];
	for (const folder of folders) {
		const folderUri = resolveRemoteFolderUri(folder, providerId ?? '', sessionsProvidersService, remoteAgentHostService);
		if (!folderUri || (requireAllFolders && folderUri.scheme !== Schemas.file && folderUri.scheme !== Schemas.vscodeRemote)) {
			if (requireAllFolders || folders.length > 1) { notifyUnsupportedWorkspace(); return; }
			return nativeHostService.openWindow({ remoteAuthority: ambientRemoteAuthority ?? null });
		}
		// Keep the host's path formatter while labeling the same resolved path the editor will open.
		const labelUri = folder.scheme === AGENT_HOST_SCHEME ? folder.with({ path: folderUri.path }) : folder;
		foldersToOpen.push({
			folderUri,
			...(folderUri.scheme === Schemas.vscodeRemote ? { label: labelService.getWorkspaceLabel(labelUri, { verbose: Verbosity.LONG }) } : {}),
		});
	}
	if (new Set(foldersToOpen.map(folder => folder.folderUri.scheme === Schemas.vscodeRemote ? `remote:${folder.folderUri.authority.toLowerCase()}` : 'local')).size > 1) {
		notifyUnsupportedWorkspace();
		return;
	}

	const providerRemoteAuthority = providerId ? resolveRemoteAuthority(providerId, sessionsProvidersService, remoteAgentHostService) : undefined;
	const targetRemoteAuthority = foldersToOpen.length ? foldersToOpen.find(folder => folder.folderUri.scheme === Schemas.vscodeRemote)?.folderUri.authority : providerRemoteAuthority ?? ambientRemoteAuthority;
	const workspaceConnection = { targetRemoteAuthority, sourceRemoteAuthority: providerRemoteAuthority ?? ambientRemoteAuthority };
	const editorChatSession = chatSessionToOpen && providerId
		? getEditorWindowSessionResource(chatSessionToOpen, providerId, sessionsProvidersService, remoteAgentHostService, agentHostConnectionsService, tunnelAgentHostService, accessor.get(ISSHRemoteAgentHostService), accessor.get(IRemoteAgentHostLocationPreferenceService), workspaceConnection)
		: undefined;
	if (typeof editorChatSession === 'string') {
		notifyEditorWindowSessionUnsupported(notificationService, editorChatSession, folders.length > 0);
	}
	if (!foldersToOpen.length) {
		return nativeHostService.openWindow({ remoteAuthority: targetRemoteAuthority ?? null, reuseExistingWindow: true, ...(URI.isUri(editorChatSession) ? { chatSessionToOpen: editorChatSession } : {}) });
	}
	return nativeHostService.openWindow(foldersToOpen, { forceNewWindow: true, reuseWorkspaceContainingFolder: true, chatSessionToOpen: URI.isUri(editorChatSession) ? editorChatSession : undefined });
}

export class OpenVSCodeWindowAction extends Action2 {
	static readonly ID = OPEN_VSCODE_WINDOW_COMMAND_ID;

	constructor() {
		super({
			id: OpenVSCodeWindowAction.ID,
			title: localize2('openVSCodeWindow', 'Open VS Code Window'),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
				// On Linux, Ctrl+Shift+A is Toggle Block Comment, so defer to it in a focused writable editor.
				when: ContextKeyExpr.or(IsLinuxContext.toNegated(), EditorAreaFocusContext.toNegated(), EditorContextKeys.readOnly),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);

		const windows = await nativeHostService.getWindows({ includeAuxiliaryWindows: false });
		const currentWindowId = getWindowId(mainWindow);
		const vscodeWindow = windows.find(w => w.id !== currentWindowId);

		if (vscodeWindow) {
			await nativeHostService.focusWindow({ targetWindowId: vscodeWindow.id });
		} else {
			await nativeHostService.openWindow();
		}
	}
}

export class ReturnToVSCodeEditorAction extends Action2 {

	constructor() {
		super({
			id: RETURN_TO_VSCODE_EDITOR_COMMAND_ID,
			title: localize2('returnToVSCodeEditor', 'Return to VS Code Editor'),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await returnToVSCodeEditor(nativeHostService, getWindowId(mainWindow));
	}
}

export class ShouldShowReturnToVSCodeEditorAction extends Action2 {

	constructor() {
		super({
			id: SHOULD_SHOW_RETURN_TO_VSCODE_EDITOR_COMMAND_ID,
			title: localize2('shouldShowReturnToVSCodeEditor', 'Check Whether to Show Return to VS Code Editor'),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<boolean> {
		const nativeHostService = accessor.get(INativeHostService);
		const windows = await nativeHostService.getWindows({ includeAuxiliaryWindows: false });
		return shouldShowReturnToVSCodeEditor(windows, getWindowId(mainWindow));
	}
}

export function shouldShowReturnToVSCodeEditor(windows: readonly IOpenedMainWindow[], currentWindowId: number): boolean {
	return !windows.some(window => window.id !== currentWindowId);
}

export async function returnToVSCodeEditor(nativeHostService: INativeHostService, currentWindowId: number): Promise<void> {
	await nativeHostService.openWindow();
	await nativeHostService.closeWindow({ targetWindowId: currentWindowId });
}

export class OpenInVSCodeWidgetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openInVSCode.widget';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		this._register(actionViewItemService.register(AgentsWindowMenus.TitleBarLeftLayout, OpenSessionInVSCodeAction.ID, (action, options) => {
			return configurationService.getValue<boolean>(WORKSPACE_MODE_SWITCH_SETTING) === false
				? instantiationService.createInstance(OpenInVSCodeTitleBarWidget, action, options, OpenVSCodeWindowAction.ID)
				: instantiationService.createInstance(WorkspaceModeSwitch, action, options, 'agents', OpenSessionInVSCodeAction.ID).trackHandoff(switchToEditor);
		}, onDidChangeWorkspaceModeSwitch(configurationService)));
	}
}
