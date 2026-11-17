/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IsAuxiliaryWindowContext, IsSessionsWindowContext, LayoutModeContext } from '../../../workbench/common/contextkeys.js';
import { Codicon } from '../../../base/common/codicons.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ServicesAccessor } from '../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { IAgentHostConnectionsService } from '../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IRemoteAgentHostLocationPreferenceService } from '../../../platform/agentHost/common/remoteAgentHostLocationPreference.js';
import { ISSHRemoteAgentHostService } from '../../../platform/agentHost/common/sshRemoteAgentHost.js';
import { ITunnelAgentHostService } from '../../../platform/agentHost/common/tunnelAgentHost.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../workbench/contrib/sessions/common/contextkeys.js';
import { logSessionsInteraction } from '../../../workbench/contrib/sessions/common/sessionsTelemetry.js';
import { AgentsWindowMenus } from '../agentsWindowMenus.js';
import { resolveSessionCommandTarget } from '../../../workbench/contrib/sessions/browser/sessionCommandTarget.js';
import { ISessionsProvidersService } from '../../../workbench/contrib/sessions/browser/sessionsProvidersService.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { getChatSessionToOpenInEditor, getEditorWindowSessionResource, notifyEditorWindowSessionUnsupported, resolveRemoteAuthority, resolveRemoteFolderUri } from '../../../workbench/contrib/sessions/browser/openInVSCodeUtils.js';
import { WorkspaceModeSwitch, WORKSPACE_MODE_SWITCH_SETTING, WORKSPACE_MODE_SWITCH_KEYBINDING } from '../../../workbench/browser/parts/titlebar/workspaceModeSwitch.js';
import { OpenInVSCodeTitleBarWidget } from '../widget/openInVSCodeWidget.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IChat, ISession } from '../../../workbench/services/sessions/common/session.js';
import { createExternalEditorWindowLinkUri, parseExternalEditorWindowLinkUri } from '../../../platform/window/common/window.js';

export class OpenInVSCodeAction extends Action2 {
	static readonly ID = 'sessions.openInVSCode';

	constructor() {
		super({
			id: OpenInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in Editor'),
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

	override async run(accessor: ServicesAccessor, context?: { readonly session: ISession; readonly chat: IChat }): Promise<void> {
		const telemetryService = accessor.get(ITelemetryService);
		logSessionsInteraction(telemetryService, 'openInVSCode');

		const openerService = accessor.get(IOpenerService);
		const productService = accessor.get(IProductService);
		const sessionsProvidersService = accessor.get(ISessionsProvidersService);
		const remoteAgentHostService = accessor.get(IRemoteAgentHostService);

		const scheme = productService.urlProtocol;

		const params = new URLSearchParams();
		params.set('windowId', '_blank');

		const target = context?.session ? context : resolveSessionCommandTarget(accessor, []);
		const activeSession = target?.session;
		if (!activeSession) {
			await openerService.open(createExternalEditorWindowLinkUri(scheme), { openExternal: true });
			return;
		}

		const chat = target?.chat ?? activeSession.mainChat.get();
		const workspace = chat?.workspace.get();
		const rawFolderUris = workspace?.isVirtualWorkspace ? [] : workspace?.folders.map(folder => folder.workingDirectory) ?? [];
		const rawFolderUri = rawFolderUris[0];
		const notifyUnsupportedWorkspace = () => accessor.get(INotificationService).info(localize('openInEditor.unsupportedWorkspaceRoots', "This workspace cannot be opened in the editor because its folder paths are unsupported or its link is too large."));

		const resolvedFolderUris = rawFolderUris.map(folder => resolveRemoteFolderUri(folder, activeSession.providerId, sessionsProvidersService, remoteAgentHostService));
		if (!resolvedFolderUris.every((folder): folder is URI => !!folder)) {
			if (rawFolderUris.length > 1) { notifyUnsupportedWorkspace(); return; }
			await openerService.open(URI.from({ scheme, query: params.toString() }), { openExternal: true });
			return;
		}

		const remoteAuthority = resolveRemoteAuthority(
			activeSession.providerId, sessionsProvidersService, remoteAgentHostService);

		const chatSessionToOpen = getChatSessionToOpenInEditor(activeSession, chat);
		const chatSession = chatSessionToOpen && getEditorWindowSessionResource(chatSessionToOpen, activeSession.providerId, sessionsProvidersService, remoteAgentHostService, accessor.get(IAgentHostConnectionsService), accessor.get(ITunnelAgentHostService), accessor.get(ISSHRemoteAgentHostService), accessor.get(IRemoteAgentHostLocationPreferenceService));
		if (URI.isUri(chatSession)) {
			params.set('session', chatSession.toString());
		}
		const notifyUnsupportedChat = () => {
			if (chatSession && !URI.isUri(chatSession)) { notifyEditorWindowSessionUnsupported(accessor.get(INotificationService), chatSession, !!rawFolderUri); }
		};

		if (!rawFolderUri) {
			notifyUnsupportedChat();
			await openerService.open(createExternalEditorWindowLinkUri(scheme, { remoteAuthority, chatSessionToOpen: URI.isUri(chatSession) ? chatSession : undefined }), { openExternal: true });
			return;
		}
		if (rawFolderUris.length > 1) {
			if (new Set(rawFolderUris.filter(folder => folder.scheme === AGENT_HOST_SCHEME).map(folder => folder.authority)).size > 1) { notifyUnsupportedWorkspace(); return; }
			const folders = resolvedFolderUris.map(resolved => {
				// eslint-disable-next-line local/code-agent-host-uri-mapping -- opens every wrapped root through the target editor's remote authority
				const folder = resolved.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(resolved) : resolved;
				return remoteAuthority && folder.scheme === Schemas.file ? folder.with({ scheme: Schemas.vscodeRemote, authority: remoteAuthority }) : folder;
			});
			const link = createExternalEditorWindowLinkUri(scheme, { remoteAuthority, folders, chatSessionToOpen: URI.isUri(chatSession) ? chatSession : undefined });
			if (!parseExternalEditorWindowLinkUri(link, scheme)) {
				notifyUnsupportedWorkspace();
				return;
			}
			notifyUnsupportedChat();
			await openerService.open(link, { openExternal: true });
			return;
		}
		// eslint-disable-next-line local/code-agent-host-uri-mapping -- opens the remote folder in a new window from its wrapped host URI
		const folderUri = rawFolderUri.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(rawFolderUri) : rawFolderUri;
		notifyUnsupportedChat();

		if (remoteAuthority) {
			await openerService.open(URI.from({
				scheme,
				authority: Schemas.vscodeRemote,
				path: `/${remoteAuthority}${folderUri.path}`,
				query: params.toString(),
			}), { openExternal: true });
		} else {
			await openerService.open(URI.from({
				scheme,
				authority: Schemas.file,
				// The editor reconstructs a file URI from this path, including its UNC server.
				path: folderUri.scheme === Schemas.file && folderUri.authority ? `//${folderUri.authority}${folderUri.path}` : folderUri.path,
				query: params.toString(),
			}), { openExternal: true });
		}
	}
}


export class OpenInVSCodeWidgetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openInVSCode.widget';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		this._register(actionViewItemService.register(AgentsWindowMenus.TitleBarLeftLayout, OpenInVSCodeAction.ID, (action, options) => {
			return configurationService.getValue<boolean>(WORKSPACE_MODE_SWITCH_SETTING) === false
				? instantiationService.createInstance(OpenInVSCodeTitleBarWidget, action, options, OpenInVSCodeAction.ID)
				: instantiationService.createInstance(WorkspaceModeSwitch, action, options, 'agents', OpenInVSCodeAction.ID);
		}, undefined));
	}
}
