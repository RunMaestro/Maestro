/**
 * Tests for shared/local-models/model-map - the Agent and Housekeeping slots,
 * the reader that migrates the old Utility source into the Housekeeping slot,
 * the provider a slot or task spawns, the one-string slot spelling, and the
 * labels a surface shows.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_MODEL_MAP,
	MODEL_MAP_ASSIGNMENTS,
	MODEL_MAP_REFERENCE_TASK,
	MODEL_MAP_ROLE_LABELS,
	MODEL_MAP_ROLES,
	SESSION_PROVIDER_SLOT,
	formatModelMapSlotSpec,
	isRecommendedForModelMapRole,
	modelMapSlotLabel,
	modelMapSlotProblem,
	parseModelMap,
	parseModelMapSlot,
	parseModelMapSlotSpec,
	readModelMap,
	resolveSlotProvider,
	resolveTaskProvider,
	tasksInheritingModelMapRole,
	withModelMapSlot,
	type ModelMapSlot,
} from '../../../shared/local-models/model-map';
import {
	AGENT_MODEL_ASSIGNMENT,
	HOUSEKEEPING_MODEL_ASSIGNMENT,
	LOCAL_MODEL_TASKS,
} from '../../../shared/local-models/tasks';
import {
	BGE_SMALL_EN_ID,
	QWEN3_1_7B_ID,
	getLocalModel,
} from '../../../shared/local-models/model-catalog';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../../shared/local-models/model-server';

const LOCAL: ModelMapSlot = { type: 'local', modelId: QWEN3_1_7B_ID };
const ENDPOINT: ModelMapSlot = { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' };
const ENDPOINTS = [{ id: 'ep-1', name: 'Ollama' }];

/** A settings getter over a plain record, the shape every reader hands over. */
function reader(settings: Record<string, unknown>): (key: string) => unknown {
	return (key) => settings[key];
}

describe('Model Map roles', () => {
	it('names two slots, matching the Library text groups, each with its assignment', () => {
		expect(MODEL_MAP_ROLES).toEqual(['agent', 'housekeeping']);
		expect(MODEL_MAP_ROLE_LABELS).toEqual({
			agent: 'Agent model',
			housekeeping: 'Housekeeping model',
		});
		expect(MODEL_MAP_ASSIGNMENTS.agent).toBe(AGENT_MODEL_ASSIGNMENT);
		expect(MODEL_MAP_ASSIGNMENTS.housekeeping).toBe(HOUSEKEEPING_MODEL_ASSIGNMENT);
	});

	it('checks slot choices against a System Two text task', () => {
		const task = LOCAL_MODEL_TASKS[MODEL_MAP_REFERENCE_TASK];
		expect(task.system).toBe('two');
		expect(task.needs).toBe('text-gen');
		expect(task.allowsModelMap).toBe(true);
	});

	it('defaults both slots to the session provider', () => {
		expect(DEFAULT_MODEL_MAP).toEqual({
			agent: SESSION_PROVIDER_SLOT,
			housekeeping: SESSION_PROVIDER_SLOT,
		});
		expect(SESSION_PROVIDER_SLOT).toEqual({ type: 'provider' });
	});
});

describe('parseModelMapSlot', () => {
	it('reads each slot shape, trimming ids', () => {
		expect(parseModelMapSlot({ type: 'provider' })).toEqual({ type: 'provider' });
		expect(
			parseModelMapSlot({ type: 'provider', agentId: ' codex ', modelId: ' gpt-5-mini ' })
		).toEqual({ type: 'provider', agentId: 'codex', modelId: 'gpt-5-mini' });
		expect(parseModelMapSlot({ type: 'local', modelId: ` ${QWEN3_1_7B_ID} ` })).toEqual(LOCAL);
		expect(parseModelMapSlot(ENDPOINT)).toEqual(ENDPOINT);
	});

	it('drops a model override that has no agent to apply to', () => {
		expect(parseModelMapSlot({ type: 'provider', modelId: 'haiku' })).toEqual({
			type: 'provider',
		});
		expect(parseModelMapSlot({ type: 'provider', agentId: '  ', modelId: 'haiku' })).toEqual({
			type: 'provider',
		});
	});

	it('keeps a model the catalog no longer knows, so readiness can name it', () => {
		expect(parseModelMapSlot({ type: 'local', modelId: 'retired-model' })).toEqual({
			type: 'local',
			modelId: 'retired-model',
		});
	});

	it('refuses shapes a slot cannot hold', () => {
		for (const value of [
			undefined,
			null,
			[],
			'provider',
			{ type: 'off' },
			{ type: 'system-one' },
			{ type: 'housekeeping-model' },
			{ type: 'utility-agent' },
			{ type: 'local', modelId: '' },
			{ type: 'endpoint', endpointId: 'ep-1' },
		]) {
			expect(parseModelMapSlot(value)).toBeNull();
		}
	});
});

describe('parseModelMap', () => {
	it('reads nothing stored as null, so the reader can migrate', () => {
		for (const value of [undefined, null, [], 'x', 3]) {
			expect(parseModelMap(value)).toBeNull();
		}
	});

	it('reads a missing or bad slot as the session provider', () => {
		expect(parseModelMap({})).toEqual(DEFAULT_MODEL_MAP);
		expect(parseModelMap({ agent: LOCAL, housekeeping: { type: 'off' } })).toEqual({
			agent: LOCAL,
			housekeeping: SESSION_PROVIDER_SLOT,
		});
	});
});

describe('readModelMap (migration from the Utility source)', () => {
	it('uses a stored map and ignores the old keys once one exists', () => {
		expect(
			readModelMap(
				reader({
					modelMap: { agent: ENDPOINT, housekeeping: LOCAL },
					utilitySource: { type: 'utility-agent' },
					utilityAgentId: 'codex',
				})
			)
		).toEqual({ agent: ENDPOINT, housekeeping: LOCAL });
	});

	it('reads an install with no old setup as both slots on the session provider', () => {
		expect(readModelMap(reader({}))).toEqual(DEFAULT_MODEL_MAP);
		expect(readModelMap(reader({ modelMap: null }))).toEqual(DEFAULT_MODEL_MAP);
	});

	it('moves a provider Utility source with its agent and model into the Housekeeping slot', () => {
		expect(
			readModelMap(
				reader({
					utilitySource: { type: 'utility-agent' },
					utilityAgentId: 'codex',
					utilityModelId: 'gpt-5-mini',
				})
			)
		).toEqual({
			agent: SESSION_PROVIDER_SLOT,
			housekeeping: { type: 'provider', agentId: 'codex', modelId: 'gpt-5-mini' },
		});
		// No utilitySource at all was the provider path too.
		expect(readModelMap(reader({ utilityAgentId: 'codex', utilityModelId: null }))).toEqual({
			agent: SESSION_PROVIDER_SLOT,
			housekeeping: { type: 'provider', agentId: 'codex' },
		});
	});

	it('moves a local or endpoint Utility source into the Housekeeping slot, dropping a parked agent', () => {
		for (const source of [LOCAL, ENDPOINT]) {
			expect(
				readModelMap(
					reader({ utilitySource: source, utilityAgentId: 'codex', utilityModelId: 'm' })
				)
			).toEqual({ agent: SESSION_PROVIDER_SLOT, housekeeping: source });
		}
	});
});

describe('withModelMapSlot', () => {
	it('replaces one slot and keeps the other, without mutating the input', () => {
		const before = DEFAULT_MODEL_MAP;
		const after = withModelMapSlot(before, 'agent', LOCAL);
		expect(after).toEqual({ agent: LOCAL, housekeeping: SESSION_PROVIDER_SLOT });
		expect(before).toEqual(DEFAULT_MODEL_MAP);
	});
});

describe('resolveSlotProvider', () => {
	it('follows the session when the slot names no agent', () => {
		expect(resolveSlotProvider(SESSION_PROVIDER_SLOT, 'claude-code')).toEqual({
			agentType: 'claude-code',
			modelId: undefined,
			usesMappedProvider: false,
			changesProvider: false,
		});
	});

	it('runs the named agent with its model override', () => {
		expect(
			resolveSlotProvider(
				{ type: 'provider', agentId: 'codex', modelId: 'gpt-5-mini' },
				'claude-code'
			)
		).toEqual({
			agentType: 'codex',
			modelId: 'gpt-5-mini',
			usesMappedProvider: true,
			changesProvider: true,
		});
		expect(
			resolveSlotProvider({ type: 'provider', agentId: 'claude-code' }, 'claude-code')
		).toMatchObject({ usesMappedProvider: true, changesProvider: false });
	});

	it('keeps the session provider for a slot on a model', () => {
		for (const slot of [LOCAL, ENDPOINT]) {
			expect(resolveSlotProvider(slot, 'claude-code')).toEqual({
				agentType: 'claude-code',
				modelId: undefined,
				usesMappedProvider: false,
				changesProvider: false,
			});
		}
	});
});

describe('resolveTaskProvider', () => {
	const map = {
		agent: { type: 'provider', agentId: 'codex', modelId: 'gpt-5' },
		housekeeping: { type: 'provider', agentId: 'claude-code', modelId: 'haiku' },
	};

	it('spawns the provider of the slot the task follows', () => {
		const settings = reader({ modelMap: map });
		// Summaries is on its default, the Agent model.
		expect(resolveTaskProvider(settings, 'tab-summary', 'opencode')).toMatchObject({
			agentType: 'codex',
			modelId: 'gpt-5',
		});
		// Tab naming is on its default, the Housekeeping model.
		expect(resolveTaskProvider(settings, 'tab-naming', 'opencode')).toMatchObject({
			agentType: 'claude-code',
			modelId: 'haiku',
		});
	});

	it('follows the session for a task that names its own source', () => {
		const settings = reader({
			modelMap: map,
			localModelAssignments: { 'ai-command': { type: 'off' } },
		});
		expect(resolveTaskProvider(settings, 'ai-command', 'opencode')).toEqual({
			agentType: 'opencode',
			modelId: undefined,
			usesMappedProvider: false,
			changesProvider: false,
		});
	});

	it('reads the old Utility source for a task still on the Housekeeping model', () => {
		const settings = reader({ utilityAgentId: 'codex', utilityModelId: 'gpt-5-mini' });
		expect(resolveTaskProvider(settings, 'tab-naming', 'claude-code')).toMatchObject({
			agentType: 'codex',
			modelId: 'gpt-5-mini',
			usesMappedProvider: true,
		});
		// Summaries now follows the Agent model, which the old keys never set.
		expect(resolveTaskProvider(settings, 'tab-summary', 'claude-code')).toMatchObject({
			agentType: 'claude-code',
			usesMappedProvider: false,
		});
	});

	it('moves Summaries back to the old Utility source when it is pointed at the Housekeeping model', () => {
		const settings = reader({
			utilityAgentId: 'codex',
			localModelAssignments: { 'tab-summary': { type: 'housekeeping-model' } },
		});
		expect(resolveTaskProvider(settings, 'tab-summary', 'claude-code')).toMatchObject({
			agentType: 'codex',
			usesMappedProvider: true,
		});
	});
});

describe('slot spec', () => {
	it('round-trips every slot shape', () => {
		for (const slot of [
			SESSION_PROVIDER_SLOT,
			{ type: 'provider', agentId: 'codex' },
			{ type: 'provider', agentId: 'codex', modelId: 'gpt-5-mini' },
			LOCAL,
			ENDPOINT,
		] as ModelMapSlot[]) {
			expect(parseModelMapSlotSpec(formatModelMapSlotSpec(slot))).toEqual(slot);
		}
	});

	it('spells each slot shape', () => {
		expect(formatModelMapSlotSpec(SESSION_PROVIDER_SLOT)).toBe('provider');
		expect(formatModelMapSlotSpec({ type: 'provider', agentId: 'codex' })).toBe('provider:codex');
		expect(formatModelMapSlotSpec(LOCAL)).toBe(`local:${QWEN3_1_7B_ID}`);
		expect(formatModelMapSlotSpec(ENDPOINT)).toBe('endpoint:ep-1:qwen3:latest');
	});

	it('keeps everything after the agent as the model, colons included', () => {
		expect(parseModelMapSlotSpec('provider:opencode:ollama:qwen3:latest')).toEqual({
			type: 'provider',
			agentId: 'opencode',
			modelId: 'ollama:qwen3:latest',
		});
		expect(
			formatModelMapSlotSpec({
				type: 'provider',
				agentId: 'opencode',
				modelId: 'ollama:qwen3:latest',
			})
		).toBe('provider:opencode:ollama:qwen3:latest');
	});

	it('refuses spellings a slot cannot hold', () => {
		for (const spec of [
			'',
			'off',
			'system-one',
			'agent-model',
			'housekeeping-model',
			'utility-agent',
			'local:',
			'endpoint:ep-1',
			'provider:',
			'provider::haiku',
		]) {
			expect(parseModelMapSlotSpec(spec)).toBeNull();
		}
	});
});

describe('modelMapSlotProblem', () => {
	it('accepts a provider, an installed text model and an endpoint', () => {
		expect(modelMapSlotProblem(SESSION_PROVIDER_SLOT)).toBeNull();
		expect(modelMapSlotProblem({ type: 'provider', agentId: 'codex' })).toBeNull();
		expect(modelMapSlotProblem(LOCAL)).toBeNull();
		expect(modelMapSlotProblem(ENDPOINT)).toBeNull();
	});

	it('refuses a model that is not a text model or not in the catalog', () => {
		expect(modelMapSlotProblem({ type: 'local', modelId: BGE_SMALL_EN_ID })).toMatch(
			/needs a text-gen model/
		);
		expect(modelMapSlotProblem({ type: 'local', modelId: 'nope' })).toMatch(
			/not a known local model/
		);
	});
});

describe('modelMapSlotLabel', () => {
	it('names the session provider, an agent with or without its override, a model and an endpoint model', () => {
		expect(modelMapSlotLabel(SESSION_PROVIDER_SLOT, ENDPOINTS)).toBe('Session provider');
		expect(modelMapSlotLabel({ type: 'provider', agentId: 'codex' }, ENDPOINTS)).toBe(
			getAgentDisplayName('codex')
		);
		expect(
			modelMapSlotLabel({ type: 'provider', agentId: 'codex', modelId: 'gpt-5-mini' }, ENDPOINTS)
		).toBe(`${getAgentDisplayName('codex')} (gpt-5-mini)`);
		expect(modelMapSlotLabel(LOCAL, ENDPOINTS)).toBe(getLocalModel(QWEN3_1_7B_ID)?.displayName);
		expect(modelMapSlotLabel(ENDPOINT, ENDPOINTS)).toBe('qwen3:latest on Ollama');
	});

	it('names an endpoint that was removed by its model, and the built-in model server by name', () => {
		expect(modelMapSlotLabel(ENDPOINT, [])).toBe('qwen3:latest');
		expect(
			modelMapSlotLabel(
				{ type: 'endpoint', endpointId: MODEL_SERVER_ENDPOINT_ID, model: QWEN3_1_7B_ID },
				[]
			)
		).toBe(`${getLocalModel(QWEN3_1_7B_ID)?.displayName} on ${MODEL_SERVER_NAME}`);
	});
});

describe('isRecommendedForModelMapRole', () => {
	it('follows the roles the Library gives a model', () => {
		const roles = getLocalModel(QWEN3_1_7B_ID)?.roles ?? [];
		expect(isRecommendedForModelMapRole(QWEN3_1_7B_ID, 'housekeeping')).toBe(
			roles.includes('housekeeping')
		);
		expect(isRecommendedForModelMapRole(QWEN3_1_7B_ID, 'agent')).toBe(roles.includes('agent'));
		expect(isRecommendedForModelMapRole('nope', 'agent')).toBe(false);
	});
});

describe('tasksInheritingModelMapRole', () => {
	it('lists the tasks that follow each slot, defaults included, in registry order', () => {
		expect(tasksInheritingModelMapRole(undefined, 'housekeeping')).toEqual([
			'tab-naming',
			'ai-command',
			'spoken-notices',
			'token-proxy',
			'history-digests',
		]);
		expect(tasksInheritingModelMapRole(undefined, 'agent')).toEqual(['tab-summary', 'git-drafts']);
	});

	it('moves a task between slots and drops one that names its own source', () => {
		const assignments = {
			'tab-summary': HOUSEKEEPING_MODEL_ASSIGNMENT,
			'ai-command': AGENT_MODEL_ASSIGNMENT,
			'tab-naming': { type: 'local' as const, modelId: QWEN3_1_7B_ID },
		};
		expect(tasksInheritingModelMapRole(assignments, 'agent')).toEqual(['ai-command', 'git-drafts']);
		expect(tasksInheritingModelMapRole(assignments, 'housekeeping')).toEqual([
			'tab-summary',
			'spoken-notices',
			'token-proxy',
			'history-digests',
		]);
	});
});
