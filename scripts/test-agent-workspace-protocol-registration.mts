/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { _electron, type ElectronApplication } from 'playwright';

assert.equal(process.platform, 'win32', 'This check exercises Windows protocol registration');
const require = createRequire(import.meta.url);
const { createLaunchOptions } = require('./code-agent-workspace.ts') as { createLaunchOptions(root: string, workspace: string, ide: boolean, env: NodeJS.ProcessEnv): { executable: string } };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.build', 'agent-workspace-protocol-registration', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const home = join(run, 'home');
const probeDirectory = join(run, 'arguments with spaces & # 100%');
const profile = join(probeDirectory, 'profile') + '\\';
const extensions = join(probeDirectory, 'extensions');
const shared = join(probeDirectory, 'shared') + '\\';
const codexHome = join(probeDirectory, 'codex home');
const claudeHome = join(probeDirectory, 'claude home');
const cliFallback = join(probeDirectory, 'cli fallback') + '\\';
const controlProfile = join(run, 'control-profile');
for (const folder of [home, probeDirectory, profile, extensions, shared, controlProfile]) { await mkdir(folder, { recursive: true }); }
const controlMain = join(run, 'control.cjs');
const probeMain = join(probeDirectory, 'argv-probe.cjs');
const probeOutput = join(probeDirectory, 'argv.json');
await writeFile(controlMain, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(controlProfile)});
app.whenReady().then(async () => { const window = new BrowserWindow({ show: false }); await window.loadURL('data:text/html,Protocol%20argument%20fixture'); });
`);
await writeFile(probeMain, `const { app } = require('electron');
require('node:fs').writeFileSync(${JSON.stringify(probeOutput)}, JSON.stringify(process.argv.slice(1)));
// This probe only records parsed arguments; no Chromium window or shutdown state is needed.
app.exit(0);
`);
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
for (const key of Object.keys(env)) {
	if (/^(?:VSCODE_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|CODEX|CLAUDE|COPILOT|DEVIN|WINDSURF|GITHUB|GH_|OPENAI|ANTHROPIC)/i.test(key)) { delete env[key]; }
}
Object.assign(env, { USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') });
const execute = promisify(execFile);
async function registryEntry(protocol: string, commandOnly = true): Promise<string | undefined> {
	assert.match(protocol, /^[a-z][a-z0-9-]+$/);
	try {
		const { stdout } = await execute('reg.exe', ['query', `HKCU\\Software\\Classes\\${protocol}${commandOnly ? '\\shell\\open\\command' : ''}`, ...(commandOnly ? ['/ve'] : [])], { windowsHide: true, timeout: 10000 });
		return commandOnly ? stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1] : stdout;
	} catch (error) {
		if ((error as { code?: string | number }).code === 1) { return undefined; }
		throw error;
	}
}
type ProtocolEnvironment = { isBuilt: boolean; appRoot: string; userDataPath: string; extensionsPath: string; appSharedDataHome: { fsPath: string }; args: { _: string[]; 'user-data-dir': string; 'extensions-dir': string; 'shared-data-dir': string; 'agent-codex-home': string; 'agent-claude-config-dir': string; 'agent-cli-fallback-dir': string } };
// Load compiled code without importing the workbench's ambient type environment into this standalone script.
const { getWindowsProtocolHandlerArguments } = await import(pathToFileURL(join(root, 'out/vs/platform/url/node/protocolHandlerArguments.js')).href) as { getWindowsProtocolHandlerArguments(environment: ProtocolEnvironment): string[] };
const { URI } = await import(pathToFileURL(join(root, 'out/vs/base/common/uri.js')).href) as { URI: { file(path: string): { fsPath: string } } };
const args = getWindowsProtocolHandlerArguments({ isBuilt: false, appRoot: probeMain, userDataPath: profile, extensionsPath: extensions, appSharedDataHome: URI.file(shared), args: { _: [], 'user-data-dir': 'relative-profile', 'extensions-dir': 'relative-extensions', 'shared-data-dir': 'relative-shared', 'agent-codex-home': codexHome, 'agent-claude-config-dir': claudeHome, 'agent-cli-fallback-dir': cliFallback } });
assert.equal(args[args.indexOf('--agent-codex-home') + 1], codexHome);
assert.equal(args[args.indexOf('--agent-claude-config-dir') + 1], claudeHome);
assert.equal(args[args.indexOf('--agent-cli-fallback-dir') + 1], cliFallback);
const protocol = `signal-c-argument-check-${process.pid}-${randomUUID()}`;
assert.equal(await registryEntry(protocol, false), undefined, 'The test protocol must not already exist');
const originalSignalCCommand = await registryEntry('signal-c');
const executable = createLaunchOptions(root, root, true, {}).executable;
let control: ElectronApplication | undefined;
let registered = false;
let registeredCommand: string | undefined;
const report = { argumentsVerified: false, hiddenControlWindow: false, testProtocolRemoved: false, registryCleanupRequired: false, signalCProtocolUnchanged: false };
try {
	control = await _electron.launch({ executablePath: executable, args: [controlMain, '--user-data-dir', controlProfile], env, timeout: 30000 });
	await control.firstWindow();
	report.hiddenControlWindow = await control.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()));
	assert.ok(report.hiddenControlWindow);
	registered = await control.evaluate(({ app }, options) => app.setAsDefaultProtocolClient(options.protocol, options.executable, options.args), { protocol, executable, args });
	assert.ok(registered, 'The fixture protocol registration must succeed');
	const command = await registryEntry(protocol);
	assert.ok(command);
	registeredCommand = command;
	const prefix = command.startsWith(`"${executable}" `) ? `"${executable}" ` : `${executable} `;
	assert.ok(command.startsWith(prefix), 'The registered command must use the fixture runtime');
	const suffix = command.slice(prefix.length);
	assert.ok(suffix.endsWith('"%1"'));
	const uri = `${protocol}://editor-window/open?session=test%3A%2Fone&example=100%25#fragment`;
	const nativeArguments = suffix.replace(/"%1"$/, () => `"${uri}"`);
	// No shell: preserve both the registry's quoted executable token and its argument string.
	// execFile does not forward argv0, so spawn is necessary when verbatim arguments are used.
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, [nativeArguments], { argv0: prefix.trimEnd(), env, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
		const timer = setTimeout(() => { child.kill(); reject(new Error('The fixture argument probe timed out')); }, 20000);
		child.once('error', error => { clearTimeout(timer); reject(error); });
		child.once('close', code => { clearTimeout(timer); if (code === 0) { resolve(); } else { reject(new Error(`The fixture argument probe exited with code ${code}`)); } });
	});
	assert.deepEqual(JSON.parse(await readFile(probeOutput, 'utf8')), [...args, uri]);
	report.argumentsVerified = true;
} finally {
	try {
		if (registered && control) {
			assert.ok(await control.evaluate(({ app }, options) => app.removeAsDefaultProtocolClient(options.protocol, options.executable, options.args), { protocol, executable, args }));
			if (await registryEntry(protocol, false) !== undefined) {
				// Chromium's string registry reader is limited to 1024 characters. Electron can
				// return true without removing a longer command; delete only this verified fixture.
				assert.ok(registeredCommand);
				assert.equal(await registryEntry(protocol), registeredCommand, 'Never delete a fixture key whose owner changed');
				assert.match(protocol, /^signal-c-argument-check-\d+-[0-9a-f-]+$/);
				await execute('reg.exe', ['delete', `HKCU\\Software\\Classes\\${protocol}`, '/f'], { windowsHide: true, timeout: 10000 });
				report.registryCleanupRequired = true;
			}
			report.testProtocolRemoved = await registryEntry(protocol, false) === undefined;
			assert.ok(report.testProtocolRemoved, 'The fixture protocol registry key must be removed');
		}
		report.signalCProtocolUnchanged = await registryEntry('signal-c') === originalSignalCCommand;
		assert.ok(report.signalCProtocolUnchanged, 'The real Signal-C protocol command must remain unchanged');
	} finally {
		try { await control?.close(); } finally {
			await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2));
			console.log(`Artifacts: ${run}`);
		}
	}
}
console.log('Verified registered Windows arguments, isolated storage paths, and fixture cleanup');
