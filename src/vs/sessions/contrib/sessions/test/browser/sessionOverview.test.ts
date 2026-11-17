/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { mainWindow } from '../../../../../base/browser/window.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { Context, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { AccessibilityVerbositySettingId } from '../../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { ISessionsService } from '../../../../../workbench/contrib/sessions/browser/sessionsService.js';
import { IsPhoneLayoutContext } from '../../../../../workbench/contrib/sessions/common/contextkeys.js';
import { ISessionHost } from '../../../../../workbench/services/sessions/browser/sessionHost.js';
import { ChatInteractivity, IChat, ISession, ISessionChangeset, ISessionFileChange, ISessionWorkspace, SessionStatus } from '../../../../../workbench/services/sessions/common/session.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { getSessionOverview, getSessionOverviewContent, SESSION_OVERVIEW_VIEW_ID } from '../../browser/sessionOverview.js';
import { SessionOverviewAccessibility } from '../../browser/sessionOverviewAccessibility.js';
import '../../browser/sessionOverview.contribution.js';
import { SessionOverviewWidget } from '../../browser/sessionOverviewWidget.js';

suite('Session Overview', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	function fixture(verbosity = true) {
		const title = observableValue('overviewTest.title', 'Review the parser');
		const status = observableValue<SessionStatus>('overviewTest.status', SessionStatus.NeedsInput);
		const interactivity = observableValue('overviewTest.interactivity', ChatInteractivity.Full);
		const changes = observableValue<readonly ISessionFileChange[]>('overviewTest.changes', []);
		const changesets = observableValue<readonly ISessionChangeset[] | undefined>('overviewTest.changesets', undefined);
		const workspace = observableValue<ISessionWorkspace | undefined>('overviewTest.workspace', upcastPartial<ISessionWorkspace>({ label: 'Parser workspace' }));
		const chat = upcastPartial<IChat>({ resource: URI.parse('test:/chat'), title, status, interactivity, changes, changesets, workspace, description: constObservable(new MarkdownString('Reviewing **README.md**')) });
		const sessionStatus = observableValue<SessionStatus>('overviewTest.sessionStatus', SessionStatus.Completed);
		const session = upcastPartial<ISession>({ resource: URI.parse('test:/session'), status: sessionStatus, title: constObservable('Parser project'), chats: constObservable([chat]), isArchived: constObservable(false) });
		const chatSource = observableValue<IChat | undefined>('overviewTest.chat', chat);
		const host = upcastPartial<ISessionHost>({ id: 'overview-host', session: constObservable(session), chat: chatSource, commandContext: { sessionHostId: 'overview-host' } });
		const instantiation = store.add(new TestInstantiationService());
		const config = new TestConfigurationService({ [AccessibilityVerbositySettingId.SessionOverview]: verbosity });
		const context = store.add(new ContextKeyService(config));
		const execute = sinon.stub().resolves(undefined);
		const openChat = sinon.stub().resolves(undefined);
		instantiation.stub(ISessionHost, host);
		instantiation.stub(IConfigurationService, config);
		instantiation.stub(IContextKeyService, context);
		instantiation.stub(IKeybindingService, new MockKeybindingService());
		instantiation.stub(ICommandService, upcastPartial<ICommandService>({ executeCommand: execute }));
		instantiation.stub(ISessionsService, upcastPartial<ISessionsService>({ openChat }));
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		container.className = 'monaco-workbench';
		store.add(toDisposable(() => container.remove()));
		const widget = store.add(instantiation.createInstance(SessionOverviewWidget, container));
		instantiation.stub(IViewsService, upcastPartial<IViewsService>({ getActiveViewWithId: sinon.stub().returns({ focus: () => widget.focus(), getOverviewContent: () => widget.getOverviewContent() }) }));
		return { instantiation, container, widget, host, chat, session, chatSource, title, status, sessionStatus, interactivity, workspace, changes, changesets, execute, openChat };
	}

	test('reports chat state and omits a zero file count until changes are published', () => {
		const f = fixture();
		const before = getSessionOverview(f.session, f.chat)!;
		assert.strictEqual(before.files, undefined);
		assert.strictEqual(before.activity, 'Reviewing README.md');
		assert.strictEqual(before.waiting, 1);
		f.changesets.set([], undefined);
		assert.strictEqual(getSessionOverview(f.session, f.chat)?.files, undefined);
		const loading = observableValue('overviewTest.loading', true);
		f.changesets.set([upcastPartial<ISessionChangeset>({ label: 'Branch Changes', isEnabled: constObservable(true), isDefault: constObservable(true), isLoadingChanges: loading, changes: f.changes })], undefined);
		assert.strictEqual(getSessionOverview(f.session, f.chat)?.files, undefined);
		loading.set(false, undefined);
		assert.strictEqual(getSessionOverview(f.session, f.chat)?.files, 0);
		f.changes.set([upcastPartial<ISessionFileChange>({}), upcastPartial<ISessionFileChange>({})], undefined);
		assert.strictEqual(getSessionOverview(f.session, f.chat)?.files, 2);
		assert.strictEqual(getSessionOverview(f.session, f.chat)?.filesText, 'Branch Changes: 2 files');
		f.changes.set([upcastPartial<ISessionFileChange>({})], undefined);
		f.changesets.set([{ ...f.changesets.get()![0], label: '' }], undefined);
		assert.strictEqual(f.container.querySelector('.session-overview-files')?.textContent, 'Chat Changes: 1 file');
		f.status.set(SessionStatus.Completed, undefined);
		const content = getSessionOverviewContent(getSessionOverview(f.session, f.chat));
		assert.ok(content.includes('Completed'));
		assert.ok(!content.toLowerCase().includes('verified'));
	});

	test('updates text without replacing focused controls or inheriting an absent chat workspace', () => {
		const f = fixture();
		const button = f.container.querySelector<HTMLElement>('.monaco-button')!;
		button.focus();
		f.title.set('<img src=x onerror=alert(1)>', undefined);
		f.workspace.set(undefined, undefined);
		f.status.set(SessionStatus.InProgress, undefined);
		assert.strictEqual(mainWindow.document.activeElement, button);
		assert.strictEqual(f.container.querySelector('.session-overview-title')?.textContent, '<img src=x onerror=alert(1)>');
		assert.strictEqual(f.container.querySelector('img'), null);
		assert.ok(f.container.querySelector('.session-overview-status')?.textContent?.includes('Working'));
		assert.ok(!f.container.textContent?.includes('Parser workspace'));
	});

	test('routes shortcuts to the current local host and does not navigate an unsent draft', () => {
		const f = fixture();
		const buttons = [...f.container.querySelectorAll<HTMLElement>('.monaco-button')];
		buttons[0].click();
		assert.deepStrictEqual(f.openChat.firstCall.args, [f.session, f.chat.resource, { from: f.host, source: 'sessionsList' }]);
		buttons[1].click();
		buttons[2].click();
		assert.deepStrictEqual(f.execute.args, [['sessions.openSessionTools', f.host.commandContext], ['sessions.openAttentionQueue']]);
		buttons[0].focus();
		f.sessionStatus.set(SessionStatus.Untitled, undefined);
		assert.strictEqual(mainWindow.document.activeElement, buttons[0]);
		buttons[0].click();
		assert.strictEqual(f.openChat.callCount, 1);
	});

	test('does not expose a hidden chat or retain its data after the host becomes empty', () => {
		const f = fixture();
		f.interactivity.set(ChatInteractivity.Hidden, undefined);
		assert.strictEqual(getSessionOverview(f.session, f.chat), undefined);
		assert.ok(!f.container.textContent?.includes('Review the parser'));
		f.chatSource.set(undefined, undefined);
		assert.ok(f.container.textContent?.includes('Open a chat'));
	});

	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		test(`provides ${type} content and restores the exact focused button`, () => {
			const f = fixture();
			const button = f.container.querySelector<HTMLElement>('.monaco-button')!;
			button.focus();
			const provider = f.instantiation.invokeFunction(accessor => new SessionOverviewAccessibility(type).getProvider(accessor))!;
			store.add(provider);
			assert.ok(provider.provideContent().includes(type === AccessibleViewType.Help ? 'Tab and Shift+Tab' : 'Review the parser'));
			f.widget.element.focus();
			provider.onClose();
			assert.strictEqual(mainWindow.document.activeElement, button);
		});
	}

	test('restores overview focus when the original accessible-view control has disappeared', () => {
		const f = fixture();
		const temporary = f.container.appendChild(mainWindow.document.createElement('button'));
		temporary.focus();
		const provider = f.instantiation.invokeFunction(accessor => new SessionOverviewAccessibility(AccessibleViewType.View).getProvider(accessor))!;
		store.add(provider);
		temporary.remove();
		provider.onClose();
		assert.strictEqual(mainWindow.document.activeElement, f.widget.element);
	});

	test('resolves accessibility content from the open view without requesting a root-scoped session host', () => {
		const f = fixture();
		const views = f.instantiation.get(IViewsService);
		const rootServices = store.add(new TestInstantiationService());
		rootServices.stub(IViewsService, views);
		const provider = rootServices.invokeFunction(accessor => new SessionOverviewAccessibility(AccessibleViewType.View).getProvider(accessor));
		assert.ok(provider);
		store.add(provider);
		assert.ok(provider.provideContent().includes('Review the parser'));
		f.instantiation.stub(IViewsService, upcastPartial<IViewsService>({ getActiveViewWithId: () => null }));
		assert.strictEqual(f.instantiation.invokeFunction(accessor => new SessionOverviewAccessibility(AccessibleViewType.View).getProvider(accessor)), undefined);
	});

	test('honors the accessibility verbosity setting', () => {
		assert.ok(fixture(true).widget.element.getAttribute('aria-description')?.includes('Accessibility Help'));
		assert.strictEqual(fixture(false).widget.element.getAttribute('aria-description'), null);
	});

	test('registers an auxiliary view and exposes it only in the main desktop Agents window', async () => {
		const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
		const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
		const view = views.getView(SESSION_OVERVIEW_VIEW_ID)!;
		const container = containers.get('sessions.overviewContainer')!;
		assert.strictEqual(containers.getViewContainerLocation(container), ViewContainerLocation.AuxiliaryBar);
		const context = new Context(0, null);
		context.setValue(IsSessionsWindowContext.key, true);
		assert.strictEqual(view.when?.evaluate(context), true);
		for (const key of [IsPhoneLayoutContext.key, IsAuxiliaryWindowContext.key]) {
			context.setValue(key, true);
			assert.strictEqual(view.when?.evaluate(context), false);
			context.setValue(key, false);
		}
		const f = fixture();
		const open = sinon.stub().resolves(undefined);
		f.instantiation.stub(IViewsService, upcastPartial<IViewsService>({ openView: open }));
		await f.instantiation.invokeFunction(async accessor => { await CommandsRegistry.getCommand('sessions.openOverview')!.handler(accessor); });
		assert.deepStrictEqual(open.firstCall.args, [SESSION_OVERVIEW_VIEW_ID, true]);
	});
});
