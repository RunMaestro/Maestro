/**
 * @file route-turn.test.ts
 *
 * `routeTurn`, with every router mocked at its own entry: the embedding router
 * behind `runEmbeddingRouteTask`, the local judge behind `askLocalJudge`, and
 * System One behind `runSystemOneTask`. What is under test is the part no
 * router owns:
 *
 *   - **The assignment picks the router**, and no router stands in for another.
 *   - **A send never waits past the timeout and never fails here.** A router
 *     that cannot be stopped is overtaken; a bug in one is reported and
 *     answered as a skip.
 *   - **Every reason a turn gets no decision** is named, with the router asked.
 *   - **Every routing that asked a router is in the ledger once**: written here
 *     for the two local routers, left to `runSystemOneTask` for System One.
 *   - **The embedding router's vectors follow the assignment**, and nothing is
 *     loaded at a start.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const mocks = vi.hoisted(() => ({
	runEmbeddingRouteTask: vi.fn(),
	runSystemOneTask: vi.fn(),
	askLocalJudge: vi.fn(),
	systemOneKeepsInputs: vi.fn(),
	keepSystemOneDecision: vi.fn(),
	warm: vi.fn(),
	reset: vi.fn(),
}));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
}));
vi.mock('../../../main/local-models/endpoint-service', () => ({
	getConfiguredLocalModelEndpoints: () => [{ id: 'ep-1', name: 'Ollama' }],
}));
vi.mock('../../../main/local-models/task-router', () => ({
	runEmbeddingRouteTask: mocks.runEmbeddingRouteTask,
	runSystemOneTask: mocks.runSystemOneTask,
}));
vi.mock('../../../main/local-models/system-one/local-judge', () => ({
	askLocalJudge: mocks.askLocalJudge,
}));
vi.mock('../../../main/local-models/system-one/service', () => ({
	systemOneKeepsInputs: mocks.systemOneKeepsInputs,
}));
vi.mock('../../../main/local-models/system-one/decisions', () => ({
	keepSystemOneDecision: mocks.keepSystemOneDecision,
}));
vi.mock('../../../main/local-models/model-router', () => ({
	getEmbeddingRouter: () => ({ warm: mocks.warm, reset: mocks.reset }),
}));

import {
	LocalModelEndpointError,
	LocalModelError,
	SystemOneError,
} from '../../../main/local-models/errors';
import {
	refreshModelRouting,
	resetModelRoutingForTests,
	routeTurn,
	routeTurnRequest,
	startModelRouting,
} from '../../../main/local-models/route-turn';
import { captureException } from '../../../main/utils/sentry';
import {
	BGE_SMALL_EN_ID,
	EMBEDDINGGEMMA_300M_ID,
	QWEN3_1_7B_ID,
	getLocalModel,
} from '../../../shared/local-models/model-catalog';
import {
	MODEL_ROUTING_TIMEOUT_MS,
	isModelRouteSkipped,
	modelRoutingSystemOneRequest,
	type ModelRouteSkipped,
	type RouteTurnResult,
} from '../../../shared/local-models/model-routing-task';
import type { SystemOneErrorCode } from '../../../shared/local-models/system-one';

const BGE = { type: 'local', modelId: BGE_SMALL_EN_ID } as const;
const GEMMA = { type: 'local', modelId: EMBEDDINGGEMMA_300M_ID } as const;
const QWEN = { type: 'local', modelId: QWEN3_1_7B_ID } as const;
const ENDPOINT = { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' } as const;
const SYSTEM_ONE = { type: 'system-one' } as const;

const BGE_NAME = getLocalModel(BGE_SMALL_EN_ID)!.displayName;
const QWEN_NAME = getLocalModel(QWEN3_1_7B_ID)!.displayName;

const PROMPT = 'Rename the helper in utils.ts';
const TURN = {
	prompt: PROMPT,
	recent: { user: 'Where is the helper?', assistant: 'In utils.ts. Rename it?' },
	agent: { id: 'agent-7', tabId: 'tab-3' },
};

const EMBEDDING_ENGINE = {
	id: 'embedding-router',
	label: `Embedding router (${BGE_NAME}), not calibrated`,
	calibrated: false,
};
const JUDGE_ENGINE = {
	id: 'local-judge',
	label: `Local judge (${QWEN_NAME}), not calibrated`,
	calibrated: false,
};
const JEV_LABEL = 'Jev (TypeSafe cloud)';

function assign(assignment: unknown): void {
	settings.set('localModelAssignments', { 'model-routing': assignment });
}

/** A vote of the embedding router, as `runEmbeddingRouteTask` hands it back. */
function voted(tier = 'medium', effort = 'low') {
	return {
		status: 'ok',
		decision: {
			tier,
			effort,
			tierConfidence: 0.6,
			effortConfidence: 0.25,
			neighbours: [],
			exampleCount: 57,
			source: BGE,
		},
		source: BGE,
		durationMs: 12,
	};
}

/** The answers of an engine or a judge: a level per question. */
function answered(tier: number, effort: number, confidence?: number) {
	const answer = (score: number) => ({
		type: 'score',
		score,
		...(confidence !== undefined ? { confidence } : {}),
	});
	return { tier: answer(tier), effort: answer(effort) };
}

function judgeError(code: SystemOneErrorCode, message: string): SystemOneError {
	return new SystemOneError(message, { code, engine: 'local-judge' });
}

/** Let the record, which is written after the answer is returned, land. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

/** The one decision `routeTurn` filed itself, and the request kept with it. */
async function recorded(): Promise<{ decision: Record<string, unknown>; kept: unknown }> {
	await flush();
	expect(mocks.keepSystemOneDecision).toHaveBeenCalledTimes(1);
	const [decision, kept] = mocks.keepSystemOneDecision.mock.calls[0];
	return { decision: decision as Record<string, unknown>, kept };
}

function skippedOf(result: RouteTurnResult): ModelRouteSkipped {
	expect(isModelRouteSkipped(result)).toBe(true);
	return result as ModelRouteSkipped;
}

/** A promise that never settles, like a model that is still loading. */
function never<T>(): Promise<T> {
	return new Promise<T>(() => undefined);
}

beforeEach(() => {
	settings.clear();
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.systemOneKeepsInputs.mockResolvedValue(false);
	mocks.warm.mockResolvedValue(undefined);
	vi.mocked(captureException).mockClear();
	resetModelRoutingForTests();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('routeTurn: turns that ask nothing', () => {
	it('skips as off on the default assignment, saying where to assign a router', async () => {
		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('off');
		expect(result.detail).toBe(
			'Model routing is off. Assign it a router in Settings > Models > System One.'
		);
		expect(result).not.toHaveProperty('engine');
		await flush();
		expect(mocks.runEmbeddingRouteTask).not.toHaveBeenCalled();
		expect(mocks.askLocalJudge).not.toHaveBeenCalled();
		expect(mocks.runSystemOneTask).not.toHaveBeenCalled();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});

	it('skips a blank prompt as no-prompt, whichever router is assigned', async () => {
		for (const assignment of [BGE, QWEN, SYSTEM_ONE]) {
			assign(assignment);
			expect(skippedOf(await routeTurn({ prompt: '  \n ' })).skipped).toBe('no-prompt');
		}
		await flush();
		expect(mocks.runEmbeddingRouteTask).not.toHaveBeenCalled();
		expect(mocks.askLocalJudge).not.toHaveBeenCalled();
		expect(mocks.runSystemOneTask).not.toHaveBeenCalled();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});

	it('skips a send that was already stopped as cancelled, and records nothing', async () => {
		assign(BGE);
		const stopped = new AbortController();
		stopped.abort();

		const result = skippedOf(await routeTurn(TURN, { signal: stopped.signal }));

		expect(result.skipped).toBe('cancelled');
		await flush();
		expect(mocks.runEmbeddingRouteTask).not.toHaveBeenCalled();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});
});

describe('routeTurn on an embedding model', () => {
	beforeEach(() => assign(BGE));

	it('returns the vote with its margins and names the embedding router', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted('medium', 'low'));

		const result = await routeTurn(TURN);

		expect(result).toEqual({
			tier: 'medium',
			effort: 'low',
			tierConfidence: 0.6,
			effortConfidence: 0.25,
			engine: EMBEDDING_ENGINE,
			latencyMs: expect.any(Number),
		});
	});

	it('hands the router the prompt alone, never the recent exchange', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted());

		await routeTurn({ ...TURN, prompt: `  ${PROMPT}  ` });

		expect(mocks.runEmbeddingRouteTask).toHaveBeenCalledWith('model-routing', {
			text: PROMPT,
			// The agent rides on the run the router's model leaves, not in its input.
			agentId: 'agent-7',
			signal: expect.any(AbortSignal),
		});
		expect(JSON.stringify(mocks.runEmbeddingRouteTask.mock.calls)).not.toContain('Where is');
		// No other router is asked beside it.
		expect(mocks.askLocalJudge).not.toHaveBeenCalled();
		expect(mocks.runSystemOneTask).not.toHaveBeenCalled();
	});

	it('names no agent on the run when the turn has none', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted());

		await routeTurn({ prompt: PROMPT });

		expect(mocks.runEmbeddingRouteTask).toHaveBeenCalledWith('model-routing', {
			text: PROMPT,
			signal: expect.any(AbortSignal),
		});
	});

	it('files the decision in the ledger in the shape an engine decision has', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted('high', 'medium'));

		const result = await routeTurn(TURN);
		const { decision, kept } = await recorded();

		expect(decision).toEqual({
			taskId: 'model-routing',
			engine: 'embedding-router',
			model: `local:${BGE_SMALL_EN_ID}`,
			questionIds: ['tier', 'effort'],
			answers: {
				tier: { type: 'score', score: 2, confidence: 0.6 },
				effort: { type: 'score', score: 1, confidence: 0.25 },
			},
			outcome: 'ok',
			costUsd: 0,
			startedAt: expect.any(Number),
			latencyMs: result.latencyMs,
			agentId: 'agent-7',
			tabId: 'tab-3',
		});
		// "Keep inputs in the ledger" is off: no text is kept.
		expect(kept).toBeNull();
	});

	it('keeps what the router read only while Keep inputs is on: the prompt, and no question', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted());
		mocks.systemOneKeepsInputs.mockResolvedValue(true);

		await routeTurn(TURN);

		expect((await recorded()).kept).toEqual({ state: PROMPT, questions: {} });
	});

	it('records a turn with no agent under no agent', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted());

		await routeTurn({ prompt: PROMPT });
		const { decision } = await recorded();

		expect(decision).not.toHaveProperty('agentId');
		expect(decision).not.toHaveProperty('tabId');
	});

	it('still files the decision when the Keep inputs setting cannot be read, without the text', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted());
		mocks.systemOneKeepsInputs.mockRejectedValue(new Error('settings file is locked'));

		await routeTurn(TURN);
		const { decision, kept } = await recorded();

		expect(decision.outcome).toBe('ok');
		expect(kept).toBeNull();
		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it('skips as unavailable when the model cannot run, naming it, and asks no other router', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue({
			status: 'unavailable',
			source: BGE,
			reason: `${BGE_NAME} is not downloaded. Download it in Settings.`,
			code: 'model-not-installed',
		});

		const result = skippedOf(await routeTurn(TURN));

		expect(result).toMatchObject({ skipped: 'unavailable', engine: EMBEDDING_ENGINE });
		expect(result.detail).toBe(
			`${EMBEDDING_ENGINE.label}: could not route. ${BGE_NAME} is not downloaded. Download it in Settings.`
		);
		expect(mocks.askLocalJudge).not.toHaveBeenCalled();
		expect(mocks.runSystemOneTask).not.toHaveBeenCalled();
		const { decision } = await recorded();
		expect(decision).toMatchObject({ outcome: 'unavailable', code: 'unavailable' });
		expect(decision).not.toHaveProperty('answers');
	});

	it('reads a router stopped by the deadline as a timeout', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue({ status: 'cancelled', source: BGE });

		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('timeout');
		expect((await recorded()).decision).toMatchObject({ outcome: 'unavailable', code: 'timeout' });
	});

	it('reads a router stopped by the caller as cancelled, which is not a fault', async () => {
		const caller = new AbortController();
		mocks.runEmbeddingRouteTask.mockImplementation(async () => {
			caller.abort();
			return { status: 'cancelled', source: BGE };
		});

		const result = skippedOf(await routeTurn(TURN, { signal: caller.signal }));

		expect(result.skipped).toBe('cancelled');
		expect((await recorded()).decision).toMatchObject({ outcome: 'cancelled', code: 'cancelled' });
		expect(captureException).not.toHaveBeenCalled();
	});

	it('skips, and files nothing, when the assignment was switched off mid-route', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue({ status: 'off' });

		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('unavailable');
		expect(result.detail).toMatch(/was reassigned while this turn was being routed/);
		await flush();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});

	it('reports a bug in the router and answers a skip: a send is never failed here', async () => {
		mocks.runEmbeddingRouteTask.mockRejectedValue(new Error('embeddings of more than one width'));

		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('unavailable');
		expect(result.detail).toMatch(/failed: embeddings of more than one width/);
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'modelRouting:routeTurn' })
		);
		expect((await recorded()).decision).toMatchObject({ outcome: 'unavailable' });
	});
});

describe('routeTurn: the hard timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		assign(BGE);
	});

	it('answers at the timeout when the router cannot be stopped, and not a moment before', async () => {
		mocks.runEmbeddingRouteTask.mockReturnValue(never());
		const settled = vi.fn();
		const routing = routeTurn(TURN).then((result) => {
			settled(result);
			return result;
		});

		await vi.advanceTimersByTimeAsync(MODEL_ROUTING_TIMEOUT_MS - 1);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		const result = skippedOf(await routing);

		expect(result).toMatchObject({ skipped: 'timeout', engine: EMBEDDING_ENGINE });
		expect(result.detail).toBe(`${EMBEDDING_ENGINE.label}: no decision within 400 ms.`);
	});

	it('tells the router to stop at the deadline, and files the timeout once', async () => {
		mocks.runEmbeddingRouteTask.mockReturnValue(never());
		const routing = routeTurn(TURN);
		const { signal } = mocks.runEmbeddingRouteTask.mock.calls[0][1] as { signal: AbortSignal };
		expect(signal.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(MODEL_ROUTING_TIMEOUT_MS);
		await routing;

		expect(signal.aborted).toBe(true);
		const { decision } = await recorded();
		expect(decision).toMatchObject({
			engine: 'embedding-router',
			outcome: 'unavailable',
			code: 'timeout',
		});
		expect(decision).not.toHaveProperty('answers');
	});

	it("waits the caller's own budget when it names one", async () => {
		mocks.runEmbeddingRouteTask.mockReturnValue(never());
		const settled = vi.fn();
		const routing = routeTurn(TURN, { timeoutMs: 2_000 }).then(settled);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await routing;

		expect(skippedOf(settled.mock.calls[0][0]).detail).toMatch(/within 2000 ms/);
	});

	it('uses an answer that arrives in time, and holds no timer after it', async () => {
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted('low', 'low'));

		const result = await routeTurn(TURN);

		expect(isModelRouteSkipped(result)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reports a failure of the work it overtook, and never throws it at anyone', async () => {
		let fail: (error: Error) => void = () => undefined;
		mocks.runEmbeddingRouteTask.mockReturnValue(
			new Promise((_resolve, reject) => {
				fail = reject;
			})
		);
		const routing = routeTurn(TURN);
		await vi.advanceTimersByTimeAsync(MODEL_ROUTING_TIMEOUT_MS);
		expect(skippedOf(await routing).skipped).toBe('timeout');
		expect(captureException).not.toHaveBeenCalled();

		fail(new Error('the model crashed while loading'));
		await flush();

		expect(captureException).toHaveBeenCalledTimes(1);
		// One record: the timeout. The late failure adds none.
		expect(mocks.keepSystemOneDecision).toHaveBeenCalledTimes(1);
	});

	it('leaves the record of an overtaken System One run to the task router', async () => {
		assign(SYSTEM_ONE);
		mocks.runSystemOneTask.mockReturnValue(never());
		const routing = routeTurn(TURN);

		await vi.advanceTimersByTimeAsync(MODEL_ROUTING_TIMEOUT_MS);
		const result = skippedOf(await routing);

		expect(result.skipped).toBe('timeout');
		// The engine is not known until the task router resolves it.
		expect(result).not.toHaveProperty('engine');
		await flush();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});
});

describe('routeTurn on a text model (a local judge)', () => {
	beforeEach(() => assign(QWEN));

	it("asks the two questions on the task's own model, inside the timeout", async () => {
		mocks.askLocalJudge.mockResolvedValue({
			answers: answered(2, 1),
			usage: { inputTokens: 410, outputTokens: 16 },
		});
		const request = modelRoutingSystemOneRequest(TURN);

		const result = await routeTurn(TURN);

		expect(mocks.askLocalJudge).toHaveBeenCalledWith(request.state, request.questions, {
			taskId: 'model-routing',
			// Kept on each generation's run record (`local_model_runs.agent_id`).
			agentId: 'agent-7',
			timeoutMs: MODEL_ROUTING_TIMEOUT_MS,
		});
		expect(result).toEqual({
			tier: 'high',
			effort: 'medium',
			engine: JUDGE_ENGINE,
			latencyMs: expect.any(Number),
		});
		expect(mocks.runEmbeddingRouteTask).not.toHaveBeenCalled();
		expect(mocks.runSystemOneTask).not.toHaveBeenCalled();
	});

	it('shows the judge the recent exchange, which the embedding router never sees', async () => {
		mocks.askLocalJudge.mockResolvedValue({ answers: answered(0, 0), usage: undefined });

		await routeTurn(TURN);

		expect(mocks.askLocalJudge.mock.calls[0][0]).toEqual({
			prompt: PROMPT,
			recent: TURN.recent,
		});
	});

	it("passes the caller's signal, so only the caller reads as cancelled", async () => {
		mocks.askLocalJudge.mockResolvedValue({ answers: answered(1, 1) });
		const caller = new AbortController();

		await routeTurn(TURN, { signal: caller.signal, timeoutMs: 900 });

		expect(mocks.askLocalJudge.mock.calls[0][2]).toEqual({
			taskId: 'model-routing',
			agentId: 'agent-7',
			timeoutMs: 900,
			signal: caller.signal,
		});
	});

	it('files the decision with the tokens the model counted, and no confidence it did not give', async () => {
		mocks.askLocalJudge.mockResolvedValue({
			answers: answered(1, 2),
			usage: { inputTokens: 410, outputTokens: 16 },
		});
		mocks.systemOneKeepsInputs.mockResolvedValue(true);

		await routeTurn(TURN);
		const { decision, kept } = await recorded();

		expect(decision).toMatchObject({
			taskId: 'model-routing',
			engine: 'local-judge',
			model: `local:${QWEN3_1_7B_ID}`,
			questionIds: ['tier', 'effort'],
			answers: { tier: { type: 'score', score: 1 }, effort: { type: 'score', score: 2 } },
			outcome: 'ok',
			usage: { inputTokens: 410, outputTokens: 16 },
			costUsd: 0,
			agentId: 'agent-7',
		});
		// The judge was asked the questions, so the kept input has them.
		expect(kept).toEqual(modelRoutingSystemOneRequest(TURN));
	});

	it('names an endpoint model as the judge it is', async () => {
		assign(ENDPOINT);
		mocks.askLocalJudge.mockResolvedValue({ answers: answered(0, 0) });

		const result = await routeTurn(TURN);

		expect(!isModelRouteSkipped(result) && result.engine).toEqual({
			id: 'local-judge',
			label: 'Local judge (qwen3:latest on Ollama), not calibrated',
			calibrated: false,
		});
		expect((await recorded()).decision.model).toBe('endpoint:ep-1:qwen3:latest');
	});

	it.each([
		['timeout', 'timeout', 'timeout'],
		['unavailable', 'unavailable', 'unavailable'],
		['auth', 'unavailable', 'auth'],
		['too-large', 'unavailable', 'too-large'],
	] as const)(
		'skips a judge that fails with %s as %s, and files the code',
		async (code, skipped, filed) => {
			mocks.askLocalJudge.mockRejectedValue(judgeError(code, `Local judge: ${code}.`));

			const result = skippedOf(await routeTurn(TURN));

			expect(result).toMatchObject({
				skipped,
				detail: `Local judge: ${code}.`,
				engine: JUDGE_ENGINE,
			});
			expect((await recorded()).decision).toMatchObject({ outcome: 'unavailable', code: filed });
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('skips a judge the caller stopped as cancelled', async () => {
		mocks.askLocalJudge.mockRejectedValue(judgeError('cancelled', 'Cancelled.'));

		expect(skippedOf(await routeTurn(TURN)).skipped).toBe('cancelled');
		expect((await recorded()).decision).toMatchObject({ outcome: 'cancelled' });
	});

	it('is no decision when the answers are not a tier and an effort', async () => {
		mocks.askLocalJudge.mockResolvedValue({ answers: { tier: { type: 'score', score: 1 } } });

		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('unavailable');
		expect(result.detail).toBe(`${JUDGE_ENGINE.label}: the answer was not a tier and an effort.`);
		expect((await recorded()).decision).toMatchObject({ outcome: 'unavailable' });
	});

	it('reports an unclassified failure of the model and answers a skip', async () => {
		mocks.askLocalJudge.mockRejectedValue(new TypeError('cannot read context'));

		expect(skippedOf(await routeTurn(TURN)).skipped).toBe('unavailable');
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});

describe('routeTurn on System One', () => {
	beforeEach(() => assign(SYSTEM_ONE));

	it('asks the engine in force through the task router, with the agent and the timeout', async () => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'ok',
			engine: 'jev-cloud',
			engineLabel: JEV_LABEL,
			answers: answered(1.6, 0.2, 0.88),
			calibrated: true,
		});

		const result = await routeTurn(TURN);

		expect(mocks.runSystemOneTask).toHaveBeenCalledWith(
			'model-routing',
			{ prompt: PROMPT, recent: TURN.recent },
			{ timeoutMs: MODEL_ROUTING_TIMEOUT_MS, agentId: 'agent-7', tabId: 'tab-3' }
		);
		expect(result).toEqual({
			// 1.6 is nearer high, 0.2 nearer low.
			tier: 'high',
			effort: 'low',
			tierConfidence: 0.88,
			effortConfidence: 0.88,
			engine: { id: 'jev-cloud', label: JEV_LABEL, calibrated: true },
			latencyMs: expect.any(Number),
		});
		expect(mocks.runEmbeddingRouteTask).not.toHaveBeenCalled();
		expect(mocks.askLocalJudge).not.toHaveBeenCalled();
	});

	it('files nothing itself: the task router already kept the decision', async () => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'ok',
			engine: 'openjev',
			engineLabel: 'OpenJev at jev.lan',
			answers: answered(0, 0),
		});

		await routeTurn(TURN);
		await flush();

		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});

	it('says the System One local judge is not calibrated', async () => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'ok',
			engine: 'local-judge',
			engineLabel: 'Local judge (Qwen), not calibrated',
			answers: answered(1, 1),
		});

		const result = await routeTurn(TURN);

		expect(!isModelRouteSkipped(result) && result.engine.calibrated).toBe(false);
	});

	it.each([
		['timeout', 'timeout'],
		['auth', 'unavailable'],
		['rate-limited', 'unavailable'],
		['unavailable', 'unavailable'],
	] as const)('skips an engine with no answer (%s) as %s', async (code, skipped) => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'unavailable',
			engine: 'jev-cloud',
			engineLabel: JEV_LABEL,
			code,
			reason: `${JEV_LABEL}: ${code}.`,
		});

		expect(skippedOf(await routeTurn(TURN))).toMatchObject({
			skipped,
			detail: `${JEV_LABEL}: ${code}.`,
			engine: { id: 'jev-cloud', label: JEV_LABEL, calibrated: true },
		});
		await flush();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});

	it('skips with no engine named when System One is off', async () => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'unavailable',
			engine: 'off',
			engineLabel: 'Off',
			code: 'off',
			reason: 'Model routing is assigned to System One, and System One is off.',
		});

		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('unavailable');
		expect(result.detail).toMatch(/System One is off/);
		expect(result).not.toHaveProperty('engine');
	});

	it('skips a request the caller stopped as cancelled', async () => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'cancelled',
			engine: 'jev-cloud',
			engineLabel: JEV_LABEL,
		});

		expect(skippedOf(await routeTurn(TURN)).skipped).toBe('cancelled');
	});

	it('is no decision when the engine answered without a tier and an effort', async () => {
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'ok',
			engine: 'jev-cloud',
			engineLabel: JEV_LABEL,
			answers: { tier: { type: 'noul', probability: 0.5 } },
		});

		const result = skippedOf(await routeTurn(TURN));

		expect(result.skipped).toBe('unavailable');
		expect(result.detail).toBe(`${JEV_LABEL}: the answer was not a tier and an effort.`);
	});

	it('skips when the assignment moved off System One mid-route', async () => {
		mocks.runSystemOneTask.mockResolvedValue({ status: 'not-assigned' });

		expect(skippedOf(await routeTurn(TURN)).detail).toMatch(/was reassigned/);
	});

	it('reports an unclassified engine failure, answers a skip, and has no router to file under', async () => {
		mocks.runSystemOneTask.mockRejectedValue(new Error('engine bug'));

		expect(skippedOf(await routeTurn(TURN)).skipped).toBe('unavailable');
		expect(captureException).toHaveBeenCalledTimes(1);
		await flush();
		expect(mocks.keepSystemOneDecision).not.toHaveBeenCalled();
	});
});

describe('routeTurnRequest: a routing asked from the renderer or the CLI', () => {
	it('routes the prompt for the agent and tab it names, and files the decision under them', async () => {
		assign(BGE);
		mocks.runEmbeddingRouteTask.mockResolvedValue(voted('high', 'medium'));

		const result = await routeTurnRequest({
			prompt: PROMPT,
			recent: TURN.recent,
			agentId: 'agent-7',
			tabId: 'tab-3',
		});

		expect(result).toMatchObject({ tier: 'high', effort: 'medium', engine: EMBEDDING_ENGINE });
		const { decision } = await recorded();
		expect(decision).toMatchObject({ taskId: 'model-routing', agentId: 'agent-7', tabId: 'tab-3' });
	});

	it('hands the recent exchange to a router that reads text', async () => {
		assign(SYSTEM_ONE);
		mocks.runSystemOneTask.mockResolvedValue({
			status: 'ok',
			engine: 'jev-cloud',
			engineLabel: JEV_LABEL,
			answers: answered(0, 0, 0.9),
		});

		await routeTurnRequest({ prompt: PROMPT, recent: TURN.recent, agentId: 'agent-7' });

		expect(mocks.runSystemOneTask).toHaveBeenCalledWith(
			'model-routing',
			{ prompt: PROMPT, recent: TURN.recent },
			expect.objectContaining({ agentId: 'agent-7', timeoutMs: MODEL_ROUTING_TIMEOUT_MS })
		);
	});

	it('waits as long as the caller asks, for a turn nobody is typing at', async () => {
		assign(QWEN);
		mocks.askLocalJudge.mockResolvedValue({ answers: answered(1, 1) });

		await routeTurnRequest({ prompt: PROMPT, timeoutMs: 5000 });

		expect(mocks.askLocalJudge.mock.calls[0][2]).toMatchObject({ timeoutMs: 5000 });
	});

	it('answers a skip like any routing: off is a result, not an error', async () => {
		const result = skippedOf(await routeTurnRequest({ prompt: PROMPT }));
		expect(result.skipped).toBe('off');
	});

	it('rejects a request it cannot read, and asks no router', async () => {
		assign(BGE);

		await expect(routeTurnRequest({ prompt: 7 })).rejects.toThrow(/prompt is text/);
		await expect(routeTurnRequest(null)).rejects.toThrow(/routing request/);
		await expect(routeTurnRequest({ prompt: 'p', timeoutMs: -1 })).rejects.toThrow(/timeout/);

		expect(mocks.runEmbeddingRouteTask).not.toHaveBeenCalled();
	});
});

describe('refreshModelRouting', () => {
	it('only notes where routing stands on the first look: a start loads nothing', () => {
		assign(BGE);

		refreshModelRouting();

		expect(mocks.warm).not.toHaveBeenCalled();
		expect(mocks.reset).not.toHaveBeenCalled();
	});

	it('embeds the examples when the assignment changes to an embedding model, once', () => {
		refreshModelRouting();
		assign(BGE);

		refreshModelRouting();
		refreshModelRouting();

		expect(mocks.warm).toHaveBeenCalledTimes(1);
		expect(mocks.warm).toHaveBeenCalledWith(BGE);
	});

	it('embeds again for another embedding model', () => {
		assign(BGE);
		refreshModelRouting();
		assign(GEMMA);

		refreshModelRouting();

		expect(mocks.warm).toHaveBeenCalledTimes(1);
		expect(mocks.warm).toHaveBeenCalledWith(GEMMA);
	});

	it('drops the vectors when routing leaves the embedding router', () => {
		assign(BGE);
		refreshModelRouting();

		for (const next of [QWEN, SYSTEM_ONE, { type: 'off' }]) {
			assign(BGE);
			refreshModelRouting();
			mocks.reset.mockClear();
			assign(next);
			refreshModelRouting();
			expect(mocks.reset).toHaveBeenCalledTimes(1);
		}
	});

	it('loads no embedding model for a judge or an engine', () => {
		refreshModelRouting();
		for (const next of [QWEN, ENDPOINT, SYSTEM_ONE]) {
			assign(next);
			refreshModelRouting();
		}

		expect(mocks.warm).not.toHaveBeenCalled();
	});

	it('logs a model that cannot be warmed as what it is, and reports only a bug', async () => {
		refreshModelRouting();
		mocks.warm.mockRejectedValueOnce(
			new LocalModelError('Not downloaded.', {
				code: 'model-not-installed',
				recovery: 'Download it.',
				consumerId: 'embeddings',
			})
		);
		assign(BGE);
		refreshModelRouting();
		await flush();
		expect(captureException).not.toHaveBeenCalled();

		mocks.warm.mockRejectedValueOnce(
			new LocalModelEndpointError('Down.', {
				kind: 'network',
				endpointId: 'ep-1',
				endpointName: 'Ollama',
				url: 'http://127.0.0.1:11434',
			})
		);
		assign(GEMMA);
		refreshModelRouting();
		await flush();
		expect(captureException).not.toHaveBeenCalled();

		mocks.warm.mockRejectedValueOnce(new Error('vector store bug'));
		assign(BGE);
		refreshModelRouting();
		await flush();
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});

describe('startModelRouting', () => {
	it('notes the assignment at a start, then follows the setting', () => {
		assign(BGE);
		const listeners: Array<() => void> = [];
		const store = {
			onDidChange: vi.fn((_key: string, listener: () => void) => {
				listeners.push(listener);
				return () => undefined;
			}),
		};

		startModelRouting(store as never);

		expect(store.onDidChange).toHaveBeenCalledWith('localModelAssignments', expect.any(Function));
		expect(mocks.warm).not.toHaveBeenCalled();

		assign(GEMMA);
		listeners[0]();

		expect(mocks.warm).toHaveBeenCalledWith(GEMMA);
	});
});
