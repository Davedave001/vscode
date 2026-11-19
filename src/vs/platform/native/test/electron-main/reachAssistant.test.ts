/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { REACH_ACCOUNT_ORIGIN } from '../../common/native.js';
import { fetchAssistantWeatherForecast } from '../../electron-main/assistantWeather.js';
import { requestReachAssistant } from '../../electron-main/reachAssistant.js';

suite('The Weather Network forecast', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const key = 'synthetic-weather-fixture';
	const vancouver = { city: 'Vancouver', subdivision: 'bc', country: 'ca' };

	test('uses the requested city and its provider-local day and sends the key only as a Pelmorex header', async () => {
		const result = await fetchAssistantWeatherForecast('tomorrow', vancouver, key, async (url, options) => {
			assert.strictEqual(url, 'https://api.data.pelmorex.com/weather/LongTermForecasts/CA/BC/Vancouver?locale=en-CA');
			assert.strictEqual(new Headers(options.headers).get('x-api-key'), key);
			assert.strictEqual(options.redirect, 'error');
			assert.strictEqual(options.credentials, 'omit');
			return Response.json({
				Location: { Name: 'Vancouver', SubDivision: 'British Columbia', SubDivisionCode: 'BC' },
				LongTermPeriod: [
					{ Period: '0', TimestampLocal: '2026-11-18T00:00:00', TemperatureCMax: '-5' },
					{ Period: '1', TimestampLocal: '2026-11-19T00:00:00', TemperatureCMax: '8', TemperatureCMin: '-2', POPPercentDay: '0', FxConditionDay: 'Sunny' },
				],
			});
		});
		assert.deepStrictEqual(result, {
			source: 'The Weather Network', sourceUrl: 'https://www.theweathernetwork.com/en/city/ca/british-columbia/vancouver/7-days',
			location: 'Vancouver, BC, CA', date: '2026-11-19', highC: 8, lowC: -2, precipitationChancePercent: 0, conditions: 'Sunny',
		});
	});

	test('supports the country and city route with no subdivision and encodes the city name', async () => {
		const result = await fetchAssistantWeatherForecast('today', { city: 'Aix en Provence', country: 'FR' }, key, async url => {
			assert.strictEqual(url, 'https://api.data.pelmorex.com/weather/LongTermForecasts/FR/Aix%20en%20Provence?locale=en-CA');
			return Response.json({ LongTermPeriod: [{ Period: 0, TimestampLocal: '2026-11-20T00:00:00', TemperatureCMax: '13' }] });
		});
		assert.strictEqual(result.date, '2026-11-20');
		assert.strictEqual(result.location, 'Aix en Provence, FR');
		assert.strictEqual(result.sourceUrl, 'https://www.theweathernetwork.com/en/city');
	});

	test('reports missing dates and rejected keys without returning raw provider content', async () => {
		await assert.rejects(() => fetchAssistantWeatherForecast('tomorrow', vancouver, key, async () =>
			Response.json({ LongTermPeriod: [{ Period: '0', TimestampLocal: '2026-11-18T00:00:00', TemperatureCMax: '7' }] })), /requested forecast day for Vancouver/);
		await assert.rejects(() => fetchAssistantWeatherForecast('today', vancouver, key, async () =>
			Response.json({ detail: key }, { status: 403 })),
		(error: Error) => error.message.includes('/weather') && !error.message.includes(key));
		await assert.rejects(() => fetchAssistantWeatherForecast('today', { city: '../test', country: 'FR' }, key, async () => {
			assert.fail('Invalid city reached the provider');
		}), /Enter a city/);
	});
});

suite('REACH Assistant transport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const account = { id: 'account', access: { activeSubscription: true }, requestAllowance: { remaining: 2 }, allowedModels: [] };
	const requestId = '7b0fd1ed-357e-4117-b6f7-c05dcd891992';

	test('uses the authenticated catalog even when the account has an empty model list', async () => {
		const calls: { path: string; options: RequestInit }[] = [];
		const fetcher = async (url: string, options: RequestInit) => {
			assert.strictEqual(new URL(url).origin, REACH_ACCOUNT_ORIGIN);
			const path = new URL(url).pathname;
			calls.push({ path, options });
			switch (path) {
				case '/v1/account': return Response.json(account);
				case '/v1/models': return Response.json({ data: [
					{ id: 'embedding', access: 'requests', capabilities: { chat: false, endpoint: '/v1/embeddings' } },
					{ id: 'decision', access: 'requests', capabilities: { endpoint: '/v1/decisions' } },
					{ id: 'api-model', access: 'tokens' },
					{ id: 'qwen', access: 'requests', name: 'Qwen', capabilities: { outputTokenLimit: true } },
				] });
				case '/v1/chat/completions': return Response.json({ choices: [{ message: { content: 'Hello!' } }] });
				default: throw new Error('Unexpected request');
			}
		};
		const result = await requestReachAssistant(fetcher, account.id, 'test-token', { messages: [{ role: 'user', content: 'Hello' }] }, requestId, new AbortController().signal);
		assert.deepStrictEqual(result, { kind: 'reply', text: 'Hello!', model: 'Qwen' });
		assert.deepStrictEqual(calls.map(call => call.path), ['/v1/account', '/v1/models', '/v1/chat/completions']);
		const completion = calls[2].options;
		assert.strictEqual(new Headers(completion.headers).get('Idempotency-Key'), requestId);
		assert.strictEqual(completion.redirect, 'error');
		const payload = JSON.parse(String(completion.body));
		assert.strictEqual(payload.model, 'qwen');
		assert.deepStrictEqual(payload.messages.map((message: { role: string }) => message.role), ['system', 'user']);
		assert.deepStrictEqual(payload.messages.at(-1), { role: 'user', content: 'Hello' });
	});

	test('forwards tool specs and parses tool_calls replies', async () => {
		const calls: { path: string; options: RequestInit }[] = [];
		const fetcher = async (url: string, options: RequestInit) => {
			const path = new URL(url).pathname;
			calls.push({ path, options });
			switch (path) {
				case '/v1/account': return Response.json(account);
				case '/v1/models': return Response.json({ data: [{ id: 'qwen', access: 'requests', name: 'Qwen' }] });
				case '/v1/chat/completions': return Response.json({ choices: [{ message: { content: null, tool_calls: [
					{ id: 'call-1', type: 'function', function: { name: 'mcp_mail_search', arguments: '{"q":"hi"}' } },
					{ id: 'call-2', type: 'function', function: { name: 'broken' } },
				] } }] });
				default: throw new Error('Unexpected request');
			}
		};
		const request = {
			messages: [{ role: 'system' as const, content: 'Extra instructions' }, { role: 'user' as const, content: 'Search mail' }],
			tools: [{ name: 'mcp_mail_search', description: 'Search mail', parameters: { type: 'object' } }],
		};
		const result = await requestReachAssistant(fetcher, account.id, 'test-token', request, requestId, new AbortController().signal);
		assert.deepStrictEqual(result, {
			kind: 'reply', text: '', model: 'Qwen',
			toolCalls: [
				{ id: 'call-1', name: 'mcp_mail_search', arguments: '{"q":"hi"}' },
				{ id: 'call-2', name: 'broken', arguments: '' },
			],
		});
		const payload = JSON.parse(String(calls[2].options.body!));
		assert.strictEqual(payload.tool_choice, 'auto');
		assert.deepStrictEqual(payload.tools, [{ type: 'function', function: { name: 'mcp_mail_search', description: 'Search mail', parameters: { type: 'object' } } }]);
		assert.strictEqual(payload.messages[0].role, 'system');
		assert.match(payload.messages[0].content, /Extra instructions/);
	});

	test('echoes prior tool calls and tool results back to the model', async () => {
		const calls: { path: string; options: RequestInit }[] = [];
		const fetcher = async (url: string, options: RequestInit) => {
			const path = new URL(url).pathname;
			calls.push({ path, options });
			switch (path) {
				case '/v1/account': return Response.json(account);
				case '/v1/models': return Response.json({ data: [{ id: 'qwen', access: 'requests' }] });
				case '/v1/chat/completions': return Response.json({ choices: [{ message: { content: 'Done.' } }] });
				default: throw new Error('Unexpected request');
			}
		};
		const request = {
			messages: [
				{ role: 'user' as const, content: 'Search mail' },
				{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'call-1', name: 'mcp_mail_search', arguments: '{"q":"hi"}' }] },
				{ role: 'tool' as const, toolCallId: 'call-1', name: 'mcp_mail_search', content: 'found 2' },
			],
		};
		const result = await requestReachAssistant(fetcher, account.id, 'test-token', request, requestId, new AbortController().signal);
		assert.deepStrictEqual(result, { kind: 'reply', text: 'Done.', model: 'qwen' });
		const payload = JSON.parse(String(calls[2].options.body!));
		assert.deepStrictEqual(payload.messages.at(-3), { role: 'user', content: 'Search mail' });
		assert.deepStrictEqual(payload.messages.at(-2).tool_calls, [{ id: 'call-1', type: 'function', function: { name: 'mcp_mail_search', arguments: '{"q":"hi"}' } }]);
		assert.deepStrictEqual(payload.messages.at(-1), { role: 'tool', content: 'found 2', name: 'mcp_mail_search', tool_call_id: 'call-1' });
	});

	test('streams reply deltas and assembles streamed tool_calls', async () => {
		const events = [
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'there' } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'mcp_mail', arguments: '{"q":' } }] } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }] })}\n\n`,
			'data: [DONE]\n\n',
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) { controller.enqueue(new TextEncoder().encode(event)); }
				controller.close();
			},
		});
		const calls: { path: string; options: RequestInit }[] = [];
		const fetcher = async (url: string, options: RequestInit) => {
			const path = new URL(url).pathname;
			calls.push({ path, options });
			switch (path) {
				case '/v1/account': return Response.json(account);
				case '/v1/models': return Response.json({ data: [{ id: 'qwen', access: 'requests' }] });
				case '/v1/chat/completions': return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
				default: throw new Error('Unexpected request');
			}
		};
		const deltas: string[] = [];
		const result = await requestReachAssistant(fetcher, account.id, 'test-token', { messages: [{ role: 'user', content: 'Hi' }] }, requestId, new AbortController().signal, delta => deltas.push(delta));
		assert.deepStrictEqual(result, { kind: 'reply', text: 'Hello there', model: 'qwen', toolCalls: [{ id: 'call-1', name: 'mcp_mail', arguments: '{"q":"hi"}' }] });
		assert.deepStrictEqual(deltas, ['Hello ', 'there']);
		assert.strictEqual(JSON.parse(String(calls[2].options.body)).stream, true);
	});

	test('stops before submitting a prompt when cancelled during model lookup', async () => {
		const control = new AbortController();
		const calls: string[] = [];
		const result = await requestReachAssistant(async url => {
			const path = new URL(url).pathname;
			calls.push(path);
			if (path === '/v1/account') { return Response.json(account); }
			control.abort();
			return Response.json({ data: [{ id: 'qwen', access: 'requests' }] });
		}, account.id, 'test-token', { messages: [{ role: 'user', content: 'Hello' }] }, requestId, control.signal);
		assert.deepStrictEqual(result, { kind: 'stopped' });
		assert.deepStrictEqual(calls, ['/v1/account', '/v1/models']);
	});
});
