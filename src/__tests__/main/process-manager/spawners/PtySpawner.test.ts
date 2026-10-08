/**
 * Tests for src/main/process-manager/spawners/PtySpawner.ts
 *
 * Key behaviors verified:
 * - Shell terminal: uses `shell` field with -l/-i flags (login+interactive)
 * - SSH terminal: when no `shell` is provided, uses `command`/`args` directly
 *   (this is the fix for SSH terminal tabs connecting to remote hosts)
 * - AI agent PTY: uses `command`/`args` directly (toolType !== 'terminal')
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPtySpawn = vi.fn();
const mockPtyProcess = {
	pid: 99999,
	onData: vi.fn(),
	onExit: vi.fn(),
	write: vi.fn(),
	resize: vi.fn(),
	kill: vi.fn(),
};

vi.mock('node-pty', () => ({
	spawn: (...args: unknown[]) => {
		mockPtySpawn(...args);
		return mockPtyProcess;
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/terminalFilter', () => ({
	stripControlSequences: vi.fn((data: string) => data),
}));

vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildPtyTerminalEnv: vi.fn(() => ({ TERM: 'xterm-256color' })),
	buildChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
	collectMaestroEnvVars: vi.fn(() => ({})),
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

vi.mock('../../../../main/process-manager/utils/pathResolver', () => ({
	resolveShellPath: vi.fn((shell: string) => shell),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { PtySpawner } from '../../../../main/process-manager/spawners/PtySpawner';
import type { ManagedProcess, ProcessConfig } from '../../../../main/process-manager/types';
import { resolveShellPath } from '../../../../main/process-manager/utils/pathResolver';
import { isWindows } from '../../../../shared/platformDetection';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestContext() {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};
	const spawner = new PtySpawner(processes, emitter, bufferManager as any);
	return { processes, emitter, bufferManager, spawner };
}

function createBaseConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'test-session',
		toolType: 'terminal',
		cwd: '/home/user',
		command: 'zsh',
		args: [],
		shell: 'zsh',
		...overrides,
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PtySpawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPtyProcess.onData.mockImplementation(() => {});
		mockPtyProcess.onExit.mockImplementation(() => {});
	});

	describe('shell terminal (toolType=terminal, shell provided)', () => {
		it('spawns the shell with -l -i flags', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createBaseConfig({ shell: 'zsh' }));

			expect(mockPtySpawn).toHaveBeenCalledWith(
				'zsh',
				['-l', '-i'],
				expect.objectContaining({ name: 'xterm-256color' })
			);
		});

		it('appends custom shellArgs after -l -i', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createBaseConfig({ shell: 'zsh', shellArgs: '--login --no-rcs' }));

			const [, args] = mockPtySpawn.mock.calls[0];
			expect(args[0]).toBe('-l');
			expect(args[1]).toBe('-i');
			expect(args).toContain('--login');
			expect(args).toContain('--no-rcs');
		});

		it('returns success with pid from PTY process', () => {
			const { spawner } = createTestContext();
			const result = spawner.spawn(createBaseConfig({ shell: 'bash' }));

			expect(result.success).toBe(true);
			expect(result.pid).toBe(99999);
		});
	});

	describe('SSH terminal (toolType=terminal, no shell provided)', () => {
		it('uses command and args directly without -l/-i flags', () => {
			const { spawner } = createTestContext();
			spawner.spawn(
				createBaseConfig({
					shell: undefined,
					command: 'ssh',
					args: ['pedram@pedtome.example.com'],
				})
			);

			expect(mockPtySpawn).toHaveBeenCalledWith(
				'ssh',
				['pedram@pedtome.example.com'],
				expect.objectContaining({ name: 'xterm-256color' })
			);
		});

		it('passes through ssh args including -t flag and remote command', () => {
			const { spawner } = createTestContext();
			const sshArgs = ['-t', 'pedram@pedtome.example.com', 'cd "/project" && exec $SHELL'];
			spawner.spawn(
				createBaseConfig({
					shell: undefined,
					command: 'ssh',
					args: sshArgs,
				})
			);

			expect(mockPtySpawn).toHaveBeenCalledWith(
				'ssh',
				sshArgs,
				expect.objectContaining({ name: 'xterm-256color' })
			);
		});

		it('passes through ssh args with -i and -p flags', () => {
			const { spawner } = createTestContext();
			const sshArgs = ['-i', '/home/user/.ssh/id_rsa', '-p', '2222', 'pedram@pedtome.example.com'];
			spawner.spawn(
				createBaseConfig({
					shell: undefined,
					command: 'ssh',
					args: sshArgs,
				})
			);

			const [cmd, args] = mockPtySpawn.mock.calls[0];
			expect(cmd).toBe('ssh');
			expect(args).toEqual(sshArgs);
			// Must NOT contain -l or -i (shell flags)
			expect(args).not.toContain('-l');
		});

		it('returns success with pid from PTY process', () => {
			const { spawner } = createTestContext();
			const result = spawner.spawn(
				createBaseConfig({
					shell: undefined,
					command: 'ssh',
					args: ['user@remote.example.com'],
				})
			);

			expect(result.success).toBe(true);
			expect(result.pid).toBe(99999);
		});
	});

	describe('Windows shell resolution', () => {
		it('resolves shell ID to executable via resolveShellPath', () => {
			vi.mocked(isWindows).mockReturnValueOnce(true);
			vi.mocked(resolveShellPath).mockReturnValueOnce('powershell.exe');

			const { spawner } = createTestContext();
			spawner.spawn(createBaseConfig({ shell: 'powershell' }));

			expect(resolveShellPath).toHaveBeenCalledWith('powershell');
			expect(mockPtySpawn).toHaveBeenCalledWith(
				'powershell.exe',
				[],
				expect.objectContaining({ name: 'xterm-256color' })
			);
		});
	});

	describe('AI agent PTY (toolType !== terminal)', () => {
		it('uses command and args directly regardless of shell field', () => {
			const { spawner } = createTestContext();
			spawner.spawn(
				createBaseConfig({
					toolType: 'claude-code',
					command: 'claude',
					args: ['--print'],
					shell: 'zsh',
				})
			);

			expect(mockPtySpawn).toHaveBeenCalledWith(
				'claude',
				['--print'],
				expect.objectContaining({ name: 'xterm-256color' })
			);
		});
	});

	describe('process registration', () => {
		it('registers the managed process by sessionId', () => {
			const { spawner, processes } = createTestContext();
			spawner.spawn(createBaseConfig({ sessionId: 'my-session', shell: 'zsh' }));

			expect(processes.has('my-session')).toBe(true);
			expect(processes.get('my-session')?.pid).toBe(99999);
		});

		it('records terminal identity independently of the PTY transport', () => {
			const { spawner, processes } = createTestContext();

			// Shell terminal
			spawner.spawn(createBaseConfig({ sessionId: 'shell-session', shell: 'zsh' }));
			expect(processes.get('shell-session')?.isTerminal).toBe(true);

			// SSH terminal
			spawner.spawn(
				createBaseConfig({
					sessionId: 'ssh-session',
					shell: undefined,
					command: 'ssh',
					args: ['host'],
				})
			);
			expect(processes.get('ssh-session')?.isTerminal).toBe(true);

			// AI agent that requires a PTY
			spawner.spawn(
				createBaseConfig({
					sessionId: 'agent-pty-session',
					toolType: 'claude-code',
					command: 'claude',
					args: [],
					shell: undefined,
				})
			);
			expect(processes.get('agent-pty-session')?.isTerminal).toBe(false);
		});
	});

	describe('exit ownership', () => {
		it('releases an AI process before notifying synchronous replay listeners', () => {
			const { spawner, processes, emitter } = createTestContext();
			const config = createBaseConfig({
				sessionId: 'agent-pty-session',
				toolType: 'claude-code',
				command: 'claude',
				shell: undefined,
			});

			spawner.spawn(config);
			const exitingProcess = processes.get(config.sessionId);
			const onExit = mockPtyProcess.onExit.mock.calls[0][0];
			emitter.on('exit', () => spawner.spawn(config));

			expect(() => onExit({ exitCode: 0, signal: 0 })).not.toThrow();
			expect(processes.get(config.sessionId)).not.toBe(exitingProcess);
		});

		it('ignores an exit from a stale terminal generation', () => {
			const { spawner, processes, emitter } = createTestContext();
			const config = createBaseConfig({ sessionId: 'restarted-terminal' });
			const exitListener = vi.fn();
			emitter.on('exit', exitListener);

			spawner.spawn(config);
			const staleOnExit = mockPtyProcess.onExit.mock.calls[0][0];
			spawner.spawn(config);
			const replacement = processes.get(config.sessionId);

			staleOnExit({ exitCode: 0, signal: 0 });

			expect(processes.get(config.sessionId)).toBe(replacement);
			expect(exitListener).not.toHaveBeenCalled();
		});

		it('emits exit when an explicit kill already removed the process entry', () => {
			const { spawner, processes, emitter } = createTestContext();
			const config = createBaseConfig({ sessionId: 'killed-terminal' });
			const exitListener = vi.fn();
			emitter.on('exit', exitListener);

			spawner.spawn(config);
			const onExit = mockPtyProcess.onExit.mock.calls[0][0];
			processes.delete(config.sessionId);

			onExit({ exitCode: 143, signal: 15 });

			expect(exitListener).toHaveBeenCalledWith(config.sessionId, 143, 15);
		});
	});

	// Regression (issue #1044): ProcessManager.spawn() kills whatever holds a
	// sessionId before registering the replacement under the same key. A late
	// exit from the killed PTY must not be reported as the successor dying, and
	// must not delete the successor's tracking entry.
	describe('late events from a superseded generation', () => {
		function spawnTwoGenerations() {
			const ctx = createTestContext();
			const config = createBaseConfig({ sessionId: 'reused-session', shell: 'zsh' });

			ctx.spawner.spawn(config);
			const firstOnData = mockPtyProcess.onData.mock.calls[0][0] as (data: string) => void;
			const firstOnExit = mockPtyProcess.onExit.mock.calls[0][0] as (e: {
				exitCode: number;
				signal?: number;
			}) => void;

			// The predecessor is killed (map entry dropped) and the successor takes
			// over the same key.
			ctx.processes.delete(config.sessionId);
			ctx.spawner.spawn(config);

			return {
				...ctx,
				config,
				firstOnData,
				firstOnExit,
				second: ctx.processes.get('reused-session'),
			};
		}

		it('ignores a late exit from the superseded PTY', () => {
			const { emitter, processes, firstOnExit, second } = spawnTwoGenerations();
			const onExit = vi.fn();
			emitter.on('exit', onExit);

			firstOnExit({ exitCode: 143, signal: 15 });

			expect(onExit).not.toHaveBeenCalled();
			expect(processes.get('reused-session')).toBe(second);
		});

		it('ignores late data from the superseded PTY', () => {
			const { bufferManager, firstOnData } = spawnTwoGenerations();

			firstOnData('stale terminal output');

			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});

		it('still reports exit for the current generation', () => {
			const { emitter, processes, spawner } = createTestContext();
			spawner.spawn(createBaseConfig({ sessionId: 'live-session', shell: 'zsh' }));
			const onPtyExit = mockPtyProcess.onExit.mock.calls.at(-1)![0] as (e: {
				exitCode: number;
				signal?: number;
			}) => void;
			const onExit = vi.fn();
			emitter.on('exit', onExit);

			onPtyExit({ exitCode: 0, signal: undefined });

			expect(onExit).toHaveBeenCalledWith('live-session', 0, undefined);
			expect(processes.has('live-session')).toBe(false);
		});
	});

	// Regression: `flushDataBuffer()` and the `exit` emit below are both
	// synchronous, and EventEmitter runs listeners in-line. If a listener on
	// either event re-spawns this session id (e.g. a Cue completion chain
	// reacting to output) before this callback finishes, the trailing cleanup
	// must not delete the successor's fresh entry.
	describe('successor spawned synchronously during the final flush', () => {
		it('does not emit exit or untrack the successor', () => {
			const { emitter, processes, bufferManager, spawner } = createTestContext();
			const config = createBaseConfig({ sessionId: 'reused-session', shell: 'zsh' });

			spawner.spawn(config);
			const onExit = mockPtyProcess.onExit.mock.calls[0][0] as (e: {
				exitCode: number;
				signal?: number;
			}) => void;
			const predecessor = processes.get('reused-session');

			let successor: ManagedProcess | undefined;
			bufferManager.flushDataBuffer.mockImplementation((sid: string) => {
				// Simulate a listener on 'data' re-spawning the session while the
				// flush is still running.
				spawner.spawn(config);
				successor = processes.get(sid);
			});

			const onExitEvent = vi.fn();
			emitter.on('exit', onExitEvent);

			onExit({ exitCode: 143, signal: 15 });

			expect(onExitEvent).not.toHaveBeenCalled();
			expect(successor).toBeDefined();
			expect(successor).not.toBe(predecessor);
			expect(processes.get('reused-session')).toBe(successor);
		});
	});
});
