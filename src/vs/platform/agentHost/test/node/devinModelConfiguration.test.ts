/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyDevinModelConfiguration, DevinModelConfigurationError, readDevinConfigOptions, resolveDevinModelTarget, type IDevinSelectConfig } from '../../node/acp/devinModelConfiguration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

const representatives = ['swe-2-high', 'claude-opus-5-5-medium', 'gpt-6-sol-medium', 'glm-5-2-1m', 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high'];
const variants = ['swe-2-max', 'swe-2-medium-lightning', 'claude-opus-5-5-max-fast', 'gpt-6-sol-high-priority', 'glm-5-2-max-1m', 'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-high', 'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-high-lightning'];
const catalog = new Set([...representatives, ...variants]);

function config(model: string, thought = 'high', speed = 'standard'): readonly IDevinSelectConfig[] {
	return [
		{ id: 'permissions', category: 'mode', currentValue: 'ask', values: ['ask', 'bypass'] },
		{ id: 'model-choice', category: 'model', currentValue: model, values: representatives },
		{ id: 'reasoning-depth', category: 'thought_level', currentValue: thought, values: ['low', 'medium', 'high', 'max'] },
		{ id: 'response-speed', category: 'model_config', currentValue: speed, values: ['standard', 'fast'] },
	];
}

function nativeSession(initial = config('swe-2-high')) {
	let state = initial;
	const calls: { id: string; value: string }[] = [];
	return {
		get state() { return state; },
		calls,
		set: async (id: string, value: string) => {
			calls.push({ id, value });
			const option = state.find(option => option.id === id);
			assert.ok(option?.values.includes(value), `Unadvertised setting ${id}=${value}`);
			state = id === 'model-choice' ? config(value, 'medium') : state.map(option => option.id === id ? { ...option, currentValue: value } : option);
			return state;
		},
	};
}

suite('Devin Model Configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads grouped advertised choices and ignores unsupported option types', () => {
		assert.deepStrictEqual(readDevinConfigOptions([
			{ id: 'models', category: 'model', type: 'select', currentValue: 'a', options: [{ group: 'first', options: [{ value: 'a' }, { value: 'b' }] }] },
			{ id: 'boolean', type: 'boolean', currentValue: true },
			{ id: 'bad', type: 'select', options: [] },
		]), [{ id: 'models', category: 'model', currentValue: 'a', values: ['a', 'b'] }]);
	});

	for (const [id, value, thought, speed] of [
		['swe-2-max', 'swe-2-high', 'max', 'standard'],
		['swe-2-medium-lightning', 'swe-2-high', 'medium', 'fast'],
		['claude-opus-5-5-max-fast', 'claude-opus-5-5-medium', 'max', 'fast'],
		['gpt-6-sol-high-priority', 'gpt-6-sol-medium', 'high', 'fast'],
		['glm-5-2-max-1m', 'glm-5-2-1m', 'max', 'standard'],
		['fusion-claude-opus-5-5-high-fast-sidekick-swe-2-high', 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high', 'high', 'fast'],
		['fusion-claude-opus-5-5-high-fast-sidekick-swe-2-high-lightning', 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high', 'high', 'fast'],
	]) {
		test(`maps ${id} through advertised model, thinking, and speed options`, async () => {
			const session = nativeSession();
			const result = await applyDevinModelConfiguration(id, catalog, session.state, session.set);
			assert.strictEqual(result.find(option => option.category === 'model')?.currentValue, value);
			assert.strictEqual(result.find(option => option.category === 'thought_level')?.currentValue, thought);
			assert.strictEqual(result.find(option => option.id === 'response-speed')?.currentValue, speed);
			assert.ok(session.calls.every(call => call.id !== 'permissions'));
		});
	}

	test('resets dependent settings when choosing an explicit default variant from a faster one', async () => {
		const session = nativeSession(config('swe-2-high', 'max', 'fast'));
		const result = await applyDevinModelConfiguration('swe-2-high', catalog, session.state, session.set);
		assert.strictEqual(result.find(option => option.category === 'thought_level')?.currentValue, 'high');
		assert.strictEqual(result.find(option => option.id === 'response-speed')?.currentValue, 'standard');
	});

	test('keeps exact long-context and thinking model choices distinct', () => {
		const ids = new Set(['claude-opus-4-6', 'claude-opus-4-6-thinking-1m']);
		const options = [{ id: 'models', category: 'model', currentValue: 'claude-opus-4-6', values: [...ids] }];
		assert.strictEqual(resolveDevinModelTarget('claude-opus-4-6-thinking-1m', ids, options).value, 'claude-opus-4-6-thinking-1m');
	});

	test('rejects unknown, ambiguous, and missing-sidekick choices before changing native settings', async () => {
		const session = nativeSession();
		await assert.rejects(applyDevinModelConfiguration('unknown', catalog, session.state, session.set), /not in the loaded catalog/);
		const ambiguous = [...session.state.filter(option => option.category !== 'model'), { id: 'models', category: 'model', currentValue: 'swe-2-high', values: ['swe-2-high', 'swe-2-medium'] }];
		assert.throws(() => resolveDevinModelTarget('swe-2-max', new Set([...catalog, 'swe-2-medium']), ambiguous), /unambiguous/);
		const missingSidekick = 'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium';
		assert.throws(() => resolveDevinModelTarget(missingSidekick, new Set([...catalog, missingSidekick]), session.state), /unambiguous/);
		assert.deepStrictEqual(session.calls, []);
	});

	test('rolls back the model and its dependent settings when the new family rejects a thinking value', async () => {
		const session = nativeSession();
		const initial = session.state;
		const calls: string[] = [];
		await assert.rejects(applyDevinModelConfiguration('gpt-6-sol-high-priority', catalog, initial, async (id, value) => {
			calls.push(`${id}=${value}`);
			const state = await session.set(id, value);
			return state.find(option => option.category === 'model')?.currentValue === 'gpt-6-sol-medium' ? state.map(option => option.category === 'thought_level' ? { ...option, values: ['low', 'medium'] } : option) : state;
		}), error => error instanceof DevinModelConfigurationError && !error.requiresReconciliation);
		assert.deepStrictEqual(session.state, initial);
		assert.ok(calls.includes('model-choice=swe-2-high'));
		assert.ok(calls.every(call => !call.startsWith('permissions=')));
	});

	test('marks a lost transport during a change as requiring reconciliation', async () => {
		await assert.rejects(applyDevinModelConfiguration('swe-2-max', catalog, config('swe-2-high'), async () => { throw new Error('connection lost'); }), error => error instanceof DevinModelConfigurationError && error.requiresReconciliation);
	});

	test('rejects and rolls back a speed change that silently resets the requested thinking level', async () => {
		const session = nativeSession();
		const initial = session.state;
		await assert.rejects(applyDevinModelConfiguration('gpt-6-sol-high-priority', catalog, initial, async (id, value) => {
			const result = await session.set(id, value);
			return id === 'response-speed' && value === 'fast' ? session.set('reasoning-depth', 'medium') : result;
		}), error => error instanceof DevinModelConfigurationError && !error.requiresReconciliation && /all settings/.test(error.message));
		assert.deepStrictEqual(session.state, initial);
	});

	test('requires the native response to confirm the requested setting', async () => {
		const initial = config('swe-2-high');
		await assert.rejects(applyDevinModelConfiguration('gpt-6-sol-high-priority', catalog, initial, async () => initial), /did not confirm/);
	});
});
