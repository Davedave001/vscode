/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspaceModeSwitch.css';
import { $, append, EventHelper, EventLike } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const WORKSPACE_MODE_SWITCH_SETTING = 'workbench.titleBar.workspaceModeSwitch';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'workbench',
	properties: {
		[WORKSPACE_MODE_SWITCH_SETTING]: {
			type: 'boolean', default: true,
			description: localize('workspaceModeSwitch.setting', "Show a labelled Agents and IDE switch in the title bar. Reload the window after changing this setting."),
		},
	},
});

/** A persistent, labelled switch between agent orchestration and the code editor. */
export class WorkspaceModeSwitch extends BaseActionViewItem {
	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		private readonly mode: 'agents' | 'ide',
		private readonly commandId: string,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('workspace-mode-switch', 'agent-sessions-interactive');
		container.setAttribute('role', 'switch');
		container.setAttribute('aria-label', localize('workspaceModeSwitch.label', "IDE mode"));
		container.setAttribute('aria-checked', String(this.mode === 'ide'));
		const hover = this.keybindingService.appendKeybinding(this.mode === 'agents'
			? localize('workspaceModeSwitch.toIDE', "Switch to IDE with This Session's Workspace")
			: localize('workspaceModeSwitch.toAgents', "Return to Agents"), this.commandId);
		this._register(this.hoverService.setupManagedHover(this.options.hoverDelegate ?? getDefaultHoverDelegate('element'), container, hover));
		for (const [mode, label] of [['agents', localize('workspaceModeSwitch.agents', "Agents")], ['ide', localize('workspaceModeSwitch.ide', "IDE")]] as const) {
			const segment = append(container, $('span.workspace-mode-segment', { 'aria-hidden': 'true' }, label));
			segment.classList.toggle('active-mode', mode === this.mode);
		}
		this.updateEnabled();
	}

	protected override updateEnabled(): void {
		this.element?.setAttribute('aria-disabled', String(!this.action.enabled));
		this.element?.classList.toggle('disabled', !this.action.enabled);
	}

	override onClick(event: EventLike): void {
		EventHelper.stop(event, true);
		void this.actionRunner.run(this.action, this._context);
	}
}
