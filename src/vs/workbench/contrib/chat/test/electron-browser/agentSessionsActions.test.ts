/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { encodeHex, VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor, IDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { EditorType } from '../../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../../platform/accessibility/common/accessibility.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContext, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { AGENTS_EDITOR_SELECTION_LIMIT, INativeHostService, IOpenAgentsWindowOptions } from '../../../../../platform/native/common/native.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { TestExperimentTriggerTelemetryService } from '../../../../../platform/telemetry/test/common/experimentTriggerTestUtils.js';
import { AgentsWindowOpenSource } from '../../../../../platform/window/common/window.js';
import { IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { extUri } from '../../../../../base/common/resources.js';
import { EditorsOrder, IVisibleEditorPane } from '../../../../common/editor.js';
import { DiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { ExplorerItem } from '../../../files/common/explorerModel.js';
import { VIEW_ID } from '../../../files/common/files.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IExtensionService, NullExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IChatWidget, IChatWidgetService } from '../../browser/chat.js';
import { IChatViewTitleActionContext } from '../../common/actions/chatActions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY, ChatConfiguration, OPEN_AGENTS_WINDOW_COMMAND_ID, OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID } from '../../common/constants.js';
import { IChatViewModel } from '../../common/model/chatViewModel.js';
import { OpenAgentsWindowAction, OpenChatSessionInAgentsWindowAction, OpenExplorerRootInAgentsWindowAction, OpenWorkspaceInAgentsContribution, OpenWorkspaceInAgentsWindowAction, OpenWorkspaceInAgentsWindowChatTitleAction, OpenWorkspaceInAgentsWindowTitleBarAction } from '../../electron-browser/agentSessions/agentSessionsActions.js';
import { testIWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';

class TestCommandService extends mock<ICommandService>() {
	readonly calls: { readonly commandId: string; readonly args: readonly unknown[] }[] = [];

	override async executeCommand<T = unknown>(commandId: string, ...args: unknown[]): Promise<T | undefined> {
		this.calls.push({ commandId, args });
		return undefined;
	}
}

suite('Agents window launch enablement', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const actions: Action2[] = [
		new OpenWorkspaceInAgentsWindowAction(),
		new OpenAgentsWindowAction(),
		new OpenChatSessionInAgentsWindowAction(),
		new OpenWorkspaceInAgentsWindowChatTitleAction(),
		new OpenWorkspaceInAgentsWindowTitleBarAction(),
	];
	const explicitTargets: IOpenAgentsWindowOptions[] = [
		{ folderUri: URI.file('/explicit') },
		{ reveal: URI.parse('agent-host-copilot:/session') },
		{ reveal: 'new', draft: { inputText: 'Keep this prompt', attachments: '[]' } },
	];
	const scenarios = [
		...actions.map(action => ({ name: action.desc.id, command: action.desc.id, args: [] })),
		...explicitTargets.map(target => ({ name: `explicit ${Object.keys(target)[0]}`, command: OPEN_AGENTS_WINDOW_COMMAND_ID, args: [target] })),
	];

	function createContribution(sessionCount?: number) {
		const instantiationService = disposables.add(new TestInstantiationService());
		const storageService = disposables.add(new InMemoryStorageService());
		if (sessionCount !== undefined) {
			storageService.store(AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY, sessionCount, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		const contextKeyService = disposables.add(new MockContextKeyService());
		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(IProductService, upcastPartial<IProductService>({}));
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IActionViewItemService, upcastPartial<IActionViewItemService>({ register: () => Disposable.None }));
		disposables.add(instantiationService.createInstance(OpenWorkspaceInAgentsContribution));
		return { storageService, contextKeyService };
	}

	test('restores whether a session has been created in the Agents Window', () => {
		assert.deepStrictEqual([undefined, 0, 1, 2].map(count => {
			const { contextKeyService } = createContribution(count);
			return contextKeyService.getContextKeyValue(ChatContextKeys.hasCreatedSessionInAgentsWindow.key);
		}), [false, false, true, true]);
	});

	test('enables both default keybindings only after the first Agents Window session without gating the command', () => {
		const { storageService, contextKeyService } = createContribution();
		const screenReaderMode = CONTEXT_ACCESSIBILITY_MODE_ENABLED.bindTo(contextKeyService);
		const isSessionsWindow = IsSessionsWindowContext.bindTo(contextKeyService);
		contextKeyService.createKey(`config.${ChatConfiguration.AgentEnabled}`, true);
		const context: IContext = { getValue: key => contextKeyService.getContextKeyValue(key) };
		const action = new OpenAgentsWindowAction();
		const keybindings = action.desc.keybinding;
		assert.ok(Array.isArray(keybindings));
		const matches = () => keybindings.map(keybinding => keybinding.when?.evaluate(context));

		screenReaderMode.set(false);
		const beforeFirstSession = matches();
		const commandAvailableBeforeFirstSession = action.desc.precondition?.evaluate(context);
		screenReaderMode.set(true);
		const screenReaderBeforeFirstSession = matches();

		storageService.store(AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY, 1, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const screenReaderAfterFirstSession = matches();
		screenReaderMode.set(false);
		const afterFirstSession = matches();
		isSessionsWindow.set(true);
		const inAgentsWindow = matches();

		assert.deepStrictEqual({
			beforeFirstSession,
			commandAvailableBeforeFirstSession,
			screenReaderBeforeFirstSession,
			screenReaderAfterFirstSession,
			afterFirstSession,
			inAgentsWindow,
		}, {
			beforeFirstSession: [false, false],
			commandAvailableBeforeFirstSession: true,
			screenReaderBeforeFirstSession: [false, false],
			screenReaderAfterFirstSession: [false, true],
			afterFirstSession: [true, false],
			inAgentsWindow: [false, false],
		});
	});

	for (const scenario of scenarios) {
		test(`direct command respects effective agent enablement: ${scenario.name}`, async () => {
			const instantiationService = disposables.add(new TestInstantiationService());
			const configurationService = new TestConfigurationService({ [ChatConfiguration.AgentEnabled]: false });
			disposables.add(configurationService.onDidChangeConfigurationEmitter);
			instantiationService.stub(IConfigurationService, configurationService);
			instantiationService.stub(IExtensionService, new NullExtensionService());
			instantiationService.stub(ILogService, disposables.add(new NullLogService()));
			instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
				getWorkspace: () => (testIWorkspace({ id: 'empty', folders: [] })),
			}));
			instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({ lastFocusedWidget: undefined }));
			const calls: IOpenAgentsWindowOptions[] = [];
			instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
				openAgentsWindow: async options => { calls.push(options ?? {}); },
			}));
			for (const action of actions) {
				disposables.add(CommandsRegistry.registerCommand(action.desc.id, (accessor, ...args) => action.run(accessor, ...args)));
			}
			const commandService = disposables.add(instantiationService.createInstance(CommandService));
			instantiationService.stub(ICommandService, commandService);
			const execute = () => commandService.executeCommand(scenario.command, ...scenario.args);
			const disabledError = { message: 'The Agents window is unavailable because agent mode is disabled.' };

			await assert.rejects(execute(), disabledError);
			const initiallyDisabledCalls = calls.length;
			await configurationService.setUserConfiguration(ChatConfiguration.AgentEnabled, true);
			await execute();
			const enabledCalls = calls.length;
			await configurationService.setUserConfiguration(ChatConfiguration.AgentEnabled, false);
			await assert.rejects(execute(), disabledError);

			assert.deepStrictEqual({
				initiallyDisabledCalls,
				enabledCalls,
				disabledAgainCalls: calls.length,
			}, { initiallyDisabledCalls: 0, enabledCalls: 1, disabledAgainCalls: 1 });
		});
	}
});

suite('OpenWorkspaceInAgentsWindowAction', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('combines overlapping title-bar and keyboard switches while allowing an explicit new chat', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({ getWorkspace: () => testIWorkspace({ id: 'workspace', folders: [] }) }));
		instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({ lastFocusedWidget: undefined }));
		const firstHandoff = new DeferredPromise<void>();
		const opened: (IOpenAgentsWindowOptions['reveal'])[] = [];
		instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
			openAgentsWindow: options => {
				opened.push(options?.reveal);
				return opened.length === 1 ? firstHandoff.p : Promise.resolve();
			},
		}));
		const action = new OpenWorkspaceInAgentsWindowAction();
		const switchMode = (source?: AgentsWindowOpenSource) => instantiationService.invokeFunction(accessor => action.run(accessor, { source }));
		const first = switchMode(AgentsWindowOpenSource.TitleBar);
		const repeated = switchMode();
		try {
			await instantiationService.invokeFunction(accessor => action.run(accessor, { reveal: 'new' }));
			assert.deepStrictEqual(opened, [undefined, 'new']);
		} finally {
			await firstHandoff.complete();
			await Promise.all([first, repeated]);
		}
		await switchMode();
		assert.deepStrictEqual(opened, [undefined, 'new', undefined]);
	});

	for (const scenario of [
		{ name: 'active editor takes priority', activeFile: '/second/file.ts', recentFiles: ['/first/earlier.ts'], explorerFolder: '/first', explorerVisible: true, expected: '/second' },
		{ name: 'visible Explorer supplies the root with no editor open', explorerFolder: '/second', explorerVisible: true, expected: '/second' },
		{ name: 'hidden Explorer is ignored', explorerFolder: '/second', explorerVisible: false, expected: '/first' },
		{ name: 'first-root fallback without editor or Explorer context', explorerVisible: true, expected: '/first' },
		{ name: 'most recent workspace editor supplies the root for an external active tab', activeFile: '/outside/scratch.txt', recentFiles: ['/elsewhere/note.txt', '/second/recent.ts', '/first/earlier.ts'], explorerVisible: false, expected: '/second' },
		{ name: 'first-root fallback when recent tabs are all external', activeFile: '/outside/scratch.txt', recentFiles: ['/elsewhere/note.txt'], explorerVisible: false, expected: '/first' },
	]) {
		test(`explicit Open in Agents: ${scenario.name}`, async () => {
			const instantiationService = disposables.add(new TestInstantiationService());
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({ lastFocusedWidget: undefined }));
			const folders = ['/first', '/second'].map((path, index) => new WorkspaceFolder({ uri: URI.file(path), name: path, index }));
			const activeFile = scenario.activeFile && URI.file(scenario.activeFile);
			const calls: IOpenAgentsWindowOptions[] = [];
			instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
				getWorkspace: () => (testIWorkspace({ id: 'multi-root', folders })),
				getWorkspaceFolder: uri => folders.find(folder => extUri.isEqualOrParent(uri, folder.uri)) ?? null,
			}));
			instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
				activeEditor: activeFile ? upcastPartial<EditorInput>({ resource: activeFile }) : undefined,
				activeTextEditorControl: activeFile ? upcastPartial<ICodeEditor>({
					getEditorType: () => EditorType.ICodeEditor,
					getModel: () => upcastPartial<ITextModel>({ uri: activeFile }),
					getSelection: () => null,
					saveViewState: () => null,
				}) : undefined,
				getEditors: order => {
					assert.strictEqual(order, EditorsOrder.MOST_RECENTLY_ACTIVE);
					return (scenario.recentFiles ?? []).map(file => ({ groupId: 0, editor: upcastPartial<EditorInput>({ resource: URI.file(file) }) }));
				},
			}));
			instantiationService.stub(IViewsService, upcastPartial<IViewsService>({
				isViewVisible: id => id === VIEW_ID && scenario.explorerVisible,
			}));
			instantiationService.stub(IExplorerService, upcastPartial<IExplorerService>({
				getViewId: () => VIEW_ID,
				getContext: () => scenario.explorerFolder ? [upcastPartial<ExplorerItem>({ resource: URI.file(scenario.explorerFolder) })] : [],
			}));
			instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
				openAgentsWindow: async options => { calls.push(options ?? {}); },
			}));
			await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor));
			assert.deepStrictEqual(calls.map(call => ({ folder: URI.revive(call.folderUri)?.path, isDefault: call.folderUriIsDefault, workspace: call.editorWorkspace })), [{
				folder: scenario.expected, isDefault: true, workspace: {
					folders: folders.map(({ uri, name }) => ({ uri, name })),
					activeFile: activeFile && folders.some(folder => extUri.isEqualOrParent(activeFile, folder.uri)) ? activeFile : undefined,
				},
			}]);
		});
	}

	test('carries the last focused side of a cross-root diff into Agents', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		const folders = ['modified', 'original'].map((name, index) => new WorkspaceFolder({ uri: URI.file(`/${name}`), name, index }));
		instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
			getWorkspace: () => testIWorkspace({ id: 'diff-workspace', folders }),
			getWorkspaceFolder: uri => folders.find(folder => extUri.isEqualOrParent(uri, folder.uri)) ?? null,
		}));
		const createSide = (folder: WorkspaceFolder) => {
			const file = URI.joinPath(folder.uri, 'file.ts');
			const text = `selected ${folder.name}`;
			const model = store.add(createTextModel(`first line\n${text}`, null, undefined, file));
			const input = store.add(new class extends EditorInput {
				readonly typeId = 'test.editorInput';
				readonly resource = file;
			});
			const control = upcastPartial<ICodeEditor>({
				getModel: () => model,
				getSelection: () => new Selection(2, 1, 2, text.length + 1),
			});
			return { folder, file, input, control, model, text };
		};
		const modified = createSide(folders[0]);
		const original = createSide(folders[1]);
		const sideState = {
			cursorState: [],
			viewState: { scrollLeft: 0, firstPosition: { lineNumber: 1, column: 1 }, firstPositionDeltaTop: 0 },
			contributionsState: { privateFixtureState: 'excluded from the handoff' },
		};
		let focusedSide = original;
		const editorService = upcastPartial<IEditorService>({
			get activeEditor(): EditorInput { return activeEditor; },
			activeEditorPane: upcastPartial<IVisibleEditorPane>({
				input: upcastPartial<EditorInput>({}),
				group: upcastPartial<IVisibleEditorPane['group']>({ id: 17, isPinned: () => true, isSticky: () => true }),
			}),
			activeTextEditorControl: upcastPartial<IDiffEditor>({
				getEditorType: () => EditorType.IDiffEditor,
				getModel: () => ({ original: original.model, modified: modified.model }),
				getOriginalEditor: () => original.control,
				getModifiedEditor: () => modified.control,
				getLastFocusedEditor: () => focusedSide.control,
				saveViewState: () => ({ original: sideState, modified: sideState }),
			}),
		});
		const activeEditor = store.add(new DiffEditorInput('Compare files', undefined, original.input, modified.input, undefined, editorService));
		instantiationService.stub(IEditorService, editorService);
		const calls: IOpenAgentsWindowOptions[] = [];
		instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
			openAgentsWindow: async options => { calls.push(options ?? {}); },
		}));

		for (const side of [original, modified]) {
			focusedSide = side;
			await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor));
			const call = calls.at(-1)!;
			assert.strictEqual(call.folderUri, side.folder.uri);
			assert.strictEqual(call.editorWorkspace?.activeFile, side.file);
			assert.strictEqual(call.editorWorkspace?.activeEditorGroupId, 17);
			assert.deepStrictEqual(call.editorWorkspace?.activeEditorTab, { pinned: true, sticky: true });
			assert.deepStrictEqual(call.editorWorkspace?.activeFileSelection, {
				startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: side.text.length + 1,
			});
			assert.deepStrictEqual(call.editorWorkspace?.selection, { text: side.text, startLine: 2, endLine: 2, truncated: false });
			const restoredSide = { ...sideState, contributionsState: {} };
			assert.deepStrictEqual(call.editorWorkspace?.activeDiff, {
				original: original.file,
				modified: modified.file,
				viewState: { original: restoredSide, modified: restoredSide, focusedSide: side.folder.name },
			});
		}
	});

	test('opens the Agents Window with the local folder and Dev Container preference', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({ lastFocusedWidget: undefined }));
		let workspaceFolderUri = URI.file('/workspace');
		const activeFile = URI.joinPath(workspaceFolderUri, 'active.ts');
		const longLine = 'b'.repeat(AGENTS_EDITOR_SELECTION_LIMIT + 2);
		const model = store.add(createTextModel(`before\nselected text\n${longLine}\nafter`, null, undefined, activeFile));
		let selection = new Selection(2, 1, 3, 1);
		const positions = {
			cursorState: [
				{ inSelectionMode: true, selectionStart: { lineNumber: 2, column: 1 }, position: { lineNumber: 3, column: 1 } },
				{ inSelectionMode: false, selectionStart: { lineNumber: 1, column: 4 }, position: { lineNumber: 1, column: 4 } },
			],
			viewState: { scrollLeft: 40, firstPosition: { lineNumber: 2, column: 1 }, firstPositionDeltaTop: 5 },
		};
		const calls: IOpenAgentsWindowOptions[] = [];
		const workspaceFolder = () => new WorkspaceFolder({ uri: workspaceFolderUri, name: 'workspace', index: 0 });
		instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
			getWorkspace: () => (testIWorkspace({
				id: 'workspace',
				folders: [workspaceFolder()],
			})),
			getWorkspaceFolder: uri => extUri.isEqualOrParent(uri, workspaceFolderUri) ? workspaceFolder() : null,
		}));
		instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
			activeEditorPane: upcastPartial<IVisibleEditorPane>({
				input: upcastPartial<EditorInput>({ resource: activeFile }),
				group: upcastPartial<IVisibleEditorPane['group']>({ id: 18, isPinned: () => false, isSticky: () => false }),
			}),
			activeTextEditorControl: upcastPartial<ICodeEditor>({
				getEditorType: () => EditorType.ICodeEditor,
				getModel: () => model,
				getSelection: () => selection,
				saveViewState: () => ({ ...positions, contributionsState: { folding: 'local editor state' } }),
			}),
		}));
		instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
			openAgentsWindow: async options => { calls.push(options ?? {}); },
		}));

		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor, {
			source: AgentsWindowOpenSource.TitleBar,
		}));
		const hostFolderUri = URI.file('/host/workspace');
		workspaceFolderUri = URI.from({
			scheme: Schemas.vscodeRemote,
			authority: `dev-container+${encodeHex(VSBuffer.fromString(hostFolderUri.fsPath))}`,
			path: '/workspaces/project',
		});
		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor, {
			source: AgentsWindowOpenSource.ChatTitleBar,
		}));

		assert.deepStrictEqual(calls.map(call => ({
			folderUri: URI.revive(call.folderUri)?.toString(),
			source: call.source,
		})), [{
			folderUri: URI.file('/workspace').toString(),
			source: AgentsWindowOpenSource.TitleBar,
		}, {
			folderUri: workspaceFolderUri.toString(),
			source: AgentsWindowOpenSource.ChatTitleBar,
		}]);
		assert.strictEqual(calls[0].editorWorkspace?.activeFile, activeFile);
		assert.deepStrictEqual(calls[0].editorWorkspace?.activeFileViewState, { ...positions, contributionsState: {} });
		assert.deepStrictEqual(calls[0].editorWorkspace?.activeEditorTab, { pinned: false, sticky: false });
		assert.deepStrictEqual(calls[0].editorWorkspace?.activeFileSelection, {
			startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1,
		});
		assert.deepStrictEqual(calls[0].editorWorkspace?.selection, {
			text: 'selected text\n', startLine: 2, endLine: 2, truncated: false,
		});
		assert.strictEqual(calls[1].editorWorkspace, undefined);

		workspaceFolderUri = URI.file('/workspace');
		selection = new Selection(3, 1, 3, longLine.length + 1);
		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor));
		assert.deepStrictEqual(calls[2].editorWorkspace?.selection, {
			text: longLine.slice(0, AGENTS_EDITOR_SELECTION_LIMIT), startLine: 3, endLine: 3, truncated: true,
		});
		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor, { reveal: 'new' }));
		assert.strictEqual(calls[3].editorWorkspace, undefined);
		selection = new Selection(4, 2, 4, 2);
		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowAction().run(accessor));
		assert.deepStrictEqual(calls[4].editorWorkspace?.activeFileSelection, {
			startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 2,
		});
		assert.strictEqual(calls[4].editorWorkspace?.selection, undefined);
	});
});

suite('OpenExplorerRootInAgentsWindowAction', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the explicitly clicked workspace root in Agents', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		const local = URI.file('/workspace');
		const remote = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+example', path: '/workspace' });
		const folders = [local, remote].map((uri, index) => new WorkspaceFolder({ uri, name: uri.path, index }));
		instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
			getWorkspaceFolder: uri => folders.find(folder => extUri.isEqualOrParent(uri, folder.uri)) ?? null,
		}));
		const calls: IOpenAgentsWindowOptions[] = [];
		instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
			openAgentsWindow: async options => { calls.push(options ?? {}); },
		}));
		const action = new OpenExplorerRootInAgentsWindowAction();
		for (const resource of [URI.joinPath(local, 'subfolder'), URI.file('/outside'), local, remote]) {
			await instantiationService.invokeFunction(accessor => action.run(accessor, resource));
		}
		assert.deepStrictEqual(calls, [local, remote].map(folderUri => ({
			folderUri,
			reveal: 'new',
			source: AgentsWindowOpenSource.Explorer,
		})));
	});
});

suite('OpenChatSessionInAgentsWindowAction', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('names the remote machine of a remote window\'s own agent host sessions and passes its folder for a fallback', async () => {
		const calls: { folder: string | undefined; reveal: string | undefined; revealRemoteAuthority: string | undefined }[] = [];
		const run = async (remoteAuthority: string | undefined, folders: URI[], session: string) => {
			const instantiationService = disposables.add(new TestInstantiationService());
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({ lastFocusedWidget: undefined }));
			instantiationService.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority }));
			instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
				getWorkspace: () => (testIWorkspace({ id: 'workspace', folders: folders.map((uri, index) => new WorkspaceFolder({ uri, name: uri.path, index })) })),
			}));
			instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
				openAgentsWindow: async options => { calls.push({ folder: URI.revive(options?.folderUri)?.toString(), reveal: options?.reveal === 'new' ? 'new' : URI.revive(options?.reveal)?.toString(), revealRemoteAuthority: options?.revealRemoteAuthority }); },
			}));
			await instantiationService.invokeFunction(accessor => new OpenChatSessionInAgentsWindowAction().run(accessor, URI.parse(session)));
		};
		const remoteFolder = URI.from({ scheme: Schemas.vscodeRemote, authority: 'tunnel+box', path: '/project' });
		await run('tunnel+box', [remoteFolder], 'agent-host-copilotcli:/session');
		await run('tunnel+box', [], 'agent-host-copilotcli:/session');
		await run('tunnel+box', [remoteFolder], 'copilotcli:/session');
		await run(undefined, [URI.file('/project')], 'agent-host-copilotcli:/session');
		assert.deepStrictEqual(calls, [
			{ folder: remoteFolder.toString(), reveal: 'agent-host-copilotcli:/session', revealRemoteAuthority: 'tunnel+box' },
			{ folder: undefined, reveal: 'agent-host-copilotcli:/session', revealRemoteAuthority: 'tunnel+box' },
			{ folder: undefined, reveal: 'copilotcli:/session', revealRemoteAuthority: undefined },
			{ folder: undefined, reveal: 'agent-host-copilotcli:/session', revealRemoteAuthority: undefined },
		]);
	});
});

suite('OpenAgentsWindowAction workspace defaults', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	for (const scenario of [
		{ name: 'single folder', folders: ['/one'], activeFile: undefined, expected: '/one' },
		{ name: 'active file in a multi-root workspace', folders: ['/one', '/two'], activeFile: '/two/file.ts', expected: '/two' },
		{ name: 'no active file in a multi-root workspace', folders: ['/one', '/two'], activeFile: undefined, expected: undefined },
		{ name: 'active file outside the workspace', folders: ['/one', '/two'], activeFile: '/elsewhere/file.ts', expected: undefined },
		{ name: 'empty editor window', folders: [], activeFile: '/elsewhere/file.ts', expected: undefined },
	]) {
		test(`infers ${scenario.name} without turning it into an explicit selection`, async () => {
			const instantiationService = disposables.add(new TestInstantiationService());
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({ lastFocusedWidget: undefined }));
			const folders = scenario.folders.map((path, index) => new WorkspaceFolder({ uri: URI.file(path), name: path, index }));
			const calls: IOpenAgentsWindowOptions[] = [];
			instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
				getWorkspace: () => (testIWorkspace({ id: 'workspace', folders })),
				getWorkspaceFolder: resource => folders.find(folder => extUri.isEqualOrParent(resource, folder.uri)) ?? null,
			}));
			instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
				activeEditor: scenario.activeFile ? upcastPartial<EditorInput>({ resource: URI.file(scenario.activeFile) }) : undefined,
			}));
			instantiationService.stub(IViewsService, upcastPartial<IViewsService>({ isViewVisible: () => false }));
			instantiationService.stub(IExplorerService, upcastPartial<IExplorerService>({ getViewId: () => VIEW_ID }));
			instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({
				openAgentsWindow: async options => { calls.push(options ?? {}); },
			}));

			await instantiationService.invokeFunction(accessor => new OpenAgentsWindowAction().run(accessor, { source: AgentsWindowOpenSource.KeyboardShortcut }));
			assert.deepStrictEqual(calls.map(call => ({
				folder: URI.revive(call.folderUri)?.path,
				isDefault: call.folderUriIsDefault,
				source: call.source,
				preserveEditorHandoff: call.preserveEditorHandoff,
			})), [{ folder: scenario.expected, isDefault: scenario.expected ? true : undefined, source: AgentsWindowOpenSource.KeyboardShortcut, preserveEditorHandoff: true }]);
		});
	}

	test('preserves explicit folder and existing-session arguments without consulting editor context', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		const calls: IOpenAgentsWindowOptions[] = [];
		instantiationService.stub(INativeHostService, upcastPartial<INativeHostService>({ openAgentsWindow: async options => { calls.push(options ?? {}); } }));
		const explicit = { folderUri: URI.file('/explicit') };
		const existing = { reveal: URI.parse('agent-host-copilot:/session') };
		await instantiationService.invokeFunction(accessor => new OpenAgentsWindowAction().run(accessor, explicit));
		await instantiationService.invokeFunction(accessor => new OpenAgentsWindowAction().run(accessor, existing));
		assert.deepStrictEqual(calls, [
			{ ...explicit, source: AgentsWindowOpenSource.CommandPalette, preserveEditorHandoff: true },
			{ ...existing, source: AgentsWindowOpenSource.CommandPalette },
		]);
	});
});

suite('OpenWorkspaceInAgentsWindowTitleBarAction', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function run(sessionResource: URI | undefined) {
		const instantiationService = disposables.add(new TestInstantiationService());
		const commandService = new TestCommandService();
		const telemetryService = new TestExperimentTriggerTelemetryService();
		instantiationService.stub(ICommandService, commandService);
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(ITelemetryService, telemetryService);
		instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({
			lastFocusedWidget: sessionResource ? upcastPartial<IChatWidget>({
				viewModel: upcastPartial<IChatViewModel>({ sessionResource }),
			}) : undefined,
		}));

		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowTitleBarAction().run(accessor));
		return { calls: commandService.calls, triggers: telemetryService.triggers };
	}

	test('opens the workspace regardless of the focused chat session, without logging an experiment trigger', async () => {
		const openWorkspace = {
			calls: [{ commandId: OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID, args: [{ source: AgentsWindowOpenSource.TitleBar }] }],
			triggers: [],
		};

		assert.deepStrictEqual({
			localSession: await run(URI.from({ scheme: 'agent-host-claude', path: '/session' })),
			untitledLocalSession: await run(URI.from({ scheme: 'agent-host-claude', path: '/untitled-session' })),
			remoteSession: await run(URI.from({ scheme: 'remote-host-claude', path: '/session' })),
			regularSession: await run(URI.from({ scheme: 'vscode-chat-session', path: '/session' })),
			noSession: await run(undefined),
		}, {
			localSession: openWorkspace,
			untitledLocalSession: openWorkspace,
			remoteSession: openWorkspace,
			regularSession: openWorkspace,
			noSession: openWorkspace,
		});
	});

	test('opens the workspace for the chat title session without logging an experiment trigger', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const commandService = new TestCommandService();
		const telemetryService = new TestExperimentTriggerTelemetryService();
		const sessionResource = URI.from({ scheme: 'agent-host-claude', path: '/session' });
		const context = upcastPartial<IChatViewTitleActionContext>({ sessionResource });
		instantiationService.stub(ICommandService, commandService);
		instantiationService.stub(ITelemetryService, telemetryService);

		await instantiationService.invokeFunction(accessor => new OpenWorkspaceInAgentsWindowChatTitleAction().run(accessor, context));

		assert.deepStrictEqual({
			triggers: telemetryService.triggers,
			calls: commandService.calls,
		}, {
			triggers: [],
			calls: [{
				commandId: OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID,
				args: [{ source: AgentsWindowOpenSource.ChatTitleBar, sessionResource }],
			}],
		});
	});
});
