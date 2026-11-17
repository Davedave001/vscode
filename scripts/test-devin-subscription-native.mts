/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { allocateInspectorArgs } from './agent-workspace-test-utils.mts';

assert.equal(process.platform, 'win32', 'Use the prepared Windows development runtime');
assert.equal(process.argv.length, 2, 'This isolated smoke check does not take arguments');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { createLaunchOptions } = require('./code-agent-workspace.ts') as { createLaunchOptions(root: string, workspace: string, ide: boolean, env: NodeJS.ProcessEnv): { executable: string } };
const run = join(root, '.build', 'devin-subscription-native', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const home = join(run, 'home');
const portable = join(run, 'portable');
const profile = join(portable, 'user-data');
const extensions = join(run, 'extensions');
const fixture = join(extensions, 'signal-c-test.devin-native-0.0.1');
const reports = join(run, 'reports');
for (const folder of [home, reports, join(fixture, 'production')]) { await mkdir(folder, { recursive: true }); }
const commands = ['claimAgents', 'claimIDE', 'signIn', 'signOut'] as const;
const titles = { claimAgents: 'Claim Agents', claimIDE: 'Claim IDE', signIn: 'Sign In', signOut: 'Sign Out' };
await writeFile(join(fixture, 'package.json'), JSON.stringify({
	name: 'devin-native', publisher: 'signal-c-test', version: '0.0.1', engines: { vscode: '^1.148.0' },
	main: './extension.cjs', type: 'commonjs', activationEvents: ['onStartupFinished'],
	extensionKind: ['ui'], capabilities: { agentsWindow: { supported: true }, untrustedWorkspaces: { supported: true } },
	contributes: {
		authentication: [{ id: 'devin-subscription', label: 'Devin Subscription' }],
		commands: commands.map(command => ({ command: `signalCFixture.${command}`, title: `Signal-C Fixture: ${titles[command]}` })),
	},
}));
const compiler = join(root, 'node_modules/@typescript/native/bin/tsc');
execFileSync(process.execPath, [compiler, '-p', 'extensions/devin-subscription/tsconfig.json', '--module', 'Node16', '--moduleResolution', 'Node16'], { cwd: root, windowsHide: true, stdio: 'pipe' });
execFileSync(process.execPath, [compiler, '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2024', '--module', 'Node16', '--moduleResolution', 'Node16', '--allowImportingTsExtensions', '--rewriteRelativeImportExtensions', '--types', 'node', '--rootDir', root, '--outDir', join(run, 'compiled'), 'extensions/devin-subscription/test/native/extension.cts', 'src/vscode-dts/vscode.d.ts'], { cwd: root, windowsHide: true, stdio: 'pipe' });
await copyFile(join(run, 'compiled/extensions/devin-subscription/test/native/extension.cjs'), join(fixture, 'extension.cjs'));
for (const file of ['extension.js', 'auth.js']) { await copyFile(join(root, 'extensions/devin-subscription/out', file), join(fixture, 'production', file)); }
const settings = {
	'chat.allowAnonymousAccess': true,
	'workbench.startupEditor': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
	'chat.agentHost.codexAgent.enabled': false, 'chat.agentHost.claudeAgent.enabled': false,
	'chat.agentHost.githubMcpServer.enabled': false, 'github.copilot.chat.githubMcpServer.enabled': false,
	'chat.agentHost.computerUse.enabled': false, 'chat.agentHost.browserUse.enabled': false,
	'chat.agentHost.experimental.prewarmSessions': false,
	'agents.subscriptions.devinExecutable': join(run, 'not-installed-devin.exe'),
};
for (const file of [join(profile, 'User/settings.json'), join(profile, 'User/profiles/builtin/agents/settings.json')]) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings));
}
const runner = join(run, 'unused-runner.cjs');
await writeFile(runner, 'exports.run = async () => { throw new Error("Unexpected extension-development runner"); };');
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
for (const key of Object.keys(env)) {
	if (/^(?:VSCODE_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|CODEX|CLAUDE|COPILOT|DEVIN|WINDSURF|GITHUB|GH_|OPENAI|ANTHROPIC|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) { delete env[key]; }
}
Object.assign(env, {
	VSCODE_DEV: '1', VSCODE_CLI: '1', VSCODE_PORTABLE: portable,
	USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
	CODEX_HOME: join(run, 'codex'), CLAUDE_CONFIG_DIR: join(run, 'claude'), COPILOT_HOME: join(run, 'copilot'), XDG_STATE_HOME: join(run, 'state'),
});
let app: ElectronApplication | undefined;
let stage = 'launching';
const report = { nativeSharedSignIn: false, nativeReplacement: false, nativeSharedSignOut: false, pendingCodeCancelled: false, automaticCallback: false, windowsHidden: false };
interface Snapshot {
	role: string; pid: number; result: string; pending: boolean; exchanges: number;
	sessions: { id: string; accountId: string }[];
	events: { added: string[]; removed: string[]; changed: string[] }[];
}
async function snapshot(role: string, predicate: (value: Snapshot) => boolean): Promise<Snapshot> {
	const until = Date.now() + 20000;
	while (Date.now() < until) {
		for (const file of await readdir(reports)) {
			let value: Snapshot;
			try { value = JSON.parse(await readFile(join(reports, file), 'utf8')); } catch { continue; }
			if (value.role === role && predicate(value)) { return value; }
		}
		await delay(100);
	}
	throw new Error(`Native ${role} account state did not settle during ${stage}`);
}
async function command(page: Page, command: typeof commands[number]): Promise<void> {
	await page.getByRole('switch', { name: 'IDE mode', exact: true }).focus();
	await page.keyboard.press('Control+Shift+P');
	const input = page.locator('.quick-input-widget input').first();
	await input.fill(`>Signal-C Fixture: ${titles[command]}`);
	await page.getByRole('option').filter({ hasText: `Signal-C Fixture: ${titles[command]}` }).first().waitFor();
	await input.press('Enter');
}
async function beginSignIn(page: Page, manual: boolean): Promise<void> {
	await command(page, 'signIn');
	await page.getByRole('option').filter({ hasText: manual ? 'Browser Code' : 'Browser Sign-In' }).first().click();
	// Keep the real external-link confirmation; approve only the expected synthetic Devin attempt.
	const dialog = page.getByRole('dialog').filter({ hasText: 'Do you want Signal-C Dev to open the external website?' });
	const role = await page.getByRole('switch', { name: 'IDE mode', exact: true, includeHidden: true }).getAttribute('aria-checked') === 'true' ? 'ide' : 'agents';
	const next = await Promise.race([
		dialog.waitFor().then(() => 'confirm'),
		manual ? page.locator('.quick-input-widget input[type="password"]').waitFor().then(() => 'continue') : snapshot(role, value => !value.pending).then(() => 'continue'),
	]);
	if (next === 'confirm') {
		assert.ok((await dialog.innerText()).includes('https://app.devin.ai/auth/cli/continue'));
		await dialog.getByRole('button', { name: 'Open', exact: true }).click();
	}
}
async function signIn(page: Page, manual: boolean): Promise<void> {
	await beginSignIn(page, manual);
	if (manual) {
		const input = page.locator('.quick-input-widget input[type="password"]');
		await input.fill('native-fixture-code');
		await input.press('Enter');
	}
}
const deadline = setTimeout(() => { void app?.close().catch(() => {}); }, 180000);
try {
	app = await _electron.launch({
		executablePath: createLaunchOptions(root, root, true, {}).executable,
		args: [root, '--agents', '--hidden-window', '--extensionTestsPath', runner,
			'--user-data-dir', profile, '--shared-data-dir', join(run, 'shared'), '--extensions-dir', extensions,
			'--agent-codex-home', env.CODEX_HOME, '--agent-claude-config-dir', env.CLAUDE_CONFIG_DIR,
			'--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--disable-experiments', '--disable-updates',
			'--disable-extension=agent-workspace.devin-subscription', '--disable-extension=vscode.vscode-api-tests',
			'--disable-extension=vscode.github-authentication', '--disable-extension=vscode.microsoft-authentication', '--disable-extension=GitHub.copilot-chat',
			...await allocateInspectorArgs()],
		env, timeout: 60000,
	});
	assert.deepEqual(await app.evaluate(({ app, safeStorage }) => ({ profile: app.getPath('userData'), encryption: safeStorage.isEncryptionAvailable() })), { profile, encryption: true });
	// Stub only the final OS browser launch, preserving env.openExternal, RPC and URI formatting.
	await app.evaluate(({ shell }) => {
		const observations: { manual: boolean; callbackStatus: number }[] = [];
		Object.defineProperty(globalThis, '__signalCNativeBrowser', { value: observations });
		const intercept: typeof shell.openExternal = async url => {
			const authorize = new URL(url);
			if (authorize.origin + authorize.pathname !== 'https://app.devin.ai/auth/cli/continue') { throw new Error('The fixture refuses unexpected external browser URLs'); }
			const redirect = authorize.searchParams.get('redirect_uri');
			const observation = { manual: !redirect, callbackStatus: 0 };
			observations.push(observation);
			if (redirect) {
				const callback = new URL(redirect);
				if (callback.hostname !== '127.0.0.1' || callback.pathname !== '/callback') { throw new Error('The fixture refuses non-loopback callbacks'); }
				callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
				callback.searchParams.set('code', 'native-fixture-code');
				// A browser launch returns before the user approves; do not hold the opener RPC open.
				void fetch(callback, { signal: AbortSignal.timeout(10000) }).then(response => { observation.callbackStatus = response.status; }, () => { observation.callbackStatus = -1; });
			}
		};
		shell.openExternal = intercept;
		if (shell.openExternal !== intercept) { throw new Error('The fixture could not intercept the OS browser launch'); }
	});
	const agents = await app.firstWindow();
	await agents.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor();
	assert.equal(await agents.getByRole('switch', { name: 'IDE mode', exact: true }).getAttribute('aria-checked'), 'false');
	await command(agents, 'claimAgents');
	await snapshot('agents', value => value.sessions.length === 0);
	const anonymous = agents.getByText('Continue Without Signing In', { exact: true });
	await anonymous.waitFor();
	await anonymous.click();
	await agents.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor();
	stage = 'opening IDE with the mode switch';
	const ideOpened = app.waitForEvent('window');
	await agents.getByRole('switch', { name: 'IDE mode', exact: true }).click();
	const ide = await ideOpened;
	await ide.getByRole('switch', { name: 'IDE mode', exact: true }).waitFor();
	assert.equal(await ide.getByRole('switch', { name: 'IDE mode', exact: true }).getAttribute('aria-checked'), 'true');
	await command(ide, 'claimIDE');
	await snapshot('ide', value => value.sessions.length === 0);
	stage = 'manual sign-in in Agents';
	await signIn(agents, true);
	const first = await snapshot('agents', value => value.result === 'signedIn' && !value.pending);
	assert.equal(first.sessions.length, 1);
	const mirrored = await snapshot('ide', value => value.events.length === 1 && value.sessions[0]?.id === first.sessions[0].id);
	assert.deepEqual(mirrored.events[0], { added: [first.sessions[0].id], removed: [], changed: [] });
	report.nativeSharedSignIn = true;
	stage = 'replacement sign-in in IDE';
	await signIn(ide, false);
	const replacement = await snapshot('ide', value => value.result === 'signedIn' && !value.pending);
	assert.notEqual(replacement.sessions[0].id, first.sessions[0].id);
	const replaced = await snapshot('agents', value => value.events.length === 2 && value.sessions[0]?.id === replacement.sessions[0].id);
	assert.deepEqual(replaced.events[1], { added: [replacement.sessions[0].id], removed: [first.sessions[0].id], changed: [] });
	report.nativeReplacement = true;
	assert.equal(replacement.exchanges, 1);
	assert.deepEqual(await app.evaluate(() => Reflect.get(globalThis, '__signalCNativeBrowser')), [{ manual: true, callbackStatus: 0 }, { manual: false, callbackStatus: 200 }]);
	report.automaticCallback = true;
	stage = 'sign-out while Agents waits for a code';
	await beginSignIn(agents, true);
	await agents.locator('.quick-input-widget input[type="password"]').waitFor();
	await command(ide, 'signOut');
	const cancelled = await snapshot('agents', value => value.result === 'cancelled' && !value.pending && value.sessions.length === 0);
	const signedOut = await snapshot('ide', value => value.sessions.length === 0 && value.events.length === 3);
	assert.equal(cancelled.events.length, 3);
	assert.deepEqual(cancelled.events[2], { added: [], removed: [replacement.sessions[0].id], changed: [] });
	assert.deepEqual(signedOut.events[2], cancelled.events[2]);
	await agents.locator('.quick-input-widget input[type="password"]').waitFor({ state: 'hidden' });
	report.nativeSharedSignOut = true;
	report.pendingCodeCancelled = true;
	report.windowsHidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()));
	assert.ok(report.windowsHidden);
	assert.equal(cancelled.exchanges, 1, 'The cancelled second code input must not exchange a token');
	console.log(JSON.stringify({ run, ...report }));
} catch (error) {
	await writeFile(join(run, 'failure.txt'), `${stage}\n${error instanceof Error ? error.stack : String(error)}`);
	if (app) {
		await writeFile(join(run, 'browser.json'), JSON.stringify(await app.evaluate(() => Reflect.get(globalThis, '__signalCNativeBrowser')).catch(() => [])));
		const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), hidden: !window.isVisible() }))).catch(() => []);
		await writeFile(join(run, 'windows.json'), JSON.stringify(windows));
		for (const [index, page] of app.windows().entries()) {
			await writeFile(join(run, `window-${index}.txt`), await page.locator('body').innerText({ timeout: 5000 }).catch(() => 'No renderer text'));
		}
	}
	throw error;
} finally {
	clearTimeout(deadline);
	await writeFile(join(run, 'report.json'), JSON.stringify({ stage, ...report }, null, 2));
	await app?.close();
}
