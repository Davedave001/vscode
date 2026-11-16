/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, IMenuService, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { Menus } from '../../../../workbench/contrib/sessions/browser/menus.js';
import { ISessionsService } from '../../../../workbench/contrib/sessions/browser/sessionsService.js';
import { INewSessionComposerService } from '../../../../workbench/contrib/sessions/browser/newSessionComposerService.js';
import { SessionsCategories } from '../../../../workbench/contrib/sessions/common/categories.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ISessionsManagementService } from '../../../../workbench/contrib/sessions/common/sessionsManagement.js';
import { ISession, SessionStatus } from '../../../../workbench/services/sessions/common/session.js';
import { getSessionAttentionQueue } from './sessionAttentionQueue.js';

const mainAgentsWindow = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated(), ChatContextKeys.enabled);

/** Uses the existing menu's capability and policy checks instead of maintaining a second tool catalog. */
function collectToolActions(actions: readonly IAction[], prefix = ''): { action: IAction; label: string }[] {
	return actions.flatMap(action => {
		if (action instanceof Separator || !action.enabled) {
			return [];
		}
		const label = prefix + action.label;
		return action instanceof SubmenuAction
			? collectToolActions(action.actions, `${label} / `)
			: [{ action, label }];
	});
}

registerAction2(class SessionToolsAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.openSessionTools',
			title: localize2('sessionTools', "Session Tools"),
			category: SessionsCategories.Sessions,
			icon: Codicon.tools,
			f1: true,
			precondition: mainAgentsWindow,
			menu: { id: Menus.SessionBarToolbar, group: 'navigation', order: 90, when: mainAgentsWindow },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const store = new DisposableStore();
		const menu = store.add(accessor.get(IMenuService).createMenu(Menus.SessionActivityBar, accessor.get(IContextKeyService)));
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		try {
			const readActions = () => collectToolActions(menu.getActions().flatMap(([, actions]) => actions));
			const items = readActions().map(({ action, label }) => ({ id: action.id, label }));
			if (items.length === 0) {
				notificationService.info(localize('sessionTools.empty', "No tools are available for the current session. Select a workspace session first."));
				return;
			}
			const selected = await quickInputService.pick(items, {
				title: localize('sessionTools.title', "Session Tools"),
				placeHolder: localize('sessionTools.search', "Search tools and canvases for this session"),
			});
			if (selected) {
				// Session capabilities may have changed while the picker was open.
				const current = readActions().find(({ action }) => action.id === selected.id);
				if (current) {
					await current.action.run();
				} else {
					notificationService.info(localize('sessionTools.changed', "This tool is no longer available for the current session. Open Session Tools again."));
				}
			}
		} finally {
			store.dispose();
		}
	}
});

registerAction2(class SessionAttentionQueueAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.openAttentionQueue',
			title: localize2('attentionQueue', "Attention Queue"),
			category: SessionsCategories.Sessions,
			icon: Codicon.bell,
			f1: true,
			precondition: mainAgentsWindow,
			menu: { id: Menus.SidebarSessionsHeader, group: 'navigation', order: 5, when: mainAgentsWindow },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const management = accessor.get(ISessionsManagementService);
		const sessionsService = accessor.get(ISessionsService);
		const composer = accessor.get(INewSessionComposerService);
		interface ISessionQueueItem extends IQuickPickItem { readonly session: ISession }
		const store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<ISessionQueueItem>({ useSeparators: true }));
		picker.placeholder = localize('attentionQueue.search', "Search sessions waiting for you by name or workspace");
		picker.matchOnDescription = true;
		picker.sortByLabel = false;
		const changed = observableSignalFromEvent('attentionQueue.sessionsChanged', management.onDidChangeSessions);
		store.add(autorun(reader => {
			changed.read(reader);
			const queue = getSessionAttentionQueue(management.getSessions(), reader);
			picker.title = localize('attentionQueue.summary', "{0} Waiting for Input · {1} Failed · {2} Working", queue.needsInput.length, queue.errors.length, queue.working);
			const items: (ISessionQueueItem | IQuickPickSeparator)[] = [];
			for (const [label, sessions] of [
				[localize('attentionQueue.waiting', "Waiting for Your Input"), queue.needsInput],
				[localize('attentionQueue.failed', "Failed — Review Required"), queue.errors],
			] as const) {
				if (sessions.length) {
					items.push({ type: 'separator', label });
					items.push(...sessions.map(session => ({
						id: session.resource.toString(), session,
						label: session.title.read(reader) || localize('attentionQueue.untitled', "Untitled Session"),
						description: session.workspace.read(reader)?.label,
					})));
				}
			}
			const activeId = picker.activeItems[0]?.id;
			picker.items = items;
			const active = items.find((item): item is ISessionQueueItem => item.type !== 'separator' && item.id === activeId);
			if (active) {
				picker.activeItems = [active];
			}
			picker.description = items.length ? undefined : localize('attentionQueue.clear', "Nothing needs your attention. Running sessions will appear here if they need input or fail.");
		}));
		store.add(picker.onDidAccept(() => {
			const selected = picker.selectedItems[0];
			if (!selected) {
				return;
			}
			// Resolve again: a provider can remove, archive, or finish the session during selection.
			const current = management.getSession(selected.session.resource);
			if (!current || current.isArchived.get() || ![SessionStatus.NeedsInput, SessionStatus.Error].includes(current.status.get())) {
				return;
			}
			composer.notifyUserNavigation();
			picker.hide();
			sessionsService.openSession(current.resource, { source: 'sessionsList' }).catch(onUnexpectedError);
		}));
		store.add(picker.onDidHide(() => store.dispose()));
		picker.show();
	}
});
