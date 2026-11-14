/**
 * Tests for shared/local-models/run-model-choice - the model one Auto Run picks
 * for itself, across the provider's models and every Local Models source.
 */

import { describe, it, expect } from 'vitest';
import {
	buildRunModelChoiceGroups,
	hasRunModelChoices,
	RUN_MODEL_DEFAULT_SPEC,
	runModelChoiceLaunch,
	runModelDefaultLabel,
	type RunModelAgent,
} from '../../../shared/local-models/run-model-choice';
import { namedRunOnContextTokens } from '../../../shared/local-models/run-on';
import type { HarnessTierOptions } from '../../../shared/local-models/tier-options';

const OLLAMA = { id: 'ep-ollama', name: 'Ollama', enabled: true };
const DEEPSEEK = 'deepseek-v4.1-flash:cloud';
const SOURCES = [
	{
		endpointId: OLLAMA.id,
		name: 'Ollama',
		models: [DEEPSEEK, 'qwen3:latest'],
		contextTokens: { [DEEPSEEK]: 1_000_000 },
	},
];
const ROW: Pick<HarnessTierOptions, 'harness' | 'name' | 'catalog' | 'runOn' | 'sources'> = {
	harness: 'codex',
	name: 'Codex',
	catalog: [{ id: 'catalog-model' }],
	runOn: { supported: true },
	sources: SOURCES,
};

const ON_PROVIDER: RunModelAgent = { toolType: 'codex', customModel: 'gpt-6.1-terra' };
const ON_SOURCE: RunModelAgent = {
	toolType: 'codex',
	customModel: 'gpt-6.1-terra',
	runOn: { type: 'source', endpointId: OLLAMA.id, model: DEEPSEEK, contextTokens: 524_288 },
};

function values(agent: RunModelAgent, spec = RUN_MODEL_DEFAULT_SPEC, providerModels?: string[]) {
	return buildRunModelChoiceGroups({
		agent,
		options: ROW,
		providerModels,
		spec,
		endpoints: [OLLAMA],
	}).flatMap((group) => group.options.map((option) => option.value));
}

describe('runModelChoiceLaunch', () => {
	it('launches nothing new for the default', () => {
		expect(runModelChoiceLaunch(RUN_MODEL_DEFAULT_SPEC, ON_SOURCE, SOURCES)).toEqual({});
	});

	it('picks only a model on an agent already on its provider', () => {
		expect(runModelChoiceLaunch('provider:o3', ON_PROVIDER, SOURCES)).toEqual({ model: 'o3' });
		expect(runModelChoiceLaunch('provider', ON_PROVIDER, SOURCES)).toEqual({});
	});

	it('sends a source-backed agent to its provider, on the picked model or its own', () => {
		expect(runModelChoiceLaunch('provider:o3', ON_SOURCE, SOURCES)).toEqual({
			model: 'o3',
			runOn: { type: 'provider' },
		});
		expect(runModelChoiceLaunch('provider', ON_SOURCE, SOURCES)).toEqual({
			model: 'gpt-6.1-terra',
			runOn: { type: 'provider' },
		});
	});

	it('names no model for the provider when the agent names only Auto', () => {
		expect(
			runModelChoiceLaunch('provider', { ...ON_SOURCE, customModel: 'auto' }, SOURCES)
		).toEqual({
			runOn: { type: 'provider' },
		});
	});

	it('runs a source model on its source, at the context the source reports', () => {
		expect(runModelChoiceLaunch(`${OLLAMA.id}:${DEEPSEEK}`, ON_PROVIDER, SOURCES)).toEqual({
			model: DEEPSEEK,
			runOn: { type: 'source', endpointId: OLLAMA.id, model: DEEPSEEK, contextTokens: 1_000_000 },
		});
	});

	it("launches nothing new for the agent's own source and model", () => {
		expect(runModelChoiceLaunch(`${OLLAMA.id}:${DEEPSEEK}`, ON_SOURCE, SOURCES)).toEqual({});
	});

	it('reads a malformed spec as the default', () => {
		expect(runModelChoiceLaunch('nonsense', ON_PROVIDER, SOURCES)).toEqual({});
	});
});

describe('buildRunModelChoiceGroups', () => {
	it("offers the default, the provider's models, then each source's", () => {
		expect(values(ON_PROVIDER)).toEqual([
			'default',
			'provider:catalog-model',
			`${OLLAMA.id}:${DEEPSEEK}`,
			`${OLLAMA.id}:qwen3:latest`,
		]);
	});

	it("lists the agent's own discovered models in place of the harness catalogue", () => {
		expect(values(ON_PROVIDER, RUN_MODEL_DEFAULT_SPEC, ['o3'])).toContain('provider:o3');
		expect(values(ON_PROVIDER, RUN_MODEL_DEFAULT_SPEC, ['o3'])).not.toContain(
			'provider:catalog-model'
		);
	});

	it('offers the provider on its own model only to an agent on a source', () => {
		expect(values(ON_PROVIDER)).not.toContain('provider');
		const head = buildRunModelChoiceGroups({
			agent: ON_SOURCE,
			options: ROW,
			spec: RUN_MODEL_DEFAULT_SPEC,
			endpoints: [OLLAMA],
		})[0];
		expect(head.options).toContainEqual({ value: 'provider', label: 'Codex on gpt-6.1-terra' });
	});

	it('keeps a picked provider model nothing lists, so the select shows it', () => {
		expect(values(ON_PROVIDER, 'provider:gone', ['o3'])).toContain('provider:gone');
	});

	it('offers no source models for a harness with no model source recipe', () => {
		const groups = buildRunModelChoiceGroups({
			agent: ON_PROVIDER,
			options: { ...ROW, runOn: { supported: false, reason: 'no recipe' } },
			spec: RUN_MODEL_DEFAULT_SPEC,
			endpoints: [OLLAMA],
		});
		expect(groups.some((group) => group.label === 'Ollama')).toBe(false);
	});
});

describe('runModelDefaultLabel', () => {
	it('names what the agent runs on', () => {
		expect(runModelDefaultLabel(ON_SOURCE, [OLLAMA])).toBe(
			`Use agent default (${DEEPSEEK} on Ollama)`
		);
		expect(runModelDefaultLabel(ON_PROVIDER, [])).toBe('Use agent default (gpt-6.1-terra)');
		expect(runModelDefaultLabel({ toolType: 'codex', customModel: 'auto' }, [])).toBe(
			'Use agent default (Auto)'
		);
		expect(runModelDefaultLabel({ toolType: 'codex' }, [])).toBe('Use agent default');
	});
});

describe('hasRunModelChoices', () => {
	it('is false when only the default is offered', () => {
		expect(hasRunModelChoices([{ label: null, options: [{ value: 'default', label: 'x' }] }])).toBe(
			false
		);
		expect(
			hasRunModelChoices([{ label: null, options: [{ value: 'provider:o3', label: 'o3' }] }])
		).toBe(true);
	});
});

describe('namedRunOnContextTokens', () => {
	const named = { endpointId: OLLAMA.id, model: DEEPSEEK };

	it('takes the size someone gave first', () => {
		expect(namedRunOnContextTokens(named, ON_SOURCE.runOn, 1_000_000, 131_072)).toBe(131_072);
	});

	it("keeps the agent's own size when it names the same source and model", () => {
		expect(namedRunOnContextTokens(named, ON_SOURCE.runOn, 1_000_000)).toBe(524_288);
	});

	it('starts another target where the source says', () => {
		expect(namedRunOnContextTokens({ ...named, model: 'other' }, ON_SOURCE.runOn, 262_144)).toBe(
			262_144
		);
	});
});
