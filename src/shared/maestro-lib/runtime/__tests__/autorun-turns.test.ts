/**
 * The Auto Run turn runner when the provider refuses the effort a turn asked for: it runs the turn
 * once more at the agent's own effort, as the CLI and the desktop do. Each turn is the real
 * `runAgentTurn` over the fake agent, replaying a refusal or an answer.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeStream } from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import {
	FAKE_AGENT_PATH,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { getEffortRejection, resetEffortRejections } from '../../../effortRejection';
import { resolveMaestroPaths } from '../../paths/resolve';
import type { AgentRecord } from '../../store/records';
import type { CompletedTurn } from '../../run/run-to-completion';
import type { AssembledTurn } from '../../turns/assemble';
import type { RunAgentTurnStart } from '../../turns/run-agent-turn';
import { runAgentTurn } from '../../turns/run-agent-turn';
import { createAutoRunTurnRunner } from '../autorun-turns';
import { createProcessRegistry } from '../processes';

const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

/** Codex's answer to a retired effort value, as the Responses API words it. */
const REFUSAL = JSON.stringify({
	type: 'error',
	status: 400,
	error: {
		message:
			"Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model. " +
			"Supported values are: 'low', 'medium', 'high'.",
		param: 'reasoning.effort',
	},
});

type Reply = 'refuse' | 'fail' | 'answer';

describe('Auto Run turns: a refused effort', () => {
	let dir: string;
	/** The effort each turn was assembled with, in order. */
	let efforts: Array<string | undefined>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-autorun-turns-'));
		efforts = [];
		resetEffortRejections();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function runner(replies: Reply[]) {
		const record = {
			id: 'a1',
			name: 'Alpha',
			toolType: 'claude-code',
			cwd: dir,
			projectRoot: dir,
		} as unknown as AgentRecord;
		return createAutoRunTurnRunner({
			agentId: 'a1',
			paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }),
			repository: { getAgent: () => record },
			registry: createProcessRegistry({ waitMs: 2_000 }),
			statsRecorder: { recordQuery: async () => ({ ok: true, id: 'q1' }) },
			host: { bundledPromptsDir: BUNDLED_PROMPTS },
			deps: {
				now: () => Date.now(),
				probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
				runAgentTurn: (turn: AssembledTurn, options) => {
					efforts.push(turn.settings.effort);
					const reply = replies.shift() ?? 'answer';
					const recording = writeFakeTurn(
						dir,
						reply === 'answer'
							? { chunks: claudeStream('Done.', 'sess-1'), close: { code: 0, signal: null } }
							: {
									chunks: [],
									stderr: reply === 'refuse' ? `${REFUSAL}\n` : 'something else broke\n',
									close: { code: 1, signal: null },
								}
					);
					return runAgentTurn(
						{
							...turn,
							launch: {
								...turn.launch,
								command: process.execPath,
								args: [FAKE_AGENT_PATH, ...turn.launch.args],
								sessionCustomEnvVars: {
									...turn.launch.sessionCustomEnvVars,
									FAKE_AGENT_RECORDING: recording,
								},
							},
						},
						{ ...options, stopGraceMs: 200 }
					);
				},
			},
			onStream: () => undefined,
		});
	}

	it('runs the turn once more without the effort, and notes the refusal', async () => {
		const result = await runner(['refuse', 'answer']).run({
			purpose: 'task',
			prompt: 'do the task',
			effort: 'minimal',
		});

		expect(efforts).toEqual(['minimal', undefined]);
		expect(result).toMatchObject({ success: true, response: 'Done.' });
		expect(getEffortRejection('claude-code', 'minimal')).toBeDefined();
	});

	it('does not retry a turn that sent no effort of its own', async () => {
		const result = await runner(['refuse']).run({ purpose: 'task', prompt: 'do the task' });

		expect(efforts).toEqual([undefined]);
		expect(result.success).toBe(false);
	});

	it('does not retry a failure that is not a refused effort', async () => {
		const result = await runner(['fail', 'answer']).run({
			purpose: 'task',
			prompt: 'do the task',
			effort: 'minimal',
		});

		expect(efforts).toEqual(['minimal']);
		expect(result.success).toBe(false);
	});

	/**
	 * A turn that RAN on Grok and was refused its effort keeps that failure. The request
	 * carries a bare effort string, never automatic-hint provenance or the selected model's menu, so
	 * there is no proven distinct fallback to retry on; the runner returns the first result with one
	 * process. Each attempt here is a synthetic run whose result is the refusal (the real Grok route
	 * needs a native peer), recording the assembled provider, model and effort it was handed.
	 */
	describe('a Grok turn refused its effort keeps the first failure', () => {
		const GROK_SESSION = 'grok-native-session-1';
		type Attempt = { provider: string; model: string | undefined; effort: string | undefined };
		let attempts: Attempt[];

		beforeEach(() => {
			attempts = [];
		});

		function refusedTurn(message: string, where: 'error' | 'stderr' = 'error'): CompletedTurn {
			return {
				outcome: 'crashed',
				answerText: undefined,
				sessionId: GROK_SESSION,
				usage: undefined,
				error:
					where === 'error'
						? ({
								type: 'unknown',
								message,
								recoverable: true,
								agentId: 'grok',
								timestamp: 0,
							} as CompletedTurn['error'])
						: undefined,
				exit: {
					exitCode: 1,
					signal: null,
					interrupted: false,
					stderrText: where === 'stderr' ? `${message}\n` : '',
					stdoutText: '',
					droppedOutputBytes: 0,
				},
			};
		}

		function syntheticRun(completed: CompletedTurn): RunAgentTurnStart {
			return {
				ok: true,
				run: {
					pid: 4242,
					events: (async function* () {})(),
					result: Promise.resolve(completed),
					interrupt: () => undefined,
					terminate: () => undefined,
					terminateNow: () => undefined,
					stopRequested: () => false,
				},
			};
		}

		/** A runner over an agent of `toolType` whose every attempt ends as `completed` says. */
		function syntheticRunner(
			toolType: string,
			completed: (attempt: number) => CompletedTurn,
			extra: { record?: Record<string, unknown>; onAttempt?: () => void } = {}
		) {
			const { record: recordFields, onAttempt } = extra;
			const record = {
				id: 'a1',
				name: 'Alpha',
				toolType,
				cwd: dir,
				projectRoot: dir,
				...recordFields,
			} as unknown as AgentRecord;
			return createAutoRunTurnRunner({
				agentId: 'a1',
				paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }),
				repository: { getAgent: () => record },
				registry: createProcessRegistry({ waitMs: 2_000 }),
				statsRecorder: { recordQuery: async () => ({ ok: true, id: 'q1' }) },
				host: { bundledPromptsDir: BUNDLED_PROMPTS },
				deps: {
					now: () => Date.now(),
					probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
					runAgentTurn: async (turn: AssembledTurn) => {
						attempts.push({
							provider: turn.settings.provider,
							model: turn.settings.model,
							effort: turn.settings.effort,
						});
						onAttempt?.();
						return syntheticRun(completed(attempts.length));
					},
				},
				onStream: () => undefined,
			});
		}

		const REFUSED_MAX =
			"--effort/--reasoning-effort: unknown effort level 'max'; use one of: low, high";

		it('an explicit effort refused by Grok returns the first error, outcome and session with one attempt', async () => {
			const result = await syntheticRunner('grok', () => refusedTurn(REFUSED_MAX)).run({
				purpose: 'task',
				prompt: 'do the task',
				model: 'grok-test-model',
				effort: 'max',
			});

			expect(attempts).toEqual([{ provider: 'grok', model: 'grok-test-model', effort: 'max' }]);
			expect(result).toMatchObject({
				success: false,
				outcome: 'crashed',
				error: REFUSED_MAX,
				agentSessionId: GROK_SESSION,
				agentError: { type: 'unknown', message: REFUSED_MAX },
			});
		});

		it('an uppercase refusal read from stderr alone, with no selectable menu, is not retried', async () => {
			const result = await syntheticRunner('grok', () =>
				refusedTurn(
					"--effort/--reasoning-effort: unknown effort level 'HIGH'; this model has no selectable effort levels",
					'stderr'
				)
			).run({ purpose: 'task', prompt: 'do the task', effort: 'HIGH' });

			expect(attempts).toHaveLength(1);
			expect(result.success).toBe(false);
			expect(result.agentSessionId).toBe(GROK_SESSION);
		});

		it('an effort equal to the agent own (inherited) value is not retried', async () => {
			const result = await syntheticRunner('grok', () => refusedTurn(REFUSED_MAX), {
				record: { customEffort: 'max', customModel: 'grok-configured' },
			}).run({ purpose: 'synopsis', prompt: 'summarize', effort: 'max' });

			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({ provider: 'grok', effort: 'max' });
			expect(result.success).toBe(false);
		});

		it('a distinct value on the refusal menu is a diagnostic, not a fallback: one attempt', async () => {
			const result = await syntheticRunner('grok', () =>
				refusedTurn("--effort/--reasoning-effort: unknown effort level 'minimal'; use one of: low")
			).run({ purpose: 'task', prompt: 'do the task', effort: 'minimal' });

			expect(attempts.map((attempt) => attempt.effort)).toEqual(['minimal']);
			expect(result.error).toContain("unknown effort level 'minimal'");
		});

		it('the same refusal on an ordinary provider still retries exactly once without the effort, keeping its model', async () => {
			const result = await syntheticRunner('codex', () => refusedTurn(REFUSED_MAX)).run({
				purpose: 'task',
				prompt: 'do the task',
				model: 'gpt-test',
				effort: 'max',
			});

			// The control: the synthetic refusal is one the runner recognizes, and the bound holds.
			expect(attempts).toEqual([
				{ provider: 'codex', model: 'gpt-test', effort: 'max' },
				{ provider: 'codex', model: 'gpt-test', effort: undefined },
			]);
			expect(result.success).toBe(false);
		});

		it('a run stopped meanwhile is never started again, on Grok or on an ordinary provider', async () => {
			for (const toolType of ['grok', 'claude-code']) {
				attempts = [];
				const controller = new AbortController();
				const result = await syntheticRunner(toolType, () => refusedTurn(REFUSED_MAX), {
					onAttempt: () => controller.abort(),
				}).run({
					purpose: 'task',
					prompt: 'do the task',
					effort: 'max',
					signal: controller.signal,
				});

				expect(attempts).toHaveLength(1);
				expect(result.success).toBe(false);
			}
		});
	});
});
