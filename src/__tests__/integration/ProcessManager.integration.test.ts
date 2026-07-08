import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessManager } from '../../main/process-manager/ProcessManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';

const mockDeps = vi.hoisted(() => ({
	childSpawn: vi.fn(),
	execFile: vi.fn(),
	isWindows: false,
	localRun: vi.fn(),
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
	ptySpawn: vi.fn(),
	sshRun: vi.fn(),
}));

vi.mock('child_process', () => ({
	default: { execFile: mockDeps.execFile },
	execFile: mockDeps.execFile,
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: () => mockDeps.isWindows,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mockDeps.logger,
}));

vi.mock('../../main/process-manager/spawners/PtySpawner', () => ({
	PtySpawner: vi.fn().mockImplementation(function PtySpawner() {
		return {
			spawn: mockDeps.ptySpawn,
		};
	}),
}));

vi.mock('../../main/process-manager/spawners/ChildProcessSpawner', () => ({
	ChildProcessSpawner: vi.fn().mockImplementation(function ChildProcessSpawner() {
		return {
			spawn: mockDeps.childSpawn,
		};
	}),
}));

vi.mock('../../main/process-manager/runners/LocalCommandRunner', () => ({
	LocalCommandRunner: vi.fn().mockImplementation(function LocalCommandRunner() {
		return {
			run: mockDeps.localRun,
		};
	}),
}));

vi.mock('../../main/process-manager/runners/SshCommandRunner', () => ({
	SshCommandRunner: vi.fn().mockImplementation(function SshCommandRunner() {
		return {
			run: mockDeps.sshRun,
		};
	}),
}));

describe('ProcessManager integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDeps.isWindows = false;
		mockDeps.ptySpawn.mockReturnValue({ pid: 101, success: true });
		mockDeps.childSpawn.mockReturnValue({ pid: 202, success: true });
		mockDeps.localRun.mockResolvedValue({ exitCode: 0 });
		mockDeps.sshRun.mockResolvedValue({ exitCode: 7 });
		mockDeps.execFile.mockImplementation((_command, _args, callback) => {
			callback?.(null);
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('routes spawns, command runners, process lookup, and parser calls through real manager state', async () => {
		const manager = new ProcessManager();
		const terminalConfig = createConfig({ sessionId: 'terminal', toolType: 'terminal' });
		const childConfig = createConfig({ sessionId: 'agent', prompt: 'hello', toolType: 'terminal' });
		const ptyConfig = createConfig({
			sessionId: 'pty-required',
			requiresPty: true,
			toolType: 'claude',
		});

		expect(manager.spawn(terminalConfig)).toEqual({ pid: 101, success: true });
		expect(manager.spawn(childConfig)).toEqual({ pid: 202, success: true });
		expect(manager.spawn(ptyConfig)).toEqual({ pid: 101, success: true });
		expect(mockDeps.ptySpawn).toHaveBeenCalledWith(terminalConfig);
		expect(mockDeps.childSpawn).toHaveBeenCalledWith(childConfig);
		expect(mockDeps.ptySpawn).toHaveBeenCalledWith(ptyConfig);

		const parser = { parseJsonLine: vi.fn().mockReturnValue({ type: 'usage' }) };
		const managed = createManagedProcess({ outputParser: parser, sessionId: 'with-parser' });
		setManagedProcess(manager, managed);

		expect(manager.get('with-parser')).toBe(managed);
		expect(manager.getAll()).toEqual([managed]);
		expect(manager.getParser('with-parser')).toBe(parser);
		expect(manager.parseLine('with-parser', '{"type":"usage"}')).toEqual({ type: 'usage' });
		expect(parser.parseJsonLine).toHaveBeenCalledWith('{"type":"usage"}');
		expect(manager.getParser('missing')).toBeNull();
		expect(manager.parseLine('missing', '{}')).toBeNull();

		await expect(
			manager.runCommand('local', 'git status', '/repo', 'zsh', { A: '1' })
		).resolves.toEqual({
			exitCode: 0,
		});
		expect(mockDeps.localRun).toHaveBeenCalledWith('local', 'git status', '/repo', 'zsh', {
			A: '1',
		});

		const sshConfig = { enabled: true, host: 'builder', port: 22, username: 'dev' };
		await expect(
			manager.runCommand('remote', 'pwd', '/repo', undefined, { B: '2' }, sshConfig)
		).resolves.toEqual({ exitCode: 7 });
		expect(mockDeps.sshRun).toHaveBeenCalledWith('remote', 'pwd', '/repo', sshConfig, { B: '2' });
	});

	it('writes to terminal and child processes and handles missing or failing streams', () => {
		const manager = new ProcessManager();
		const terminalPty = createPty();
		const child = createChildProcess();
		setManagedProcess(
			manager,
			createManagedProcess({ isTerminal: true, ptyProcess: terminalPty, sessionId: 'terminal' })
		);
		setManagedProcess(manager, createManagedProcess({ childProcess: child, sessionId: 'child' }));
		setManagedProcess(
			manager,
			createManagedProcess({
				childProcess: createChildProcess({ stdin: null }),
				sessionId: 'closed',
			})
		);

		expect(manager.write('missing', 'echo nope\n')).toBe(false);
		expect(mockDeps.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] write() - No process found for session',
			'ProcessManager',
			{ sessionId: 'missing' }
		);

		expect(manager.write('terminal', 'npm test\n')).toBe(true);
		expect(terminalPty.write).toHaveBeenCalledWith('npm test\n');
		expect(manager.get('terminal')?.lastCommand).toBe('npm test');
		expect(manager.write('terminal', '\n')).toBe(true);
		expect(manager.get('terminal')?.lastCommand).toBe('npm test');

		expect(manager.write('child', 'hello')).toBe(true);
		expect(child.stdin.write).toHaveBeenCalledWith('hello');

		expect(manager.write('closed', 'lost')).toBe(false);

		terminalPty.write.mockImplementationOnce(() => {
			throw new Error('pty closed');
		});
		expect(manager.write('terminal', 'again')).toBe(false);
		expect(mockDeps.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Failed to write to process',
			'ProcessManager',
			expect.objectContaining({ error: 'Error: pty closed', sessionId: 'terminal' })
		);
	});

	it('resizes terminals and reports unsupported or failing resize operations', () => {
		const manager = new ProcessManager();
		const terminalPty = createPty();
		setManagedProcess(
			manager,
			createManagedProcess({ isTerminal: true, ptyProcess: terminalPty, sessionId: 'terminal' })
		);
		setManagedProcess(manager, createManagedProcess({ sessionId: 'child' }));

		expect(manager.resize('missing', 80, 24)).toBe(false);
		expect(manager.resize('child', 80, 24)).toBe(false);
		expect(manager.resize('terminal', 120, 40)).toBe(true);
		expect(terminalPty.resize).toHaveBeenCalledWith(120, 40);

		terminalPty.resize.mockImplementationOnce(() => {
			throw new Error('resize failed');
		});
		expect(manager.resize('terminal', 100, 30)).toBe(false);
		expect(mockDeps.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Failed to resize terminal',
			'ProcessManager',
			expect.objectContaining({ error: 'Error: resize failed', sessionId: 'terminal' })
		);
	});

	it('interrupts terminals and child processes, including escalation and Windows stdin handling', () => {
		vi.useFakeTimers();
		const manager = new ProcessManager();
		const terminalPty = createPty();
		const exitingChild = createChildProcess();
		const hangingChild = createChildProcess({ pid: 777 });
		setManagedProcess(
			manager,
			createManagedProcess({ isTerminal: true, ptyProcess: terminalPty, sessionId: 'terminal' })
		);
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: exitingChild, sessionId: 'exiting' })
		);
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: hangingChild, pid: 777, sessionId: 'hanging' })
		);
		setManagedProcess(manager, createManagedProcess({ sessionId: 'inert' }));

		expect(manager.interrupt('missing')).toBe(false);
		expect(manager.interrupt('terminal')).toBe(true);
		expect(terminalPty.write).toHaveBeenCalledWith('\x03');
		expect(manager.interrupt('inert')).toBe(false);

		expect(manager.interrupt('exiting')).toBe(true);
		expect(exitingChild.kill).toHaveBeenCalledWith('SIGINT');
		exitingChild.emit('exit');
		vi.advanceTimersByTime(2000);
		expect(exitingChild.kill).not.toHaveBeenCalledWith('SIGTERM');

		const alreadyKilled = createChildProcess();
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: alreadyKilled, sessionId: 'killed' })
		);
		expect(manager.interrupt('killed')).toBe(true);
		alreadyKilled.killed = true;
		vi.advanceTimersByTime(2000);
		expect(alreadyKilled.kill).not.toHaveBeenCalledWith('SIGTERM');

		expect(manager.interrupt('hanging')).toBe(true);
		expect(hangingChild.kill).toHaveBeenCalledWith('SIGINT');
		vi.advanceTimersByTime(2000);
		expect(hangingChild.kill).toHaveBeenCalledWith('SIGTERM');
		expect(manager.get('hanging')).toBeUndefined();

		const failingPty = createPty();
		failingPty.write.mockImplementationOnce(() => {
			throw new Error('interrupt failed');
		});
		setManagedProcess(
			manager,
			createManagedProcess({
				isTerminal: true,
				ptyProcess: failingPty,
				sessionId: 'failing-interrupt',
			})
		);
		expect(manager.interrupt('failing-interrupt')).toBe(false);
		expect(mockDeps.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Failed to interrupt process',
			'ProcessManager',
			expect.objectContaining({
				error: 'Error: interrupt failed',
				sessionId: 'failing-interrupt',
			})
		);

		mockDeps.isWindows = true;
		const windowsChild = createChildProcess({ pid: 888 });
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: windowsChild, pid: 888, sessionId: 'win' })
		);
		expect(manager.interrupt('win')).toBe(true);
		expect(windowsChild.stdin.write).toHaveBeenCalledWith('\x03');
		vi.advanceTimersByTime(2000);
		expect(mockDeps.execFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', '888', '/t', '/f'],
			expect.any(Function)
		);

		const noStdin = createChildProcess({
			pid: 889,
			stdin: { destroyed: true, writableEnded: false, write: vi.fn() },
		});
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: noStdin, pid: 889, sessionId: 'win-no-stdin' })
		);
		expect(manager.interrupt('win-no-stdin')).toBe(true);
		expect(mockDeps.logger.warn).toHaveBeenCalledWith(
			'[ProcessManager] stdin unavailable for Windows interrupt, will escalate to kill',
			'ProcessManager',
			{ sessionId: 'win-no-stdin' }
		);
		vi.advanceTimersByTime(2000);
		expect(mockDeps.execFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', '889', '/t', '/f'],
			expect.any(Function)
		);
	});

	it('kills terminals, children, buffered output, and Windows process trees', () => {
		const manager = new ProcessManager();
		const dataEvents: unknown[] = [];
		manager.on('data', (...args) => dataEvents.push(args));

		const terminalPty = createPty();
		const child = createChildProcess({ pid: 444 });
		setManagedProcess(
			manager,
			createManagedProcess({
				dataBuffer: 'buffered output',
				dataBufferTimeout: setTimeout(() => undefined, 1000),
				isTerminal: true,
				pid: 333,
				ptyProcess: terminalPty,
				sessionId: 'terminal',
			})
		);
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: child, pid: 444, sessionId: 'child' })
		);

		expect(manager.kill('missing')).toBe(false);
		expect(manager.kill('terminal')).toBe(true);
		expect(dataEvents).toEqual([['terminal', 'buffered output']]);
		expect(terminalPty.kill).toHaveBeenCalledTimes(1);
		expect(manager.get('terminal')).toBeUndefined();

		expect(manager.kill('child')).toBe(true);
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');

		mockDeps.isWindows = true;
		const winChild = createChildProcess({ pid: 555 });
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: winChild, pid: 555, sessionId: 'win-child' })
		);
		expect(manager.kill('win-child')).toBe(true);
		expect(mockDeps.execFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', '555', '/t', '/f'],
			expect.any(Function)
		);

		mockDeps.execFile.mockImplementationOnce((_command, _args, callback) => {
			callback?.(new Error('already dead'));
		});
		const winPty = createPty();
		setManagedProcess(
			manager,
			createManagedProcess({ isTerminal: true, pid: 666, ptyProcess: winPty, sessionId: 'win-pty' })
		);
		expect(manager.kill('win-pty')).toBe(true);
		expect(mockDeps.logger.debug).toHaveBeenCalledWith(
			'[ProcessManager] taskkill exited with error (process may already be terminated)',
			'ProcessManager',
			expect.objectContaining({ error: 'Error: already dead', pid: 666, sessionId: 'win-pty' })
		);

		const noPid = createChildProcess({ pid: undefined });
		setManagedProcess(
			manager,
			createManagedProcess({ childProcess: noPid, pid: 0, sessionId: 'no-pid' })
		);
		expect(manager.kill('no-pid')).toBe(true);
		expect(noPid.kill).toHaveBeenCalledWith('SIGTERM');

		setManagedProcess(manager, createManagedProcess({ sessionId: 'empty' }));
		expect(manager.kill('empty')).toBe(true);
		expect(manager.get('empty')).toBeUndefined();
	});

	it('kills all active processes and reports hard lifecycle failures', () => {
		const manager = new ProcessManager();
		const first = createChildProcess();
		const second = createPty();
		setManagedProcess(manager, createManagedProcess({ childProcess: first, sessionId: 'first' }));
		setManagedProcess(
			manager,
			createManagedProcess({ isTerminal: true, ptyProcess: second, sessionId: 'second' })
		);

		manager.killAll();
		expect(first.kill).toHaveBeenCalledWith('SIGTERM');
		expect(second.kill).toHaveBeenCalledTimes(1);
		expect(manager.getAll()).toEqual([]);

		const alreadyDeadManager = new ProcessManager();
		const alreadyDeadPty = createPty();
		alreadyDeadPty.kill.mockImplementationOnce(() => {
			throw new Error('kill failed');
		});
		setManagedProcess(
			alreadyDeadManager,
			createManagedProcess({
				isTerminal: true,
				ptyProcess: alreadyDeadPty,
				sessionId: 'already-dead',
			})
		);

		expect(alreadyDeadManager.kill('already-dead')).toBe(true);
		expect(alreadyDeadManager.get('already-dead')).toBeUndefined();

		const failingManager = new ProcessManager();
		const failingChild = createChildProcess();
		failingChild.kill.mockImplementationOnce(() => {
			throw new Error('kill failed');
		});
		setManagedProcess(
			failingManager,
			createManagedProcess({ childProcess: failingChild, sessionId: 'failing' })
		);

		expect(failingManager.kill('failing')).toBe(false);
		expect(mockDeps.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Failed to kill process',
			'ProcessManager',
			expect.objectContaining({ error: 'Error: kill failed', sessionId: 'failing' })
		);
	});
});

function createConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		args: [],
		command: 'agent',
		cwd: '/repo',
		sessionId: 'session',
		toolType: 'claude',
		...overrides,
	};
}

function createManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		cwd: '/repo',
		isTerminal: false,
		pid: 123,
		sessionId: 'session',
		startTime: Date.now(),
		toolType: 'claude',
		...overrides,
	};
}

function setManagedProcess(manager: ProcessManager, process: ManagedProcess) {
	const processes = (manager as unknown as { processes: Map<string, ManagedProcess> }).processes;
	processes.set(process.sessionId, process);
}

function createPty() {
	return {
		kill: vi.fn(),
		onExit: vi.fn((callback: () => void) => {
			callback();
			return { dispose: vi.fn() };
		}),
		resize: vi.fn(),
		write: vi.fn(),
	};
}

function createChildProcess(overrides: Record<string, unknown> = {}) {
	const child = new EventEmitter() as EventEmitter & {
		killed: boolean;
		kill: ReturnType<typeof vi.fn>;
		pid?: number;
		stdin: { destroyed: boolean; write: ReturnType<typeof vi.fn>; writableEnded: boolean } | null;
	};
	child.killed = false;
	child.kill = vi.fn((signal?: string) => {
		if (signal === 'SIGTERM') {
			child.killed = true;
		}
	});
	child.pid = 321;
	child.stdin = {
		destroyed: false,
		writableEnded: false,
		write: vi.fn(),
	};
	return Object.assign(child, overrides);
}
