/**
 * Tests for cue-shell-executor.
 *
 * Verifies that subscriptions with `action: command` + `command.mode: 'shell'`
 * spawn through `shell: true` (PATH-aware), in the owning session's project
 * root, with template substitution, captured stdout/stderr/exitCode, and
 * timeout enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Keep the ssh-spawn-wrapper inert in this suite; the tests exercise the local
// code path only (no SSH config provided). Mocking here avoids pulling in the
// transitive ssh-command-builder → execFile chain, which would try to wrap
// the mocked `child_process` and break at module load.
vi.mock('../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: vi.fn(),
}));

class MockChildProcess extends EventEmitter {
	pid = 54321;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(_signal?: string) {
		this.killed = true;
		return true;
	}

	constructor() {
		super();
		(this.stdout as any).setEncoding = vi.fn();
		(this.stderr as any).setEncoding = vi.fn();
	}
}

let mockChild: MockChildProcess;
const mockSpawn = vi.fn((..._args: unknown[]) => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
		},
	};
});

import { executeCueShell, stopCueShellRun } from '../../../main/cue/cue-shell-executor';

function createSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
	};
}

function createEvent(): CueEvent {
	return {
		id: 'evt-1',
		type: 'time.heartbeat',
		timestamp: '2026-04-16T10:00:00.000Z',
		triggerName: 'shell-test',
		payload: {},
	};
}

function createSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'shell-test',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'echo hello',
		action: 'command',
		command: { mode: 'shell', shell: 'echo hello' },
		...overrides,
	};
}

function createConfig(overrides: Record<string, unknown> = {}) {
	const templateContext: TemplateContext = {
		session: {
			id: 'session-1',
			name: 'Test Session',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		},
	};
	return {
		runId: 'run-1',
		session: createSession(),
		subscription: createSubscription(),
		event: createEvent(),
		shellCommand: 'echo hello',
		projectRoot: '/projects/test',
		templateContext,
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

describe('cue-shell-executor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('spawns the command through the shell so PATH is honored', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const call = mockSpawn.mock.calls[0];
		expect(call[0]).toBe('echo hello');
		expect(call[1]).toEqual([]);
		const opts = call[2] as Record<string, unknown>;
		expect(opts.shell).toBe(true);
		expect(opts.cwd).toBe('/projects/test');
		const env = opts.env as Record<string, string>;
		expect(env.PATH).toBe(process.env.PATH);
		expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

		mockChild.emit('close', 0);
		await promise;
	});

	it('captures stdout, stderr, and exit code on success', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		mockChild.stdout.emit('data', 'line one\n');
		mockChild.stdout.emit('data', 'line two\n');
		mockChild.stderr.emit('data', 'a warning\n');
		mockChild.emit('close', 0);

		const result = await promise;
		expect(result.status).toBe('completed');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('line one\nline two\n');
		expect(result.stderr).toBe('a warning\n');
		expect(result.subscriptionName).toBe('shell-test');
	});

	it('substitutes Cue template variables in the command before spawning', async () => {
		const config = createConfig({
			shellCommand: 'echo {{CUE_RUN_ID}} from {{CUE_TRIGGER_NAME}}',
		});
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		const cmd = mockSpawn.mock.calls[0][0] as string;
		expect(cmd).toContain('echo run-1 from shell-test');

		mockChild.emit('close', 0);
		await promise;
	});

	it('returns a failed result without spawning when the command is empty', async () => {
		const config = createConfig({ shellCommand: '   ' });
		const result = await executeCueShell(config as any);
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.stderr).toMatch(/no shell command/i);
	});

	it('kills the process and reports timeout when it exceeds timeoutMs', async () => {
		const config = createConfig({ timeoutMs: 1000 });
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(1000);
		expect(mockChild.killed).toBe(true);

		mockChild.emit('close', null);
		const result = await promise;
		expect(result.status).toBe('timeout');
	});

	it('stopCueShellRun signals an active process and returns true', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		const stopped = stopCueShellRun('run-1');
		expect(stopped).toBe(true);
		expect(mockChild.killed).toBe(true);

		mockChild.emit('close', null);
		await promise;
	});

	it('stopCueShellRun returns false for unknown runId', () => {
		expect(stopCueShellRun('does-not-exist')).toBe(false);
	});

	it('reports failed status when spawn throws synchronously', async () => {
		mockSpawn.mockImplementationOnce(() => {
			throw new Error('command not found');
		});
		const config = createConfig();
		const result = await executeCueShell(config as any);
		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('command not found');
		expect(mockCaptureException).toHaveBeenCalled();
	});
});
