/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext } from '../../../../workbench/contrib/sessions/common/contextkeys.js';
import { Menus } from '../../../../workbench/contrib/sessions/browser/menus.js';
import { SessionsCategories } from '../../../../workbench/contrib/sessions/common/categories.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { SessionOverviewView } from './sessionOverviewView.js';
import { SessionOverviewAccessibility } from './sessionOverviewAccessibility.js';
import { SESSION_OVERVIEW_VIEW_ID } from './sessionOverview.js';

const containerId = 'sessions.overviewContainer';
const when = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.negate(), IsPhoneLayoutContext.negate());
const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id: containerId, title: localize2('overview.title', "Session Overview"), icon: Codicon.dashboard, order: 12,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: containerId, hideIfEmpty: true, windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);
Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: SESSION_OVERVIEW_VIEW_ID, name: localize2('overview.title', "Session Overview"),
	ctorDescriptor: new SyncDescriptor(SessionOverviewView), canToggleVisibility: false, canMoveView: false,
	when, windowEnablement: WindowEnablement.Sessions,
}], container);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.openOverview', title: localize2('overview.title', "Session Overview"),
			category: SessionsCategories.Sessions, icon: Codicon.dashboard, f1: true, precondition: when,
			menu: { id: Menus.SessionBarToolbar, group: 'navigation', order: 89, when },
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IViewsService).openView(SESSION_OVERVIEW_VIEW_ID, true); }
});

AccessibleViewRegistry.register(new SessionOverviewAccessibility(AccessibleViewType.Help));
AccessibleViewRegistry.register(new SessionOverviewAccessibility(AccessibleViewType.View));
