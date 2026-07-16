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
	isMacOS: vi.fn(() => false),
}));

import { LocalCommandRunner } from '../../../../main/process-manager/runners/LocalCommandRunner';

describe('LocalCommandRunner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolveShellPath.mockReturnValue('/bin/zsh');
		mockBuildInteractiveShellArgs.mockReturnValue(['-l', '-i', '-c', 'ls']);
		mockBuildExpandedPath.mockReturnValue('/usr/bin:/bin');
	});

	it('emits the exact recoverable PTY spawn error bytes and a failed exit', async () => {
		mockPtySpawn.mockImplementation(() => {
			throw new Error('permission denied');
		});

		const emitter = new EventEmitter();
		const runner = new LocalCommandRunner(emitter);
		const stderrEvents: Array<[string, string]> = [];
		const exitEvents: Array<[string, number]> = [];

		emitter.on('stderr', (sessionId: string, data: string) => {
			stderrEvents.push([sessionId, data]);
		});
		emitter.on('command-exit', (sessionId: string, code: number) => {
			exitEvents.push([sessionId, code]);
		});

		const result = await runner.run('session-1', 'ls', '/tmp');

		expect(result).toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual([['session-1', 'Error: permission denied']]);
		expect(exitEvents).toEqual([['session-1', 1]]);
	});

	it('keeps concurrent command streams and exits isolated by their session IDs', async () => {
		const ptyCallbacks: Array<{
			onData: (callback: (data: string) => void) => void;
			onExit: (callback: (event: { exitCode: number }) => void) => void;
			data?: (data: string) => void;
			exit?: (event: { exitCode: number }) => void;
		}> = [];
		mockPtySpawn.mockImplementation(() => {
			const callbacks: (typeof ptyCallbacks)[number] = {
				onData(callback) {
					callbacks.data = callback;
				},
				onExit(callback) {
					callbacks.exit = callback;
				},
			};
			ptyCallbacks.push(callbacks);
			return callbacks;
		});

		const emitter = new EventEmitter();
		const runner = new LocalCommandRunner(emitter);
		const streamEvents: Array<[string, string]> = [];
		const exitEvents: Array<[string, number]> = [];
		emitter.on('data', (sessionId: string, data: string) => streamEvents.push([sessionId, data]));
		emitter.on('command-exit', (sessionId: string, code: number) =>
			exitEvents.push([sessionId, code])
		);

		const first = runner.run('session-a', 'echo first', '/tmp');
		const second = runner.run('session-b', 'echo second', '/tmp');

		ptyCallbacks[1].data?.('second\n');
		ptyCallbacks[0].data?.('first\n');
		ptyCallbacks[1].exit?.({ exitCode: 2 });
		ptyCallbacks[0].exit?.({ exitCode: 0 });

		await expect(Promise.all([first, second])).resolves.toEqual([{ exitCode: 0 }, { exitCode: 2 }]);
		expect(streamEvents).toEqual([
			['session-b', 'second'],
			['session-a', 'first'],
		]);
		expect(exitEvents).toEqual([
			['session-b', 2],
			['session-a', 0],
		]);
	});
});
