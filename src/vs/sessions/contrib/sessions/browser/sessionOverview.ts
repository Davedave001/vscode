/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { IReader } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IChat, ISession, SessionStatus, ChatInteractivity } from '../../../../workbench/services/sessions/common/session.js';
import { getSessionAttentionQueue } from './sessionAttentionQueue.js';

export const SESSION_OVERVIEW_VIEW_ID = 'sessions.overview';

export interface ISessionOverview {
	readonly title: string;
	readonly sessionTitle: string | undefined;
	readonly status: string;
	readonly activity: string;
	readonly workspace: string | undefined;
	readonly files: number | undefined;
	readonly filesText: string | undefined;
	readonly waiting: number;
	readonly failed: number;
}

/** Reads provider state without opening a runtime, fetching changes, or inventing verification results. */
export function getSessionOverview(session: ISession | undefined, chat: IChat | undefined, reader?: IReader): ISessionOverview | undefined {
	if (!session || !chat || chat.interactivity.read(reader) === ChatInteractivity.Hidden) { return undefined; }
	const sessionTitle = session.title.read(reader);
	const title = chat.title.read(reader) || sessionTitle || localize('overview.untitled', "Untitled Chat");
	const statuses: Record<SessionStatus, string> = {
		[SessionStatus.Untitled]: localize('overview.draft', "Draft"),
		[SessionStatus.InProgress]: localize('overview.working', "Working"),
		[SessionStatus.NeedsInput]: localize('overview.input', "Waiting for Your Input"),
		[SessionStatus.Completed]: localize('overview.completed', "Completed"),
		[SessionStatus.Error]: localize('overview.failed', "Failed"),
	};
	const changes = chat.changes.read(reader);
	const changesets = chat.changesets.read(reader);
	const defaultChangeset = changesets?.find(changeset => changeset.isEnabled.read(reader) && changeset.isDefault.read(reader));
	const files = defaultChangeset
		? defaultChangeset.isLoadingChanges.read(reader) ? undefined : defaultChangeset.changes.read(reader).length
		: changes.length > 0 ? changes.length : undefined;
	const queue = getSessionAttentionQueue([session], reader);
	const filesLabel = defaultChangeset?.label || localize('overview.chatChanges', "Chat Changes");
	return {
		title, sessionTitle: sessionTitle && sessionTitle !== title ? sessionTitle : undefined,
		status: statuses[chat.status.read(reader)],
		activity: renderAsPlaintext(chat.description.read(reader) ?? ''),
		workspace: chat.workspace.read(reader)?.label,
		// Only a usable default changeset establishes zero; its label states the count's scope.
		files, filesText: files === undefined ? undefined : files === 1
			? localize('overview.file', "{0}: {1} file", filesLabel, files)
			: localize('overview.files', "{0}: {1} files", filesLabel, files),
		waiting: queue.needsInput.length, failed: queue.errors.length,
	};
}

export function getSessionOverviewContent(overview: ISessionOverview | undefined): string {
	if (!overview) { return localize('overview.empty', "Open a chat to see its overview."); }
	return [
		overview.title, overview.sessionTitle, overview.status, overview.activity, overview.workspace,
		overview.filesText,
		localize('overview.attention', "Session attention: {0} waiting for input, {1} failed", overview.waiting, overview.failed),
	].filter(line => !!line).join('\n');
}
