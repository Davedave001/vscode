/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { observableValue } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual, basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { DevinSubscriptionProviderId, DevinSubscriptionResource } from '../../common/devinAgentConfiguration.js';
import { type IAgent, type IAgentChats, type AgentSignal, type IAgentChatMetadata, type IAgentMaterializeChatEvent, type IActiveClient, type IAgentModelInfo, resolveAgentChatContext } from '../../common/agent.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { type ModelSelection, type Turn, type MarkdownResponsePart, type ToolCallResponsePart, type ToolCallPendingConfirmationState, type ToolResultContent, TurnState, MessageKind, ResponsePartKind, ToolCallStatus, ToolCallConfirmationReason, ToolCallCancellationReason, ToolResultContentType } from '../../common/state/sessionState.js';
import { AcpClient, initializeAcp, isAcpRecord as isObject } from './acpClient.js';
import { AcpStdioTransport } from './acpStdioTransport.js';
import { resolveAcpPrompt, type IAcpPromptCapabilities } from './acpPromptResolver.js';
import { applyDevinModelConfiguration, DevinModelConfigurationError, readDevinConfigOptions, type IDevinSelectConfig } from './devinModelConfiguration.js';
import { acpToolContent, acpToolValue } from './acpToolContent.js';

export const DEVIN_SUBSCRIPTION_PROVIDER = DevinSubscriptionProviderId;
export const DEVIN_SUBSCRIPTION_RESOURCE = DevinSubscriptionResource;

interface ITool {
	readonly id: string;
	name: string;
	title: string;
	ready: boolean;
	complete: boolean;
	readonly part: ToolCallResponsePart;
	input?: string;
	rawInput?: unknown;
	content: ToolResultContent[];
	rawOutput?: string;
	contentIsRaw?: boolean;
	confirmed: ToolCallConfirmationReason;
}

interface ISendOperation {
	readonly finished: DeferredPromise<void>;
	cancelled: boolean;
	waiting: boolean;
}

interface IChat {
	readonly chat: URI;
	cwd: URI;
	model?: ModelSelection;
	nativeId?: string;
	client?: AcpClient;
	initializing?: Promise<void>;
	readonly store: DisposableStore;
	readonly history: Turn[];
	readonly tools: Map<string, ITool>;
	activeTurn?: Turn;
	send?: ISendOperation;
	preparing?: boolean;
	aborting?: boolean;
	textPart?: MarkdownResponsePart;
	replaying: boolean;
	lastReplayUserId?: string;
	modelConfigId?: string;
	legacyModels: boolean;
	configOptions: readonly IDevinSelectConfig[];
	modelNeedsReconciliation?: boolean;
	promptCapabilities?: IAcpPromptCapabilities;
	forceStop?: ReturnType<typeof setTimeout>;
	readonly createdAt: number;
	modifiedAt: number;
}

interface IPersistedChat {
	readonly sessionId: string;
	readonly cwd: URI;
	readonly model?: ModelSelection;
	readonly createdAt: number;
	readonly modifiedAt: number;
	readonly modelNeedsReconciliation?: boolean;
}

/** Metadata is needed before materializeChat runs, including before account reconnect. */
function readPersistedChat(data: string | undefined): IPersistedChat | undefined {
	try {
		const value: unknown = data ? JSON.parse(data) : undefined;
		if (!isObject(value) || value.version !== 1 || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.cwd !== 'string') { return undefined; }
		const cwd = URI.parse(value.cwd);
		if (cwd.scheme !== 'file') { return undefined; }
		const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt >= 0 ? value.createdAt : 0;
		const modifiedAt = typeof value.modifiedAt === 'number' && Number.isFinite(value.modifiedAt) && value.modifiedAt >= createdAt ? value.modifiedAt : createdAt;
		return { sessionId: value.sessionId, cwd, model: typeof value.model === 'string' && value.model ? { id: value.model } : undefined, createdAt, modifiedAt, modelNeedsReconciliation: value.modelNeedsReconciliation === true };
	} catch { return undefined; }
}

export interface IDevinClientAdapter {
	listModels(env: NodeJS.ProcessEnv): Promise<unknown>;
	createClient(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): AcpClient;
}

/** The official client understands this prefix as a Devin account, not a Windsurf API key. */
export function devinSubscriptionEnvironment(token: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...inherited };
	for (const key of Object.keys(env)) {
		if (/^WINDSURF_API_KEY$/i.test(key)) { delete env[key]; }
	}
	env.WINDSURF_API_KEY = token.startsWith('devin-session-token$') ? token : `devin-session-token$${token}`;
	return env;
}

export function parseDevinModels(value: unknown): readonly IAgentModelInfo[] {
	if (!isObject(value) || !Array.isArray(value.families)) { throw new Error('Invalid Devin model catalog'); }
	const result = new Map<string, IAgentModelInfo>();
	for (const family of value.families) {
		if (!isObject(family) || !Array.isArray(family.variants)) { continue; }
		for (const model of family.variants) {
			if (!isObject(model) || typeof model.model_uid !== 'string' || !model.model_uid || typeof model.label !== 'string') { continue; }
			result.set(model.model_uid, {
				provider: DEVIN_SUBSCRIPTION_PROVIDER, id: model.model_uid, name: model.label,
				maxContextWindow: typeof model.max_context_tokens === 'number' && model.max_context_tokens > 0 ? model.max_context_tokens : undefined,
				maxOutputTokens: typeof model.max_output_tokens === 'number' && model.max_output_tokens > 0 ? model.max_output_tokens : undefined,
				supportsVision: false, // The catalog does not establish per-model image support.
			});
		}
	}
	return [...result.values()];
}

/** Subscription credentials come only from the editor's separate browser account. */
export class DevinSubscriptionAgent extends Disposable implements IAgent {
	readonly id = DEVIN_SUBSCRIPTION_PROVIDER;
	readonly agentHostCapabilities = { workspaceConversion: false };
	readonly models = observableValue<readonly IAgentModelInfo[]>(this, []);
	private readonly progress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this.progress.event;
	private readonly materialized = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this.materialized.event;
	private readonly dataChanged = this._register(new Emitter<{ chat: URI; providerData: string }>());
	readonly onDidChangeChatData = this.dataChanged.event;
	readonly onDidSpawnChat = Event.None;
	readonly onDidDiscoverChats = Event.None;
	private readonly records = new Map<string, IChat>();
	private readonly permissions = new Map<string, { chat: IChat; tool: ITool; resolve: (value: unknown) => void; allow?: string; deny?: string }>();
	private token: string | undefined;
	private authRevision = 0;
	private catalogIds: ReadonlySet<string> = new Set();

	constructor(private readonly executable: string, private readonly adapter?: IDevinClientAdapter) { super(); }

	getDescriptor() {
		return { provider: this.id, displayName: 'Devin Subscription', description: localize('devin.subscriptionDescription', "Uses your connected Devin subscription") };
	}

	getProtectedResources() { return [{ resource: DEVIN_SUBSCRIPTION_RESOURCE, resource_name: 'Devin Subscription', required: false }]; }

	async authenticate(resource: string, token: string): Promise<boolean> {
		if (resource !== DEVIN_SUBSCRIPTION_RESOURCE) { return false; }
		if (this.token !== (token || undefined)) {
			this.authRevision++;
			for (const chat of this.records.values()) { this.cancelSendAndRelease(chat); }
			this.token = token || undefined;
			this.models.set([], undefined);
			this.catalogIds = new Set();
		}
		if (this.token) { await this.refreshModels(); }
		return true;
	}

	async refreshModels(): Promise<void> {
		const token = this.token;
		const revision = this.authRevision;
		if (!token) { return; }
		const environment = devinSubscriptionEnvironment(token, process.env);
		const value = this.adapter ? await this.adapter.listModels(environment) : JSON.parse(await new Promise<string>((resolve, reject) => {
			execFile(this.executable, ['models', 'list', '--format', 'json'], { env: environment, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
				if (error) { reject(new Error(localize('devin.catalogFailed', "Could not load the Devin model catalog. Check the configured Devin executable and your account access."))); } else { resolve(output); }
			});
		}));
		const models = parseDevinModels(value);
		if (!models.length) { throw new Error('Devin returned an empty model catalog.'); }
		if (revision === this.authRevision) { this.catalogIds = new Set(models.map(model => model.id)); this.models.set(models, undefined); }
	}

	readonly chats: IAgentChats = {
		createChat: async (chat, context, options) => {
			if (options?.fork || options?.importConversation) { throw new Error('Devin conversation import and forks are not supported yet.'); }
			const directories = options?.workingDirectories ?? resolveAgentChatContext(context, chat).launchWorkingDirectories;
			if (directories?.length !== 1 || directories[0].scheme !== 'file') { throw new Error('Devin Subscription requires one local workspace folder.'); }
			this.createRecord(chat, directories[0], options?.model);
			return { provisional: true, resolvedWorkingDirectory: directories[0] };
		},
		disposeChat: async chat => { const record = this.records.get(chat.toString()); if (record) { this.cancelSendAndRelease(record); record.store.dispose(); this.records.delete(chat.toString()); } },
		releaseChat: async chat => { this.cancelSendAndRelease(this.record(chat)); },
		sendMessage: async (chat, prompt, directories, attachments, turnId, _sender, clientTypeOrContext, context) => {
			if (!turnId) { throw new Error('A host turn id is required.'); }
			const record = this.record(chat);
			return this.runSend(record, async () => {
				if (record.activeTurn || record.preparing) { throw new Error('A Devin turn is already running.'); }
				record.preparing = true;
				record.aborting = false;
				try {
					const folders = URI.isUri(directories) ? [directories] : directories;
					if (folders?.length) { await this.setWorkingDirectory(chat, context ?? chat, folders[0]); }
					if (folders && folders.length > 1) { throw new Error('Devin Subscription requires one local workspace folder.'); }
					if (record.aborting) { throw new CancellationError(); }
					await this.ensureSession(record);
					if (record.aborting) { throw new CancellationError(); }
					if (record.modelNeedsReconciliation) { throw new Error(localize('devin.modelUnconfirmed', "Devin could not confirm the model after a failed change. Select a model again before sending another message.")); }
				} finally { record.preparing = false; }
				const operation = context ?? (typeof clientTypeOrContext === 'object' ? clientTypeOrContext : undefined);
				const instructions = operation && !URI.isUri(operation) ? operation.hostInstructions : undefined;
				const text = instructions?.length ? `${instructions.join('\n\n')}\n\n${prompt}` : prompt;
				const content = resolveAcpPrompt(text, attachments, record.promptCapabilities ?? {});
				const turn: Turn = { id: turnId, startedAt: new Date().toISOString(), message: { text: prompt, attachments: attachments ? [...attachments] : undefined, origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: TurnState.Complete };
				record.activeTurn = turn;
				record.history.push(turn);
				record.tools.clear();
				record.textPart = undefined;
				const started = Date.now();
				try {
					const result = await record.client!.request('session/prompt', { sessionId: record.nativeId, prompt: content }, { timeoutMs: 0 });
					const cancelled = record.aborting || isObject(result) && result.stopReason === 'cancelled';
					turn.state = cancelled ? TurnState.Cancelled : TurnState.Complete;
					this.cancelPermissions(record);
					for (const tool of record.tools.values()) { if (!tool.complete) { this.completeTool(record, turn, tool, false); } }
					record.modifiedAt = Date.now();
					this.dataChanged.fire({ chat, providerData: this.providerData(record) });
					this.fire(record, { type: ActionType.ChatTurnComplete, turnId, duration: Date.now() - started });
				} catch (error) {
					turn.state = record.aborting ? TurnState.Cancelled : TurnState.Error;
					throw error;
				} finally {
					clearTimeout(record.forceStop);
					record.forceStop = undefined;
					this.cancelPermissions(record);
					for (const tool of record.tools.values()) { if (!tool.complete) { this.completeTool(record, turn, tool, false); } }
					record.activeTurn = undefined;
					record.textPart = undefined;
				}
			});
		},
		abort: async chat => {
			const record = this.record(chat);
			const send = record.send;
			if (!send || send.cancelled) { return; }
			send.cancelled = true;
			if (send.waiting) { return; }
			record.aborting = true;
			this.cancelPermissions(record);
			if (record.preparing) { this.release(record); return; }
			const client = record.client;
			const turn = record.activeTurn;
			if (client && record.nativeId && turn) {
				client.notify('session/cancel', { sessionId: record.nativeId });
				// A deadline belongs to this client and turn, never a later reconnect.
				if (record.client === client && record.activeTurn === turn) {
					record.forceStop = setTimeout(() => {
						if (record.client === client && record.activeTurn === turn) { this.release(record); }
					}, 2000);
				}
			}
		},
		changeModel: async (chat, model) => {
			const record = this.record(chat);
			if (record.send || record.activeTurn || record.preparing) { throw new Error('Wait for the current Devin turn before changing models.'); }
			if (!record.modelNeedsReconciliation && record.model?.id === model.id && equals(record.model.config ?? {}, model.config ?? {})) { return; }
			if (record.nativeId && !record.client) { await this.ensureSession(record, false); }
			if (record.client) { await this.applyModel(record, model); }
			record.modelNeedsReconciliation = false;
			record.model = model;
			if (record.nativeId) { this.dataChanged.fire({ chat, providerData: this.providerData(record) }); }
		},
		changeAgent: async (_chat, agent) => { if (agent) { throw new Error('Custom agent selection is not supported by Devin Subscription.'); } },
		getMessages: async chat => {
			const record = this.record(chat);
			// A reconnecting turn owns replay; a history read must not race its cleanup.
			if (record.nativeId && !record.client && !record.send) { await this.ensureSession(record); }
			return record.history;
		},
	};

	private async runSend(record: IChat, run: () => Promise<void>): Promise<void> {
		const previous = record.send;
		if (previous && !previous.cancelled) { throw new Error('A Devin turn is already running.'); }
		const send: ISendOperation = { finished: new DeferredPromise<void>(), cancelled: false, waiting: true };
		record.send = send;
		try {
			if (previous) { await previous.finished.p; }
			if (send.cancelled || this._store.isDisposed || record.store.isDisposed || this.records.get(record.chat.toString()) !== record) { throw new CancellationError(); }
			send.waiting = false;
			await run();
		} finally {
			// A newer explicitly submitted turn can already own this slot.
			if (record.send === send) { record.send = undefined; }
			void send.finished.complete();
		}
	}

	private createRecord(chat: URI, cwd: URI, model?: ModelSelection, createdAt = Date.now(), modifiedAt = createdAt): IChat {
		if (this.records.has(chat.toString())) { throw new Error('Devin chat already exists.'); }
		const record: IChat = { chat, cwd, model, history: [], store: new DisposableStore(), tools: new Map(), replaying: false, legacyModels: false, configOptions: [], createdAt, modifiedAt };
		this.records.set(chat.toString(), record);
		return record;
	}

	private record(chat: URI): IChat {
		const record = this.records.get(chat.toString());
		if (!record) { throw new Error('Unknown Devin chat.'); }
		return record;
	}

	async materializeChat(chat: URI, _context: Parameters<IAgent['materializeChat']>[1], data: string | undefined): Promise<void> {
		if (this.records.has(chat.toString())) { return; }
		const value = readPersistedChat(data);
		if (!value) { throw new Error('Invalid persisted Devin chat.'); }
		const record = this.createRecord(chat, value.cwd, value.model, value.createdAt, value.modifiedAt);
		record.nativeId = value.sessionId;
		record.modelNeedsReconciliation = value.modelNeedsReconciliation;
	}

	async setWorkingDirectory(chat: URI, _context: Parameters<IAgent['setWorkingDirectory']>[1], cwd: URI): Promise<void> {
		const record = this.record(chat);
		if (cwd.scheme !== 'file' || record.nativeId && !isEqual(record.cwd, cwd)) { throw new Error('Cannot move a running Devin chat to another workspace.'); }
		record.cwd = cwd;
	}

	private providerData(record: IChat): string { return JSON.stringify({ version: 1, sessionId: record.nativeId, cwd: record.cwd.toString(), model: record.model?.id, createdAt: record.createdAt, modifiedAt: record.modifiedAt, ...(record.modelNeedsReconciliation ? { modelNeedsReconciliation: true } : {}) }); }

	private async ensureSession(record: IChat, reconcileModel = true): Promise<void> {
		if (record.initializing) { return record.initializing; }
		if (record.client) { return; }
		record.initializing = this.start(record, reconcileModel);
		try { await record.initializing; } finally { record.initializing = undefined; }
	}

	private async start(record: IChat, reconcileModel: boolean): Promise<void> {
		const token = this.token;
		if (!token) { throw new Error(localize('devin.signInRequired', "Connect Devin Subscription from Agent Subscriptions before starting a session.")); }
		const args = ['acp', ...(record.model ? ['--model', record.model.id] : [])];
		record.store.clear();
		const environment = devinSubscriptionEnvironment(token, process.env);
		const client = this.adapter?.createClient(record.cwd.fsPath, args, environment) ?? new AcpClient(new AcpStdioTransport(spawn(this.executable, args, { cwd: record.cwd.fsPath, env: environment, windowsHide: true, stdio: 'pipe' })));
		record.client = client;
		record.store.add(client);
		record.store.add(client.onClose(() => { if (record.client === client) { record.client = undefined; this.cancelPermissions(record); } }));
		record.store.add(client.onNotification(notification => {
			if (notification.method !== 'session/update' || !isObject(notification.params)) { return; }
			if (record.nativeId && notification.params.sessionId !== record.nativeId) { return; }
			if (isObject(notification.params.update)) { this.update(record, notification.params.update); }
		}));
		record.store.add(client.registerRequestHandler('session/request_permission', params => this.permission(record, params)));
		const previousHistory = [...record.history];
		try {
			const initialized = await initializeAcp(client, { name: 'agent-workspace', version: '0.1.0' });
			const capabilities = isObject(initialized.agentCapabilities) ? initialized.agentCapabilities.promptCapabilities : undefined;
			record.promptCapabilities = isObject(capabilities) ? { image: capabilities.image === true, embeddedContext: capabilities.embeddedContext === true } : {};
			const loading = !!record.nativeId;
			if (loading && (!isObject(initialized.agentCapabilities) || initialized.agentCapabilities.loadSession !== true)) { throw new Error('Devin does not support restoring this session.'); }
			record.replaying = loading;
			if (loading) { record.history.length = 0; record.lastReplayUserId = undefined; record.textPart = undefined; record.tools.clear(); }
			const result = await client.request(loading ? 'session/load' : 'session/new', { ...(loading ? { sessionId: record.nativeId } : {}), cwd: record.cwd.fsPath, mcpServers: [] });
			record.replaying = false;
			if (!isObject(result)) { throw new Error('Invalid Devin session response.'); }
			if (!loading) {
				if (typeof result.sessionId !== 'string' || !result.sessionId) { throw new Error('Devin did not return a session id.'); }
				record.nativeId = result.sessionId;
			}
			const modelOption = Array.isArray(result.configOptions) ? result.configOptions.find(option => isObject(option) && option.category === 'model') : undefined;
			record.modelConfigId = isObject(modelOption) && typeof modelOption.id === 'string' ? modelOption.id : undefined;
			record.legacyModels = isObject(result.models);
			record.configOptions = readDevinConfigOptions(result.configOptions);
			// session/load restores the native model and its separate reasoning/speed
			// selectors. Catalog variant ids are not necessarily model-selector values.
			if (reconcileModel && record.modelNeedsReconciliation && record.model) { await this.applyModel(record, record.model); record.modelNeedsReconciliation = false; }
			this.materialized.fire({ chat: record.chat, result: { providerData: this.providerData(record), resolvedWorkingDirectory: record.cwd }, workingDirectories: [record.cwd], project: undefined });
		} catch (error) {
			this.release(record);
			// A partial replay must not replace the last successfully loaded transcript.
			record.history.splice(0, record.history.length, ...previousHistory);
			record.textPart = undefined;
			record.tools.clear();
			throw error;
		}
	}

	private async applyModel(record: IChat, model: ModelSelection): Promise<void> {
		if (record.configOptions.some(option => option.category === 'model')) {
			try {
				record.configOptions = await applyDevinModelConfiguration(model.id, this.catalogIds, record.configOptions, async (configId, value) => {
					const result = await record.client!.request('session/set_config_option', { sessionId: record.nativeId, configId, value });
					record.configOptions = readDevinConfigOptions(isObject(result) ? result.configOptions : undefined);
					return record.configOptions;
				});
			} catch (error) {
				if (error instanceof DevinModelConfigurationError && error.requiresReconciliation) {
					record.modelNeedsReconciliation = true;
					this.dataChanged.fire({ chat: record.chat, providerData: this.providerData(record) });
				}
				throw error;
			}
		} else if (record.modelConfigId) { throw new Error(localize('devin.invalidModelSelector', "Devin returned an unsupported model selector. Update the official client and reconnect.")); }
		else if (record.legacyModels) { await record.client!.request('session/set_model', { sessionId: record.nativeId, modelId: model.id }); }
		else { throw new Error('Devin did not advertise model selection for this session.'); }
	}

	private update(record: IChat, update: Record<string, unknown>): void {
		if (update.sessionUpdate === 'config_option_update') { record.configOptions = readDevinConfigOptions(update.configOptions); return; }
		if (update.sessionUpdate === 'user_message_chunk' && record.replaying && isObject(update.content) && typeof update.content.text === 'string') {
			const id = typeof update.messageId === 'string' ? update.messageId : undefined;
			const previous = record.history.at(-1);
			if (previous && !previous.responseParts.length && (!id || id === record.lastReplayUserId)) { previous.message.text += update.content.text; }
			else { record.history.push({ id: id ?? generateUuid(), message: { text: update.content.text, origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: TurnState.Complete }); }
			record.lastReplayUserId = id;
			record.textPart = undefined;
			record.tools.clear();
			return;
		}
		const turn = record.activeTurn ?? (record.replaying ? record.history.at(-1) : undefined);
		if (!turn) { return; }
		if (update.sessionUpdate === 'agent_message_chunk' && isObject(update.content) && update.content.type === 'text' && typeof update.content.text === 'string') {
			if (!record.textPart) {
				record.textPart = { kind: ResponsePartKind.Markdown, id: generateUuid(), content: '' };
				turn.responseParts.push(record.textPart);
				if (!record.replaying) { this.fire(record, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { ...record.textPart } }); }
			}
			record.textPart.content += update.content.text;
			if (!record.replaying) { this.fire(record, { type: ActionType.ChatDelta, turnId: turn.id, partId: record.textPart.id, content: update.content.text }); }
		} else if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && typeof update.toolCallId === 'string') {
			const previous = record.tools.get(update.toolCallId);
			const previousInput = previous?.input;
			const previousRawInput = previous?.rawInput;
			const previousTitle = previous?.title;
			const tool = this.tool(record, update, turn);
			if (tool.complete) { return; }
			if (this.permissions.has(tool.id) && !equals(previousRawInput, tool.rawInput)) {
				this.cancelPermission(tool.id, localize('devin.toolInputChanged', "The tool input changed while waiting for approval. Devin must request permission again."));
				return;
			}
			record.textPart = undefined;
			if ((update.status === 'in_progress' && !this.permissions.has(tool.id)) || (tool.ready && tool.part.toolCall.status === ToolCallStatus.Running)) {
				const readyChanged = !tool.ready || tool.input !== previousInput || tool.title !== previousTitle;
				if (readyChanged) { this.readyTool(record, turn, tool); }
				if (tool.part.toolCall.status === ToolCallStatus.Running) {
					tool.part.toolCall = { ...tool.part.toolCall, content: tool.content };
					if (!record.replaying && (readyChanged || Array.isArray(update.content) || acpToolValue(update.rawOutput) !== undefined)) {
						this.fire(record, { type: ActionType.ChatToolCallContentChanged, turnId: turn.id, toolCallId: tool.id, content: tool.content });
					}
				}
			}
			if ((update.status === 'completed' || update.status === 'failed') && !tool.complete) {
				this.completeTool(record, turn, tool, update.status === 'completed');
			}
		}
	}

	private readyTool(record: IChat, turn: Turn, tool: ITool): void {
		tool.ready = true;
		tool.part.toolCall = { toolCallId: tool.id, toolName: tool.name, displayName: tool.title, invocationMessage: tool.title, toolInput: tool.input, status: ToolCallStatus.Running, confirmed: tool.confirmed, content: tool.content };
		if (!record.replaying) {
			this.fire(record, { type: ActionType.ChatToolCallReady, turnId: turn.id, toolCallId: tool.id, invocationMessage: tool.title, toolInput: tool.input, confirmed: tool.confirmed });
		}
	}

	private completeTool(record: IChat, turn: Turn, tool: ITool, success: boolean): void {
		if (tool.complete) { return; }
		if (this.permissions.has(tool.id)) { this.cancelPermission(tool.id); return; }
		if (!tool.ready) { this.readyTool(record, turn, tool); }
		tool.complete = true;
		const result = { success, pastTenseMessage: tool.title, content: tool.content };
		tool.part.toolCall = { toolCallId: tool.id, toolName: tool.name, displayName: tool.title, invocationMessage: tool.title, toolInput: tool.input, status: ToolCallStatus.Completed, confirmed: tool.confirmed, ...result };
		if (!record.replaying) { this.fire(record, { type: ActionType.ChatToolCallComplete, turnId: turn.id, toolCallId: tool.id, result }); }
	}

	private tool(record: IChat, update: Record<string, unknown>, turn = record.activeTurn!): ITool {
		const nativeId = String(update.toolCallId);
		let tool = record.tools.get(nativeId);
		if (!tool) {
			const id = `${turn.id}:${nativeId}`;
			const name = typeof update.name === 'string' ? update.name : 'devin-tool';
			const title = typeof update.title === 'string' ? update.title : 'Devin tool';
			const part: ToolCallResponsePart = { kind: ResponsePartKind.ToolCall, toolCall: { toolCallId: id, toolName: name, displayName: title, status: ToolCallStatus.Streaming } };
			tool = { id, name, title, ready: false, complete: false, part, content: [], confirmed: ToolCallConfirmationReason.NotNeeded };
			record.tools.set(nativeId, tool);
			turn.responseParts.push(part);
			if (!record.replaying) { this.fire(record, { type: ActionType.ChatToolCallStart, turnId: turn.id, toolCallId: tool.id, toolName: tool.name, displayName: tool.title }); }
		}
		if (tool.complete) { return tool; }
		if (typeof update.title === 'string') { tool.title = update.title; }
		if (typeof update.name === 'string') { tool.name = update.name; }
		const input = acpToolValue(update.rawInput);
		if (input !== undefined) { tool.input = input; tool.rawInput = update.rawInput; }
		const rawOutput = acpToolValue(update.rawOutput);
		if (rawOutput !== undefined) { tool.rawOutput = rawOutput; }
		if (Array.isArray(update.content)) { tool.content = acpToolContent(update.content); tool.contentIsRaw = false; }
		if ((!tool.content.length || tool.contentIsRaw) && tool.rawOutput !== undefined) { tool.content = [{ type: ToolResultContentType.Text, text: tool.rawOutput }]; tool.contentIsRaw = true; }
		return tool;
	}

	private async permission(record: IChat, params: unknown): Promise<unknown> {
		const cancelled = { outcome: { outcome: 'cancelled' } };
		if (!record.activeTurn || record.aborting || !isObject(params) || params.sessionId !== record.nativeId || !isObject(params.toolCall) || typeof params.toolCall.toolCallId !== 'string' || !Array.isArray(params.options)) { return cancelled; }
		const tool = this.tool(record, params.toolCall);
		const allow = params.options.find(option => isObject(option) && option.kind === 'allow_once' && typeof option.optionId === 'string');
		const deny = params.options.find(option => isObject(option) && option.kind === 'reject_once' && typeof option.optionId === 'string');
		if (tool.complete) { return cancelled; }
		// A repeated request must not leave the earlier RPC waiting forever.
		const previous = this.permissions.get(tool.id);
		previous?.resolve(cancelled);
		const state: ToolCallPendingConfirmationState = { toolCallId: tool.id, toolName: tool.name, displayName: tool.title, status: ToolCallStatus.PendingConfirmation, invocationMessage: tool.title, toolInput: tool.input };
		tool.part.toolCall = state;
		return new Promise(resolve => {
			this.permissions.set(tool.id, { chat: record, tool, resolve, allow: isObject(allow) ? allow.optionId as string : undefined, deny: isObject(deny) ? deny.optionId as string : undefined });
			tool.ready = true;
			this.fire(record, { type: ActionType.ChatToolCallReady, turnId: record.activeTurn!.id, toolCallId: tool.id, invocationMessage: state.invocationMessage, toolInput: state.toolInput });
			this.progress.fire({ kind: 'pending_confirmation', chat: record.chat, state });
		});
	}

	respondToPermissionRequest(id: string, approved: boolean): void {
		const pending = this.permissions.get(id);
		if (!pending) { return; }
		this.permissions.delete(id);
		const optionId = approved ? pending.allow : pending.deny;
		if (approved && optionId) {
			pending.tool.confirmed = ToolCallConfirmationReason.UserAction;
			pending.tool.part.toolCall = { toolCallId: pending.tool.id, toolName: pending.tool.name, displayName: pending.tool.title, invocationMessage: pending.tool.title, toolInput: pending.tool.input, status: ToolCallStatus.Running, confirmed: pending.tool.confirmed, content: pending.tool.content };
		} else {
			this.cancelTool(pending.tool, approved ? ToolCallCancellationReason.Skipped : ToolCallCancellationReason.Denied);
			if (approved && pending.chat.activeTurn) {
				this.fire(pending.chat, { type: ActionType.ChatToolCallComplete, turnId: pending.chat.activeTurn.id, toolCallId: pending.tool.id, result: { success: false, pastTenseMessage: localize('devin.noOneTimeApproval', "Devin did not offer a one-time approval option.") } });
			}
		}
		pending.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
	}

	private cancelTool(tool: ITool, reason: ToolCallCancellationReason.Denied | ToolCallCancellationReason.Skipped): void {
		tool.complete = true;
		tool.part.toolCall = { toolCallId: tool.id, toolName: tool.name, displayName: tool.title, invocationMessage: tool.title, toolInput: tool.input, status: ToolCallStatus.Cancelled, reason };
	}

	private cancelPermissions(record: IChat): void {
		for (const [id, pending] of this.permissions) {
			if (pending.chat === record) { this.cancelPermission(id); }
		}
	}

	private cancelPermission(id: string, reasonMessage?: string): void {
		const pending = this.permissions.get(id);
		if (!pending) { return; }
		this.permissions.delete(id);
		this.cancelTool(pending.tool, ToolCallCancellationReason.Skipped);
		if (pending.chat.activeTurn && !pending.chat.replaying) {
			this.fire(pending.chat, { type: ActionType.ChatToolCallConfirmed, turnId: pending.chat.activeTurn.id, toolCallId: pending.tool.id, approved: false, reason: ToolCallCancellationReason.Skipped, ...(reasonMessage ? { reasonMessage } : {}) });
		}
		pending.resolve({ outcome: { outcome: 'cancelled' } });
	}
	private fire(record: IChat, action: ChatAction): void { this.progress.fire({ kind: 'action', resource: record.chat, action }); }
	private cancelSendAndRelease(record: IChat): void {
		if (record.send) { record.send.cancelled = true; record.aborting = true; }
		this.release(record);
	}
	private release(record: IChat): void { this.cancelPermissions(record); clearTimeout(record.forceStop); record.forceStop = undefined; record.store.clear(); record.client = undefined; record.replaying = false; }
	getOrCreateActiveClient(_chat: URI, _context: Parameters<IAgent['getOrCreateActiveClient']>[1], client: { clientId: string; displayName?: string }): IActiveClient { return { clientId: client.clientId, displayName: client.displayName, tools: [], customizations: [] }; }
	removeActiveClient(): void { }
	onClientToolCallComplete(): void { throw new Error('Devin does not advertise client-side tools.'); }
	respondToUserInputRequest(): void { }
	async resolveChatConfig(params: Parameters<IAgent['resolveChatConfig']>[0]) { return { schema: { type: 'object' as const, properties: {} }, values: params.config ?? {} }; }
	getInheritedChatConfig(): undefined { return undefined; }
	async chatConfigCompletions() { return { items: [] }; }
	async getChatCustomizations() { return []; }
	async listChatsToMigrate() { return []; }
	async getChatMetadata(chat: URI, _context: Parameters<IAgent['getChatMetadata']>[1], providerData?: string): Promise<IAgentChatMetadata | undefined> {
		const record = this.records.get(chat.toString()) ?? readPersistedChat(providerData);
		return record ? { chat, startTime: record.createdAt, modifiedTime: record.modifiedAt, model: record.model, workingDirectories: [record.cwd], project: { uri: record.cwd, displayName: basename(record.cwd) } } : undefined;
	}
	async shutdown(): Promise<void> { for (const record of this.records.values()) { this.cancelSendAndRelease(record); } }
	override dispose(): void { for (const record of this.records.values()) { this.cancelSendAndRelease(record); record.store.dispose(); } this.records.clear(); this.token = undefined; super.dispose(); }
}
