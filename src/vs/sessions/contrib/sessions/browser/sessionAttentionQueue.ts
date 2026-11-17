/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReader } from '../../../../base/common/observable.js';
import { ChatInteractivity, IChat, ISession, SessionStatus } from '../../../../workbench/services/sessions/common/session.js';

export interface ISessionAttentionItem {
	readonly session: ISession;
	/** Undefined while an aggregate alert has no matching chat metadata. */
	readonly chat: IChat | undefined;
}

/** Keeps actionable chats separate from working-session counts without changing order or read state. */
export function getSessionAttentionQueue(sessions: readonly ISession[], reader?: IReader): { needsInput: ISessionAttentionItem[]; errors: ISessionAttentionItem[]; working: number } {
	const needsInput: ISessionAttentionItem[] = [];
	const errors: ISessionAttentionItem[] = [];
	let working = 0;
	for (const session of sessions) {
		const status = session.status.read(reader);
		if (session.isArchived.read(reader) || status === SessionStatus.Untitled) {
			continue;
		}
		let hasInputChat = false;
		let hasErrorChat = false;
		let isWorking = status === SessionStatus.InProgress;
		for (const chat of session.chats.read(reader)) {
			const chatStatus = chat.status.read(reader);
			// Known archived/internal alerts are not missing metadata and must not create a fallback row.
			hasInputChat ||= chatStatus === SessionStatus.NeedsInput;
			hasErrorChat ||= chatStatus === SessionStatus.Error;
			if (chat.isArchived?.read(reader) || chat.interactivity?.read(reader) === ChatInteractivity.Hidden) { continue; }
			switch (chatStatus) {
				case SessionStatus.NeedsInput: needsInput.push({ session, chat }); break;
				case SessionStatus.Error: errors.push({ session, chat }); break;
				case SessionStatus.InProgress: isWorking = true; break;
			}
		}
		// Some providers publish the aggregate before their chat metadata arrives.
		if (status === SessionStatus.NeedsInput && !hasInputChat) { needsInput.push({ session, chat: undefined }); }
		if (status === SessionStatus.Error && !hasErrorChat) { errors.push({ session, chat: undefined }); }
		if (isWorking) { working++; }
	}
	return { needsInput, errors, working };
}
