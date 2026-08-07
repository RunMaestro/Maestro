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
		 * Minimal node-pty double. Note it does NOT trigger exit from kill() -
		 * cancel no longer goes through ptyProcess.kill(), because its default
		 * signal is SIGHUP and the interactive login shell these commands run
		 * under survives that on macOS. The test drives exit explicitly instead.
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

		it('SIGTERMs the process group rather than SIGHUPing the shell', async () => {
			// The regression: SIGHUP (node-pty's default) left the shell alive, so
			// Stop appeared to do nothing. A negative pid targets the whole group,
			// which is what reaches the command and anything it spawned.
			const { ptyKill, exit } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			expect(runner.cancel('session-1')).toBe(true);

			expect(killSpy).toHaveBeenCalledWith(-PTY_PID, 'SIGTERM');
			expect(killSpy).not.toHaveBeenCalledWith(expect.anything(), 'SIGHUP');
			expect(ptyKill).not.toHaveBeenCalled();

			exit();
			await expect(run).resolves.toEqual({ exitCode: 143 });
		});

		it('reports the cancelled run through command-exit so the UI can settle', async () => {
			const { exit } = stubPty();
			const emitter = new EventEmitter();
			const exits: number[] = [];
			emitter.on('command-exit', (_sessionId: string, code: number) => exits.push(code));
			const runner = new LocalCommandRunner(emitter);

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			runner.cancel('session-1');
			exit(143);
			await run;

			expect(exits).toEqual([143]);
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

		it('does not SIGKILL after the process has already exited', async () => {
			// A late escalation against a recycled pid would kill an unrelated
			// process, so exiting must cancel the pending SIGKILL.
			vi.useFakeTimers();
			const { exit } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			runner.cancel('session-1');
			exit();
			await run;

			killSpy.mockClear();
			vi.advanceTimersByTime(10_000);

			expect(killSpy).not.toHaveBeenCalled();
			vi.useRealTimers();
		});
	});
});
