/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { SESSION_OVERVIEW_VIEW_ID } from './sessionOverview.js';
import { SessionOverviewFocusedContext } from './sessionOverviewWidget.js';
import type { SessionOverviewView } from './sessionOverviewView.js';

/** Both providers restore the exact control from which the accessible view was opened. */
export class SessionOverviewAccessibility implements IAccessibleViewImplementation {
	readonly priority = 115;
	readonly when = SessionOverviewFocusedContext;
	readonly name: string;

	constructor(readonly type: AccessibleViewType) {
		this.name = type === AccessibleViewType.Help ? 'session-overview-help' : 'session-overview-view';
	}

	getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const origin = getActiveElement();
		const views = accessor.get(IViewsService);
		const view = views.getActiveViewWithId<SessionOverviewView>(SESSION_OVERVIEW_VIEW_ID);
		if (!view) { return undefined; }
		const content = this.type === AccessibleViewType.Help ? [
			localize('overview.help', "Session Overview shows this window's selected chat, its reported status and activity, workspace, known changed-file count, and session attention counts. Completed means the chat completed; it does not establish that its work was verified."),
			localize('overview.navigation', "Use Tab and Shift+Tab to move between Open Chat, Session Tools, and Attention Queue. Use Enter or Space to activate a button. Open Chat returns to the selected conversation. Session Tools keeps its original chat target, and Attention Queue lists actionable chats across sessions."),
			localize('overview.accessibleView', "Use Open Accessible View{0} to read the current overview as plain text. Closing accessibility help or the accessible view returns focus to the control that opened it.", '<keybinding:editor.action.accessibleView>'),
		].join('\n') : view.getOverviewContent();
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionOverview, { type: this.type }, () => content,
			() => {
				if (isHTMLElement(origin) && origin.isConnected) { origin.focus(); }
				else { views.getActiveViewWithId(SESSION_OVERVIEW_VIEW_ID)?.focus(); }
			},
			AccessibilityVerbositySettingId.SessionOverview,
		);
	}
}
