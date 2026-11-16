/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISession, SessionStatus } from '../../../../../workbench/services/sessions/common/session.js';
import { getSessionAttentionQueue } from '../../browser/sessionAttentionQueue.js';

function session(sessionId: string, status: SessionStatus, archived = false): ISession {
	return upcastPartial<ISession>({ sessionId, status: constObservable(status), isArchived: constObservable(archived) });
}

suite('Session Attention Queue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('separates unresolved input and failures, excludes archives and drafts, and preserves source order', () => {
		const input = [
			session('waiting-one', SessionStatus.NeedsInput), session('working', SessionStatus.InProgress),
			session('failed', SessionStatus.Error), session('done', SessionStatus.Completed),
			session('waiting-two', SessionStatus.NeedsInput), session('draft', SessionStatus.Untitled),
			session('archived-waiting', SessionStatus.NeedsInput, true), session('archived-error', SessionStatus.Error, true),
			session('archived-working', SessionStatus.InProgress, true),
		];
		const queue = getSessionAttentionQueue(input);
		assert.deepStrictEqual({
			waiting: queue.needsInput.map(item => item.sessionId),
			failed: queue.errors.map(item => item.sessionId), working: queue.working,
			unchangedOrder: input.map(item => item.sessionId),
		}, {
			waiting: ['waiting-one', 'waiting-two'], failed: ['failed'], working: 1,
			unchangedOrder: ['waiting-one', 'working', 'failed', 'done', 'waiting-two', 'draft', 'archived-waiting', 'archived-error', 'archived-working'],
		});
	});

	test('reads current provider state when a blocked session resumes and is archived', () => {
		const state = observableValue<SessionStatus>('queueTest.status', SessionStatus.NeedsInput);
		const archived = observableValue('queueTest.archived', false);
		const current = upcastPartial<ISession>({ status: state, isArchived: archived });
		const snapshot = () => {
			const queue = getSessionAttentionQueue([current]);
			return [queue.needsInput.length, queue.errors.length, queue.working];
		};
		const waiting = snapshot();
		state.set(SessionStatus.InProgress, undefined);
		const running = snapshot();
		state.set(SessionStatus.Error, undefined);
		const failed = snapshot();
		archived.set(true, undefined);
		assert.deepStrictEqual([waiting, running, failed, snapshot()], [[1, 0, 0], [0, 0, 1], [0, 1, 0], [0, 0, 0]]);
	});
});
