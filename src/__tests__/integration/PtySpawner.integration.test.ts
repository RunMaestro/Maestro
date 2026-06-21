import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';

const mocks = vi.hoisted(() => ({
	ptySpawn: vi.fn(),
	stripControlSequences: vi.fn((data: string) => data),
	buildPtyTerminalEnv: vi.fn(),
	buildChildProcessEnv: vi.fn(),
	collectMaestroEnvVars: vi.fn(),
	isWindows: vi.fn(),
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('node-pty', () => ({
	spawn: mocks.ptySpawn,
}));

vi.mock('../../main/utils/terminalFilter', () => ({
	stripControlSequences: mocks.stripControlSequences,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/process-manager/utils/envBuilder', () => ({
	buildPtyTerminalEnv: mocks.buildPtyTerminalEnv,
	buildChildProcessEnv: mocks.buildChildProcessEnv,
	collectMaestroEnvVars: mocks.collectMaestroEnvVars,
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
}));

import { PtySpawner } from '../../main/process-manager/spawners/PtySpawner';

type MockPty = {
	pid: number;
	onData: ReturnType<typeof vi.fn>;
	onExit: ReturnType<typeof vi.fn>;
	emitData: (data: string) => void;
	emitExit: (exitCode: number) => void;
};

function createMockPty(pid = 4321): MockPty {
	let dataHandler: ((data: string) => void) | undefined;
	let exitHandler: ((event: { exitCode: number }) => void) | undefined;

	return {
		pid,
		onData: vi.fn((handler: (data: string) => void) => {
			dataHandler = handler;
		}),
		onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
			exitHandler = handler;
		}),
		emitData(data: string) {
			dataHandler?.(data);
		},
		emitExit(exitCode: number) {
			exitHandler?.({ exitCode });
		},
	};
}

function createContext() {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};
	const spawner = new PtySpawner(processes, emitter, bufferManager as DataBufferManager);

	return { processes, emitter, bufferManager, spawner };
}

function createConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'session-1',
		toolType: 'terminal',
		cwd: '/workspace/project',
		command: 'claude',
		args: ['--print'],
		...overrides,
	};
}

describe('PtySpawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isWindows.mockReturnValue(false);
		mocks.buildPtyTerminalEnv.mockReturnValue({ PATH: '/terminal/bin', TERM: 'xterm-256color' });
		mocks.buildChildProcessEnv.mockReturnValue({ PATH: '/agent/bin', HOME: '/home/tester' });
		mocks.collectMaestroEnvVars.mockImplementation(
			(
				globalShellEnvVars?: Record<string, string>,
				customEnvVars?: Record<string, string>,
				isResuming?: boolean
			) => ({
				...(globalShellEnvVars || {}),
				...(customEnvVars || {}),
				...(isResuming ? { MAESTRO_SESSION_RESUMED: '1' } : {}),
			})
		);
		mocks.stripControlSequences.mockImplementation((data: string) => data);
		mocks.ptySpawn.mockReturnValue(createMockPty());
	});

	it('spawns a non-Windows terminal shell with login, interactive, and custom shell args', () => {
		const { processes, spawner } = createContext();

		const result = spawner.spawn(
			createConfig({
				shell: '/bin/zsh',
				shellArgs: '--rcfile "/tmp/my rc" \'--noprofile\'',
				shellEnvVars: { FOO: 'bar' },
			})
		);

		expect(result).toEqual({ pid: 4321, success: true });
		expect(mocks.buildPtyTerminalEnv).toHaveBeenCalledWith({ FOO: 'bar' });
		expect(mocks.ptySpawn).toHaveBeenCalledWith(
			'/bin/zsh',
			['-l', '-i', '--rcfile', '/tmp/my rc', '--noprofile'],
			{
				name: 'xterm-256color',
				cols: 100,
				rows: 30,
				cwd: '/workspace/project',
				env: { PATH: '/terminal/bin', TERM: 'xterm-256color' },
			}
		);
		expect(processes.get('session-1')).toMatchObject({
			sessionId: 'session-1',
			toolType: 'terminal',
			pid: 4321,
			isTerminal: true,
			command: '/bin/zsh',
			args: ['-l', '-i', '--rcfile', '/tmp/my rc', '--noprofile'],
		});
	});

	it('uses the explicit terminal command when no shell is configured on Windows', () => {
		mocks.isWindows.mockReturnValue(true);
		const { spawner } = createContext();

		spawner.spawn(createConfig());

		expect(mocks.ptySpawn).toHaveBeenCalledWith(
			'claude',
			['--print'],
			expect.objectContaining({ cwd: '/workspace/project' })
		);
	});

	it('ignores malformed quote-only shell args when parsing produces no arguments', () => {
		const { spawner } = createContext();

		spawner.spawn(createConfig({ shell: '/bin/bash', shellArgs: '"' }));

		expect(mocks.ptySpawn).toHaveBeenCalledWith(
			'/bin/bash',
			['-l', '-i'],
			expect.objectContaining({ cwd: '/workspace/project' })
		);
	});

	it('spawns an agent command with child-process style environment', () => {
		const { processes, spawner } = createContext();

		const result = spawner.spawn(
			createConfig({
				toolType: 'claude-code',
				command: 'claude',
				args: ['--dangerously-skip-permissions'],
				customEnvVars: { API_URL: 'https://example.test' },
				shellEnvVars: { GLOBAL_TOKEN: 'set' },
			})
		);

		expect(result).toEqual({ pid: 4321, success: true });
		expect(mocks.buildChildProcessEnv).toHaveBeenCalledWith(
			{ API_URL: 'https://example.test' },
			false,
			{ GLOBAL_TOKEN: 'set' }
		);
		expect(mocks.ptySpawn).toHaveBeenCalledWith(
			'claude',
			['--dangerously-skip-permissions'],
			expect.objectContaining({ env: { PATH: '/agent/bin', HOME: '/home/tester' } })
		);
		expect(processes.get('session-1')).toMatchObject({
			command: 'claude',
			args: ['--dangerously-skip-permissions'],
			isTerminal: true,
		});
	});

	it('filters PTY output and buffers only non-empty cleaned data', () => {
		const ptyProcess = createMockPty();
		mocks.ptySpawn.mockReturnValue(ptyProcess);
		mocks.stripControlSequences.mockReturnValueOnce('cleaned output').mockReturnValueOnce('   ');
		const { processes, bufferManager, spawner } = createContext();

		spawner.spawn(createConfig());
		processes.get('session-1')!.lastCommand = 'ls -la';
		ptyProcess.emitData('\u001b[?2004hcleaned output');
		ptyProcess.emitData('\u001b[?2004l');

		expect(mocks.stripControlSequences).toHaveBeenNthCalledWith(
			1,
			'\u001b[?2004hcleaned output',
			'ls -la',
			true
		);
		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith('session-1', 'cleaned output');
		expect(bufferManager.emitDataBuffered).toHaveBeenCalledTimes(1);
	});

	it('flushes buffered output, emits exit, and removes the process on PTY exit', () => {
		const ptyProcess = createMockPty();
		mocks.ptySpawn.mockReturnValue(ptyProcess);
		const { processes, emitter, bufferManager, spawner } = createContext();
		const exitEvents: Array<[string, number]> = [];
		emitter.on('exit', (sessionId: string, exitCode: number) => {
			exitEvents.push([sessionId, exitCode]);
		});

		spawner.spawn(createConfig());
		ptyProcess.emitExit(130);

		expect(bufferManager.flushDataBuffer).toHaveBeenCalledWith('session-1');
		expect(exitEvents).toEqual([['session-1', 130]]);
		expect(processes.has('session-1')).toBe(false);
	});

	it('returns a failed result and logs when PTY spawn throws', () => {
		mocks.ptySpawn.mockImplementation(() => {
			throw new Error('spawn denied');
		});
		const { processes, spawner } = createContext();

		const result = spawner.spawn(createConfig());

		expect(result).toEqual({ pid: -1, success: false });
		expect(processes.has('session-1')).toBe(false);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Failed to spawn PTY process',
			'ProcessManager',
			expect.objectContaining({
				error: 'Error: spawn denied',
				sessionId: 'session-1',
				toolType: 'terminal',
				command: 'claude',
				cwd: '/workspace/project',
			})
		);
	});
});
