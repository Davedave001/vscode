/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReader } from '../../../../base/common/observable.js';
import { ISession, SessionStatus } from '../../../../workbench/services/sessions/common/session.js';

/** Keeps actionable sessions separate from running work without changing sidebar order or read state. */
export function getSessionAttentionQueue(sessions: readonly ISession[], reader?: IReader): { needsInput: ISession[]; errors: ISession[]; working: number } {
	const needsInput: ISession[] = [];
	const errors: ISession[] = [];
	let working = 0;
	for (const session of sessions) {
		if (session.isArchived.read(reader)) {
			continue;
		}
		switch (session.status.read(reader)) {
			case SessionStatus.NeedsInput: needsInput.push(session); break;
			case SessionStatus.Error: errors.push(session); break;
			case SessionStatus.InProgress: working++; break;
		}
	}
	return { needsInput, errors, working };
}
