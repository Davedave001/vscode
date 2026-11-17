/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { autorun, constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChat, ISession, SessionStatus } from '../../../../../workbench/services/sessions/common/session.js';
import { getSessionAttentionQueue } from '../../browser/sessionAttentionQueue.js';

function session(sessionId: string, status: SessionStatus, archived = false, chats: readonly IChat[] = []): ISession {
	return upcastPartial<ISession>({ sessionId, status: constObservable(status), isArchived: constObservable(archived), chats: constObservable(chats) });
}

function chat(id: string, status: SessionStatus): IChat {
	return upcastPartial<IChat>({ resource: URI.parse(`test:/${id}`), status: constObservable(status) });
}

suite('Session Attention Queue', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

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
			waiting: queue.needsInput.map(item => item.session.sessionId),
			failed: queue.errors.map(item => item.session.sessionId), working: queue.working,
			unchangedOrder: input.map(item => item.sessionId),
		}, {
			waiting: ['waiting-one', 'waiting-two'], failed: ['failed'], working: 1,
			unchangedOrder: ['waiting-one', 'working', 'failed', 'done', 'waiting-two', 'draft', 'archived-waiting', 'archived-error', 'archived-working'],
		});
	});

	test('reads current provider state when a blocked session resumes and is archived', () => {
		const state = observableValue<SessionStatus>('queueTest.status', SessionStatus.NeedsInput);
		const archived = observableValue('queueTest.archived', false);
		const current = upcastPartial<ISession>({ status: state, isArchived: archived, chats: constObservable([]) });
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

	test('includes actionable child chats even when the parent is completed and counts working sessions once', () => {
		const current = session('parent', SessionStatus.Completed, false, [chat('main', SessionStatus.Completed), chat('waiting-a', SessionStatus.NeedsInput), chat('failed', SessionStatus.Error), chat('waiting-b', SessionStatus.NeedsInput), chat('working-a', SessionStatus.InProgress), chat('working-b', SessionStatus.InProgress), chat('draft', SessionStatus.Untitled)]);
		const queue = getSessionAttentionQueue([current]);
		assert.deepStrictEqual({ waiting: queue.needsInput.map(item => item.chat?.resource.path), errors: queue.errors.map(item => item.chat?.resource.path), working: queue.working }, { waiting: ['/waiting-a', '/waiting-b'], errors: ['/failed'], working: 1 });
	});

	test('does not duplicate aggregate alerts already represented by a chat and retains unresolved aggregate alerts', () => {
		const known = session('known', SessionStatus.NeedsInput, false, [chat('waiting', SessionStatus.NeedsInput), chat('failed', SessionStatus.Error)]);
		const unresolved = session('unresolved', SessionStatus.Error);
		const pendingMetadata = session('pending-metadata', SessionStatus.NeedsInput, false, [chat('peer-failed', SessionStatus.Error)]);
		const queue = getSessionAttentionQueue([known, unresolved, pendingMetadata]);
		assert.deepStrictEqual(queue.needsInput.map(item => [item.session.sessionId, item.chat?.resource.path]), [['known', '/waiting'], ['pending-metadata', undefined]]);
		assert.deepStrictEqual(queue.errors.map(item => [item.session.sessionId, item.chat?.resource.path]), [['known', '/failed'], ['unresolved', undefined], ['pending-metadata', '/peer-failed']]);
	});

	test('excludes every chat of an archived session or an unsent draft', () => {
		const children = [chat('waiting', SessionStatus.NeedsInput), chat('failed', SessionStatus.Error), chat('working', SessionStatus.InProgress)];
		assert.deepStrictEqual(getSessionAttentionQueue([session('archived', SessionStatus.NeedsInput, true, children), session('draft', SessionStatus.Untitled, false, children)]), { needsInput: [], errors: [], working: 0 });
	});

	test('reacts to per-chat status and membership changes without an aggregate status change', () => {
		const state = observableValue<SessionStatus>('queueTest.chatStatus', SessionStatus.NeedsInput);
		const child = upcastPartial<IChat>({ resource: URI.parse('test:/child'), status: state });
		const chats = observableValue<readonly IChat[]>('queueTest.chats', [child]);
		const current = upcastPartial<ISession>({ status: constObservable(SessionStatus.Completed), isArchived: constObservable(false), chats });
		const snapshots: number[][] = [];
		store.add(autorun(reader => { const queue = getSessionAttentionQueue([current], reader); snapshots.push([queue.needsInput.length, queue.errors.length, queue.working]); }));
		state.set(SessionStatus.Error, undefined);
		state.set(SessionStatus.InProgress, undefined);
		chats.set([], undefined);
		assert.deepStrictEqual(snapshots, [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]]);
	});
});
