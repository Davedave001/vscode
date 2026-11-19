/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IChatModelReference, IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatPermissionLevel } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatModel, IChatRequestModel, IChatResponseModel, IResponse } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { ISessionsNavigationService } from '../../../../../workbench/contrib/sessions/browser/sessionsNavigationService.js';
import { ICreateNewSessionOptions, IProviderSessionType, ISendRequestOptions, ISessionsManagementService, NewSessionRequestOptions } from '../../../../../workbench/contrib/sessions/common/sessionsManagement.js';
import { IChat, ISession, ISessionWorkspace, SessionStatus, SessionTypeAuthRequirement } from '../../../../../workbench/services/sessions/common/session.js';
import { AssistantAgentChats } from '../../browser/assistantAgentChats.js';
import { AssistantConversationStore } from '../../browser/assistantConversation.js';

suite('Assistant agent chats', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('creates a background session and routes reads and follow-ups to the same owned chat', async () => {
		const storage = store.add(new InMemoryStorageService());
		const workspaceTrust = upcastPartial<IWorkspaceTrustManagementService>({});
		const folder = URI.parse('file:///selected-workspace');
		const resource = URI.parse('agent-host-codex:/regular-chat');
		const status = observableValue<SessionStatus>('delegate status', SessionStatus.InProgress);
		const chat = upcastPartial<IChat>({
			resource, status, isArchived: constObservable(false),
			title: constObservable('Renamed build check'),
			workspace: constObservable(upcastPartial<ISessionWorkspace>({ label: 'selected-workspace' })),
		});
		const session = upcastPartial<ISession>({ resource, mainChat: constObservable(chat), isArchived: constObservable(false) });
		const agentType: IProviderSessionType = { providerId: 'local', sessionType: { id: 'codex', label: 'Codex', icon: Codicon.hubot, authRequirement: SessionTypeAuthRequirement.None } };
		const launches: { folder: URI; request: NewSessionRequestOptions; options?: ICreateNewSessionOptions }[] = [];
		const followUps: { session: ISession; chat: IChat; request: ISendRequestOptions }[] = [];
		const openedChats: { session: ISession; resource: URI }[] = [];
		const navigation = upcastPartial<ISessionsNavigationService>({ openChat: async (session, resource) => { openedChats.push({ session, resource }); } });
		const incomplete = observableValue('agent reply pending', false);
		const confirmation = observableValue<{ startedWaitingAt: number } | undefined>('agent confirmation', undefined);
		let replyText = 'Initial reply from the regular chat.';
		let releases = 0;
		let transcriptLoaded: DeferredPromise<void> | undefined = undefined;
		const response = upcastPartial<IChatResponseModel>({
			get isComplete() { return !incomplete.get(); },
			isIncomplete: incomplete,
			isPendingConfirmation: confirmation,
			response: upcastPartial<IResponse>({ getFinalResponse: () => replyText }),
		});
		const model = upcastPartial<IChatModel>({
			hasActiveRequest: incomplete,
			requestNeedsInput: confirmation.map(value => value && { title: 'Agent approval' }),
			getRequests: () => {
				void transcriptLoaded?.complete();
				return [upcastPartial<IChatRequestModel>({ response })];
			},
		});
		const sessions = upcastPartial<ISessionsManagementService>({
			getSessionTypesForFolder: uri => { assert.deepStrictEqual(uri, folder); return [agentType]; },
			getSessionForChatResource: uri => uri.toString() === resource.toString() ? { session, chat } : undefined,
			createAndSendNewChatRequest: async (folder, request, options) => { launches.push({ folder, request, options }); return session; },
			sendRequestInBackground: async (session, chat, request) => { followUps.push({ session, chat, request }); status.set(SessionStatus.InProgress, undefined); },
		});
		const chatService = upcastPartial<IChatService>({
			getSession: () => model,
			acquireOrLoadSession: async (uri, location) => {
				assert.deepStrictEqual(uri, resource);
				assert.strictEqual(location, ChatAgentLocation.Chat);
				return upcastPartial<IChatModelReference>({
					object: model,
					dispose: () => { releases++; },
				});
			},
		});
		const fileService = upcastPartial<IFileService>({});
		const bridge = new AssistantAgentChats(sessions, chatService, storage, navigation, fileService, workspaceTrust);
		const target = { workspace: folder, providerId: 'local', sessionTypeId: 'codex' };
		assert.match(bridge.list('owner', target), /Codex: local\/codex/);
		const started = await bridge.start('owner', target, 'Check the build', 'Build check', 'local/codex', CancellationToken.None);
		const id = new AssistantConversationStore(storage).read('owner').agentChats?.[0].id;
		assert.ok(id && started.includes(id));
		assert.deepStrictEqual(bridge.getChats('owner'), [{ id, title: 'Renamed build check', workspaceLabel: 'selected-workspace', status: SessionStatus.InProgress }]);
		assert.deepStrictEqual(bridge.getChats('another-account'), []);
		assert.strictEqual(await bridge.open('another-account', id), false);
		assert.strictEqual(await bridge.open('owner', 'deleted-chat'), false);
		assert.deepStrictEqual(openedChats, []);
		assert.deepStrictEqual(launches, [{ folder, request: { query: 'Check the build', title: 'Build check', background: true, requireConnected: true }, options: { providerId: 'local', sessionTypeId: 'codex', permissionLevel: ChatPermissionLevel.Default } }]);
		assert.match(await bridge.send('owner', id, 'Another question'), /busy/);
		assert.match(await bridge.read('another-account', id, false, CancellationToken.None), /No available agent chat/);
		assert.match(await bridge.send('another-account', id, 'Another question'), /No available agent chat/);
		assert.strictEqual(releases, 0);
		const firstReply = bridge.read('owner', id, true, CancellationToken.None);
		status.set(SessionStatus.Completed, undefined);
		assert.match(await firstReply, /Initial reply from the regular chat/);
		const reopened = new AssistantAgentChats(sessions, chatService, storage, navigation, fileService, workspaceTrust);
		assert.strictEqual(await reopened.open('owner', id), true);
		assert.deepStrictEqual(openedChats, [{ session, resource }]);
		assert.match(await reopened.send('owner', id, 'Check the follow-up'), /Sent the follow-up/);
		assert.deepStrictEqual(followUps, [{ session, chat, request: { query: 'Check the follow-up' } }]);
		status.set(SessionStatus.NeedsInput, undefined);
		assert.match(await reopened.read('owner', id, false, CancellationToken.None), /waiting for user input/);
		// The session still shows the previous turn as completed while the follow-up is streaming.
		incomplete.set(true, undefined);
		status.set(SessionStatus.Completed, undefined);
		assert.strictEqual(reopened.getChats('owner')[0].status, SessionStatus.InProgress);
		assert.match(await reopened.send('owner', id, 'A duplicate follow-up'), /busy/);
		assert.match(await reopened.read('owner', id, false, CancellationToken.None), /is working/);
		confirmation.set({ startedWaitingAt: 1 }, undefined);
		assert.strictEqual(reopened.getChats('owner')[0].status, SessionStatus.NeedsInput);
		assert.match(await reopened.read('owner', id, true, CancellationToken.None), /waiting for user input/);
		confirmation.set(undefined, undefined);
		transcriptLoaded = new DeferredPromise<void>();
		const followUpReply = reopened.read('owner', id, true, CancellationToken.None);
		await transcriptLoaded.p;
		replyText = 'Follow-up reply from the same chat.';
		incomplete.set(false, undefined);
		assert.match(await followUpReply, /Follow-up reply from the same chat/);
		assert.strictEqual(releases, 4);
	});

	test('opens the chosen worktree in folder mode and rejects a missing or redirected checkout', async () => {
		const storage = store.add(new InMemoryStorageService());
		const root = URI.file(isWindows ? 'c:/' : '/');
		const project = URI.joinPath(root, 'project');
		const checkout = URI.joinPath(root, 'project-feature');
		const checkoutMarker = URI.joinPath(checkout, '.git');
		const gitDirectory = URI.joinPath(project, '.git', 'worktrees', 'feature');
		const commonMarker = URI.joinPath(gitDirectory, 'commondir');
		const target = { workspace: project, worktree: { uri: checkout, label: 'feature', identity: { gitDirectory, createdAt: 1 } } };
		const agentType: IProviderSessionType = { providerId: 'local', sessionType: { id: 'codex', label: 'Codex', icon: Codicon.hubot, authRequirement: SessionTypeAuthRequirement.None, supportsWorktreeConfiguration: true } };
		let checkoutExists = true;
		let trusted = true;
		let replacedDuringLaunch = false;
		let replacement = false;
		let backlink = '../../../../project-feature/.git';
		let actualWorkingDirectory = checkout;
		let sent = 0;
		const fileService = upcastPartial<IFileService>({
			exists: async uri => checkoutExists && (uri.path === checkoutMarker.path || uri.path === commonMarker.path),
			stat: async uri => upcastPartial<Awaited<ReturnType<IFileService['stat']>>>({ isDirectory: uri.path !== checkoutMarker.path || replacement, ctime: replacement ? 2 : 1 }),
			realpath: async uri => uri,
			readFile: async uri => upcastPartial<Awaited<ReturnType<IFileService['readFile']>>>({
				value: VSBuffer.fromString(uri.path === checkoutMarker.path ? 'gitdir: ../project/.git/worktrees/feature\n' : backlink),
			}),
		});
		const workspaceTrust = upcastPartial<IWorkspaceTrustManagementService>({ getUriTrustInfo: async uri => ({ uri, trusted }) });
		const sessions = upcastPartial<ISessionsManagementService>({
			getSessionTypesForFolder: uri => { assert.deepStrictEqual(uri, checkout); return [agentType]; },
			createAndSendNewChatRequest: async (uri, _request, options) => {
				assert.deepStrictEqual(uri, checkout);
				assert.strictEqual(options?.isolationMode, 'workspace');
				const session = upcastPartial<ISession>({
					mainChat: constObservable(upcastPartial<IChat>({ resource: URI.parse('agent-host-codex:/worktree-chat') })),
					workspace: constObservable(upcastPartial<ISessionWorkspace>({ folders: [{ root: checkout, workingDirectory: actualWorkingDirectory, name: 'feature', description: undefined }] })),
				});
				replacement ||= replacedDuringLaunch;
				await options.onSessionCreated?.(session);
				sent++;
				return session;
			},
		});
		const bridge = new AssistantAgentChats(sessions, upcastPartial<IChatService>({}), storage, upcastPartial<ISessionsNavigationService>({}), fileService, workspaceTrust);
		const start = () => bridge.start('owner', target, 'Check feature', 'Feature check', undefined, CancellationToken.None);
		assert.match(await start(), /Started Codex/);
		actualWorkingDirectory = project;
		await assert.rejects(start(), /could not open the selected Git worktree/);
		actualWorkingDirectory = checkout;
		backlink = '../../../../another-folder/.git';
		assert.match(await start(), /worktree is unavailable/);
		backlink = '../../../../project-feature/.git';
		assert.strictEqual(await bridge.getWorktreeStatus({ uri: checkout, label: 'feature' }), 'unverified');
		replacedDuringLaunch = true;
		await assert.rejects(start(), /Git checkout at the selected path has changed/);
		assert.match(await start(), /Git checkout at the selected path has changed/);
		replacement = false;
		trusted = false;
		assert.match(await start(), /worktree needs trust/);
		checkoutExists = false;
		assert.match(await start(), /worktree is unavailable/);
		assert.strictEqual(sent, 1);
	});
});
