/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { isAcpRecord } from './acpClient.js';

export interface IDevinSelectConfig {
	readonly id: string;
	readonly category?: string;
	readonly currentValue: string;
	readonly values: readonly string[];
}

export function readDevinConfigOptions(value: unknown): readonly IDevinSelectConfig[] {
	if (!Array.isArray(value)) { return []; }
	const values = (items: unknown[]): string[] => items.flatMap(item => {
		if (!isAcpRecord(item)) { return []; }
		return typeof item.value === 'string' ? [item.value] : Array.isArray(item.options) ? values(item.options) : [];
	});
	return value.flatMap(option => isAcpRecord(option) && option.type === 'select' && typeof option.id === 'string' && typeof option.currentValue === 'string' && Array.isArray(option.options)
		? [{ id: option.id, category: typeof option.category === 'string' ? option.category : undefined, currentValue: option.currentValue, values: values(option.options) }]
		: []);
}

/** Thinking applies to the lead; Speed can accelerate both members of a Fusion pairing. */
function variantParts(id: string): { key: string; thought?: string; speed: 'fast' | 'standard' } {
	const split = id.indexOf('-sidekick-');
	const sidekick = split < 0 ? '' : id.slice(split);
	let lead = split < 0 ? id : id.slice(0, split);
	const fast = /-(fast|priority|lightning)$/.test(lead) || /-(fast|priority|lightning)$/.test(sidekick);
	lead = lead.replace(/-(fast|priority|lightning)$/, '');
	const thought = /-(none|minimal|low|medium|high|xhigh|max)(?=-1m$|$)/.exec(lead)?.[1];
	if (thought) { lead = lead.replace(new RegExp(`-${thought}(?=-1m$|$)`), ''); }
	return { key: lead + sidekick.replace(/-(fast|priority|lightning)$/, ''), thought, speed: fast ? 'fast' : 'standard' };
}

export interface IDevinModelTarget {
	readonly selector: IDevinSelectConfig;
	readonly value: string;
	readonly thought?: string;
	readonly speed: 'fast' | 'standard';
	readonly exact: boolean;
}

/** Resolve only catalog entries and advertised choices; never guess a config id or a model alias. */
export function resolveDevinModelTarget(id: string, catalog: ReadonlySet<string>, options: readonly IDevinSelectConfig[]): IDevinModelTarget {
	if (!catalog.has(id)) { throw new Error(localize('devin.unknownModel', "The Devin model \"{0}\" is not in the loaded catalog. Refresh the subscription connection and select a model again.", id)); }
	const selector = options.find(option => option.category === 'model');
	if (!selector) { throw new Error(localize('devin.noModelSelector', "Devin did not advertise a model selector for this session.")); }
	const parts = variantParts(id);
	const exact = selector.values.includes(id);
	const candidates = exact ? [id] : selector.values.filter(value => catalog.has(value) && variantParts(value).key === parts.key);
	if (candidates.length !== 1) { throw new Error(localize('devin.unmappedModel', "Devin does not expose an unambiguous selector for \"{0}\" in this session. The current model has been kept.", id)); }
	return { selector, value: candidates[0], thought: parts.thought, speed: parts.speed, exact };
}

export class DevinModelConfigurationError extends Error {
	constructor(message: string, readonly requiresReconciliation: boolean) { super(message); }
}

/** Apply dependent selectors from each fresh response, rolling back model settings on failure. */
export async function applyDevinModelConfiguration(
	id: string,
	catalog: ReadonlySet<string>,
	initial: readonly IDevinSelectConfig[],
	setOption: (id: string, value: string) => Promise<readonly IDevinSelectConfig[]>,
): Promise<readonly IDevinSelectConfig[]> {
	const target = resolveDevinModelTarget(id, catalog, initial);
	let current = initial;
	let changed = false;
	const set = async (option: IDevinSelectConfig, value: string) => {
		if (!option.values.includes(value)) { throw new Error(localize('devin.unsupportedModelSetting', "Devin does not offer \"{0}\" for the model setting \"{1}\".", value, option.id)); }
		changed = true; // A transport failure can occur after the native setting was applied.
		current = await setOption(option.id, value);
		if (current.find(candidate => candidate.id === option.id)?.currentValue !== value) {
			throw new Error(localize('devin.modelSettingNotApplied', "Devin did not confirm the requested model setting \"{0}\".", option.id));
		}
	};
	try {
		// An explicit model choice resets the family's dependent defaults first.
		await set(target.selector, target.value);
		const thought = current.find(option => option.category === 'thought_level');
		if (target.thought && thought) {
			if (thought.currentValue !== target.thought) { await set(thought, target.thought); }
		} else if (target.thought && !target.exact) {
			throw new Error(localize('devin.noThinkingSelector', "Devin did not advertise a Thinking selector for \"{0}\".", id));
		}
		const speed = current.find(option => option.category === 'model_config' && option.values.includes('standard') && option.values.includes('fast'));
		if (speed) {
			if (speed.currentValue !== target.speed) { await set(speed, target.speed); }
		} else if (target.speed === 'fast' && !target.exact) {
			throw new Error(localize('devin.noSpeedSelector', "Devin did not advertise a Speed selector for \"{0}\".", id));
		}
		const finalThought = current.find(option => option.category === 'thought_level');
		const finalSpeed = speed && current.find(option => option.id === speed.id);
		if (current.find(option => option.id === target.selector.id)?.currentValue !== target.value
			|| target.thought && (finalThought ? finalThought.currentValue !== target.thought : !target.exact)
			|| speed && finalSpeed?.currentValue !== target.speed) {
			throw new Error(localize('devin.modelSettingsChanged', "Devin did not confirm all settings for \"{0}\" after applying its dependent options.", id));
		}
		return current;
	} catch (error) {
		let requiresReconciliation = false;
		if (changed) {
			try {
				// Restore the family before dependent settings; never change permission/mode options.
				for (const previous of [...initial.filter(option => option.category === 'model'), ...initial.filter(option => option.category === 'thought_level' || option.category === 'model_config')]) {
					const option = current.find(candidate => candidate.id === previous.id);
					if (!option) { throw new Error('Devin model setting disappeared during rollback'); }
					if (option.category === 'model' || option.currentValue !== previous.currentValue) { await set(option, previous.currentValue); }
				}
				if (initial.filter(option => option.category === 'model' || option.category === 'thought_level' || option.category === 'model_config').some(previous => current.find(option => option.id === previous.id)?.currentValue !== previous.currentValue)) {
					throw new Error('Devin did not confirm all previous model settings during rollback');
				}
			} catch { requiresReconciliation = true; }
		}
		throw new DevinModelConfigurationError(error instanceof Error ? error.message : localize('devin.modelSwitchFailed', "Could not change the Devin model."), requiresReconciliation);
	}
}
