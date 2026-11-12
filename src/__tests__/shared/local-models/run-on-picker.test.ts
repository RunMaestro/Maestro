/**
 * Tests for shared/local-models/run-on-picker - the choices an agent's Run on
 * picker offers, and what the Library says about each one.
 */

import { describe, it, expect } from 'vitest';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import {
	GEMMA_4_E4B_ID,
	GPT_OSS_20B_ID,
	QWEN3_1_7B_ID,
	getLocalModel,
} from '../../../shared/local-models/model-catalog';
import type { HardwareProfile } from '../../../shared/local-models/model-fit';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../../shared/local-models/model-server';
import {
	RUN_ON_DEFAULT_CONTEXT_TOKENS,
	RUN_ON_MIN_CONTEXT_TOKENS,
	type RunOnSourceTarget,
} from '../../../shared/local-models/run-on';
import {
	RUN_ON_PROVIDER_OPTION_LABEL,
	buildRunOnOptionGroups,
	reportedRunOnContextTokens,
	runOnModelFacts,
	toRunOnPickerSource,
	type RunOnPickerSource,
} from '../../../shared/local-models/run-on-picker';

const GiB = 1024 ** 3;

const ROOMY: HardwareProfile = {
	platform: 'darwin',
	arch: 'arm64',
	totalMemoryBytes: 128 * GiB,
	unifiedMemory: true,
	gpus: [],
};

const SMALL: HardwareProfile = { ...ROOMY, totalMemoryBytes: 8 * GiB };

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const SERVER: RunOnPickerSource = {
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	name: MODEL_SERVER_NAME,
	models: [GPT_OSS_20B_ID, GEMMA_4_E4B_ID, QWEN3_1_7B_ID],
};

const OLLAMA_SOURCE: RunOnPickerSource = {
	endpointId: OLLAMA.id,
	name: OLLAMA.name,
	models: ['qwen3:latest'],
};

const onServer = (model: string): RunOnSourceTarget => ({
	type: 'source',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model,
});

function labels(groups: ReturnType<typeof buildRunOnOptionGroups>) {
	return groups.map((group) => ({
		label: group.label,
		options: group.options.map((option) => option.label),
	}));
}

describe('runOnModelFacts', () => {
	it('reads a Maestro server model from the catalog', () => {
		const facts = runOnModelFacts('claude-code', onServer(GPT_OSS_20B_ID), ROOMY);

		expect(facts.displayName).toBe(getLocalModel(GPT_OSS_20B_ID)?.displayName);
		expect(facts.qualified).toBe(true);
		expect(facts.fit?.fit).toBe('fits');
		expect(facts.defaultContextTokens).toBe(getLocalModel(GPT_OSS_20B_ID)?.defaultContext);
		// The size Suggest ranks local models by.
		expect(facts.parametersB).toBe(getLocalModel(GPT_OSS_20B_ID)?.parameters?.totalB);
	});

	it('grants the badge only for the harness the model qualified with', () => {
		expect(runOnModelFacts('claude-code', onServer(GEMMA_4_E4B_ID)).qualified).toBe(true);
		expect(runOnModelFacts('codex', onServer(GEMMA_4_E4B_ID)).qualified).toBe(false);
		// OpenCode has a recipe, and no model has been qualified with it.
		expect(runOnModelFacts('opencode', onServer(GPT_OSS_20B_ID)).qualified).toBe(false);
	});

	it('does not grant it to a model that never took the qualification', () => {
		expect(runOnModelFacts('claude-code', onServer(QWEN3_1_7B_ID)).qualified).toBe(false);
	});

	it('never starts the context under the agent minimum', () => {
		for (const model of SERVER.models) {
			expect(
				runOnModelFacts('claude-code', onServer(model)).defaultContextTokens
			).toBeGreaterThanOrEqual(RUN_ON_MIN_CONTEXT_TOKENS);
		}
	});

	it('knows nothing about a model on another source', () => {
		expect(
			runOnModelFacts('claude-code', { endpointId: OLLAMA.id, model: 'qwen3:latest' }, ROOMY)
		).toEqual({
			displayName: 'qwen3:latest',
			qualified: false,
			defaultContextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS,
		});
	});

	it('starts a model on another source at the context the source reports, and keeps it as the maximum', () => {
		expect(
			runOnModelFacts(
				'claude-code',
				{ endpointId: OLLAMA.id, model: 'deepseek-v4.1-flash:cloud' },
				ROOMY,
				1_048_576
			)
		).toEqual({
			displayName: 'deepseek-v4.1-flash:cloud',
			qualified: false,
			defaultContextTokens: 1_048_576,
			maxContextTokens: 1_048_576,
		});
	});

	it('never starts under the agent minimum, even when the source reports less', () => {
		const facts = runOnModelFacts(
			'claude-code',
			{ endpointId: OLLAMA.id, model: 'tiny:7b' },
			ROOMY,
			8192
		);

		expect(facts.defaultContextTokens).toBe(RUN_ON_MIN_CONTEXT_TOKENS);
		expect(facts.maxContextTokens).toBe(8192);
	});

	it("takes a Maestro server model's maximum from the catalog, not the source", () => {
		const facts = runOnModelFacts('claude-code', onServer(GPT_OSS_20B_ID), ROOMY, 1_048_576);

		expect(facts.maxContextTokens).toBe(getLocalModel(GPT_OSS_20B_ID)?.contextLength);
		expect(facts.defaultContextTokens).toBe(getLocalModel(GPT_OSS_20B_ID)?.defaultContext);
	});

	it('does not read a catalog id on another source as the catalog model', () => {
		const facts = runOnModelFacts(
			'claude-code',
			{ endpointId: OLLAMA.id, model: GPT_OSS_20B_ID },
			ROOMY
		);

		expect(facts.qualified).toBe(false);
		expect(facts.fit).toBeUndefined();
	});

	it('leaves the fit out without a hardware profile', () => {
		expect(runOnModelFacts('claude-code', onServer(GPT_OSS_20B_ID)).fit).toBeUndefined();
		expect(runOnModelFacts('claude-code', onServer(GPT_OSS_20B_ID), null).fit).toBeUndefined();
	});

	it('says when a model is too large for this computer', () => {
		expect(runOnModelFacts('claude-code', onServer(GPT_OSS_20B_ID), SMALL).fit?.fit).toBe(
			'too-large'
		);
	});
});

describe('toRunOnPickerSource and reportedRunOnContextTokens', () => {
	it('keeps the model ids in order and the contexts the listing stated', () => {
		const source = toRunOnPickerSource(OLLAMA.id, 'Ollama', [
			{ id: 'deepseek-v4.1-flash:cloud', contextTokens: 1_048_576 },
			{ id: 'gemma4:latest' },
		]);

		expect(source).toEqual({
			endpointId: OLLAMA.id,
			name: 'Ollama',
			models: ['deepseek-v4.1-flash:cloud', 'gemma4:latest'],
			contextTokens: { 'deepseek-v4.1-flash:cloud': 1_048_576 },
		});
		expect(
			reportedRunOnContextTokens([source], {
				endpointId: OLLAMA.id,
				model: 'deepseek-v4.1-flash:cloud',
			})
		).toBe(1_048_576);
		expect(
			reportedRunOnContextTokens([source], { endpointId: OLLAMA.id, model: 'gemma4:latest' })
		).toBeUndefined();
		expect(
			reportedRunOnContextTokens([source], { endpointId: 'other', model: 'gemma4:latest' })
		).toBeUndefined();
	});

	it('leaves the context map out when the listing stated none', () => {
		expect(toRunOnPickerSource(OLLAMA.id, 'Ollama', [{ id: 'qwen3:latest' }])).toEqual({
			endpointId: OLLAMA.id,
			name: 'Ollama',
			models: ['qwen3:latest'],
		});
	});
});

describe('buildRunOnOptionGroups', () => {
	it('offers the provider alone when no source lists a model', () => {
		const groups = buildRunOnOptionGroups({
			toolType: 'claude-code',
			current: { type: 'provider' },
			sources: [],
			endpoints: [],
		});

		expect(groups).toEqual([
			{ label: null, options: [{ value: 'provider', label: RUN_ON_PROVIDER_OPTION_LABEL }] },
		]);
	});

	it('groups models by source, with the fit and the badge on a catalog model', () => {
		const groups = buildRunOnOptionGroups({
			toolType: 'claude-code',
			current: { type: 'provider' },
			sources: [SERVER, OLLAMA_SOURCE],
			endpoints: [OLLAMA],
			hardware: ROOMY,
		});

		expect(labels(groups)).toEqual([
			{ label: null, options: [RUN_ON_PROVIDER_OPTION_LABEL] },
			{
				label: MODEL_SERVER_NAME,
				options: [
					'gpt-oss 20B (MXFP4) (Fits, Agent-ready)',
					`${getLocalModel(GEMMA_4_E4B_ID)?.displayName} (Fits, Agent-ready)`,
					`${getLocalModel(QWEN3_1_7B_ID)?.displayName} (Fits)`,
				],
			},
			{ label: 'Ollama', options: ['qwen3:latest'] },
		]);
		expect(groups[1].options[0].value).toBe(`${MODEL_SERVER_ENDPOINT_ID}:${GPT_OSS_20B_ID}`);
		expect(groups[2].options[0].value).toBe('ep-ollama:qwen3:latest');
	});

	it('reads the badge for the harness the agent runs', () => {
		const groups = buildRunOnOptionGroups({
			toolType: 'codex',
			current: { type: 'provider' },
			sources: [SERVER],
			endpoints: [],
		});

		expect(groups[1].options.map((option) => option.label)).toEqual([
			'gpt-oss 20B (MXFP4) (Agent-ready)',
			getLocalModel(GEMMA_4_E4B_ID)?.displayName,
			getLocalModel(QWEN3_1_7B_ID)?.displayName,
		]);
	});

	it('leaves out a source that lists nothing', () => {
		const groups = buildRunOnOptionGroups({
			toolType: 'claude-code',
			current: { type: 'provider' },
			sources: [{ ...OLLAMA_SOURCE, models: [] }],
			endpoints: [OLLAMA],
		});

		expect(groups).toHaveLength(1);
	});

	it('does not repeat a current target a source lists', () => {
		const groups = buildRunOnOptionGroups({
			toolType: 'claude-code',
			current: {
				type: 'source',
				endpointId: OLLAMA.id,
				model: 'qwen3:latest',
				contextTokens: 65_536,
			},
			sources: [OLLAMA_SOURCE],
			endpoints: [OLLAMA],
		});

		expect(groups[0].options).toHaveLength(1);
	});

	it.each([
		[
			'a source that was removed',
			{ type: 'source', endpointId: 'ep-gone', model: 'm' } as const,
			[OLLAMA],
			'm (source removed)',
		],
		[
			'a source that is disabled',
			{ type: 'source', endpointId: OLLAMA.id, model: 'qwen3:latest' } as const,
			[{ ...OLLAMA, enabled: false }],
			'qwen3:latest on Ollama (source disabled)',
		],
		[
			'a model its source no longer lists',
			{ type: 'source', endpointId: OLLAMA.id, model: 'gone:latest' } as const,
			[OLLAMA],
			'gone:latest on Ollama (not listed)',
		],
		[
			'a Maestro server model that is not installed',
			onServer(GPT_OSS_20B_ID),
			[],
			`gpt-oss 20B (MXFP4) on ${MODEL_SERVER_NAME} (not installed)`,
		],
	])('keeps %s in the picker with the reason', (_name, current, endpoints, expected) => {
		const groups = buildRunOnOptionGroups({
			toolType: 'claude-code',
			current,
			sources: [],
			endpoints,
		});

		expect(groups[0].options.map((option) => option.label)).toEqual([
			RUN_ON_PROVIDER_OPTION_LABEL,
			expected,
		]);
	});
});
