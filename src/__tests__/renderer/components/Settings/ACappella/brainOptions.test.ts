/**
 * @file brainOptions.test.ts
 *
 * The rows of the Conductor Brain picker: the voice-specific providers plus the
 * models the `voice-routing` assignment can name, with the Brain in force
 * always among them.
 */

import { describe, it, expect } from 'vitest';

import type { LocalModelListing } from '../../../../../main/local-models/service';
import { buildBrainOptionGroups } from '../../../../../renderer/components/Settings/ACappella/brainOptions';
import type { VoiceBrainSource } from '../../../../../shared/acappella/voice-routing';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import {
	QWEN3_1_7B_ID,
	QWEN3_5_4B_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';

const PROVIDER_ROWS = [
	{ value: 'mock-brain', label: 'Built-in (keyword routing)' },
	{ value: 'openai-brain', label: 'OpenAI (hosted)' },
	{ value: 'anthropic-brain', label: 'Anthropic (hosted)' },
];

const ollama: LocalModelEndpoint = {
	id: 'ep-1',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const lmStudio: LocalModelEndpoint = {
	id: 'ep-2',
	name: 'LM Studio',
	kind: 'lmstudio',
	baseUrl: 'http://127.0.0.1:1234',
	enabled: false,
};

function installedQwen(modelId: string = QWEN3_1_7B_ID): LocalModelListing {
	const entry = getLocalModel(modelId)!;
	return {
		entry,
		status: { id: entry.id, status: 'installed', manifest: null, bytesOnDisk: 1 },
		installPaths: [],
	} as LocalModelListing;
}

const QWEN_SOURCE: VoiceBrainSource = {
	assignment: { type: 'local', modelId: QWEN3_1_7B_ID },
	spec: `local:${QWEN3_1_7B_ID}`,
	label: 'Qwen3 1.7B Instruct (Q4_K_M)',
};

const endpointModels = {
	'ep-1': { ok: true as const, models: [{ id: 'llama3.3' }] },
	'ep-2': { ok: true as const, models: [{ id: 'phi4' }] },
};

describe('buildBrainOptionGroups', () => {
	it('offers the voice-specific providers, with no Off row, when nothing else exists', () => {
		expect(
			buildBrainOptionGroups(null, { listings: [], endpoints: [], endpointModels: {} })
		).toEqual([{ label: null, options: PROVIDER_ROWS }]);
	});

	it('adds the models of each enabled endpoint, under its name', () => {
		const groups = buildBrainOptionGroups(null, {
			listings: [],
			endpoints: [ollama, lmStudio],
			endpointModels,
		});

		expect(groups).toEqual([
			{ label: null, options: PROVIDER_ROWS },
			{ label: 'Ollama', options: [{ value: 'endpoint:ep-1:llama3.3', label: 'llama3.3' }] },
		]);
	});

	it('does not offer an installed local model that measured badly at routing', () => {
		const groups = buildBrainOptionGroups(null, {
			listings: [installedQwen()],
			endpoints: [],
			endpointModels: {},
		});

		expect(groups).toEqual([{ label: null, options: PROVIDER_ROWS }]);
	});

	it('offers an installed local model that voice routing offers', () => {
		// Qwen3.5 4B routed every request to the agent it named (2026-10-12), so the
		// task offers it and this picker does too. Qwen3 1.7B beside it stays out.
		const groups = buildBrainOptionGroups(null, {
			listings: [installedQwen(), installedQwen(QWEN3_5_4B_ID)],
			endpoints: [],
			endpointModels: {},
		});

		expect(groups).toEqual([
			{ label: null, options: PROVIDER_ROWS },
			{
				label: 'Local models',
				options: [
					{
						value: `local:${QWEN3_5_4B_ID}`,
						label: getLocalModel(QWEN3_5_4B_ID)!.displayName,
					},
				],
			},
		]);
	});

	it('lists the local model that is already assigned', () => {
		const groups = buildBrainOptionGroups(QWEN_SOURCE, {
			listings: [installedQwen()],
			endpoints: [],
			endpointModels: {},
		});

		// Installed and assigned, but voice routing records it as measured-unfit
		// (`unofferedLocalModels`), so it is shown as the current choice with the
		// reason in its label rather than in a group that reads as a recommendation.
		expect(groups).toEqual([
			{
				label: null,
				options: [
					...PROVIDER_ROWS,
					{
						value: `local:${QWEN3_1_7B_ID}`,
						label: 'Qwen3 1.7B Instruct (Q4_K_M) (not recommended)',
					},
				],
			},
		]);
	});

	it('keeps an assignment no row covers, and says why it is not offered', () => {
		const notInstalled = buildBrainOptionGroups(QWEN_SOURCE, {
			listings: [],
			endpoints: [],
			endpointModels: {},
		});
		expect(notInstalled[0].options).toEqual([
			...PROVIDER_ROWS,
			{ value: `local:${QWEN3_1_7B_ID}`, label: 'Qwen3 1.7B Instruct (Q4_K_M) (not installed)' },
		]);

		const disabled = buildBrainOptionGroups(
			{
				assignment: { type: 'endpoint', endpointId: 'ep-2', model: 'phi4' },
				spec: 'endpoint:ep-2:phi4',
				label: 'phi4 on LM Studio',
				endpointName: 'LM Studio',
			},
			{ listings: [], endpoints: [ollama, lmStudio], endpointModels }
		);
		expect(disabled[0].options).toContainEqual({
			value: 'endpoint:ep-2:phi4',
			label: 'phi4 on LM Studio (disabled)',
		});
	});
});
