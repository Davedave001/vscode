/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionOverview.css';
import { $, append, trackFocus } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { ISessionsService } from '../../../../workbench/contrib/sessions/browser/sessionsService.js';
import { ISessionHost } from '../../../../workbench/services/sessions/browser/sessionHost.js';
import { ChatInteractivity, isSessionCreated } from '../../../../workbench/services/sessions/common/session.js';
import { getSessionOverview, getSessionOverviewContent } from './sessionOverview.js';

export const SessionOverviewFocusedContext = new RawContextKey<boolean>('sessionOverviewFocused', false);

/** Stable text and controls keep keyboard focus intact as provider data changes. */
export class SessionOverviewWidget extends Disposable {
	readonly element: HTMLElement;

	constructor(
		container: HTMLElement,
		@ISessionHost private readonly host: ISessionHost,
		@ISessionsService sessionsService: ISessionsService,
		@ICommandService commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super();
		this.element = append(container, $('.session-overview', { tabIndex: 0, role: 'region', 'aria-label': localize('overview.label', "Session Overview") }));
		const title = append(this.element, $('h2.session-overview-title'));
		const parent = append(this.element, $('p.session-overview-context'));
		const status = append(this.element, $('p.session-overview-status', { 'aria-live': 'polite', 'aria-atomic': 'true' }));
		const activity = append(this.element, $('p.session-overview-activity'));
		const workspace = append(this.element, $('p.session-overview-context'));
		const facts = append(this.element, $('div.session-overview-facts'));
		const files = append(facts, $('p.session-overview-files'));
		const attention = append(facts, $('p.session-overview-attention', { 'aria-live': 'polite', 'aria-atomic': 'true' }));
		const actions = append(this.element, $('div.session-overview-actions'));
		const conversation = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		conversation.label = localize('overview.openChat', "Open Chat");
		const tools = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		tools.label = localize('overview.tools', "Session Tools");
		const queue = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		queue.label = localize('overview.queue', "Attention Queue");
		const focusKey = SessionOverviewFocusedContext.bindTo(contextKeyService);
		const tracker = this._register(trackFocus(this.element));
		this._register(tracker.onDidFocus(() => focusKey.set(true)));
		this._register(tracker.onDidBlur(() => focusKey.reset()));
		this._register({ dispose: () => focusKey.reset() });
		const updateHint = () => {
			if (configurationService.getValue<boolean>(AccessibilityVerbositySettingId.SessionOverview)) {
				this.element.setAttribute('aria-description', keybindingService.appendKeybinding(localize('overview.helpHint', "Open Accessibility Help for navigation instructions"), 'editor.action.accessibilityHelp'));
			} else { this.element.removeAttribute('aria-description'); }
		};
		this._register(configurationService.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionOverview)) { updateHint(); } }));
		this._register(keybindingService.onDidUpdateKeybindings(updateHint));
		updateHint();
		this._register(autorun(reader => {
			const session = host.session.read(reader);
			const chat = host.chat.read(reader);
			const overview = getSessionOverview(session, chat, reader);
			this.setText(title, overview?.title ?? localize('overview.empty', "Open a chat to see its overview."));
			this.setText(parent, overview?.sessionTitle ?? '');
			this.setText(status, overview?.status ?? '');
			this.setText(activity, overview?.activity ?? '');
			this.setText(workspace, overview?.workspace ?? '');
			this.setText(files, overview?.filesText ?? '');
			this.setText(attention, overview ? localize('overview.attention', "Session attention: {0} waiting for input, {1} failed", overview.waiting, overview.failed) : '');
			conversation.enabled = !!overview && isSessionCreated(session, reader);
			tools.enabled = !!overview;
		}));
		this._register(conversation.onDidClick(() => {
			const session = host.session.get();
			const chat = host.chat.get();
			if (session && chat && isSessionCreated(session) && chat.interactivity.get() !== ChatInteractivity.Hidden) {
				void sessionsService.openChat(session, chat.resource, { from: host, source: 'sessionsList' }).catch(onUnexpectedError);
			}
		}));
		this._register(tools.onDidClick(() => { void commandService.executeCommand('sessions.openSessionTools', host.commandContext).catch(onUnexpectedError); }));
		this._register(queue.onDidClick(() => { void commandService.executeCommand('sessions.openAttentionQueue').catch(onUnexpectedError); }));
	}

	private setText(element: HTMLElement, text: string): void {
		element.hidden = !text;
		if (element.textContent !== text) { element.textContent = text; }
	}

	focus(): void { this.element.focus(); }
	layout(height: number): void { this.element.style.height = `${height}px`; }
	getOverviewContent(): string { return getSessionOverviewContent(getSessionOverview(this.host.session.get(), this.host.chat.get())); }
}
