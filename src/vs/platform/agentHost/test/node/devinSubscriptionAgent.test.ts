/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AcpClient } from '../../node/acp/acpClient.js';
import { DevinSubscriptionAgent, DEVIN_SUBSCRIPTION_RESOURCE, devinSubscriptionEnvironment, parseDevinModels } from '../../node/acp/devinSubscriptionAgent.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { type AgentSignal } from '../../common/agent.js';
import { Event } from '../../../../base/common/event.js';
import { TestAcpTransport } from './acpTestUtils.js';
import { MessageAttachmentKind, type MessageAttachment } from '../../common/state/sessionState.js';
import { resolveAcpPrompt } from '../../node/acp/acpPromptResolver.js';

const catalog = { families: [{ variants: [{ model_uid: 'swe-2-high', label: 'SWE-2 High', max_context_tokens: 262000 }] }] };
const chat = URI.parse('agent-host-chat://devin-subscription/chat');
const owner = URI.parse('agent-host-devin-subscription:/session');
const cwd = URI.file('/project with spaces');

suite('Devin Subscription Agent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function fixture() {
		const transports: TestAcpTransport[] = [];
		const launches: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		const events: AgentSignal[] = [];
		let onPrompt: ((transport: TestAcpTransport, request: Record<string, unknown>) => void) | undefined;
		let onLoad: typeof onPrompt;
		const agent = store.add(new DevinSubscriptionAgent('devin.exe', {
			listModels: async () => catalog,
			createClient: (_cwd, args, env) => {
				launches.push({ args, env });
				const transport = new TestAcpTransport();
				transports.push(transport);
				transport.handle = request => {
					switch (request.method) {
						case 'initialize': transport.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } }); break;
						case 'session/new': transport.reply(request, { sessionId: 'native', configOptions: [{ id: 'model-choice', category: 'model' }] }); break;
						case 'session/load':
							if (onLoad) { onLoad(transport, request); break; }
							transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'original' } } } });
							transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'restored' } } } });
							transport.reply(request, { configOptions: [{ id: 'model-choice', category: 'model' }] }); break;
						case 'session/set_config_option': transport.reply(request, {}); break;
						case 'session/prompt': if (onPrompt) { onPrompt(transport, request); } else { transport.reply(request, { stopReason: 'end_turn' }); } break;
					}
				};
				return new AcpClient(transport);
			},
		}));
		store.add(agent.onDidChatProgress(event => events.push(event)));
		return { agent, transports, launches, events, set onPrompt(value: typeof onPrompt) { onPrompt = value; }, set onLoad(value: typeof onLoad) { onLoad = value; } };
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
			transport.receive({ jsonrpc: '2.0', id: request.id, method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'tool', title: 'Run command' }, options: [{ optionId: 'forever', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
		};
		const send = f.agent.chats.sendMessage(chat, 'prompt', [cwd], undefined, 'host-turn');
		await new Promise<void>(resolve => {
			const listener = f.agent.onDidChatProgress(event => { if (event.kind === 'pending_confirmation') { listener.dispose(); resolve(); } });
			store.add(listener);
		});
		assert.ok(f.events.some(event => event.kind === 'pending_confirmation'));
		const transport = f.transports[0];
		const replied = Event.toPromise(Event.filter(transport.onSend, message => Object.hasOwn(message, 'result')));
		f.agent.respondToPermissionRequest('host-turn:tool', true);
		await replied;
		const response = transport.sent.find(message => Object.hasOwn(message, 'result'));
		assert.deepStrictEqual(response?.result, { outcome: { outcome: 'selected', optionId: 'once' } });
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
});
