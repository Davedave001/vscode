/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright';

assert.equal(process.platform, 'win32', 'This smoke check uses the prepared Windows development runtime');
const require = createRequire(import.meta.url);
const { startServer } = require('./chat-simulation/common/mock-llm-server.ts') as typeof import('./chat-simulation/common/mock-llm-server.ts');
const { buildEnv } = require('./chat-simulation/common/utils.js') as { buildEnv(server: { url: string }): Record<string, string> };
const { createLaunchOptions } = require('./code-agent-workspace.ts') as { createLaunchOptions(root: string, workspace: string, ide: boolean, env: NodeJS.ProcessEnv): { executable: string } };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.build', 'agent-workspace-native-smoke', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const emptyWorkspace = process.argv.includes('--empty-workspace');
const profile = join(run, 'profile');
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

const mock = await startServer(0, { logger: () => {}, captureRequests: true });
let app: ElectronApplication | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let stage = 'preparing';
const report = {
	scenario: emptyWorkspace ? 'empty-workspace' : 'multi-root',
	windowReuseVerified: false, dirtyBufferRetained: false, agentsDraftRetained: false,
	modelRequestCount: 0,
	windowChecks: [] as { stage: string; windows: { id: number; hidden: boolean; title: string }[] }[],
};
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
	};
	for (const file of [join(profile, 'User', 'settings.json'), join(profile, 'User', 'profiles', 'builtin', 'agents', 'settings.json')]) {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(settings));
	}
	await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });
	await writeFile(join(profile, 'User', 'globalStorage', 'agent-host-config.json'), JSON.stringify({ githubMcpServerEnabled: false }));
	const env = buildEnv(mock);
	const fakeKeys = new Set(['VSCODE_DEV', 'VSCODE_CLI', 'GITHUB_PAT', 'VSCODE_COPILOT_CHAT_TOKEN']);
	for (const key of Object.keys(env)) {
		if (/^(?:VSCODE_|OPENAI|ANTHROPIC|CLAUDE|CODEX|COPILOT|GITHUB|GH_|WINDSURF|DEVIN|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key) && !fakeKeys.has(key)) {
			delete env[key];
		}
	}
	Object.assign(env, {
		CODEX_HOME: join(run, 'codex'), CLAUDE_CONFIG_DIR: join(run, 'claude'), COPILOT_HOME: join(run, 'copilot'), XDG_STATE_HOME: join(run, 'state'),
		COPILOT_API_URL: mock.url, COPILOT_DEBUG_GITHUB_API_URL: mock.url,
		GITHUB_COPILOT_API_TOKEN: 'smoketest-fake-agent-host-token', VSCODE_AGENT_HOST_CAPI_URL_OVERRIDE: mock.url,
	});
	// Reserve separate ports so the dev runtime does not attempt the running editor's default inspectors.
	const reservations: { server: ReturnType<typeof createServer>; port: number }[] = [];
	let inspectArgs: string[];
	try {
		for (let i = 0; i < 4; i++) {
			const server = createServer();
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			reservations.push({ server, port: address.port });
		}
		inspectArgs = ['agenthost', 'ptyhost', 'sharedprocess', 'extensions'].map((name, i) => `--inspect-${name}=${reservations[i].port}`);
	} finally {
		await Promise.all(reservations.map(({ server }) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
	}
	stage = 'launching';
	const executable = createLaunchOptions(root, workspace, true, {}).executable;
	app = await _electron.launch({ executablePath: executable, args: [root, ...(emptyWorkspace ? ['--agents'] : [workspace]),
		'--hidden-window', '--extensionTestsPath', runner, '--enable-smoke-test-driver', ...inspectArgs,
		'--user-data-dir', profile, '--shared-data-dir', join(run, 'shared'), '--extensions-dir', join(run, 'extensions'),
		'--use-inmemory-secretstorage', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		'--disable-telemetry', '--disable-experiments', '--disable-updates', '--disable-extension=vscode.vscode-api-tests'], env, timeout: 60000 });
	const launched = app;
	deadline = setTimeout(() => { void launched.close(); }, 180000);
	const capture = async (page: Page, name: string) => {
		const window = await launched.browserWindow(page);
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
		const input = agents.locator('.new-chat-widget-container .interactive-input-part .monaco-editor');
		const draft = 'Signal-C folderless draft preserved across mode switches';
		await input.click(); await agents.keyboard.type(draft);
		assert.equal((await checkWindows(stage)).length, 1);
		stage = 'first empty IDE';
		const [ide] = await Promise.all([
			launched.waitForEvent('window', { timeout: 45000 }),
			agents.getByRole('switch', { name: 'IDE mode', exact: true }).click(),
		]);
		await ide.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor({ timeout: 60000 });
		const expectedIds = await checkWindows(stage);
		assert.equal(expectedIds.length, 2);
		const marker = '// Signal-C empty editor unsaved buffer';
		await ide.locator('body').click({ position: { x: 600, y: 400 } });
		await ide.keyboard.press('Control+n');
		await ide.locator('.monaco-editor').first().waitFor({ state: 'visible' });
		await ide.keyboard.type(marker);
		await ide.locator('.tabs-container .tab.active.dirty').waitFor();
		for (let roundTrip = 1; roundTrip <= 2; roundTrip++) {
			stage = `empty return to Agents ${roundTrip}`;
			await ide.getByRole('switch', { name: 'IDE mode', exact: true }).click();
			await ide.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds);
			assert.ok((await input.innerText()).replaceAll('\u00a0', ' ').includes(draft));
			report.agentsDraftRetained = true;
			stage = `empty return to IDE ${roundTrip}`;
			await agents.getByRole('switch', { name: 'IDE mode', exact: true }).click();
			await agents.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds, 'A folderless handoff must reuse the existing editor');
			await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
			await ide.locator('.tabs-container .tab.active.dirty').waitFor();
			report.windowReuseVerified = true; report.dirtyBufferRetained = true;
		}
		await capture(ide, 'empty-ide-returned.png');
		await capture(agents, 'empty-agents-retained.png');
		console.log('Two folderless round trips retained the editor window, dirty buffer, and Agents draft');
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
	await Promise.all((app?.windows() ?? []).map((page, i) => page.screenshot({ path: join(run, `failure-${i}.png`), timeout: 5000 }).catch(() => {})));
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
