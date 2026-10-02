/**
 * Cue's agent run against a REAL process.
 *
 * `cue-process-lifecycle.test.ts` fakes the child and drives its events by
 * hand. This file lets a real process write the stream: the fake agent
 * replaying recorded provider turns. It covers what a fake child cannot, which
 * is that the run settles from what the process actually did.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	runProcess,
	stopProcess,
	getProcessList,
	getActiveProcessOutput,
	getActiveProcessMap,
	type ProcessRunOptions,
} from '../../../main/cue/cue-process-lifecycle';
import type { SpawnSpec } from '../../../main/cue/cue-spawn-builder';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../process-manager/recordings/captured';
import {
	createScratchDir,
	fakeAgentSpec,
	fakeTurnFromRecording,
	type FakeAgentOptions,
	type FakeTurn,
} from '../../shared/maestro-lib/run/fakeAgent';

const posixIt = it.skipIf(process.platform === 'win32');

let scratch: { dir: string; cleanup: () => void };
let runSequence = 0;

beforeAll(() => {
	scratch = createScratchDir('maestro-cue-run');
});

afterAll(() => {
	scratch.cleanup();
});

afterEach(() => {
	for (const entry of getActiveProcessMap().values()) entry.child.kill('SIGKILL');
	getActiveProcessMap().clear();
});

function spec(turn: FakeTurn, options: FakeAgentOptions = {}): SpawnSpec {
	const { command, args, cwd, env } = fakeAgentSpec(scratch.dir, turn, options);
	return { command, args, cwd, env: env as Record<string, string> };
}

function options(toolType: string, overrides: Partial<ProcessRunOptions> = {}): ProcessRunOptions {
	return { toolType, timeoutMs: 30_000, onLog: vi.fn(), ...overrides };
}

const nextRunId = (): string => `run-${++runSequence}`;

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('condition was not met in time');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('runProcess against a real process', () => {
	it('completes an OpenCode run with its answer, session id and usage', async () => {
		const recording = CAPTURED_RECORDINGS['captured-opencode-normal'];

		const result = await runProcess(
			nextRunId(),
			spec(fakeTurnFromRecording(recording)),
			options('opencode')
		);

		expect(result.status).toBe('completed');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('The capital of France is Paris.');
		expect(result.providerSessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
		expect(result.usage?.inputTokens).toBeGreaterThan(0);
	});

	it('completes a Claude Code run with its answer, session id and usage', async () => {
		const recording = CAPTURED_RECORDINGS['captured-claude-code-normal'];

		const result = await runProcess(
			nextRunId(),
			spec(fakeTurnFromRecording(recording)),
			options('claude-code')
		);

		expect(result.status).toBe('completed');
		expect(result.stdout).toBeTruthy();
		expect(result.providerSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		expect(result.usage?.outputTokens).toBeGreaterThan(0);
	});

	it('fails a run whose process exited non-zero with nothing captured', async () => {
		const result = await runProcess(
			nextRunId(),
			spec({ chunks: [], stderr: 'Error: not logged in\n', close: { code: 1, signal: null } }),
			options('opencode')
		);

		expect(result.status).toBe('failed');
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('not logged in');
	});

	it('reads an unterminated last line before it settles', async () => {
		const recording = CAPTURED_RECORDINGS['captured-opencode-normal'];
		const chunks = [...recording.chunks];
		chunks[chunks.length - 1] = chunks[chunks.length - 1].replace(/\n$/, '');

		const result = await runProcess(
			nextRunId(),
			spec({ chunks, close: { code: 0, signal: null } }),
			options('opencode')
		);

		expect(result.status).toBe('completed');
		expect(result.stdout).toBe('The capital of France is Paris.');
	});

	it('returns raw stdout for an agent whose output is not parsed', async () => {
		const result = await runProcess(
			nextRunId(),
			spec({ chunks: ['plain text\n', 'second line\n'], close: { code: 0, signal: null } }),
			options('terminal')
		);

		expect(result.status).toBe('completed');
		expect(result.stdout).toBe('plain text\nsecond line\n');
		expect(result.providerSessionId).toBeNull();
		expect(result.usage).toBeNull();
	});

	it('gives the process no stdin to wait on when the prompt is on the command line', async () => {
		const result = await runProcess(
			nextRunId(),
			spec(fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']), {
				stdinOut: `${scratch.dir}/cue-stdin-empty.txt`,
			}),
			options('opencode')
		);

		// The fake agent reads stdin to its end first, so finishing proves it
		// was not left holding an open pipe.
		expect(result.status).toBe('completed');
	});

	it('delivers a prompt the launch plan moved to stdin', async () => {
		const fs = await import('node:fs');
		const stdinOut = `${scratch.dir}/cue-stdin-prompt.txt`;

		const result = await runProcess(
			nextRunId(),
			spec(fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']), { stdinOut }),
			options('opencode', { stdinPrompt: 'What is the capital of France?' })
		);

		expect(result.status).toBe('completed');
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('What is the capital of France?');
	});

	it('reports a command that does not exist as a failed run', async () => {
		const result = await runProcess(
			nextRunId(),
			{
				command: `${scratch.dir}/no-such-agent`,
				args: [],
				cwd: scratch.dir,
				env: process.env as Record<string, string>,
			},
			options('opencode')
		);

		expect(result.status).toBe('failed');
		expect(result.exitCode).toBeNull();
		expect(result.stderr).toContain('Spawn error');
	});

	it('is listed and readable while it runs, and gone once it settles', async () => {
		const runId = nextRunId();
		const running = runProcess(
			runId,
			spec(fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']), { hold: true }),
			options('opencode')
		);
		await waitFor(() => (getActiveProcessOutput(runId)?.stdout ?? '').includes('Paris'));

		expect(getProcessList().map((entry) => entry.runId)).toContain(runId);

		expect(stopProcess(runId)).toBe(true);
		const result = await running;

		expect(result.status).toBe('stopped');
		expect(result.stdout).toBe('The capital of France is Paris.');
		expect(getProcessList().map((entry) => entry.runId)).not.toContain(runId);
	});

	it('times out a run that does not finish', async () => {
		const onLog = vi.fn();

		const result = await runProcess(
			nextRunId(),
			spec({ chunks: [], close: { code: 0, signal: null } }, { hold: true }),
			options('opencode', { timeoutMs: 300, onLog })
		);

		expect(result.status).toBe('timeout');
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('timed out after 300ms'));
	});

	posixIt('fails a run that a signal nobody sent cut short', async () => {
		const recording = CAPTURED_RECORDINGS['captured-opencode-normal'];

		const result = await runProcess(
			nextRunId(),
			spec({ chunks: recording.chunks, close: { code: null, signal: 'SIGKILL' } }),
			options('opencode')
		);

		expect(result.status).toBe('failed');
	});
});
