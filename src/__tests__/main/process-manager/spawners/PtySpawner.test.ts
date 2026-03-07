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
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { PtySpawner } from '../../../../main/process-manager/spawners/PtySpawner';
import type { ManagedProcess, ProcessConfig } from '../../../../main/process-manager/types';

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

		it('sets isTerminal=true for all PTY processes', () => {
			const { spawner, processes } = createTestContext();

			// Shell terminal
			spawner.spawn(createBaseConfig({ sessionId: 'shell-session', shell: 'zsh' }));
			expect(processes.get('shell-session')?.isTerminal).toBe(true);

			// SSH terminal
			spawner.spawn(
				createBaseConfig({ sessionId: 'ssh-session', shell: undefined, command: 'ssh', args: ['host'] })
			);
			expect(processes.get('ssh-session')?.isTerminal).toBe(true);
		});
	});
});
