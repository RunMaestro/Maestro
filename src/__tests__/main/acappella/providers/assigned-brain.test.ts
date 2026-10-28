/**
 * @file assigned-brain.test.ts
 *
 * The Conductor Brain on a Local Models source, against a mocked task router.
 *
 * Nothing here loads a model or reaches a server: the router is the seam. What
 * is worth testing is what this provider adds around a turn, which is where a
 * bug would send a spoken instruction to the wrong place or leave the user in
 * silence: the schema each kind of source is held to, the decision validated
 * against the roster whatever produced it, and every router verdict restated as
 * this provider's own classified failure, never as a different Brain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const routerMock = vi.hoisted(() => ({ runLocalTask: vi.fn() }));
vi.mock('../../../../main/local-models/task-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/local-models/task-router')>()),
	runLocalTask: routerMock.runLocalTask,
}));

import {
	ASSIGNED_BRAIN_TURN_TIMEOUT_MS,
	AssignedBrainProvider,
	localEngineTaskRunner,
} from '../../../../main/acappella/providers/local/assigned-brain';
import { LocalModelError, localModelCancelledError } from '../../../../main/local-models/errors';
import type { LocalTaskInput, LocalTaskResult } from '../../../../main/local-models/task-router';
import {
	ENDPOINT_BRAIN_PROVIDER_ID,
	QWEN3_BRAIN_PROVIDER_ID,
} from '../../../../shared/acappella/provider-catalog';
import type { RosterAgent } from '../../../../shared/acappella/protocol';
import {
	ROUTE_DECISION_GRAMMAR_SCHEMA,
	ROUTE_DECISION_JSON_SCHEMA,
	holdsTheFloor,
} from '../../../../shared/acappella/route-decision';
import type { VoiceBrainSource } from '../../../../shared/acappella/voice-routing';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
	},
];
const CONTEXT = { roster: ROSTER, scope: { kind: 'conductor' as const } };

const LOCAL_SOURCE: VoiceBrainSource = {
	assignment: { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
	spec: 'local:qwen3-1.7b-instruct-q4km',
	label: 'Qwen3 1.7B Instruct (Q4_K_M)',
};
const ENDPOINT_SOURCE: VoiceBrainSource = {
	assignment: { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.3' },
	spec: 'endpoint:ep-1:llama3.3',
	label: 'llama3.3 on Ollama',
	endpointName: 'Ollama',
};

const DECISION = JSON.stringify({
	target: { sessionId: 'agent-backend' },
	tabAction: 'new',
	tabName: 'Auth',
	prompt: 'refactor auth',
	confidence: 0.9,
});

function ok(text: string): LocalTaskResult {
	return { status: 'ok', text, source: LOCAL_SOURCE.assignment, durationMs: 12 };
}

function providerWith(
	verdict: LocalTaskResult | Error,
	options: { id?: typeof QWEN3_BRAIN_PROVIDER_ID | typeof ENDPOINT_BRAIN_PROVIDER_ID } = {}
) {
	const runTask = vi.fn(async (_input: LocalTaskInput): Promise<LocalTaskResult> => {
		if (verdict instanceof Error) throw verdict;
		return verdict;
	});
	const id = options.id ?? QWEN3_BRAIN_PROVIDER_ID;
	const provider = new AssignedBrainProvider({
		id,
		source: id === QWEN3_BRAIN_PROVIDER_ID ? LOCAL_SOURCE : ENDPOINT_SOURCE,
		runTask,
	});
	return { provider, runTask };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('AssignedBrainProvider', () => {
	it('routes through the task router on the voice-routing task by default', async () => {
		routerMock.runLocalTask.mockResolvedValue(ok(DECISION));
		const provider = new AssignedBrainProvider({ id: QWEN3_BRAIN_PROVIDER_ID });

		const decision = await provider.route('ask backend to refactor auth', CONTEXT);

		expect(routerMock.runLocalTask).toHaveBeenCalledTimes(1);
		expect(routerMock.runLocalTask.mock.calls[0][0]).toBe('voice-routing');
		expect(decision).toMatchObject({ target: { sessionId: 'agent-backend' }, tabAction: 'new' });
	});

	it('holds a local model to the grammar schema and an endpoint to the JSON schema', async () => {
		const local = providerWith(ok(DECISION));
		const endpoint = providerWith(ok(DECISION), { id: ENDPOINT_BRAIN_PROVIDER_ID });

		await local.provider.route('one', CONTEXT);
		await endpoint.provider.route('one', CONTEXT);

		// A llama.cpp grammar emits every listed property, so the local shape lets
		// the optional ones be null; a server honors `required` and gets the plain one.
		expect(local.runTask.mock.calls[0][0].jsonSchema).toBe(ROUTE_DECISION_GRAMMAR_SCHEMA);
		expect(endpoint.runTask.mock.calls[0][0].jsonSchema).toBe(ROUTE_DECISION_JSON_SCHEMA);
	});

	it('asks deterministically, with a bounded turn', async () => {
		const { provider, runTask } = providerWith(ok(DECISION));

		await provider.route('one', CONTEXT);

		const input = runTask.mock.calls[0][0];
		expect(input.temperature).toBe(0);
		expect(input.signal).toBeInstanceOf(AbortSignal);
		expect(input.system).toContain('route spoken instructions');
		expect(input.prompt).toContain('Utterance: one');
		expect(ASSIGNED_BRAIN_TURN_TIMEOUT_MS).toBeGreaterThan(0);
	});

	it('reads a grammar reply with null optional fields as a dispatch, not a question', async () => {
		const { provider } = providerWith(
			ok(
				JSON.stringify({
					target: { sessionId: 'agent-backend' },
					tabAction: 'current',
					tabId: null,
					tabName: null,
					prompt: 'fix the navbar padding',
					confidence: 0.9,
					clarify: null,
					reply: null,
				})
			)
		);

		const decision = await provider.route('tell backend to fix the navbar padding', CONTEXT);

		expect(holdsTheFloor(decision)).toBe(false);
		expect(decision).toMatchObject({
			target: { sessionId: 'agent-backend' },
			prompt: 'fix the navbar padding',
		});
		expect(decision.tabId).toBeUndefined();
	});

	it('sends an id that is not in the roster to the conductor', async () => {
		const { provider } = providerWith(
			ok(JSON.stringify({ target: { sessionId: 'agent-invented' }, prompt: 'x', confidence: 1 }))
		);

		const decision = await provider.route('anything', CONTEXT);

		// A schema guarantees a well-formed id, not a real one.
		expect(decision.target).toBe('conductor');
	});

	it('trims a spoken rewrite to the sentence budget, with no schema', async () => {
		const { provider, runTask } = providerWith(ok('One. Two. Three.'));

		const spoken = await provider.converse('...', {
			agentSessionId: 'agent-backend',
			tabId: 'tab-auth',
			maxSentences: 2,
		});

		expect(spoken).toBe('One. Two.');
		expect(runTask.mock.calls[0][0].jsonSchema).toBeUndefined();
	});

	it('reports a source that cannot run as its own failure, with the router sentence', async () => {
		const { provider } = providerWith({
			status: 'unavailable',
			source: LOCAL_SOURCE.assignment,
			reason: 'Qwen3 1.7B Instruct (Q4_K_M) is not downloaded. Download it in Settings.',
			code: 'model-not-installed',
		});

		await expect(provider.route('anything', CONTEXT)).rejects.toMatchObject({
			name: 'VoiceProviderError',
			kind: 'unavailable',
			providerId: QWEN3_BRAIN_PROVIDER_ID,
			message: 'Qwen3 1.7B Instruct (Q4_K_M) is not downloaded. Download it in Settings.',
		});
	});

	it.each([
		['network', 'network'],
		['timeout', 'timeout'],
		['auth', 'auth'],
		['missing-key', 'unavailable'],
		['not-found', 'unavailable'],
		['runtime-unavailable', 'unavailable'],
	])('classifies an unavailable source with code %s as %s', async (code, kind) => {
		const { provider } = providerWith(
			{
				status: 'unavailable',
				source: ENDPOINT_SOURCE.assignment,
				reason: 'Ollama could not answer.',
				code,
			},
			{ id: ENDPOINT_BRAIN_PROVIDER_ID }
		);

		await expect(provider.converse('...', { maxSentences: 1 } as never)).rejects.toMatchObject({
			kind,
			providerId: ENDPOINT_BRAIN_PROVIDER_ID,
		});
	});

	it('reports a turn that ran out of time as a timeout naming the model', async () => {
		const { provider } = providerWith(
			{ status: 'cancelled', source: ENDPOINT_SOURCE.assignment },
			{ id: ENDPOINT_BRAIN_PROVIDER_ID }
		);

		await expect(provider.route('anything', CONTEXT)).rejects.toMatchObject({
			kind: 'timeout',
			message: expect.stringContaining('llama3.3 on Ollama (endpoint) did not answer'),
		});
	});

	it.each(['off', 'use-utility-agent'] as const)(
		'refuses by name when the assignment answers %s, and reaches for nothing else',
		async (status) => {
			const { provider, runTask } = providerWith({ status });

			await expect(provider.route('anything', CONTEXT)).rejects.toMatchObject({
				kind: 'unavailable',
				providerId: QWEN3_BRAIN_PROVIDER_ID,
				message: expect.stringContaining('Voice routing has no model assigned'),
			});
			expect(runTask).toHaveBeenCalledTimes(1);
		}
	);

	it('lets an unclassified failure through, because it is a bug', async () => {
		const { provider } = providerWith(new TypeError('undefined is not a function'));

		await expect(provider.route('anything', CONTEXT)).rejects.toBeInstanceOf(TypeError);
	});

	it('is labeled with the model the assignment named', () => {
		expect(providerWith(ok('')).provider.label).toBe('Qwen3 1.7B Instruct (Q4_K_M) (local)');
		expect(providerWith(ok(''), { id: ENDPOINT_BRAIN_PROVIDER_ID }).provider.label).toBe(
			'llama3.3 on Ollama (endpoint)'
		);
		expect(new AssignedBrainProvider({ id: QWEN3_BRAIN_PROVIDER_ID }).label).toBe('Local model');
		expect(new AssignedBrainProvider({ id: ENDPOINT_BRAIN_PROVIDER_ID }).label).toBe(
			'Model endpoint'
		);
		expect(providerWith(ok('')).provider.tier).toBe('local');
	});

	it('frees its own local model on teardown, and nothing for an endpoint', async () => {
		const unloadModel = vi.fn(async () => {});
		const local = new AssignedBrainProvider({
			id: QWEN3_BRAIN_PROVIDER_ID,
			source: LOCAL_SOURCE,
			unloadModel,
		});
		const endpoint = new AssignedBrainProvider({
			id: ENDPOINT_BRAIN_PROVIDER_ID,
			source: ENDPOINT_SOURCE,
			unloadModel,
		});

		await endpoint.unload();
		expect(unloadModel).not.toHaveBeenCalled();

		await local.unload();
		// By id, so the engine frees it only when it is the resident model.
		expect(unloadModel).toHaveBeenCalledWith('qwen3-1.7b-instruct-q4km');
	});
});

describe('localEngineTaskRunner', () => {
	const input: LocalTaskInput = { prompt: 'p', system: 's', jsonSchema: { type: 'object' } };

	it('runs the turn on the given engine and model', async () => {
		const generate = vi.fn(async () => ({ text: 'reply' }));
		const run = localEngineTaskRunner({ generate }, 'model-x');

		const verdict = await run(input);

		expect(verdict).toMatchObject({
			status: 'ok',
			text: 'reply',
			source: { type: 'local', modelId: 'model-x' },
		});
		expect(generate).toHaveBeenCalledWith(
			'model-x',
			expect.objectContaining({ prompt: 'p', system: 's', temperature: 0, maxTokens: 512 })
		);
	});

	it('classifies a core failure the way the router does', async () => {
		const run = localEngineTaskRunner(
			{
				generate: async () => {
					throw new LocalModelError('llama.cpp is not downloaded.', {
						code: 'runtime-unavailable',
						recovery: 'Download it.',
						consumerId: 'local-models:text-gen',
					});
				},
			},
			'model-x'
		);

		expect(await run(input)).toEqual({
			status: 'unavailable',
			source: { type: 'local', modelId: 'model-x' },
			reason: 'llama.cpp is not downloaded. Download it.',
			code: 'runtime-unavailable',
		});
	});

	it('reports a cancelled turn as cancelled, and rethrows a bug', async () => {
		const cancelled = localEngineTaskRunner(
			{
				generate: async () => {
					throw localModelCancelledError('local-models:text-gen');
				},
			},
			'model-x'
		);
		expect(await cancelled(input)).toEqual({
			status: 'cancelled',
			source: { type: 'local', modelId: 'model-x' },
		});

		const broken = localEngineTaskRunner(
			{
				generate: async () => {
					throw new RangeError('bug');
				},
			},
			'model-x'
		);
		await expect(broken(input)).rejects.toBeInstanceOf(RangeError);
	});
});
