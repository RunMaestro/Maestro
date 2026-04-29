/**
 * Tests for src/main/process-manager/spawners/PtySpawner.ts
 *
 * Covers two orthogonal concerns:
 *
 * 1. Spawn dispatch — shell terminal uses `shell` field with -l/-i flags;
 *    SSH terminal (no `shell`) uses `command`/`args` directly; AI agent PTY
 *    (toolType !== 'terminal') uses `command`/`args` directly; Windows
 *    `resolveShellPath` is honored.
 *
 * 2. Shell-integration injection — when a terminal session is spawned, the
 *    spawner correctly merges the integration env vars and prepends the
 *    integration args returned by `getShellIntegrationEnv()` /
 *    `getShellIntegrationArgs()` — but only when the
 *    `terminalShellIntegration` setting is enabled and the shell is supported.
 *
 * The shell-integration helpers themselves are unit-tested in their own suite;
 * here we mock them out and assert on what the spawner passes to `pty.spawn()`.
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
	buildPtyTerminalEnv: vi.fn(() => ({
		PATH: '/usr/bin',
		TERM: 'xterm-256color',
	})),
	buildChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

vi.mock('../../../../main/process-manager/utils/pathResolver', () => ({
	resolveShellPath: vi.fn((shell: string) => shell),
}));

// Settings store: default-on; per-test override via mockSetting.
const mockSetting = vi.fn();
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, defaultValue: unknown) => mockSetting(key, defaultValue),
	}),
}));

// Shell-integration helpers — return realistic-ish payloads only for zsh/bash so
// we can assert "no-op for unsupported shells" without re-implementing the
// classifier here.
vi.mock('../../../../main/shell-integration', () => ({
	getShellIntegrationEnv: vi.fn((shell?: string) => {
		const base = (shell || '').split('/').pop();
		if (base === 'zsh') {
			return {
				MAESTRO_SHELL_INTEGRATION: '1',
				MAESTRO_SHELL_INTEGRATION_SCRIPT: '<<zsh-script>>',
				ZDOTDIR: '/tmp/loader/zsh',
			};
		}
		if (base === 'bash') {
			return {
				MAESTRO_SHELL_INTEGRATION: '1',
				MAESTRO_SHELL_INTEGRATION_SCRIPT: '<<bash-script>>',
			};
		}
		return {};
	}),
	getShellIntegrationArgs: vi.fn((shell?: string) => {
		const base = (shell || '').split('/').pop();
		if (base === 'bash') return ['--rcfile', '/tmp/loader/bash-init.sh'];
		return [];
	}),
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

function createTerminalConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'test-session',
		toolType: 'terminal',
		cwd: '/tmp/test',
		command: '',
		args: [],
		shell: 'zsh',
		...overrides,
	};
}

function getSpawnedEnv(): Record<string, string> {
	const callArgs = mockPtySpawn.mock.calls[0];
	return callArgs?.[2]?.env || {};
}

function getSpawnedArgs(): string[] {
	const callArgs = mockPtySpawn.mock.calls[0];
	return callArgs?.[1] || [];
}

function getSpawnedCommand(): string {
	const callArgs = mockPtySpawn.mock.calls[0];
	return callArgs?.[0] || '';
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PtySpawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPtyProcess.onData.mockImplementation(() => {});
		mockPtyProcess.onExit.mockImplementation(() => {});
		// Default: setting enabled.
		mockSetting.mockImplementation((_key, defaultValue) => defaultValue);
	});

	describe('shell terminal (toolType=terminal, shell provided)', () => {
		it('spawns the shell with -l -i flags', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createBaseConfig({ shell: 'zsh' }));

			expect(mockPtySpawn).toHaveBeenCalledWith(
				'zsh',
				expect.arrayContaining(['-l', '-i']),
				expect.objectContaining({ name: 'xterm-256color' })
			);
		});

		it('appends custom shellArgs after -l -i', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createBaseConfig({ shell: 'zsh', shellArgs: '--login --no-rcs' }));

			const args = getSpawnedArgs();
			expect(args).toContain('-l');
			expect(args).toContain('-i');
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

		it('sets isTerminal=true for all PTY processes', () => {
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
		});
	});
});

describe('PtySpawner - shell integration injection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPtyProcess.onData.mockImplementation(() => {});
		mockPtyProcess.onExit.mockImplementation(() => {});
		// Default: setting enabled.
		mockSetting.mockImplementation((_key, defaultValue) => defaultValue);
	});

	describe('when setting `terminalShellIntegration` is enabled (default)', () => {
		it('merges zsh integration env vars into the PTY env', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: 'zsh' }));

			const env = getSpawnedEnv();
			expect(env.MAESTRO_SHELL_INTEGRATION).toBe('1');
			expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).toBe('<<zsh-script>>');
			expect(env.ZDOTDIR).toBe('/tmp/loader/zsh');
			// Existing env preserved
			expect(env.TERM).toBe('xterm-256color');
		});

		it('does not prepend extra args for zsh (ZDOTDIR-driven, not flag-driven)', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: 'zsh' }));

			expect(getSpawnedArgs()).toEqual(['-l', '-i']);
		});

		it('merges bash integration env vars and prepends --rcfile arg', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: 'bash' }));

			const env = getSpawnedEnv();
			expect(env.MAESTRO_SHELL_INTEGRATION).toBe('1');
			expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).toBe('<<bash-script>>');

			// Integration args must come BEFORE the standard `-l -i` so user
			// `shellArgs` (which are appended later) can override our flags.
			expect(getSpawnedArgs()).toEqual(['--rcfile', '/tmp/loader/bash-init.sh', '-l', '-i']);
		});

		it('classifies absolute shell paths correctly (e.g. /bin/zsh)', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: '/bin/zsh' }));

			const env = getSpawnedEnv();
			expect(env.MAESTRO_SHELL_INTEGRATION).toBe('1');
			// Spawned binary is the resolved shell path
			expect(getSpawnedCommand()).toBe('/bin/zsh');
		});

		it('is a no-op for unsupported shells (sh, fish, etc.)', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: 'fish' }));

			const env = getSpawnedEnv();
			expect(env.MAESTRO_SHELL_INTEGRATION).toBeUndefined();
			expect(getSpawnedArgs()).toEqual(['-l', '-i']);
		});

		it('places integration args before user-supplied shellArgs', () => {
			const { spawner } = createTestContext();
			spawner.spawn(
				createTerminalConfig({
					shell: 'bash',
					shellArgs: '--norc',
				})
			);

			// Layout: [integrationArgs..., -l, -i, ...userShellArgs]
			expect(getSpawnedArgs()).toEqual([
				'--rcfile',
				'/tmp/loader/bash-init.sh',
				'-l',
				'-i',
				'--norc',
			]);
		});
	});

	describe('when setting `terminalShellIntegration` is disabled', () => {
		beforeEach(() => {
			mockSetting.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'terminalShellIntegration') return false;
				return defaultValue;
			});
		});

		it('does not merge integration env vars', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: 'zsh' }));

			const env = getSpawnedEnv();
			expect(env.MAESTRO_SHELL_INTEGRATION).toBeUndefined();
			expect(env.ZDOTDIR).toBeUndefined();
		});

		it('does not prepend integration args for bash', () => {
			const { spawner } = createTestContext();
			spawner.spawn(createTerminalConfig({ shell: 'bash' }));

			expect(getSpawnedArgs()).toEqual(['-l', '-i']);
		});
	});

	describe('non-terminal sessions', () => {
		it('does not inject shell integration when toolType is not terminal', () => {
			const { spawner } = createTestContext();
			spawner.spawn({
				sessionId: 'agent-session',
				toolType: 'claude-code',
				cwd: '/tmp',
				command: 'claude',
				args: ['--print'],
				requiresPty: true,
			});

			const env = getSpawnedEnv();
			expect(env.MAESTRO_SHELL_INTEGRATION).toBeUndefined();
			// Args are exactly what was passed in
			expect(getSpawnedArgs()).toEqual(['--print']);
			expect(getSpawnedCommand()).toBe('claude');
		});
	});
});
