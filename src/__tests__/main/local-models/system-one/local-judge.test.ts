/**
 * @file local-judge.test.ts
 *
 * The System One local judge, through the REAL task router, with the model
 * itself mocked in-process (`generateText` answers from a script). Properties
 * worth protecting:
 *
 *   - **One constrained generation per question**, on the source the
 *     `local-judge` task is assigned, each recorded as a run of that task.
 *   - **Never calibrated, never dressed up.** Every result says so, and a choice
 *     or a score carries no distribution the model was not asked for.
 *   - **A noul's probability never contradicts its yes or no.**
 *   - **Strict answers.** A reply that is not one of the options, not a level on
 *     the rubric, or not JSON is no answer, and the request fails as a whole.
 *   - **Every failure is a `SystemOneError` for `local-judge`** with a code a
 *     fail policy can switch on, and nothing else is asked instead.
 *   - **A state too long for the in-process context is refused**, never handed
 *     to a model that would read part of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const stats = vi.hoisted(() => ({
	recordLocalModelRun: vi.fn((_run: unknown) => 'id'),
}));
const generate = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

vi.mock('../../../../main/stats/singleton', () => ({
	getStatsDB: () => ({
		isReady: () => true,
		recordLocalModelRun: stats.recordLocalModelRun,
	}),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
}));

vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/local-models/text-gen')>()),
	generateText: generate.generateText,
}));

vi.mock('../../../../main/local-models/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('../../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import {
	askLocalJudge,
	formatLocalJudgeInput,
	localJudgeReplySchema,
	parseLocalJudgeReply,
} from '../../../../main/local-models/system-one/local-judge';
import {
	LocalModelEndpointError,
	LocalModelError,
	SystemOneError,
	isLocalModelCancelled,
	isSystemOneError,
	localModelCancelledError,
} from '../../../../main/local-models/errors';
import { LOCAL_TEXT_CONTEXT_TOKENS } from '../../../../main/local-models/text-gen';
import { QWEN3_1_7B_ID, getLocalModel } from '../../../../shared/local-models/model-catalog';
import {
	choice,
	noul,
	score,
	type SystemOneErrorCode,
	type SystemOneQuestions,
} from '../../../../shared/local-models/system-one';
import { LOCAL_JUDGE_TASK_ID } from '../../../../shared/local-models/tasks';

const LOCAL = { type: 'local', modelId: QWEN3_1_7B_ID } as const;
const ENDPOINT = { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' } as const;
const MODEL_NAME = getLocalModel(QWEN3_1_7B_ID)!.displayName;

const STATE = 'The export button crashes the settings page in Safari but works in Chrome.';

const QUESTIONS: SystemOneQuestions = {
	is_bug: noul('Does the text describe a software bug?'),
	team: choice('Which team should handle it?', {
		frontend: 'Browser rendering and UI defects',
		backend: 'Server errors and data problems',
		other: null,
	}),
	severity: score('How severe is it?', ['Cosmetic', 'Degraded, workaround exists', 'Blocking']),
};

/** What the mocked model is handed: the request `generateText` gets. */
interface ModelRequest {
	source: unknown;
	prompt: string;
	system?: string;
	maxTokens: number;
	jsonSchema?: Record<string, unknown>;
	signal?: AbortSignal;
}

type QuestionType = 'noul' | 'choice' | 'score';

function questionType(request: ModelRequest): QuestionType {
	return /^Question type: (\w+)$/m.exec(request.prompt)![1] as QuestionType;
}

/** A sound answer of each type, for a model that follows its schema. */
const SOUND: Record<QuestionType, unknown> = {
	noul: { answer: 'yes', confidence: 0.9 },
	choice: { choice: 'frontend' },
	score: { level: 2 },
};

/**
 * The in-process model: answers each request with what `reply` returns (an
 * object is written as JSON, a string is the raw reply), the way `generateText`
 * reports it.
 */
function mockModel(reply: (request: ModelRequest) => unknown = (r) => SOUND[questionType(r)]) {
	generate.generateText.mockImplementation(async (request: ModelRequest) => {
		const answer = reply(request);
		const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		return {
			text,
			...(json !== undefined ? { json } : {}),
			source: request.source,
			durationMs: 40,
			tokensIn: 100,
			tokensOut: 8,
		};
	});
}

function assign(assignment: unknown): void {
	settings.set('localModelAssignments', { [LOCAL_JUDGE_TASK_ID]: assignment });
}

function requests(): ModelRequest[] {
	return generate.generateText.mock.calls.map(([request]) => request as ModelRequest);
}

/** The rejection of `promise`, asserted to be a local-judge SystemOneError with this code. */
async function failure(
	promise: Promise<unknown>,
	code: SystemOneErrorCode
): Promise<SystemOneError> {
	const error = await promise.then(
		() => null,
		(reason: unknown) => reason
	);
	expect(isSystemOneError(error)).toBe(true);
	expect((error as SystemOneError).code).toBe(code);
	expect((error as SystemOneError).engine).toBe('local-judge');
	return error as SystemOneError;
}

beforeEach(() => {
	settings.clear();
	stats.recordLocalModelRun.mockReset().mockReturnValue('id');
	generate.generateText.mockReset();
	assign(LOCAL);
	mockModel();
});

describe('askLocalJudge', () => {
	it('answers one question of each type, typed, on the assigned model', async () => {
		const result = await askLocalJudge(STATE, QUESTIONS);

		expect(result.answers).toEqual({
			is_bug: { type: 'noul', probability: 0.9 },
			team: { type: 'choice', choice: 'frontend' },
			severity: { type: 'score', score: 2 },
		});
		expect(result.engine).toBe('local-judge');
		expect(result.model).toBe(`local:${QWEN3_1_7B_ID}`);
		expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 24 });
		expect(result.costUsd).toBe(0);
		expect(result.redacted).toBe(false);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it('marks every result not calibrated, and gives a choice or a score no distribution', async () => {
		const result = await askLocalJudge(STATE, QUESTIONS);

		expect(result.calibrated).toBe(false);
		expect(result.answers.team).not.toHaveProperty('probabilities');
		expect(result.answers.team).not.toHaveProperty('confidence');
		expect(result.answers.severity).not.toHaveProperty('probabilities');
		expect(result.answers.severity).not.toHaveProperty('confidence');
	});

	it('asks one question per generation, each held to its own schema', async () => {
		await askLocalJudge(STATE, QUESTIONS);

		const asked = requests();
		expect(asked.map(questionType)).toEqual(['noul', 'choice', 'score']);
		for (const request of asked) {
			expect(request.source).toEqual(LOCAL);
			expect(request.system).toBe('PROMPT:system-one-judge-local');
			expect(request.prompt).toContain(STATE);
			expect(request.signal).toBeInstanceOf(AbortSignal);
		}
		expect(asked[0].jsonSchema).toEqual(localJudgeReplySchema(QUESTIONS.is_bug));
		expect(asked[1].jsonSchema).toEqual(localJudgeReplySchema(QUESTIONS.team));
		expect(asked[2].jsonSchema).toEqual(localJudgeReplySchema(QUESTIONS.severity));
		// One question's criteria never reach another question's prompt.
		expect(asked[0].prompt).not.toContain('frontend');
		expect(asked[1].prompt).not.toContain('Blocking');
	});

	it('records each generation as a run of the local-judge task', async () => {
		await askLocalJudge(STATE, QUESTIONS);

		expect(stats.recordLocalModelRun).toHaveBeenCalledTimes(3);
		for (const [run] of stats.recordLocalModelRun.mock.calls) {
			expect(run).toMatchObject({
				taskId: 'local-judge',
				sourceType: 'local',
				modelId: QWEN3_1_7B_ID,
				outcome: 'ok',
			});
		}
	});

	it('runs on an endpoint model when that is what the task is assigned', async () => {
		assign(ENDPOINT);

		const result = await askLocalJudge(STATE, { is_bug: QUESTIONS.is_bug });

		expect(requests()[0].source).toEqual(ENDPOINT);
		expect(result.model).toBe('endpoint:ep-1:llama3.2');
		expect(result.calibrated).toBe(false);
	});

	describe("on another task's own model", () => {
		const ROUTING = 'model-routing';
		const TIER = { tier: score('How much model?', ['Small', 'Middle', 'Large']) };

		it("answers on that task's assignment while the local judge task has no model", async () => {
			settings.set('localModelAssignments', { [ROUTING]: ENDPOINT });

			const result = await askLocalJudge(STATE, TIER, { taskId: ROUTING });

			expect(result.answers).toEqual({ tier: { type: 'score', score: 2 } });
			expect(result.engine).toBe('local-judge');
			expect(result.model).toBe('endpoint:ep-1:llama3.2');
			expect(requests()[0].source).toEqual(ENDPOINT);
			// The generation is a run of the task that owns the model.
			expect(stats.recordLocalModelRun.mock.calls[0][0]).toMatchObject({ taskId: ROUTING });
		});

		it("never reads the local judge task's model for it", async () => {
			// The local judge task has a model (the `beforeEach`); model routing has none.
			const error = await failure(askLocalJudge(STATE, TIER, { taskId: ROUTING }), 'unavailable');

			expect(error.message).toMatch(/Assign Model routing a local model or an endpoint/);
			expect(generate.generateText).not.toHaveBeenCalled();
		});
	});

	describe('a noul', () => {
		async function probability(answer: unknown): Promise<number> {
			mockModel(() => answer);
			const result = await askLocalJudge(STATE, { q: QUESTIONS.is_bug });
			return (result.answers.q as { probability: number }).probability;
		}

		it('reads a yes as its confidence and a no as the rest', async () => {
			expect(await probability({ answer: 'yes', confidence: 0.9 })).toBeCloseTo(0.9);
			expect(await probability({ answer: 'no', confidence: 0.8 })).toBeCloseTo(0.2);
			expect(await probability({ answer: 'yes', confidence: 1 })).toBe(1);
			expect(await probability({ answer: 'no', confidence: 1 })).toBe(0);
		});

		it('reads a confidence under a coin flip as undecided, never as the other answer', async () => {
			expect(await probability({ answer: 'yes', confidence: 0.2 })).toBe(0.5);
			expect(await probability({ answer: 'no', confidence: 0 })).toBe(0.5);
		});
	});

	describe('redaction', () => {
		const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

		it('removes a secret from the state and from a question before the model reads either', async () => {
			const result = await askLocalJudge(`Deploy failed. Token: ${SECRET}`, {
				q: noul(`Is the token ${SECRET} still valid?`),
			});

			expect(requests()[0].prompt).not.toContain(SECRET);
			expect(result.redacted).toBe(true);
		});
	});

	describe('a request that cannot be asked', () => {
		it('refuses an empty state and a malformed question as invalid, and asks nothing', async () => {
			await failure(askLocalJudge('  ', QUESTIONS), 'invalid');
			const error = await failure(
				askLocalJudge(STATE, {
					q: { type: 'choice', instructions: 'Pick', criteria: { a: null } },
				}),
				'invalid'
			);
			expect(error.message).toMatch(/Choice "q" needs at least 2 options/);
			expect(generate.generateText).not.toHaveBeenCalled();
		});

		it('is unavailable when no model is assigned, naming where to assign one', async () => {
			settings.clear();

			const error = await failure(askLocalJudge(STATE, QUESTIONS), 'unavailable');

			expect(error.message).toMatch(/no model is assigned/);
			expect(error.message).toMatch(/Settings > Models > System One/);
			expect(generate.generateText).not.toHaveBeenCalled();
		});

		it('refuses a state too long for the in-process context, before any generation', async () => {
			const long = 'word '.repeat(LOCAL_TEXT_CONTEXT_TOKENS);

			const error = await failure(askLocalJudge(long, QUESTIONS), 'too-large');

			expect(error.message).toContain(MODEL_NAME);
			expect(error.message).toMatch(/Send less state/);
			expect(generate.generateText).not.toHaveBeenCalled();
		});

		it('leaves the size of a request to an endpoint, whose context it cannot read', async () => {
			assign(ENDPOINT);
			const long = 'word '.repeat(LOCAL_TEXT_CONTEXT_TOKENS);

			await expect(askLocalJudge(long, { q: QUESTIONS.is_bug })).resolves.toMatchObject({
				engine: 'local-judge',
			});
		});
	});

	describe('an answer that is not one', () => {
		it('fails the whole request on the first unreadable answer, and asks no more', async () => {
			mockModel((request) =>
				questionType(request) === 'choice' ? { choice: 'design' } : SOUND[questionType(request)]
			);

			const error = await failure(askLocalJudge(STATE, QUESTIONS), 'unavailable');

			expect(error.message).toContain(`Local judge (${MODEL_NAME}), not calibrated`);
			expect(error.message).toMatch(/question "team"/);
			expect(error.message).toMatch(/not one of the options/);
			// The noul and the choice ran; the score after them did not.
			expect(generate.generateText).toHaveBeenCalledTimes(2);
		});

		it('refuses prose where JSON was asked for', async () => {
			mockModel(() => 'I think it is probably a bug.');

			const error = await failure(askLocalJudge(STATE, { q: QUESTIONS.is_bug }), 'unavailable');

			expect(error.message).toMatch(/unreadable answer/);
		});
	});

	describe('a source that cannot run', () => {
		it('is unavailable with the reason that names the model, and nothing else is asked', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelError(`${MODEL_NAME} is not downloaded.`, {
					code: 'model-not-installed',
					recovery: 'Download it in Settings > Models > Library.',
					consumerId: 'test',
				})
			);

			const error = await failure(askLocalJudge(STATE, QUESTIONS), 'unavailable');

			expect(error.message).toContain(`${MODEL_NAME} is not downloaded.`);
			expect(error.message).toContain('Download it in Settings > Models > Library.');
			expect(generate.generateText).toHaveBeenCalledTimes(1);
		});

		it('reports an endpoint that refused its key as auth', async () => {
			assign(ENDPOINT);
			generate.generateText.mockRejectedValue(
				new LocalModelEndpointError('LiteLLM rejected the API key (HTTP 401).', {
					kind: 'auth',
					endpointId: 'ep-1',
					endpointName: 'LiteLLM',
					url: 'http://127.0.0.1:4000/v1/chat/completions',
					httpStatus: 401,
				})
			);

			const error = await failure(askLocalJudge(STATE, QUESTIONS), 'auth');

			expect(error.message).toContain('LiteLLM rejected the API key');
		});

		it('lets an unclassified engine failure propagate as itself', async () => {
			generate.generateText.mockRejectedValue(new Error('engine bug'));

			await expect(askLocalJudge(STATE, QUESTIONS)).rejects.toThrow('engine bug');
		});
	});

	describe('the budget and cancellation', () => {
		/** A model that never answers: it holds the turn until its signal fires. */
		function mockStalledModel(): void {
			generate.generateText.mockImplementation(
				(request: ModelRequest) =>
					new Promise((_resolve, reject) => {
						const stop = () => reject(localModelCancelledError('test'));
						if (request.signal?.aborted) stop();
						else request.signal?.addEventListener('abort', stop, { once: true });
					})
			);
		}

		it('is a timeout when the model does not answer inside the budget', async () => {
			mockStalledModel();

			const error = await failure(askLocalJudge(STATE, QUESTIONS, { timeoutMs: 20 }), 'timeout');

			expect(error.message).toMatch(/no answer within 20 ms/);
			expect(isLocalModelCancelled(error)).toBe(false);
		});

		it('is cancelled, not a fault, when the caller aborts', async () => {
			mockStalledModel();
			const controller = new AbortController();
			const asking = askLocalJudge(STATE, QUESTIONS, { signal: controller.signal });
			controller.abort();

			const error = await failure(asking, 'cancelled');

			expect(isLocalModelCancelled(error)).toBe(true);
		});
	});
});

describe('localJudgeReplySchema', () => {
	it('holds a noul to yes or no and a confidence from 0 to 1', () => {
		const schema = localJudgeReplySchema(QUESTIONS.is_bug) as {
			properties: { answer: { enum: string[] }; confidence: { enum: number[] } };
			required: string[];
		};
		expect(schema.properties.answer.enum).toEqual(['yes', 'no']);
		expect(Math.min(...schema.properties.confidence.enum)).toBe(0);
		expect(Math.max(...schema.properties.confidence.enum)).toBe(1);
		expect(schema.required).toEqual(['answer', 'confidence']);
	});

	it("holds a choice to the question's own option ids", () => {
		expect(localJudgeReplySchema(QUESTIONS.team)).toEqual({
			type: 'object',
			properties: { choice: { type: 'string', enum: ['frontend', 'backend', 'other'] } },
			required: ['choice'],
			additionalProperties: false,
		});
	});

	it("holds a score to the rubric's level numbers", () => {
		expect(localJudgeReplySchema(QUESTIONS.severity)).toEqual({
			type: 'object',
			properties: { level: { type: 'integer', enum: [0, 1, 2] } },
			required: ['level'],
			additionalProperties: false,
		});
	});
});

describe('formatLocalJudgeInput', () => {
	it('puts the state first and the question last', () => {
		expect(formatLocalJudgeInput(STATE, QUESTIONS.is_bug)).toBe(
			[
				'<state>',
				STATE,
				'</state>',
				'',
				'Question type: noul',
				'Question: Does the text describe a software bug?',
			].join('\n')
		);
	});

	it('says what yes and no mean when the question does', () => {
		const prompt = formatLocalJudgeInput(
			STATE,
			noul('Is it urgent?', { true: 'Users are blocked', false: 'A workaround exists' })
		);
		expect(prompt).toContain('Yes means: Users are blocked');
		expect(prompt).toContain('No means: A workaround exists');
	});

	it('lists each option by its quoted id, with its description when it has one', () => {
		const prompt = formatLocalJudgeInput(STATE, QUESTIONS.team);
		expect(prompt).toContain(
			[
				'Options:',
				'- "frontend": Browser rendering and UI defects',
				'- "backend": Server errors and data problems',
				'- "other"',
			].join('\n')
		);
	});

	it('numbers the levels of a rubric from 0, low to high', () => {
		const prompt = formatLocalJudgeInput(STATE, QUESTIONS.severity);
		expect(prompt).toContain(
			['Levels, low to high:', '0: Cosmetic', '1: Degraded, workaround exists', '2: Blocking'].join(
				'\n'
			)
		);
	});

	it('writes a JSON state and structured instructions as JSON', () => {
		const prompt = formatLocalJudgeInput(
			{ ticket: { title: 'Crash on save' } },
			noul({ ask: 'Is `ticket.title` a bug report?' })
		);
		expect(prompt).toContain('{"ticket":{"title":"Crash on save"}}');
		expect(prompt).toContain('Question: {"ask":"Is `ticket.title` a bug report?"}');
	});
});

describe('parseLocalJudgeReply', () => {
	it('reads a sound answer of each type', () => {
		expect(parseLocalJudgeReply(QUESTIONS.is_bug, { answer: 'Yes', confidence: 0.7 })).toEqual({
			type: 'noul',
			probability: 0.7,
		});
		expect(parseLocalJudgeReply(QUESTIONS.team, { choice: 'other' })).toEqual({
			type: 'choice',
			choice: 'other',
		});
		expect(parseLocalJudgeReply(QUESTIONS.severity, { level: 0 })).toEqual({
			type: 'score',
			score: 0,
		});
	});

	it('refuses a noul with no yes or no, or a confidence off the scale', () => {
		expect(parseLocalJudgeReply(QUESTIONS.is_bug, { answer: 'maybe', confidence: 0.5 })).toBe(
			'no yes or no'
		);
		expect(parseLocalJudgeReply(QUESTIONS.is_bug, { answer: true, confidence: 0.5 })).toBe(
			'no yes or no'
		);
		for (const confidence of [85, -0.1, Number.NaN, '0.9', undefined]) {
			expect(parseLocalJudgeReply(QUESTIONS.is_bug, { answer: 'yes', confidence })).toBe(
				'no confidence from 0 to 1'
			);
		}
	});

	it('refuses a choice that is not an option id, a description included', () => {
		for (const choice of ['design', 'Frontend', 'Browser rendering and UI defects', 0, undefined]) {
			expect(parseLocalJudgeReply(QUESTIONS.team, { choice })).toBe(
				'a choice that is not one of the options'
			);
		}
	});

	it('refuses a level off the rubric or between two levels', () => {
		for (const level of [3, -1, 1.5, '1', undefined]) {
			expect(parseLocalJudgeReply(QUESTIONS.severity, { level })).toBe('no level from 0 to 2');
		}
	});

	it('refuses a reply that is not a JSON object', () => {
		for (const reply of [undefined, null, 'yes', 1, [{ answer: 'yes', confidence: 1 }]]) {
			expect(parseLocalJudgeReply(QUESTIONS.is_bug, reply)).toBe('no JSON object');
		}
	});
});
