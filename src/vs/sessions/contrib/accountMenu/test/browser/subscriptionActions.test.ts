/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostClaudeAgentEnabledSettingId, AgentHostCodexAgentEnabledSettingId, IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { agentModelCatalogStatusKey } from '../../../../../platform/agentHost/common/agentModelCatalogStatus.js';
import { RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationHandle, INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITerminalBackend, ITerminalLaunchError, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { ICodexAccountService } from '../../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IAgentSdkSetupService } from '../../../../../workbench/services/agentHost/browser/agentSdkSetupService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { DevinSubscriptionStatus, IDevinSubscriptionConnection } from '../../browser/devinSubscriptionConnection.js';
import { IReachSubscriptionConnection } from '../../browser/reachSubscriptionConnection.js';
import { IFocusedSessionHostService, ISessionHost, ISessionHostService } from '../../../../../workbench/services/sessions/browser/sessionHost.js';
import { IChat, ISessionWorkspace } from '../../../../../workbench/services/sessions/common/session.js';
import { TestPathService, TestQuickInputService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { AgentSubscriptionsAction, CLAUDE_SUBSCRIPTION_EXECUTABLE_SETTING, connectCodexSubscription, enableClaudeAgent, openSubscriptionClient } from '../../browser/subscriptionActions.js';

suite('Agent Subscriptions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function nativeClaudeFixture(state: 'registered' | 'missing' | 'failed' = 'registered', remoteAuthority?: string) {
		const instantiation = store.add(new TestInstantiationService());
		const values = new TestConfigurationService({ [AgentHostClaudeAgentEnabledSettingId]: false });
		const configuration: IConfigurationService = values;
		const updates = sinon.stub(configuration, 'updateValue').callsFake(async (key, value) => { await values.setUserConfiguration(key, value); });
		const reloads: string[] = [];
		const notices: string[] = [];
		let restartChoice: IPromptChoice | undefined;
		let restarts = 0;
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(IReachSubscriptionConnection, upcastPartial<IReachSubscriptionConnection>({ getAccount: async () => undefined }));
		instantiation.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority }));
		instantiation.stub(IHostService, upcastPartial<IHostService>({ restart: async () => { restarts++; } }));
		instantiation.stub(IAgentSdkSetupService, upcastPartial<IAgentSdkSetupService>({ setups: state === 'registered' ? [{ agent: 'claude', download: 'ready' }] : [], requestReload: agent => { reloads.push(agent); } }));
		instantiation.stub(IAgentHostService, upcastPartial<IAgentHostService>({
			rootState: upcastPartial<IAgentHostService['rootState']>({ value: state === 'failed' ? new Error('Unavailable') : upcastPartial<RootState>({ agents: state === 'registered' ? [{ provider: 'claude', displayName: 'Claude', description: 'Test', models: [] }] : [] }) }),
		}));
		instantiation.stub(INotificationService, upcastPartial<INotificationService>({
			info: message => { notices.push(String(message)); },
			prompt: (_severity, message, choices) => { notices.push(String(message)); restartChoice = choices[0]; return upcastPartial<INotificationHandle>({}); },
		}));
		return { instantiation, configuration, values, updates, reloads, notices, get restarts() { return restarts; }, get restartChoice() { return restartChoice; } };
	}

	test('enables an already registered native Claude provider and requests account/model refresh without restarting', async () => {
		const f = nativeClaudeFixture();
		await f.instantiation.invokeFunction(enableClaudeAgent);
		assert.deepStrictEqual(f.updates.firstCall.args, [AgentHostClaudeAgentEnabledSettingId, true, ConfigurationTarget.USER]);
		assert.deepStrictEqual({ reloads: f.reloads, restarts: f.restarts, restartOffered: !!f.restartChoice }, { reloads: ['claude'], restarts: 0, restartOffered: false });
		assert.match(f.notices[0], /being checked/);
		assert.ok(!f.notices[0].includes('models ready'));
	});

	for (const state of ['missing', 'failed'] as const) {
		test(`offers an explicit restart for a ${state} native Claude provider without interrupting running turns automatically`, async () => {
			const f = nativeClaudeFixture(state);
			await f.instantiation.invokeFunction(enableClaudeAgent);
			assert.deepStrictEqual({ reloads: f.reloads, restarts: f.restarts, enabled: f.configuration.getValue(AgentHostClaudeAgentEnabledSettingId) }, { reloads: [], restarts: 0, enabled: true });
			assert.ok(f.restartChoice);
			assert.match(f.notices[0], /Restart Signal-C.*Running agent turns will be interrupted/);
			assert.strictEqual(f.restartChoice.label, 'Restart Signal-C');
			await f.restartChoice.run();
			assert.deepStrictEqual({ reloads: f.reloads, restarts: f.restarts }, { reloads: [], restarts: 1 });
		});
	}

	test('does not enable native Claude when policy disables it or the window belongs to a remote host', async () => {
		for (const policyDisabled of [true, false]) {
			const f = nativeClaudeFixture('registered', policyDisabled ? undefined : 'ssh-remote+example');
			if (policyDisabled) { sinon.stub(f.configuration, 'inspect').returns({ policyValue: false }); }
			await f.instantiation.invokeFunction(enableClaudeAgent);
			assert.deepStrictEqual({ updates: f.updates.callCount, reloads: f.reloads, restarts: f.restarts, restartOffered: !!f.restartChoice }, { updates: 0, reloads: [], restarts: 0, restartOffered: false });
		}
	});

	test('does not run a stale restart choice after Claude is disabled again', async () => {
		const f = nativeClaudeFixture('missing');
		await f.instantiation.invokeFunction(enableClaudeAgent);
		await f.values.setUserConfiguration(AgentHostClaudeAgentEnabledSettingId, false);
		assert.ok(f.restartChoice);
		await f.restartChoice.run();
		assert.deepStrictEqual({ reloads: f.reloads, restarts: f.restarts }, { reloads: [], restarts: 0 });
	});

	for (const managed of [false, true]) {
		test(`reuses enabled Claude preferences without writing a redundant user override (managed=${managed})`, async () => {
			const f = nativeClaudeFixture();
			await f.values.setUserConfiguration(AgentHostClaudeAgentEnabledSettingId, true);
			if (managed) { sinon.stub(f.configuration, 'inspect').returns({ policyValue: true }); }
			await f.instantiation.invokeFunction(enableClaudeAgent);
			assert.deepStrictEqual({ updates: f.updates.callCount, reloads: f.reloads, restarts: f.restarts }, { updates: 0, reloads: ['claude'], restarts: 0 });
		});
	}

	for (const policyChanged of [false, true]) {
		test(`does not refresh or offer restart when enablement changes while settings are being saved (policy=${policyChanged})`, async () => {
			const f = nativeClaudeFixture('missing');
			f.updates.callsFake(async () => {
				if (policyChanged) { sinon.stub(f.configuration, 'inspect').returns({ policyValue: false }); }
				else { await f.values.setUserConfiguration(AgentHostClaudeAgentEnabledSettingId, false); }
			});
			await f.instantiation.invokeFunction(enableClaudeAgent);
			assert.deepStrictEqual({ reloads: f.reloads, restarts: f.restarts, restartOffered: !!f.restartChoice }, { reloads: [], restarts: 0, restartOffered: false });
			assert.match(f.notices[0], /current settings/);
		});
	}

	test('does not refresh Claude or offer restart after a failed preference write', async () => {
		const f = nativeClaudeFixture('missing');
		f.updates.rejects(new Error('Preference write failed'));
		await assert.rejects(f.instantiation.invokeFunction(enableClaudeAgent), /Preference write failed/);
		assert.deepStrictEqual({ reloads: f.reloads, restarts: f.restarts, restartOffered: !!f.restartChoice }, { reloads: [], restarts: 0, restartOffered: false });
	});

	test('offers the native Claude action alongside official CLI sign-in and opening', async () => {
		const f = nativeClaudeFixture();
		const quickInput = new TestQuickInputService();
		const picker = sinon.stub(quickInput, 'pick');
		picker.onFirstCall().resolves({ id: 'claude', label: 'Anthropic' });
		picker.onSecondCall().resolves({ id: 'native', label: 'Use in Agent Workspace' });
		f.instantiation.stub(IQuickInputService, quickInput);
		f.instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
		f.instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ status: constObservable({ kind: 'signedOut' }) }));
		try {
			await f.instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
			const items = picker.secondCall.args[0];
			assert.ok(Array.isArray(items));
			assert.deepStrictEqual(items.map(item => item.type === 'separator' ? 'separator' : item.label), ['Use in Agent Workspace', 'Open Claude Code', 'Sign in']);
			assert.deepStrictEqual(f.reloads, ['claude']);
		} finally { picker.restore(); }
	});

	test('reopening subscriptions reads current Claude catalog state without counting Copilot models or changing setup', async () => {
		const f = nativeClaudeFixture();
		await f.values.setUserConfiguration(AgentHostClaudeAgentEnabledSettingId, true);
		const quickInput = new TestQuickInputService();
		const picker = sinon.stub(quickInput, 'pick').resolves(undefined);
		f.instantiation.stub(IQuickInputService, quickInput);
		f.instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
		f.instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ status: constObservable({ kind: 'signedOut' }) }));
		try {
			const descriptions: (string | undefined)[] = [];
			for (const catalog of ['ready', 'pending', 'error'] as const) {
				const root = upcastPartial<RootState>({
					agents: [{ provider: 'claude', displayName: 'Claude', description: 'Test', models: [
						{ id: 'anthropic/test', name: 'Native', provider: 'anthropic' }, { id: 'copilot/test', name: 'Copilot', provider: 'copilot' },
					] }],
					config: { schema: { type: 'object', properties: {} }, values: { [agentModelCatalogStatusKey('claude')]: catalog } },
				});
				f.instantiation.stub(IAgentHostService, upcastPartial<IAgentHostService>({ rootState: upcastPartial<IAgentHostService['rootState']>({ value: root }) }));
				await f.instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
				const items = picker.lastCall.args[0];
				assert.ok(Array.isArray(items));
				descriptions.push(items.find(item => item.label === 'Anthropic')?.description);
			}
			assert.deepStrictEqual({ descriptions, writes: f.updates.callCount, reloads: f.reloads, restarts: f.restarts }, {
				descriptions: ['1 Anthropic model available', 'Checking account and models', 'Model refresh needs attention'], writes: 0, reloads: [], restarts: 0,
			});
		} finally { picker.restore(); }
	});

	for (const outcome of ['success', 'failure', 'unknownExit', 'launchError', 'closed', 'alreadyExited', 'alreadyDisposed', 'notRegistered', 'initiallyDisabled', 'disabledDuringLogin', 'policyDuringLogin'] as const) {
		test(`refreshes Claude models only after a successful official sign-in (${outcome})`, async () => {
			const f = nativeClaudeFixture(outcome === 'notRegistered' || outcome === 'initiallyDisabled' ? 'missing' : 'registered');
			if (outcome !== 'initiallyDisabled') { await f.values.setUserConfiguration(AgentHostClaudeAgentEnabledSettingId, true); }
			const exited = store.add(new Emitter<number | ITerminalLaunchError | undefined>());
			const disposed = store.add(new Emitter<ITerminalInstance>());
			const terminal = upcastPartial<ITerminalInstance>({ onExit: exited.event, onDisposed: disposed.event, isDisposed: outcome === 'alreadyDisposed', exitCode: outcome === 'alreadyExited' ? 0 : undefined });
			const cwd = URI.file('/workspace/login');
			const host = upcastPartial<ISessionHost>({ session: constObservable(undefined), chat: constObservable(upcastPartial<IChat>({ workspace: constObservable(upcastPartial<ISessionWorkspace>({ folders: [upcastPartial<ISessionWorkspace['folders'][number]>({ workingDirectory: cwd })] })) })) });
			f.instantiation.stub(ISessionHostService, upcastPartial<ISessionHostService>({}));
			f.instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => host }));
			f.instantiation.stub(ITerminalService, upcastPartial<ITerminalService>({ createTerminal: async () => terminal, setActiveInstance: () => { }, revealTerminal: async () => { } }));
			await f.instantiation.invokeFunction(openSubscriptionClient, 'claude', true);
			if (outcome === 'disabledDuringLogin') { await f.values.setUserConfiguration(AgentHostClaudeAgentEnabledSettingId, false); }
			if (outcome === 'policyDuringLogin') { sinon.stub(f.configuration, 'inspect').returns({ policyValue: false }); }
			if (outcome === 'closed') { disposed.fire(terminal); }
			exited.fire(outcome === 'failure' ? 1 : outcome === 'unknownExit' ? undefined : outcome === 'launchError' ? upcastPartial<ITerminalLaunchError>({ message: 'Simulated launch failure' }) : 0);
			exited.fire(0);
			await timeout(0);
			assert.deepStrictEqual(f.reloads, outcome === 'success' || outcome === 'alreadyExited' ? ['claude'] : []);
			assert.strictEqual(f.restarts, 0);
			assert.strictEqual(f.updates.callCount, outcome === 'initiallyDisabled' ? 1 : 0);
			assert.strictEqual(!!f.restartChoice, outcome === 'notRegistered' || outcome === 'initiallyDisabled');
		});
	}

	for (const cancelled of [false, true]) {
		test(cancelled ? 'cancels the provider picker without opening sign-in' : 'offers Devin Subscription separately from Devin CLI and starts browser authentication', async () => {
			const { instantiation } = nativeClaudeFixture();
			const quickInput = new TestQuickInputService();
			const picker = sinon.stub(quickInput, 'pick').resolves(cancelled ? undefined : { id: 'devin-subscription', label: 'Devin Subscription' });
			const calls: unknown[] = [];
			instantiation.stub(IQuickInputService, quickInput);
			instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
			instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ status: constObservable({ kind: 'signedOut' }), connect: async () => { calls.push('connect-provider'); } }));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => { calls.push('connected'); } }));
			try {
				await instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
				const items = picker.firstCall.args[0];
				assert.ok(Array.isArray(items));
				assert.deepStrictEqual(items.map(item => item.label), ['Codex', 'Anthropic', 'Devin Subscription', 'Devin CLI', 'REACH Subscription']);
				assert.deepStrictEqual(calls, cancelled ? [] : ['connect-provider', 'connected']);
			} finally { picker.restore(); }
		});
	}

	test('opens REACH browser sign-in from the subscriptions picker', async () => {
		const { instantiation, notices } = nativeClaudeFixture();
		const quickInput = new TestQuickInputService();
		const picker = sinon.stub(quickInput, 'pick').resolves({ id: 'reach', label: 'REACH Subscription' });
		const signIn = sinon.stub().resolves({ id: 'reach-account', subscriptionActive: true });
		instantiation.stub(IQuickInputService, quickInput);
		instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
		instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ status: constObservable({ kind: 'signedOut' }) }));
		instantiation.stub(IReachSubscriptionConnection, upcastPartial<IReachSubscriptionConnection>({ getAccount: async () => undefined, signIn }));
		try {
			await instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
			assert.strictEqual(signIn.callCount, 1);
			assert.deepStrictEqual(notices, ['Signed in to REACH Subscription.']);
		} finally { picker.restore(); }
	});

	const devinStatuses: { status: DevinSubscriptionStatus; description: string }[] = [
		{ status: { kind: 'checking' }, description: 'Checking connection' },
		{ status: { kind: 'signedOut' }, description: 'Not signed in' },
		{ status: { kind: 'signingIn' }, description: 'Browser sign-in in progress' },
		{ status: { kind: 'connecting' }, description: 'Sign-in saved · connecting' },
		{ status: { kind: 'unavailable' }, description: 'Sign-in saved · agent unavailable' },
		{ status: { kind: 'failed' }, description: 'Connection needs attention' },
		{ status: { kind: 'ready', modelCount: 7 }, description: '7 models ready' },
	];
	for (const { status, description } of devinStatuses) {
		test(`reports ${status.kind} in the picker without announcing models before readiness`, async () => {
			const { instantiation } = nativeClaudeFixture();
			const quickInput = new TestQuickInputService();
			const picker = sinon.stub(quickInput, 'pick');
			picker.onFirstCall().resolves({ id: 'devin-subscription', label: 'Devin Subscription' });
			picker.onSecondCall().resolves({ id: 'retry', label: 'Retry Connection' });
			const notices: string[] = [];
			instantiation.stub(IQuickInputService, quickInput);
			instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
			instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ status: constObservable(status), connect: async () => { } }));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: message => { notices.push(String(message)); } }));
			try {
				await instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
				const items = picker.firstCall.args[0];
				assert.ok(Array.isArray(items));
				const devin = items.find(item => item.label === 'Devin Subscription');
				assert.ok(devin && devin.type !== 'separator');
				assert.strictEqual(devin.description, description);
				if (status.kind === 'unavailable') { assert.match(devin.detail ?? '', /executable setting.*restart/); }
				assert.strictEqual(notices.length, 1);
				assert.match(notices[0], status.kind === 'ready' ? /has 7 models ready/ : status.kind === 'signedOut' ? /is signed out/ : /models have not appeared yet/);
			} finally { picker.restore(); }
		});
	}

	for (const choice of ['retry', 'signIn', 'cancel'] as const) {
		test(`offers Devin recovery choices and handles ${choice} without clearing the saved account`, async () => {
			const { instantiation } = nativeClaudeFixture();
			const quickInput = new TestQuickInputService();
			const picker = sinon.stub(quickInput, 'pick');
			picker.onFirstCall().resolves({ id: 'devin-subscription', label: 'Devin Subscription' });
			picker.onSecondCall().resolves(choice === 'cancel' ? undefined : { id: choice, label: choice });
			const calls: ({ readonly forceSignIn?: boolean } | undefined)[] = [];
			instantiation.stub(IQuickInputService, quickInput);
			instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({ account: { status: 'signedOut' } }));
			instantiation.stub(IDevinSubscriptionConnection, upcastPartial<IDevinSubscriptionConnection>({ status: constObservable({ kind: 'failed' }), connect: async options => { calls.push(options); } }));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => {} }));
			try {
				await instantiation.invokeFunction(accessor => new AgentSubscriptionsAction().run(accessor));
				const items = picker.secondCall.args[0];
				assert.ok(Array.isArray(items));
				assert.deepStrictEqual(items.map(item => item.label), ['Retry Connection', 'Sign In Again']);
				assert.deepStrictEqual(calls, choice === 'cancel' ? [] : [choice === 'signIn' ? { forceSignIn: true } : undefined]);
			} finally { picker.restore(); }
		});
	}

	for (const status of ['signedOut', 'signedIn'] as const) {
		test(`enables Codex before ${status === 'signedOut' ? 'starting official sign-in' : 'reusing the signed-in account'}`, async () => {
			const instantiation = store.add(new TestInstantiationService());
			const calls: unknown[] = [];
			const values = new TestConfigurationService({ [AgentHostCodexAgentEnabledSettingId]: false });
			const configuration: IConfigurationService = values;
			sinon.stub(configuration, 'updateValue').callsFake(async (key, value, target) => { calls.push([key, value, target]); await values.setUserConfiguration(key, value); });
			instantiation.stub(IConfigurationService, values);
			const changed = store.add(new Emitter<RootState>());
			const registered = upcastPartial<RootState>({ agents: [{ provider: 'codex', displayName: 'Codex', description: '', models: [] }] });
			const subscription = { value: upcastPartial<RootState>({ agents: [] }), onDidChange: changed.event };
			instantiation.stub(IAgentHostService, upcastPartial<IAgentHostService>({ rootState: upcastPartial<IAgentHostService['rootState']>(subscription), onAgentHostStart: Event.None }));
			instantiation.stub(ICodexAccountService, upcastPartial<ICodexAccountService>({
				account: { status, planType: 'plus' }, signIn: () => { calls.push('signIn'); },
			}));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: () => { calls.push('ready'); } }));
			const connection = instantiation.invokeFunction(connectCodexSubscription);
			await timeout(0);
			assert.deepStrictEqual(calls, [[AgentHostCodexAgentEnabledSettingId, true, ConfigurationTarget.USER]]);
			subscription.value = registered;
			changed.fire(registered);
			await connection;
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
				instantiation.stub(IFileService, upcastPartial<IFileService>({ exists: async () => false }));
				instantiation.stub(ITerminalInstanceService, upcastPartial<ITerminalInstanceService>({ getBackend: async () => undefined }));
				const terminal = upcastPartial<ITerminalInstance>({ onExit: Event.None, onDisposed: Event.None, exitCode: 1 });
				instantiation.stub(IAgentSdkSetupService, upcastPartial<IAgentSdkSetupService>({ requestReload: () => { } }));
				const calls: unknown[] = [];
				instantiation.stub(ITerminalService, upcastPartial<ITerminalService>({
					createTerminal: async options => { calls.push(options); return terminal; },
					setActiveInstance: instance => { assert.strictEqual(instance, terminal); calls.push('activate'); },
					revealTerminal: async instance => { assert.strictEqual(instance, terminal); calls.push('reveal'); },
				}));
				await instantiation.invokeFunction(openSubscriptionClient, provider, signIn);
				assert.deepStrictEqual(calls, [{
					config: {
						name: provider === 'claude' ? 'Claude Code · Subscription' : 'Devin CLI', executable: provider === 'claude' ? '/clients/Claude Code/claude.exe' : 'devin', args: signIn ? provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['auth', 'login'] : [], cwd,
						env: provider === 'claude' ? { ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null } : { WINDSURF_API_KEY: null }, waitOnExit: true,
					},
					location: TerminalLocation.Editor,
				}, 'activate', 'reveal']);
			});
		}
	}

	test('starts subscription sign-in in the local home when no workspace is open', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const host = upcastPartial<ISessionHost>({ session: constObservable(undefined), chat: constObservable(undefined) });
		instantiation.stub(ISessionHostService, upcastPartial<ISessionHostService>({}));
		instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => host }));
		instantiation.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders: [] }) }));
		const home = URI.file('/local-home');
		instantiation.stub(IPathService, new TestPathService(home));
		instantiation.stub(IConfigurationService, new TestConfigurationService());
		instantiation.stub(IFileService, upcastPartial<IFileService>({ exists: async uri => isWindows && uri.fsPath.toLowerCase() === 'c:\\users\\test\\appdata\\local\\devin\\cli\\bin\\devin.exe' }));
		instantiation.stub(ITerminalInstanceService, upcastPartial<ITerminalInstanceService>({
			getBackend: async () => upcastPartial<ITerminalBackend>({ getEnvironment: async () => ({ LocalAppData: 'C:\\Users\\test\\AppData\\Local' }) }),
		}));
		const terminal = upcastPartial<ITerminalInstance>({});
		const created: unknown[] = [];
		instantiation.stub(ITerminalService, upcastPartial<ITerminalService>({
			createTerminal: async options => {
				created.push(options?.config);
				return terminal;
			},
			setActiveInstance: () => { },
			revealTerminal: async () => { },
		}));
		await instantiation.invokeFunction(openSubscriptionClient, 'devin', true);
		assert.deepStrictEqual(created, [{ name: 'Devin CLI', executable: isWindows ? 'C:\\Users\\test\\AppData\\Local\\devin\\cli\\bin\\devin.exe' : 'devin', args: ['auth', 'login'], cwd: home, env: { WINDSURF_API_KEY: null }, waitOnExit: true }]);
	});

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
