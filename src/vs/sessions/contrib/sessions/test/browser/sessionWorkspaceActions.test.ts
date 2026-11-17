/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMenu, IMenuService, MenuId, MenuItemAction, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputHideEvent, IQuickInputService, IQuickPick, IQuickPickDidAcceptEvent, IQuickPickItem, QuickInputHideReason } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { INewSessionComposerService } from '../../../../../workbench/contrib/sessions/browser/newSessionComposerService.js';
import { ISessionsService } from '../../../../../workbench/contrib/sessions/browser/sessionsService.js';
import { ISessionsChangeEvent, ISessionsManagementService } from '../../../../../workbench/contrib/sessions/common/sessionsManagement.js';
import { IChat, ISession, ISessionWorkspace, SessionStatus } from '../../../../../workbench/services/sessions/common/session.js';
import { IFocusedSessionHostService, ISessionHost, ISessionHostService } from '../../../../../workbench/services/sessions/browser/sessionHost.js';
import '../../browser/sessionWorkspaceActions.js';

suite('Session Workspace Actions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function toolsHost(instantiation: TestInstantiationService) {
		const session = observableValue<ISession | undefined>('toolsTest.session', upcastPartial<ISession>({ resource: URI.parse('test:/session') }));
		const chat = observableValue<IChat | undefined>('toolsTest.chat', upcastPartial<IChat>({ resource: URI.parse('test:/child') }));
		const context = upcastPartial<IContextKeyService>({ contextMatchesRules: () => true });
		const host = upcastPartial<ISessionHost>({ id: 'tools-origin', session, chat, contextKeyService: context, commandContext: { sessionHostId: 'tools-origin' } });
		const hosts = new Map([[host.id, host]]);
		let focused = host;
		instantiation.stub(ISessionHostService, upcastPartial<ISessionHostService>({ getHost: id => hosts.get(id) }));
		instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => focused }));
		return { host, hosts, session, chat, context, focus: (value: ISessionHost) => { focused = value; } };
	}

	function attentionFixture(status = SessionStatus.Completed, chatStatus = SessionStatus.NeedsInput) {
		let closePicker = () => { };
		store.add(toDisposable(() => closePicker()));
		const accepted = store.add(new Emitter<IQuickPickDidAcceptEvent>());
		const hidden = store.add(new Emitter<IQuickInputHideEvent>());
		const changed = store.add(new Emitter<ISessionsChangeEvent>());
		const childStatus = observableValue<SessionStatus>('attentionTest.childStatus', chatStatus);
		const title = observableValue('attentionTest.title', 'Child decision');
		const workspace = observableValue<ISessionWorkspace | undefined>('attentionTest.workspace', upcastPartial<ISessionWorkspace>({ label: 'Child workspace' }));
		const child = upcastPartial<IChat>({ resource: URI.parse('test:/child'), status: childStatus, title, workspace });
		const chats = observableValue<readonly IChat[]>('attentionTest.chats', [child]);
		const archived = observableValue('attentionTest.archived', false);
		const read = observableValue('attentionTest.read', false);
		const session = upcastPartial<ISession>({ resource: URI.parse('test:/parent'), status: constObservable(status), title: constObservable('Parent task'), workspace: constObservable(upcastPartial<ISessionWorkspace>({ label: 'Parent workspace' })), isArchived: archived, isRead: read, chats });
		let current: ISession | undefined = session;
		let disposed = false;
		let navigation = 0;
		const opened: { session: ISession; chat: URI | undefined }[] = [];
		const picker = upcastPartial<IQuickPick<IQuickPickItem, { useSeparators: true }>>({
			items: [], activeItems: [], selectedItems: [],
			onDidAccept: accepted.event, onDidHide: hidden.event,
			show: () => { }, hide: () => hidden.fire({ reason: QuickInputHideReason.Gesture }), dispose: () => { disposed = true; },
		});
		closePicker = () => picker.hide();
		const instantiation = store.add(new TestInstantiationService());
		const quickInput = new TestQuickInputService();
		const create = sinon.stub(quickInput, 'createQuickPick').returns(picker);
		store.add(toDisposable(() => create.restore()));
		instantiation.stub(IQuickInputService, quickInput);
		instantiation.stub(ISessionsManagementService, upcastPartial<ISessionsManagementService>({ onDidChangeSessions: changed.event, getSessions: () => current ? [current] : [], getSession: () => current }));
		instantiation.stub(INewSessionComposerService, upcastPartial<INewSessionComposerService>({ notifyUserNavigation: () => { navigation++; } }));
		instantiation.stub(ISessionsService, upcastPartial<ISessionsService>({
			openChat: async (session, chat) => { opened.push({ session, chat }); },
			openSession: async () => { opened.push({ session: current!, chat: undefined }); },
		}));
		instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.openAttentionQueue')!.handler(accessor));
		return {
			picker, opened, session, child, childStatus, title, workspace, chats, archived, read,
			get navigation() { return navigation; }, get disposed() { return disposed; },
			items: () => picker.items.filter((item): item is IQuickPickItem => item.type !== 'separator'),
			accept: (item: IQuickPickItem) => { picker.selectedItems = [item]; accepted.fire({ inBackground: false }); },
			removeSession: () => { current = undefined; changed.fire({ added: [], changed: [], removed: [session] }); },
		};
	}

	test('lists and opens the actionable child chat with its own workspace', () => {
		const f = attentionFixture();
		assert.strictEqual(f.navigation, 0);
		assert.deepStrictEqual(f.items().map(item => [item.label, item.description, item.detail]), [['Child decision', 'Parent task', 'Child workspace']]);
		assert.strictEqual(f.picker.matchOnDetail, true);
		f.accept(f.items()[0]);
		assert.deepStrictEqual(f.opened, [{ session: f.session, chat: f.child.resource }]);
		assert.strictEqual(f.navigation, 1);
		assert.strictEqual(f.disposed, true);
	});

	for (const change of ['completed', 'removedChat', 'archived', 'removedSession'] as const) {
		test(`does not navigate a stale selection after it is ${change}`, () => {
			const f = attentionFixture();
			const selected = f.items()[0];
			if (change === 'completed') { f.childStatus.set(SessionStatus.Completed, undefined); }
			else if (change === 'removedChat') { f.chats.set([], undefined); }
			else if (change === 'archived') { f.archived.set(true, undefined); }
			else { f.removeSession(); }
			f.accept(selected);
			assert.deepStrictEqual(f.opened, []);
			assert.strictEqual(f.navigation, 0);
			assert.strictEqual(f.disposed, false);
		});
	}

	test('updates chat metadata live and accepts a replacement chat object with the same identity', () => {
		const f = attentionFixture();
		const selected = f.items()[0];
		f.picker.activeItems = [selected];
		f.title.set('', undefined);
		assert.deepStrictEqual(f.items().map(item => item.label), ['Parent task']);
		f.title.set('Renamed child', undefined);
		f.workspace.set(undefined, undefined);
		assert.strictEqual(f.items()[0].detail, undefined);
		f.workspace.set(upcastPartial<ISessionWorkspace>({ label: 'New child workspace' }), undefined);
		assert.deepStrictEqual(f.items().map(item => [item.label, item.detail]), [['Renamed child', 'New child workspace']]);
		assert.strictEqual(f.picker.activeItems[0].id, selected.id);
		f.chats.set([upcastPartial<IChat>({ ...f.child, status: constObservable(SessionStatus.Error) })], undefined);
		f.accept(selected);
		assert.deepStrictEqual(f.opened, [{ session: f.session, chat: f.child.resource }]);
	});

	test('opens an unresolved aggregate alert through the session navigation path', () => {
		const f = attentionFixture(SessionStatus.NeedsInput, SessionStatus.Completed);
		assert.deepStrictEqual(f.items().map(item => [item.label, item.detail]), [['Parent task', 'Parent workspace']]);
		f.accept(f.items()[0]);
		assert.deepStrictEqual(f.opened, [{ session: f.session, chat: undefined }]);
	});

	for (const choice of ['cancel', 'chat', 'session'] as const) {
		test(`keeps legacy main-chat and aggregate identities distinct when choosing ${choice}`, () => {
			const f = attentionFixture(SessionStatus.Error);
			f.chats.set([upcastPartial<IChat>({ ...f.child, resource: f.session.resource })], undefined);
			assert.strictEqual(new Set(f.items().map(item => item.id)).size, 2);
			if (choice === 'cancel') { f.picker.hide(); }
			else { f.accept(f.items().find(item => item.label === (choice === 'chat' ? 'Child decision' : 'Parent task'))!); }
			assert.deepStrictEqual(f.opened, choice === 'cancel' ? [] : [{ session: f.session, chat: choice === 'chat' ? f.session.resource : undefined }]);
			assert.strictEqual(f.navigation, choice === 'cancel' ? 0 : 1);
			assert.strictEqual(f.disposed, true);
			assert.strictEqual(f.read.get(), false);
		});
	}

	for (const becomesUnavailable of [false, true]) {
		test(becomesUnavailable ? 'rechecks tool availability before executing a picked action' : 'offers native enabled tools and runs the selected action', async () => {
			const instantiation = store.add(new TestInstantiationService());
			toolsHost(instantiation);
			let enabled = true;
			let runs = 0;
			let disposed = false;
			const notifications: string[] = [];
			const tools = [
				upcastPartial<MenuItemAction>({ id: 'files', label: 'Files', get enabled() { return enabled; }, run: async () => { runs++; } }),
				upcastPartial<MenuItemAction>({ id: 'blocked', label: 'Unavailable', enabled: false }),
			];
			const menu = upcastPartial<IMenu>({ getActions: () => [['navigation', tools]], dispose: () => { disposed = true; } });
			instantiation.stub(IMenuService, upcastPartial<IMenuService>({ createMenu: () => menu }));
			instantiation.stub(IContextKeyService, upcastPartial<IContextKeyService>({}));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: message => { notifications.push(String(message)); } }));
			const quickInput = new TestQuickInputService();
			const pick = sinon.stub(quickInput, 'pick').callsFake(async () => {
				enabled = !becomesUnavailable;
				return { id: 'files', label: 'Files' };
			});
			instantiation.stub(IQuickInputService, quickInput);
			try {
				await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.openSessionTools')!.handler(accessor));
				assert.deepStrictEqual({ offered: pick.firstCall.args[0], runs, disposed, notices: notifications.length }, {
					offered: [{ id: 'files', label: 'Files' }], runs: becomesUnavailable ? 0 : 1, disposed: true, notices: becomesUnavailable ? 1 : 0,
				});
			} finally {
				pick.restore();
			}
		});
	}

	for (const scenario of ['unchanged', 'chatChanged', 'sessionChanged', 'removedHost', 'hostReplaced', 'objectsReplaced', 'draftBound', 'focusChanged', 'cancelled', 'explicitOrigin', 'nestedCanvas', 'policyChanged', 'failed'] as const) {
		test(`keeps Session Tools bound to its origin when ${scenario}`, async () => {
			const instantiation = store.add(new TestInstantiationService());
			const origin = toolsHost(instantiation);
			if (scenario === 'draftBound') { origin.session.set(undefined, undefined); origin.chat.set(undefined, undefined); }
			const execute = sinon.stub().resolves(undefined);
			const failure = new Error('Tool could not open');
			if (scenario === 'failed') { execute.rejects(failure); }
			const commandService = upcastPartial<ICommandService>({ executeCommand: execute });
			let allowed = true;
			let disposed = false;
			const notices: string[] = [];
			const menuContexts: IContextKeyService[] = [];
			const scope = upcastPartial<IContextKeyService>({ contextMatchesRules: () => allowed });
			const menu = upcastPartial<IMenu>({
				getActions: options => {
					const action = new MenuItemAction({ id: 'tool', title: 'Files', precondition: ContextKeyExpr.true() }, undefined, options, undefined, undefined, scope, commandService);
					return [['navigation', scenario === 'nestedCanvas' ? [new SubmenuItemAction({ submenu: MenuId.for('test.sessionTools.canvases'), title: 'Canvases' }, undefined, [action])] : [action]]];
				},
				dispose: () => { disposed = true; },
			});
			instantiation.stub(IContextKeyService, upcastPartial<IContextKeyService>({}));
			instantiation.stub(IMenuService, upcastPartial<IMenuService>({ createMenu: (_id, context) => { menuContexts.push(context); return menu; } }));
			instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: message => { notices.push(String(message)); } }));
			const quickInput = new TestQuickInputService();
			const other = upcastPartial<ISessionHost>({ id: 'other', session: constObservable(upcastPartial<ISession>({ resource: URI.parse('test:/other-session') })), chat: constObservable(upcastPartial<IChat>({ resource: URI.parse('test:/other-chat') })) });
			if (scenario === 'explicitOrigin') { origin.focus(other); }
			const pick = sinon.stub(quickInput, 'pick').callsFake(async () => {
				if (scenario === 'chatChanged') { origin.chat.set(upcastPartial<IChat>({ resource: URI.parse('test:/different-chat') }), undefined); }
				else if (scenario === 'sessionChanged') { origin.session.set(upcastPartial<ISession>({ resource: URI.parse('test:/different-session') }), undefined); }
				else if (scenario === 'removedHost') { origin.hosts.delete(origin.host.id); }
				else if (scenario === 'hostReplaced') { origin.hosts.set(origin.host.id, upcastPartial<ISessionHost>({ ...origin.host })); }
				else if (scenario === 'objectsReplaced') {
					origin.session.set(upcastPartial<ISession>({ resource: URI.parse('test:/session') }), undefined);
					origin.chat.set(upcastPartial<IChat>({ resource: URI.parse('test:/child') }), undefined);
				}
				else if (scenario === 'draftBound') { origin.session.set(upcastPartial<ISession>({ resource: URI.parse('test:/draft') }), undefined); }
				else if (scenario === 'focusChanged') { origin.focus(other); }
				else if (scenario === 'policyChanged') { allowed = false; }
				return { id: 'tool', label: 'Files' };
			});
			if (scenario === 'cancelled') { pick.resolves(undefined); }
			instantiation.stub(IQuickInputService, quickInput);
			try {
				const opening = instantiation.invokeFunction(async accessor => { await CommandsRegistry.getCommand('sessions.openSessionTools')!.handler(accessor, ...(scenario === 'explicitOrigin' ? [origin.host.commandContext] : [])); });
				if (scenario === 'failed') { await assert.rejects(opening, error => error === failure); } else { await opening; }
				const rejected = ['chatChanged', 'sessionChanged', 'removedHost', 'hostReplaced', 'draftBound', 'policyChanged'].includes(scenario);
				assert.deepStrictEqual(menuContexts, [origin.context]);
				assert.strictEqual(execute.callCount, rejected || scenario === 'cancelled' ? 0 : 1);
				if (execute.called) { assert.deepStrictEqual(execute.firstCall.args, ['tool', origin.host.commandContext]); }
				assert.strictEqual(notices.length, rejected ? 1 : 0);
				assert.strictEqual(disposed, true);
				if (scenario === 'nestedCanvas') { assert.deepStrictEqual(pick.firstCall.args[0], [{ id: 'tool', label: 'Canvases / Files' }]); }
			} finally { pick.restore(); }
		});
	}

	test('does not create a root menu when a toolbar names a host that has gone away', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const origin = toolsHost(instantiation);
		origin.hosts.clear();
		const createMenu = sinon.stub().throws(new Error('A stale host must not create a menu'));
		const notices: string[] = [];
		instantiation.stub(IMenuService, upcastPartial<IMenuService>({ createMenu }));
		instantiation.stub(IQuickInputService, new TestQuickInputService());
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(INotificationService, upcastPartial<INotificationService>({ info: message => { notices.push(String(message)); } }));
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.openSessionTools')!.handler(accessor, origin.host.commandContext));
		assert.strictEqual(createMenu.called, false);
		assert.strictEqual(notices.length, 1);
	});
});
