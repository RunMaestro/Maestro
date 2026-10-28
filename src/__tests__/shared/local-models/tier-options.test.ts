/**
 * Tests for shared/local-models/tier-options - the choices one tier's picker
 * offers, in the spelling `maestro-cli models tiers set` takes.
 */

import { describe, it, expect } from 'vitest';

import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { GPT_OSS_20B_ID, getLocalModel } from '../../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../../shared/local-models/model-server';
import {
	agentTierFallthroughLabel,
	buildTierTargetOptionGroups,
	type HarnessTierOptions,
} from '../../../shared/local-models/tier-options';
import { agentTierRows, TIER_AGENT_MODEL_LABEL, type TierTarget } from '../../../shared/modelTiers';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const CLAUDE: HarnessTierOptions = {
	harness: 'claude-code',
	name: 'Claude Code',
	installed: true,
	catalog: [{ id: 'haiku' }, { id: 'opus' }],
	runOn: { supported: true },
	sources: [
		{ endpointId: MODEL_SERVER_ENDPOINT_ID, name: MODEL_SERVER_NAME, models: [GPT_OSS_20B_ID] },
		{ endpointId: OLLAMA.id, name: OLLAMA.name, models: ['qwen3:latest'] },
	],
	problems: [],
};

const groupsFor = (
	options: HarnessTierOptions,
	current: TierTarget | undefined,
	endpoints: LocalModelEndpoint[] = [OLLAMA]
) =>
	buildTierTargetOptionGroups({
		options,
		current,
		fallthroughLabel: 'Built-in (haiku)',
		endpoints,
	});

describe('buildTierTargetOptionGroups', () => {
	it('offers the next layer, the agent model, the catalogue, then each source', () => {
		const groups = groupsFor(CLAUDE, undefined);

		expect(groups.map((group) => group.label)).toEqual([
			null,
			'Claude Code models',
			MODEL_SERVER_NAME,
			'Ollama',
		]);
		expect(groups[0].options).toEqual([
			{ value: 'default', label: 'Built-in (haiku)' },
			{ value: 'provider', label: TIER_AGENT_MODEL_LABEL },
		]);
		expect(groups[1].options).toEqual([
			{ value: 'provider:haiku', label: 'haiku' },
			{ value: 'provider:opus', label: 'opus' },
		]);
		expect(groups[3].options).toEqual([{ value: 'ep-ollama:qwen3:latest', label: 'qwen3:latest' }]);
	});

	it('labels a model on the Maestro server as the Run on picker does', () => {
		const server = groupsFor(CLAUDE, undefined)[2];
		const entry = getLocalModel(GPT_OSS_20B_ID);

		expect(server.options[0].value).toBe(`${MODEL_SERVER_ENDPOINT_ID}:${GPT_OSS_20B_ID}`);
		expect(server.options[0].label).toContain(entry?.displayName);
		expect(server.options[0].label).toContain('Agent-ready');
	});

	it('offers no source to a harness with no Run on recipe', () => {
		const droid: HarnessTierOptions = {
			...CLAUDE,
			harness: 'factory-droid',
			name: 'Factory Droid',
			runOn: { supported: false, reason: 'No recipe.' },
		};
		expect(groupsFor(droid, undefined).map((group) => group.label)).toEqual([
			null,
			'Factory Droid models',
		]);
	});

	it('keeps a provider model the catalogue no longer lists, and says so', () => {
		const groups = groupsFor(CLAUDE, { type: 'provider-model', model: 'claude-opus-3' });
		expect(groups[0].options[2]).toEqual({
			value: 'provider:claude-opus-3',
			label: 'claude-opus-3 (not in the catalogue)',
		});
	});

	it('does not call a model unlisted when the harness lists no catalogue', () => {
		const groups = groupsFor({ ...CLAUDE, catalog: [] }, { type: 'provider-model', model: 'x' });
		expect(groups.map((group) => group.label)).not.toContain('Claude Code models');
		expect(groups[0].options[2]).toEqual({ value: 'provider:x', label: 'x' });
	});

	it('keeps a source target no source lists, with the reason', () => {
		const gone: TierTarget = { type: 'source', endpointId: 'ep-gone', model: 'm' };
		expect(groupsFor(CLAUDE, gone)[0].options[2]).toEqual({
			value: 'ep-gone:m',
			label: 'm (source removed)',
		});
	});

	it('does not repeat a current value that is listed', () => {
		const listed = groupsFor(CLAUDE, { type: 'provider-model', model: 'opus' });
		expect(listed[0].options).toHaveLength(2);
		const source = groupsFor(CLAUDE, {
			type: 'source',
			endpointId: OLLAMA.id,
			model: 'qwen3:latest',
		});
		expect(source[0].options).toHaveLength(2);
	});
});

describe('agentTierFallthroughLabel', () => {
	const LOCAL: TierTarget = { type: 'source', endpointId: OLLAMA.id, model: 'qwen3:latest' };

	it('names the value the layers below give the tier', () => {
		const [low] = agentTierRows({ toolType: 'claude-code' });
		expect(agentTierFallthroughLabel(low)).toBe('Harness default (haiku)');

		const [onSource] = agentTierRows(
			{ toolType: 'claude-code' },
			{ 'claude-code': { low: LOCAL } }
		);
		expect(agentTierFallthroughLabel(onSource, [OLLAMA])).toBe(
			'Harness default (qwen3:latest on Ollama)'
		);
	});

	it('says so when no layer maps the tier', () => {
		const [low] = agentTierRows({ toolType: 'opencode' });
		expect(agentTierFallthroughLabel(low)).toBe('Harness default (not mapped)');
	});

	it('says so when the harness default cannot be used', () => {
		const [low] = agentTierRows({ toolType: 'factory-droid' }, { 'factory-droid': { low: LOCAL } });
		expect(agentTierFallthroughLabel(low)).toBe('Harness default (cannot be used)');
	});
});
