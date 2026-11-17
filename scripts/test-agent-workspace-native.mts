/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright';

assert.equal(process.platform, 'win32', 'This smoke check uses the prepared Windows development runtime');
const require = createRequire(import.meta.url);
const { startServer, registerScenario } = require('./chat-simulation/common/mock-llm-server.ts') as typeof import('./chat-simulation/common/mock-llm-server.ts');
const { buildEnv } = require('./chat-simulation/common/utils.js') as { buildEnv(server: { url: string }): Record<string, string> };
const { createLaunchOptions } = require('./code-agent-workspace.ts') as { createLaunchOptions(root: string, workspace: string, ide: boolean, env: NodeJS.ProcessEnv): { executable: string; args: string[] } };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.build', 'agent-workspace-native-smoke', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
assert.ok(process.argv.slice(2).every(arg => ['--empty-workspace', '--conversation', '--protocol', '--workspace-protocol'].includes(arg)), 'Use --empty-workspace, --conversation, --protocol, or --workspace-protocol');
const workspaceProtocol = process.argv.includes('--workspace-protocol');
const protocol = workspaceProtocol || process.argv.includes('--protocol');
const conversation = protocol || process.argv.includes('--conversation');
const emptyWorkspace = conversation || process.argv.includes('--empty-workspace');
const portable = join(run, 'portable');
const profile = join(portable, 'user-data');
const fixtureHome = join(run, 'home');
await mkdir(fixtureHome, { recursive: true });
const folders = [join(run, 'one'), join(run, 'two')];
const agentHomes = ['codex', 'claude', 'copilot', 'state'];
for (const directory of [...folders, join(run, 'extensions'), ...agentHomes.map(name => join(run, name))]) {
	await mkdir(directory, { recursive: true });
}
for (const folder of folders) {
	await writeFile(join(folder, 'README.md'), '# Native continuity fixture\n');
	// Keep repository discovery inside the fixture instead of discovering the checkout's parent repository.
	execFileSync('git', ['init', '--quiet'], { cwd: folder, windowsHide: true, stdio: 'pipe' });
}
const workspace = join(run, 'continuity.code-workspace');
await writeFile(workspace, JSON.stringify({ folders: folders.map(path => ({ path })) }));
const runner = join(run, 'unused-extension-test-runner.cjs');
// Hidden-window mode requires a test location. No extension-development path is supplied, so no runner executes.
await writeFile(runner, 'exports.run = async () => { throw new Error("Unexpected extension-development test execution"); };\n');

const responseText = 'Signal-C native conversation retained.';
if (conversation) { registerScenario('text-only', [{ content: responseText, delayMs: 0 }]); }
const mock = await startServer(0, { logger: () => {}, captureRequests: true });
let app: ElectronApplication | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let stage = 'preparing';
const report = {
	scenario: workspaceProtocol ? 'workspace-protocol-conversation' : protocol ? 'protocol-conversation' : conversation ? 'folderless-conversation' : emptyWorkspace ? 'empty-workspace' : 'multi-root',
	windowReuseVerified: false, dirtyBufferRetained: false, agentsDraftRetained: false,
	conversationCompleted: false, conversationRestoredInIDE: false, modelRequestCountBeforeHandoff: 0,
	warmProtocolConversationRestored: false, coldProtocolConversationRestored: false,
	coldCliFallbackVerified: false, coldClaudeCliVersion: '',
	modelRequestCount: 0,
	windowChecks: [] as { stage: string; windows: { id: number; hidden: boolean; title: string }[] }[],
};
// Reserve separate ports so the dev runtime never needs the running editor's default inspectors.
async function allocateInspectorArgs(): Promise<string[]> {
	const reservations: { server: ReturnType<typeof createServer>; port: number }[] = [];
	try {
		for (let i = 0; i < 4; i++) {
			const server = createServer();
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			reservations.push({ server, port: address.port });
		}
		return ['agenthost', 'ptyhost', 'sharedprocess', 'extensions'].map((name, i) => `--inspect-${name}=${reservations[i].port}`);
	} finally {
		await Promise.all(reservations.map(({ server }) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
	}
}

try {
	const settings = {
		'workbench.startupEditor': 'none', 'workbench.editor.showTabs': 'multiple',
		'chat.allowAnonymousAccess': true, 'chat.agent.enabled': true,
		'chat.agentHost.claudeAgent.enabled': false, 'chat.agentHost.codexAgent.enabled': false,
		'chat.agentHost.unsafeTestToken': 'smoketest-fake-agent-host-token',
		'github.copilot.advanced.debug.overrideProxyUrl': mock.url,
		'github.copilot.chat.githubMcpServer.enabled': false, 'github.copilot.chat.cli.legacyProvider.enabled': false,
		'chat.agentHost.githubMcpServer.enabled': false, 'chat.agentHost.computerUse.enabled': false,
		'chat.agentHost.browserUse.enabled': false, 'chat.agentHost.experimental.prewarmSessions': false,
		'chat.agentHost.experimental.autoAttachPullRequests': false,
		'agents.subscriptions.devinExecutable': join(run, 'not-installed-devin.exe'),
		'sessions.useWorktree': false, 'files.autoSave': 'off',
		'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
		...(protocol ? { 'security.promptForLocalFileProtocolHandling': false, 'security.promptForRemoteFileProtocolHandling': false } : {}),
	};
	for (const file of [join(profile, 'User', 'settings.json'), join(profile, 'User', 'profiles', 'builtin', 'agents', 'settings.json')]) {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(settings));
	}
	await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });
	await writeFile(join(profile, 'User', 'globalStorage', 'agent-host-config.json'), JSON.stringify({ githubMcpServerEnabled: false }));
	const env = buildEnv(mock);
	if (conversation) {
		// Only the synthetic token supplied by buildEnv is used; no account profile is copied.
		const token = JSON.parse(Buffer.from(env.VSCODE_COPILOT_CHAT_TOKEN, 'base64').toString()) as Record<string, unknown>;
		Object.assign(token, { copilot_plan: 'individual', sku: 'copilot_individual', isNoAuthUser: false });
		env.VSCODE_COPILOT_CHAT_TOKEN = Buffer.from(JSON.stringify(token)).toString('base64');
	}
	const fakeKeys = new Set(['VSCODE_DEV', 'VSCODE_CLI', 'GITHUB_PAT', 'VSCODE_COPILOT_CHAT_TOKEN']);
	for (const key of Object.keys(env)) {
		if (/^(?:VSCODE_|OPENAI|ANTHROPIC|CLAUDE|CODEX|COPILOT|GITHUB|GH_|WINDSURF|DEVIN|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key) && !fakeKeys.has(key)) {
			delete env[key];
		}
	}
	Object.assign(env, {
		// Portable mode also confines argv.json and disables OS protocol registration.
		VSCODE_PORTABLE: portable,
		// Workspace-less chat scratch directories use os.homedir(), independently of SDK storage.
		USERPROFILE: fixtureHome, HOME: fixtureHome, APPDATA: join(fixtureHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(fixtureHome, 'AppData', 'Local'),
		CODEX_HOME: join(run, 'codex'), CLAUDE_CONFIG_DIR: join(run, 'claude'), COPILOT_HOME: join(run, 'copilot'), XDG_STATE_HOME: join(run, 'state'),
		COPILOT_API_URL: mock.url, COPILOT_DEBUG_GITHUB_API_URL: mock.url,
		GITHUB_COPILOT_API_TOKEN: 'smoketest-fake-agent-host-token', VSCODE_AGENT_HOST_CAPI_URL_OVERRIDE: mock.url,
	});
	assert.equal(execFileSync(process.execPath, ['-p', 'require("node:os").homedir()'], { env, windowsHide: true, encoding: 'utf8' }).trim(), fixtureHome);
	const inspectArgs = await allocateInspectorArgs();
	stage = 'launching';
	const launch = createLaunchOptions(root, workspace, true, {});
	const executable = launch.executable;
	const fallbackIndex = launch.args.indexOf('--agent-cli-fallback-dir');
	assert.ok(fallbackIndex >= 0, 'The native fixture requires the installed official Claude CLI fallback');
	const cliFallback = launch.args[fallbackIndex + 1];
	const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
	// Startup must restore the fallback without help from the parent process's PATH.
	env[pathKey] = (env[pathKey] ?? '').split(delimiter).filter(entry => entry.toLowerCase() !== cliFallback.toLowerCase()).join(delimiter);
	const commonArgs = ['--hidden-window', '--extensionTestsPath', runner, '--enable-smoke-test-driver',
		'--user-data-dir', profile, '--shared-data-dir', join(run, 'shared'), '--extensions-dir', join(run, 'extensions'),
		'--agent-codex-home', join(run, 'codex'), '--agent-claude-config-dir', join(run, 'claude'),
		'--agent-cli-fallback-dir', cliFallback,
		'--use-inmemory-secretstorage', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		'--disable-telemetry', '--disable-experiments', '--disable-updates', '--disable-extension=vscode.vscode-api-tests',
		...(protocol ? ['--log', 'trace'] : [])];
	app = await _electron.launch({ executablePath: executable, args: [root, ...(emptyWorkspace ? ['--agents'] : [workspace]), ...commonArgs, ...inspectArgs], env, timeout: 60000 });
	const launched = app;
	deadline = setTimeout(() => { void app?.close().catch(() => {}); }, 180000);
	assert.deepEqual(await launched.evaluate(({ app }) => ({ portable: process.env.VSCODE_PORTABLE, profile: app.getPath('userData') })), { portable, profile }, 'The fixture must keep portable configuration and editor storage under its own run directory');
	const capture = async (page: Page, name: string, target = launched) => {
		// DOM visibility can precede the hidden window's next compositor frame.
		await page.evaluate(async () => {
			await document.fonts.ready;
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		});
		const window = await target.browserWindow(page);
		try {
			// CDP screenshots can stall after a hidden native window becomes inactive.
			const png = await window.evaluate(async nativeWindow => (await nativeWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
			assert.ok(png.length, 'The hidden native capture must contain image data');
			await writeFile(join(run, name), Buffer.from(png, 'base64'));
		} finally {
			await window.dispose();
		}
	};
	const checkWindows = async (label: string) => {
		const windows = await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, hidden: !window.isVisible(), title: window.getTitle() })));
		report.windowChecks.push({ stage: label, windows });
		assert.ok(windows.every(window => window.hidden), 'Every fixture window must remain hidden');
		return windows.map(window => window.id).sort((a, b) => a - b);
	};
	if (emptyWorkspace) {
		stage = 'empty Agents';
		const agents = await launched.firstWindow({ timeout: 30000 });
		await agents.locator('.agent-sessions-workbench').waitFor({ timeout: 60000 });
		await agents.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor();
		let input = agents.locator('.new-chat-widget-container .interactive-input-part .monaco-editor');
		const draft = 'Signal-C folderless draft preserved across mode switches';
		await input.click(); await agents.keyboard.type(draft);
		if (conversation) {
			stage = 'completing the native mock conversation';
			const modelButton = agents.locator('.new-chat-widget-container').getByText('Auto', { exact: true });
			await modelButton.waitFor({ timeout: 60000 });
			const catalogDeadline = Date.now() + 60000;
			let catalogReady = false;
			while (!catalogReady && Date.now() < catalogDeadline) {
				// Read only this fixture's logs; the SDK publishes its catalog asynchronously.
				const dirs = await readdir(join(profile, 'logs'), { withFileTypes: true });
				for (const dir of dirs.filter(entry => entry.isDirectory())) {
					const log = await readFile(join(profile, 'logs', dir.name, 'agenthost.log'), 'utf8').catch(() => '');
					catalogReady ||= /Found \d+ models:.*GPT-5\.3-Codex \(Mock\)/.test(log);
				}
				if (!catalogReady) { await new Promise(resolve => setTimeout(resolve, 250)); }
			}
			assert.ok(catalogReady, 'The native host must discover the mock model catalog');
			await modelButton.click();
			const model = agents.locator('.chat-model-picker-widget').getByText('GPT-5.3-Codex (Mock)', { exact: true });
			await model.waitFor({ timeout: 30000 });
			assert.equal(await model.evaluate(element => !!element.closest('[aria-disabled="true"], [disabled], .disabled')), false);
			await model.click();
			await input.click(); await agents.keyboard.press('Enter');
			await agents.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor({ timeout: 45000 });
			report.conversationCompleted = true;
			report.modelRequestCountBeforeHandoff = mock.getRequests().length;
			assert.ok(report.modelRequestCountBeforeHandoff > 0, 'The native conversation must reach the local model endpoint');
			input = agents.locator('.interactive-input-part .monaco-editor').last();
			await input.click(); await agents.keyboard.type(draft);
			await capture(agents, 'native-conversation-completed.png');
			console.log('Completed the native conversation through the local mock endpoint');
		}
		assert.equal((await checkWindows(stage)).length, 1);
		stage = 'first empty IDE';
		let [ide] = await Promise.all([
			launched.waitForEvent('window', { timeout: 45000 }),
			agents.getByRole('switch', { name: 'IDE mode', exact: true }).click(),
		]);
		await ide.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor({ timeout: 60000 });
		if (conversation) {
			await ide.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor({ timeout: 45000 });
			report.conversationRestoredInIDE = true;
			console.log('Restored the native conversation in the folderless IDE');
		}
		let protocolUri: string | undefined;
		let deliverProtocol: ((uri: string) => Promise<void>) | undefined;
		if (protocol) {
			stage = 'warm editor protocol';
			let chatResource: string | undefined;
			for (const log of await readdir(join(profile, 'logs'), { withFileTypes: true })) {
				if (!log.isDirectory()) { continue; }
				for (const window of await readdir(join(profile, 'logs', log.name), { withFileTypes: true })) {
					if (!window.isDirectory() || !window.name.startsWith('window')) { continue; }
					const renderer = await readFile(join(profile, 'logs', log.name, window.name, 'renderer.log'), 'utf8').catch(() => '');
					for (const match of renderer.matchAll(/vscode:openChatSession\s+(\S+)/g)) { chatResource = match[1]; }
				}
			}
			assert.ok(chatResource, 'The first native handoff must record its conversation identity');
			const product = JSON.parse(await readFile(join(root, 'product.json'), 'utf8')) as { urlProtocol: string };
			const link = new URL(`${product.urlProtocol}://editor-window/open`);
			link.searchParams.set('session', chatResource);
			if (workspaceProtocol) { link.searchParams.set('folders', JSON.stringify(folders.map(folder => pathToFileURL(folder).toString()))); }
			protocolUri = link.toString();
			const closed = ide.waitForEvent('close', { timeout: 30000 });
			const window = await launched.browserWindow(ide);
			try { await window.evaluate(nativeWindow => nativeWindow.close()); } finally { await window.dispose(); }
			await closed;
			// Direct CLI delivery exercises this fixture's URL receiver without OS protocol registration.
			// A second instance must not carry extensionTestsPath: the launcher rejects test-instance forwarding.
			const forwardingArgs = commonArgs.filter(arg => arg !== '--extensionTestsPath' && arg !== runner);
			deliverProtocol = async uri => {
				await promisify(execFile)(executable, [root, '--open-url', ...forwardingArgs, '--', uri], { env, windowsHide: true, timeout: 45000 }).catch(async (error: NodeJS.ErrnoException & { signal?: string; stdout?: string; stderr?: string }) => {
					await writeFile(join(run, 'protocol-helper-error.json'), JSON.stringify({ code: error.code, signal: error.signal, stdout: error.stdout?.replace(/https?:\/\/\S+/g, '[URL]'), stderr: error.stderr?.replace(/https?:\/\/\S+/g, '[URL]') }, null, 2));
					throw new Error('The isolated protocol helper did not exit successfully');
				});
			};
			[ide] = await Promise.all([
				launched.waitForEvent('window', { timeout: 45000 }),
				deliverProtocol(protocolUri),
			]);
			await ide.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor({ timeout: 60000 });
			await ide.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor({ timeout: 60000 });
			if (workspaceProtocol) {
				await ide.getByRole('tree').getByText('one', { exact: true }).waitFor();
				await ide.getByRole('tree').getByText('two', { exact: true }).waitFor();
			}
			report.warmProtocolConversationRestored = true;
			await capture(ide, 'protocol-warm-editor.png');
			console.log('Restored the conversation through the running editor protocol receiver');
		}
		const expectedIds = await checkWindows(stage);
		assert.equal(expectedIds.length, 2);
		const marker = '// Signal-C empty editor unsaved buffer';
		await ide.locator('body').click({ position: { x: 600, y: 400 } });
		await ide.keyboard.press('Control+n');
		await ide.locator('.monaco-editor').first().waitFor({ state: 'visible' });
		await ide.keyboard.type(marker);
		await ide.locator('.tabs-container .tab.active.dirty').waitFor();
		if (workspaceProtocol) {
			assert.ok(protocolUri && deliverProtocol);
			const reordered = new URL(protocolUri);
			reordered.searchParams.set('folders', JSON.stringify([...folders].reverse().map(folder => pathToFileURL(folder).toString())));
			await deliverProtocol(reordered.toString());
			await ide.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor();
			assert.deepEqual(await checkWindows('reordered workspace protocol'), expectedIds, 'Reordered roots must reuse the same workspace editor');
			await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
			await ide.locator('.tabs-container .tab.active.dirty').waitFor();
		}
		for (let roundTrip = 1; roundTrip <= 2; roundTrip++) {
			stage = `empty return to Agents ${roundTrip}`;
			await ide.getByRole('switch', { name: 'IDE mode', exact: true }).click();
			await ide.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds);
			if (conversation) { await agents.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor(); }
			assert.ok((await input.innerText()).replaceAll('\u00a0', ' ').includes(draft));
			report.agentsDraftRetained = true;
			stage = `empty return to IDE ${roundTrip}`;
			await agents.getByRole('switch', { name: 'IDE mode', exact: true }).click();
			await agents.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds, 'A folderless handoff must reuse the existing editor');
			if (conversation) { await ide.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor(); }
			await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
			await ide.locator('.tabs-container .tab.active.dirty').waitFor();
			report.windowReuseVerified = true; report.dirtyBufferRetained = true;
		}
		await capture(ide, 'empty-ide-returned.png');
		await capture(agents, 'empty-agents-retained.png');
		if (conversation) { assert.equal(mock.getRequests().length, report.modelRequestCountBeforeHandoff, 'Restoring the conversation must not send another model request'); }
		console.log('Two folderless round trips retained the editor window, dirty buffer, and Agents draft');
		if (protocol) {
			stage = 'cold editor protocol';
			assert.ok(protocolUri);
			await launched.close();
			const coldEnv = { ...env };
			delete coldEnv.CODEX_HOME; delete coldEnv.CLAUDE_CONFIG_DIR;
			app = await _electron.launch({ executablePath: executable, args: [root, '--open-url', ...commonArgs, ...await allocateInspectorArgs(), '--', protocolUri], env: coldEnv, timeout: 60000 });
			const coldApp = app;
			await coldApp.firstWindow({ timeout: 45000 });
			assert.deepEqual(await coldApp.evaluate(() => ({ codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR })), { codex: join(run, 'codex'), claude: join(run, 'claude') }, 'Cold URL startup must restore explicit agent homes without launcher environment variables');
			assert.ok(await coldApp.evaluate((_electron, directory) => (process.env.PATH ?? '').split(';').some(entry => entry.toLowerCase() === directory.toLowerCase()), cliFallback), 'Cold URL startup must restore the explicit CLI fallback without the launcher PATH');
			report.coldClaudeCliVersion = await coldApp.evaluate(() => new Promise<string>((resolve, reject) => {
				process.getBuiltinModule('child_process').execFile('claude.exe', ['--version'], { windowsHide: true, timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
			}));
			assert.match(report.coldClaudeCliVersion, /Claude Code/);
			report.coldCliFallbackVerified = true;
			let coldIDE: Page | undefined;
			const restored = Date.now() + 60000;
			while (!coldIDE && Date.now() < restored) {
				for (const page of coldApp.windows()) {
					if (await page.locator('.interactive-session').getByText(responseText, { exact: false }).last().isVisible()) { coldIDE = page; break; }
				}
				if (!coldIDE) { await new Promise(resolve => setTimeout(resolve, 200)); }
			}
			assert.ok(coldIDE, 'Cold protocol startup must restore the conversation in one editor');
			await coldIDE.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor({ timeout: 60000 });
			assert.equal(await coldIDE.getByRole('switch', { name: 'IDE mode', exact: true }).getAttribute('aria-checked'), 'true');
			await coldIDE.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor({ timeout: 60000 });
			const windows = await coldApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, hidden: !window.isVisible(), title: window.getTitle() })));
			report.windowChecks.push({ stage, windows });
			assert.equal(windows.length, workspaceProtocol ? 1 : 2, 'Cold startup must recover its dirty editor and reuse a matching workspace');
			assert.ok(windows.every(window => window.hidden));
			if (workspaceProtocol) {
				await coldIDE.getByRole('tree').getByText('one', { exact: true }).waitFor();
				await coldIDE.getByRole('tree').getByText('two', { exact: true }).waitFor();
			}
			let conversationWindows = 0;
			let recoveredBuffer = false;
			for (const page of coldApp.windows()) {
				if (await page.locator('.interactive-session').getByText(responseText, { exact: false }).last().isVisible()) { conversationWindows++; }
				if (await page.getByRole('code').getByText(marker, { exact: false }).isVisible()) {
					await page.locator('.tabs-container .tab.active.dirty').waitFor();
					recoveredBuffer = true;
				}
			}
			assert.equal(conversationWindows, 1, 'Only the selected editor receives the external conversation');
			assert.ok(recoveredBuffer, 'Cold startup must recover the unsaved editor buffer');
			assert.equal(mock.getRequests().length, report.modelRequestCountBeforeHandoff, 'Cold restoration must not repeat the prompt');
			report.coldProtocolConversationRestored = true;
			await capture(coldIDE, 'protocol-cold-editor.png', coldApp);
			console.log('Restored the persisted conversation through cold editor protocol startup');
		}

	} else {
		const ide = await launched.firstWindow({ timeout: 30000 });
		stage = 'native IDE';
		await ide.getByRole('tree').getByText('one', { exact: true }).waitFor({ timeout: 60000 });
		await ide.getByRole('tree').getByText('two', { exact: true }).waitFor();
		await checkWindows('IDE ready');
		const marker = '// Signal-C native unsaved buffer';
		await ide.locator('body').click({ position: { x: 600, y: 400 } });
		await ide.keyboard.press('Control+n');
		await ide.locator('.monaco-editor').first().waitFor({ state: 'visible' });
		await ide.keyboard.type(marker);
		await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
		await ide.locator('.tabs-container .tab.active.dirty').waitFor();
		console.log('Created a dirty buffer in the hidden native multi-root editor');
		stage = 'native Agents';
		const [agents] = await Promise.all([
			launched.waitForEvent('window', { timeout: 45000 }),
			ide.getByRole('switch', { name: 'IDE mode', exact: true }).click(),
		]);
		await agents.locator('.agent-sessions-workbench').waitFor({ timeout: 60000 });
		await agents.getByText('one', { exact: true }).first().waitFor({ timeout: 45000 });
		const expectedIds = await checkWindows('Agents ready');
		assert.equal(expectedIds.length, 2, 'The fixture should contain only its editor and Agents windows');
		const input = agents.locator('.new-chat-widget-container .interactive-input-part .monaco-editor');
		const draft = 'Signal-C native draft preserved across mode switches';
		await input.click(); await agents.keyboard.type(draft);
		await capture(agents, 'agents-draft.png');
		for (let roundTrip = 1; roundTrip <= 2; roundTrip++) {
			stage = `return to IDE ${roundTrip}`;
			await agents.getByRole('switch', { name: 'IDE mode', exact: true }).click();
			await agents.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds, 'The handoff must not open another editor window');
			await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
			await ide.locator('.tabs-container .tab.active.dirty').waitFor();
			await ide.getByRole('tree').getByText('two', { exact: true }).waitFor();
			report.windowReuseVerified = true; report.dirtyBufferRetained = true;
			await capture(ide, `ide-return-${roundTrip}.png`);
			stage = `return to Agents ${roundTrip}`;
			await ide.getByRole('switch', { name: 'IDE mode', exact: true }).click();
			await ide.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds);
			assert.ok((await input.innerText()).replaceAll('\u00a0', ' ').includes(draft), 'The original Agents draft must remain');
			report.agentsDraftRetained = true;
			console.log(`Native round trip ${roundTrip} retained both window IDs, the dirty buffer, and the Agents draft`);
		}
		await capture(agents, 'agents-returned.png');
	}
} catch (error) {
	const failedApp = app;
	await Promise.all((failedApp?.windows() ?? []).map(async (page, i) => {
		try {
			const window = await failedApp!.browserWindow(page);
			try {
				const png = await window.evaluate(async nativeWindow => (await nativeWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
				await writeFile(join(run, `failure-${i}.png`), Buffer.from(png, 'base64'));
			} finally { await window.dispose(); }
			await writeFile(join(run, `failure-${i}.json`), JSON.stringify(await page.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 12000) })), null, 2));
		} catch { /* Retain other diagnostics if a failed window already closed. */ }
	}));
	await writeFile(join(run, 'failure.json'), JSON.stringify({ stage, message: error instanceof Error ? error.message : String(error) }, null, 2));
	throw error;
} finally {
	if (deadline) { clearTimeout(deadline); }
	try {
		await app?.close();
	} finally {
		report.modelRequestCount = mock.getRequests().length;
		try { await mock.close(); }
		finally {
			await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2));
			console.log(`Artifacts: ${run}`);
		}
	}
}
