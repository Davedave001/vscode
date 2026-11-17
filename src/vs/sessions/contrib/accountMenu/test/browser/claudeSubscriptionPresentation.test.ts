/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentModelCatalogStatusKey, type AgentModelCatalogStatus } from '../../../../../platform/agentHost/common/agentModelCatalogStatus.js';
import { agentSdkSetupStatusKey, type AgentSdkDownloadStatus } from '../../../../../platform/agentHost/common/agentSdkSetup.js';
import type { RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { getClaudeSubscriptionPresentation } from '../../browser/claudeSubscriptionPresentation.js';

suite('Claude subscription presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	function root(options: { catalog?: AgentModelCatalogStatus; download?: AgentSdkDownloadStatus; providers?: readonly string[]; registered?: boolean } = {}): RootState {
		return upcastPartial<RootState>({
			agents: options.registered === false ? [] : [{
				provider: 'claude', displayName: 'Claude', description: 'Test',
				models: (options.providers ?? []).map((provider, i) => ({ id: `${provider}/${i}`, name: `Model ${i}`, provider })),
			}],
			config: { schema: { type: 'object', properties: {} }, values: {
				...(options.catalog ? { [agentModelCatalogStatusKey('claude')]: options.catalog } : {}),
				...(options.download ? { [agentSdkSetupStatusKey('claude')]: { agent: 'claude', download: options.download } } : {}),
			} },
		});
	}

	const cases: { label: string; root: RootState | Error | undefined; description: string }[] = [
		{ label: 'host startup', root: undefined, description: 'Checking agent host' },
		{ label: 'host error', root: new Error('private diagnostic'), description: 'Agent host unavailable' },
		{ label: 'missing provider', root: root({ registered: false }), description: 'Native agent unavailable' },
		{ label: 'missing SDK', root: root({ download: 'notDownloaded', catalog: 'ready' }), description: 'Claude runtime setup needed' },
		{ label: 'deferred SDK', root: root({ download: 'downloadOnUse' }), description: 'Claude runtime setup needed' },
		{ label: 'SDK download', root: root({ download: 'downloading', catalog: 'pending' }), description: 'Preparing Claude runtime' },
		{ label: 'pending refresh with retained models', root: root({ catalog: 'pending', providers: ['anthropic'] }), description: 'Checking account and models' },
		{ label: 'failed refresh with retained models', root: root({ catalog: 'error', providers: ['anthropic'] }), description: 'Model refresh needs attention' },
		{ label: 'empty completed catalog', root: root({ catalog: 'ready', download: 'ready' }), description: 'No Anthropic models available' },
		{ label: 'Copilot-only catalog', root: root({ catalog: 'ready', providers: ['copilot'] }), description: 'No Anthropic models available' },
		{ label: 'native model beside Copilot rows', root: root({ catalog: 'ready', providers: ['copilot', 'anthropic', 'copilot'] }), description: '1 Anthropic model available' },
		{ label: 'multiple native models', root: root({ catalog: 'ready', providers: ['anthropic', 'anthropic'] }), description: '2 Anthropic models available' },
		{ label: 'older host with native models', root: root({ providers: ['anthropic'] }), description: '1 Anthropic model available' },
		{ label: 'older host with ready SDK and no native models', root: root({ download: 'ready', providers: ['copilot'] }), description: 'No Anthropic models available' },
		{ label: 'unreported setup', root: root(), description: 'Waiting for Claude setup' },
	];
	for (const entry of cases) {
		test(`describes ${entry.label} from published state`, () => {
			const result = getClaudeSubscriptionPresentation({ root: entry.root, enabled: true, policyDisabled: false, remote: false });
			assert.strictEqual(result.description, entry.description);
			assert.ok(result.detail.length > 0 && !result.detail.includes('private diagnostic'));
		});
	}

	for (const entry of [
		{ enabled: true, policyDisabled: true, remote: false, description: 'Disabled by organization' },
		{ enabled: true, policyDisabled: false, remote: true, description: 'Local window required' },
		{ enabled: false, policyDisabled: false, remote: false, description: 'Native agent disabled' },
	]) {
		test(`describes ${entry.description} before retained model readiness`, () => {
			assert.strictEqual(getClaudeSubscriptionPresentation({ ...entry, root: root({ catalog: 'ready', providers: ['anthropic'] }) }).description, entry.description);
		});
	}
});
