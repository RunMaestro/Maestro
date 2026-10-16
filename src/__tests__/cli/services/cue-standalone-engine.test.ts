/**
 * Standalone Cue engine wiring (`src/cli/services/cue-standalone-engine.ts`).
 *
 * The desktop registers every provider's output parser at boot; the standalone
 * runner has to do it itself, or every prompt run is recorded as raw
 * stream-json with no provider session id and no usage.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CueEvent, CueRunResult } from '../../../shared/cue/contracts';

const initializeOutputParsers = vi.fn();
const executeCuePrompt = vi.fn();
const stopCueRun = vi.fn(() => true);
/** The Cue process registry, as `getActiveProcesses()` hands it out. */
const activeProcesses = new Map<string, { child: EventEmitter }>();
/** The stored agent, which a test may repoint. */
const agent: Record<string, unknown> = {};
const providerCustomPath = vi.fn((): string | undefined => undefined);
// Hoisted: the engine imports this module statically, so its mock is built before this file's body runs.
const { prepareMaestroSystemPromptCli } = vi.hoisted(() => ({
	prepareMaestroSystemPromptCli: vi.fn(async (_session: unknown) => 'MAESTRO SYSTEM PROMPT'),
}));

vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers }));
vi.mock('../../../main/cue/cue-executor', () => ({
	executeCuePrompt,
	stopCueRun,
	getActiveProcesses: () => activeProcesses,
}));
vi.mock('../../../main/cue/cue-shell-executor', () => ({
	executeCueShell: vi.fn(),
	stopCueShellRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	executeCueCli: vi.fn(),
	stopCueCliRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure: vi.fn(() => null) }));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{
			id: 'agent-1',
			name: 'alpha',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
			...agent,
		},
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => providerCustomPath(),
	readAgentConfig: () => ({}),
	readSettings: () => ({}),
}));
vi.mock('../../../cli/services/system-prompt', () => ({ prepareMaestroSystemPromptCli }));

import {
	AUTO_RUN_NEEDS_HOST,
	buildStandaloneCueEngineDeps,
	consoleCueLog,
	cueLogForFormat,
	jsonCueLog,
	stderrCueLog,
	waitForStandaloneCueProcesses,
	type StandaloneCueAutoRun,
	type StandaloneCueAutoRunEnd,
} from '../../../cli/services/cue-standalone-engine';

const event: CueEvent = {
	id: 'evt-1',
	type: 'webhook.received',
	timestamp: new Date().toISOString(),
	triggerName: 'ask',
	payload: {},
};

type CueRunRequest = Parameters<ReturnType<typeof buildStandaloneCueEngineDeps>['onCueRun']>[0];

/** A fired `action: autorun` subscription. */
function autoRunRequest(overrides: Partial<CueRunRequest> = {}): CueRunRequest {
	return {
		runId: 'run-auto',
		sessionId: 'agent-1',
		prompt: '/p/.maestro/playbooks/a.md',
		subscriptionName: 'nightly',
		event,
		timeoutMs: 1000,
		action: 'autorun',
		autoRun: { documents: ['/p/.maestro/playbooks/a.md'], reset_on_completion: [true] },
		...overrides,
	} as CueRunRequest;
}

describe('buildStandaloneCueEngineDeps', () => {
	beforeEach(() => {
		executeCuePrompt.mockReset();
		executeCuePrompt.mockResolvedValue({ status: 'completed' } as CueRunResult);
		for (const key of Object.keys(agent)) delete agent[key];
		providerCustomPath.mockReturnValue(undefined);
		prepareMaestroSystemPromptCli.mockClear();
		activeProcesses.clear();
	});

	it('registers the output parsers before the first prompt run executes', async () => {
		executeCuePrompt.mockImplementation(async () => {
			expect(initializeOutputParsers).toHaveBeenCalledTimes(1);
			return { status: 'completed' } as CueRunResult;
		});
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });

		await deps.onCueRun({
			runId: 'run-1',
			sessionId: 'agent-1',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(initializeOutputParsers).toHaveBeenCalledTimes(1);
	});

	// The desktop host resolves a subscription's tier / model / effort in
	// src/main/index.ts. This runner has its own onCueRun, so without the same
	// step a headless run silently used the agent's default model.
	it("spawns the prompt run on the subscription's model choice", async () => {
		executeCuePrompt.mockClear();
		const onLog = vi.fn();
		const deps = buildStandaloneCueEngineDeps({ onLog });

		await deps.onCueRun({
			runId: 'run-2',
			sessionId: 'agent-1',
			prompt: 'Review it',
			subscriptionName: 'deep-review',
			event,
			timeoutMs: 1000,
			turnSettings: { model: 'claude-pinned-model', effort: 'low' },
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(executeCuePrompt.mock.calls[0][0]).toMatchObject({ customModel: 'claude-pinned-model' });
		expect(executeCuePrompt.mock.calls[0][0].customEffort).toBeTruthy();
	});

	it("keeps the agent's own model when the subscription sets none", async () => {
		executeCuePrompt.mockClear();
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });

		await deps.onCueRun({
			runId: 'run-3',
			sessionId: 'agent-1',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt.mock.calls[0][0].customModel).toBeUndefined();
		expect(executeCuePrompt.mock.calls[0][0].customEffort).toBeUndefined();
	});

	describe('which binary a prompt run executes, and with what system prompt', () => {
		const run = async () => {
			const onLog = vi.fn();
			const deps = buildStandaloneCueEngineDeps({ onLog });
			await deps.onCueRun({
				runId: 'run-bin',
				sessionId: 'agent-1',
				prompt: 'Say pong',
				subscriptionName: 'ask',
				event,
				timeoutMs: 1000,
			} as CueRunRequest);
			return { config: executeCuePrompt.mock.calls[0][0], onLog };
		};

		it("runs the agent's own custom path before the provider's", async () => {
			// Any file that exists and can be executed stands in for a pinned binary.
			agent.customPath = process.execPath;
			providerCustomPath.mockReturnValue('/provider/claude');

			expect((await run()).config.customPath).toBe(process.execPath);
		});

		it("falls back to the provider's path, with a warning, when the agent's own is not runnable", async () => {
			agent.customPath = '/no/such/binary-for-this-agent';
			providerCustomPath.mockReturnValue('/provider/claude');

			const { config, onLog } = await run();
			expect(config.customPath).toBe('/provider/claude');
			expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('invalid custom path'));
		});

		it("uses the provider's path for an agent with none of its own, and PATH when there is neither", async () => {
			providerCustomPath.mockReturnValue('/provider/claude');
			expect((await run()).config.customPath).toBe('/provider/claude');

			executeCuePrompt.mockClear();
			providerCustomPath.mockReturnValue(undefined);
			expect((await run()).config.customPath).toBeUndefined();
		});

		it('carries the Maestro system prompt the CLI builds for the agent', async () => {
			const { config } = await run();
			expect(prepareMaestroSystemPromptCli).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'agent-1', toolType: 'claude-code' })
			);
			expect(config.appendSystemPrompt).toBe('MAESTRO SYSTEM PROMPT');
		});
	});

	describe('action: autorun', () => {
		it('fails loudly without a runtime, and never sends the documents as a prompt', async () => {
			const onLog = vi.fn();
			const deps = buildStandaloneCueEngineDeps({ onLog });

			const result = await deps.onCueRun(autoRunRequest());

			expect(executeCuePrompt).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.stderr).toContain(AUTO_RUN_NEEDS_HOST);
			expect(AUTO_RUN_NEEDS_HOST).toContain('maestro-cli host');
			expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('maestro-cli host'));
		});

		it('hands the run to the runner and ends when the Auto Run does', async () => {
			let finish!: (end: StandaloneCueAutoRunEnd) => void;
			const runAutoRun = vi.fn<StandaloneCueAutoRun>(async () => ({
				started: true,
				ended: new Promise<StandaloneCueAutoRunEnd>((resolve) => {
					finish = resolve;
				}),
			}));
			const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn(), runAutoRun });

			let settled = false;
			const running = deps.onCueRun(autoRunRequest()).then((result) => {
				settled = true;
				return result;
			});
			await vi.waitFor(() => expect(runAutoRun).toHaveBeenCalledTimes(1));
			expect(runAutoRun.mock.calls[0][0]).toMatchObject({
				sessionId: 'agent-1',
				documents: [{ filename: '/p/.maestro/playbooks/a.md', resetOnCompletion: true }],
			});
			// Accepted is not finished: the Cue run is still in flight.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(settled).toBe(false);

			finish({ ok: true });
			const result = await running;
			expect(result.status).toBe('completed');
			expect(result.stdout).toContain('Auto Run finished');
			expect(executeCuePrompt).not.toHaveBeenCalled();
		});

		it('records a run that ended badly as failed, with the reason', async () => {
			const onLog = vi.fn();
			const deps = buildStandaloneCueEngineDeps({
				onLog,
				runAutoRun: async () => ({
					started: true,
					ended: Promise.resolve({ ok: false, reason: 'the run ended while paused: rate limited' }),
				}),
			});

			const result = await deps.onCueRun(autoRunRequest());

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe('Auto Run failed: the run ended while paused: rate limited');
			expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('rate limited'));
		});

		it('records a refused launch, and a runner that throws, as failed with the reason', async () => {
			const refused = buildStandaloneCueEngineDeps({
				onLog: vi.fn(),
				runAutoRun: async () => ({ started: false, error: 'The agent is busy.' }),
			});
			const first = await refused.onCueRun(autoRunRequest());
			expect(first.status).toBe('failed');
			expect(first.stderr).toContain('The agent is busy.');

			const broken = buildStandaloneCueEngineDeps({
				onLog: vi.fn(),
				runAutoRun: async () => {
					throw new Error('runtime closed');
				},
			});
			const second = await broken.onCueRun(autoRunRequest());
			expect(second.status).toBe('failed');
			expect(second.stderr).toContain('runtime closed');
		});

		it('fails a run whose documents did not survive the queue', async () => {
			const runAutoRun = vi.fn<StandaloneCueAutoRun>();
			const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn(), runAutoRun });

			const result = await deps.onCueRun(autoRunRequest({ autoRun: undefined }));

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('no documents');
			expect(runAutoRun).not.toHaveBeenCalled();
		});

		it('stops the Auto Run when the Cue run is stopped', async () => {
			let signal: AbortSignal | undefined;
			const deps = buildStandaloneCueEngineDeps({
				onLog: vi.fn(),
				runAutoRun: async (_params, given) => {
					signal = given;
					return { started: true, ended: new Promise(() => undefined) };
				},
			});
			void deps.onCueRun(autoRunRequest({ runId: 'run-stop' }));
			await vi.waitFor(() => expect(signal).toBeDefined());

			expect(deps.onStopCueRun?.('run-stop')).toBe(true);
			expect(signal?.aborted).toBe(true);
			// It had no Cue child process, so the process registry was not asked.
			expect(stopCueRun).not.toHaveBeenCalledWith('run-stop');
		});
	});
});

describe('waitForStandaloneCueProcesses', () => {
	const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });

	it('waits for every stopped child to exit', async () => {
		const first = child();
		const second = child();
		activeProcesses.set('run-a', { child: first });
		activeProcesses.set('run-b', { child: second });

		let left: number | undefined;
		const waiting = waitForStandaloneCueProcesses(5_000).then((count) => {
			left = count;
		});
		Object.assign(first, { exitCode: 0 });
		first.emit('exit', 0, null);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(left).toBeUndefined();

		Object.assign(second, { signalCode: 'SIGTERM' });
		second.emit('exit', null, 'SIGTERM');
		await waiting;
		expect(left).toBe(0);
		activeProcesses.clear();
	});

	it('gives up after the wait and says how many are still alive', async () => {
		activeProcesses.set('run-c', { child: child() });
		expect(await waitForStandaloneCueProcesses(20)).toBe(1);
		activeProcesses.clear();
	});

	it('has nothing to wait for when no process is running', async () => {
		expect(await waitForStandaloneCueProcesses(5_000)).toBe(0);
	});
});

describe('a run stopped while the executors are still loading', () => {
	it.each([
		['prompt', {}],
		['shell command', { action: 'command', command: { mode: 'shell', shell: 'echo hi' } }],
		[
			'maestro-cli command',
			{ action: 'command', command: { mode: 'cli', cli: { command: 'send', target: 'x' } } },
		],
	] as const)('starts no %s run', async (_label, extra) => {
		vi.clearAllMocks();
		// A fresh module, so its executor load is the first and the test holds it open.
		vi.resetModules();
		let finishLoad!: () => void;
		initializeOutputParsers.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishLoad = resolve;
				})
		);
		const { buildStandaloneCueEngineDeps: build } =
			await import('../../../cli/services/cue-standalone-engine');
		const shell = await import('../../../main/cue/cue-shell-executor');
		const cli = await import('../../../main/cue/cue-cli-executor');
		const prompt = await import('../../../main/cue/cue-executor');
		const deps = build({ onLog: vi.fn() });
		const controller = new AbortController();

		const pending = deps.onCueRun({
			runId: 'run-1',
			sessionId: 'agent-1',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
			signal: controller.signal,
			...extra,
		} as Parameters<typeof deps.onCueRun>[0]);
		await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
		controller.abort();
		finishLoad();
		const result = await pending;

		expect(result.status).toBe('stopped');
		expect(prompt.executeCuePrompt).not.toHaveBeenCalled();
		expect(shell.executeCueShell).not.toHaveBeenCalled();
		expect(cli.executeCueCli).not.toHaveBeenCalled();
	});
});

describe('engine log sinks (--log-format)', () => {
	it('picks text by default, JSON on request, and the stderr-only text form under --json', () => {
		expect(cueLogForFormat(undefined)).toBe(consoleCueLog);
		expect(cueLogForFormat('text')).toBe(consoleCueLog);
		expect(cueLogForFormat('text', { stderrOnly: true })).toBe(stderrCueLog);
		expect(cueLogForFormat('json')).toBe(jsonCueLog);
		expect(cueLogForFormat('json', { stderrOnly: true })).toBe(jsonCueLog);
	});

	it('jsonCueLog writes one JSON line to stderr with the run ids and never stdout', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		jsonCueLog('cue', '[CUE] Run started: nightly', {
			type: 'runStarted',
			runId: 'run-9',
			sessionId: 'agent-1',
			subscriptionName: 'nightly',
			pipelineId: 'Build',
		});
		expect(stdout).not.toHaveBeenCalled();
		const written = String(stderr.mock.calls[0][0]);
		expect(written.endsWith('\n')).toBe(true);
		expect(JSON.parse(written)).toMatchObject({
			level: 'info',
			message: '[CUE] Run started: nightly',
			context: 'Cue',
			event: 'runStarted',
			runId: 'run-9',
			sessionId: 'agent-1',
			subscriptionName: 'nightly',
			pipelineId: 'Build',
		});
		expect(typeof JSON.parse(written).timestamp).toBe('string');
		stderr.mockRestore();
		stdout.mockRestore();
	});

	it('stderrCueLog keeps the text shape but never writes to stdout', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		stderrCueLog('info', 'Engine started');
		expect(log).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith('[Cue] Engine started');
		log.mockRestore();
		error.mockRestore();
	});
});
