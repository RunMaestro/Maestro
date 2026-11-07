/**
 * @file task-router-system-one.test.ts
 *
 * `runSystemOneTask`: a task assigned to System One, through the real System
 * One service against a loopback Jev server (`mockJevServer`) and the
 * in-process model mock. Every test runs in a temp data folder with an injected
 * environment and home folder, so none reads the developer's own key.
 *
 * Properties worth protecting:
 *
 *   - **Any other assignment is not its business.** It answers `not-assigned`,
 *     asks nothing and records nothing, so a caller's model path is unchanged.
 *   - **The task's own questions are what is asked**, of the engine in force.
 *   - **No answer applies the fail policy**: the task's default, the user's
 *     change of it, or the more specific rule a caller hands in. Nothing else
 *     is asked instead: not another engine, not a model.
 *   - **Assigned with no engine chosen is no answer too**, and sends nothing.
 *   - **Every run that reached System One is recorded with its outcome**, and a
 *     record that cannot be kept never fails the run.
 *   - **A model twin refuses a task assigned to System One** instead of
 *     treating it as the Utility Agent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const settings = vi.hoisted(() => new Map<string, unknown>());
const generate = vi.hoisted(() => ({ generateText: vi.fn() }));
const decisions = vi.hoisted(() => ({ recordSystemOneDecision: vi.fn() }));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));
// The ledger itself is real (`decisions.ts`); what it writes lands on this
// stand-in for the statistics database, which is where the tests read it back.
vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({
		isReady: () => true,
		recordLocalModelRun: vi.fn(() => 'id'),
		recordSystemOneDecision: decisions.recordSystemOneDecision,
		pruneSystemOneDecisions: vi.fn(() => 0),
	}),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));
vi.mock('../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/text-gen')>()),
	generateText: generate.generateText,
}));
vi.mock('../../../main/local-models/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import {
	configureSystemOne,
	resetSystemOneServiceForTests,
	updateSystemOneSettingsRequest,
} from '../../../main/local-models/system-one/service';
import { runLocalTask, runSystemOneTask } from '../../../main/local-models/task-router';
import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import { captureException } from '../../../main/utils/sentry';
import { CUE_GATE_QUESTION_ID } from '../../../shared/cue/gate';
import { QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';
import {
	TYPESAFE_API_KEY_ENV_VAR,
	TYPESAFE_BASE_URL_ENV_VAR,
} from '../../../shared/local-models/system-one-settings';
import { LOCAL_JUDGE_TASK_ID } from '../../../shared/local-models/tasks';
import {
	MOCK_JEV_VERSION,
	startMockJevServer,
	type MockJevServer,
} from '../../helpers/mockJevServer';

const KEY = 'sk-task-router-0123456789';
const SYSTEM_ONE = { type: 'system-one' } as const;
const INPUT = {
	condition: 'the comment reports a bug',
	event: {
		type: 'github.issue' as const,
		payload: { number: 7, title: 'Crash on save', comments: 'It crashes every time.' },
	},
};

let dir: string;
let home: string;
let shellEnv: Record<string, string>;
let server: MockJevServer | null;

const osSeal: SealProvider = {
	available: () => true,
	seal: (text) => Buffer.from(`os-sealed:${Buffer.from(text).toString('hex')}`),
	unseal: (blob) => Buffer.from(blob.toString().slice('os-sealed:'.length), 'hex').toString(),
};

beforeEach(async () => {
	settings.clear();
	generate.generateText.mockReset();
	decisions.recordSystemOneDecision.mockReset();
	vi.mocked(captureException).mockClear();
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-task-'));
	home = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-task-home-'));
	shellEnv = {};
	server = null;
	configureSystemOne({
		dataDir: () => dir,
		osSeal: () => osSeal,
		shellEnvVars: () => shellEnv,
		processEnv: () => ({}),
		homeDir: () => home,
	});
});

afterEach(async () => {
	resetSystemOneServiceForTests();
	await server?.close();
	await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(home, { recursive: true, force: true });
});

function assign(taskId: string, assignment: unknown): void {
	settings.set('localModelAssignments', {
		...(settings.get('localModelAssignments') as Record<string, unknown> | undefined),
		[taskId]: assignment,
	});
}

/** The Cue gate on System One, with the hosted engine pointed at the mock server. */
async function gateOnJev(options: { key?: boolean } = {}): Promise<MockJevServer> {
	server = await startMockJevServer({ apiKey: KEY });
	shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = server.baseUrl;
	if (options.key !== false) shellEnv[TYPESAFE_API_KEY_ENV_VAR] = KEY;
	assign('cue-gate', SYSTEM_ONE);
	await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
	return server;
}

function recorded(): Record<string, unknown> {
	expect(decisions.recordSystemOneDecision).toHaveBeenCalledTimes(1);
	return decisions.recordSystemOneDecision.mock.calls[0][0] as Record<string, unknown>;
}

describe('runSystemOneTask', () => {
	it('is not assigned on the default, on a model and on an endpoint: nothing is asked or recorded', async () => {
		const jev = await gateOnJev();
		for (const assignment of [
			{ type: 'off' },
			{ type: 'local', modelId: QWEN3_1_7B_ID },
			{ type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' },
		]) {
			assign('cue-gate', assignment);
			await expect(runSystemOneTask('cue-gate', INPUT)).resolves.toEqual({
				status: 'not-assigned',
			});
		}
		expect(jev.requests).toHaveLength(0);
		expect(generate.generateText).not.toHaveBeenCalled();
		expect(decisions.recordSystemOneDecision).not.toHaveBeenCalled();
	});

	it("asks the engine in force the task's own questions, and answers with who answered", async () => {
		const jev = await gateOnJev();

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({
			status: 'ok',
			engine: 'jev-cloud',
			engineLabel: 'Jev (TypeSafe cloud)',
			model: MOCK_JEV_VERSION,
			calibrated: true,
			answers: { [CUE_GATE_QUESTION_ID]: { type: 'noul', probability: 0.91 } },
		});
		expect(jev.requests).toHaveLength(1);
		const body = jev.requests[0].body as { state: string; questions: Record<string, unknown> };
		expect(body.state).toContain('Event type: github.issue');
		expect(body.state).toContain('"title":"Crash on save"');
		expect(Object.keys(body.questions)).toEqual([CUE_GATE_QUESTION_ID]);
		expect(body.questions[CUE_GATE_QUESTION_ID]).toMatchObject({
			type: 'noul',
			instructions: expect.stringContaining('the comment reports a bug'),
		});
	});

	it('records an answered run with its questions, answers, engine and cost, and no input text', async () => {
		await gateOnJev();
		const startedBefore = Date.now();

		const result = await runSystemOneTask('cue-gate', INPUT);

		const decision = recorded();
		expect(decision).toMatchObject({
			taskId: 'cue-gate',
			engine: 'jev-cloud',
			model: MOCK_JEV_VERSION,
			questionIds: [CUE_GATE_QUESTION_ID],
			outcome: 'ok',
			answers: { [CUE_GATE_QUESTION_ID]: { type: 'noul', probability: 0.91 } },
		});
		expect(decision.code).toBeUndefined();
		expect(decision.startedAt).toBeGreaterThanOrEqual(startedBefore);
		expect(result.status === 'ok' && decision.usage).toEqual(
			result.status === 'ok' ? result.usage : null
		);
		expect(JSON.stringify(decision)).not.toContain('Crash on save');
		expect(JSON.stringify(decision)).not.toContain('reports a bug');
		expect(decision).not.toHaveProperty('input');
		expect(decision).not.toHaveProperty('agentId');
	});

	it('records the agent the run was for, when the caller names one', async () => {
		await gateOnJev();

		await runSystemOneTask('cue-gate', INPUT, { agentId: 'agent-7' });

		expect(recorded().agentId).toBe('agent-7');
		expect(recorded()).not.toHaveProperty('tabId');
	});

	it('records the tab whose turn the run was for, when the caller names one', async () => {
		await gateOnJev();

		await runSystemOneTask('cue-gate', INPUT, { agentId: 'agent-7', tabId: 'tab-3' });

		expect(recorded()).toMatchObject({ agentId: 'agent-7', tabId: 'tab-3' });
	});

	it('keeps the redacted state and questions on the record only while Keep inputs is on', async () => {
		// Built at run time so no secret-shaped literal sits in the source.
		const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
		const input = {
			...INPUT,
			event: {
				...INPUT.event,
				payload: { ...INPUT.event.payload, comments: `It crashes. My key is ${secret}` },
			},
		};
		await gateOnJev();
		await updateSystemOneSettingsRequest({ keepInputs: true });

		await runSystemOneTask('cue-gate', input);

		const kept = recorded().input as string;
		expect(kept).toContain('Crash on save');
		expect(kept).toContain('the comment reports a bug');
		expect(kept).not.toContain(secret);
		expect(Object.keys(JSON.parse(kept))).toEqual(['state', 'questions']);

		decisions.recordSystemOneDecision.mockReset();
		await updateSystemOneSettingsRequest({ keepInputs: false });
		await runSystemOneTask('cue-gate', input);

		expect(recorded()).not.toHaveProperty('input');
	});

	it('keeps the input of a run that got no answer too, so a failed gate can be read', async () => {
		assign('cue-gate', SYSTEM_ONE);
		await updateSystemOneSettingsRequest({ keepInputs: true });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result.status).toBe('failed-open');
		expect(recorded()).toMatchObject({ engine: 'off', code: 'off' });
		expect(recorded().input).toContain('Crash on save');
	});

	it('fails open by default when the engine gives no answer, and asks nothing else', async () => {
		const jev = await gateOnJev();
		jev.replyOnce({ status: 503, body: { detail: 'overloaded' } });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({
			status: 'failed-open',
			engine: 'jev-cloud',
			engineLabel: 'Jev (TypeSafe cloud)',
			code: 'unavailable',
		});
		expect(result.status === 'failed-open' && result.reason).toContain('Jev (TypeSafe cloud)');
		// One attempt at the one engine. No model stands in for it.
		expect(jev.requests).toHaveLength(1);
		expect(generate.generateText).not.toHaveBeenCalled();
		expect(recorded()).toMatchObject({
			taskId: 'cue-gate',
			engine: 'jev-cloud',
			outcome: 'failed-open',
			code: 'unavailable',
			questionIds: [CUE_GATE_QUESTION_ID],
		});
		expect(recorded().answers).toBeUndefined();
	});

	it("fails closed once the user sets the task's fail policy to closed", async () => {
		const jev = await gateOnJev();
		await updateSystemOneSettingsRequest({ failPolicy: { taskId: 'cue-gate', policy: 'closed' } });
		jev.replyOnce({ status: 503, body: { detail: 'overloaded' } });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({ status: 'failed-closed', code: 'unavailable' });
		expect(recorded()).toMatchObject({ outcome: 'failed-closed' });
	});

	it("applies a caller's more specific rule in place of the task's, and records what happened", async () => {
		const jev = await gateOnJev();
		await updateSystemOneSettingsRequest({ failPolicy: { taskId: 'cue-gate', policy: 'closed' } });
		jev.replyOnce({ status: 503, body: { detail: 'overloaded' } });
		const opened = await runSystemOneTask('cue-gate', INPUT, { failPolicy: 'open' });
		expect(opened.status).toBe('failed-open');
		expect(recorded()).toMatchObject({ outcome: 'failed-open' });

		decisions.recordSystemOneDecision.mockReset();
		await updateSystemOneSettingsRequest({ failPolicy: { taskId: 'cue-gate', policy: 'default' } });
		jev.replyOnce({ status: 503, body: { detail: 'overloaded' } });
		const closed = await runSystemOneTask('cue-gate', INPUT, { failPolicy: 'closed' });
		expect(closed.status).toBe('failed-closed');
		expect(recorded()).toMatchObject({ outcome: 'failed-closed' });
	});

	it('has no answer, and sends nothing, when the task is assigned and no engine is chosen', async () => {
		const jev = await gateOnJev();
		await updateSystemOneSettingsRequest({ engine: 'off' });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({
			status: 'failed-open',
			engine: 'off',
			engineLabel: 'Off',
			code: 'off',
		});
		expect(result.status === 'failed-open' && result.reason).toBe(
			'Cue gate is assigned to System One, and System One is off. Choose an engine in Settings > Models > System One.'
		);
		expect(jev.requests).toHaveLength(0);
		expect(recorded()).toMatchObject({ engine: 'off', outcome: 'failed-open', code: 'off' });
	});

	it('has no answer, and sends nothing, when the engine has no key', async () => {
		const jev = await gateOnJev({ key: false });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({ status: 'failed-open', engine: 'jev-cloud', code: 'auth' });
		expect(jev.requests).toHaveLength(0);
	});

	it('reports an engine that runs past its budget as a timeout', async () => {
		const jev = await gateOnJev();
		await updateSystemOneSettingsRequest({ timeoutMs: 100 });
		jev.setDelayMs(600);

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({ status: 'failed-open', code: 'timeout' });
		expect(recorded()).toMatchObject({ outcome: 'failed-open', code: 'timeout' });
	});

	it("replaces the engine's stored budget for one request when the caller states its own", async () => {
		const jev = await gateOnJev();
		await updateSystemOneSettingsRequest({ timeoutMs: 100 });
		jev.setDelayMs(400);

		// Past the stored 100 ms, inside the caller's own budget: answered.
		await expect(runSystemOneTask('cue-gate', INPUT, { timeoutMs: 5_000 })).resolves.toMatchObject({
			status: 'ok',
		});
	});

	it('reports a caller abort as cancelled, which is not a failure of either policy', async () => {
		const jev = await gateOnJev();
		jev.setDelayMs(600);
		const controller = new AbortController();

		const pending = runSystemOneTask('cue-gate', INPUT, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);

		await expect(pending).resolves.toEqual({
			status: 'cancelled',
			engine: 'jev-cloud',
			engineLabel: 'Jev (TypeSafe cloud)',
		});
		expect(recorded()).toMatchObject({ outcome: 'cancelled', code: 'cancelled' });
	});

	it('asks the local judge when that is the engine, and says its answer is not calibrated', async () => {
		const jev = await gateOnJev();
		assign(LOCAL_JUDGE_TASK_ID, { type: 'local', modelId: QWEN3_1_7B_ID });
		generate.generateText.mockImplementation(async (request: { source: unknown }) => ({
			text: '{"answer":"no","confidence":0.9}',
			json: { answer: 'no', confidence: 0.9 },
			source: request.source,
			durationMs: 30,
			tokensIn: 60,
			tokensOut: 8,
		}));
		await updateSystemOneSettingsRequest({ engine: 'local-judge' });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({
			status: 'ok',
			engine: 'local-judge',
			calibrated: false,
			model: `local:${QWEN3_1_7B_ID}`,
		});
		expect(result.status === 'ok' && result.engineLabel).toContain('not calibrated');
		expect(result.status === 'ok' && result.answers[CUE_GATE_QUESTION_ID]).toMatchObject({
			type: 'noul',
		});
		// The hosted engine is still set up, and is not asked.
		expect(jev.requests).toHaveLength(0);
		expect(recorded()).toMatchObject({ engine: 'local-judge', outcome: 'ok' });
	});

	it('never asks Jev when the local judge is the engine and has no model', async () => {
		const jev = await gateOnJev();
		await updateSystemOneSettingsRequest({ engine: 'local-judge' });

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result).toMatchObject({
			status: 'failed-open',
			engine: 'local-judge',
			code: 'unavailable',
		});
		expect(jev.requests).toHaveLength(0);
		expect(generate.generateText).not.toHaveBeenCalled();
	});

	it('never lets a record that cannot be kept fail the run, and reports it', async () => {
		await gateOnJev();
		decisions.recordSystemOneDecision.mockImplementation(() => {
			throw new Error('disk full');
		});

		const result = await runSystemOneTask('cue-gate', INPUT);

		expect(result.status).toBe('ok');
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});

describe('a model twin and a task assigned to System One', () => {
	it('refuses the task by name instead of handing it to the Utility Agent path', async () => {
		await gateOnJev();

		await expect(runLocalTask('cue-gate', { prompt: 'Should this run?' })).rejects.toThrow(
			/Cue gate is assigned to System One.*takes no prompt/
		);
		expect(generate.generateText).not.toHaveBeenCalled();
		expect(decisions.recordSystemOneDecision).not.toHaveBeenCalled();
	});
});
