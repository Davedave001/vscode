/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReader } from '../../../../base/common/observable.js';
import { IChat, ISession, SessionStatus } from '../../../../workbench/services/sessions/common/session.js';

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
			switch (chat.status.read(reader)) {
				case SessionStatus.NeedsInput: needsInput.push({ session, chat }); hasInputChat = true; break;
				case SessionStatus.Error: errors.push({ session, chat }); hasErrorChat = true; break;
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
