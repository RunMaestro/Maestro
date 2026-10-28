/**
 * @file agent-service.test.ts
 *
 * `runAgentSystemOneRequest`: what an agent's `maestro-cli s1` verb reaches,
 * through the real System One service against a loopback Jev server
 * (`mockJevServer`), the in-process model mock, the real answer cache in a temp
 * folder and the real ledger over an in-memory SQLite. Every test runs with an
 * injected environment and home folder, so none reads the developer's own key.
 *
 * Properties worth protecting:
 *
 *   - **A request that cannot be read asks nothing.**
 *   - **Off is off**, for each switch by name: no engine, agents switched off,
 *     this agent switched off, an engine that is not set up, an engine that has
 *     not passed its Test. None of them sends anything.
 *   - **The key never reaches the caller**, in an answer or in a refusal.
 *   - **A candidate is keyed, never indexed**: it travels inside its own
 *     question, and its answer comes back under its key.
 *   - **A long job is split under the token limit** and says whether it
 *     finished. An item with no answer is unknown, never a low score.
 *   - **An answer already given costs nothing the second time**, and says so.
 *   - **The budget refuses by name**, across all agents and per agent, and a
 *     day's spend survives a restart.
 *   - **Every request is recorded** under `agent:<verb>` with who asked.
 *   - **Every answer names its engine**, and a local judge's is never
 *     calibrated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const settings = vi.hoisted(() => new Map<string, unknown>());
const generate = vi.hoisted(() => ({ generateText: vi.fn() }));
const ledger = vi.hoisted(() => ({ db: null as unknown, ready: true }));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));
// The ledger is real: the real `s1_decisions` SQL over an in-memory SQLite.
vi.mock('../../../../main/stats/singleton', async () => {
	const decisions = await import('../../../../main/stats/s1-decisions');
	const db = (): Database.Database => ledger.db as Database.Database;
	return {
		getStatsDB: () => ({
			isReady: () => ledger.ready,
			recordLocalModelRun: vi.fn(() => 'id'),
			recordSystemOneDecision: (decision: never) =>
				decisions.insertSystemOneDecision(db(), decision),
			getSystemOneDecisions: (read: never) => decisions.getSystemOneDecisions(db(), read),
			getSystemOneAgentSpend: (since: number) => decisions.getSystemOneAgentSpend(db(), since),
			pruneSystemOneDecisions: (cutoffMs: number) =>
				decisions.pruneSystemOneDecisions(db(), cutoffMs),
		}),
	};
});
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
	generateText: generate.generateText,
}));
vi.mock('../../../../main/local-models/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('../../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import {
	SYSTEM_ONE_AGENT_REQUEST_SPACING_MS,
	configureAgentSystemOne,
	getSystemOneAgentAccess,
	getSystemOneAgentAccessRequest,
	readSystemOneAgentUsage,
	resetAgentSystemOneForTests,
	runAgentSystemOneRequest,
} from '../../../../main/local-models/system-one/agent-service';
import { coreSystemPromptSectionsFor } from '../../../../shared/maestroSystemPrompt';
import {
	SYSTEM_ONE_CACHE_DIR,
	SYSTEM_ONE_CACHE_TTL_MS,
	resetSystemOneAnswerCacheForTests,
} from '../../../../main/local-models/system-one/answer-cache';
import {
	SYSTEM_ONE_LEDGER_STATS_OFF_NOTICE,
	SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE,
	resetSystemOneLedgerForTests,
} from '../../../../main/local-models/system-one/decisions';
import {
	configureSystemOne,
	resetSystemOneServiceForTests,
	setSystemOneKeyRequest,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../../../main/local-models/system-one/service';
import { runMigrations } from '../../../../main/stats/migrations';
import {
	clearSystemOneDecisionsCache,
	getSystemOneDecisions,
} from '../../../../main/stats/s1-decisions';
import type { SealProvider } from '../../../../main/utils/safe-storage-seal';
import { QWEN3_1_7B_ID } from '../../../../shared/local-models/model-catalog';
import {
	choice,
	estimateSystemOneRequest,
	noul,
	score,
	type SystemOneQuestions,
	type SystemOneState,
} from '../../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_AGENT_MAX_QUESTIONS,
	SYSTEM_ONE_AGENT_REQUEST_TOKENS,
	SYSTEM_ONE_CONTINUE_WITHOUT,
	SYSTEM_ONE_RANK_QUESTION,
	type SystemOneAgentAskResult,
	type SystemOneAgentBatchResult,
	type SystemOneAgentRankResult,
	type SystemOneAgentRefusal,
	type SystemOneAgentResponse,
} from '../../../../shared/local-models/system-one-agent';
import type { SystemOneLedgerEntry } from '../../../../shared/local-models/system-one-ledger';
import { TYPESAFE_BASE_URL_ENV_VAR } from '../../../../shared/local-models/system-one-settings';
import { LOCAL_JUDGE_TASK_ID } from '../../../../shared/local-models/tasks';
import {
	MOCK_JEV_MAX_STATE_CHARS,
	MOCK_JEV_VERSION,
	startMockJevServer,
	type MockJevServer,
	type MockJevServerOptions,
} from '../../../helpers/mockJevServer';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../../helpers/nodeSqlite';

const KEY = 'sk-agent-service-0123456789';
// Built at run time so no secret-shaped literal sits in the source.
const SECRET = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
const DAY_MS = 86_400_000;
const AGENT = { agentId: 'agent-1', tabId: 'tab-1' };
const STATE = 'The deploy failed at the migration step and was rolled back.';
const QUESTIONS = { failed: noul('Did the deploy fail?') };
const ASK = { kind: 'ask', verb: 'yes', state: STATE, questions: QUESTIONS };

let dir: string;
let home: string;
let shellEnv: Record<string, string>;
let server: MockJevServer | null;
let sessions: Array<Record<string, unknown>>;
let nowMs: number;
let sleep: ReturnType<typeof vi.fn>;

const osSeal: SealProvider = {
	available: () => true,
	seal: (text) => Buffer.from(`os-sealed:${Buffer.from(text).toString('hex')}`),
	unseal: (blob) => Buffer.from(blob.toString().slice('os-sealed:'.length), 'hex').toString(),
};

function configureAgents(): void {
	configureAgentSystemOne({
		sessions: () => sessions,
		now: () => nowMs,
		sleep: sleep as never,
		// Frozen, so the waits a job asks for are exact.
		monotonicNow: () => 0,
	});
}

/** A process that starts again: the day's count is gone, the ledger and the cache are not. */
function restart(): void {
	resetAgentSystemOneForTests();
	configureAgents();
}

/** The hosted engine at the mock server, with a key, having passed its Test. */
async function jevReady(options: MockJevServerOptions = {}): Promise<MockJevServer> {
	server = await startMockJevServer({ apiKey: KEY, ...options });
	shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = server.baseUrl;
	await setSystemOneKeyRequest({ engine: 'jev-cloud', key: KEY });
	await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
	expect((await testSystemOne()).ok).toBe(true);
	server.requests.length = 0;
	return server;
}

/** The local judge on a model whose every answer is `reply`, having passed its Test. */
async function judgeReady(reply: Record<string, unknown> = { answer: 'yes', confidence: 0.8 }) {
	settings.set('localModelAssignments', {
		[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
	});
	generate.generateText.mockImplementation(async (request: { source: unknown }) => ({
		text: JSON.stringify(reply),
		json: reply,
		source: request.source,
		durationMs: 30,
		tokensIn: 60,
		tokensOut: 8,
	}));
	await updateSystemOneSettingsRequest({ engine: 'local-judge' });
	expect((await testSystemOne()).ok).toBe(true);
	generate.generateText.mockClear();
}

function records(): SystemOneLedgerEntry[] {
	return getSystemOneDecisions(ledger.db as Database.Database, { since: 0, limit: 1_000 }).entries;
}

function answered<T extends SystemOneAgentResponse>(response: SystemOneAgentResponse): T {
	if (!response.ok) throw new Error(`refused: ${response.code}: ${response.message}`);
	return response as T;
}

function refusedBy(response: SystemOneAgentResponse): SystemOneAgentRefusal {
	if (response.ok) throw new Error('expected a refusal');
	return response;
}

/** A caller that names no agent: a person at a terminal, or a script. */
const NOBODY = null;

type Caller = { agentId: string; tabId?: string } | typeof NOBODY;

const ask = (request: unknown = ASK, caller: Caller = AGENT) =>
	runAgentSystemOneRequest(request, caller ?? undefined);

/** `count` commit lines, keyed by their line number. */
function commits(count: number, chars = 0): Array<{ key: string; item: string }> {
	return Array.from({ length: count }, (_, i) => ({
		key: String(i + 1),
		item: `commit ${i + 1}${chars ? ` ${'x'.repeat(chars)}` : ''}`,
	}));
}

/** What the mock engine says of a commit: a number that depends on the commit alone. */
function commitScore(item: string): number {
	const n = Number(/^commit (\d+)/.exec(item)?.[1]);
	return ((n * 37) % 100) / 100;
}

/** Answers a rank's questions from the candidate INSIDE each question. */
const byCandidate: MockJevServerOptions['answer'] = (_id, question) => {
	const instructions = question.instructions as { candidate?: unknown } | string;
	if (typeof instructions === 'string' || typeof instructions.candidate !== 'string') {
		return undefined;
	}
	return { type: 'noul', noul: commitScore(instructions.candidate) };
};

/** A budget one answered request passes: the mock bills a few millionths of a dollar. */
const ONE_REQUEST_BUDGET = 0.000_000_1;

describe.skipIf(!canLoadNodeSqlite())('runAgentSystemOneRequest', () => {
	beforeEach(async () => {
		settings.clear();
		generate.generateText.mockReset();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-agent-'));
		home = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-agent-home-'));
		shellEnv = {};
		server = null;
		sessions = [{ id: 'agent-1' }, { id: 'agent-2' }];
		nowMs = Date.now();
		sleep = vi.fn(async () => {});
		ledger.ready = true;
		clearSystemOneDecisionsCache();
		const Shim = nodeSqliteBetterSqlite3Mock().default;
		ledger.db = new Shim(':memory:');
		runMigrations(ledger.db as Database.Database);
		resetSystemOneLedgerForTests();
		resetSystemOneAnswerCacheForTests();
		configureSystemOne({
			dataDir: () => dir,
			osSeal: () => osSeal,
			shellEnvVars: () => shellEnv,
			processEnv: () => ({}),
			homeDir: () => home,
		});
		configureAgents();
	});

	afterEach(async () => {
		resetAgentSystemOneForTests();
		resetSystemOneServiceForTests();
		await server?.close();
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(home, { recursive: true, force: true });
	});

	describe('the request', () => {
		it('refuses one it cannot read, before a switch is even looked at', async () => {
			const jev = await jevReady();

			for (const raw of [
				null,
				'yes',
				{ kind: 'generate', prompt: 'Write a poem.' },
				{ ...ASK, state: '' },
				{ ...ASK, questions: { q: { type: 'essay', instructions: 'Go on.' } } },
				{
					kind: 'rank',
					query: 'q',
					candidates: [
						{ key: 'a', item: 'x' },
						{ key: 'a', item: 'y' },
					],
				},
			]) {
				const refusal = refusedBy(await ask(raw));
				expect(refusal.code).toBe('invalid');
				expect(refusal).not.toHaveProperty('gate');
			}
			expect(jev.requests).toHaveLength(0);
			expect(records()).toHaveLength(0);
		});

		it('reads only the fields a request has: a caller cannot name a model, a key or a budget', async () => {
			const jev = await jevReady();

			answered(
				await ask({ ...ASK, model: 'someone-elses-model', apiKey: 'sk-mine', timeoutMs: 1 })
			);

			expect(jev.requests).toHaveLength(1);
			expect(jev.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
			expect(jev.requests[0].body).toMatchObject({ model: 'jev-latest' });
			expect(Object.keys(jev.requests[0].body ?? {}).sort()).toEqual([
				'model',
				'questions',
				'state',
			]);
		});
	});

	describe('off is off', () => {
		it('refuses while no engine is chosen', async () => {
			const refusal = refusedBy(await ask());

			expect(refusal).toMatchObject({ code: 'off', gate: 'engine-off' });
			expect(refusal.message).toMatch(/^System One is off/);
			expect(refusal.message.endsWith(SYSTEM_ONE_CONTINUE_WITHOUT)).toBe(true);
			expect(refusal).not.toHaveProperty('engine');
			expect(records()).toHaveLength(0);
		});

		it('refuses every agent while "Let agents use System One" is switched off', async () => {
			const jev = await jevReady();
			await updateSystemOneSettingsRequest({ agents: { enabled: false } });

			for (const caller of [AGENT, { agentId: 'agent-2' }, NOBODY]) {
				const refusal = refusedBy(await ask(ASK, caller));
				expect(refusal).toMatchObject({ code: 'off', gate: 'agents-off', engine: 'jev-cloud' });
				expect(refusal.message).toContain('"Let agents use System One"');
			}
			expect(jev.requests).toHaveLength(0);

			await updateSystemOneSettingsRequest({ agents: { enabled: true } });
			expect((await ask()).ok).toBe(true);
		});

		it('refuses the one agent that is switched off in its own settings, and nobody else', async () => {
			const jev = await jevReady();
			sessions = [{ id: 'agent-1', systemOneOptOut: true }, { id: 'agent-2' }];

			const refusal = refusedBy(await ask());
			expect(refusal).toMatchObject({ code: 'off', gate: 'agent-opted-out' });
			expect(refusal.message).toContain('off for this agent');
			expect(jev.requests).toHaveLength(0);

			expect((await ask(ASK, { agentId: 'agent-2' })).ok).toBe(true);
			// A caller that names nobody is not that agent.
			expect((await ask(ASK, NOBODY)).ok).toBe(true);
			// Nor is an agent the stores do not know: there is no switch to read.
			expect((await ask(ASK, { agentId: 'not-an-agent' })).ok).toBe(true);
		});

		it('refuses an engine that is not set up, with what is missing', async () => {
			server = await startMockJevServer({ apiKey: KEY });
			shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = server.baseUrl;
			await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });

			const refusal = refusedBy(await ask());

			expect(refusal).toMatchObject({ code: 'off', gate: 'engine-not-ready', engine: 'jev-cloud' });
			expect(refusal.message).toContain('has no API key');
			expect(server.requests).toHaveLength(0);
		});

		it('refuses an engine that has not passed its Test, and answers once it has', async () => {
			server = await startMockJevServer({ apiKey: KEY });
			shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = server.baseUrl;
			await setSystemOneKeyRequest({ engine: 'jev-cloud', key: KEY });
			await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });

			const refusal = refusedBy(await ask());
			expect(refusal).toMatchObject({ code: 'off', gate: 'engine-untested' });
			expect(refusal.message).toMatch(/Jev \(TypeSafe cloud\) has not passed its Test/);
			expect(server.requests).toHaveLength(0);

			expect((await testSystemOne()).ok).toBe(true);
			expect((await ask()).ok).toBe(true);
		});

		it('reads a changed model, a replaced key and a failed Test as not tested', async () => {
			const jev = await jevReady();
			expect((await ask()).ok).toBe(true);

			await updateSystemOneSettingsRequest({ model: 'jev-1.12.0' });
			expect(refusedBy(await ask()).gate).toBe('engine-untested');
			// The setup that passed is the one that is back in force.
			await updateSystemOneSettingsRequest({ model: null });
			expect((await ask()).ok).toBe(true);

			await setSystemOneKeyRequest({ engine: 'jev-cloud', key: KEY });
			expect(refusedBy(await ask()).gate).toBe('engine-untested');
			expect((await testSystemOne()).ok).toBe(true);
			expect((await ask()).ok).toBe(true);

			jev.replyOnce({ status: 503, body: { error: { message: 'Overloaded.' } } });
			expect((await testSystemOne()).ok).toBe(false);
			expect(refusedBy(await ask()).gate).toBe('engine-untested');
		});

		it('says what the user switched off before it says what the engine lacks', async () => {
			await updateSystemOneSettingsRequest({ engine: 'jev-cloud', agents: { enabled: false } });
			expect(refusedBy(await ask()).gate).toBe('agents-off');

			await updateSystemOneSettingsRequest({ agents: { enabled: true } });
			sessions = [{ id: 'agent-1', systemOneOptOut: true }];
			expect(refusedBy(await ask()).gate).toBe('agent-opted-out');

			await updateSystemOneSettingsRequest({ engine: 'off' });
			expect(refusedBy(await ask()).gate).toBe('engine-off');
		});
	});

	describe('one request', () => {
		it('answers with typed answers, the engine, its calibration, tokens and cost', async () => {
			const jev = await jevReady();

			const result = answered<SystemOneAgentAskResult>(await ask());

			expect(result).toMatchObject({
				ok: true,
				kind: 'ask',
				verb: 'yes',
				answers: { failed: { type: 'noul', probability: 0.91 } },
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
				calibrated: true,
				model: MOCK_JEV_VERSION,
				cached: false,
				redacted: false,
			});
			expect(result.tokens.inputTokens).toBeGreaterThan(0);
			expect(result.costUsd).toBeGreaterThan(0);
			expect(result.latencyMs).toBeGreaterThanOrEqual(0);
			expect(result.budget.spentTodayUsd).toBeCloseTo(result.costUsd, 12);
			expect(jev.requests).toHaveLength(1);
			expect(jev.requests[0].body).toMatchObject({ state: STATE, questions: QUESTIONS });
		});

		it('answers all three question types in one request', async () => {
			await jevReady();
			const questions = {
				failed: noul('Did the deploy fail?'),
				team: choice('Who owns it?', { infra: 'Deploys and databases', web: 'The site' }),
				urgency: score('How urgent?', ['can wait', 'this week', 'now']),
			};

			const result = answered<SystemOneAgentAskResult>(
				await ask({ kind: 'ask', verb: 'ask', state: STATE, questions })
			);

			expect(result.answers).toMatchObject({
				failed: { type: 'noul' },
				team: { type: 'choice', choice: 'infra', confidence: 0.74 },
				urgency: { type: 'score', score: 1.75 },
			});
			expect(records()[0]).toMatchObject({
				taskId: 'agent:ask',
				questionIds: ['failed', 'team', 'urgency'],
			});
		});

		it('never hands the key to the caller, in an answer or in a refusal', async () => {
			const jev = await jevReady();
			expect(JSON.stringify(await ask())).not.toContain(KEY);

			jev.replyOnce({ status: 401, body: { error: { message: 'Invalid API key.' } } });
			const refusal = refusedBy(await ask({ ...ASK, noCache: true }));
			expect(refusal.code).toBe('auth');
			expect(JSON.stringify(refusal)).not.toContain(KEY);
		});

		it('redacts a secret before the request leaves, and says it did', async () => {
			const jev = await jevReady();

			const result = answered<SystemOneAgentAskResult>(
				await ask({ ...ASK, state: `The token ${SECRET} was pasted into the log.` })
			);

			expect(result.redacted).toBe(true);
			expect(JSON.stringify(jev.requests[0].body)).not.toContain(SECRET);
		});

		it('gives an agent request the long budget, not the one a gate is held to', async () => {
			const jev = await jevReady();
			await updateSystemOneSettingsRequest({ timeoutMs: 100 });
			// The setup did not change, so the pass still stands.
			jev.setDelayMs(300);

			expect((await ask()).ok).toBe(true);
		});

		it("refuses with the engine's own code when it gives no answer, and asks no other engine", async () => {
			const jev = await jevReady();
			await judgeAssignedButNotInForce();
			jev.replyOnce({ status: 429, body: { error: { message: 'Slow down.' } } });

			const refusal = refusedBy(await ask());

			expect(refusal).toMatchObject({
				code: 'rate-limited',
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
			});
			expect(refusal).not.toHaveProperty('gate');
			expect(generate.generateText).not.toHaveBeenCalled();
			expect(jev.requests).toHaveLength(1);
			expect(refusal.budget?.spentTodayUsd).toBe(0);
		});

		it('reports a cancelled call as cancelled', async () => {
			await jevReady();
			const gone = new AbortController();
			gone.abort();

			const refusal = refusedBy(
				await runAgentSystemOneRequest(ASK, AGENT, { signal: gone.signal })
			);

			expect(refusal.code).toBe('cancelled');
			expect(records()[0]).toMatchObject({ outcome: 'cancelled', code: 'cancelled' });
		});

		it('names the local judge and never calls its numbers calibrated', async () => {
			await judgeReady();

			const result = answered<SystemOneAgentAskResult>(await ask());

			expect(result).toMatchObject({
				engine: 'local-judge',
				calibrated: false,
				model: `local:${QWEN3_1_7B_ID}`,
				costUsd: 0,
				answers: { failed: { type: 'noul', probability: 0.8 } },
			});
			expect(result.engineLabel).toContain('not calibrated');
		});
	});

	describe('the record', () => {
		it("files a request under the agent's verb, with the agent and tab that asked", async () => {
			await jevReady();

			const result = answered<SystemOneAgentAskResult>(await ask());

			expect(records()).toEqual([
				expect.objectContaining({
					taskId: 'agent:yes',
					engine: 'jev-cloud',
					model: MOCK_JEV_VERSION,
					questionIds: ['failed'],
					answers: { failed: { type: 'noul', probability: 0.91 } },
					outcome: 'ok',
					agentId: 'agent-1',
					tabId: 'tab-1',
					startedAt: nowMs,
					usage: result.tokens,
					costUsd: result.costUsd,
				}),
			]);
			expect(records()[0]).not.toHaveProperty('cached');
			expect(records()[0]).not.toHaveProperty('input');
		});

		it('records a request that names nobody with no agent', async () => {
			await jevReady();

			answered(await ask(ASK, NOBODY));

			expect(records()[0]).not.toHaveProperty('agentId');
			expect(records()[0]).not.toHaveProperty('tabId');
		});

		it('records a request the engine did not answer, with why', async () => {
			const jev = await jevReady();
			jev.replyOnce({ status: 503, body: { error: { message: 'Overloaded.' } } });

			refusedBy(await ask());

			expect(records()).toEqual([
				expect.objectContaining({
					taskId: 'agent:yes',
					outcome: 'unavailable',
					code: 'unavailable',
					agentId: 'agent-1',
				}),
			]);
			expect(records()[0]).not.toHaveProperty('answers');
		});

		it('keeps what was asked only while "Keep inputs in the ledger" is on, and then redacted', async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ keepInputs: true });

			answered(await ask({ ...ASK, state: `Leaked ${SECRET} in the deploy log.`, noCache: true }));

			const kept = records()[0].input ?? '';
			expect(kept).toContain('deploy log');
			expect(kept).toContain('Did the deploy fail?');
			expect(kept).not.toContain(SECRET);
		});

		it('bounds the names it keeps, and keeps a tab only with its agent', async () => {
			await jevReady();

			answered(await ask(ASK, { agentId: `  ${'a'.repeat(500)}  `, tabId: 't' }));
			answered(await ask({ ...ASK, noCache: true }, { agentId: '   ', tabId: 'orphan' }));

			const [second, first] = records();
			expect(first.agentId).toHaveLength(200);
			expect(first.tabId).toBe('t');
			expect(second).not.toHaveProperty('agentId');
			expect(second).not.toHaveProperty('tabId');
		});
	});

	describe('the answer cache', () => {
		it('answers a repeat from the cache: nothing sent, no tokens, no cost, and it says so', async () => {
			const jev = await jevReady();
			const first = answered<SystemOneAgentAskResult>(await ask());

			const repeat = answered<SystemOneAgentAskResult>(await ask());

			expect(jev.requests).toHaveLength(1);
			expect(repeat).toMatchObject({
				cached: true,
				latencyMs: 0,
				tokens: { inputTokens: 0, outputTokens: 0 },
				costUsd: 0,
				model: MOCK_JEV_VERSION,
				engine: 'jev-cloud',
				calibrated: true,
			});
			expect(repeat.answers).toEqual(first.answers);
			// The repeat spent nothing.
			expect(repeat.budget.spentTodayUsd).toBeCloseTo(first.costUsd, 12);
		});

		it('records a cached answer as one, at no cost', async () => {
			await jevReady();
			answered(await ask());
			nowMs += 1_000;

			answered(await ask());

			expect(records()[0]).toMatchObject({
				taskId: 'agent:yes',
				outcome: 'ok',
				cached: true,
				latencyMs: 0,
				costUsd: 0,
				usage: { inputTokens: 0, outputTokens: 0 },
				agentId: 'agent-1',
			});
		});

		it('is the same request whatever order its keys are written in, for any agent', async () => {
			const jev = await jevReady();
			const state = { ticket: { title: 'Refund', body: 'Charged twice.' }, plan: 'pro' };
			const questions: SystemOneQuestions = {
				refund: noul('Is this a refund request?', { true: 'Asks for money back.', false: 'Not.' }),
			};
			answered(await ask({ kind: 'ask', verb: 'yes', state, questions }));

			const reordered = answered<SystemOneAgentAskResult>(
				await ask(
					{
						questions: {
							refund: {
								criteria: { false: 'Not.', true: 'Asks for money back.' },
								instructions: 'Is this a refund request?',
								type: 'noul',
							},
						},
						state: { plan: 'pro', ticket: { body: 'Charged twice.', title: 'Refund' } },
						verb: 'yes',
						kind: 'ask',
					},
					{ agentId: 'agent-2' }
				)
			);

			expect(reordered.cached).toBe(true);
			expect(jev.requests).toHaveLength(1);
		});

		it('asks again for another state, another question, or another model', async () => {
			const jev = await jevReady();
			answered(await ask());

			answered(await ask({ ...ASK, state: `${STATE} Twice.` }));
			answered(await ask({ ...ASK, questions: { failed: noul('Did the deploy succeed?') } }));
			expect(jev.requests).toHaveLength(3);

			await updateSystemOneSettingsRequest({ model: 'jev-1.12.0' });
			expect((await testSystemOne()).ok).toBe(true);
			const pinned = answered<SystemOneAgentAskResult>(await ask());
			expect(pinned.cached).toBe(false);
			expect(pinned.model).toBe('jev-1.12.0');
		});

		it('asks again with noCache, and stores the new answer', async () => {
			const jev = await jevReady();
			answered(await ask());

			const fresh = answered<SystemOneAgentAskResult>(await ask({ ...ASK, noCache: true }));

			expect(fresh.cached).toBe(false);
			expect(jev.requests).toHaveLength(2);
			expect(answered<SystemOneAgentAskResult>(await ask()).cached).toBe(true);
		});

		it('asks again after seven days', async () => {
			const jev = await jevReady();
			answered(await ask());

			nowMs += SYSTEM_ONE_CACHE_TTL_MS - 1_000;
			expect(answered<SystemOneAgentAskResult>(await ask()).cached).toBe(true);

			nowMs += 2_000;
			expect(answered<SystemOneAgentAskResult>(await ask()).cached).toBe(false);
			expect(jev.requests).toHaveLength(2);
		});

		it('does not store a request the engine did not answer', async () => {
			const jev = await jevReady();
			jev.replyOnce({ status: 503, body: { error: { message: 'Overloaded.' } } });
			refusedBy(await ask());

			expect(answered<SystemOneAgentAskResult>(await ask()).cached).toBe(false);
			expect(jev.requests).toHaveLength(2);
		});

		it('keeps answers on disk and never the text that was judged', async () => {
			await jevReady();
			answered(await ask({ ...ASK, state: `${STATE} ${SECRET}` }));

			const root = path.join(dir, SYSTEM_ONE_CACHE_DIR);
			const files: string[] = [];
			for (const shard of await fs.readdir(root)) {
				for (const name of await fs.readdir(path.join(root, shard))) {
					expect(name.startsWith(shard)).toBe(true);
					files.push(await fs.readFile(path.join(root, shard, name), 'utf-8'));
				}
			}
			expect(files).toHaveLength(1);
			expect(files[0]).toContain('"probability":0.91');
			expect(files[0]).not.toContain('deploy');
			expect(files[0]).not.toContain('Did the deploy fail?');
			expect(files[0]).not.toContain(SECRET);
		});
	});

	describe('rank', () => {
		const rank = (overrides: Record<string, unknown> = {}) =>
			runAgentSystemOneRequest(
				{ kind: 'rank', query: 'a security fix', candidates: commits(40), ...overrides },
				AGENT
			);

		it('puts each candidate inside its own question, and no candidate in the state', async () => {
			const jev = await jevReady({ answer: byCandidate });

			answered(await rank({ candidates: commits(3) }));

			expect(jev.requests).toHaveLength(1);
			const body = jev.requests[0].body as {
				state: SystemOneState;
				questions: Record<string, { type: string; instructions: Record<string, unknown> }>;
			};
			expect(body.state).toEqual({ query: 'a security fix' });
			expect(JSON.stringify(body.state)).not.toContain('commit');
			expect(body.questions).toEqual({
				c0: {
					type: 'noul',
					instructions: { question: SYSTEM_ONE_RANK_QUESTION, candidate: 'commit 1' },
				},
				c1: {
					type: 'noul',
					instructions: { question: SYSTEM_ONE_RANK_QUESTION, candidate: 'commit 2' },
				},
				c2: {
					type: 'noul',
					instructions: { question: SYSTEM_ONE_RANK_QUESTION, candidate: 'commit 3' },
				},
			});
		});

		it("returns each candidate's answer under its key, best first", async () => {
			await jevReady({ answer: byCandidate });
			const candidates = commits(40);

			const result = answered<SystemOneAgentRankResult>(await rank({ candidates }));

			const expected = candidates
				.map(({ key, item }) => ({ key, p: commitScore(item) }))
				.sort((a, b) => b.p - a.p);
			expect(result.results).toEqual(expected);
			expect(result.unjudged).toEqual([]);
			expect(result.completeness).toMatchObject({
				complete: true,
				total: 40,
				judged: 40,
				requests: 1,
			});
			expect(result.completeness.marker).toBe(
				'End s1 rank: 40/40 candidates judged in 1 request(s); 40 shown.'
			);
			expect(result).toMatchObject({ engine: 'jev-cloud', calibrated: true, cached: false });
		});

		it('keeps the keys the caller gave, whatever they are', async () => {
			await jevReady({ answer: byCandidate });

			const result = answered<SystemOneAgentRankResult>(
				await rank({
					candidates: [
						{ key: 'src/main/a.ts', item: 'commit 2' },
						{ key: 'line 14', item: 'commit 1' },
						{ key: 'c0', item: 'commit 3' },
					],
				})
			);

			// The third candidate is keyed like the FIRST question's id, and is still itself.
			expect(result.results).toEqual([
				{ key: 'src/main/a.ts', p: commitScore('commit 2') },
				{ key: 'line 14', p: commitScore('commit 1') },
				{ key: 'c0', p: commitScore('commit 3') },
			]);
		});

		it('applies min and top after judging everything, and says how many are shown', async () => {
			await jevReady({ answer: byCandidate });

			const result = answered<SystemOneAgentRankResult>(await rank({ min: 0.5, top: 5 }));

			expect(result.results).toHaveLength(5);
			expect(result.results.every((entry) => entry.p >= 0.5)).toBe(true);
			expect(result.completeness).toMatchObject({ complete: true, judged: 40 });
			expect(result.completeness.marker).toContain('40/40 candidates judged');
			expect(result.completeness.marker).toContain('5 shown');
		});

		it('ranks on a rubric as a place from 0 to 1, with the level and the confidence', async () => {
			await jevReady();

			const result = answered<SystemOneAgentRankResult>(
				await rank({ candidates: commits(2), levels: ['unrelated', 'related', 'exact'] })
			);

			// The mock puts a score at 1.75 of a top level of 2.
			expect(result.results).toEqual([
				{ key: '1', p: 0.875, score: 1.75, confidence: 0.88 },
				{ key: '2', p: 0.875, score: 1.75, confidence: 0.88 },
			]);
		});

		it('splits a long list at the question limit and judges all of it', async () => {
			const jev = await jevReady({ answer: byCandidate });
			const count = SYSTEM_ONE_AGENT_MAX_QUESTIONS * 2 + 100;

			const result = answered<SystemOneAgentRankResult>(await rank({ candidates: commits(count) }));

			expect(
				jev.requests.map((request) => Object.keys(questionsOf(request)).length).sort()
			).toEqual([100, 250, 250]);
			// Every candidate was asked about exactly once.
			const asked = jev.requests.flatMap((request) =>
				Object.values(questionsOf(request)).map((question) => question.instructions.candidate)
			);
			expect(new Set(asked).size).toBe(count);
			expect(result.completeness).toMatchObject({
				complete: true,
				total: count,
				judged: count,
				requests: 3,
			});
			expect(result.results[0].p).toBe(0.99);
			// One row per request, each under the verb.
			expect(records().map((entry) => entry.taskId)).toEqual([
				'agent:rank',
				'agent:rank',
				'agent:rank',
			]);
			expect(result.tokens.inputTokens).toBe(
				records().reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0)
			);
		});

		it('splits under the token limit when the candidates are long', async () => {
			const jev = await jevReady({ answer: byCandidate });

			const result = answered<SystemOneAgentRankResult>(
				await rank({ candidates: commits(30, 10_000) })
			);

			expect(jev.requests.length).toBeGreaterThan(1);
			for (const request of jev.requests) {
				const body = request.body as { state: SystemOneState; questions: SystemOneQuestions };
				const estimate = estimateSystemOneRequest('jev-cloud', body.state, body.questions);
				expect(estimate.inputTokens).toBeLessThanOrEqual(SYSTEM_ONE_AGENT_REQUEST_TOKENS);
				expect(estimate.fits).toBe(true);
			}
			expect(result.completeness).toMatchObject({ complete: true, judged: 30 });
		});

		it('says INCOMPLETE when a request fails, and lists what is unknown instead of scoring it low', async () => {
			const jev = await jevReady({ answer: byCandidate });
			jev.replyOnce({ status: 503, body: { error: { message: 'Overloaded.' } } });
			const count = SYSTEM_ONE_AGENT_MAX_QUESTIONS + 10;

			const result = answered<SystemOneAgentRankResult>(await rank({ candidates: commits(count) }));

			const lost = result.unjudged.length;
			expect([10, SYSTEM_ONE_AGENT_MAX_QUESTIONS]).toContain(lost);
			expect(result.results).toHaveLength(count - lost);
			// No unjudged candidate was slipped into the ranking.
			expect(result.results.map((entry) => entry.key)).not.toEqual(
				expect.arrayContaining(result.unjudged)
			);
			expect(result.completeness).toMatchObject({
				complete: false,
				total: count,
				judged: count - lost,
				requests: 2,
				failedRequests: 1,
				skippedRequests: 0,
				errors: [{ code: 'unavailable', requests: 1 }],
			});
			expect(result.completeness.marker).toMatch(/^INCOMPLETE s1 rank: /);
			expect(result.completeness.marker).toContain('UNKNOWN, not irrelevant');
		});

		it('judges only the failed part again on a second run: the rest is cached', async () => {
			const jev = await jevReady({ answer: byCandidate });
			jev.replyOnce({ status: 503, body: { error: { message: 'Overloaded.' } } });
			const candidates = commits(SYSTEM_ONE_AGENT_MAX_QUESTIONS + 10);
			answered(await rank({ candidates }));
			jev.requests.length = 0;

			const again = answered<SystemOneAgentRankResult>(await rank({ candidates }));

			expect(jev.requests).toHaveLength(1);
			expect(again.cachedRequests).toBe(1);
			expect(again.cached).toBe(false);
			expect(again.completeness.complete).toBe(true);
		});

		it('warns when the question points at a position in a list', async () => {
			await jevReady();

			const pointed = answered<SystemOneAgentRankResult>(
				await rank({ candidates: commits(2), instructions: 'Is `candidates[1]` a security fix?' })
			);
			const named = answered<SystemOneAgentRankResult>(
				await rank({ candidates: commits(2), instructions: 'Is `candidate` a security fix?' })
			);

			expect(pointed.warnings).toHaveLength(1);
			expect(pointed.warnings[0]).toContain('`candidate`');
			expect(named.warnings).toEqual([]);
		});

		it('asks the local judge one candidate at a time, and calls nothing calibrated', async () => {
			await judgeReady({ answer: 'no', confidence: 0.7 });

			const result = answered<SystemOneAgentRankResult>(await rank({ candidates: commits(3) }));

			expect(generate.generateText).toHaveBeenCalledTimes(3);
			expect(result).toMatchObject({ engine: 'local-judge', calibrated: false, costUsd: 0 });
			expect(result.completeness).toMatchObject({ complete: true, requests: 3 });
			expect(result.results.map((entry) => entry.p)).toEqual(
				[0.3, 0.3, 0.3].map((p) => expect.closeTo(p, 10))
			);
			expect(records().map((entry) => entry.questionIds)).toEqual(
				expect.arrayContaining([['c0'], ['c1'], ['c2']])
			);
		});
	});

	describe('batch', () => {
		const rows = (count: number) =>
			Array.from({ length: count }, (_, i) => ({
				line: i * 2,
				...(i % 2 === 0 ? { id: `row-${i}` } : {}),
				state: `Ticket ${i}: the invoice was charged twice.`,
			}));
		const batch = (overrides: Record<string, unknown> = {}) =>
			runAgentSystemOneRequest(
				{
					kind: 'batch',
					rows: rows(6),
					questions: { refund: noul('Is this a refund request?') },
					...overrides,
				},
				AGENT
			);

		it('asks the same questions of every row, one request a row, and answers in order', async () => {
			const jev = await jevReady();

			const result = answered<SystemOneAgentBatchResult>(await batch());

			expect(jev.requests).toHaveLength(6);
			expect(new Set(jev.requests.map((request) => request.body?.state)).size).toBe(6);
			expect(result.rows).toEqual(
				rows(6).map((row) => ({
					line: row.line,
					...('id' in row ? { id: row.id } : {}),
					answers: { refund: { type: 'noul', probability: 0.91 } },
					cached: false,
				}))
			);
			expect(result.completeness).toMatchObject({
				complete: true,
				total: 6,
				judged: 6,
				requests: 6,
			});
			expect(result.completeness.marker).toBe('End s1 batch: 6/6 rows answered in 6 request(s).');
			expect(records().every((entry) => entry.taskId === 'agent:batch')).toBe(true);
			expect(records()).toHaveLength(6);
		});

		it('fails one row by name and answers the others', async () => {
			await jevReady();
			const tooLong = { line: 99, state: 'x'.repeat(MOCK_JEV_MAX_STATE_CHARS + 1) };

			const result = answered<SystemOneAgentBatchResult>(
				await batch({ rows: [...rows(3), tooLong] })
			);

			expect(result.rows.slice(0, 3).every((row) => 'answers' in row)).toBe(true);
			expect(result.rows[3]).toMatchObject({ line: 99, error: { code: 'too-large' } });
			expect(result.completeness).toMatchObject({
				complete: false,
				judged: 3,
				failedRequests: 1,
				errors: [{ code: 'too-large', requests: 1 }],
			});
			expect(result.completeness.marker).toMatch(/^INCOMPLETE s1 batch: 3\/4 rows answered/);
			expect(result.completeness.marker).toContain('UNKNOWN, not a no');
		});

		it('answers a second run from the cache, row by row', async () => {
			const jev = await jevReady();
			answered(await batch());
			jev.requests.length = 0;

			const again = answered<SystemOneAgentBatchResult>(
				await batch({ rows: [...rows(6), { line: 50, state: 'New ticket.' }] })
			);

			expect(jev.requests).toHaveLength(1);
			expect(again.cachedRequests).toBe(6);
			expect(again.rows.map((row) => 'answers' in row && row.cached)).toEqual([
				true,
				true,
				true,
				true,
				true,
				true,
				false,
			]);
			expect(again.cached).toBe(false);
		});

		it('says a job was all cache when it was', async () => {
			await jevReady();
			answered(await batch());

			const again = answered<SystemOneAgentBatchResult>(await batch());

			expect(again).toMatchObject({ cached: true, costUsd: 0, cachedRequests: 6 });
		});

		it('stops sending when the key is refused, and says so for the rows it did not send', async () => {
			const jev = await jevReady();
			jev.replyOnce({ status: 401, body: { error: { message: 'Invalid API key.' } } });

			const result = answered<SystemOneAgentBatchResult>(await batch({ rows: rows(12) }));

			expect(jev.requests.length).toBeLessThan(12);
			expect(result.completeness.complete).toBe(false);
			expect(result.completeness.skippedRequests).toBeGreaterThan(0);
			expect(result.completeness.errors).toEqual([
				expect.objectContaining({ code: 'auth', requests: 1 }),
			]);
			const unsent = result.rows.filter(
				(row) => 'error' in row && row.error.message.startsWith('Not sent.')
			);
			expect(unsent).toHaveLength(result.completeness.skippedRequests);
			expect(unsent.every((row) => 'error' in row && row.error.code === 'auth')).toBe(true);
		});
	});

	describe('the budget', () => {
		it('refuses by name once the day is spent, sends nothing, and says to go on without', async () => {
			const jev = await jevReady();
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET } });
			const first = answered<SystemOneAgentAskResult>(await ask());
			expect(first.budget.remainingTodayUsd).toBe(0);

			const refusal = refusedBy(await ask({ ...ASK, state: 'Another state.' }));

			expect(refusal).toMatchObject({ code: 'budget', gate: 'budget-day', engine: 'jev-cloud' });
			expect(refusal.message).toMatch(/^System One's budget for today is spent/);
			expect(refusal.message.endsWith(SYSTEM_ONE_CONTINUE_WITHOUT)).toBe(true);
			expect(refusal.budget).toMatchObject({ dailyBudgetUsd: ONE_REQUEST_BUDGET });
			expect(jev.requests).toHaveLength(1);
			// A refusal is not a request: nothing is recorded for it.
			expect(records()).toHaveLength(1);
		});

		it('holds for every agent, and for a caller that names nobody', async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET } });
			answered(await ask());

			for (const caller of [{ agentId: 'agent-2' }, NOBODY]) {
				expect(refusedBy(await ask({ ...ASK, state: 'Other.' }, caller)).gate).toBe('budget-day');
			}
		});

		it('caps one agent at its own budget while the others still ask', async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ agents: { perAgentBudgetUsd: ONE_REQUEST_BUDGET } });
			answered(await ask());

			const refusal = refusedBy(await ask({ ...ASK, state: 'Other.' }));
			expect(refusal).toMatchObject({ code: 'budget', gate: 'budget-agent' });
			expect(refusal.message).toMatch(/^This agent's System One budget for today is spent/);
			expect(refusal.budget?.agent).toMatchObject({
				agentId: 'agent-1',
				budgetUsd: ONE_REQUEST_BUDGET,
				remainingTodayUsd: 0,
			});

			const other = answered<SystemOneAgentAskResult>(
				await ask({ ...ASK, state: 'Other.' }, { agentId: 'agent-2' })
			);
			expect(other.budget.agent).toMatchObject({ agentId: 'agent-2' });
			// A caller that names nobody has no cap of its own; the day's budget still holds for it.
			const unnamed = answered<SystemOneAgentAskResult>(
				await ask({ ...ASK, state: 'Third.' }, NOBODY)
			);
			expect(unnamed.budget).not.toHaveProperty('agent');
		});

		it('refuses everything at a budget of zero, on an engine that costs nothing too', async () => {
			server = await startMockJevServer();
			await updateSystemOneSettingsRequest({ engine: 'openjev', openJevUrl: server.baseUrl });
			expect((await testSystemOne()).ok).toBe(true);
			server.requests.length = 0;
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: 0 } });

			expect(refusedBy(await ask()).gate).toBe('budget-day');
			expect(server.requests).toHaveLength(0);
		});

		it('never binds on an engine that costs nothing, while the budget is above zero', async () => {
			server = await startMockJevServer();
			await updateSystemOneSettingsRequest({
				engine: 'openjev',
				openJevUrl: server.baseUrl,
				agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET },
			});
			expect((await testSystemOne()).ok).toBe(true);

			for (let i = 0; i < 5; i++) {
				const result = answered<SystemOneAgentAskResult>(
					await ask({ ...ASK, state: `State ${i}.` })
				);
				expect(result).toMatchObject({ engine: 'openjev', costUsd: 0 });
			}
		});

		it("survives a restart: the day's spend is read back from the ledger", async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET } });
			const first = answered<SystemOneAgentAskResult>(await ask());

			restart();

			const refusal = refusedBy(await ask({ ...ASK, state: 'After the restart.' }));
			expect(refusal.gate).toBe('budget-day');
			expect(refusal.budget?.spentTodayUsd).toBeCloseTo(first.costUsd, 12);
			expect(refusal.budget?.agent?.spentTodayUsd).toBeCloseTo(first.costUsd, 12);
		});

		it('still holds inside one process while usage statistics are off and the ledger keeps nothing', async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET } });
			settings.set('statsCollectionEnabled', false);

			answered(await ask());

			expect(records()).toHaveLength(0);
			expect(refusedBy(await ask({ ...ASK, state: 'Other.' })).gate).toBe('budget-day');
		});

		it('counts on its own until the statistics database opens, and never counts a request twice', async () => {
			await jevReady();
			ledger.ready = false;
			const first = answered<SystemOneAgentAskResult>(await ask());
			expect(first.budget.spentTodayUsd).toBeCloseTo(first.costUsd, 12);

			ledger.ready = true;
			const second = answered<SystemOneAgentAskResult>(await ask({ ...ASK, state: 'Other.' }));

			// The first request was never written (the database was closed), and it is still counted once.
			expect(second.budget.spentTodayUsd).toBeCloseTo(first.costUsd + second.costUsd, 12);
		});

		it('starts again at local midnight', async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET } });
			answered(await ask());
			expect(refusedBy(await ask({ ...ASK, state: 'Other.' })).code).toBe('budget');

			nowMs += DAY_MS;

			const tomorrow = answered<SystemOneAgentAskResult>(await ask({ ...ASK, state: 'Other.' }));
			expect(tomorrow.budget.spentTodayUsd).toBeCloseTo(tomorrow.costUsd, 12);
			const midnight = new Date(nowMs);
			midnight.setHours(0, 0, 0, 0);
			expect(tomorrow.budget.dayStartedAt).toBe(midnight.getTime());
		});

		it("does not count a task's own run against the agents' budget", async () => {
			await jevReady();
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: 0.01 } });
			const { insertSystemOneDecision } = await import('../../../../main/stats/s1-decisions');
			insertSystemOneDecision(ledger.db as Database.Database, {
				taskId: 'cue-gate',
				engine: 'jev-cloud',
				questionIds: ['proceed'],
				outcome: 'ok',
				startedAt: nowMs,
				latencyMs: 200,
				costUsd: 5,
				agentId: 'agent-1',
			});

			const result = answered<SystemOneAgentAskResult>(await ask());

			expect(result.budget.spentTodayUsd).toBeCloseTo(result.costUsd, 12);
		});

		it('stops a long job when the money runs out, and says how far it got', async () => {
			const jev = await jevReady({ answer: byCandidate });
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: ONE_REQUEST_BUDGET } });
			const count = SYSTEM_ONE_AGENT_MAX_QUESTIONS * 10;

			const result = answered<SystemOneAgentRankResult>(
				await runAgentSystemOneRequest(
					{ kind: 'rank', query: 'a security fix', candidates: commits(count) },
					AGENT
				)
			);

			// The requests in flight when the budget was reached finish; no more are sent.
			expect(jev.requests.length).toBeGreaterThanOrEqual(1);
			expect(jev.requests.length).toBeLessThan(10);
			expect(result.completeness.complete).toBe(false);
			expect(result.completeness.judged).toBe(jev.requests.length * SYSTEM_ONE_AGENT_MAX_QUESTIONS);
			expect(result.completeness.skippedRequests).toBe(10 - jev.requests.length);
			expect(result.completeness.failedRequests).toBe(0);
			expect(result.completeness.errors[0]).toMatchObject({ code: 'budget' });
			expect(result.completeness.marker).toContain("System One's budget for today is spent");
			expect(result.unjudged).toHaveLength(count - result.completeness.judged);
		});
	});

	describe('pacing', () => {
		it('spaces the requests a job sends, and waits for nothing else', async () => {
			await jevReady({ answer: byCandidate });
			const candidates = commits(SYSTEM_ONE_AGENT_MAX_QUESTIONS * 3);

			answered(await ask());
			expect(sleep).not.toHaveBeenCalled();

			answered(await runAgentSystemOneRequest({ kind: 'rank', query: 'q', candidates }, AGENT));
			// The first request of a job goes at once; each one after it waits its turn.
			expect(sleep.mock.calls).toEqual([
				[SYSTEM_ONE_AGENT_REQUEST_SPACING_MS],
				[SYSTEM_ONE_AGENT_REQUEST_SPACING_MS * 2],
			]);

			sleep.mockClear();
			answered(await runAgentSystemOneRequest({ kind: 'rank', query: 'q', candidates }, AGENT));
			// All cached: nothing is sent, so nothing waits.
			expect(sleep).not.toHaveBeenCalled();
		});
	});

	describe('getSystemOneAgentAccess', () => {
		it('says an agent would be answered, by which engine, and what is left today', async () => {
			await jevReady();
			const { costUsd } = answered<SystemOneAgentAskResult>(await ask());

			const access = await getSystemOneAgentAccess('agent-1');

			expect(access).toMatchObject({
				allowed: true,
				gate: null,
				message: null,
				reason: null,
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
				calibrated: true,
			});
			expect(access.budget.spentTodayUsd).toBeCloseTo(costUsd, 12);
			expect(access.budget.remainingTodayUsd).toBeCloseTo(1 - costUsd, 12);
			expect(access.budget.agent).toMatchObject({ agentId: 'agent-1', budgetUsd: null });
		});

		it('names the switch that would refuse, and asks the engine nothing to find out', async () => {
			expect(await getSystemOneAgentAccess()).toMatchObject({
				allowed: false,
				gate: 'engine-off',
				engine: 'off',
				calibrated: null,
			});

			const jev = await jevReady();
			sessions = [{ id: 'agent-1', systemOneOptOut: true }];
			expect(await getSystemOneAgentAccess('agent-1')).toMatchObject({
				allowed: false,
				gate: 'agent-opted-out',
			});
			expect((await getSystemOneAgentAccess('agent-2')).allowed).toBe(true);
			expect((await getSystemOneAgentAccess()).allowed).toBe(true);

			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: 0 } });
			const spent = await getSystemOneAgentAccess('agent-2');
			expect(spent).toMatchObject({ allowed: false, gate: 'budget-day' });
			expect(spent.message).toContain('budget for today is spent');
			// A settings surface shows the same sentence without the instruction to the agent.
			expect(spent.reason).toContain('budget for today is spent');
			expect(spent.reason).not.toContain(SYSTEM_ONE_CONTINUE_WITHOUT);
			expect(spent.message).toBe(`${spent.reason} ${SYSTEM_ONE_CONTINUE_WITHOUT}`);
			expect(jev.requests).toHaveLength(0);
		});

		it('says a local judge is not calibrated', async () => {
			await judgeReady();

			const access = await getSystemOneAgentAccess('agent-1');

			expect(access).toMatchObject({ allowed: true, engine: 'local-judge', calibrated: false });
			expect(access.engineLabel).toContain('not calibrated');
		});

		it('reads an agent id as a surface sends it, and anything else as no agent named', async () => {
			await jevReady();
			sessions = [{ id: 'agent-1', systemOneOptOut: true }];

			expect((await getSystemOneAgentAccessRequest('agent-1')).gate).toBe('agent-opted-out');
			for (const junk of [undefined, null, 7, { id: 'agent-1' }, ['agent-1']]) {
				const access = await getSystemOneAgentAccessRequest(junk);
				expect(access.allowed, String(junk)).toBe(true);
				expect(access.budget.agent, String(junk)).toBeUndefined();
			}
		});

		// The system prompt builders gate the System One section on this answer
		// (`coreSystemPromptSectionsFor`). One agent, one switch at a time.
		it('is what the system prompt section follows: there only while every switch passes', async () => {
			const section = async (agentId = 'agent-1', isSsh = false) =>
				coreSystemPromptSectionsFor({
					isSsh,
					systemOne: await getSystemOneAgentAccessRequest(agentId),
				}).map((ref) => ref.promptId);
			const told = ['system-one-system'];

			// No engine chosen.
			expect(await section()).toEqual([]);

			// Chosen, with no key: not set up.
			server = await startMockJevServer({ apiKey: KEY });
			shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = server.baseUrl;
			await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
			expect((await getSystemOneAgentAccess('agent-1')).gate).toBe('engine-not-ready');
			expect(await section()).toEqual([]);

			// Set up, not tested.
			await setSystemOneKeyRequest({ engine: 'jev-cloud', key: KEY });
			expect((await getSystemOneAgentAccess('agent-1')).gate).toBe('engine-untested');
			expect(await section()).toEqual([]);

			// Tested: every gate passes.
			expect((await testSystemOne()).ok).toBe(true);
			expect(await section()).toEqual(told);
			// Never for an SSH remote agent, whose shell cannot reach this desktop.
			expect(await section('agent-1', true)).toEqual([]);

			// "Let agents use System One" off, then on again: the next spawn follows.
			await updateSystemOneSettingsRequest({ agents: { enabled: false } });
			expect(await section()).toEqual([]);
			await updateSystemOneSettingsRequest({ agents: { enabled: true } });
			expect(await section()).toEqual(told);

			// This agent switched off in its own settings; another agent is not.
			sessions = [{ id: 'agent-1', systemOneOptOut: true }];
			expect(await section()).toEqual([]);
			expect(await section('agent-2')).toEqual(told);
			sessions = [];

			// The day's budget spent.
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: 0 } });
			expect(await section()).toEqual([]);
			await updateSystemOneSettingsRequest({ agents: { dailyBudgetUsd: 1 } });
			expect(await section()).toEqual(told);

			// The engine switched off.
			await updateSystemOneSettingsRequest({ engine: 'off' });
			expect(await section()).toEqual([]);

			// Deciding all of that asked the engine nothing but its one Test.
			expect(server.requests).toHaveLength(1);
		});
	});

	describe('readSystemOneAgentUsage', () => {
		it("reports each agent's requests by name, highest spend first, with the total and today's budget", async () => {
			const jev = await jevReady();
			sessions = [{ id: 'agent-1', name: 'acappella' }, { id: 'agent-2' }];
			const first = answered<SystemOneAgentAskResult>(await ask(ASK, AGENT));
			// The same request again: answered from the cache, so nothing is sent for it.
			answered(await ask(ASK, AGENT));
			const second = answered<SystemOneAgentAskResult>(
				await ask({ ...ASK, state: 'Another deploy went out clean.' }, AGENT)
			);
			answered(await ask({ ...ASK, state: 'A third thing happened.' }, { agentId: 'agent-2' }));
			answered(await ask({ ...ASK, state: 'Typed by a person.' }, NOBODY));
			jev.requests.length = 0;

			const report = await readSystemOneAgentUsage(undefined, 'agent-1');

			const [top, ...rest] = report.rows.map((row) => [row.agentId, row.agentName, row.requests]);
			expect(top).toEqual(['agent-1', 'acappella', 3]);
			// An agent with no name of its own, and requests that named nobody.
			expect(rest).toHaveLength(2);
			expect(rest).toEqual(
				expect.arrayContaining([
					['agent-2', null, 1],
					[null, null, 1],
				])
			);
			expect(report.rows[0]).toMatchObject({ cachedRequests: 1 });
			expect(report.rows[0].tokensIn).toBe(first.tokens.inputTokens + second.tokens.inputTokens);
			expect(report.rows[0].costUsd).toBeCloseTo(first.costUsd + second.costUsd, 12);
			expect(report.totals).toMatchObject({ requests: 5, cachedRequests: 1 });
			expect(report.totals.costUsd).toBeCloseTo(
				report.rows.reduce((sum, row) => sum + row.costUsd, 0),
				12
			);
			expect(report).toMatchObject({
				retentionDays: 30,
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
				notice: null,
			});
			expect(report.since).toBe(nowMs - 30 * DAY_MS);
			expect(report.budget.spentTodayUsd).toBeCloseTo(report.totals.costUsd, 12);
			expect(report.budget.agent).toMatchObject({ agentId: 'agent-1' });
			// A read: nothing is asked of the engine to answer it.
			expect(jev.requests).toHaveLength(0);
		});

		it('narrows to one agent, and to a start time', async () => {
			await jevReady();
			answered(await ask(ASK, AGENT));
			answered(await ask({ ...ASK, state: 'From the other agent.' }, { agentId: 'agent-2' }));

			const one = await readSystemOneAgentUsage({ agentId: 'agent-2' });
			expect(one.rows.map((row) => row.agentId)).toEqual(['agent-2']);
			expect(one.totals.requests).toBe(1);
			// The budget beside it is that agent's own.
			expect(one.budget.agent).toMatchObject({ agentId: 'agent-2' });

			const later = await readSystemOneAgentUsage({ since: nowMs + 60_000 });
			expect(later.rows).toEqual([]);
			expect(later.since).toBe(nowMs + 60_000);
			expect(later.totals).toMatchObject({ requests: 0, costUsd: 0 });
		});

		it('never reads past what the ledger keeps, whatever the query asks for', async () => {
			await jevReady();
			const report = await readSystemOneAgentUsage({ since: 0 });
			expect(report.since).toBe(nowMs - 30 * DAY_MS);
		});

		it("does not count a task's own run as an agent's request", async () => {
			await jevReady();
			const { insertSystemOneDecision } = await import('../../../../main/stats/s1-decisions');
			insertSystemOneDecision(ledger.db as Database.Database, {
				taskId: 'cue-gate',
				engine: 'jev-cloud',
				questionIds: ['proceed'],
				outcome: 'ok',
				startedAt: nowMs - 1000,
				latencyMs: 200,
				costUsd: 5,
				agentId: 'agent-1',
			});

			const report = await readSystemOneAgentUsage(undefined);
			expect(report.rows).toEqual([]);
		});

		it('says why the rows may be short: statistics off, or the database not open', async () => {
			await jevReady();
			answered(await ask());

			settings.set('statsCollectionEnabled', false);
			const off = await readSystemOneAgentUsage(undefined);
			expect(off.notice).toBe(SYSTEM_ONE_LEDGER_STATS_OFF_NOTICE);
			expect(off.rows).toHaveLength(1);

			ledger.ready = false;
			const closed = await readSystemOneAgentUsage(undefined);
			expect(closed.notice).toBe(SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE);
			expect(closed.rows).toEqual([]);
			// The day's count is kept in the process, so the budget is still reported.
			expect(closed.budget.spentTodayUsd).toBeGreaterThan(0);
		});

		it('reports with no engine chosen, and refuses a query it cannot read', async () => {
			expect(await readSystemOneAgentUsage(undefined)).toMatchObject({
				engine: 'off',
				rows: [],
				totals: { requests: 0 },
			});
			await expect(readSystemOneAgentUsage({ since: 'yesterday' })).rejects.toThrow(
				'since is a time in epoch milliseconds.'
			);
			await expect(readSystemOneAgentUsage({ agentId: '' })).rejects.toThrow(
				'Name the agent by its id.'
			);
		});
	});
});

/** A local judge with a model, while another engine is the one in force. */
async function judgeAssignedButNotInForce(): Promise<void> {
	settings.set('localModelAssignments', {
		[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
	});
	generate.generateText.mockResolvedValue({ text: '{}', json: {}, durationMs: 1 });
}

function questionsOf(request: {
	body: Record<string, unknown> | null;
}): Record<string, { instructions: { candidate: unknown } }> {
	return (request.body?.questions ?? {}) as Record<
		string,
		{ instructions: { candidate: unknown } }
	>;
}
