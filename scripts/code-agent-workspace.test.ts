/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createLaunchOptions } = require('./code-agent-workspace.ts');

test('isolates editor IPC and agent homes without mutating the launching environment', () => {
	const inherited = { PATH: 'keep-path', SystemRoot: 'keep-system-root', VSCODE_IPC_HOOK_CLI: 'other-editor', vscode_portable: 'other-profile', ELECTRON_RUN_AS_NODE: '1', codex_home: 'other-codex', claude_config_dir: 'other-claude' };
	const original = { ...inherited };
	const root = path.resolve('fork with spaces');
	const launch = createLaunchOptions(root, root, false, inherited);
	assert.deepStrictEqual(inherited, original);
	assert.strictEqual(launch.environment.PATH, inherited.PATH);
	assert.strictEqual(launch.environment.SystemRoot, inherited.SystemRoot);
	assert.strictEqual(launch.environment.CODEX_HOME, path.join(root, '.build', 'agent-workspace-codex'));
	assert.strictEqual(launch.environment.CLAUDE_CONFIG_DIR, path.join(root, '.build', 'agent-workspace-claude'));
	assert.strictEqual(launch.environment.VSCODE_IPC_HOOK_CLI, undefined);
	assert.strictEqual(launch.environment.vscode_portable, undefined);
	assert.strictEqual(launch.environment.ELECTRON_RUN_AS_NODE, undefined);
	assert.strictEqual(launch.environment.codex_home, undefined);
	assert.strictEqual(launch.environment.claude_config_dir, undefined);
});

test('keeps workspace arguments separate from the three isolated editor storage paths in both modes', () => {
	const root = path.resolve('fork with spaces');
	const workspace = path.resolve('project with spaces');
	for (const ide of [false, true]) {
		const launch = createLaunchOptions(root, workspace, ide, {});
		assert.strictEqual(launch.args.includes('--agents'), !ide);
		assert.ok(launch.args.includes(workspace));
		for (const [flag, directory] of [['--user-data-dir', 'agent-workspace-profile'], ['--shared-data-dir', 'agent-workspace-shared'], ['--extensions-dir', 'agent-workspace-extensions']]) {
			assert.strictEqual(launch.args[launch.args.indexOf(flag) + 1], path.join(root, '.build', directory));
		}
	}
});

test('dry-run accepts a workspace with spaces without launching an editor or creating a profile', { skip: process.platform !== 'win32' }, () => {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-launch-'));
	const workspace = path.join(temporary, 'Project with spaces');
	fs.mkdirSync(workspace);
	try {
		const result = spawnSync(process.execPath, [path.join(__dirname, 'code-agent-workspace.ts'), '--dry-run', '--ide', '--workspace', workspace], { encoding: 'utf8' });
		assert.strictEqual(result.status, 0, result.stderr);
		const launch = JSON.parse(result.stdout);
		assert.ok(launch.args.includes(workspace));
		assert.strictEqual(launch.args.includes('--agents'), false);
		assert.deepStrictEqual(fs.readdirSync(temporary), ['Project with spaces']);
	} finally {
		fs.rmdirSync(workspace);
		fs.rmdirSync(temporary);
	}
});
