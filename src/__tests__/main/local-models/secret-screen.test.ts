/**
 * @file secret-screen.test.ts
 * @description The secret screen every publishing path calls: the pattern scan
 * always runs, the `secret-screen` model is extra coverage only, and no state
 * of the model stack can hide a pattern finding or block a publish by itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/local-models/task-router', () => ({
	runClassifierTask: vi.fn(),
	runSystemOneTask: vi.fn(),
}));

const stores = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	configs: {} as Record<string, unknown>,
	sessions: [] as unknown[],
	ready: true,
}));

vi.mock('../../../main/stores/getters', () => {
	const guard = () => {
		if (!stores.ready) throw new Error('Stores not initialized. Call initializeStores() first.');
	};
	return {
		getSettingsStore: () => {
			guard();
			return { get: (key: string) => stores.settings[key] };
		},
		getAgentConfigsStore: () => {
			guard();
			return { get: () => stores.configs };
		},
		getSessionsStore: () => {
			guard();
			return { get: () => stores.sessions };
		},
	};
});

import {
	knownSecretEnv,
	screenForSecrets,
	SECRET_SCREEN_MODEL_TIMEOUT_MS,
} from '../../../main/local-models/secret-screen';
import { runClassifierTask, runSystemOneTask } from '../../../main/local-models/task-router';
import { logger } from '../../../main/utils/logger';
import { PROMPT_GUARD_2_22M_ID } from '../../../shared/local-models/model-catalog';
import { SECRET_SCREEN_QUESTION_ID } from '../../../shared/secretScan';

// Assembled at runtime so no token literal sits in the repository.
const GITHUB_TOKEN = ['ghp', 'a1B2c3D4e5'.repeat(4).slice(0, 36)].join('_');
const SLACK_TOKEN = ['xoxb', '1234567890', '0987654321', 'AbCdEfGhAbCdEfGhAbCdEfGh'].join('-');
const SOURCE = { type: 'local', modelId: PROMPT_GUARD_2_22M_ID } as const;

const modelOff = () => vi.mocked(runClassifierTask).mockResolvedValue({ status: 'off' });

describe('screenForSecrets', () => {
	beforeEach(() => {
		vi.mocked(runClassifierTask).mockReset();
		// Any assignment but System One: the classifier pass is the whole story.
		vi.mocked(runSystemOneTask).mockReset().mockResolvedValue({ status: 'not-assigned' });
		vi.mocked(logger.warn).mockReset();
		stores.settings = {};
		stores.configs = {};
		stores.sessions = [];
		stores.ready = true;
	});

	it('returns no findings for clean content', async () => {
		modelOff();
		expect(await screenForSecrets([{ source: 'notes.md', text: 'Nothing to see here.' }])).toEqual({
			findings: [],
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('scans every part and names the part each finding is in', async () => {
		modelOff();
		const result = await screenForSecrets([
			{ source: 'Summary', text: 'it broke' },
			{ source: 'Actual', text: `first\nit printed ${GITHUB_TOKEN}` },
			{ source: 'logs.json', text: `{\n  "line": "${SLACK_TOKEN}"\n}` },
		]);
		expect(result.findings.map((f) => [f.kind, f.source, f.line])).toEqual([
			['github-token', 'Actual', 2],
			['slack-token', 'logs.json', 2],
		]);
		expect(result.note).toBeUndefined();
	});

	it('logs kinds and counts, never a preview', async () => {
		modelOff();
		await screenForSecrets([{ text: GITHUB_TOKEN }]);
		const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
		expect(logged).toContain('github-token');
		expect(logged).not.toContain(GITHUB_TOKEN.slice(-4));
	});

	it('skips blank parts and does not ask the model about nothing', async () => {
		modelOff();
		expect(await screenForSecrets([{ source: 'description', text: '   ' }])).toEqual({
			findings: [],
		});
		expect(runClassifierTask).not.toHaveBeenCalled();
	});

	describe('the optional model pass', () => {
		it('asks the secret-screen task with all the text and a timeout', async () => {
			modelOff();
			await screenForSecrets([{ text: 'part one' }, { text: 'part two' }]);
			const [taskId, input] = vi.mocked(runClassifierTask).mock.calls[0];
			expect(taskId).toBe('secret-screen');
			expect(input.text).toBe('part one\n\npart two');
			expect(input.signal).toBeInstanceOf(AbortSignal);
			expect(SECRET_SCREEN_MODEL_TIMEOUT_MS).toBeGreaterThan(0);
		});

		it('adds a finding that names the model and its score when the model flags', async () => {
			vi.mocked(runClassifierTask).mockResolvedValue({
				status: 'ok',
				label: 'MALICIOUS',
				score: 0.974,
				flagged: true,
				chunks: 1,
				source: SOURCE,
				durationMs: 20,
			});
			const result = await screenForSecrets([{ text: 'plain words' }]);
			expect(result.findings).toEqual([
				{
					kind: 'model-flagged',
					line: 0,
					preview: 'MALICIOUS 0.97',
					name: 'Llama Prompt Guard 2 22M',
				},
			]);
		});

		it('adds nothing when the model does not flag', async () => {
			vi.mocked(runClassifierTask).mockResolvedValue({
				status: 'ok',
				label: 'BENIGN',
				score: 0.02,
				flagged: false,
				chunks: 1,
				source: SOURCE,
				durationMs: 20,
			});
			expect(await screenForSecrets([{ text: 'plain words' }])).toEqual({ findings: [] });
		});

		it('keeps the pattern findings beside a model finding', async () => {
			vi.mocked(runClassifierTask).mockResolvedValue({
				status: 'ok',
				label: 'MALICIOUS',
				score: 0.9,
				flagged: true,
				chunks: 2,
				source: SOURCE,
				durationMs: 20,
			});
			const result = await screenForSecrets([{ text: GITHUB_TOKEN }]);
			expect(result.findings.map((f) => f.kind)).toEqual(['github-token', 'model-flagged']);
		});

		// The model is extra coverage. A model that cannot run must neither block
		// a clean publish nor hide what the patterns found.
		it.each([
			[
				'unavailable',
				{
					status: 'unavailable',
					source: SOURCE,
					code: 'model-not-installed',
					reason: 'Not installed.',
				},
				'Not installed.',
			],
			['timed out', { status: 'cancelled', source: SOURCE }, 'it took too long to answer.'],
		])(
			'reports a note and still returns pattern findings when the model is %s',
			async (_n, verdict, reason) => {
				vi.mocked(runClassifierTask).mockResolvedValue(verdict as never);

				const clean = await screenForSecrets([{ text: 'plain words' }]);
				expect(clean.findings).toEqual([]);
				expect(clean.note).toBe(
					`Secret screen model did not run: ${reason} Pattern detection still ran.`
				);

				const dirty = await screenForSecrets([{ text: GITHUB_TOKEN }]);
				expect(dirty.findings.map((f) => f.kind)).toEqual(['github-token']);
				expect(dirty.note).toContain('did not run');
			}
		);

		it('never throws when the model stack does', async () => {
			vi.mocked(runClassifierTask).mockRejectedValue(new Error('onnx exploded'));
			const result = await screenForSecrets([{ text: GITHUB_TOKEN }]);
			expect(result.findings.map((f) => f.kind)).toEqual(['github-token']);
			expect(result.note).toBe(
				'Secret screen model did not run: it failed to run. Pattern detection still ran.'
			);
		});
	});

	describe('the model pass on System One', () => {
		const JEV = 'Jev (TypeSafe cloud)';

		function answered(probability: number) {
			return {
				status: 'ok' as const,
				engine: 'jev-cloud' as const,
				engineLabel: JEV,
				model: 'jev-1.13.0',
				answers: { [SECRET_SCREEN_QUESTION_ID]: { type: 'noul' as const, probability } },
				usage: { inputTokens: 40, outputTokens: 1 },
				costUsd: 0.0000017,
				latencyMs: 210,
				calibrated: true,
				redacted: false,
			};
		}

		it('asks the engine about all the text, under the pass budget, and runs no classifier', async () => {
			vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.02));

			await screenForSecrets([{ text: 'part one' }, { text: 'part two' }]);

			expect(runSystemOneTask).toHaveBeenCalledTimes(1);
			const [taskId, input, options] = vi.mocked(runSystemOneTask).mock.calls[0];
			expect(taskId).toBe('secret-screen');
			expect(input).toEqual({ text: 'part one\n\npart two' });
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			expect(runClassifierTask).not.toHaveBeenCalled();
		});

		it('adds a finding that names the engine and its probability on a yes', async () => {
			vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.934));
			const result = await screenForSecrets([{ text: 'plain words' }]);
			expect(result).toEqual({
				findings: [{ kind: 'model-flagged', line: 0, preview: 'secret 0.93', name: JEV }],
			});
		});

		it('adds nothing on a no', async () => {
			vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.12));
			expect(await screenForSecrets([{ text: 'plain words' }])).toEqual({ findings: [] });
		});

		it('still runs the pattern scan, and keeps its findings beside the engine finding', async () => {
			vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.9));
			const result = await screenForSecrets([
				{ source: 'notes.md', text: `token ${GITHUB_TOKEN}` },
			]);
			expect(result.findings.map((finding) => finding.kind)).toEqual([
				'github-token',
				'model-flagged',
			]);
		});

		it('reports an engine with no answer as a note, whatever the status, and keeps the pattern result', async () => {
			for (const status of ['failed-open', 'failed-closed', 'unavailable'] as const) {
				vi.mocked(runSystemOneTask).mockResolvedValue({
					status,
					engine: 'jev-cloud',
					engineLabel: JEV,
					code: 'auth',
					reason: `${JEV} has no key.`,
				});
				const result = await screenForSecrets([{ text: `token ${GITHUB_TOKEN}` }]);
				expect(result.findings.map((finding) => finding.kind)).toEqual(['github-token']);
				expect(result.note).toBe(
					`Secret screen model did not run: ${JEV} has no key. Pattern detection still ran.`
				);
			}
			expect(runClassifierTask).not.toHaveBeenCalled();
		});

		it('reports a timeout and an unreadable answer as notes', async () => {
			vi.mocked(runSystemOneTask).mockResolvedValue({
				status: 'cancelled',
				engine: 'jev-cloud',
				engineLabel: JEV,
			});
			expect((await screenForSecrets([{ text: 'plain words' }])).note).toMatch(
				/Jev \(TypeSafe cloud\) took too long to answer/
			);

			vi.mocked(runSystemOneTask).mockResolvedValue({ ...answered(0.9), answers: {} });
			const result = await screenForSecrets([{ text: 'plain words' }]);
			expect(result.findings).toEqual([]);
			expect(result.note).toMatch(/did not answer its question/);
		});

		it('never throws when the engine does', async () => {
			vi.mocked(runSystemOneTask).mockRejectedValue(new Error('engine bug'));
			const result = await screenForSecrets([{ text: `token ${GITHUB_TOKEN}` }]);
			expect(result.findings.map((finding) => finding.kind)).toEqual(['github-token']);
			expect(result.note).toMatch(/it failed to run/);
		});
	});

	describe('configured environment values', () => {
		const value = 'correct-horse-battery-staple';

		it('matches a value passed as env', async () => {
			modelOff();
			const result = await screenForSecrets([{ text: `oops ${value}` }], {
				env: { DB_PASSWORD: value },
			});
			expect(result.findings).toEqual([
				expect.objectContaining({ kind: 'env-var-value', name: 'DB_PASSWORD' }),
			]);
		});

		it('matches values from every layer Maestro is configured with by default', async () => {
			modelOff();
			stores.settings = { shellEnvVars: { GLOBAL_API_TOKEN: 'global-layer-value-0001' } };
			stores.configs = {
				'claude-code': { customEnvVars: { PROVIDER_SECRET: 'provider-layer-value-0002' } },
				codex: {},
			};
			stores.sessions = [
				{ id: 'a', customEnvVars: { AGENT_PASSWORD: 'agent-layer-value-0003' } },
				{ id: 'b' },
			];
			const result = await screenForSecrets([
				{
					text: 'global-layer-value-0001\nprovider-layer-value-0002\nagent-layer-value-0003',
				},
			]);
			expect(result.findings.map((f) => f.name)).toEqual([
				'GLOBAL_API_TOKEN',
				'PROVIDER_SECRET',
				'AGENT_PASSWORD',
			]);
		});
	});
});

describe('knownSecretEnv', () => {
	const original = process.env.SECRET_SCREEN_TEST_TOKEN;

	beforeEach(() => {
		stores.settings = {};
		stores.configs = {};
		stores.sessions = [];
		stores.ready = true;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.SECRET_SCREEN_TEST_TOKEN;
		else process.env.SECRET_SCREEN_TEST_TOKEN = original;
	});

	it('includes the process environment', () => {
		process.env.SECRET_SCREEN_TEST_TOKEN = 'process-layer-value';
		expect(knownSecretEnv()).toContainEqual(['SECRET_SCREEN_TEST_TOKEN', 'process-layer-value']);
	});

	it('keeps two agents holding the same variable name as two entries', () => {
		stores.sessions = [
			{ customEnvVars: { ANTHROPIC_API_KEY: 'first-agent-key' } },
			{ customEnvVars: { ANTHROPIC_API_KEY: 'second-agent-key' } },
		];
		const entries = knownSecretEnv().filter(([name]) => name === 'ANTHROPIC_API_KEY');
		expect(entries.map(([, value]) => value)).toEqual(
			expect.arrayContaining(['first-agent-key', 'second-agent-key'])
		);
	});

	it('still answers from the process environment when the stores are not ready', () => {
		stores.ready = false;
		process.env.SECRET_SCREEN_TEST_TOKEN = 'process-layer-value';
		expect(knownSecretEnv()).toContainEqual(['SECRET_SCREEN_TEST_TOKEN', 'process-layer-value']);
	});
});
