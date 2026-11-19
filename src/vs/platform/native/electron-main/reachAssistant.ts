/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { REACH_ACCOUNT_ORIGIN, REACH_ASSISTANT_PROMPT_LIMIT, ReachAssistantModel, ReachAssistantRequest, ReachAssistantResponse, ReachAssistantToolCall } from '../common/native.js';

const assistantInstructions = 'You are Signal-C Assistant. Help with the user’s request using the information they provide. Use clear, actionable answers and Markdown when it improves readability.';
const taskInstructions = 'You are a task agent working for Signal-C Assistant. Complete the assigned task using the information the user provides. Report your result, any assumptions, and what remains unresolved.';

type ReachChatModel = {
	readonly id: string;
	readonly name?: string;
	readonly access?: string;
	readonly allow_tools?: boolean;
	readonly capabilities?: { readonly chat?: boolean; readonly endpoint?: string };
};

type ReachFetcher = (url: string, options: RequestInit) => Promise<Response>;

type ReachChatCompletionMessage = {
	readonly role: string;
	readonly content: string | null;
	readonly name?: string;
	readonly tool_call_id?: string;
	readonly tool_calls?: readonly {
		readonly id?: string;
		readonly type?: string;
		readonly function?: { readonly name?: string; readonly arguments?: string };
	}[];
};

export async function fetchReachAssistantModels(fetcher: ReachFetcher, accessToken: string, signal = AbortSignal.timeout(15_000)): Promise<ReachAssistantModel[]> {
	const response = await fetcher(`${REACH_ACCOUNT_ORIGIN}/v1/models`, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'ngrok-skip-browser-warning': '1' },
		redirect: 'error', credentials: 'omit', signal,
	});
	if (!response.ok) { throw new Error('Could not load REACH models'); }
	const catalog: { data?: ReachChatModel[] } = await response.json();
	if (!Array.isArray(catalog.data)) { throw new Error('Invalid REACH model catalog'); }
	return catalog.data.filter(entry => typeof entry?.id === 'string' && entry.id.length > 0
		&& entry.access === 'requests' && entry.capabilities?.chat !== false
		&& (!entry.capabilities?.endpoint || entry.capabilities.endpoint === '/v1/chat/completions'))
		.map(model => ({ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id, supportsTools: model.allow_tools !== false }));
}

function toUpstreamMessage(message: ReachAssistantRequest['messages'][number]): Record<string, unknown> {
	const upstream: Record<string, unknown> = { role: message.role, content: message.content };
	if (message.name) { upstream.name = message.name; }
	if (message.toolCallId) { upstream.tool_call_id = message.toolCallId; }
	if (message.toolCalls?.length) {
		upstream.tool_calls = message.toolCalls.map(call => ({
			id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
		}));
	}
	return upstream;
}

function parseToolCalls(message: ReachChatCompletionMessage): ReachAssistantToolCall[] | undefined {
	if (!Array.isArray(message.tool_calls)) { return undefined; }
	const calls = message.tool_calls.filter((call): call is { id: string; function: { name: string; arguments: string } } =>
		typeof call?.id === 'string' && typeof call.function?.name === 'string'
		&& (call.function.arguments === undefined || typeof call.function.arguments === 'string'))
		.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? '' }));
	return calls.length ? calls : undefined;
}

type ReachChatStreamDelta = {
	readonly content?: string | null;
	readonly tool_calls?: readonly {
		readonly index?: number;
		readonly id?: string;
		readonly function?: { readonly name?: string; readonly arguments?: string };
	}[];
};

/** Consumes an OpenAI-style SSE body, returning the assembled reply text and tool calls. */
async function readAssistantStream(body: ReadableStream<Uint8Array>, onDelta: ((delta: string) => void) | undefined): Promise<{ text: string; toolCalls?: ReachAssistantToolCall[] }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: true });
			let split;
			while ((split = buffer.indexOf('\n\n')) >= 0) {
				const event = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				for (const line of event.split('\n')) {
					if (!line.startsWith('data:')) { continue; }
					const payload = line.slice(5).trim();
					if (!payload || payload === '[DONE]') { continue; }
					try {
						const chunk: { choices?: { delta?: ReachChatStreamDelta }[] } = JSON.parse(payload);
						const delta = chunk.choices?.[0]?.delta;
						if (typeof delta?.content === 'string' && delta.content) {
							text += delta.content;
							onDelta?.(delta.content);
						}
						for (const call of delta?.tool_calls ?? []) {
							const slot = calls.get(call.index ?? 0) ?? { arguments: '' };
							if (call.id) { slot.id = call.id; }
							if (call.function?.name) { slot.name = (slot.name ?? '') + call.function.name; }
							if (call.function?.arguments) { slot.arguments += call.function.arguments; }
							calls.set(call.index ?? 0, slot);
						}
					} catch { /* keep going on malformed events */ }
				}
			}
			if (done) { break; }
		}
	} finally {
		reader.releaseLock();
	}
	const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0])
		.filter(([, call]) => typeof call.id === 'string' && typeof call.name === 'string')
		.map(([, call]) => ({ id: call.id!, name: call.name!, arguments: call.arguments }));
	return { text, toolCalls: toolCalls.length ? toolCalls : undefined };
}

export async function requestReachAssistant(fetcher: ReachFetcher, accountId: string, accessToken: string, request: ReachAssistantRequest, requestId: string, signal: AbortSignal, onDelta?: (delta: string) => void): Promise<ReachAssistantResponse> {
	const messages = Array.isArray(request?.messages) ? request.messages : [];
	const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
	if (!messages.length || !lastUserMessage || lastUserMessage.content.length > REACH_ASSISTANT_PROMPT_LIMIT) {
		return { kind: 'unavailable' };
	}
	const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'ngrok-skip-browser-warning': '1' };
	const options = {
		headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	} satisfies RequestInit;
	try {
		const accountResponse = await fetcher(`${REACH_ACCOUNT_ORIGIN}/v1/account`, options);
		if (accountResponse.status === 401) { return { kind: 'signedOut' }; }
		if (!accountResponse.ok) { return { kind: 'unavailable' }; }
		const account: {
			id?: string;
			access?: { activeSubscription?: boolean };
			requestAllowance?: { unlimited?: boolean; remaining?: number };
		} = await accountResponse.json();
		if (account.id !== accountId) { return { kind: 'signedOut' }; }
		if (account.access?.activeSubscription !== true) { return { kind: 'subscriptionRequired' }; }
		if (account.requestAllowance?.unlimited !== true && !(Number(account.requestAllowance?.remaining) > 0)) {
			return { kind: 'allowanceExhausted' };
		}

		// The account view is intended for account management and can omit hosted models.
		// The authenticated model catalog is the source for entitled inference routes.
		const models = await fetchReachAssistantModels(fetcher, accessToken, options.signal);
		const model = request.modelId ? models.find(entry => entry.id === request.modelId) : models[0];
		if (!model) { return { kind: request.modelId ? 'modelUnavailable' : 'noModel' }; }
		signal.throwIfAborted();

		const tools = Array.isArray(request.tools) && request.tools.length
			? {
				tools: request.tools.map(tool => ({
					type: 'function',
					function: { name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object' } },
				})),
				tool_choice: 'auto',
			}
			: {};
		const base = request.isTask ? taskInstructions : assistantInstructions;
		const upstream = messages.map(toUpstreamMessage);
		if (messages[0]?.role === 'system' && messages[0].content.trim()) {
			upstream[0] = { role: 'system', content: `${base}\n\n${messages[0].content}` };
		} else {
			upstream.unshift({ role: 'system', content: base });
		}
		const result = await fetcher(`${REACH_ACCOUNT_ORIGIN}/v1/chat/completions`, {
			...options,
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
			body: JSON.stringify({
				model: model.id,
				messages: upstream,
				stream: !!onDelta,
				max_tokens: 4096,
				...tools,
			}),
			signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
		});
		if (result.status === 401) { return { kind: 'signedOut' }; }
		if (result.status === 402) { return { kind: 'allowanceExhausted' }; }
		if (result.status === 403) { return { kind: 'subscriptionRequired' }; }
		if (!result.ok) { return { kind: 'unavailable' }; }
		if (onDelta && result.body && (result.headers.get('content-type') ?? '').includes('text/event-stream')) {
			const { text, toolCalls } = await readAssistantStream(result.body, onDelta);
			if (!text.trim() && !toolCalls) { return { kind: 'unavailable' }; }
			return { kind: 'reply', text, model: model.name, ...(toolCalls ? { toolCalls } : {}) };
		}
		const output: { choices?: { message?: ReachChatCompletionMessage }[] } = await result.json();
		const message = output.choices?.[0]?.message;
		const text = typeof message?.content === 'string' ? message.content : '';
		const toolCalls = message ? parseToolCalls(message) : undefined;
		if (!text.trim() && !toolCalls) { return { kind: 'unavailable' }; }
		return { kind: 'reply', text, model: model.name, ...(toolCalls ? { toolCalls } : {}) };
	} catch {
		return { kind: signal.aborted ? 'stopped' : 'unavailable' };
	}
}
