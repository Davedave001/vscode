/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { spawn } = require('child_process') as typeof import('child_process');
const minimist = require('minimist') as typeof import('minimist');

function createLaunchOptions(repoRoot: string, workspace: string, ide: boolean, inheritedEnvironment: NodeJS.ProcessEnv) {
	const buildRoot = path.join(repoRoot, '.build');
	const profile = path.join(buildRoot, 'agent-workspace-profile');
	const codexHome = path.join(buildRoot, 'agent-workspace-codex');
	const claudeHome = path.join(buildRoot, 'agent-workspace-claude');
	const environment = { ...inheritedEnvironment };
	// Editor-injected IPC and SDK overrides belong to the launching editor. Keep
	// this development fork on its own runtime, storage, and agent configuration.
	for (const name of Object.keys(environment)) {
		if (/^(?:VSCODE_|ELECTRON_RUN_AS_NODE$|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/i.test(name)) {
			delete environment[name];
		}
	}
	Object.assign(environment, {
		NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1',
		CODEX_HOME: codexHome,
		CLAUDE_CONFIG_DIR: claudeHome,
	});
	return {
		executable: path.join(buildRoot, 'electron', 'Code - OSS.exe'),
		args: [repoRoot, ...(ide ? [] : ['--agents']), workspace,
			'--user-data-dir', profile,
			'--shared-data-dir', path.join(buildRoot, 'agent-workspace-shared'),
			'--extensions-dir', path.join(buildRoot, 'agent-workspace-extensions'),
			'--disable-extension=vscode.vscode-api-tests'],
		profile,
		agentHomes: [codexHome, claudeHome],
		environment,
	};
}

function main() {
	const args = minimist(process.argv.slice(2), { boolean: ['help', 'ide', 'dry-run'], string: ['workspace'] });
	if (args.help) {
		console.log('node scripts/code-agent-workspace.ts [--ide] [--workspace <folder>] [--dry-run]\nLaunch the Windows development fork with separate editor, shared-storage, extension, and agent profiles.');
		return;
	}
	if (process.platform !== 'win32') {
		throw new Error('This development launcher currently supports Windows.');
	}
	const unknown = Object.keys(args).filter(key => !['_', 'help', 'ide', 'dry-run', 'workspace'].includes(key));
	if (unknown.length || args._.length) {
		throw new Error('Use --workspace <folder> to select a workspace; additional editor arguments are not forwarded.');
	}
	const repoRoot = path.resolve(__dirname, '..');
	const workspace = path.resolve(args.workspace ?? repoRoot);
	if (!fs.statSync(workspace).isDirectory()) {
		throw new Error('The workspace must be an existing directory.');
	}
	const options = createLaunchOptions(repoRoot, workspace, args.ide, process.env);
	if (args['dry-run']) {
		console.log(JSON.stringify({ executable: options.executable, args: options.args }, null, 2));
		return;
	}
	if (!fs.existsSync(options.executable)) {
		throw new Error('The development Electron runtime is missing. Prepare the native build before launching.');
	}
	for (const directory of [options.profile, ...options.agentHomes]) {
		fs.mkdirSync(directory, { recursive: true });
	}
	// Seed only a new isolated profile. Later user choices are preserved.
	const settings = path.join(options.profile, 'User', 'settings.json');
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	try {
		fs.writeFileSync(settings, JSON.stringify({
			'chat.agentHost.codexAgent.enabled': false,
			'chat.agentHost.claudeAgent.enabled': false,
		}, null, '\t') + '\n', { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
	}
	const child = spawn(options.executable, options.args, { cwd: repoRoot, env: options.environment, detached: true, stdio: 'ignore' });
	child.on('error', error => { console.error(error.message); process.exitCode = 1; });
	child.on('spawn', () => { console.log(`Opened ${args.ide ? 'IDE' : 'Agents'} development window (PID ${child.pid}).`); child.unref(); });
}

module.exports = { createLaunchOptions };
if (require.main === module) {
	try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
