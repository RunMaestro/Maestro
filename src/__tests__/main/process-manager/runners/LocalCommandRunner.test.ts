import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
		/** Minimal node-pty double whose exit is driven by the test. */
		function stubPty() {
			let exitHandler: ((e: { exitCode: number }) => void) | undefined;
			const kill = vi.fn(() => exitHandler?.({ exitCode: 143 }));
			mockPtySpawn.mockReturnValue({
				onData: vi.fn(),
				onExit: (cb: (e: { exitCode: number }) => void) => {
					exitHandler = cb;
				},
				kill,
			});
			return { kill };
		}

		it('kills an in-flight command and resolves the run', async () => {
			const { kill } = stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'tail -f log', '/tmp');
			expect(runner.cancel('session-1')).toBe(true);
			expect(kill).toHaveBeenCalledTimes(1);
			await expect(run).resolves.toEqual({ exitCode: 143 });
		});

		it('returns false when nothing is running under that id', () => {
			const runner = new LocalCommandRunner(new EventEmitter());
			expect(runner.cancel('session-nope')).toBe(false);
		});

		it('stops tracking a command once it exits', async () => {
			stubPty();
			const runner = new LocalCommandRunner(new EventEmitter());

			const run = runner.run('session-1', 'ls', '/tmp');
			runner.cancel('session-1');
			await run;

			expect(runner.cancel('session-1')).toBe(false);
		});
	});
});
