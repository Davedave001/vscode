/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewContainerModel, IViewDescriptorService, IViewContainersRegistry, IViewsRegistry, Extensions, ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { ISessionsService } from '../../../../../workbench/contrib/sessions/browser/sessionsService.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ISessionHost } from '../../../../../workbench/services/sessions/browser/sessionHost.js';
import { ChatInteractivity, IChat, ISession, ISessionChangeset, ISessionFileChange, ISessionWorkspace, SessionStatus } from '../../../../../workbench/services/sessions/common/session.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup, registerWorkbenchServices } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { SESSION_OVERVIEW_VIEW_ID } from '../../browser/sessionOverview.js';
import { SessionOverviewView } from '../../browser/sessionOverviewView.js';
import '../../browser/sessionOverview.contribution.js';

function renderOverview(context: ComponentFixtureContext, status: SessionStatus | undefined, width: number): void {
	const { container, disposableStore, theme } = context;
	container.style.width = `${width}px`;
	container.style.height = '440px';
	container.classList.add('agent-sessions-workbench');
	const changes = constObservable<readonly ISessionFileChange[]>(Array.from({ length: 3 }, () => upcastPartial<ISessionFileChange>({})));
	const chat = upcastPartial<IChat>({
		resource: URI.parse('fixture:/chat'), title: constObservable(width < 300 ? 'Review the parser and the workspace configuration' : 'Review the parser'),
		status: constObservable(status ?? SessionStatus.Untitled), interactivity: constObservable(ChatInteractivity.Full),
		isArchived: constObservable(false), changes,
		changesets: constObservable([upcastPartial<ISessionChangeset>({
			label: 'Branch Changes', isEnabled: constObservable(true), isDefault: constObservable(true),
			isLoadingChanges: constObservable(false), changes,
		})]),
		workspace: constObservable(upcastPartial<ISessionWorkspace>({ label: 'Signal-C workspace' })),
		description: constObservable(new MarkdownString(status === SessionStatus.NeedsInput ? 'Choose whether to include the **configuration changes** before continuing.' : 'Updated the parser and its configuration.')),
	});
	const session = upcastPartial<ISession>({
		resource: URI.parse('fixture:/session'), title: constObservable('Parser improvements'), status: constObservable(SessionStatus.Completed),
		isArchived: constObservable(false), chats: constObservable([chat]),
	});
	const host = upcastPartial<ISessionHost>({
		id: 'overview-fixture', session: constObservable(status === undefined ? undefined : session), chat: constObservable(status === undefined ? undefined : chat),
		commandContext: { sessionHostId: 'overview-fixture' },
	});
	const viewContainer = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).get('sessions.overviewContainer')!;
	const descriptor = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).getView(SESSION_OVERVIEW_VIEW_ID)!;
	const services = createEditorServices(disposableStore, {
		colorTheme: theme,
		additionalServices: registration => {
			registerWorkbenchServices(registration);
			registration.define(IContextKeyService, ContextKeyService);
			registration.defineInstance(ISessionHost, host);
			registration.definePartialInstance(ISessionsService, { openChat: async () => { } });
			registration.definePartialInstance(ILifecycleService, { onWillShutdown: Event.None });
			registration.definePartialInstance(IViewDescriptorService, {
				getViewLocationById: () => ViewContainerLocation.AuxiliaryBar,
				onDidChangeLocation: Event.None, onDidChangeContainer: Event.None,
				getViewContainerByViewId: () => viewContainer,
				getViewContainerModel: () => upcastPartial<IViewContainerModel>({ title: 'Session Overview', onDidChangeContainerInfo: Event.None }),
				getViewDescriptorById: () => descriptor,
				getDefaultContainerById: () => viewContainer,
			});
		},
	});
	const view = disposableStore.add(services.createInstance(SessionOverviewView, {
		id: SESSION_OVERVIEW_VIEW_ID, title: 'Session Overview', minimumBodySize: 0, maximumBodySize: Number.POSITIVE_INFINITY,
	}));
	view.render();
	append(container, $('.monaco-pane-view')).appendChild(view.element);
	view.setVisible(true);
	view.orthogonalSize = width;
	view.layout(440);
	view.focus();
	const keys = services.get(IContextKeyService);
	if (keys.getContext(view.element).getValue('sessionOverviewFocused') !== true || keys.getContextKeyValue('sessionOverviewFocused') === true) {
		throw new Error('Overview focus must be available in its view scope without leaking to the root.');
	}
	view.element.querySelector<HTMLElement>('.session-overview')?.blur();
}

function overviewFixture(status: SessionStatus | undefined, width = 340, highContrast = false) {
	return defineComponentFixture({
		labels: { kind: 'screenshot' },
		additionalThemes: highContrast ? ['darkHighContrast', 'lightHighContrast'] : undefined,
		render: context => renderOverview(context, status, width),
	});
}

export default defineThemedFixtureGroup({ path: 'sessions/sessionOverview/' }, {
	WaitingForInput: overviewFixture(SessionStatus.NeedsInput, 340, true),
	Working: overviewFixture(SessionStatus.InProgress),
	Completed: overviewFixture(SessionStatus.Completed),
	Narrow: overviewFixture(SessionStatus.NeedsInput, 270),
	Empty: overviewFixture(undefined),
});
