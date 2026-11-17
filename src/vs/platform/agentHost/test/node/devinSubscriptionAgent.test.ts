/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AcpClient } from '../../node/acp/acpClient.js';
import { DevinSubscriptionAgent, DEVIN_SUBSCRIPTION_RESOURCE, devinSubscriptionEnvironment, parseDevinModels } from '../../node/acp/devinSubscriptionAgent.js';
import { ActionType, isChatAction } from '../../common/state/sessionActions.js';
import { type AgentSignal } from '../../common/agent.js';
import { Event } from '../../../../base/common/event.js';
import { TestAcpTransport } from './acpTestUtils.js';
import { MessageAttachmentKind, type MessageAttachment, type ChatState, MessageKind, ResponsePartKind, SessionStatus, ToolCallStatus, ToolCallConfirmationReason, ToolCallCancellationReason, ToolResultContentType, TurnState } from '../../common/state/sessionState.js';
import { chatReducer } from '../../common/state/protocol/reducers.js';
import { resolveAcpPrompt } from '../../node/acp/acpPromptResolver.js';

const catalog = { families: [{ variants: [{ model_uid: 'swe-2-high', label: 'SWE-2 High', max_context_tokens: 262000 }] }] };
const chat = URI.parse('agent-host-chat://devin-subscription/chat');
const owner = URI.parse('agent-host-devin-subscription:/session');
const cwd = URI.file('/project with spaces');

function toolUpdate(transport: TestAcpTransport, update: Record<string, unknown>): void {
	transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update } });
}

suite('Devin Subscription Agent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function fixture(modelCatalog = catalog) {
		const transports: TestAcpTransport[] = [];
		const launches: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		const events: AgentSignal[] = [];
		let onPrompt: ((transport: TestAcpTransport, request: Record<string, unknown>) => void) | undefined;
		let onLoad: typeof onPrompt;
		let onConfig: typeof onPrompt;
		let onInitialize: typeof onPrompt;
		const agent = store.add(new DevinSubscriptionAgent('devin.exe', {
			listModels: async () => modelCatalog,
			createClient: (_cwd, args, env) => {
				const configOptions = [{ id: 'model-choice', category: 'model', type: 'select', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high', name: 'SWE-2' }] }];
				launches.push({ args, env });
				const transport = new TestAcpTransport();
				transports.push(transport);
				transport.handle = request => {
					switch (request.method) {
						case 'initialize':
							if (onInitialize) { onInitialize(transport, request); } else { transport.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } }); }
							break;
						case 'session/new': transport.reply(request, { sessionId: 'native', configOptions }); break;
						case 'session/load':
							if (onLoad) { onLoad(transport, request); break; }
							transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'original' } } } });
							transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'restored' } } } });
							transport.reply(request, { configOptions }); break;
						case 'session/set_config_option':
							if (onConfig) { onConfig(transport, request); } else { transport.reply(request, { configOptions }); }
							break;
						case 'session/prompt': if (onPrompt) { onPrompt(transport, request); } else { transport.reply(request, { stopReason: 'end_turn' }); } break;
					}
				};
				return new AcpClient(transport);
			},
		}));
		store.add(agent.onDidChatProgress(event => events.push(event)));
		return { agent, transports, launches, events, set onPrompt(value: typeof onPrompt) { onPrompt = value; }, set onLoad(value: typeof onLoad) { onLoad = value; }, set onConfig(value: typeof onConfig) { onConfig = value; }, set onInitialize(value: typeof onInitialize) { onInitialize = value; } };
	}

	test('keeps subscription credentials separate from inherited CLI credentials and parses a live catalog shape', () => {
		const inherited = { WINDSURF_API_KEY: 'other-account', windsurf_api_key: 'case-variant', PATH: 'keep' };
		assert.deepStrictEqual(devinSubscriptionEnvironment('browser-token', inherited), { PATH: 'keep', WINDSURF_API_KEY: 'devin-session-token$browser-token' });
		assert.strictEqual(inherited.WINDSURF_API_KEY, 'other-account');
		assert.strictEqual(parseDevinModels(catalog)[0].id, 'swe-2-high');
		assert.strictEqual(parseDevinModels(catalog)[0].maxContextWindow, 262000);
	});

	test('loads models only after the editor forwards a subscription account and clears them on sign-out', async () => {
		const { agent, launches } = fixture();
		assert.deepStrictEqual(agent.models.get(), []);
		await agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		assert.strictEqual(agent.models.get().length, 1);
		assert.strictEqual(launches.length, 0);
		await agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, '');
		assert.deepStrictEqual(agent.models.get(), []);
	});

	test('defers the client, uses the selected model, and streams to the exact host turn', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd], model: { id: 'swe-2-high' } });
		assert.strictEqual(f.launches.length, 0);
		f.onPrompt = (transport, request) => {
			transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'different-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } } } });
			for (const text of ['hello ', 'world']) { transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }); }
			transport.reply(request, { stopReason: 'end_turn' });
		};
		await f.agent.chats.sendMessage(chat, 'prompt', [cwd], undefined, 'host-turn');
		assert.deepStrictEqual(f.launches[0].args, ['acp', '--model', 'swe-2-high']);
		assert.strictEqual(f.launches[0].env.WINDSURF_API_KEY, 'devin-session-token$browser-token');
		const deltas = f.events.filter(event => event.kind === 'action' && event.action.type === ActionType.ChatDelta);
		assert.strictEqual(deltas.length, 2);
		assert.strictEqual(f.events.at(-1)?.kind, 'action');
		const turns = await f.agent.chats.getMessages(chat, owner);
		assert.strictEqual(turns[0].id, 'host-turn');
		assert.strictEqual(turns[0].responseParts.length, 1);
	});

	test('waits for a host permission decision and never selects an always-allow option implicitly', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		let promptRequest: Record<string, unknown>;
		f.onPrompt = (transport, request) => {
			promptRequest = request;
			transport.receive({ jsonrpc: '2.0', id: request.id, method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'tool', title: 'Run command', rawInput: { command: 'read', path: 'README.md' } }, options: [{ optionId: 'forever', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
		};
		const send = f.agent.chats.sendMessage(chat, 'prompt', [cwd], undefined, 'host-turn');
		await new Promise<void>(resolve => {
			const listener = f.agent.onDidChatProgress(event => { if (event.kind === 'pending_confirmation') { listener.dispose(); resolve(); } });
			store.add(listener);
		});
		assert.ok(f.events.some(event => event.kind === 'pending_confirmation'));
		const transport = f.transports[0];
		toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', rawInput: { path: 'README.md', command: 'read' } });
		assert.ok(!transport.sent.some(message => Object.hasOwn(message, 'result')));
		const replied = Event.toPromise(Event.filter(transport.onSend, message => Object.hasOwn(message, 'result')));
		f.agent.respondToPermissionRequest('host-turn:tool', true);
		await replied;
		const response = transport.sent.find(message => Object.hasOwn(message, 'result'));
		assert.deepStrictEqual(response?.result, { outcome: { outcome: 'selected', optionId: 'once' } });
		toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'in_progress' });
		toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'done' });
		transport.reply(promptRequest!, { stopReason: 'end_turn' });
		await send;
		const approved = (await f.agent.chats.getMessages(chat, owner))[0].responseParts[0];
		assert.ok(approved.kind === ResponsePartKind.ToolCall && approved.toolCall.status === ToolCallStatus.Completed);
		assert.strictEqual(approved.toolCall.confirmed, ToolCallConfirmationReason.UserAction);
		assert.strictEqual(approved.toolCall.success, true);
	});

	test('retains intermediate tool output and full input when the completion omits them', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		f.onPrompt = (transport, request) => {
			toolUpdate(transport, { sessionUpdate: 'tool_call', toolCallId: 'read', name: 'read_file', title: 'Read file', status: 'pending', rawInput: { path: 'D:/project with spaces/README.md' } });
			toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'file content 🌎' } }] });
			toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
			transport.reply(request, { stopReason: 'end_turn' });
		};
		await f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		const part = (await f.agent.chats.getMessages(chat, owner))[0].responseParts[0];
		assert.ok(part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Completed);
		assert.strictEqual(part.toolCall.toolInput, JSON.stringify({ path: 'D:/project with spaces/README.md' }, undefined, 2));
		assert.deepStrictEqual(part.toolCall.content, [{ type: ToolResultContentType.Text, text: 'file content 🌎' }]);
		assert.strictEqual(f.events.filter(event => event.kind === 'action' && event.action.type === ActionType.ChatToolCallContentChanged).length, 1);
	});

	test('keeps the latest raw output and updates running metadata without losing the result', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		f.onPrompt = (transport, request) => {
			toolUpdate(transport, { sessionUpdate: 'tool_call', toolCallId: 'run', title: 'Run', status: 'in_progress', rawInput: 'old command', rawOutput: 'first output' });
			toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'run', title: 'Read public file', rawInput: 'new command', rawOutput: 'latest output' });
			toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'run', status: 'completed', rawInput: null, rawOutput: null });
			transport.reply(request, { stopReason: 'end_turn' });
		};
		await f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		const part = (await f.agent.chats.getMessages(chat, owner))[0].responseParts[0];
		assert.ok(part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Completed);
		assert.strictEqual(part.toolCall.toolInput, 'new command');
		assert.strictEqual(part.toolCall.invocationMessage, 'Read public file');
		assert.deepStrictEqual(part.toolCall.content, [{ type: ToolResultContentType.Text, text: 'latest output' }]);
	});

	test('finalizes a running tool with its partial result when the prompt transport fails', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		f.onPrompt = (transport, _request) => {
			toolUpdate(transport, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file', status: 'in_progress', rawOutput: 'partial content' });
			transport.close();
		};
		await assert.rejects(f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn'), /peer exited/);
		const complete = f.events.flatMap(event => event.kind === 'action' && event.action.type === ActionType.ChatToolCallComplete ? [event.action] : []);
		assert.strictEqual(complete.length, 1);
		assert.strictEqual(complete[0].result.success, false);
		assert.deepStrictEqual(complete[0].result.content, [{ type: ToolResultContentType.Text, text: 'partial content' }]);
	});

	test('preserves a denial as cancelled in history and ignores a late successful tool update', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		let promptRequest: Record<string, unknown>;
		f.onPrompt = (transport, request) => {
			promptRequest = request;
			transport.receive({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'read', title: 'Read file', rawInput: { path: 'README.md' } }, options: [{ optionId: 'deny', kind: 'reject_once' }] } });
		};
		const pending = Event.toPromise(Event.filter(f.agent.onDidChatProgress, event => event.kind === 'pending_confirmation'));
		const send = f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		await pending;
		f.agent.respondToPermissionRequest('host-turn:read', false);
		const transport = f.transports[0];
		toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'late output' });
		transport.reply(promptRequest!, { stopReason: 'end_turn' });
		await send;
		const part = (await f.agent.chats.getMessages(chat, owner))[0].responseParts[0];
		assert.ok(part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Cancelled);
		assert.strictEqual(part.toolCall.reason, ToolCallCancellationReason.Denied);
		assert.strictEqual(part.toolCall.toolInput, JSON.stringify({ path: 'README.md' }, undefined, 2));
	});

	test('cancels a permission when its input changes and does not accept a stale approval', async () => {
		const f = fixture();
		let host: ChatState = { resource: chat.toString(), title: 'Test', status: SessionStatus.Idle, modifiedAt: new Date(0).toISOString(), turns: [], activeTurn: { id: 'host-turn', startedAt: new Date(0).toISOString(), message: { text: 'read', origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined } };
		store.add(f.agent.onDidChatProgress(event => { if (event.kind === 'action' && isChatAction(event.action)) { host = chatReducer(host, event.action); } }));
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		let promptRequest: Record<string, unknown>;
		f.onPrompt = (transport, request) => {
			promptRequest = request;
			transport.receive({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'run', title: 'Read file', rawInput: { command: 'read README.md' } }, options: [{ optionId: 'once', kind: 'allow_once' }] } });
		};
		const pending = Event.toPromise(Event.filter(f.agent.onDidChatProgress, event => event.kind === 'pending_confirmation'));
		const send = f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		await pending;
		const transport = f.transports[0];
		const response = Event.toPromise(Event.filter(transport.onSend, message => message.id === 'permission' && Object.hasOwn(message, 'result')));
		toolUpdate(transport, { sessionUpdate: 'tool_call_update', toolCallId: 'run', rawInput: { command: 'different command' } });
		f.agent.respondToPermissionRequest('host-turn:run', true);
		assert.deepStrictEqual((await response).result, { outcome: { outcome: 'cancelled' } });
		assert.ok(f.events.some(event => event.kind === 'action' && event.action.type === ActionType.ChatToolCallConfirmed && !event.action.approved));
		const cancelled = host.activeTurn?.responseParts[0];
		assert.ok(cancelled?.kind === ResponsePartKind.ToolCall && cancelled.toolCall.status === ToolCallStatus.Cancelled);
		assert.strictEqual(cancelled.toolCall.reason, ToolCallCancellationReason.Skipped);
		transport.reply(promptRequest!, { stopReason: 'end_turn' });
		await send;
		assert.strictEqual(host.activeTurn, undefined);
		assert.strictEqual(host.turns.length, 1);
	});

	test('keeps an aborted tool turn cancelled even when the process closes instead of replying', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		f.onPrompt = transport => {
			toolUpdate(transport, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file', status: 'in_progress' });
			store.add(transport.onSend(message => { if (message.method === 'session/cancel') { transport.close(); } }));
		};
		const started = Event.toPromise(Event.filter(f.agent.onDidChatProgress, event => event.kind === 'action' && event.action.type === ActionType.ChatToolCallStart));
		const send = f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		const rejected = assert.rejects(send, /peer exited/);
		await started;
		const history = await f.agent.chats.getMessages(chat, owner);
		await f.agent.chats.abort(chat, owner);
		await rejected;
		assert.strictEqual(history[0].state, TurnState.Cancelled);
		const completed = f.events.flatMap(event => event.kind === 'action' && event.action.type === ActionType.ChatToolCallComplete ? [event.action] : []);
		assert.strictEqual(completed.length, 1);
		assert.strictEqual(completed[0].result.success, false);
	});

	test('repeated Stop does not leave a deadline that kills the next turn', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const firstPrompt = new DeferredPromise<Record<string, unknown>>();
			f.onPrompt = (_transport, request) => { void firstPrompt.complete(request); };
			const first = f.agent.chats.sendMessage(chat, 'first', [cwd], undefined, 'first-turn');
			const firstRequest = await firstPrompt.p;
			await f.agent.chats.abort(chat, owner);
			await f.agent.chats.abort(chat, owner);
			f.transports[0].reply(firstRequest, { stopReason: 'cancelled' });
			await first;
			const secondPrompt = new DeferredPromise<Record<string, unknown>>();
			f.onPrompt = (_transport, request) => { void secondPrompt.complete(request); };
			const second = f.agent.chats.sendMessage(chat, 'second', [cwd], undefined, 'second-turn').then(() => undefined, error => error);
			const secondRequest = await secondPrompt.p;
			await clock.tickAsync(2100);
			f.transports[0].reply(secondRequest, { stopReason: 'end_turn' });
			assert.strictEqual(await second, undefined);
			assert.strictEqual(f.transports[0].sent.filter(message => message.method === 'session/cancel').length, 1);
			assert.strictEqual(f.launches.length, 1);
		} finally { clock.restore(); }
	});

	test('Stop before process startup prevents the prompt and permits a later turn', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		const send = f.agent.chats.sendMessage(chat, 'stopped', [cwd], undefined, 'stopped-turn');
		const rejected = assert.rejects(send, error => isCancellationError(error));
		await f.agent.chats.abort(chat, owner);
		await rejected;
		assert.strictEqual(f.launches.length, 0);
		await f.agent.chats.sendMessage(chat, 'retry', [cwd], undefined, 'retry-turn');
		assert.strictEqual(f.launches.length, 1);
	});

	test('forces an unresponsive stopped client closed and resumes the same conversation on the next turn', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd], model: { id: 'swe-2-high' } });
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const started = new DeferredPromise<void>();
			f.onPrompt = transport => {
				toolUpdate(transport, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file', status: 'in_progress', rawOutput: 'partial content' });
				void started.complete();
			};
			const stopped = f.agent.chats.sendMessage(chat, 'stopped', [cwd], undefined, 'stopped-turn').then(() => undefined, error => error);
			await started.p;
			const history = await f.agent.chats.getMessages(chat, owner);
			await f.agent.chats.abort(chat, owner);
			await clock.tickAsync(2001);
			assert.ok(isCancellationError(await stopped));
			assert.strictEqual(history[0].state, TurnState.Cancelled);
			const tool = history[0].responseParts[0];
			assert.ok(tool.kind === ResponsePartKind.ToolCall && tool.toolCall.status === ToolCallStatus.Completed);
			assert.strictEqual(tool.toolCall.success, false);
			assert.deepStrictEqual(tool.toolCall.content, [{ type: ToolResultContentType.Text, text: 'partial content' }]);
			f.onPrompt = undefined;
			await f.agent.chats.sendMessage(chat, 'retry', [cwd], undefined, 'retry-turn');
			assert.strictEqual(f.launches.length, 2);
			assert.deepStrictEqual(f.launches[1].args, ['acp', '--model', 'swe-2-high']);
			const requests = f.transports[1].sent;
			assert.ok(!requests.some(message => message.method === 'session/new'));
			assert.deepStrictEqual(requests.find(message => message.method === 'session/load')?.params, { sessionId: 'native', cwd: cwd.fsPath, mcpServers: [] });
			assert.strictEqual(requests.filter(message => message.method === 'session/prompt').length, 1);
		} finally { clock.restore(); }
	});

	test('a competing send or model change cannot change the workspace while a turn prepares', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd], model: { id: 'swe-2-high' } });
		const started = new DeferredPromise<{ transport: TestAcpTransport; request: Record<string, unknown> }>();
		f.onInitialize = (transport, request) => { void started.complete({ transport, request }); };
		const send = f.agent.chats.sendMessage(chat, 'first', [cwd], undefined, 'first-turn');
		const { transport, request } = await started.p;
		await assert.rejects(f.agent.chats.sendMessage(chat, 'competing', [URI.file('/another project')], undefined, 'other-turn'), /turn is already running/);
		await assert.rejects(f.agent.chats.changeModel(chat, { id: 'another-model' }, owner), /Wait for the current Devin turn/);
		transport.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
		await send;
		assert.strictEqual(f.launches.length, 1);
		assert.deepStrictEqual(transport.sent.find(message => message.method === 'session/new')?.params, { cwd: cwd.fsPath, mcpServers: [] });
		assert.strictEqual(transport.sent.filter(message => message.method === 'session/prompt').length, 1);
	});

	for (const phase of ['initialize', 'load'] as const) {
		test(`Stop cancels pending ${phase} and ignores its late response without sending a prompt`, async () => {
			const f = fixture();
			await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
			if (phase === 'load') {
				await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), model: 'swe-2-high' }));
			} else {
				await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
			}
			const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				const started = new DeferredPromise<{ transport: TestAcpTransport; request: Record<string, unknown> }>();
				const onSetup = (transport: TestAcpTransport, request: Record<string, unknown>) => { void started.complete({ transport, request }); };
				if (phase === 'initialize') { f.onInitialize = onSetup; } else { f.onLoad = onSetup; }
				const result = f.agent.chats.sendMessage(chat, 'stopped', [cwd], undefined, 'stopped-turn').then(() => undefined, error => error);
				const { transport, request } = await started.p;
				await f.agent.chats.abort(chat, owner);
				transport.reply(request, phase === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : { configOptions: [] });
				await clock.tickAsync(1);
				assert.ok(isCancellationError(await result));
				assert.ok(!transport.sent.some(message => message.method === 'session/prompt'));
				assert.ok(!transport.sent.some(message => message.method === 'session/cancel'));
				f.onInitialize = undefined;
				f.onLoad = undefined;
				await f.agent.chats.sendMessage(chat, 'retry', [cwd], undefined, 'retry-turn');
				assert.strictEqual(f.launches.length, 2);
				assert.strictEqual(f.transports[1].sent.filter(message => message.method === (phase === 'load' ? 'session/load' : 'session/new')).length, 1);
			} finally { clock.restore(); }
		});
	}

	test('declines new permission requests after Stop without asking the user to approve', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		const prompt = new DeferredPromise<{ transport: TestAcpTransport; request: Record<string, unknown> }>();
		f.onPrompt = (transport, request) => { void prompt.complete({ transport, request }); };
		const send = f.agent.chats.sendMessage(chat, 'prompt', [cwd], undefined, 'stopped-turn');
		const { transport, request } = await prompt.p;
		await f.agent.chats.abort(chat, owner);
		const response = Event.toPromise(Event.filter(transport.onSend, message => message.id === 'late-permission'));
		transport.receive({ jsonrpc: '2.0', id: 'late-permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'late-tool', title: 'Late tool' }, options: [{ kind: 'allow_once', optionId: 'once' }] } });
		assert.deepStrictEqual((await response).result, { outcome: { outcome: 'cancelled' } });
		assert.ok(!f.events.some(event => event.kind === 'pending_confirmation'));
		// A normal completion can race with Stop; the user's cancellation still wins.
		transport.reply(request, { stopReason: 'end_turn' });
		await send;
		assert.strictEqual((await f.agent.chats.getMessages(chat, owner))[0].state, TurnState.Cancelled);
	});

	test('settles a superseded permission RPC and requires a decision for the replacement request', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		let promptRequest: Record<string, unknown>;
		f.onPrompt = (transport, request) => {
			promptRequest = request;
			transport.receive({ jsonrpc: '2.0', id: 'first-permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'read', title: 'Read file' }, options: [{ optionId: 'first-once', kind: 'allow_once' }] } });
		};
		const pending = Event.toPromise(Event.filter(f.agent.onDidChatProgress, event => event.kind === 'pending_confirmation'));
		const send = f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		await pending;
		const transport = f.transports[0];
		const first = Event.toPromise(Event.filter(transport.onSend, message => message.id === 'first-permission'));
		transport.receive({ jsonrpc: '2.0', id: 'second-permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'read', title: 'Read another file', rawInput: 'another.md' }, options: [{ optionId: 'second-once', kind: 'allow_once' }] } });
		assert.deepStrictEqual((await first).result, { outcome: { outcome: 'cancelled' } });
		const second = Event.toPromise(Event.filter(transport.onSend, message => message.id === 'second-permission'));
		f.agent.respondToPermissionRequest('host-turn:read', true);
		assert.deepStrictEqual((await second).result, { outcome: { outcome: 'selected', optionId: 'second-once' } });
		transport.reply(promptRequest!, { stopReason: 'end_turn' });
		await send;
	});

	test('does not turn an ordinary approval into an always-allow choice when no one-time option exists', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		let promptRequest: Record<string, unknown>;
		f.onPrompt = (transport, request) => {
			promptRequest = request;
			transport.receive({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'read', title: 'Read file' }, options: [{ optionId: 'forever', kind: 'allow_always' }] } });
		};
		const pending = Event.toPromise(Event.filter(f.agent.onDidChatProgress, event => event.kind === 'pending_confirmation'));
		const send = f.agent.chats.sendMessage(chat, 'read', [cwd], undefined, 'host-turn');
		await pending;
		const transport = f.transports[0];
		const response = Event.toPromise(Event.filter(transport.onSend, message => message.id === 'permission' && Object.hasOwn(message, 'result')));
		f.agent.respondToPermissionRequest('host-turn:read', true);
		assert.deepStrictEqual((await response).result, { outcome: { outcome: 'cancelled' } });
		transport.reply(promptRequest!, { stopReason: 'end_turn' });
		await send;
	});

	test('sends a plain greeting with automatic context and preserves the attachments in history', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		const attachments: MessageAttachment[] = [
			{ type: MessageAttachmentKind.Simple, label: 'Workspace context', modelRepresentation: 'Current workspace: example' },
			{ type: MessageAttachmentKind.Simple, label: 'Display-only completion' },
			{ type: MessageAttachmentKind.EmbeddedResource, label: 'Unsaved editor', contentType: 'text/plain', data: Buffer.from('live editor text 🌎').toString('base64') },
		];
		await f.agent.chats.sendMessage(chat, 'hey', [cwd], attachments, 'greeting');
		const request = f.transports[0].sent.find(message => message.method === 'session/prompt');
		const params = request?.params as { prompt: { text: string }[] };
		assert.deepStrictEqual(params.prompt.map(block => block.text), ['hey', 'Current workspace: example', 'Unsaved editor (read-only attached content):\nlive editor text 🌎']);
		assert.deepStrictEqual((await f.agent.chats.getMessages(chat, owner))[0].message.attachments, attachments);
	});

	test('preserves file selection references and only sends binary content with an advertised capability', () => {
		const resource: MessageAttachment = { type: MessageAttachmentKind.Resource, label: 'source.ts', uri: URI.file('/project/source.ts').toString(), selection: { range: { start: { line: 2, character: 0 }, end: { line: 5, character: 0 } } } };
		const blocks = resolveAcpPrompt('inspect', [resource], {});
		assert.strictEqual(blocks[1].type, 'resource_link');
		assert.strictEqual(blocks[1].uri, resource.uri);
		assert.match(String(blocks[2].text), /lines 3-5/);
		const image: MessageAttachment = { type: MessageAttachmentKind.EmbeddedResource, label: 'screen.png', contentType: 'image/png', data: 'AA==' };
		assert.throws(() => resolveAcpPrompt('inspect', [image], {}), /screen\.png/);
		assert.deepStrictEqual(resolveAcpPrompt('inspect', [image], { image: true })[1], { type: 'image', mimeType: 'image/png', data: 'AA==' });
		const document: MessageAttachment = { ...image, label: 'document.pdf', contentType: 'application/pdf' };
		const embedded = resolveAcpPrompt('inspect', [document], { embeddedContext: true })[1];
		assert.strictEqual(embedded.type, 'resource');
		assert.deepStrictEqual(embedded.resource, { uri: 'attachment:/document.pdf', mimeType: 'application/pdf', blob: 'AA==' });
	});

	test('restores the provider session with replay instead of creating another conversation', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString() }));
		const turns = await f.agent.chats.getMessages(chat, owner);
		assert.strictEqual(turns[0].message.text, 'original');
		assert.ok(f.transports[0].sent.some(message => message.method === 'session/load'));
		assert.ok(!f.transports[0].sent.some(message => message.method === 'session/new'));
		assert.deepStrictEqual(f.events, []);
	});

	test('exposes persisted metadata before materialization and restores model, folder, and timestamps without starting a client', async () => {
		const f = fixture();
		const data = JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), model: 'swe-2-high', createdAt: 1000, modifiedAt: 2000 });
		const metadata = await f.agent.getChatMetadata(chat, owner, data);
		assert.strictEqual(metadata?.startTime, 1000);
		assert.strictEqual(metadata?.modifiedTime, 2000);
		assert.deepStrictEqual(metadata?.model, { id: 'swe-2-high' });
		assert.deepStrictEqual(metadata?.workingDirectories?.map(uri => uri.toString()), [cwd.toString()]);
		assert.strictEqual(f.launches.length, 0);
		await f.agent.materializeChat(chat, owner, data);
		const materialized = await f.agent.getChatMetadata(chat, owner);
		assert.strictEqual(materialized?.startTime, metadata?.startTime);
		assert.strictEqual(materialized?.modifiedTime, metadata?.modifiedTime);
		assert.deepStrictEqual(materialized?.model, metadata?.model);
		assert.strictEqual(materialized?.project?.uri.toString(), cwd.toString());
		assert.strictEqual(f.launches.length, 0);
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.getMessages(chat, owner);
		assert.deepStrictEqual(f.launches[0].args, ['acp', '--model', 'swe-2-high']);
		assert.ok(!f.transports[0].sent.some(message => message.method === 'session/set_config_option'));
		assert.strictEqual((await f.agent.getChatMetadata(chat, owner))?.startTime, 1000);
	});

	test('rejects corrupt or nonlocal backings without starting a client and accepts the older timestamp format', async () => {
		const f = fixture();
		for (const data of ['{', JSON.stringify({ version: 1, sessionId: '', cwd: cwd.toString() }), JSON.stringify({ version: 1, sessionId: 'native', cwd: 'https://example.com' })]) {
			assert.strictEqual(await f.agent.getChatMetadata(chat, owner, data), undefined);
			await assert.rejects(f.agent.materializeChat(chat, owner, data), /Invalid persisted Devin chat/);
		}
		const old = await f.agent.getChatMetadata(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), createdAt: 1000 }));
		assert.strictEqual(old?.modifiedTime, 1000);
		assert.deepStrictEqual(f.launches, []);
	});

	test('preserves a restored variant represented by separate native model and thinking selectors', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), model: 'swe-2-max', createdAt: 1000 }));
		f.onLoad = (transport, request) => transport.reply(request, { configOptions: [
			{ id: 'model', category: 'model', type: 'select', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high', name: 'SWE-2' }] },
			{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'max', options: [{ value: 'high' }, { value: 'max' }] },
		] });
		await f.agent.chats.getMessages(chat, owner);
		assert.deepStrictEqual((await f.agent.getChatMetadata(chat, owner))?.model, { id: 'swe-2-max' });
		// The host reconciles its model selection before every outgoing turn.
		await f.agent.chats.changeModel(chat, { id: 'swe-2-max', config: {} }, owner);
		assert.ok(!f.transports[0].sent.some(message => message.method === 'session/set_config_option'));
	});

	test('keeps the previous transcript when a replay fails partway, then allows a clean retry', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString() }));
		const turns = await f.agent.chats.getMessages(chat, owner);
		const previous = structuredClone(turns);
		await f.agent.chats.releaseChat(chat, owner);
		f.onLoad = (transport, request) => {
			transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'incomplete replay' } } } });
			transport.receive({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Replay interrupted' } });
		};
		await assert.rejects(f.agent.chats.getMessages(chat, owner), /Replay interrupted/);
		assert.deepStrictEqual(turns, previous);
		f.onLoad = undefined;
		const retried = await f.agent.chats.getMessages(chat, owner);
		assert.strictEqual(retried.length, 1);
		assert.strictEqual(retried[0].message.text, 'original');
		assert.strictEqual(f.transports.length, 3);
		assert.ok(f.transports.every(transport => transport.sent.every(message => message.method !== 'session/new')));
	});

	test('reopens a released native session before applying an explicit model change', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), model: 'swe-2-max' }));
		await f.agent.chats.changeModel(chat, { id: 'swe-2-high' }, owner);
		const methods = f.transports[0].sent.map(request => request.method);
		assert.ok(methods.indexOf('session/load') < methods.indexOf('session/set_config_option'));
		assert.ok(!methods.includes('session/new'));
		assert.deepStrictEqual((await f.agent.getChatMetadata(chat, owner))?.model, { id: 'swe-2-high' });
	});

	test('persists the latest activity timestamp when a turn completes', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.chats.createChat(chat, owner, { workingDirectories: [cwd] });
		let saved: string | undefined;
		store.add(f.agent.onDidChangeChatData(event => { saved = event.providerData; }));
		await f.agent.chats.sendMessage(chat, 'hey', [cwd], undefined, 'host-turn');
		assert.ok(saved);
		const savedMetadata = await fixture().agent.getChatMetadata(chat, owner, saved);
		const live = await f.agent.getChatMetadata(chat, owner);
		assert.strictEqual(savedMetadata?.startTime, live?.startTime);
		assert.strictEqual(savedMetadata?.modifiedTime, live?.modifiedTime);
		assert.strictEqual(savedMetadata?.project?.uri.toString(), cwd.toString());
	});

	test('persists an unconfirmed model change and reconciles the previous model after a new host loads it', async () => {
		const modelCatalog = { families: [{ variants: [...catalog.families[0].variants, { model_uid: 'swe-2-max', label: 'SWE-2 Max', max_context_tokens: 262000 }] }] };
		const f = fixture(modelCatalog);
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), model: 'swe-2-high' }));
		let saved: string | undefined;
		store.add(f.agent.onDidChangeChatData(event => { saved = event.providerData; }));
		f.onConfig = transport => transport.close();
		await assert.rejects(f.agent.chats.changeModel(chat, { id: 'swe-2-max' }, owner), /peer exited/);
		assert.ok(saved);
		assert.strictEqual(JSON.parse(saved).modelNeedsReconciliation, true);
		assert.strictEqual(JSON.parse(saved).model, 'swe-2-high');
		const resumed = fixture(modelCatalog);
		await resumed.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await resumed.agent.materializeChat(chat, owner, saved);
		let recovered: string | undefined;
		store.add(resumed.agent.onDidMaterializeChat(event => { recovered = event.result?.providerData; }));
		await resumed.agent.chats.getMessages(chat, owner);
		assert.ok(resumed.transports[0].sent.some(request => request.method === 'session/set_config_option'));
		assert.ok(recovered);
		assert.strictEqual(JSON.parse(recovered).modelNeedsReconciliation, undefined);
		assert.strictEqual(JSON.parse(recovered).model, 'swe-2-high');
	});

	test('allows selecting an available model when the previous unconfirmed model is no longer in the catalog', async () => {
		const f = fixture();
		await f.agent.authenticate(DEVIN_SUBSCRIPTION_RESOURCE, 'browser-token');
		await f.agent.materializeChat(chat, owner, JSON.stringify({ version: 1, sessionId: 'native', cwd: cwd.toString(), model: 'retired-model', modelNeedsReconciliation: true }));
		await f.agent.chats.changeModel(chat, { id: 'swe-2-high' }, owner);
		assert.deepStrictEqual((await f.agent.getChatMetadata(chat, owner))?.model, { id: 'swe-2-high' });
		assert.ok(f.transports[0].sent.some(request => request.method === 'session/set_config_option'));
	});
});
