/**
 * @file jev-e2e.test.ts
 *
 * System One against the real hosted Jev: one noul, one choice and one score,
 * each its own request, asked the way a task asks (the stored engine choice
 * resolved by the service, then `askResolvedSystemOne`). Every other System One
 * test runs against `mockJevServer`, which is built from the shapes the `jev`
 * CLI documents; this is the one that can tell whether the real API still
 * answers in those shapes, what a request costs in tokens, and how long one
 * takes against the 1500 ms default budget.
 *
 * Opt-in only (it sends three small requests to TypeSafe and spends a fraction
 * of a cent): SKIPPED unless
 *   MAESTRO_JEV_E2E=1
 * Run with:
 *   MAESTRO_JEV_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/system-one/jev-e2e.test.ts
 *
 * The key is whatever `resolveSystemOneKey` finds from a test process:
 * `TYPESAFE_API_KEY`, then the `jev` CLI's key file. A key stored in Settings
 * is sealed by the app's own key store and cannot be opened here, so the test
 * runs in an empty scratch data folder and never reads the live one. With no
 * key it skips and says so. `TYPESAFE_BASE_URL` is honored, as it is in the app.
 *
 * The key is never printed: the record carries where it came from and no more.
 * The state is a fixed, made-up support ticket, so nothing of the user's is sent.
 * Measurements go to the console and to `jev-e2e-results.json` in the results
 * folder (override it with MAESTRO_JEV_E2E_DIR).
 */

import { describe, it, expect, vi, beforeAll, afterAll, type TestContext } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.MAESTRO_JEV_E2E === '1';
const RESULTS_DIR = process.env.MAESTRO_JEV_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-jev-e2e');
const RESULTS_FILE = path.join(RESULTS_DIR, 'jev-e2e-results.json');

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
}));
vi.mock('../../../../main/stats/singleton', () => ({
	getStatsDB: () => ({ isReady: () => false }),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));
vi.mock('../../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/local-models/text-gen')>()),
	generateText: vi.fn(),
}));
vi.mock('../../../../main/local-models/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('../../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import {
	askResolvedSystemOne,
	configureSystemOne,
	resetSystemOneServiceForTests,
	resolveSystemOneEngine,
	updateSystemOneSettingsRequest,
	type ResolvedSystemOneEngine,
} from '../../../../main/local-models/system-one/service';
import { obscuringSeal } from '../../../../main/utils/safe-storage-seal';
import {
	SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
	choice,
	estimateSystemOneRequest,
	noul,
	score,
	systemOneCostUsd,
	type SystemOneQuestion,
	type SystemOneRemoteEngine,
	type SystemOneResult,
} from '../../../../shared/local-models/system-one';
import {
	TYPESAFE_API_KEY_ENV_VAR,
	TYPESAFE_API_KEY_FILE,
	describeSystemOneKey,
} from '../../../../shared/local-models/system-one-settings';

/**
 * Wide on purpose. The run MEASURES latency against the 1500 ms default; a test
 * that failed at 1500 ms would report a slow network as a broken client.
 */
const REQUEST_BUDGET_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

const STATE = {
	ticket: {
		subject: 'Charged twice for the March invoice',
		text: 'I was billed twice for my March invoice. The second charge posted yesterday. Please refund it. This is urgent: my account is now overdrawn.',
	},
};

const TEAMS = {
	billing: 'Charges, invoices and refunds.',
	technical: 'Bugs, errors and outages in the product.',
	sales: 'Questions before a purchase: plans, pricing and demos.',
};

const URGENCY_LEVELS = [
	'No time pressure: a question or a comment.',
	'Wants it handled soon, and nothing is blocked.',
	'Urgent: money or access is affected now.',
];

/** One question of each type. Each has an answer a wiring fault would get wrong. */
const QUESTIONS = {
	refund: noul('Does the customer in `ticket.text` ask for a refund?'),
	team: choice('Which team handles `ticket.text`?', TEAMS),
	urgency: score('How urgent is `ticket.text` for the customer?', URGENCY_LEVELS),
} satisfies Record<string, SystemOneQuestion>;

type QuestionId = keyof typeof QUESTIONS;
type JevEngine = Extract<ResolvedSystemOneEngine, { engine: SystemOneRemoteEngine }>;

/** Measurements written at the end. Numbers and names only: never the key. */
const results: Record<string, string | number | boolean> = {};
const asked: SystemOneResult[] = [];
let estimatedInputTokens = 0;

describe.skipIf(!RUN)('System One on the hosted Jev (MAESTRO_JEV_E2E=1)', () => {
	let dataDir: string;
	let engine: JevEngine | null = null;
	let skipReason: string | null = null;

	beforeAll(async () => {
		dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-jev-e2e-'));
		// The real environment and the real home folder, an empty data folder, and
		// no Settings > Environment: the sources a test process can read.
		configureSystemOne({
			dataDir: () => dataDir,
			osSeal: obscuringSeal,
			shellEnvVars: () => ({}),
		});
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud', timeoutMs: REQUEST_BUDGET_MS });

		const resolved = await resolveSystemOneEngine();
		if (resolved.id !== 'jev-cloud') {
			throw new Error(`Expected the hosted Jev to be the engine in force, got ${resolved.id}.`);
		}
		if (resolved.key.source === 'none') {
			skipReason = `no API key found. Set ${TYPESAFE_API_KEY_ENV_VAR} or write the key to ~/${TYPESAFE_API_KEY_FILE.join('/')}. A key stored in Settings is sealed by the app and cannot be opened by a test.`;
			console.warn(`[jev-e2e] skipped: ${skipReason}`);
			return;
		}
		if (resolved.refusal) throw new Error(resolved.refusal.message);

		engine = resolved;
		results.baseUrl = resolved.engine.baseUrl;
		results.keySource = describeSystemOneKey(resolved.key);
		results.requestBudgetMs = REQUEST_BUDGET_MS;
	});

	afterAll(async () => {
		resetSystemOneServiceForTests();
		await fs.rm(dataDir, { recursive: true, force: true });
	});

	/** Ask ONE question as its own request, and check what every answered request carries. */
	async function ask(ctx: TestContext, id: QuestionId): Promise<SystemOneResult> {
		if (!engine) ctx.skip(skipReason ?? 'the engine was not resolved');
		const questions = { [id]: QUESTIONS[id] };
		estimatedInputTokens += estimateSystemOneRequest('jev-cloud', STATE, questions).inputTokens;

		const result = await askResolvedSystemOne(engine!, STATE, questions);
		asked.push(result);
		results[`${id}LatencyMs`] = result.latencyMs;

		expect(result.engine).toBe('jev-cloud');
		expect(result.calibrated).toBe(true);
		expect(result.redacted).toBe(false);
		expect(result.model).toMatch(/^jev-/);
		expect(result.latencyMs).toBeGreaterThan(0);
		expect(Number.isInteger(result.usage.inputTokens)).toBe(true);
		expect(result.usage.inputTokens).toBeGreaterThan(0);
		expect(Number.isInteger(result.usage.outputTokens)).toBe(true);
		expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
		expect(result.costUsd).toBe(systemOneCostUsd('jev-cloud', result.usage.inputTokens));
		expect(Object.keys(result.answers)).toEqual([id]);
		return result;
	}

	function expectProbability(value: unknown): void {
		expect(typeof value).toBe('number');
		expect(value as number).toBeGreaterThanOrEqual(0);
		expect(value as number).toBeLessThanOrEqual(1);
	}

	it(
		'answers a noul with P(yes)',
		async (ctx) => {
			const { answers } = await ask(ctx, 'refund');
			const answer = answers.refund;

			if (answer.type !== 'noul') throw new Error(`Expected a noul, got ${answer.type}.`);
			expectProbability(answer.probability);
			expect(answer.probability).toBeGreaterThan(0.5);
			results.refundProbability = Number(answer.probability.toFixed(4));
		},
		TEST_TIMEOUT_MS
	);

	it(
		'answers a choice with one option, a probability per option and a confidence',
		async (ctx) => {
			const { answers } = await ask(ctx, 'team');
			const answer = answers.team;

			if (answer.type !== 'choice') throw new Error(`Expected a choice, got ${answer.type}.`);
			expect(Object.keys(TEAMS)).toContain(answer.choice);
			expect(Object.keys(answer.probabilities ?? {}).sort()).toEqual(Object.keys(TEAMS).sort());
			for (const probability of Object.values(answer.probabilities ?? {})) {
				expectProbability(probability);
			}
			expectProbability(answer.confidence);
			expect(answer.choice).toBe('billing');
			results.teamChoice = answer.choice;
			results.teamConfidence = Number((answer.confidence ?? 0).toFixed(4));
		},
		TEST_TIMEOUT_MS
	);

	it(
		'answers a score with a position on the rubric, a probability per level and a confidence',
		async (ctx) => {
			const { answers } = await ask(ctx, 'urgency');
			const answer = answers.urgency;

			if (answer.type !== 'score') throw new Error(`Expected a score, got ${answer.type}.`);
			expect(typeof answer.score).toBe('number');
			expect(answer.score).toBeGreaterThanOrEqual(0);
			expect(answer.score).toBeLessThanOrEqual(URGENCY_LEVELS.length - 1);
			expect(answer.probabilities).toHaveLength(URGENCY_LEVELS.length);
			for (const probability of answer.probabilities ?? []) expectProbability(probability);
			expectProbability(answer.confidence);
			expect(answer.score).toBeGreaterThan(1);
			results.urgencyScore = Number(answer.score.toFixed(4));
			results.urgencyConfidence = Number((answer.confidence ?? 0).toFixed(4));
		},
		TEST_TIMEOUT_MS
	);

	it('records the latency and the tokens, and never the key', async (ctx) => {
		if (!engine) ctx.skip(skipReason ?? 'the engine was not resolved');
		expect(asked).toHaveLength(Object.keys(QUESTIONS).length);

		const latencies = asked.map((result) => result.latencyMs);
		const inputTokens = asked.reduce((sum, result) => sum + result.usage.inputTokens, 0);
		const outputTokens = asked.reduce((sum, result) => sum + result.usage.outputTokens, 0);
		results.model = asked[0].model;
		results.requests = asked.length;
		// The first request pays for the connection; the rest reuse it.
		results.firstRequestMs = latencies[0];
		results.slowestRequestMs = Math.max(...latencies);
		results.fastestRequestMs = Math.min(...latencies);
		results.defaultBudgetMs = SYSTEM_ONE_DEFAULT_TIMEOUT_MS;
		results.allWithinDefaultBudget = latencies.every((ms) => ms <= SYSTEM_ONE_DEFAULT_TIMEOUT_MS);
		results.inputTokens = inputTokens;
		results.outputTokens = outputTokens;
		results.totalTokens = inputTokens + outputTokens;
		results.estimatedInputTokens = estimatedInputTokens;
		results.costUsd = Number(asked.reduce((sum, result) => sum + result.costUsd, 0).toPrecision(4));

		const report = JSON.stringify(results, null, 2);
		// A boolean, not `not.toContain`: a failed matcher would print the key it found.
		expect(report.includes(engine!.engine.apiKey!)).toBe(false);
		await fs.mkdir(RESULTS_DIR, { recursive: true });
		await fs.writeFile(RESULTS_FILE, `${report}\n`);
		console.log(`[jev-e2e] results\n${report}`);
	});
});
