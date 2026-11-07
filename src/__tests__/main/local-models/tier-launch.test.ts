/**
 * @file tier-launch.test.ts
 *
 * A tier launches on its target. One Auto Run document holds a `low` task and a
 * `high` task, and each is taken through the steps every spawn surface takes:
 * `resolveTurnSettings` (the tier's target, by layer), `turnRunOnTarget` (the
 * place that target names, else the agent's own), `prepareLaunchRunOn` (the
 * source looked up and asked) and `buildAgentLaunchPlan` (the variables and
 * arguments the process gets).
 *
 * What is pinned: the two tasks of one document get two different launch
 * plans; a source tier's model name never reaches the provider, and a provider
 * tier's never reaches the source; a tier that names no place keeps the agent's
 * own; and a tier target that cannot run refuses, with no plan built.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	configureAgentRunOn,
	prepareLaunchRunOn,
	resetAgentRunOnForTests,
	type AgentRunOnDeps,
} from '../../../main/local-models/run-on';
import { findActiveModelHint } from '../../../shared/autorunModelHints';
import {
	resolveTurnSettings,
	turnRunOnTarget,
	type ResolvedTurnSettings,
} from '../../../shared/autorunTurnSettings';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';
import type { RunOnSourceTarget } from '../../../shared/local-models/run-on';
import { applyAgentConfigOverrides } from '../../../shared/maestro-lib/launch/agent-args';
import {
	buildAgentLaunchPlan,
	type AgentLaunchPlan,
} from '../../../shared/maestro-lib/launch/launch-plan';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import type { TierRouting } from '../../../shared/modelTiers';
import type { ToolType } from '../../../shared/types';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const SERVER_URL = 'http://127.0.0.1:52100';

const ON_SERVER: RunOnSourceTarget = {
	type: 'source',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model: 'qwen3.5-4b',
};
const ON_OLLAMA: RunOnSourceTarget = {
	type: 'source',
	endpointId: OLLAMA.id,
	model: 'qwen3:latest',
};

/** One document, two tiers: the first task is `low`, the second is `high`. */
const DOCUMENT = [
	'<!-- MAESTRO:MODEL tier="low" -->',
	'- [ ] Rename the helper',
	'',
	'<!-- MAESTRO:MODEL tier="high" -->',
	'- [ ] Design the migration',
].join('\n');
/** The same document once the `low` task is checked off. */
const DOCUMENT_AFTER_LOW = DOCUMENT.replace('- [ ] Rename', '- [x] Rename');

let deps: { [K in keyof Required<AgentRunOnDeps>]: ReturnType<typeof vi.fn> };

beforeEach(() => {
	deps = {
		sessions: vi.fn(() => []),
		endpoints: vi.fn(() => [OLLAMA]),
		shellEnvVars: vi.fn(() => ({})),
		modelServer: vi.fn(async () => ({ ok: true, baseUrl: SERVER_URL, key: 'sk-server' })),
		listModels: vi.fn(async () => [{ id: 'qwen3:latest' }]),
	};
	configureAgentRunOn(deps as unknown as AgentRunOnDeps);
});

afterEach(() => {
	resetAgentRunOnForTests();
});

interface TaskAgent {
	toolType: ToolType;
	customModel?: string;
	routing: TierRouting;
}

type TaskLaunch =
	| { kind: 'planned'; turn: ResolvedTurnSettings; plan: AgentLaunchPlan }
	| { kind: 'refused'; turn: ResolvedTurnSettings; message: string };

/** The next unfinished task of `content`, taken as far as its launch plan. */
async function launchNextTask(content: string, agent: TaskAgent): Promise<TaskLaunch> {
	const turn = resolveTurnSettings(
		agent.toolType,
		findActiveModelHint(content),
		agent.customModel,
		undefined,
		agent.routing
	);
	if (turn.refusal) return { kind: 'refused', turn, message: turn.refusal.message };

	const definition = getAgentDefinition(agent.toolType);
	if (!definition) throw new Error(`No definition for ${agent.toolType}`);
	// The model reaches the arguments the way a spawn puts it there.
	const { args } = applyAgentConfigOverrides(definition, [...(definition.args ?? [])], {
		agentConfigValues: {},
		sessionCustomModel: turn.model,
	});

	const prepared = await prepareLaunchRunOn({
		toolType: agent.toolType,
		target: turnRunOnTarget(turn, agent.routing.runOn),
	});
	if (prepared.kind === 'refused') return { kind: 'refused', turn, message: prepared.message };

	const planned = buildAgentLaunchPlan({
		surface: 'desktop',
		agent: definition,
		command: definition.command,
		args,
		cwd: '/project',
		prompt: 'Work the document.',
		runOn: prepared.kind === 'ready' ? prepared.runOn : undefined,
	});
	if (!planned.ok) return { kind: 'refused', turn, message: planned.error };
	return { kind: 'planned', turn, plan: planned.plan };
}

function planOf(launch: TaskLaunch): AgentLaunchPlan {
	if (launch.kind !== 'planned') throw new Error(`The task was refused: ${launch.message}`);
	return launch.plan;
}

/** The value after the provider's model flag, or undefined when there is none. */
function modelArg(plan: AgentLaunchPlan): string | undefined {
	const index = plan.launchArgs.indexOf('--model');
	return index === -1 ? undefined : plan.launchArgs[index + 1];
}

describe('a document with a low task and a high task', () => {
	// The agent runs on its provider. It sends `low` to a model on the Maestro
	// model server, and leaves `high` to the layers below it.
	const agent: TaskAgent = {
		toolType: 'claude-code',
		customModel: 'sonnet',
		routing: { tierTargets: { low: ON_SERVER }, harnessDefaults: {} },
	};

	it('launches the low task on the local source, through the Run on recipe', async () => {
		const launch = await launchNextTask(DOCUMENT, agent);
		const plan = planOf(launch);

		expect(launch.turn).toMatchObject({
			model: ON_SERVER.model,
			runOn: ON_SERVER,
			tierSource: 'agent',
		});
		expect(deps.modelServer).toHaveBeenCalledWith(ON_SERVER.model);
		expect(plan.runOn).toMatchObject({ model: ON_SERVER.model });
		expect(plan.envVars).toMatchObject({
			ANTHROPIC_BASE_URL: SERVER_URL,
			ANTHROPIC_AUTH_TOKEN: 'sk-server',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: ON_SERVER.model,
			// The provider's own key is blanked, so it is not sent to the source.
			ANTHROPIC_API_KEY: '',
		});
		expect(modelArg(plan)).toBe(ON_SERVER.model);
	});

	it('launches the high task on the provider, with nothing of the source on it', async () => {
		const launch = await launchNextTask(DOCUMENT_AFTER_LOW, agent);
		const plan = planOf(launch);

		expect(launch.turn).toMatchObject({ model: 'opus', tierSource: 'built-in' });
		expect(launch.turn.runOn).toBeUndefined();
		expect(plan.runOn).toBeUndefined();
		expect(modelArg(plan)).toBe('opus');
		expect(plan.envVars ?? {}).not.toHaveProperty('ANTHROPIC_BASE_URL');
		expect(plan.envVars ?? {}).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
		// A provider launch reads no store and starts no server.
		expect(deps.modelServer).not.toHaveBeenCalled();
		expect(deps.endpoints).not.toHaveBeenCalled();
	});

	it('takes the low target from the harness default when the agent sets none', async () => {
		const launch = await launchNextTask(DOCUMENT, {
			...agent,
			routing: { harnessDefaults: { 'claude-code': { low: ON_OLLAMA } } },
		});
		const plan = planOf(launch);

		expect(launch.turn.tierSource).toBe('harness-default');
		expect(plan.envVars).toMatchObject({
			ANTHROPIC_BASE_URL: OLLAMA.baseUrl,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: ON_OLLAMA.model,
		});
		expect(modelArg(plan)).toBe(ON_OLLAMA.model);
	});
});

describe('an agent that runs on a source', () => {
	// Its own turns run on Ollama. The harness default sends `high` to the
	// provider's opus; nothing the user wrote names a `low` target.
	const agent: TaskAgent = {
		toolType: 'claude-code',
		customModel: 'sonnet',
		routing: {
			runOn: ON_OLLAMA,
			harnessDefaults: { 'claude-code': { high: { type: 'provider-model', model: 'opus' } } },
		},
	};

	it("keeps the low task on the agent's own source: the built-in table does not move it", async () => {
		const launch = await launchNextTask(DOCUMENT, agent);
		const plan = planOf(launch);

		expect(launch.turn.runOn).toBeUndefined();
		expect(launch.turn.warnings.join(' ')).toContain('runs on a Local Models source');
		expect(plan.runOn).toMatchObject({ model: ON_OLLAMA.model });
		expect(plan.envVars).toMatchObject({ ANTHROPIC_BASE_URL: OLLAMA.baseUrl });
		expect(modelArg(plan)).toBe(ON_OLLAMA.model);
	});

	it('launches the high task on the provider, because a layer the user wrote says so', async () => {
		const launch = await launchNextTask(DOCUMENT_AFTER_LOW, agent);
		const plan = planOf(launch);

		expect(launch.turn).toMatchObject({
			model: 'opus',
			runOn: { type: 'provider' },
			tierSource: 'harness-default',
		});
		expect(plan.runOn).toBeUndefined();
		expect(modelArg(plan)).toBe('opus');
		expect(plan.envVars ?? {}).not.toHaveProperty('ANTHROPIC_BASE_URL');
		expect(deps.listModels).not.toHaveBeenCalled();
	});
});

describe('a tier target that cannot run', () => {
	it('refuses the task when the source does not serve the model, and builds no plan', async () => {
		const launch = await launchNextTask(DOCUMENT, {
			toolType: 'claude-code',
			customModel: 'sonnet',
			routing: { tierTargets: { low: { ...ON_OLLAMA, model: 'not-pulled' } } },
		});

		expect(launch.kind).toBe('refused');
		expect(launch.kind === 'refused' && launch.message).toContain('not-pulled');
	});

	it('refuses a malformed target at the resolution, before any source is asked', async () => {
		const launch = await launchNextTask(DOCUMENT, {
			toolType: 'claude-code',
			routing: { tierTargets: { low: { type: 'source' } as never } },
		});

		expect(launch.kind).toBe('refused');
		expect(launch.kind === 'refused' && launch.message).toContain(
			'"low" tier target cannot be used'
		);
		expect(deps.listModels).not.toHaveBeenCalled();
		expect(deps.modelServer).not.toHaveBeenCalled();
	});

	it('launches the next task of the same document all the same', async () => {
		const launch = await launchNextTask(DOCUMENT_AFTER_LOW, {
			toolType: 'claude-code',
			routing: { tierTargets: { low: { type: 'source' } as never } },
		});

		expect(modelArg(planOf(launch))).toBe('opus');
	});
});
