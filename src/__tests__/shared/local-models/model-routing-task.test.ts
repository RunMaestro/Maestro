/**
 * Tests for the `model-routing` task's shared vocabulary: what a router is
 * handed, the two typed questions, how an answer is read back as a tier and an
 * effort, which router an assignment names, and what each is called.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	BGE_SMALL_EN_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
} from '../../../shared/local-models/model-catalog';
import { MODEL_ROUTING_TEXT_MAX_CHARS } from '../../../shared/local-models/model-routing';
import {
	EMBEDDING_ROUTER_ENGINE_ID,
	MODEL_ROUTING_EFFORT_DESCRIPTIONS,
	MODEL_ROUTING_QUESTION_IDS,
	MODEL_ROUTING_RECENT_MAX_CHARS,
	MODEL_ROUTING_SKIP_REASONS,
	MODEL_ROUTING_TASK_ID,
	MODEL_ROUTING_TIER_DESCRIPTIONS,
	MODEL_ROUTING_MAX_TIMEOUT_MS,
	MODEL_ROUTING_TIMEOUT_MS,
	MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
	clipModelRoutingRecent,
	embeddingRouterLabel,
	isModelRouteSkipped,
	isModelRoutingEngineCalibrated,
	modelRouteAnswers,
	modelRouteFromSystemOne,
	modelRouterEngineLabel,
	modelRouterKind,
	modelRouterSourceNote,
	modelRoutingSystemOneRequest,
	parseRouteTurnRequest,
} from '../../../shared/local-models/model-routing-task';
import {
	systemOneQuestionsProblem,
	systemOneStateProblem,
	type SystemOneAnswers,
} from '../../../shared/local-models/system-one';
import { LOCAL_MODEL_TASKS } from '../../../shared/local-models/tasks';
import { TIER_LEVELS } from '../../../shared/modelTiers';

// Built at run time so no secret-shaped literal sits in the source.
const SECRET = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;

const scoreAnswer = (score: number, confidence?: number) => ({
	type: 'score' as const,
	score,
	...(confidence !== undefined ? { confidence } : {}),
});

describe('the task', () => {
	it('is the registry entry, off until the user picks a router', () => {
		const task = LOCAL_MODEL_TASKS[MODEL_ROUTING_TASK_ID];
		expect(task.label).toBe('Model routing');
		expect(task.defaultAssignment).toEqual({ type: 'off' });
		expect(task.failPolicy).toBeUndefined();
		expect(task.systemOneQuestions).toBe(modelRoutingSystemOneRequest);
	});

	it('waits 400 ms for a decision and no longer', () => {
		expect(MODEL_ROUTING_TIMEOUT_MS).toBe(400);
	});
});

describe('modelRoutingSystemOneRequest', () => {
	it('asks tier and effort as two scores over the three levels, low to high', () => {
		const request = modelRoutingSystemOneRequest({ prompt: 'Rename the helper in utils.ts' });

		expect(systemOneStateProblem(request.state)).toBeNull();
		expect(systemOneQuestionsProblem(request.questions)).toBeNull();
		expect(Object.keys(request.questions)).toEqual([...MODEL_ROUTING_QUESTION_IDS]);
		expect(request.questions.tier).toMatchObject({
			type: 'score',
			criteria: TIER_LEVELS.map((level) => MODEL_ROUTING_TIER_DESCRIPTIONS[level]),
		});
		expect(request.questions.effort).toMatchObject({
			type: 'score',
			criteria: TIER_LEVELS.map((level) => MODEL_ROUTING_EFFORT_DESCRIPTIONS[level]),
		});
	});

	it('describes the tiers in the words the plan fixed', () => {
		expect(MODEL_ROUTING_TIER_DESCRIPTIONS.low).toMatch(/lookup.*rename.*one-line fix/);
		expect(MODEL_ROUTING_TIER_DESCRIPTIONS.medium).toMatch(/a few files.*bounded investigation/);
		expect(MODEL_ROUTING_TIER_DESCRIPTIONS.high).toMatch(
			/design decision.*multi-file refactor.*hard bug.*costly/
		);
	});

	it('hands over the prompt alone when there is no recent exchange, and says nothing of one', () => {
		const request = modelRoutingSystemOneRequest({ prompt: '  Fix the typo  ' });

		expect(request.state).toEqual({ prompt: 'Fix the typo' });
		expect(JSON.stringify(request.questions)).not.toContain('recent');
	});

	it('adds the recent exchange under its own key, and tells the judge what it is for', () => {
		const request = modelRoutingSystemOneRequest({
			prompt: 'do it',
			recent: { user: 'Can we split auth into modules?', assistant: 'Yes. Shall I start?' },
		});

		expect(request.state).toEqual({
			prompt: 'do it',
			recent: { user: 'Can we split auth into modules?', assistant: 'Yes. Shall I start?' },
		});
		expect(request.questions.tier.instructions).toMatch(/`recent` is the exchange before it/);
		expect(request.questions.effort.instructions).toMatch(/Judge the request itself/);
	});

	it('cuts a long prompt to the length the embedding router reads, after replacing secrets', () => {
		const request = modelRoutingSystemOneRequest({
			prompt: `${SECRET} ${'x'.repeat(MODEL_ROUTING_TEXT_MAX_CHARS * 2)}`,
		});
		const { prompt } = request.state as { prompt: string };

		expect(prompt.length).toBeLessThanOrEqual(MODEL_ROUTING_TEXT_MAX_CHARS);
		expect(prompt).not.toContain(SECRET);
	});
});

describe('clipModelRoutingRecent', () => {
	it('is nothing when there is no exchange, or only blanks', () => {
		expect(clipModelRoutingRecent(undefined)).toBeNull();
		expect(clipModelRoutingRecent({})).toBeNull();
		expect(clipModelRoutingRecent({ user: '   ', assistant: '' })).toBeNull();
	});

	it('keeps a short message whole and drops the side that is missing', () => {
		expect(clipModelRoutingRecent({ assistant: ' Done. ' })).toEqual({ assistant: 'Done.' });
		expect(clipModelRoutingRecent({ user: 'Hi' })).toEqual({ user: 'Hi' });
	});

	it("keeps the START of the user's message and the END of the assistant's", () => {
		const long = `HEAD ${'m'.repeat(MODEL_ROUTING_RECENT_MAX_CHARS * 2)} TAIL`;

		const clipped = clipModelRoutingRecent({ user: long, assistant: long })!;

		expect(clipped.user!.startsWith('HEAD')).toBe(true);
		expect(clipped.user!.endsWith(' ...')).toBe(true);
		expect(clipped.user).not.toContain('TAIL');
		expect(clipped.assistant!.startsWith('... ')).toBe(true);
		expect(clipped.assistant!.endsWith('TAIL')).toBe(true);
		expect(clipped.assistant).not.toContain('HEAD');
		// The cap, plus the four characters that mark the cut.
		expect(clipped.user!.length).toBeLessThanOrEqual(MODEL_ROUTING_RECENT_MAX_CHARS + 4);
		expect(clipped.assistant!.length).toBeLessThanOrEqual(MODEL_ROUTING_RECENT_MAX_CHARS + 4);
	});

	it('replaces a secret before it cuts, so a cut never leaves half of one', () => {
		// The secret straddles the cap: cut first, and its first half would stay.
		const user = `${'a'.repeat(MODEL_ROUTING_RECENT_MAX_CHARS - 20)} ${SECRET} and more`;

		const clipped = clipModelRoutingRecent({ user })!;

		expect(clipped.user).not.toContain(SECRET.slice(0, 20));
	});
});

describe('modelRouteFromSystemOne', () => {
	it('reads a level on each question as a tier and an effort', () => {
		expect(modelRouteFromSystemOne({ tier: scoreAnswer(0), effort: scoreAnswer(2) })).toEqual({
			tier: 'low',
			effort: 'high',
		});
		expect(modelRouteFromSystemOne({ tier: scoreAnswer(1), effort: scoreAnswer(1) })).toEqual({
			tier: 'medium',
			effort: 'medium',
		});
	});

	it('carries the confidence an engine reports, and none for a judge that reports none', () => {
		expect(
			modelRouteFromSystemOne({ tier: scoreAnswer(2, 0.91), effort: scoreAnswer(1, 0.4) })
		).toEqual({ tier: 'high', effort: 'medium', tierConfidence: 0.91, effortConfidence: 0.4 });
		const judged = modelRouteFromSystemOne({ tier: scoreAnswer(2), effort: scoreAnswer(1) })!;
		expect(judged).not.toHaveProperty('tierConfidence');
		expect(judged).not.toHaveProperty('effortConfidence');
	});

	it('takes the nearer level for a position between two, and the higher one for a tie', () => {
		const tier = (score: number) =>
			modelRouteFromSystemOne({ tier: scoreAnswer(score), effort: scoreAnswer(0) })?.tier;
		expect(tier(0.4)).toBe('low');
		expect(tier(0.6)).toBe('medium');
		expect(tier(1.49)).toBe('medium');
		// Exactly between: too little model costs a wrong answer.
		expect(tier(0.5)).toBe('medium');
		expect(tier(1.5)).toBe('high');
	});

	it('is no route when either answer is missing, the wrong type, or off the rubric', () => {
		const effort = scoreAnswer(1);
		const unusable: SystemOneAnswers[] = [
			{},
			{ tier: scoreAnswer(1) },
			{ effort },
			{ tier: { type: 'noul', probability: 0.9 }, effort },
			{ tier: { type: 'choice', choice: 'high' }, effort },
			{ tier: scoreAnswer(3), effort },
			{ tier: scoreAnswer(-1), effort },
			{ tier: scoreAnswer(Number.NaN), effort },
		];
		for (const answers of unusable) expect(modelRouteFromSystemOne(answers)).toBeNull();
	});
});

describe('modelRouteAnswers', () => {
	it('writes a route as the typed answers the ledger keeps, and reads back the same', () => {
		const route = {
			tier: 'high' as const,
			effort: 'low' as const,
			tierConfidence: 0.7,
			effortConfidence: 0.1,
		};

		const answers = modelRouteAnswers(route);

		expect(answers).toEqual({
			tier: { type: 'score', score: 2, confidence: 0.7 },
			effort: { type: 'score', score: 0, confidence: 0.1 },
		});
		expect(modelRouteFromSystemOne(answers)).toEqual(route);
	});

	it('writes no confidence the router did not give', () => {
		expect(modelRouteAnswers({ tier: 'medium', effort: 'medium' })).toEqual({
			tier: { type: 'score', score: 1 },
			effort: { type: 'score', score: 1 },
		});
	});
});

describe('modelRouterKind', () => {
	it('reads a catalog embedding model as the embedding router', () => {
		expect(modelRouterKind({ type: 'local', modelId: BGE_SMALL_EN_ID })).toBe(
			EMBEDDING_ROUTER_ENGINE_ID
		);
	});

	it('reads every other model as a judge: a text model, an endpoint model, an unknown one', () => {
		expect(modelRouterKind({ type: 'local', modelId: QWEN3_1_7B_ID })).toBe('local-judge');
		// An endpoint does not report a model's kind, even when its name says embedding.
		expect(modelRouterKind({ type: 'endpoint', endpointId: 'ep', model: 'nomic-embed-text' })).toBe(
			'local-judge'
		);
		expect(modelRouterKind({ type: 'local', modelId: 'gone-from-the-catalog' })).toBe(
			'local-judge'
		);
		// The registry refuses this one at save; read as a judge, it fails as itself.
		expect(modelRouterKind({ type: 'local', modelId: PROMPT_GUARD_2_22M_ID })).toBe('local-judge');
	});

	it('reads System One as itself, and off or the Utility Agent as no router', () => {
		expect(modelRouterKind({ type: 'system-one' })).toBe('system-one');
		expect(modelRouterKind({ type: 'off' })).toBeNull();
		expect(modelRouterKind({ type: 'utility-agent' })).toBeNull();
	});
});

describe('what a router is called', () => {
	it('is calibrated only for Jev and OpenJev', () => {
		expect(isModelRoutingEngineCalibrated('jev-cloud')).toBe(true);
		expect(isModelRoutingEngineCalibrated('openjev')).toBe(true);
		expect(isModelRoutingEngineCalibrated('local-judge')).toBe(false);
		expect(isModelRoutingEngineCalibrated(EMBEDDING_ROUTER_ENGINE_ID)).toBe(false);
	});

	it('names the embedding router with its model, and always as not calibrated', () => {
		expect(embeddingRouterLabel('BGE Small')).toBe('Embedding router (BGE Small), not calibrated');
		expect(embeddingRouterLabel()).toBe('Embedding router, not calibrated');
		expect(embeddingRouterLabel(null)).toBe('Embedding router, not calibrated');
	});

	it('notes beside a source which router it is and whether it is calibrated', () => {
		expect(modelRouterSourceNote(EMBEDDING_ROUTER_ENGINE_ID)).toBe(
			'embedding router, not calibrated'
		);
		expect(modelRouterSourceNote('local-judge')).toBe('local judge, not calibrated');
		expect(modelRouterSourceNote('system-one', 'jev-cloud')).toBe('calibrated');
		expect(modelRouterSourceNote('system-one', 'openjev')).toBe('calibrated');
		expect(modelRouterSourceNote('system-one', 'local-judge')).toBe('not calibrated');
		// No engine chosen answers nothing, so it is never called calibrated.
		expect(modelRouterSourceNote('system-one', 'off')).toBe('not calibrated');
		expect(modelRouterSourceNote('system-one')).toBe('not calibrated');
	});

	it('names a router before it has answered', () => {
		expect(modelRouterEngineLabel(EMBEDDING_ROUTER_ENGINE_ID, 'EmbeddingGemma 300M')).toBe(
			'Embedding router (EmbeddingGemma 300M), not calibrated'
		);
		expect(modelRouterEngineLabel('local-judge', 'Qwen3.5 4B')).toBe(
			'Local judge (Qwen3.5 4B), not calibrated'
		);
		expect(modelRouterEngineLabel('local-judge')).toBe('Local judge, not calibrated');
		// Which engine is in force is the main process's to say, when it answers.
		expect(modelRouterEngineLabel('system-one')).toBe('System One');
	});
});

describe('import order', () => {
	it('closes no cycle through the task registry, whichever module loads first', async () => {
		// `modelTiers.ts` builds constants from `run-on.ts` while it loads, and
		// `run-on.ts` imports the task registry. If the registry (or anything it
		// imports, this module included) imported `modelTiers.ts`, loading
		// `run-on.ts` FIRST would hand `modelTiers.ts` values that are not there
		// yet, and `provider:<model>` would stop parsing as the provider's model.
		vi.resetModules();
		await import('../../../shared/local-models/run-on');
		const tiers = await import('../../../shared/modelTiers');

		expect(tiers.TIER_TARGET_SPEC_FORMS).toBe(
			'default, provider, provider:<model>, or <source id>:<model>'
		);
		expect(tiers.parseTierTargetSpec('provider:opus')).toEqual({
			ok: true,
			target: { type: 'provider-model', model: 'opus' },
		});
	});
});

describe('the result of one routing', () => {
	it('names every reason a turn gets no decision', () => {
		expect(MODEL_ROUTING_SKIP_REASONS).toEqual([
			'off',
			'no-prompt',
			'timeout',
			'unavailable',
			'cancelled',
		]);
	});

	it('tells a skip from a decision', () => {
		expect(isModelRouteSkipped({ skipped: 'off', detail: 'Off.', latencyMs: 0 })).toBe(true);
		expect(
			isModelRouteSkipped({
				tier: 'low',
				effort: 'low',
				engine: { id: 'jev-cloud', label: 'Jev (TypeSafe cloud)', calibrated: true },
				latencyMs: 240,
			})
		).toBe(false);
	});
});

describe('a routing asked from another process', () => {
	it('lets a turn nobody is typing at wait longer than a send, inside the cap', () => {
		expect(MODEL_ROUTING_UNATTENDED_TIMEOUT_MS).toBeGreaterThan(MODEL_ROUTING_TIMEOUT_MS);
		expect(MODEL_ROUTING_UNATTENDED_TIMEOUT_MS).toBeLessThanOrEqual(MODEL_ROUTING_MAX_TIMEOUT_MS);
	});

	it('reads the prompt, the recent exchange and who the turn is for', () => {
		expect(
			parseRouteTurnRequest({
				prompt: 'rename the helper',
				recent: { user: 'what does it do?', assistant: 'It formats a date.' },
				agentId: 'agent-1',
				tabId: 'tab-1',
				timeoutMs: 5000,
				extra: 'dropped',
			})
		).toEqual({
			ok: true,
			request: {
				prompt: 'rename the helper',
				recent: { user: 'what does it do?', assistant: 'It formats a date.' },
				agentId: 'agent-1',
				tabId: 'tab-1',
				timeoutMs: 5000,
			},
		});
	});

	it('does not cut or trim the texts: they are redacted first, where they are used', () => {
		const prompt = `  ${'x'.repeat(MODEL_ROUTING_TEXT_MAX_CHARS * 3)}  `;
		const parsed = parseRouteTurnRequest({ prompt });
		expect(parsed).toEqual({ ok: true, request: { prompt } });
	});

	it('keeps a blank prompt for routeTurn to answer, and drops blank optional fields', () => {
		expect(
			parseRouteTurnRequest({ prompt: '', recent: { user: '  ' }, agentId: '', tabId: null })
		).toEqual({ ok: true, request: { prompt: '' } });
	});

	it('caps a timeout at the most a routing may wait', () => {
		const parsed = parseRouteTurnRequest({ prompt: 'p', timeoutMs: 10 * 60 * 1000 });
		expect(parsed).toEqual({
			ok: true,
			request: { prompt: 'p', timeoutMs: MODEL_ROUTING_MAX_TIMEOUT_MS },
		});
	});

	it.each([
		{ value: 'not an object' },
		{ value: null },
		{ value: ['prompt'] },
		{ value: { prompt: 7 } },
		{ value: { prompt: 'p', recent: 'earlier' } },
		{ value: { prompt: 'p', recent: ['a'] } },
		{ value: { prompt: 'p', timeoutMs: 0 } },
		{ value: { prompt: 'p', timeoutMs: -5 } },
		{ value: { prompt: 'p', timeoutMs: 'soon' } },
		{ value: { prompt: 'p', timeoutMs: Number.NaN } },
	])('refuses $value', ({ value }) => {
		const parsed = parseRouteTurnRequest(value);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toMatch(/routing request/);
	});
});
