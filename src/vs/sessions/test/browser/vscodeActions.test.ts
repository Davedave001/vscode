/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../base/common/platform.js';
import { constObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { agentHostAuthority, toAgentHostUri } from '../../../platform/agentHost/common/agentHostUri.js';
import { getEntryAddress, IRemoteAgentHostEntry, IRemoteAgentHostService, RemoteAgentHostEntryType } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { remoteAgentHostSessionTypeId } from '../../../platform/agentHost/common/agentHostSessionType.js';
import { IAgentHostConnectionsService } from '../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IRemoteAgentHostLocationPreferenceService, RemoteAgentHostLocationPreference } from '../../../platform/agentHost/common/remoteAgentHostLocationPreference.js';
import { ISSHAgentHostConnection, ISSHRemoteAgentHostService } from '../../../platform/agentHost/common/sshRemoteAgentHost.js';
import { ITunnelAgentHostService } from '../../../platform/agentHost/common/tunnelAgentHost.js';
import { TestInstantiationService } from '../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { NullTelemetryService } from '../../../platform/telemetry/common/telemetryUtils.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { TestConfigurationService } from '../../../platform/configuration/test/common/testConfigurationService.js';
import { Context, ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext, LayoutModeContext } from '../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../workbench/contrib/sessions/common/contextkeys.js';
import { registerAction2 } from '../../../platform/actions/common/actions.js';
import { KeybindingsRegistry } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResultKind } from '../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { OpenInVSCodeAction } from '../../browser/actions/vscodeActions.js';
import { AgentsWindowMenus } from '../../browser/agentsWindowMenus.js';
import { IAgentHostSessionsProvider } from '../../../workbench/contrib/sessions/common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../workbench/contrib/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../workbench/contrib/sessions/browser/sessionsService.js';
import { ISessionsProvider } from '../../../workbench/contrib/sessions/common/sessionsProvider.js';
import { IChat, ISession, ISessionWorkspace, SessionStatus } from '../../../workbench/services/sessions/common/session.js';
import { parseExternalEditorWindowLinkUri } from '../../../platform/window/common/window.js';
import { IFocusedSessionHostService, ISessionHost, ISessionHostService } from '../../../workbench/services/sessions/browser/sessionHost.js';
import { ITestSessionsService, ITestSessionWithChat, stubSessionHostsFromSessionsService } from '../../../workbench/contrib/sessions/test/browser/sessionHostTestUtils.js';

suite('Web Open in Editor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const [status, parentStatus] of [[SessionStatus.Completed, SessionStatus.Completed], [SessionStatus.Untitled, SessionStatus.Untitled], [SessionStatus.Untitled, SessionStatus.Completed]]) {
		for (const { explicit, network, folderless } of [{ explicit: false, network: false, folderless: false }, { explicit: true, network: false, folderless: false }, { explicit: false, network: true, folderless: false }, { explicit: true, network: true, folderless: false }, { explicit: false, network: false, folderless: true }, { explicit: true, network: false, folderless: true }]) {
			test(`opens the ${explicit ? 'clicked' : 'focused'} chat ${folderless ? 'folderless' : network ? 'network' : 'local'} workspace and ${status === SessionStatus.Untitled ? 'keeps the draft in Agents' : 'hands off that chat'} (parent status: ${parentStatus})`, async () => {
				const instantiation = store.add(new TestInstantiationService());
				const mainFolder = URI.file('/main project');
				const folder = network
					? URI.from({ scheme: 'file', authority: 'fileserver', path: explicit ? '/shared projects/clicked # & 100%/项目' : '/shared projects/nested # & 100%/项目' })
					: URI.file(explicit ? '/clicked project' : '/nested project');
				const mainChat = upcastPartial<IChat>({ resource: URI.parse('test:/main-chat'), workspace: constObservable(upcastPartial<ISessionWorkspace>({ folders: [{ root: mainFolder, workingDirectory: mainFolder, name: 'main', description: undefined }] })) });
				const chat = upcastPartial<IChat>({ resource: URI.from({ scheme: 'test', path: explicit ? '/clicked chat' : '/nested chat', fragment: 'chat&part=2' }), status: constObservable(status), workspace: constObservable(upcastPartial<ISessionWorkspace>({ folders: folderless ? [] : [{ root: folder, workingDirectory: folder, name: 'nested', description: undefined }] })) });
				const session = upcastPartial<ISession>({ resource: URI.parse('test:/parent'), providerId: 'test', status: constObservable(parentStatus), mainChat: constObservable(mainChat) });
				const focused = upcastPartial<ISessionHost>({ session: constObservable(session), chat: constObservable(explicit ? mainChat : chat) });
				const opened: { scheme: string; authority: string; path: string; folder: string | undefined; session: string | null }[] = [];
				instantiation.stub(ISessionHostService, upcastPartial<ISessionHostService>({}));
				instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => focused }));
				instantiation.stub(ISessionsProvidersService, upcastPartial<ISessionsProvidersService>({ getProvider: () => undefined }));
				instantiation.stub(IRemoteAgentHostService, upcastPartial<IRemoteAgentHostService>({ getEntryByAddress: () => undefined }));
				instantiation.stub(IAgentHostConnectionsService, upcastPartial<IAgentHostConnectionsService>({ resolveSessionResourceIdentity: () => undefined }));
				instantiation.stub(IRemoteAgentHostLocationPreferenceService, upcastPartial<IRemoteAgentHostLocationPreferenceService>({ getPreference: () => undefined }));
				instantiation.stub(ISSHRemoteAgentHostService, upcastPartial<ISSHRemoteAgentHostService>({ connections: [] }));
				instantiation.stub(ITunnelAgentHostService, upcastPartial<ITunnelAgentHostService>({ getSelectedServerType: () => undefined }));
				instantiation.stub(ITelemetryService, NullTelemetryService);
				instantiation.stub(IOpenerService, upcastPartial<IOpenerService>({ open: async resource => {
					const uri = URI.parse(resource.toString());
					// The native protocol handler reconstructs the file URI from the link's fsPath.
					opened.push({ scheme: uri.scheme, authority: uri.authority, path: uri.path, folder: uri.authority === 'file' ? URI.file(uri.fsPath).toString() : undefined, session: new URLSearchParams(uri.query).get('session') });
					return true;
				} }));
				for (const quality of [undefined, 'stable', 'insider', 'exploration'] as const) {
					instantiation.stub(IProductService, upcastPartial<IProductService>({ quality, urlProtocol: 'signal-c' }));
					await instantiation.invokeFunction(accessor => new OpenInVSCodeAction().run(accessor, explicit ? { session, chat } : undefined));
				}
				assert.deepStrictEqual(opened, Array.from({ length: 4 }, () => ({ scheme: 'signal-c', authority: folderless ? 'editor-window' : 'file', path: folderless ? '/open' : network ? `//fileserver${folder.path}` : folder.path, folder: folderless ? undefined : folder.toString(), session: status === SessionStatus.Untitled ? null : chat.resource.toString() })));
			});
		}
	}

	for (const [connection, expected] of [
		[
			{ type: RemoteAgentHostEntryType.CloudSandbox, address: 'cloudsandbox:environment', environmentId: 'environment' },
			{ authority: '', path: '', query: 'windowId=_blank' },
		],
		[
			{ type: RemoteAgentHostEntryType.SSH, address: 'ssh:host', hostName: 'host' },
			{ authority: 'vscode-remote', path: '/ssh-remote+host/c:/Users/test/project', query: 'windowId=_blank&session=test%3A%2Fsession' },
		],
	] satisfies [IRemoteAgentHostEntry['connection'], { authority: string; path: string; query: string }][]) {
		test(`routes ${connection.type} without opening remote paths locally`, async () => {
			const instantiationService = store.add(new TestInstantiationService());
			const calls: { authority: string; path: string; query: string; openExternal: boolean | undefined }[] = [];
			const folder = toAgentHostUri(URI.from({ scheme: 'file', path: '/c:/Users/test/project' }), agentHostAuthority(connection.address));
			const workspace = upcastPartial<ISessionWorkspace>({ folders: [{ workingDirectory: folder, root: folder, name: 'project', description: undefined }] });
			const session = upcastPartial<ITestSessionWithChat>({
				resource: URI.from({ scheme: 'test', path: '/session' }),
				providerId: 'test',
				status: constObservable(SessionStatus.Completed),
				activeChat: constObservable(upcastPartial<IChat>({ status: constObservable(SessionStatus.Completed), workspace: constObservable(workspace) })),
			});
			const provider: ISessionsProvider = upcastPartial<IAgentHostSessionsProvider>({ id: 'agenthost-test', remoteAddress: connection.address });
			instantiationService.stub(ISessionsService, upcastPartial<ITestSessionsService>({ activeSession: constObservable(session) }));
			stubSessionHostsFromSessionsService(instantiationService);
			instantiationService.stub(ISessionsProvidersService, upcastPartial<ISessionsProvidersService>({
				getProvider: <T extends ISessionsProvider>() => provider as T,
			}));
			instantiationService.stub(IRemoteAgentHostService, upcastPartial<IRemoteAgentHostService>({
				getEntryByAddress: () => ({ name: 'Remote host', connection }),
			}));
			instantiationService.stub(IAgentHostConnectionsService, upcastPartial<IAgentHostConnectionsService>({ resolveSessionResourceIdentity: () => undefined }));
			instantiationService.stub(IRemoteAgentHostLocationPreferenceService, upcastPartial<IRemoteAgentHostLocationPreferenceService>({ getPreference: () => undefined }));
			instantiationService.stub(ISSHRemoteAgentHostService, upcastPartial<ISSHRemoteAgentHostService>({ connections: [] }));
			instantiationService.stub(ITunnelAgentHostService, upcastPartial<ITunnelAgentHostService>({ getSelectedServerType: () => undefined }));
			instantiationService.stub(ITelemetryService, NullTelemetryService);
			instantiationService.stub(IProductService, upcastPartial<IProductService>({ urlProtocol: 'vscode-test' }));
			instantiationService.stub(IOpenerService, new class extends mock<IOpenerService>() {
				override async open(resource: URI | string, options?: { openExternal?: boolean }): Promise<boolean> {
					const uri = typeof resource === 'string' ? URI.parse(resource) : resource;
					calls.push({ authority: uri.authority, path: uri.path, query: uri.query, openExternal: options?.openExternal });
					return true;
				}
			}());

			await instantiationService.invokeFunction(accessor => new OpenInVSCodeAction().run(accessor));

			assert.deepStrictEqual(calls, [{ ...expected, openExternal: true }]);

			calls.length = 0;
			const clickedChat = upcastPartial<IChat>({
				resource: URI.parse('test:/nested-chat'),
				status: constObservable(SessionStatus.Completed),
				workspace: constObservable(workspace),
			});
			await instantiationService.invokeFunction(accessor => new OpenInVSCodeAction().run(accessor, { session, chat: clickedChat }));

			assert.deepStrictEqual(calls, [{
				...expected,
				query: connection.type === RemoteAgentHostEntryType.SSH ? 'windowId=_blank&session=test%3A%2Fnested-chat' : expected.query,
				openExternal: true,
			}]);
		});
	}

	for (const [connection, serverType, preference] of [
		[{ type: RemoteAgentHostEntryType.SSH, address: 'ssh:host', hostName: 'host', sshConfigHost: 'host' }, 'standalone', undefined],
		[{ type: RemoteAgentHostEntryType.SSH, address: 'ssh:host', hostName: 'host', sshConfigHost: 'host' }, 'editor', undefined],
		[{ type: RemoteAgentHostEntryType.SSH, address: 'ssh:host', hostName: 'host', sshConfigHost: 'host' }, 'editor', 'editor'],
		[{ type: RemoteAgentHostEntryType.SSH, address: 'ssh:host', hostName: 'host', sshConfigHost: 'host' }, 'editor', 'dedicated'],
		[{ type: RemoteAgentHostEntryType.WSL, address: 'wsl:Ubuntu', distro: 'Ubuntu' }, undefined, undefined],
		[{ type: RemoteAgentHostEntryType.DevContainer, address: 'devcontainer:host', hostPath: '/source/project' }, undefined, undefined],
	] satisfies [IRemoteAgentHostEntry['connection'], ISSHAgentHostConnection['serverType'], RemoteAgentHostLocationPreference | undefined][]) {
		test(`hands off ${connection.type} sessions when the editor follows the selected host (${serverType ?? 'standalone'}, ${preference ?? 'no preference'})`, async () => {
			const instantiationService = store.add(new TestInstantiationService());
			const entry = { name: 'Remote host', connection };
			const address = getEntryAddress(entry);
			const authority = agentHostAuthority(address);
			const folder = toAgentHostUri(URI.file('/project'), authority);
			const resource = URI.from({ scheme: remoteAgentHostSessionTypeId(authority, 'copilotcli'), path: '/session', fragment: 'chat' });
			const chat = upcastPartial<IChat>({
				resource,
				status: constObservable(SessionStatus.Completed),
				workspace: constObservable(upcastPartial<ISessionWorkspace>({ folders: [{ workingDirectory: folder, root: folder, name: 'project', description: undefined }] })),
			});
			const session = upcastPartial<ITestSessionWithChat>({ resource, providerId: 'test', status: constObservable(SessionStatus.Completed), activeChat: constObservable(chat) });
			const provider: ISessionsProvider = upcastPartial<IAgentHostSessionsProvider>({ id: 'agenthost-test', remoteAddress: address });
			const sessions: (string | null)[] = [];
			const links: URI[] = [];
			const notifications: string[] = [];
			instantiationService.stub(ISessionsProvidersService, upcastPartial<ISessionsProvidersService>({ getProvider: <T extends ISessionsProvider>() => provider as T }));
			instantiationService.stub(IRemoteAgentHostService, upcastPartial<IRemoteAgentHostService>({ getEntryByAddress: () => entry }));
			instantiationService.stub(IAgentHostConnectionsService, upcastPartial<IAgentHostConnectionsService>({
				resolveSessionResourceIdentity: () => ({ connectionAuthority: authority, backendSession: URI.parse('copilotcli:/session') }),
			}));
			instantiationService.stub(IRemoteAgentHostLocationPreferenceService, upcastPartial<IRemoteAgentHostLocationPreferenceService>({ getPreference: key => key === address ? preference : undefined }));
			instantiationService.stub(ISSHRemoteAgentHostService, upcastPartial<ISSHRemoteAgentHostService>({
				connections: [upcastPartial<ISSHAgentHostConnection>({ localAddress: address, serverType })],
			}));
			instantiationService.stub(ITunnelAgentHostService, upcastPartial<ITunnelAgentHostService>({ getSelectedServerType: () => undefined }));
			instantiationService.stub(INotificationService, upcastPartial<INotificationService>({ info: message => { notifications.push(String(message)); } }));
			instantiationService.stub(ITelemetryService, NullTelemetryService);
			instantiationService.stub(IProductService, upcastPartial<IProductService>({ urlProtocol: 'vscode-test' }));
			instantiationService.stub(IOpenerService, upcastPartial<IOpenerService>({
				open: async resource => {
					const link = typeof resource === 'string' ? URI.parse(resource) : resource;
					links.push(link);
					sessions.push(new URLSearchParams(link.query).get('session'));
					return true;
				},
			}));

			await instantiationService.invokeFunction(accessor => new OpenInVSCodeAction().run(accessor, { session, chat }));

			const sharesAgentHost = serverType !== 'editor' || preference === 'editor';
			assert.deepStrictEqual({ sessions, notifications }, {
				sessions: [sharesAgentHost ? 'agent-host-copilotcli:/session#chat' : null],
				notifications: !sharesAgentHost ? ['The session\'s folder was opened in a new editor window, but the session can\'t be opened there. This window is connected to a different agent host on the remote machine than the one its editor windows use.'] : [],
			});
			sessions.length = 0; notifications.length = 0; links.length = 0;
			await instantiationService.invokeFunction(accessor => new OpenInVSCodeAction().run(accessor, { session, chat: { ...chat, workspace: constObservable(undefined) } }));
			const parsed = parseExternalEditorWindowLinkUri(links[0], 'vscode-test');
			assert.ok(parsed);
			assert.strictEqual(parsed.remoteAuthority, connection.type === RemoteAgentHostEntryType.SSH ? 'ssh-remote+host' : connection.type === RemoteAgentHostEntryType.WSL ? 'wsl+Ubuntu' : 'dev-container+2f736f757263652f70726f6a656374');
			assert.deepStrictEqual({ sessions, notifications }, {
				sessions: [sharesAgentHost ? 'agent-host-copilotcli:/session#chat' : null],
				notifications: sharesAgentHost ? [] : ['This chat can\'t be opened in the editor because it uses a different agent host on the remote machine.'],
			});
		});
	}
});

suite('Open in Editor in Agents windows', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	for (const os of [OperatingSystem.Windows, OperatingSystem.Macintosh, OperatingSystem.Linux]) {
		test(`resolves the workspace mode chord only in a ready desktop Agents window (${os})`, () => {
			store.add(registerAction2(OpenInVSCodeAction));
			const rules = KeybindingsRegistry.getDefaultKeybindingsForOS(os).filter(rule => rule.command === OpenInVSCodeAction.ID);
			const resolver = new KeybindingResolver(rules.map(rule => new ResolvedKeybindingItem(
				rule.keybinding ? USLayoutResolvedKeybinding.resolveKeybinding(rule.keybinding, os)[0] : undefined, rule.command, rule.commandArgs, rule.when ?? undefined, true, null, false,
			)), [], () => { });
			const context = new Context(0, null);
			context.setValue(IsSessionsWindowContext.key, true);
			const first = os === OperatingSystem.Macintosh ? 'meta+K' : 'ctrl+K';
			const second = os === OperatingSystem.Macintosh ? 'shift+meta+A' : 'ctrl+shift+A';
			assert.strictEqual(resolver.resolve(context, [], first).kind, ResultKind.MoreChordsNeeded);
			assert.deepStrictEqual(resolver.resolve(context, [first], second), {
				kind: ResultKind.KbFound, commandId: OpenInVSCodeAction.ID, commandArgs: undefined, isBubble: false,
			});
			for (const key of [IsPhoneLayoutContext.key, SessionsWelcomeVisibleContext.key, IsAuxiliaryWindowContext.key]) {
				context.setValue(key, true);
				assert.strictEqual(resolver.resolve(context, [], first).kind, ResultKind.NoMatchingKb);
				context.setValue(key, false);
			}
			context.setValue(IsSessionsWindowContext.key, false);
			assert.strictEqual(resolver.resolve(context, [], first).kind, ResultKind.NoMatchingKb);
		});
	}

	test('shows in the main window and in chat windows, as the main window always showed it, and not in editor windows', () => {
		const menus = new OpenInVSCodeAction().desc.menu;
		const when = (Array.isArray(menus) ? menus : [menus]).find(menu => menu?.id === AgentsWindowMenus.TitleBarLeftLayout)?.when;
		const contextKeyService = store.add(new ContextKeyService(new TestConfigurationService()));
		const shows = (auxiliary: boolean, layoutMode: string | undefined) => {
			const scoped = store.add(contextKeyService.createScoped(document.createElement('div')));
			IsAuxiliaryWindowContext.bindTo(scoped).set(auxiliary);
			LayoutModeContext.bindTo(scoped).set(layoutMode);
			return scoped.contextMatchesRules(when);
		};

		assert.deepStrictEqual({ main: shows(false, undefined), chatWindow: shows(true, 'sideBySide'), editorWindow: shows(true, undefined) }, { main: true, chatWindow: true, editorWindow: false });
	});
});
