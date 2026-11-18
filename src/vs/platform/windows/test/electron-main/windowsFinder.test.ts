/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { join } from '../../../../base/common/path.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI, UriDto } from '../../../../base/common/uri.js';
import { ICommandAction } from '../../../action/common/action.js';
import { NativeParsedArgs } from '../../../environment/common/argv.js';
import { INativeWindowConfiguration } from '../../../window/common/window.js';
import { ICodeWindow, ILoadEvent, IWindowState } from '../../../window/electron-main/window.js';
import { findWindowForEmptyHandoff, findWindowOnFile, findWindowOnRequestedPath, findWindowOnWorkspaceFolders, workspaceMatchesFolders } from '../../electron-main/windowsFinder.js';
import { toWorkspaceFolders } from '../../../workspaces/common/workspaces.js';
import { IWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FocusMode, IApplicationBadge } from '../../../native/common/native.js';

suite('WindowsFinder', () => {

	const fixturesFolder = FileAccess.asFileUri('vs/platform/windows/test/electron-main/fixtures').fsPath;

	const testWorkspace: IWorkspaceIdentifier = {
		id: Date.now().toString(),
		configPath: URI.file(join(fixturesFolder, 'workspaces.json'))
	};

	const testWorkspaceFolders = toWorkspaceFolders([{ path: join(fixturesFolder, 'vscode_workspace_1_folder') }, { path: join(fixturesFolder, 'vscode_workspace_2_folder') }], testWorkspace.configPath, extUriBiasedIgnorePathCase);
	const localWorkspaceResolver = async (workspace: IWorkspaceIdentifier) => { return workspace === testWorkspace ? { id: testWorkspace.id, configPath: workspace.configPath, folders: testWorkspaceFolders } : undefined; };

	function createTestCodeWindow(options: { lastFocusTime: number; openedFolderUri?: URI; openedWorkspace?: IWorkspaceIdentifier; remoteAuthority?: string; isExtensionDevelopmentHost?: boolean; isSessionsWindow?: boolean }): ICodeWindow {
		return new class implements ICodeWindow {
			readonly onWillLoad: Event<ILoadEvent> = Event.None;
			onDidMaximize = Event.None;
			onDidUnmaximize = Event.None;
			readonly onDidTriggerSystemContextMenu: Event<{ x: number; y: number }> = Event.None;
			readonly onDidSignalReady: Event<void> = Event.None;
			readonly onDidClose: Event<void> = Event.None;
			readonly onDidDestroy: Event<void> = Event.None;
			readonly onDidEnterFullScreen: Event<void> = Event.None;
			readonly onDidLeaveFullScreen: Event<void> = Event.None;
			whenClosedOrLoaded: Promise<void> = Promise.resolve();
			id: number = -1;
			win: Electron.BrowserWindow = null!;
			config = options.isSessionsWindow === undefined ? undefined : upcastPartial<INativeWindowConfiguration>({ isSessionsWindow: options.isSessionsWindow });
			openedWorkspace = options.openedFolderUri ? { id: '', uri: options.openedFolderUri } : options.openedWorkspace;
			backupPath?: string | undefined;
			remoteAuthority = options.remoteAuthority;
			iconPath?: URI | undefined;
			isExtensionDevelopmentHost = options.isExtensionDevelopmentHost ?? false;
			isExtensionTestHost = false;
			lastFocusTime = options.lastFocusTime;
			isFullScreen = false;
			isReady = true;

			ready(): Promise<ICodeWindow> { throw new Error('Method not implemented.'); }
			setReady(): void { throw new Error('Method not implemented.'); }
			addTabbedWindow(window: ICodeWindow): void { throw new Error('Method not implemented.'); }
			load(config: INativeWindowConfiguration, options: { isReload?: boolean }): void { throw new Error('Method not implemented.'); }
			reload(cli?: NativeParsedArgs): void { throw new Error('Method not implemented.'); }
			focus(options?: { mode: FocusMode }): void { throw new Error('Method not implemented.'); }
			close(): void { throw new Error('Method not implemented.'); }
			getBounds(): Electron.Rectangle { throw new Error('Method not implemented.'); }
			send(channel: string, ...args: unknown[]): void { throw new Error('Method not implemented.'); }
			sendWhenReady(channel: string, token: CancellationToken, ...args: unknown[]): void { throw new Error('Method not implemented.'); }
			toggleFullScreen(): void { throw new Error('Method not implemented.'); }
			handleTitleDoubleClick(): void { throw new Error('Method not implemented.'); }
			setRepresentedFilename(name: string): void { throw new Error('Method not implemented.'); }
			getRepresentedFilename(): string | undefined { throw new Error('Method not implemented.'); }
			setDocumentEdited(edited: boolean): void { throw new Error('Method not implemented.'); }
			isDocumentEdited(): boolean { throw new Error('Method not implemented.'); }
			setApplicationBadge(badge: IApplicationBadge | undefined): void { throw new Error('Method not implemented.'); }
			updateTouchBar(items: UriDto<ICommandAction>[][]): void { throw new Error('Method not implemented.'); }
			serializeWindowState(): IWindowState { throw new Error('Method not implemented'); }
			updateWindowControls(options: { height?: number | undefined; backgroundColor?: string | undefined; foregroundColor?: string | undefined; dimmed?: boolean | undefined }): void { throw new Error('Method not implemented.'); }
			notifyZoomLevel(level: number): void { throw new Error('Method not implemented.'); }
			matches(webContents: Electron.WebContents): boolean { throw new Error('Method not implemented.'); }
			dispose(): void { }
		};
	}

	test('Empty handoff selects the latest ordinary editor on the exact host', () => {
		const older = createTestCodeWindow({ lastFocusTime: 1, isSessionsWindow: false });
		const latest = createTestCodeWindow({ lastFocusTime: 2, isSessionsWindow: false, openedWorkspace: testWorkspace });
		const remote = createTestCodeWindow({ lastFocusTime: 3, isSessionsWindow: false, remoteAuthority: 'ssh-remote+host' });
		const excluded = [
			createTestCodeWindow({ lastFocusTime: 4, isSessionsWindow: true }),
			createTestCodeWindow({ lastFocusTime: 5, isSessionsWindow: false, isExtensionDevelopmentHost: true }),
			createTestCodeWindow({ lastFocusTime: 6 }),
		];
		const windows = [older, latest, remote, ...excluded];
		assert.strictEqual(findWindowForEmptyHandoff(windows, undefined), latest);
		assert.strictEqual(findWindowForEmptyHandoff(windows, 'ssh-remote+host'), remote);
		assert.strictEqual(findWindowForEmptyHandoff(windows, 'ssh-remote+other'), undefined);
		assert.strictEqual(findWindowForEmptyHandoff(excluded, undefined), undefined);
		assert.deepStrictEqual(windows, [older, latest, remote, ...excluded]);
	});

	test('Empty handoff can reuse an editor before its first focus event', () => {
		const window = createTestCodeWindow({ lastFocusTime: 0, isSessionsWindow: false });
		assert.strictEqual(findWindowForEmptyHandoff([window], undefined), window);
	});

	const vscodeFolderWindow: ICodeWindow = createTestCodeWindow({ lastFocusTime: 1, openedFolderUri: URI.file(join(fixturesFolder, 'vscode_folder')) });
	const lastActiveWindow: ICodeWindow = createTestCodeWindow({ lastFocusTime: 3, openedFolderUri: undefined });
	const noVscodeFolderWindow: ICodeWindow = createTestCodeWindow({ lastFocusTime: 2, openedFolderUri: URI.file(join(fixturesFolder, 'no_vscode_folder')) });
	const windows: ICodeWindow[] = [
		vscodeFolderWindow,
		lastActiveWindow,
		noVscodeFolderWindow,
	];

	test('New window without folder when no windows exist', async () => {
		assert.strictEqual(await findWindowOnFile([], URI.file('nonexisting'), localWorkspaceResolver), undefined);
		assert.strictEqual(await findWindowOnFile([], URI.file(join(fixturesFolder, 'no_vscode_folder', 'file.txt')), localWorkspaceResolver), undefined);
	});

	test('Existing window with folder', async () => {
		assert.strictEqual(await findWindowOnFile(windows, URI.file(join(fixturesFolder, 'no_vscode_folder', 'file.txt')), localWorkspaceResolver), noVscodeFolderWindow);

		assert.strictEqual(await findWindowOnFile(windows, URI.file(join(fixturesFolder, 'vscode_folder', 'file.txt')), localWorkspaceResolver), vscodeFolderWindow);

		const window: ICodeWindow = createTestCodeWindow({ lastFocusTime: 1, openedFolderUri: URI.file(join(fixturesFolder, 'vscode_folder', 'nested_folder')) });
		assert.strictEqual(await findWindowOnFile([window], URI.file(join(fixturesFolder, 'vscode_folder', 'nested_folder', 'subfolder', 'file.txt')), localWorkspaceResolver), window);
	});

	test('More specific existing window wins', async () => {
		const window: ICodeWindow = createTestCodeWindow({ lastFocusTime: 2, openedFolderUri: URI.file(join(fixturesFolder, 'no_vscode_folder')) });
		const nestedFolderWindow: ICodeWindow = createTestCodeWindow({ lastFocusTime: 1, openedFolderUri: URI.file(join(fixturesFolder, 'no_vscode_folder', 'nested_folder')) });
		assert.strictEqual(await findWindowOnFile([window, nestedFolderWindow], URI.file(join(fixturesFolder, 'no_vscode_folder', 'nested_folder', 'subfolder', 'file.txt')), localWorkspaceResolver), nestedFolderWindow);
	});

	test('Workspace folder wins', async () => {
		const window: ICodeWindow = createTestCodeWindow({ lastFocusTime: 1, openedWorkspace: testWorkspace });
		assert.strictEqual(await findWindowOnFile([window], URI.file(join(fixturesFolder, 'vscode_workspace_2_folder', 'nested_vscode_folder', 'subfolder', 'file.txt')), localWorkspaceResolver), window);
	});

	test('Finds an open multi-root workspace by its complete folder set in either order', async () => {
		const workspaceWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace });
		const folderUris = testWorkspaceFolders.map(folder => folder.uri);
		const candidates = [...windows, workspaceWindow];
		assert.deepStrictEqual([
			await findWindowOnWorkspaceFolders(candidates, folderUris, undefined, localWorkspaceResolver),
			await findWindowOnWorkspaceFolders(candidates, [...folderUris].reverse(), undefined, localWorkspaceResolver),
		].map(match => match?.window), [workspaceWindow, workspaceWindow]);
	});

	test('Allows a workspace member only when the handoff explicitly permits additional roots', async () => {
		const workspaceWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace });
		const member = testWorkspaceFolders[0].uri;
		assert.deepStrictEqual([
			await findWindowOnWorkspaceFolders([workspaceWindow], [member], undefined, localWorkspaceResolver),
			await findWindowOnWorkspaceFolders([workspaceWindow], [member], undefined, localWorkspaceResolver, true),
			await findWindowOnWorkspaceFolders([workspaceWindow], [URI.file('/unrelated')], undefined, localWorkspaceResolver, true),
			await findWindowOnWorkspaceFolders([workspaceWindow], [member.with({ path: `${member.path}/nested` })], undefined, localWorkspaceResolver, true),
			await findWindowOnWorkspaceFolders([workspaceWindow], [], undefined, localWorkspaceResolver, true),
		].map(match => match?.window), [undefined, workspaceWindow, undefined, undefined, undefined]);
	});

	test('Prefers an exact editor workspace over a newer editor that also contains unrelated roots', async () => {
		const exact = createTestCodeWindow({ lastFocusTime: 1, openedWorkspace: testWorkspace });
		const widerWorkspace = { id: 'wider', configPath: URI.file('/wider.code-workspace') };
		const wider = createTestCodeWindow({ lastFocusTime: 2, openedWorkspace: widerWorkspace });
		const requested = [testWorkspaceFolders[0].uri];
		const resolve = async (workspace: IWorkspaceIdentifier) => ({
			...workspace,
			folders: workspace === testWorkspace ? [testWorkspaceFolders[0]] : testWorkspaceFolders,
		});
		assert.strictEqual((await findWindowOnWorkspaceFolders([wider, exact], requested, undefined, resolve, true))?.window, exact);
		assert.strictEqual((await findWindowOnWorkspaceFolders([wider], requested, undefined, resolve, true))?.window, wider);
	});

	test('A containing editor must still match its workspace after other candidates resolve', async () => {
		let currentWorkspace = testWorkspace;
		const stale = upcastPartial<ICodeWindow>({ get openedWorkspace() { return currentWorkspace; } });
		const widerWorkspace = { id: 'wider', configPath: URI.file('/wider.code-workspace') };
		const wider = createTestCodeWindow({ lastFocusTime: 1, openedWorkspace: widerWorkspace });
		const resolve = async (workspace: IWorkspaceIdentifier) => {
			if (workspace === widerWorkspace) {
				currentWorkspace = { id: 'unrelated', configPath: URI.file('/unrelated.code-workspace') };
			}
			return { ...workspace, folders: testWorkspaceFolders };
		};
		const match = await findWindowOnWorkspaceFolders([stale, wider], [testWorkspaceFolders[0].uri], undefined, resolve, true);
		assert.strictEqual(match?.window, wider);
	});

	test('Ignores the Agents window when looking for a matching editor', async () => {
		const agents = createTestCodeWindow({ lastFocusTime: 2, openedWorkspace: testWorkspace, isSessionsWindow: true });
		const editor = createTestCodeWindow({ lastFocusTime: 1, openedWorkspace: testWorkspace, isSessionsWindow: false });
		const requested = testWorkspaceFolders.map(folder => folder.uri);
		assert.strictEqual((await findWindowOnWorkspaceFolders([agents, editor], requested, undefined, localWorkspaceResolver))?.window, editor);
	});

	test('Returns the validated workspace identity instead of rereading a later window navigation', async () => {
		let currentWorkspace = testWorkspace;
		const window = upcastPartial<ICodeWindow>({
			get openedWorkspace() { return currentWorkspace; },
			remoteAuthority: undefined, isExtensionDevelopmentHost: false,
		});
		const match = await findWindowOnWorkspaceFolders([window], testWorkspaceFolders.map(folder => folder.uri), undefined, localWorkspaceResolver);
		assert.ok(match);
		currentWorkspace = { id: 'other', configPath: URI.file('/other.code-workspace') };
		assert.deepStrictEqual({ sameWindow: match.window === window, workspace: match.workspace }, { sameWindow: true, workspace: testWorkspace });
	});

	test('Requires an exact unique folder set before reusing an open workspace', async () => {
		const workspaceWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace });
		const folderUris = testWorkspaceFolders.map(folder => folder.uri);
		const anotherFolder = toWorkspaceFolders([{ uri: URI.file('/another-folder').toString() }], testWorkspace.configPath, extUriBiasedIgnorePathCase)[0];
		for (const folders of [
			[testWorkspaceFolders[0]],
			[...testWorkspaceFolders, anotherFolder],
			[testWorkspaceFolders[0], testWorkspaceFolders[0]],
			[testWorkspaceFolders[0], anotherFolder],
		]) {
			assert.strictEqual(await findWindowOnWorkspaceFolders([workspaceWindow], folderUris, undefined, async () => ({ ...testWorkspace, folders })), undefined);
		}
		assert.strictEqual(await findWindowOnWorkspaceFolders([workspaceWindow], [folderUris[0], folderUris[0]], undefined, localWorkspaceResolver), undefined);
	});

	test('Does not match identical network paths on different file servers', async () => {
		const workspaceWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace });
		const requested = [URI.parse('file://server-a/share/one'), URI.parse('file://server-a/share/two')];
		const folders = toWorkspaceFolders([{ uri: 'file://server-b/share/one' }, { uri: 'file://server-b/share/two' }], testWorkspace.configPath, extUriBiasedIgnorePathCase);
		assert.strictEqual(await findWindowOnWorkspaceFolders([workspaceWindow], requested, undefined, async () => ({ ...testWorkspace, folders })), undefined);
	});

	test('Preserves remote folder case rather than applying the local Windows filesystem comparison', () => {
		const remoteAuthority = 'ssh-remote+linux';
		const folderUris = [URI.parse('vscode-remote://ssh-remote+linux/Repo'), URI.parse('vscode-remote://ssh-remote+linux/common')];
		const folders = toWorkspaceFolders(folderUris.map(uri => ({ uri: uri.toString() })), testWorkspace.configPath, extUriBiasedIgnorePathCase);
		const workspace = { ...testWorkspace, folders, remoteAuthority };
		assert.deepStrictEqual([
			workspaceMatchesFolders(workspace, [folderUris[0].with({ path: '/repo' }), folderUris[1]], remoteAuthority),
			workspaceMatchesFolders(workspace, folderUris, remoteAuthority),
			workspaceMatchesFolders(workspace, [folderUris[0].with({ path: '/repo' })], remoteAuthority, true),
			workspaceMatchesFolders(workspace, [folderUris[0]], remoteAuthority, true),
		], [false, true, false, true]);
	});

	test('Does not reuse missing, transient, development-host, or mismatched remote workspaces', async () => {
		const folderUris = testWorkspaceFolders.map(folder => folder.uri);
		const remoteAuthority = 'ssh-remote+host';
		const workspaceWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace });
		const remoteWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace, remoteAuthority });
		const developmentWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace, isExtensionDevelopmentHost: true });
		const resolved = { ...testWorkspace, folders: testWorkspaceFolders };
		assert.deepStrictEqual([
			await findWindowOnWorkspaceFolders([workspaceWindow], folderUris, undefined, async () => undefined),
			await findWindowOnWorkspaceFolders([workspaceWindow], folderUris, undefined, async () => ({ ...resolved, transient: true })),
			await findWindowOnWorkspaceFolders([developmentWindow], folderUris, undefined, localWorkspaceResolver),
			await findWindowOnWorkspaceFolders([remoteWindow], folderUris, undefined, async () => resolved),
			await findWindowOnWorkspaceFolders([workspaceWindow], folderUris, remoteAuthority, async () => ({ ...resolved, remoteAuthority })),
			await findWindowOnWorkspaceFolders([remoteWindow], folderUris, remoteAuthority, async () => resolved),
			await findWindowOnWorkspaceFolders([remoteWindow], folderUris, remoteAuthority, async () => ({ ...resolved, remoteAuthority })),
		].map(match => match?.window), [undefined, undefined, undefined, undefined, undefined, undefined, remoteWindow]);
	});

	for (const change of ['workspace', 'remote', 'developmentHost'] as const) {
		test(`Ignores a window whose ${change} changes while its workspace file is resolving`, async () => {
			let currentWorkspace = testWorkspace;
			let remoteAuthority: string | undefined;
			let isExtensionDevelopmentHost = false;
			const window = upcastPartial<ICodeWindow>({
				get openedWorkspace() { return currentWorkspace; },
				get remoteAuthority() { return remoteAuthority; },
				get isExtensionDevelopmentHost() { return isExtensionDevelopmentHost; },
			});
			const gate = new DeferredPromise<void>();
			const found = findWindowOnWorkspaceFolders([window], testWorkspaceFolders.map(folder => folder.uri), undefined, async () => {
				await gate.p;
				return { ...testWorkspace, folders: testWorkspaceFolders };
			});
			if (change === 'workspace') { currentWorkspace = { id: 'other', configPath: URI.file('/other.code-workspace') }; }
			if (change === 'remote') { remoteAuthority = 'ssh-remote+other'; }
			if (change === 'developmentHost') { isExtensionDevelopmentHost = true; }
			await gate.complete();
			assert.strictEqual(await found, undefined);
		});
	}

	test('Window on the requested path, not a restored one', () => {
		const workspaceWindow: ICodeWindow = createTestCodeWindow({ lastFocusTime: 4, openedWorkspace: testWorkspace });
		const usedWindows = [vscodeFolderWindow, noVscodeFolderWindow, workspaceWindow];
		const vscodeFolder = { id: '', uri: URI.file(join(fixturesFolder, 'vscode_folder')) };
		const file = URI.file(join(fixturesFolder, 'no_vscode_folder', 'file.txt'));
		const found = [
			findWindowOnRequestedPath(usedWindows, [{ workspace: vscodeFolder }], undefined),
			findWindowOnRequestedPath(usedWindows, [{ workspace: testWorkspace }], undefined),
			findWindowOnRequestedPath(usedWindows, [{ fileUri: file }], noVscodeFolderWindow),
			// A requested path that doesn't exist isn't resolved, so a single restored window must not be picked
			findWindowOnRequestedPath([vscodeFolderWindow], [], undefined),
			findWindowOnRequestedPath(usedWindows, [{ workspace: vscodeFolder }, { workspace: testWorkspace }], undefined),
		];
		assert.deepStrictEqual(found.map(window => window ? usedWindows.indexOf(window) : -1), [0, 2, 1, -1, -1]);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
