/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolve } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyAgentHomeArguments } from '../../node/agentHomeArguments.js';
import { OPTIONS, parseArgs } from '../../node/argv.js';

suite('Agent home launch arguments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('leaves ambient homes and unrelated environment values unchanged without overrides', () => {
		const environment = { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path' };
		applyAgentHomeArguments({}, environment, resolve('fixture'));
		assert.deepStrictEqual(environment, { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path' });
	});
	for (const [argument, variable] of [['agent-codex-home', 'CODEX_HOME'], ['agent-claude-config-dir', 'CLAUDE_CONFIG_DIR']] as const) {
		test(`resolves ${argument} once and restores only its selected environment value`, () => {
			const args = parseArgs([`--${argument}`, 'home with spaces'], OPTIONS);
			const environment = { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path' };
			const directory = resolve('fixture', 'home with spaces');
			applyAgentHomeArguments(args, environment, resolve('fixture'));
			applyAgentHomeArguments(args, environment, resolve('different-startup-directory'));
			assert.strictEqual(args[argument], directory);
			assert.deepStrictEqual(environment, { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude', PATH: 'keep-path', [variable]: directory });
		});
	}
	test('blank overrides keep existing homes and unrelated arguments unchanged', () => {
		const args = { 'agent-codex-home': '', 'agent-claude-config-dir': '', agents: true };
		const environment = { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude' };
		applyAgentHomeArguments(args, environment, resolve('fixture'));
		assert.deepStrictEqual({ args, environment }, { args: { 'agent-codex-home': '', 'agent-claude-config-dir': '', agents: true }, environment: { CODEX_HOME: 'ambient-codex', CLAUDE_CONFIG_DIR: 'ambient-claude' } });
	});
});
