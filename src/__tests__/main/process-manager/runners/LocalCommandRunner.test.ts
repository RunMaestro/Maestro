import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPtySpawn, mockResolveShellPath, mockBuildInteractiveShellArgs, mockBuildExpandedPath } =
	vi.hoisted(() => ({
		mockPtySpawn: vi.fn(),
		mockResolveShellPath: vi.fn(),
		mockBuildInteractiveShellArgs: vi.fn(),
		mockBuildExpandedPath: vi.fn(),
	}));

vi.mock('node-pty', () => ({
	spawn: mockPtySpawn,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../../../main/process-manager/utils/pathResolver', () => ({
	resolveShellPath: mockResolveShellPath,
	buildInteractiveShellArgs: mockBuildInteractiveShellArgs,
	buildWrappedCommand: vi.fn(),
}));

vi.mock('../../../../shared/pathUtils', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../shared/pathUtils')>();
	return {
		...actual,
		buildExpandedPath: mockBuildExpandedPath,
	};
});

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

import { LocalCommandRunner } from '../../../../main/process-manager/runners/LocalCommandRunner';

describe('LocalCommandRunner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolveShellPath.mockReturnValue('/bin/zsh');
		mockBuildInteractiveShellArgs.mockReturnValue(['-l', '-i', '-c', 'ls']);
		mockBuildExpandedPath.mockReturnValue('/usr/bin:/bin');
	});

	it('resolves and emits stderr when PTY spawn throws', async () => {
		mockPtySpawn.mockImplementation(() => {
			throw new Error('permission denied');
		});

		const emitter = new EventEmitter();
		const runner = new LocalCommandRunner(emitter);
		const stderrEvents: string[] = [];
		const exitEvents: number[] = [];

		emitter.on('stderr', (_sessionId: string, data: string) => {
			stderrEvents.push(data);
		});
		emitter.on('command-exit', (_sessionId: string, code: number) => {
			exitEvents.push(code);
		});

		const result = await runner.run('session-1', 'ls', '/tmp');

		expect(result).toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual(['Error: permission denied']);
		expect(exitEvents).toEqual([1]);
	});

	describe('cancel', () => {
		const PTY_PID = 4242;

		/**
		 * Minimal node-pty double. `kill()` deliberately does NOT trigger exit, so
		 * a test can model the case that caused the hang: a command that never
		 * reports an exit at all. Tests drive exit explicitly when they want it.
		 */
		function stubPty() {
			let exitHandler: ((e: { exitCode: number }) => void) | undefined;
			const ptyKill = vi.fn();
			mockPtySpawn.mockReturnValue({
				pid: PTY_PID,
				onData: vi.fn(),
				onExit: (cb: (e: { exitCode: number }) => void) => {
					exitHandler = cb;
				},
				kill: ptyKill,
			});
			return { ptyKill, exit: (exitCode = 143) => exitHandler?.({ exitCode }) };
		}

		let killSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
		});

		afterEach(() => {
			killSpy.mockRestore();
		});

		it('SIGKILLs the tree immediately - no catchable signal, no grace period', async () => {
			// The regression: a catchable signal (SIGHUP, then SIGTERM) left the
			// shell alive and Stop appeared to do nothing.
			const { exit } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			expect(runner.cancel('session-1')).toBe(true);

			const signals = killSpy.mock.calls.map((c) => c[1]);
			expect(signals).toContain('SIGKILL');
			expect(signals).not.toContain('SIGTERM');
			expect(signals).not.toContain('SIGHUP');
			expect(signals).not.toContain('SIGINT');

			exit();
			await run;
		});

		it('settles the run synchronously, without waiting for the pty exit', async () => {
			// The hang: the pty never reported an exit for a job that survived, so
			// the card sat on "Stopping..." forever. SIGKILL cannot be ignored, so
			// there is nothing left to wait for.
			stubPty(); // deliberately never call exit()
			const emitter = new EventEmitter();
			const exits: number[] = [];
			emitter.on('command-exit', (_s: string, code: number) => exits.push(code));
			const runner = new LocalCommandRunner(emitter);

			const run = runner.run('session-1', 'top', '/tmp');
			runner.cancel('session-1');

			// No timers advanced, nothing awaited beyond the microtask queue.
			await expect(run).resolves.toEqual({ exitCode: 137 });
			expect(exits).toEqual([137]);
			// The run is no longer tracked, so a second Stop is a clean no-op.
			expect(runner.cancel('session-1')).toBe(false);
		});

		it('tears the pty down as well, releasing the slave fd', async () => {
			const { ptyKill } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'top', '/tmp');
			runner.cancel('session-1');

			expect(ptyKill).toHaveBeenCalledWith('SIGKILL');
			await run;
		});

		it('emits command-exit exactly once, even if the pty reports later', async () => {
			const { exit } = stubPty();
			const emitter = new EventEmitter();
			const exits: number[] = [];
			emitter.on('command-exit', (_sessionId: string, code: number) => exits.push(code));
			const runner = new LocalCommandRunner(emitter);

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			runner.cancel('session-1');
			exit(143); // the pty catching up afterwards must not double-report
			await run;

			expect(exits).toEqual([137]);
		});

		it('returns false when nothing is running under that id', () => {
			const runner = new LocalCommandRunner(new EventEmitter());
			expect(runner.cancel('session-nope')).toBe(false);
		});

		it('stops tracking a command once it exits', async () => {
			const { exit } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'ls', '/tmp');
			runner.cancel('session-1');
			exit();
			await run;

			expect(runner.cancel('session-1')).toBe(false);
		});

		it('leaves no timer that could fire against a recycled pid', async () => {
			// The old escalation timer could land a late SIGKILL on whatever pid the
			// OS had since handed out. Killing synchronously removes that class of
			// bug entirely - there is no deferred work at all.
			vi.useFakeTimers();
			const { exit } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			runner.cancel('session-1');
			exit();
			await run;

			killSpy.mockClear();
			vi.advanceTimersByTime(60_000);

			expect(killSpy).not.toHaveBeenCalled();
			vi.useRealTimers();
		});
	});
});
