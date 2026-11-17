/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { delimiter, resolve } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyAgentEnvironmentArguments } from '../../node/agentEnvironmentArguments.js';
import { OPTIONS, parseArgs } from '../../node/argv.js';

suite('Agent environment launch arguments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('leaves ambient homes and unrelated environment values unchanged without overrides', () => {
		const environment = { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path' };
		applyAgentEnvironmentArguments({}, environment, resolve('fixture'));
		assert.deepStrictEqual(environment, { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path' });
	});
	for (const [argument, variable] of [['agent-codex-home', 'CODEX_HOME'], ['agent-claude-config-dir', 'CLAUDE_CONFIG_DIR']] as const) {
		test(`resolves ${argument} once and restores only its selected environment value`, () => {
			const args = parseArgs([`--${argument}`, 'home with spaces'], OPTIONS);
			const environment = { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path' };
			const directory = resolve('fixture', 'home with spaces');
			applyAgentEnvironmentArguments(args, environment, resolve('fixture'));
			applyAgentEnvironmentArguments(args, environment, resolve('different-startup-directory'));
			assert.strictEqual(args[argument], directory);
			assert.deepStrictEqual(environment, { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path', [variable]: directory });
		});
	}
	test('blank overrides keep existing homes and unrelated arguments unchanged', () => {
		const args = { 'agent-codex-home': '', 'agent-claude-config-dir': '', agents: true };
		const environment = { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude' };
		applyAgentEnvironmentArguments(args, environment, resolve('fixture'));
		assert.deepStrictEqual({ args, environment }, { args: { 'agent-codex-home': '', 'agent-claude-config-dir': '', agents: true }, environment: { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude' } });
	});
	test('restores a relative CLI fallback after ambient clients and normalizes it only once', () => {
		const args = parseArgs(['--agent-cli-fallback-dir', 'cli with spaces'], OPTIONS);
		const environment = { PATH: 'existing-client', OTHER: 'keep' };
		const directory = resolve('fixture', 'cli with spaces');
		applyAgentEnvironmentArguments(args, environment, resolve('fixture'));
		applyAgentEnvironmentArguments(args, environment, resolve('another-directory'));
		assert.deepStrictEqual({ args: args['agent-cli-fallback-dir'], environment }, { args: directory, environment: { PATH: `existing-client${delimiter}${directory}`, OTHER: 'keep' } });
	});
	test('forwards the fallback in a separate instance patch without changing the parent environment', () => {
		const directory = resolve('fixture-cli');
		const inherited = { [isWindows ? 'Path' : 'PATH']: 'existing-client', PRIVATE: 'not-forwarded' };
		const environment = {};
		applyAgentEnvironmentArguments({ 'agent-cli-fallback-dir': directory }, environment, resolve('.'), inherited);
		assert.deepStrictEqual({ inherited, environment }, { inherited: { [isWindows ? 'Path' : 'PATH']: 'existing-client', PRIVATE: 'not-forwarded' }, environment: { [isWindows ? 'Path' : 'PATH']: `existing-client${delimiter}${directory}` } });
	});
	for (const ambient of [undefined, '', resolve('fixture-cli'), ...(isWindows ? [resolve('fixture-cli').toUpperCase()] : [])]) {
		test(`handles ${ambient === undefined ? 'absent' : ambient === '' ? 'empty' : 'existing'} PATH without duplicate fallback entries`, () => {
			const directory = resolve('fixture-cli');
			const environment: { PATH?: string } = { PATH: ambient };
			applyAgentEnvironmentArguments({ 'agent-cli-fallback-dir': directory }, environment, resolve('.'));
			assert.deepStrictEqual(environment, { PATH: ambient || directory });
		});
	}
});
