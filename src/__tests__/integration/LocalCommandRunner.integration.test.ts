import { EventEmitter } from 'events';
import * as os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	childSpawn: vi.fn(),
	ptySpawn: vi.fn(),
	resolveShellPath: vi.fn(),
	buildInteractiveShellArgs: vi.fn(),
	buildWrappedCommand: vi.fn(),
	buildUnixBasePath: vi.fn(),
	buildSpawnPath: vi.fn(),
	isWindows: vi.fn(),
	captureException: vi.fn(),
	stripControlSequences: vi.fn((data: string) => data),
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: mocks.childSpawn,
		default: {
			...actual,
			spawn: mocks.childSpawn,
		},
	};
});

vi.mock('node-pty', () => ({
	spawn: mocks.ptySpawn,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/process-manager/utils/pathResolver', () => ({
	resolveShellPath: mocks.resolveShellPath,
	buildInteractiveShellArgs: mocks.buildInteractiveShellArgs,
	buildWrappedCommand: mocks.buildWrappedCommand,
}));

vi.mock('../../main/process-manager/utils/envBuilder', () => ({
	buildUnixBasePath: mocks.buildUnixBasePath,
}));

vi.mock('../../main/utils/spawnPath', () => ({
	buildSpawnPath: mocks.buildSpawnPath,
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: mocks.captureException,
}));

vi.mock('../../main/utils/terminalFilter', () => ({
	stripControlSequences: mocks.stripControlSequences,
}));

import { LocalCommandRunner } from '../../main/process-manager/runners/LocalCommandRunner';

type MockPty = {
	onData: ReturnType<typeof vi.fn>;
	onExit: ReturnType<typeof vi.fn>;
	emitData: (data: string) => void;
	emitExit: (exitCode: number) => void;
};

function createMockPty(): MockPty {
	let dataHandler: ((data: string) => void) | undefined;
	let exitHandler: ((event: { exitCode: number }) => void) | undefined;

	return {
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

type MockChildProcess = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
};

function createMockChildProcess(): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

function createRunnerContext() {
	const emitter = new EventEmitter();
	const runner = new LocalCommandRunner(emitter);
	const dataEvents: string[] = [];
	const stderrEvents: string[] = [];
	const exitEvents: number[] = [];

	emitter.on('data', (_sessionId: string, data: string) => {
		dataEvents.push(data);
	});
	emitter.on('stderr', (_sessionId: string, data: string) => {
		stderrEvents.push(data);
	});
	emitter.on('command-exit', (_sessionId: string, code: number) => {
		exitEvents.push(code);
	});

	return { runner, dataEvents, stderrEvents, exitEvents };
}

describe('LocalCommandRunner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isWindows.mockReturnValue(false);
		mocks.resolveShellPath.mockReturnValue('/bin/zsh');
		mocks.buildInteractiveShellArgs.mockReturnValue(['-l', '-i', '-c', 'ls']);
		mocks.buildWrappedCommand.mockReturnValue('wrapped command');
		mocks.buildUnixBasePath.mockReturnValue('/usr/bin:/bin');
		mocks.buildSpawnPath.mockReturnValue('/usr/bin:/bin');
		mocks.stripControlSequences.mockImplementation((data: string) => data);
		mocks.ptySpawn.mockReturnValue(createMockPty());
		mocks.childSpawn.mockReturnValue(createMockChildProcess());
	});

	it('spawns a Unix PTY, emits filtered output, applies env vars, and resolves on exit', async () => {
		const ptyProcess = createMockPty();
		mocks.ptySpawn.mockReturnValue(ptyProcess);
		mocks.stripControlSequences.mockReturnValueOnce('visible output').mockReturnValueOnce('   ');
		const { runner, dataEvents, exitEvents } = createRunnerContext();

		const resultPromise = runner.run('session-1', 'ls', '/tmp/project', 'zsh', {
			CONFIG_DIR: '~/config',
			PLAIN_VALUE: 'literal',
		});
		ptyProcess.emitData('\u001b[?2004hvisible output');
		ptyProcess.emitData('\u001b[?2004l');
		ptyProcess.emitExit(0);

		await expect(resultPromise).resolves.toEqual({ exitCode: 0 });
		expect(mocks.buildInteractiveShellArgs).toHaveBeenCalledWith('ls', 'zsh');
		expect(mocks.ptySpawn).toHaveBeenCalledWith('/bin/zsh', ['-l', '-i', '-c', 'ls'], {
			name: 'xterm-256color',
			cols: 120,
			rows: 40,
			cwd: '/tmp/project',
			env: expect.objectContaining({
				PATH: '/usr/bin:/bin',
				TERM: 'xterm-256color',
				CONFIG_DIR: os.homedir() + '/config',
				PLAIN_VALUE: 'literal',
			}),
		});
		expect(mocks.stripControlSequences).toHaveBeenNthCalledWith(
			1,
			'\u001b[?2004hvisible output',
			'ls',
			true
		);
		expect(dataEvents).toEqual(['visible output']);
		expect(exitEvents).toEqual([0]);
	});

	it('uses default LANG and shell-name fallback for extension-only shells', async () => {
		const originalLang = process.env.LANG;
		delete process.env.LANG;
		const ptyProcess = createMockPty();
		mocks.ptySpawn.mockReturnValue(ptyProcess);
		mocks.buildInteractiveShellArgs.mockReturnValueOnce(['-c', 'pwd']);
		const { runner } = createRunnerContext();

		try {
			const resultPromise = runner.run('session-1', 'pwd', '/tmp/project', '.exe');
			ptyProcess.emitExit(0);

			await expect(resultPromise).resolves.toEqual({ exitCode: 0 });
			expect(mocks.buildInteractiveShellArgs).toHaveBeenCalledWith('pwd', '.exe');
			expect(mocks.ptySpawn).toHaveBeenCalledWith(
				'/bin/zsh',
				['-c', 'pwd'],
				expect.objectContaining({
					env: expect.objectContaining({ LANG: 'en_US.UTF-8' }),
				})
			);
		} finally {
			if (originalLang === undefined) {
				delete process.env.LANG;
			} else {
				process.env.LANG = originalLang;
			}
		}
	});

	it('resolves and emits stderr when PTY spawn throws a recoverable error', async () => {
		mocks.ptySpawn.mockImplementation(() => {
			throw new Error('permission denied');
		});
		const { runner, stderrEvents, exitEvents } = createRunnerContext();

		const result = await runner.run('session-1', 'ls', '/tmp');

		expect(result).toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual(['Error: permission denied']);
		expect(exitEvents).toEqual([1]);
		expect(mocks.captureException).not.toHaveBeenCalled();
	});

	it('treats recoverable PTY spawn error codes as command failures', async () => {
		const error = Object.assign(new Error('missing shell'), { code: 'ENOENT' });
		mocks.ptySpawn.mockImplementation(() => {
			throw error;
		});
		const { runner, stderrEvents, exitEvents } = createRunnerContext();

		const result = await runner.run('session-1', 'ls', '/tmp');

		expect(result).toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual(['Error: missing shell']);
		expect(exitEvents).toEqual([1]);
		expect(mocks.captureException).not.toHaveBeenCalled();
	});

	it('treats recoverable non-Error PTY spawn throws as command failures', async () => {
		const recoverableValue: unknown = { toString: () => 'cwd missing' };
		mocks.ptySpawn.mockImplementation(() => {
			throw recoverableValue;
		});
		const { runner, stderrEvents, exitEvents } = createRunnerContext();

		const result = await runner.run('session-1', 'ls', '/tmp');

		expect(result).toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual(['Error: cwd missing']);
		expect(exitEvents).toEqual([1]);
		expect(mocks.captureException).not.toHaveBeenCalled();
	});

	it('captures and rejects unrecoverable PTY spawn errors', async () => {
		const error = new Error('native pty exploded');
		mocks.ptySpawn.mockImplementation(() => {
			throw error;
		});
		const { runner } = createRunnerContext();

		await expect(runner.run('session-1', 'ls', '/tmp')).rejects.toThrow('native pty exploded');
		expect(mocks.captureException).toHaveBeenCalledWith(error, {
			operation: 'process-runner:pty-spawn',
			sessionId: 'session-1',
			shell: 'zsh',
			shellPath: '/bin/zsh',
			cwd: '/tmp',
		});
	});

	it('spawns a Windows child process, filters stdout, emits stderr, and defaults null exit to zero', async () => {
		mocks.isWindows.mockReturnValue(true);
		mocks.resolveShellPath.mockReturnValue('powershell.exe');
		mocks.buildWrappedCommand.mockReturnValue('Get-ChildItem');
		const child = createMockChildProcess();
		mocks.childSpawn.mockReturnValue(child);
		mocks.stripControlSequences.mockReturnValueOnce('windows output').mockReturnValueOnce('   ');
		const { runner, dataEvents, stderrEvents, exitEvents } = createRunnerContext();

		const resultPromise = runner.run('session-1', 'Get-ChildItem', 'C:\\repo', undefined, {
			CONFIG_DIR: '~/config',
		});
		child.stdout.emit('data', Buffer.from('\u001b]133;A\u0007windows output'));
		child.stdout.emit('data', Buffer.from('\u001b]133;B\u0007'));
		child.stderr.emit('data', Buffer.from('warning text'));
		child.emit('exit', null);

		await expect(resultPromise).resolves.toEqual({ exitCode: 0 });
		expect(mocks.buildWrappedCommand).toHaveBeenCalledWith('Get-ChildItem', 'powershell');
		expect(mocks.childSpawn).toHaveBeenCalledWith('Get-ChildItem', [], {
			cwd: 'C:\\repo',
			env: expect.objectContaining({
				TERM: 'xterm-256color',
				CONFIG_DIR: os.homedir() + '/config',
			}),
			shell: 'powershell.exe',
		});
		expect(dataEvents).toEqual(['windows output']);
		expect(stderrEvents).toEqual(['warning text']);
		expect(exitEvents).toEqual([0]);
	});

	it('emits stderr and resolves with failure when a Windows child process errors', async () => {
		mocks.isWindows.mockReturnValue(true);
		mocks.resolveShellPath.mockReturnValue('cmd.exe');
		const child = createMockChildProcess();
		mocks.childSpawn.mockReturnValue(child);
		const { runner, stderrEvents, exitEvents } = createRunnerContext();

		const resultPromise = runner.run('session-1', 'dir', 'C:\\repo', 'cmd.exe');
		child.emit('error', new Error('spawn failed'));

		await expect(resultPromise).resolves.toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual(['Error: spawn failed']);
		expect(exitEvents).toEqual([1]);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] runCommand error',
			'ProcessManager',
			{ sessionId: 'session-1', error: 'spawn failed' }
		);
	});
});
