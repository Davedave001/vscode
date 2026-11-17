/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostCodexAgentEnabledSettingId } from '../../../../../platform/agentHost/common/agentService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { ICodexAccountService } from '../../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IDevinSubscriptionConnection } from '../../browser/devinSubscriptionConnection.js';
import { IFocusedSessionHostService, ISessionHost, ISessionHostService } from '../../../../../workbench/services/sessions/browser/sessionHost.js';
import { IChat, ISessionWorkspace } from '../../../../../workbench/services/sessions/common/session.js';
import { TestQuickInputService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { AgentSubscriptionsAction, CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING, connectCodexSubscription, openSubscriptionClient } from '../../browser/subscriptionActions.js';

suite('Agent Subscriptions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const cancelled of [false, true]) {
		test(cancelled ? 'cancels the provider picker without opening sign-in' : 'offers Devin Subscription separately from Devin CLI and starts browser authentication', async () => {
			const instantiation = store.add(new TestInstantiationService());
			const quickInput = new TestQuickInputService();
			const picker = sinon.stub(quickInput, 'pick').resolves(cancelled ? undefined : { id: 'devin-subscription', label: 'Devin Subscription' });
			const calls: unknown[] = [];
			instantiation.stub(IQuickInputService, quickInput);
			instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
			instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ connect: async () => { calls.push('connect-provider'); } }));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => { calls.push('connected'); } }));
			try {
				await instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
				const items = picker.firstCall.args[0];
				assert.ok(Array.isArray(items));
				assert.deepStrictEqual(items.map(item => item.label), ['Codex', 'Anthropic', 'Devin Subscription', 'Devin CLI']);
				assert.deepStrictEqual(calls, cancelled ? [] : ['connect-provider', 'connected']);
			} finally { picker.restore(); }
		});
	}

	for (const status of ['signedOut', 'signedIn'] as const) {
		test(`enables Codex before ${status === 'signedOut' ? 'starting official sign-in' : 'reusing the signed-in account'}`, async () => {
			const instantiation = store.add(new TestInstantiationService());
			const calls: unknown[] = [];
			instantiation.stub(IConfigurationService, upcastPartial<IConfigurationService>({
				inspect: () => ({}),
				updateValue: async (key, value, target?) => { calls.push([key, value, target]); },
			}));
			instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({
				account: { status, planType: 'plus' }, signIn: () => { calls.push('signIn'); },
			}));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => { calls.push('ready'); } }));
			await instantiation.invokeFunction(connectCodexSubscription);
			assert.deepStrictEqual(calls, [[AgentHostCodexAgentEnabledSettingId, true, ConfigurationTarget.USER], status === 'signedOut' ? 'signIn' : 'ready']);
		});
	}

	test('does not enable Codex or start sign-in when policy disables it', async () => {
		const instantiation = store.add(new TestInstantiationService());
		let notices = 0;
		const configuration = new TestConfigurationService();
		sinon.stub(configuration, 'inspect').returns({ policyValue: false });
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => { notices++; } }));
		await instantiation.invokeFunction(connectCodexSubscription);
		assert.strictEqual(notices, 1);
	});

	for (const provider of ['claude', 'devin'] as const) {
		for (const signIn of [false, true]) {
			test(`opens ${provider} ${signIn ? 'sign-in' : 'chat'} in the focused session folder without a shell command`, async () => {
				const instantiation = store.add(new TestInstantiationService());
				const cwd = URI.file('/workspace/project with spaces');
				const host = upcastPartial<ISessionHost>({
					session: constObservable(undefined),
					chat: constObservable(upcastPartial<IChat>({ workspace: constObservable(upcastPartial<ISessionWorkspace>({ folders: [upcastPartial<ISessionWorkspace['folders'][number]>({ workingDirectory: cwd })] })) })),
				});
				instantiation.stub(ISessionHostService, upcastPartial<ISessionHostService>({}));
				instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => host }));
				instantiation.stub(IConfigurationService, new TestConfigurationService({ [CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING]: '/clients/Claude Code/claude.exe' }));
				const terminal = upcastPartial<ITerminalInstance>({});
				const calls: unknown[] = [];
				instantiation.stub(ITerminalService, upcastPartial<ITerminalService>({
					createTerminal: async options => { calls.push(options); return terminal; },
					setActiveInstance: instance => { assert.strictEqual(instance, terminal); calls.push('activate'); },
					revealTerminal: async instance => { assert.strictEqual(instance, terminal); calls.push('reveal'); },
				}));
				await instantiation.invokeFunction(openSubscriptionClient, provider, signIn);
				assert.deepStrictEqual(calls, [{
					config: {
						name: provider === 'claude' ? 'Claude Code · Subscription' : 'Devin CLI', executable: provider === 'claude' ? '/clients/Claude Code/claude.exe' : 'devin', args: signIn ? ['auth', 'login'] : [], cwd,
						env: provider === 'claude' ? { ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null } : { WINDSURF_API_KEY: null }, waitOnExit: true,
					},
					location: TerminalLocation.Editor,
				}, 'activate', 'reveal']);
			});
		}
	}

	test('rejects a virtual workspace before starting a local client', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const host = upcastPartial<ISessionHost>({ session: constObservable(undefined), chat: constObservable(undefined) });
		instantiation.stub(ISessionHostService, upcastPartial<ISessionHostService>({}));
		instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => host }));
		instantiation.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders: [upcastPartial<IWorkspace['folders'][number]>({ uri: URI.parse('mock-fs://repository/project') })] }) }));
		let notices = 0;
		instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => { notices++; } }));
		await instantiation.invokeFunction(openSubscriptionClient, 'devin', false);
		assert.strictEqual(notices, 1);
	});
});
