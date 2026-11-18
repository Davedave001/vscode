/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import { allocateInspectorArgs } from './agent-workspace-test-utils.mts';

assert.equal(process.platform, 'win32', 'This smoke check uses the prepared Windows development runtime');
const require = createRequire(import.meta.url);
const { startServer, registerScenario } = require('./chat-simulation/common/mock-llm-server.ts') as typeof import('./chat-simulation/common/mock-llm-server.ts');
const { buildEnv } = require('./chat-simulation/common/utils.js') as { buildEnv(server: { url: string }): Record<string, string> };
const { createLaunchOptions } = require('./code-agent-workspace.ts') as { createLaunchOptions(root: string, workspace: string, ide: boolean, env: NodeJS.ProcessEnv, optimized?: boolean, optimizedBuild?: string): { executable: string; args: string[]; environment: NodeJS.ProcessEnv } };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.build', 'agent-workspace-native-smoke', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const { values: flags } = parseArgs({
	options: {
		'empty-workspace': { type: 'boolean' },
		conversation: { type: 'boolean' },
		protocol: { type: 'boolean' },
		'workspace-protocol': { type: 'boolean' },
		keyboard: { type: 'boolean' },
		'app-connections': { type: 'boolean' },
		themes: { type: 'boolean' },
		optimized: { type: 'boolean' },
		'optimized-build': { type: 'string' },
	},
});
const optimized = flags.optimized ?? false;
const optimizedBuild = flags['optimized-build'];
assert.ok(optimizedBuild === undefined || (optimized && optimizedBuild.trim()), 'Use --optimized --optimized-build <folder> to select a staged desktop build.');
const { keyboard, 'app-connections': appConnections, themes } = flags;
const themePalettes = {
	dark: {
		name: 'Dark 2026', themeClass: 'vscode-theme-defaults-themes-2026-dark-json',
		colors: {
			'editor.background': '#17324d', 'editor.foreground': '#ddeeff', 'panel.background': '#30243a',
			'sideBar.background': '#11202b', 'input.background': '#1e2f44',
			'titleBar.activeBackground': '#0a1118', 'titleBar.inactiveBackground': '#0a1118',
		},
	},
	light: {
		name: 'Light 2026', themeClass: 'vscode-theme-defaults-themes-2026-light-json',
		colors: {
			'editor.background': '#fff4db', 'editor.foreground': '#25364a', 'panel.background': '#e6edf7',
			'sideBar.background': '#e8dfee', 'input.background': '#f2e9f6',
			'titleBar.activeBackground': '#e0d6ee', 'titleBar.inactiveBackground': '#e0d6ee',
		},
	},
} as const;
let expectedTheme: typeof themePalettes[keyof typeof themePalettes] = themePalettes.dark;
const workspaceProtocol = flags['workspace-protocol'];
const protocol = workspaceProtocol || flags.protocol;
const launchToken = 'synthetic-test-launch-token';
const conversation = protocol || flags.conversation;
const emptyWorkspace = conversation || flags['empty-workspace'];
assert.ok(!themes || !emptyWorkspace, '--themes checks the multi-root workspace round trip');
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
	optimized,
	executable: '',
	scenario: workspaceProtocol ? 'workspace-protocol-conversation' : protocol ? 'protocol-conversation' : conversation ? 'folderless-conversation' : emptyWorkspace ? 'empty-workspace' : 'multi-root',
	windowReuseVerified: false, dirtyBufferRetained: false, agentsDraftRetained: false,
	conversationCompleted: false, conversationRestoredInIDE: false, modelRequestCountBeforeHandoff: 0,
	warmProtocolConversationRestored: false, coldProtocolConversationRestored: false,
	recentWorkspaceProtocolVerified: false,
	launchEnvironmentExcludedFromTrace: false,
	coldCliFallbackVerified: false, coldClaudeCliVersion: '',
	keyboardActivations: [] as { stage: string; method: string; commandId: string }[],
	modelRequestCount: 0,
	appPickerVerified: false, payPalSandboxVerified: false, datadogRegionVerified: false, quickBooksRequirementsVerified: false, appSetupCancellationVerified: false,
	appHeaderVerified: false, googleOAuthSetupVerified: false, browseAppConnectionsVerified: false,
	windowChecks: [] as { stage: string; windows: { id: number; hidden: boolean; title: string }[] }[],
	themeChecks: [] as { stage: string; mode: string; theme: string; canvas: string[]; titlebar: string }[],
	switchSettingChangedWithoutReload: false,
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
		...(themes ? { 'workbench.colorTheme': expectedTheme.name, 'workbench.colorCustomizations': expectedTheme.colors } : {}),
		...(appConnections ? { 'chat.customizations.marketplace.enabled': true } : {}),
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
	// Trace logging includes the environment of forwarded CLI requests. Keep only
	// OS launch variables and the mock credentials generated by buildEnv.
	const fixtureEnvironment = new Set([
		'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'OS',
		'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'TEMP', 'TMP', 'TMPDIR',
		'NODE_ENV', 'ELECTRON_ENABLE_LOGGING', 'IS_SCENARIO_AUTOMATION',
		'VSCODE_DEV', 'VSCODE_CLI', 'GITHUB_PAT', 'VSCODE_COPILOT_CHAT_TOKEN',
	]);
	for (const key of Object.keys(env)) {
		if (!fixtureEnvironment.has(key.toUpperCase())) {
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
		...(protocol ? { SIGNALC_TEST_LAUNCH_TOKEN: launchToken } : {}),
	});
	assert.equal(execFileSync(process.execPath, ['-p', 'require("node:os").homedir()'], { env, windowsHide: true, encoding: 'utf8' }).trim(), fixtureHome);
	const inspectArgs = await allocateInspectorArgs();
	stage = 'launching';
	const launch = createLaunchOptions(root, workspace, true, {}, optimized, optimizedBuild);
	const executable = launch.executable;
	if (optimized) {
		delete env.VSCODE_DEV;
		env.NODE_ENV = 'production';
		for (const key of ['VSCODE_AGENT_HOST_CODEX_SDK_ROOT', 'VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT']) {
			if (launch.environment[key]) { env[key] = launch.environment[key]; }
		}
	}
	const applicationArgs = optimized ? [] : [root];
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
		...(protocol || keyboard ? ['--log', 'trace'] : [])];
	app = await _electron.launch({ executablePath: executable, args: [...applicationArgs, ...(emptyWorkspace ? ['--agents'] : [workspace]), ...commonArgs, ...inspectArgs], env, timeout: 60000 });
	const launched = app;
	deadline = setTimeout(() => { void app?.close().catch(() => {}); }, 180000);
	report.executable = await realpath(await launched.evaluate(() => process.execPath));
	assert.equal(report.executable, await realpath(executable), 'The fixture must run the selected executable');
	assert.deepEqual(await launched.evaluate(({ app }) => ({ portable: process.env.VSCODE_PORTABLE, profile: app.getPath('userData') })), { portable, profile }, 'The fixture must keep portable configuration and editor storage under its own run directory');
	const capture = async (page: Page, name: string, target = launched) => {
		const window = await target.browserWindow(page);
		// A first capture wakes the hidden compositor, which may otherwise return its previous frame.
		await window.evaluate(async nativeWindow => { await nativeWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); });
		// DOM visibility can precede the hidden window's next compositor frame.
		await page.evaluate(async () => {
			await document.fonts.ready;
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		});
		try {
			// CDP screenshots can stall after a hidden native window becomes inactive.
			const png = await window.evaluate(async nativeWindow => (await nativeWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
			assert.ok(png.length, 'The hidden native capture must contain image data');
			await writeFile(join(run, name), Buffer.from(png, 'base64'));
		} finally {
			await window.dispose();
		}
	};
	const themeWindowTimes = new Map<Page, number>();
	const checkTheme = async (page: Page, label: string) => {
		await page.waitForFunction(({ colors, themeClass }) => {
			const root = document.querySelector('.monaco-workbench');
			if (!root?.classList.contains(themeClass)) { return false; }
			const style = getComputedStyle(root);
			return Object.entries(colors).every(([key, value]) => style.getPropertyValue(`--vscode-${key.replaceAll('.', '-')}`).trim() === value);
		}, expectedTheme, { timeout: 30000 });
		const painted = await page.evaluate(() => {
			const root = document.querySelector('.monaco-workbench')!;
			const agents = root.classList.contains('agent-sessions-workbench');
			const selector = agents ? '.session-view, .session-view > .session-view-content' : '.part.editor .monaco-editor .monaco-editor-background';
			const canvases = [...root.querySelectorAll<HTMLElement>(selector)]
				.filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
			return {
				mode: agents ? 'agents' : 'ide',
				canvas: canvases.map(element => getComputedStyle(element).backgroundColor),
				titlebar: getComputedStyle(document.querySelector('.part.titlebar')!).backgroundColor,
				timeOrigin: performance.timeOrigin,
			};
		});
		const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
		const { mode, canvas, titlebar, timeOrigin } = painted;
		assert.equal(timeOrigin, themeWindowTimes.get(page) ?? timeOrigin, `${label}: the ${mode} window should not reload`);
		themeWindowTimes.set(page, timeOrigin);
		assert.equal(titlebar, rgb(expectedTheme.colors['titleBar.activeBackground']), `${label}: title bar should retain the theme`);
		assert.ok(canvas.length, `${label}: expected a visible ${mode} canvas`);
		for (const background of canvas) {
			assert.equal(background, rgb(expectedTheme.colors['editor.background']), `${label}: the visible ${mode} canvas should retain the editor color`);
		}
		report.themeChecks.push({ stage: label, mode, theme: expectedTheme.name, canvas, titlebar });
	};
	const checkWindows = async (label: string) => {
		const windows = await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, hidden: !window.isVisible(), title: window.getTitle() })));
		report.windowChecks.push({ stage: label, windows });
		assert.ok(windows.every(window => window.hidden), 'Every fixture window must remain hidden');
		if (themes) {
			for (const page of launched.windows()) { await checkTheme(page, label); }
		}
		return windows.map(window => window.id).sort((a, b) => a - b);
	};
	const rendererLogs = async () => {
		const logs: string[] = [];
		for (const log of await readdir(join(profile, 'logs'), { withFileTypes: true })) {
			if (!log.isDirectory()) { continue; }
			for (const window of await readdir(join(profile, 'logs', log.name), { withFileTypes: true })) {
				if (!window.isDirectory() || !window.name.startsWith('window')) { continue; }
				logs.push(await readFile(join(profile, 'logs', log.name, window.name, 'renderer.log'), 'utf8').catch(() => ''));
			}
		}
		return logs;
	};
	const checkAppConnections = async (page: Page) => {
		stage = 'native app connections';
		// Initial account and provider UI can take focus while the workbench restores.
		await page.waitForFunction(() => !!Reflect.get(globalThis, 'driver'));
		await page.evaluate(async () => { await Reflect.get(globalThis, 'driver').whenWorkbenchRestored(); });
		const paths = [join(profile, 'User/mcp.json'), join(profile, 'User/profiles/builtin/agents/mcp.json'), join(run, 'copilot/mcp-config.json'), ...folders.flatMap(folder => [join(folder, '.mcp.json'), join(folder, '.vscode/mcp.json')])];
		const readConfigurations = () => Promise.all(paths.map(file => readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return undefined; } throw error; })));
		const before = await readConfigurations();
		const input = page.locator('.quick-input-widget input').first();
		const openAppPicker = async () => {
			await page.getByRole('switch', { name: 'IDE mode', exact: true }).focus();
			await page.keyboard.press('Control+Shift+P');
			await input.fill('>Signal-C: Connect App');
			await page.getByRole('option').filter({ hasText: 'Signal-C: Connect App' }).waitFor();
			await input.press('Enter');
			await page.getByText('Signal-C App Connections', { exact: true }).waitFor();
		};
		await openAppPicker();
		await input.fill('PayPal');
		const payPalProduction = page.getByRole('option').filter({ has: page.getByText('PayPal (Production)', { exact: true }) });
		const payPalSandbox = page.getByRole('option').filter({ has: page.getByText('PayPal (Sandbox)', { exact: true }) });
		await Promise.all([payPalProduction.waitFor(), payPalSandbox.waitFor()]);
		await payPalSandbox.click();
		const sandboxReview = page.getByRole('dialog').filter({ hasText: 'Connect PayPal (Sandbox)' });
		await sandboxReview.waitFor();
		const sandboxDetails = await sandboxReview.innerText();
		assert.ok(sandboxDetails.includes('https://mcp.sandbox.paypal.com/http'));
		assert.ok(sandboxDetails.includes('sandbox test account'));
		report.payPalSandboxVerified = true;
		await page.keyboard.press('Escape');
		await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
		await openAppPicker();
		await input.fill('Datadog');
		const datadogUs = page.getByRole('option').filter({ has: page.getByText('Datadog (US1)', { exact: true }) });
		const datadogEu = page.getByRole('option').filter({ has: page.getByText('Datadog (EU1)', { exact: true }) });
		await Promise.all([datadogUs.waitFor(), datadogEu.waitFor()]);
		await datadogEu.click();
		const datadogReview = page.getByRole('dialog').filter({ hasText: 'Connect Datadog (EU1)' });
		await datadogReview.waitFor();
		const datadogDetails = await datadogReview.innerText();
		assert.ok(datadogDetails.includes('https://mcp.datadoghq.eu/v1/mcp'));
		assert.ok(datadogDetails.includes('site that hosts your Datadog organization'));
		report.datadogRegionVerified = true;
		await page.keyboard.press('Escape');
		await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
		await openAppPicker();
		await input.fill('QuickBooks');
		await page.getByText('QuickBooks Online (Local Server)', { exact: true }).waitFor();
		const hosted = page.getByRole('option').filter({ has: page.getByText('QuickBooks Online (Hosted Pilot)', { exact: true }) });
		await hosted.waitFor();
		report.appPickerVerified = true;
		await hosted.click();
		const review = page.getByRole('dialog').filter({ hasText: 'Connect QuickBooks Online' });
		await review.waitFor();
		assert.ok((await review.innerText()).includes('invitation-only pilot'));
		assert.ok((await review.innerText()).includes('subscription alone'));
		assert.ok((await review.innerText()).includes('currently unavailable in Signal-C'));
		assert.equal(await review.getByRole('button', { name: 'Connect with OAuth', exact: true }).count(), 0);
		report.quickBooksRequirementsVerified = true;
		await capture(page, 'app-connections-quickbooks.png');
		await page.keyboard.press('Escape');
		await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
		stage = 'MCP page app connection entry point';
		await page.getByRole('switch', { name: 'IDE mode', exact: true }).focus();
		await page.keyboard.press('Control+Shift+P');
		await input.fill('>Customizations');
		await page.getByRole('option').filter({ has: page.getByText('Customizations', { exact: true }) }).first().waitFor();
		await input.press('Enter');
		await page.getByText('MCP Servers', { exact: true }).first().click();
		const editor = page.locator('.ai-customization-management-editor');
		await editor.waitFor();
		const connectApp = editor.getByRole('button', { name: 'Connect App', exact: true });
		await connectApp.waitFor();
		await capture(page, 'app-connections-mcp-page.png');
		await connectApp.focus();
		await connectApp.press('Enter');
		await page.getByText('Signal-C App Connections', { exact: true }).waitFor();
		report.appHeaderVerified = true;
		await input.fill('Gmail');
		await page.getByRole('option').filter({ has: page.getByText('Gmail', { exact: true }) }).waitFor();
		await input.press('Enter');
		const googleReview = page.getByRole('dialog').filter({ hasText: 'Connect Gmail' });
		await googleReview.waitFor();
		assert.ok((await googleReview.innerText()).includes('Google Cloud project'));
		assert.ok((await googleReview.innerText()).includes('AI-powered agent'));
		await capture(page, 'app-connections-google-oauth.png');
		await googleReview.getByRole('button', { name: 'Connect with OAuth', exact: true }).press('Enter');
		await page.getByText('Gmail OAuth App Client ID', { exact: true }).waitFor();
		await input.press('Escape');
		await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
		assert.ok(await connectApp.evaluate(element => element.ownerDocument.activeElement === element), 'Cancelled app setup must restore focus to its MCP header button');
		report.googleOAuthSetupVerified = true;
		stage = 'Browse customizations app connections';
		await editor.locator('button.sidebar-home-button').getByText('Browse', { exact: true }).click();
		const gallery = editor.locator('.customization-discovery');
		await gallery.getByText('Browse customizations', { exact: true }).waitFor();
		await gallery.getByRole('button', { name: 'View all customizations from Signal-C App Connections', exact: true }).waitFor();
		await capture(page, 'browse-customizations-app-connections.png');
		await gallery.getByRole('button', { name: 'Customization source: All Sources', exact: true }).click();
		await page.getByRole('menu').getByText('Signal-C App Connections', { exact: true }).click();
		await gallery.locator('.customization-discovery-search').click({ position: { x: 80, y: 12 } });
		await page.keyboard.type('Datadog EU1');
		const connectDatadog = gallery.getByRole('button', { name: 'Connect Datadog (EU1)', exact: true });
		await connectDatadog.press('Enter');
		await datadogReview.waitFor();
		assert.ok((await datadogReview.innerText()).includes('https://mcp.datadoghq.eu/v1/mcp'));
		await page.keyboard.press('Escape');
		await datadogReview.waitFor({ state: 'hidden' });
		assert.ok(await connectDatadog.evaluate(element => element.ownerDocument.activeElement === element), 'Cancelling the setup review must return focus to its gallery card');
		await gallery.locator('.customization-discovery-search').click({ position: { x: 80, y: 12 } });
		await page.keyboard.press('Control+a');
		await page.keyboard.type('Gmail');
		const galleryGmail = gallery.getByRole('button', { name: 'Connect Gmail', exact: true });
		await galleryGmail.press('Enter');
		await googleReview.waitFor();
		await googleReview.getByRole('button', { name: 'Connect with OAuth', exact: true }).press('Enter');
		await page.getByText('Gmail OAuth App Client ID', { exact: true }).waitFor();
		await input.press('Escape');
		await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
		assert.ok(await galleryGmail.evaluate(element => element.ownerDocument.activeElement === element), 'Cancelling client registration must return focus to its gallery card');
		report.browseAppConnectionsVerified = true;
		await page.keyboard.press('Control+w');
		await editor.waitFor({ state: 'hidden' });
		assert.deepEqual(await readConfigurations(), before, 'Cancelled app setup must not modify any fixture MCP configuration');
		report.appSetupCancellationVerified = true;
		await checkWindows(stage);
	};
	const activateSwitch = async (page: Page, roundTrip: number, sourceInput: Locator) => {
		const control = page.getByRole('switch', { name: 'IDE mode', exact: true });
		if (!keyboard) { await control.click(); return; }
		const toAgents = await control.getAttribute('aria-checked') === 'true';
		const commandId = toAgents ? 'workbench.action.openWorkspaceInAgentsWindow' : 'agents.openSessionInVSCode';
		const countCommands = async () => (await rendererLogs()).reduce((total, log) => total + log.split(/\r?\n/).filter(line => line.endsWith(`CommandService#executeCommand ${commandId}`)).length, 0);
		const before = await countCommands();
		if (roundTrip === 1) {
			await sourceInput.click();
			await page.keyboard.press('Control+k');
			await page.keyboard.press('Control+Shift+a');
		} else {
			await control.focus();
			assert.ok(await control.evaluate(element => element.ownerDocument.activeElement === element), 'Keyboard activation must focus the production switch');
			await page.keyboard.press(toAgents ? 'Enter' : 'Space');
		}
		const timeout = Date.now() + 15000;
		while (await countCommands() === before && Date.now() < timeout) { await new Promise(resolve => setTimeout(resolve, 100)); }
		assert.equal(await countCommands(), before + 1, 'Each keyboard activation must dispatch exactly one mode command');
		report.keyboardActivations.push({ stage, method: roundTrip === 1 ? 'global-shortcut' : toAgents ? 'Enter' : 'Space', commandId });
	};
	if (emptyWorkspace) {
		stage = 'empty Agents';
		const agents = await launched.firstWindow({ timeout: 30000 });
		await agents.locator('.agent-sessions-workbench').waitFor({ timeout: 60000 });
		await agents.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor();
		if (appConnections) { await checkAppConnections(agents); }
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
			for (const renderer of await rendererLogs()) {
				for (const match of renderer.matchAll(/vscode:openChatSession\s+(\S+)/g)) { chatResource = match[1]; }
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
			const forwardToRunningApp = async (args: string[]) => {
				await promisify(execFile)(executable, [...applicationArgs, ...forwardingArgs, ...args], { env, windowsHide: true, timeout: 45000 }).catch(async (error: NodeJS.ErrnoException & { signal?: string; stdout?: string; stderr?: string }) => {
					await writeFile(join(run, 'protocol-helper-error.json'), JSON.stringify({ code: error.code, signal: error.signal, stdout: error.stdout?.replace(/https?:\/\/\S+/g, '[URL]'), stderr: error.stderr?.replace(/https?:\/\/\S+/g, '[URL]') }, null, 2));
					throw new Error('The isolated protocol helper did not exit successfully');
				});
			};
			deliverProtocol = uri => forwardToRunningApp(['--open-url', '--', uri]);
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
			if (workspaceProtocol) {
				stage = 'workspace protocol with identical roots';
				const alternateWorkspace = join(run, 'Alternate.code-workspace');
				await writeFile(alternateWorkspace, JSON.stringify({
					folders: folders.map(path => ({ path })),
					settings: { 'window.title': 'Alternate workspace' },
				}));
				const [alternate] = await Promise.all([
					launched.waitForEvent('window', { timeout: 45000 }),
					forwardToRunningApp(['--new-window', alternateWorkspace]),
				]);
				await alternate.getByRole('tree').getByText('two', { exact: true }).waitFor();
				assert.ok(await alternate.evaluate(token => Reflect.get(globalThis, 'vscode').process.env.SIGNALC_TEST_LAUNCH_TOKEN === token, launchToken));
				const expectedWindows = await checkWindows(stage);
				const alternateWindow = await launched.browserWindow(alternate);
				try {
					// Simulate the alternate editor becoming active without showing a fixture window.
					await alternateWindow.evaluate(nativeWindow => { nativeWindow.emit('focus'); });
					await deliverProtocol(protocolUri);
					await alternate.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor({ timeout: 12000 });
					assert.deepEqual(await checkWindows(stage), expectedWindows);
					report.recentWorkspaceProtocolVerified = true;
					const alternateClosed = alternate.waitForEvent('close', { timeout: 30000 });
					await alternateWindow.evaluate(nativeWindow => nativeWindow.close());
					await alternateClosed;
				} finally { await alternateWindow.dispose(); }
			}
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
			await activateSwitch(ide, roundTrip, ide.getByRole('code').getByText(marker, { exact: false }));
			await ide.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds);
			if (conversation) { await agents.locator('.interactive-session').getByText(responseText, { exact: false }).last().waitFor(); }
			assert.ok((await input.innerText()).replaceAll('\u00a0', ' ').includes(draft));
			report.agentsDraftRetained = true;
			stage = `empty return to IDE ${roundTrip}`;
			await activateSwitch(agents, roundTrip, input);
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
			app = await _electron.launch({ executablePath: executable, args: [...applicationArgs, '--open-url', ...commonArgs, ...await allocateInspectorArgs(), '--', protocolUri], env: coldEnv, timeout: 60000 });
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
		if (appConnections) { await checkAppConnections(ide); }
		const marker = '// Signal-C native unsaved buffer';
		await ide.locator('body').click({ position: { x: 600, y: 400 } });
		await ide.keyboard.press('Control+n');
		await ide.locator('.monaco-editor').first().waitFor({ state: 'visible' });
		await ide.keyboard.type(marker);
		await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
		await ide.locator('.tabs-container .tab.active.dirty').waitFor();
		await checkWindows('IDE ready');
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
		if (themes) {
			stage = 'live theme change in both modes';
			expectedTheme = themePalettes.light;
			const settingsFile = join(profile, 'User', 'settings.json');
			const currentSettings = JSON.parse(await readFile(settingsFile, 'utf8'));
			await writeFile(settingsFile, JSON.stringify({ ...currentSettings, 'workbench.colorTheme': expectedTheme.name, 'workbench.colorCustomizations': expectedTheme.colors }));
			assert.deepEqual(await checkWindows(stage), expectedIds);
		}
		if (keyboard) {
			stage = 'changing the title bar switch setting';
			const settingsFile = join(profile, 'User', 'settings.json');
			const currentSettings = JSON.parse(await readFile(settingsFile, 'utf8'));
			const windows = [ide, agents];
			const rendererStarts = () => Promise.all(windows.map(page => page.evaluate(() => performance.timeOrigin)));
			const starts = await rendererStarts();
			const setSwitchEnabled = (enabled: boolean) => writeFile(settingsFile, JSON.stringify({ ...currentSettings, 'workbench.titleBar.workspaceModeSwitch': enabled }));
			await setSwitchEnabled(false);
			await Promise.all([
				ide.locator('.part.titlebar .open-in-agents-titlebar-widget').waitFor({ timeout: 15000 }),
				agents.locator('.part.titlebar .open-in-vscode-titlebar-widget').waitFor({ timeout: 15000 }),
			]);
			for (const page of windows) {
				assert.equal(await page.getByRole('switch', { name: 'IDE mode', exact: true }).count(), 0);
			}
			await setSwitchEnabled(true);
			await Promise.all(windows.map(page => page.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor({ timeout: 15000 })));
			assert.deepEqual(await rendererStarts(), starts);
			assert.deepEqual(await checkWindows(stage), expectedIds);
			report.switchSettingChangedWithoutReload = true;
		}
		for (let roundTrip = 1; roundTrip <= 2; roundTrip++) {
			stage = `return to IDE ${roundTrip}`;
			await activateSwitch(agents, roundTrip, input);
			await agents.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds, 'The handoff must not open another editor window');
			await ide.getByRole('code').getByText(marker, { exact: false }).waitFor();
			await ide.locator('.tabs-container .tab.active.dirty').waitFor();
			await ide.getByRole('tree').getByText('two', { exact: true }).waitFor();
			report.windowReuseVerified = true; report.dirtyBufferRetained = true;
			await capture(ide, `ide-return-${roundTrip}.png`);
			stage = `return to Agents ${roundTrip}`;
			await activateSwitch(ide, roundTrip, ide.getByRole('code').getByText(marker, { exact: false }));
			await ide.locator('[role="switch"][aria-label="IDE mode"][aria-busy="false"]').waitFor({ timeout: 30000 });
			assert.deepEqual(await checkWindows(stage), expectedIds);
			assert.ok((await input.innerText()).replaceAll('\u00a0', ' ').includes(draft), 'The original Agents draft must remain');
			report.agentsDraftRetained = true;
			console.log(`Native round trip ${roundTrip} retained both window IDs, the dirty buffer, and the Agents draft`);
		}
		await capture(agents, 'agents-returned.png');
	}
	if (keyboard) { assert.equal(report.keyboardActivations.length, 4, 'The native fixture must exercise both modes by shortcut and focused control'); }
	if (protocol) {
		stage = 'launch environment trace';
		const logFiles = await readdir(join(profile, 'logs'), { recursive: true, withFileTypes: true });
		const traceLogs = await Promise.all(logFiles.filter(file => file.isFile() && ['main.log', 'renderer.log', 'ptyhost.log'].includes(file.name))
			.map(file => readFile(join(file.parentPath, file.name), 'utf8')));
		assert.ok(traceLogs.some(log => log.includes('Received a launch request from another instance')));
		assert.ok(traceLogs.some(log => log.includes('workbench#open(): with configuration')));
		assert.ok(traceLogs.every(log => !log.includes(launchToken)), 'Launch and workbench traces must exclude the process environment');
		report.launchEnvironmentExcludedFromTrace = true;
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
