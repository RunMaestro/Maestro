/**
 * Tests for the process IPC handlers
 *
 * These tests verify the process lifecycle management API:
 * - spawn: Start a new process for a session
 * - write: Send input to a process
 * - interrupt: Send SIGINT to a process
 * - kill: Terminate a process
 * - resize: Resize PTY dimensions
 * - getActiveProcesses: List all running processes
 * - runCommand: Execute a single command and capture output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { ipcMain } from 'electron';
import {
	registerProcessHandlers,
	ProcessHandlerDependencies,
} from '../../../../main/ipc/handlers/process';
import { getDefaultShell } from '../../../../main/stores/defaults';
import { stripThinkingFromTranscript } from '../../../../main/agents/claude-transcript-sanitizer';
import { checkCustomPath } from '../../../../main/agents/path-prober';
import { getChildProcesses } from '../../../../main/process-manager/utils/childProcessInfo';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		on: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/agents/path-prober', () => ({
	checkCustomPath: vi.fn(async (customPath: string) => ({ exists: true, path: customPath })),
}));

// Mock the agent-args utilities
vi.mock('../../../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn((agent, opts) => opts.baseArgs || []),
	applyAgentConfigOverrides: vi.fn((agent, args, opts) => ({
		args,
		modelSource: 'none' as const,
		customArgsSource: 'none' as const,
		customEnvSource: 'none' as const,
		effectiveCustomEnvVars: undefined,
	})),
	getContextWindowValue: vi.fn(() => 0),
}));

// Mock node-pty (required for process-manager but not directly used in these tests)
vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

// Mock streamJsonBuilder for SSH image tests
vi.mock('../../../../main/process-manager/utils/streamJsonBuilder', () => ({
	buildStreamJsonMessage: vi.fn((prompt: string, images: string[]) => {
		// Return a realistic stream-json message for assertion
		const content: any[] = [];
		for (const img of images) {
			content.push({ type: 'image', source: { type: 'base64', data: img } });
		}
		content.push({ type: 'text', text: prompt });
		return JSON.stringify({ type: 'user', message: { role: 'user', content } });
	}),
}));

// Mock ssh-command-builder to handle async buildSshCommandWithStdin
// This mock dynamically builds the SSH command based on input to support all test cases
// The production code now uses buildSshCommandWithStdin (stdin-based execution) instead of buildSshCommand
vi.mock('../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommandWithStdin: vi.fn().mockImplementation(async (config, remoteOptions) => {
		const args: string[] = [];

		// Add identity file if provided
		if (config.privateKeyPath) {
			args.push('-i', config.privateKeyPath.replace('~', '/Users/test'));
		}

		// Add SSH options
		args.push('-o', 'BatchMode=yes');
		args.push('-o', 'StrictHostKeyChecking=accept-new');
		args.push('-o', 'ConnectTimeout=10');
		args.push('-o', 'RequestTTY=no');

		// Add port if not default
		if (config.port !== 22) {
			args.push('-p', config.port.toString());
		}

		// Build destination - use user@host if username provided, otherwise just host
		if (config.username && config.username.trim()) {
			args.push(`${config.username}@${config.host}`);
		} else {
			args.push(config.host);
		}

		// For stdin-based execution, the remote command is just /bin/bash
		args.push('/bin/bash');

		// Build the stdin script that would be sent to bash
		const scriptLines: string[] = [];
		scriptLines.push(
			'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"'
		);

		if (remoteOptions.cwd) {
			scriptLines.push(`cd '${remoteOptions.cwd}' || exit 1`);
		}

		// Add env vars if present
		const mergedEnv = { ...(config.remoteEnv || {}), ...(remoteOptions.env || {}) };
		for (const [key, value] of Object.entries(mergedEnv)) {
			scriptLines.push(`export ${key}='${value}'`);
		}

		// Build command with args
		const cmdWithArgs =
			`${remoteOptions.command} ${remoteOptions.args.map((a: string) => `'${a}'`).join(' ')}`.trim();
		scriptLines.push(`exec ${cmdWithArgs}`);

		let stdinScript = scriptLines.join('\n') + '\n';
		if (remoteOptions.stdinInput) {
			stdinScript += remoteOptions.stdinInput;
		}

		return { command: 'ssh', args, stdinScript };
	}),
	buildSshCommand: vi.fn().mockImplementation(async (config, remoteOptions) => {
		// Legacy function - kept for backwards compatibility but tests primarily use buildSshCommandWithStdin
		const args: string[] = ['-tt'];

		if (config.privateKeyPath) {
			args.push('-i', config.privateKeyPath.replace('~', '/Users/test'));
		}

		args.push('-o', 'BatchMode=yes');
		args.push('-o', 'StrictHostKeyChecking=accept-new');
		args.push('-o', 'ConnectTimeout=10');

		if (config.port !== 22) {
			args.push('-p', config.port.toString());
		}

		if (config.username && config.username.trim()) {
			args.push(`${config.username}@${config.host}`);
		} else {
			args.push(config.host);
		}

		const commandParts: string[] = [];
		if (remoteOptions.cwd) {
			commandParts.push(`cd '${remoteOptions.cwd}'`);
		}

		const mergedEnv = { ...(config.remoteEnv || {}), ...(remoteOptions.env || {}) };
		const envParts: string[] = [];
		for (const [key, value] of Object.entries(mergedEnv)) {
			envParts.push(`${key}='${value}'`);
		}

		const cmdWithArgs =
			`'${remoteOptions.command}' ${remoteOptions.args.map((a: string) => `'${a}'`).join(' ')}`.trim();
		const fullCmd = envParts.length > 0 ? `${envParts.join(' ')} ${cmdWithArgs}` : cmdWithArgs;
		commandParts.push(fullCmd);

		const remoteCommand = commandParts.join(' && ');
		args.push(`$SHELL -lc "${remoteCommand}"`);

		return { command: 'ssh', args };
	}),
	buildRemoteCommand: vi.fn((opts) => {
		const parts: string[] = [];
		if (opts.cwd) {
			parts.push(`cd '${opts.cwd}'`);
		}
		const envParts: string[] = [];
		if (opts.env) {
			for (const [key, value] of Object.entries(opts.env)) {
				envParts.push(`${key}='${value}'`);
			}
		}
		const cmdWithArgs =
			`'${opts.command}' ${opts.args.map((a: string) => `'${a}'`).join(' ')}`.trim();
		const fullCmd = envParts.length > 0 ? `${envParts.join(' ')} ${cmdWithArgs}` : cmdWithArgs;
		parts.push(fullCmd);
		return parts.join(' && ');
	}),
}));

// Mock cliDetection to provide a resolved SSH path
vi.mock('../../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn().mockResolvedValue('ssh'),
	getExpandedEnv: vi.fn(() => ({ ...process.env })),
}));

// Mock platformDetection. Default mirrors the host so the existing
// `appendSystemPrompt delivery` test still picks the right branch on
// Windows CI; new tests override per-case with mockReturnValue(true).
vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => process.platform === 'win32'),
	isMacOS: vi.fn(() => process.platform === 'darwin'),
	isLinux: vi.fn(() => process.platform === 'linux'),
}));

vi.mock('../../../../main/process-manager/utils/childProcessInfo', () => ({
	getChildProcesses: vi.fn().mockResolvedValue([]),
}));

// Mock fs/promises so the new temp-file tests can assert on writeFile/unlink
// without touching the real filesystem. Other tests in this file don't use
// fs/promises, so the module-level mock is safe.
vi.mock('fs/promises', () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock sentry - captureException is asserted on by the new cleanup-error
// tests; addBreadcrumb is a no-op stub so existing tests don't hit real Sentry.
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	addBreadcrumb: vi.fn(),
}));

// Mock the transcript sanitizer so the API-resume gate can be asserted without
// touching a real Claude Code transcript on disk.
vi.mock('../../../../main/agents/claude-transcript-sanitizer', () => ({
	stripThinkingFromTranscript: vi.fn(() => ({
		sanitized: false,
		droppedRows: 0,
		strippedBlocks: 0,
		backupPath: null,
	})),
}));

// Mock the prompt manager so the copilot-preamble injection has deterministic
// content without bootstrapping the real prompt cache. Per-test overrides use
// mockReturnValueOnce / mockImplementation.
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => {
		if (id === 'copilot-preamble') return 'COPILOT_PREAMBLE_TEXT';
		return '';
	}),
}));

describe('process IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockProcessManager: {
		spawn: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		interrupt: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		resize: ReturnType<typeof vi.fn>;
		getAll: ReturnType<typeof vi.fn>;
		get: ReturnType<typeof vi.fn>;
		runCommand: ReturnType<typeof vi.fn>;
		spawnTerminalTab: ReturnType<typeof vi.fn>;
	};
	let mockAgentDetector: {
		getAgent: ReturnType<typeof vi.fn>;
	};
	let mockAgentConfigsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let mockSettingsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let mockSessionsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let deps: ProcessHandlerDependencies;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();
		vi.mocked(checkCustomPath).mockImplementation(async (customPath) => ({
			exists: true,
			path: customPath,
		}));

		// Create mock process manager
		mockProcessManager = {
			spawn: vi.fn(),
			write: vi.fn(),
			interrupt: vi.fn(),
			kill: vi.fn(),
			resize: vi.fn(),
			getAll: vi.fn(),
			get: vi.fn(),
			runCommand: vi.fn(),
			spawnTerminalTab: vi.fn(),
		};

		// Create mock agent detector
		mockAgentDetector = {
			getAgent: vi.fn(),
		};

		// Create mock config store
		mockAgentConfigsStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
		};

		// Create mock settings store
		mockSettingsStore = {
			get: vi.fn().mockImplementation((_key, defaultValue) => defaultValue),
			set: vi.fn(),
		};

		// Create mock sessions store. Defaults to an empty session list so the
		// spawn handler's stale-claudeInteractive cleanup branch reads cleanly.
		mockSessionsStore = {
			get: vi.fn().mockImplementation((_key, defaultValue) => defaultValue),
			set: vi.fn(),
		};

		// Create mock main window for SSH remote event emission
		const mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				send: vi.fn(),
				isDestroyed: vi.fn().mockReturnValue(false),
			},
		};

		// Create dependencies
		deps = {
			getProcessManager: () => mockProcessManager as any,
			getAgentDetector: () => mockAgentDetector as any,
			agentConfigsStore: mockAgentConfigsStore as any,
			settingsStore: mockSettingsStore as any,
			sessionsStore: mockSessionsStore as any,
			getMainWindow: () => mockMainWindow as any,
		};

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerProcessHandlers(deps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all process handlers', () => {
			const expectedChannels = [
				'concerto-html:restore',
				'process:spawn',
				'process:write',
				'process:broadcast-user-input',
				'process:interrupt',
				'process:kill',
				'process:resize',
				'process:getActiveProcesses',
				'process:isTerminalBusy',
				'process:spawnTerminalTab',
				'process:runCommand',
				'permission:respond',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
			expect(ipcMain.on).toHaveBeenCalledWith('concerto-html:release', expect.any(Function));
		});
	});

	describe('Concerto HTML restore', () => {
		it('restores a validated recently closed document', async () => {
			const handler = handlers.get('concerto-html:restore');

			const revision = await handler!({}, 'movement', 'mockup', '<button>Fresh</button>');

			expect(revision).toBeTypeOf('number');
		});

		it('rejects an invalid restore request', async () => {
			const handler = handlers.get('concerto-html:restore');

			await expect(handler!({}, 'bogus', '', null)).rejects.toThrow(
				'Invalid Concerto HTML restore request'
			);
		});
	});

	describe('process:spawn', () => {
		it('should spawn PTY process with correct args', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: true,
				path: '/usr/local/bin/claude',
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/test/project',
				command: 'claude',
				args: ['--print', '--verbose'],
			});

			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					toolType: 'claude-code',
					cwd: '/test/project',
					command: 'claude',
					requiresPty: true,
				})
			);
			expect(result).toEqual({ pid: 12345, success: true });
		});

		it('should return pid on successful spawn', async () => {
			const mockAgent = { id: 'terminal', requiresPty: true };

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 99999, success: true });

			const handler = handlers.get('process:spawn');
			const result = await handler!({} as any, {
				sessionId: 'session-2',
				toolType: 'terminal',
				cwd: '/home/user',
				command: '/bin/zsh',
				args: [],
			});

			expect(result.pid).toBe(99999);
			expect(result.success).toBe(true);
		});

		it('should handle spawn failure', async () => {
			const mockAgent = { id: 'claude-code' };

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: -1, success: false });

			const handler = handlers.get('process:spawn');
			const result = await handler!({} as any, {
				sessionId: 'session-3',
				toolType: 'claude-code',
				cwd: '/test',
				command: 'invalid-command',
				args: [],
			});

			expect(result.pid).toBe(-1);
			expect(result.success).toBe(false);
		});

		it('should pass environment variables to spawn', async () => {
			const mockAgent = {
				id: 'claude-code',
				requiresPty: false,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 1000, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-4',
				toolType: 'claude-code',
				cwd: '/test',
				command: 'claude',
				args: [],
				sessionCustomEnvVars: { API_KEY: 'secret123' },
			});

			expect(mockProcessManager.spawn).toHaveBeenCalled();
		});

		it('should apply readOnlyEnvOverrides when readOnlyMode is true', async () => {
			const { applyAgentConfigOverrides } = await import('../../../../main/utils/agent-args');
			const mockApply = vi.mocked(applyAgentConfigOverrides);

			// Simulate agent with YOLO env vars returned by applyAgentConfigOverrides
			mockApply.mockReturnValueOnce({
				args: [],
				modelSource: 'default',
				customArgsSource: 'none',
				customEnvSource: 'none',
				effectiveCustomEnvVars: {
					OPENCODE_CONFIG_CONTENT:
						'{"permission":{"*":"allow","question":"deny"},"tools":{"question":false}}',
				},
			});

			const mockAgent = {
				id: 'opencode',
				requiresPty: false,
				readOnlyEnvOverrides: {
					OPENCODE_CONFIG_CONTENT: '{"permission":{"question":"deny"},"tools":{"question":false}}',
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 2000, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-readonly-env',
				toolType: 'opencode',
				cwd: '/test',
				command: 'opencode',
				args: [],
				readOnlyMode: true,
			});

			// The spawn call should receive the overridden env vars (without blanket permissions)
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					customEnvVars: expect.objectContaining({
						OPENCODE_CONFIG_CONTENT:
							'{"permission":{"question":"deny"},"tools":{"question":false}}',
					}),
				})
			);
		});

		it('should NOT apply readOnlyEnvOverrides when readOnlyMode is false', async () => {
			const { applyAgentConfigOverrides } = await import('../../../../main/utils/agent-args');
			const mockApply = vi.mocked(applyAgentConfigOverrides);

			const yoloConfig =
				'{"permission":{"*":"allow","question":"deny"},"tools":{"question":false}}';
			mockApply.mockReturnValueOnce({
				args: [],
				modelSource: 'default',
				customArgsSource: 'none',
				customEnvSource: 'none',
				effectiveCustomEnvVars: { OPENCODE_CONFIG_CONTENT: yoloConfig },
			});

			const mockAgent = {
				id: 'opencode',
				requiresPty: false,
				readOnlyEnvOverrides: {
					OPENCODE_CONFIG_CONTENT: '{"permission":{"question":"deny"},"tools":{"question":false}}',
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 2001, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-not-readonly',
				toolType: 'opencode',
				cwd: '/test',
				command: 'opencode',
				args: [],
				// readOnlyMode not set (defaults to undefined/false)
			});

			// The spawn call should keep the original YOLO env vars
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					customEnvVars: expect.objectContaining({
						OPENCODE_CONFIG_CONTENT: yoloConfig,
					}),
				})
			);
		});

		it('should use sessionCustomPath for local execution when provided', async () => {
			// When user sets a custom path for a session, it should be used for the command
			// This allows users to use a different binary (e.g., a wrapper script)
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				path: '/usr/local/bin/claude', // Detected path
				requiresPty: true,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-custom-path',
				toolType: 'claude-code',
				cwd: '/test/project',
				command: '/usr/local/bin/claude', // Original detected command
				args: ['--print', '--verbose'],
				sessionCustomPath: '/home/user/my-claude-wrapper', // User's custom path
			});

			// Should use the custom path, not the original command
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/home/user/my-claude-wrapper',
				})
			);
		});

		it('should resolve a rotated local custom path before spawning', async () => {
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: '/detected/codex',
				requiresPty: false,
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });
			vi.mocked(checkCustomPath).mockResolvedValueOnce({
				exists: true,
				path: '/current/codex',
			});

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-rotated-path',
				toolType: 'codex',
				cwd: '/test/project',
				command: '/detected/codex',
				args: ['exec'],
				sessionCustomPath: '/stale/codex',
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/current/codex',
					extraPathDirs: ['/current'],
					sessionCustomPath: '/current/codex',
				})
			);
		});

		it('should fall back to the detected path when a local custom path is invalid', async () => {
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: '/detected/codex',
				requiresPty: false,
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });
			vi.mocked(checkCustomPath).mockResolvedValueOnce({ exists: false });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-invalid-path',
				toolType: 'codex',
				cwd: '/test/project',
				command: 'codex',
				args: ['exec'],
				sessionCustomPath: '/missing/codex',
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/detected/codex',
					extraPathDirs: ['/detected'],
					sessionCustomPath: undefined,
				})
			);
		});

		it('should use original command when sessionCustomPath is not provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				path: '/usr/local/bin/claude',
				requiresPty: true,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-no-custom-path',
				toolType: 'claude-code',
				cwd: '/test/project',
				command: '/usr/local/bin/claude',
				args: ['--print', '--verbose'],
				// No sessionCustomPath provided
			});

			// Should use the original command
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/usr/local/bin/claude',
				})
			);
		});

		it('should use default shell for terminal sessions', async () => {
			const mockAgent = { id: 'terminal', requiresPty: true };

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'defaultShell') return 'fish';
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 1001, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-5',
				toolType: 'terminal',
				cwd: '/test',
				command: '/bin/fish',
				args: [],
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: 'fish',
				})
			);
		});

		it('should pass promptArgs to spawn for agents that use flag-based prompts (like OpenCode -p)', async () => {
			// This test ensures promptArgs is passed through to ProcessManager.spawn
			// OpenCode uses promptArgs: (prompt) => ['-p', prompt] for YOLO mode
			const mockPromptArgs = (prompt: string) => ['-p', prompt];
			const mockAgent = {
				id: 'opencode',
				requiresPty: false,
				promptArgs: mockPromptArgs,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 2001, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-opencode',
				toolType: 'opencode',
				cwd: '/test/project',
				command: 'opencode',
				args: ['--format', 'json'],
				prompt: 'test prompt for opencode',
			});

			// Verify promptArgs function is passed to spawn
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-opencode',
					toolType: 'opencode',
					promptArgs: mockPromptArgs,
				})
			);
		});

		it('should NOT pass promptArgs for agents that use positional prompts (like Claude)', async () => {
			// Claude uses positional args with -- separator, not promptArgs
			const mockAgent = {
				id: 'claude-code',
				requiresPty: false,
				// Note: no promptArgs defined
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 2002, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-claude',
				toolType: 'claude-code',
				cwd: '/test/project',
				command: 'claude',
				args: ['--print', '--verbose'],
				prompt: 'test prompt for claude',
			});

			// Verify promptArgs is undefined for Claude
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-claude',
					toolType: 'claude-code',
					promptArgs: undefined,
				})
			);
		});

		// Batch Mode default-off: when `enableMaestroP` isn't set on the spawn
		// config, the resolver is skipped entirely and API-mode args pass through.
		// (Tests for the toggle-on path live in claude-mode-selector.test.ts and the
		// integration story for the binary swap is exercised via manual QA - the
		// swap depends on fs.existsSync + an actual snapshot which is awkward to
		// stub at the IPC layer.)
		describe('Batch Mode gating', () => {
			const claudeCodeAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				command: 'claude',
				path: '/opt/homebrew/bin/claude',
				args: ['--print', '--verbose', '--output-format', 'stream-json'],
				apiCommand: 'claude',
				interactiveCommand: 'maestro-p',
				interactiveModeArgs: ['--dangerously-skip-permissions'],
				requiresPty: true,
			};

			it('leaves API-mode args intact when Batch Mode is off (default)', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4244, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-default',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					prompt: 'hi',
				});

				const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
				expect(spawnCall.args).toContain('--print');
				expect(spawnCall.args).toContain('--verbose');
				expect(spawnCall.args).toContain('--output-format');
				expect(spawnCall.args).toContain('stream-json');
				expect(spawnCall.customEnvVars?.ELECTRON_RUN_AS_NODE).toBeUndefined();
			});

			it('passes Electron Node mode env for local interactive maestro-p desktop spawn', async () => {
				const maestroPPath = path.join(process.cwd(), 'src', 'maestro-p', 'index.ts');
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4243, success: true });
				mockSessionsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
					if (key === 'sessions') {
						return [
							{
								id: 'session-tui',
								enableMaestroP: true,
								maestroPMode: 'interactive',
								maestroPPath,
							},
						];
					}
					return defaultValue;
				});

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-tui-ai-tab-1',
					toolType: 'claude-code',
					cwd: '/test',
					command: '/usr/local/bin/claude',
					args: claudeCodeAgent.args,
					prompt: 'hi',
				});

				const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
				expect(spawnCall.command).toBe(process.execPath);
				expect(spawnCall.args[0]).toBe(maestroPPath);
				expect(spawnCall.args).toContain('--dangerously-skip-permissions');
				expect(spawnCall.customEnvVars).toEqual(
					expect.objectContaining({
						ELECTRON_RUN_AS_NODE: '1',
						MAESTRO_CLAUDE_BIN: '/usr/local/bin/claude',
					})
				);
				expect(spawnCall.customEnvVars?.NODE_PATH).toBeUndefined();
			});

			it('adds packaged NODE_PATH while preserving Electron Node mode env', async () => {
				const maestroPPath = path.join(process.cwd(), 'src', 'maestro-p', 'index.ts');
				const resourcesPath = '/Applications/Maestro.app/Contents/Resources';
				const existingNodePath = '/already/on/node-path';
				const originalNodePath = process.env.NODE_PATH;
				const originalResourcesDescriptor = Object.getOwnPropertyDescriptor(
					process,
					'resourcesPath'
				);

				Object.defineProperty(process, 'resourcesPath', {
					configurable: true,
					value: resourcesPath,
				});
				process.env.NODE_PATH = existingNodePath;

				try {
					mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
					mockProcessManager.spawn.mockReturnValue({ pid: 4242, success: true });
					mockSessionsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
						if (key === 'sessions') {
							return [
								{
									id: 'session-packaged-tui',
									enableMaestroP: true,
									maestroPMode: 'interactive',
									maestroPPath,
								},
							];
						}
						return defaultValue;
					});

					const handler = handlers.get('process:spawn');
					await handler!({} as any, {
						sessionId: 'session-packaged-tui',
						toolType: 'claude-code',
						cwd: '/test',
						command: 'claude',
						args: claudeCodeAgent.args,
						prompt: 'hi',
					});

					const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
					const expectedAsarModules = path.join(resourcesPath, 'app.asar', 'node_modules');
					expect(spawnCall.command).toBe(process.execPath);
					expect(spawnCall.customEnvVars).toEqual(
						expect.objectContaining({
							ELECTRON_RUN_AS_NODE: '1',
							MAESTRO_CLAUDE_BIN: '/opt/homebrew/bin/claude',
							NODE_PATH: `${expectedAsarModules}${path.delimiter}${existingNodePath}`,
						})
					);
				} finally {
					if (originalNodePath === undefined) {
						delete process.env.NODE_PATH;
					} else {
						process.env.NODE_PATH = originalNodePath;
					}
					if (originalResourcesDescriptor) {
						Object.defineProperty(process, 'resourcesPath', originalResourcesDescriptor);
					} else {
						delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
					}
				}
			});

			it('emits interactive resolution when Path is wired directly at maestro-p', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4245, success: true });
				const sendSpy = vi.fn();
				deps = {
					...deps,
					getMainWindow: () =>
						({
							isDestroyed: vi.fn().mockReturnValue(false),
							webContents: {
								send: sendSpy,
								isDestroyed: vi.fn().mockReturnValue(false),
							},
						}) as any,
				};
				handlers.clear();
				vi.mocked(ipcMain.handle).mockImplementation((channel, h) => {
					handlers.set(channel, h);
				});
				registerProcessHandlers(deps);

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-direct-mp',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					sessionCustomPath: '/Users/x/dist/cli/maestro-p.js',
					prompt: 'hi',
				});

				const resolveCalls = sendSpy.mock.calls.filter(
					(c) => c[0] === 'process:claude-mode-resolved'
				);
				expect(resolveCalls.length).toBeGreaterThan(0);
				const [, sessionId, payload] = resolveCalls[0];
				expect(sessionId).toBe('session-direct-mp');
				expect(payload.mode).toBe('interactive');
				expect(payload.reason).toBe('auto');

				const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
				expect(spawnCall.command).toBe('/Users/x/dist/cli/maestro-p.js');
				expect(spawnCall.customEnvVars?.ELECTRON_RUN_AS_NODE).toBeUndefined();
			});

			it('clears stale claudeInteractive=interactive when neither toggle nor maestro-p Path is active', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4246, success: true });

				// Stage a prior interactive run on this session so the cleanup branch fires.
				mockSessionsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
					if (key === 'sessions') {
						return [
							{
								id: 'session-stale',
								claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
							},
						];
					}
					return defaultValue;
				});

				const sendSpy = vi.fn();
				deps = {
					...deps,
					getMainWindow: () =>
						({
							isDestroyed: vi.fn().mockReturnValue(false),
							webContents: {
								send: sendSpy,
								isDestroyed: vi.fn().mockReturnValue(false),
							},
						}) as any,
				};
				handlers.clear();
				vi.mocked(ipcMain.handle).mockImplementation((channel, h) => {
					handlers.set(channel, h);
				});
				registerProcessHandlers(deps);

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-stale',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					prompt: 'hi',
				});

				const persisted = mockSessionsStore.set.mock.calls.find((c) => c[0] === 'sessions');
				expect(persisted).toBeDefined();
				const nextSessions = persisted![1] as Array<{ id: string; claudeInteractive: any }>;
				const stale = nextSessions.find((s) => s.id === 'session-stale');
				expect(stale?.claudeInteractive?.mode).toBe('api');

				const resolveCalls = sendSpy.mock.calls.filter(
					(c) => c[0] === 'process:claude-mode-resolved'
				);
				expect(resolveCalls.length).toBeGreaterThan(0);
				expect(resolveCalls[0][2].mode).toBe('api');
			});

			// Regression: desktop turns spawn with a COMPOUND session id
			// (`{agentId}-ai-{tabId}`), but persisted session records are keyed by the
			// bare agent id. The handler must strip the `-ai-…` suffix before the
			// token-mode lookup AND the claudeInteractive write-back, or every desktop
			// claude-code turn misses its persisted record and silently resolves to
			// `api` (`claude --print`) regardless of the agent's TUI/Dynamic setting.
			// Staging a stale `interactive` record under the bare id and spawning with
			// the compound id exercises both: the resolver only sees the persisted
			// state (and clears it to `api`) when the suffix is stripped on both sides.
			it('matches the bare-id persisted record when spawned with a compound -ai- session id', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4250, success: true });

				mockSessionsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
					if (key === 'sessions') {
						return [
							{
								id: 'session-rc',
								claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
							},
						];
					}
					return defaultValue;
				});

				const sendSpy = vi.fn();
				deps = {
					...deps,
					getMainWindow: () =>
						({
							isDestroyed: vi.fn().mockReturnValue(false),
							webContents: {
								send: sendSpy,
								isDestroyed: vi.fn().mockReturnValue(false),
							},
						}) as any,
				};
				handlers.clear();
				vi.mocked(ipcMain.handle).mockImplementation((channel, h) => {
					handlers.set(channel, h);
				});
				registerProcessHandlers(deps);

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-rc-ai-tab-abc123',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					prompt: 'hi',
				});

				// Write-back found the bare-id record and cleared the stale interactive state.
				const persisted = mockSessionsStore.set.mock.calls.find((c) => c[0] === 'sessions');
				expect(persisted).toBeDefined();
				const nextSessions = persisted![1] as Array<{ id: string; claudeInteractive: any }>;
				const rc = nextSessions.find((s) => s.id === 'session-rc');
				expect(rc?.claudeInteractive?.mode).toBe('api');

				// The renderer mirror carries the original compound id (it strips the
				// suffix on its own side), so the spawner must NOT pre-strip it here.
				const resolveCalls = sendSpy.mock.calls.filter(
					(c) => c[0] === 'process:claude-mode-resolved'
				);
				expect(resolveCalls.length).toBeGreaterThan(0);
				expect(resolveCalls[0][1]).toBe('session-rc-ai-tab-abc123');
			});

			// Once a conversation has run interactive, its transcript can hold
			// subscription-account thinking blocks. Resuming it in API mode must
			// strip them first, or Anthropic returns the "thinking blocks cannot be
			// modified" 400 and the conversation stays permanently stuck.
			it('sanitizes the transcript before an API-mode resume of a previously-interactive session', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4247, success: true });

				// Stage a prior interactive run so the cleanup branch sets the config-dir key.
				mockSessionsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
					if (key === 'sessions') {
						return [
							{
								id: 'session-resume',
								claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
							},
						];
					}
					return defaultValue;
				});

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-resume',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					agentSessionId: 'prior-session-uuid', // Resume signal
					prompt: 'continue',
				});

				expect(stripThinkingFromTranscript).toHaveBeenCalledTimes(1);
				const calledPath = vi.mocked(stripThinkingFromTranscript).mock.calls[0][0];
				expect(calledPath).toContain('prior-session-uuid.jsonl');
			});

			it('does not sanitize a fresh pure-API spawn (no resume, nothing on disk to touch)', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4248, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-fresh',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					prompt: 'hi',
				});

				expect(stripThinkingFromTranscript).not.toHaveBeenCalled();
			});

			// The original gate skipped sanitization when no `resolvedConfigDirKey`
			// was set, which left transcripts poisoned for sessions where Batch Mode
			// had since been toggled off (or where the persisted mode flipped to
			// `'api'` via sticky-limit). The narrowed sanitizer (empty-shell only)
			// is safe to run on any resume, so the gate now only requires an
			// `agentSessionId` and Claude Code in API mode.
			it('sanitizes any API-mode resume of a Claude Code session, even without persisted interactive history', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4249, success: true });

				// No prior interactive run persisted - this used to skip the sanitize
				// because resolvedConfigDirKey stayed undefined.
				mockSessionsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
					if (key === 'sessions') return [];
					return defaultValue;
				});

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-resume-no-history',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					agentSessionId: 'orphaned-transcript-uuid',
					prompt: 'continue',
				});

				expect(stripThinkingFromTranscript).toHaveBeenCalledTimes(1);
				const calledPath = vi.mocked(stripThinkingFromTranscript).mock.calls[0][0];
				expect(calledPath).toContain('orphaned-transcript-uuid.jsonl');
			});

			it('does not sanitize SSH-enabled spawns (transcript lives on remote, not local disk)', async () => {
				mockAgentDetector.getAgent.mockResolvedValue(claudeCodeAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 4250, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, {
					sessionId: 'session-ssh',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: claudeCodeAgent.args,
					agentSessionId: 'remote-session-uuid',
					prompt: 'continue',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				});

				expect(stripThinkingFromTranscript).not.toHaveBeenCalled();
			});
		});
	});

	describe('process:write', () => {
		it('should write data to process stdin', async () => {
			mockProcessManager.write.mockReturnValue(true);

			const handler = handlers.get('process:write');
			const result = await handler!({} as any, 'session-1', 'hello world\n');

			expect(mockProcessManager.write).toHaveBeenCalledWith('session-1', 'hello world\n');
			expect(result).toBe(true);
		});

		it('should handle invalid session id (no process found)', async () => {
			mockProcessManager.write.mockReturnValue(false);

			const handler = handlers.get('process:write');
			const result = await handler!({} as any, 'invalid-session', 'test');

			expect(mockProcessManager.write).toHaveBeenCalledWith('invalid-session', 'test');
			expect(result).toBe(false);
		});

		it('should handle write to already exited process', async () => {
			mockProcessManager.write.mockReturnValue(false);

			const handler = handlers.get('process:write');
			const result = await handler!({} as any, 'exited-session', 'data');

			expect(result).toBe(false);
		});
	});

	describe('process:kill', () => {
		it('should kill process by session id', async () => {
			mockProcessManager.kill.mockReturnValue(true);

			const handler = handlers.get('process:kill');
			const result = await handler!({} as any, 'session-to-kill');

			expect(mockProcessManager.kill).toHaveBeenCalledWith('session-to-kill');
			expect(result).toBe(true);
		});

		it('should handle already dead process', async () => {
			mockProcessManager.kill.mockReturnValue(false);

			const handler = handlers.get('process:kill');
			const result = await handler!({} as any, 'already-dead-session');

			expect(mockProcessManager.kill).toHaveBeenCalledWith('already-dead-session');
			expect(result).toBe(false);
		});

		it('should return false for non-existent session', async () => {
			mockProcessManager.kill.mockReturnValue(false);

			const handler = handlers.get('process:kill');
			const result = await handler!({} as any, 'non-existent');

			expect(result).toBe(false);
		});
	});

	describe('process:interrupt', () => {
		it('should send SIGINT to process', async () => {
			mockProcessManager.interrupt.mockReturnValue(true);

			const handler = handlers.get('process:interrupt');
			const result = await handler!({} as any, 'session-to-interrupt');

			expect(mockProcessManager.interrupt).toHaveBeenCalledWith('session-to-interrupt');
			expect(result).toBe(true);
		});

		it('should return false for non-existent process', async () => {
			mockProcessManager.interrupt.mockReturnValue(false);

			const handler = handlers.get('process:interrupt');
			const result = await handler!({} as any, 'non-existent');

			expect(result).toBe(false);
		});
	});

	describe('process:resize', () => {
		it('should resize PTY dimensions', async () => {
			mockProcessManager.resize.mockReturnValue(true);

			const handler = handlers.get('process:resize');
			const result = await handler!({} as any, 'terminal-session', 120, 40);

			expect(mockProcessManager.resize).toHaveBeenCalledWith('terminal-session', 120, 40);
			expect(result).toBe(true);
		});

		it('should handle invalid dimensions gracefully', async () => {
			mockProcessManager.resize.mockReturnValue(false);

			const handler = handlers.get('process:resize');
			const result = await handler!({} as any, 'session', -1, -1);

			expect(mockProcessManager.resize).toHaveBeenCalledWith('session', -1, -1);
			expect(result).toBe(false);
		});

		it('should handle invalid session id', async () => {
			mockProcessManager.resize.mockReturnValue(false);

			const handler = handlers.get('process:resize');
			const result = await handler!({} as any, 'invalid-session', 80, 24);

			expect(result).toBe(false);
		});
	});

	describe('process:getActiveProcesses', () => {
		it('should return list of running processes', async () => {
			const mockProcesses = [
				{
					sessionId: 'session-1',
					toolType: 'claude-code',
					pid: 1234,
					cwd: '/project1',
					isTerminal: false,
					isBatchMode: false,
					startTime: 1700000000000,
					command: 'claude',
					args: ['--print'],
				},
				{
					sessionId: 'session-2',
					toolType: 'terminal',
					pid: 5678,
					cwd: '/project2',
					isTerminal: true,
					isBatchMode: false,
					startTime: 1700000001000,
					command: '/bin/zsh',
					args: [],
				},
			];

			mockProcessManager.getAll.mockReturnValue(mockProcesses);

			const handler = handlers.get('process:getActiveProcesses');
			const result = await handler!({} as any);

			expect(mockProcessManager.getAll).toHaveBeenCalled();
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				sessionId: 'session-1',
				toolType: 'claude-code',
				pid: 1234,
				cwd: '/project1',
				isTerminal: false,
				isBatchMode: false,
				startTime: 1700000000000,
				command: 'claude',
				args: ['--print'],
			});
		});

		it('should return empty array when no processes running', async () => {
			mockProcessManager.getAll.mockReturnValue([]);

			const handler = handlers.get('process:getActiveProcesses');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should skip terminal child-process inspection when requested', async () => {
			mockProcessManager.getAll.mockReturnValue([
				{
					sessionId: 'session-2-terminal',
					toolType: 'terminal',
					pid: 5678,
					cwd: '/project2',
					isTerminal: true,
					isBatchMode: false,
					startTime: 1700000001000,
					command: '/bin/zsh',
					args: [],
				},
			]);

			const handler = handlers.get('process:getActiveProcesses');
			const result = await handler!({} as any, { includeChildProcesses: false });

			expect(result).toHaveLength(1);
			expect(getChildProcesses).not.toHaveBeenCalled();
		});

		it('should strip non-serializable properties from process objects', async () => {
			const mockProcesses = [
				{
					sessionId: 'session-1',
					toolType: 'claude-code',
					pid: 1234,
					cwd: '/project',
					isTerminal: false,
					isBatchMode: true,
					startTime: 1700000000000,
					command: 'claude',
					args: [],
					// These non-serializable properties should not appear in output
					ptyProcess: { some: 'pty-object' },
					childProcess: { some: 'child-object' },
					outputParser: { parse: () => {} },
				},
			];

			mockProcessManager.getAll.mockReturnValue(mockProcesses);

			const handler = handlers.get('process:getActiveProcesses');
			const result = await handler!({} as any);

			expect(result[0]).not.toHaveProperty('ptyProcess');
			expect(result[0]).not.toHaveProperty('childProcess');
			expect(result[0]).not.toHaveProperty('outputParser');
			expect(result[0]).toHaveProperty('sessionId');
			expect(result[0]).toHaveProperty('pid');
		});
	});

	describe('process:isTerminalBusy', () => {
		it('returns false when no managed process exists for the session id', async () => {
			mockProcessManager.get.mockReturnValue(undefined);

			const handler = handlers.get('process:isTerminalBusy');
			const result = await handler!({} as any, 'session-1-terminal-tab-1');

			expect(mockProcessManager.get).toHaveBeenCalledWith('session-1-terminal-tab-1');
			expect(result).toBe(false);
		});

		it('returns false when the PTY foreground process matches the shell', async () => {
			mockProcessManager.get.mockReturnValue({
				command: '/bin/zsh',
				ptyProcess: { process: 'zsh' },
			});

			const handler = handlers.get('process:isTerminalBusy');
			const result = await handler!({} as any, 'session-1-terminal-tab-1');

			expect(result).toBe(false);
		});

		it('returns true when the PTY foreground process differs from the shell', async () => {
			mockProcessManager.get.mockReturnValue({
				command: '/bin/zsh',
				ptyProcess: { process: 'vim' },
			});

			const handler = handlers.get('process:isTerminalBusy');
			const result = await handler!({} as any, 'session-1-terminal-tab-1');

			expect(result).toBe(true);
		});

		it('returns false when the managed process has no ptyProcess', async () => {
			mockProcessManager.get.mockReturnValue({
				command: '/bin/zsh',
				ptyProcess: undefined,
			});

			const handler = handlers.get('process:isTerminalBusy');
			const result = await handler!({} as any, 'session-1-terminal-tab-1');

			expect(result).toBe(false);
		});
	});

	describe('process:runCommand', () => {
		it('should execute command and return exit code', async () => {
			mockProcessManager.runCommand.mockResolvedValue({ exitCode: 0 });

			const handler = handlers.get('process:runCommand');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				command: 'ls -la',
				cwd: '/test/dir',
			});

			expect(mockProcessManager.runCommand).toHaveBeenCalledWith(
				'session-1',
				'ls -la',
				'/test/dir',
				getDefaultShell(), // default shell
				{}, // shell env vars
				null // sshRemoteConfig (not set in this test)
			);
			expect(result).toEqual({ exitCode: 0 });
		});

		it('should use custom shell from settings', async () => {
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'defaultShell') return 'fish';
				if (key === 'customShellPath') return '';
				if (key === 'shellEnvVars') return { CUSTOM_VAR: 'value' };
				return defaultValue;
			});
			mockProcessManager.runCommand.mockResolvedValue({ exitCode: 0 });

			const handler = handlers.get('process:runCommand');
			await handler!({} as any, {
				sessionId: 'session-1',
				command: 'echo test',
				cwd: '/test',
			});

			expect(mockProcessManager.runCommand).toHaveBeenCalledWith(
				'session-1',
				'echo test',
				'/test',
				'fish',
				{ CUSTOM_VAR: 'value' },
				null // sshRemoteConfig (not set in this test)
			);
		});

		it('should use custom shell path when set', async () => {
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'defaultShell') return 'zsh';
				if (key === 'customShellPath') return '/opt/custom/shell';
				if (key === 'shellEnvVars') return {};
				return defaultValue;
			});
			mockProcessManager.runCommand.mockResolvedValue({ exitCode: 0 });

			const handler = handlers.get('process:runCommand');
			await handler!({} as any, {
				sessionId: 'session-1',
				command: 'pwd',
				cwd: '/test',
			});

			expect(mockProcessManager.runCommand).toHaveBeenCalledWith(
				'session-1',
				'pwd',
				'/test',
				'/opt/custom/shell',
				{},
				null // sshRemoteConfig (not set in this test)
			);
		});

		it('should return non-zero exit code on command failure', async () => {
			mockProcessManager.runCommand.mockResolvedValue({ exitCode: 1 });

			const handler = handlers.get('process:runCommand');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				command: 'false',
				cwd: '/test',
			});

			expect(result.exitCode).toBe(1);
		});
	});

	describe('error handling', () => {
		it('should throw error when process manager is not available', async () => {
			// Create deps with null process manager
			const nullDeps: ProcessHandlerDependencies = {
				getProcessManager: () => null,
				getAgentDetector: () => mockAgentDetector as any,
				agentConfigsStore: mockAgentConfigsStore as any,
				settingsStore: mockSettingsStore as any,
			};

			// Re-register handlers with null process manager
			handlers.clear();
			registerProcessHandlers(nullDeps);

			const handler = handlers.get('process:write');

			await expect(handler!({} as any, 'session', 'data')).rejects.toThrow('Process manager');
		});

		it('should throw error when agent detector is not available for spawn', async () => {
			// Create deps with null agent detector
			const nullDeps: ProcessHandlerDependencies = {
				getProcessManager: () => mockProcessManager as any,
				getAgentDetector: () => null,
				agentConfigsStore: mockAgentConfigsStore as any,
				settingsStore: mockSettingsStore as any,
			};

			// Re-register handlers with null agent detector
			handlers.clear();
			registerProcessHandlers(nullDeps);

			const handler = handlers.get('process:spawn');

			await expect(
				handler!({} as any, {
					sessionId: 'session',
					toolType: 'claude-code',
					cwd: '/test',
					command: 'claude',
					args: [],
				})
			).rejects.toThrow('Agent detector');
		});
	});

	describe('process:spawnTerminalTab', () => {
		const mockSshRemoteForTerminal = {
			id: 'remote-1',
			name: 'Dev Server',
			host: 'dev.example.com',
			port: 22,
			username: 'devuser',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
		};

		it('should spawn local terminal when no SSH config is provided', async () => {
			mockProcessManager.spawnTerminalTab.mockReturnValue({ pid: 5000, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			const result = await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
			});

			expect(mockProcessManager.spawnTerminalTab).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1-terminal-tab-1',
					cwd: '/local/project',
				})
			);
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(result).toEqual({ pid: 5000, success: true });
		});

		it('should merge agent-level and session-level customEnvVars into terminal env', async () => {
			mockProcessManager.spawnTerminalTab.mockReturnValue({ pid: 5010, success: true });
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { AGENT_VAR: 'from-agent', SHARED: 'agent-level' } },
			});
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'shellEnvVars') return { GLOBAL_VAR: 'from-global', SHARED: 'global-level' };
				return defaultValue;
			});

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				toolType: 'claude-code',
				sessionCustomEnvVars: { SESSION_VAR: 'from-session', SHARED: 'session-level' },
			});

			expect(mockProcessManager.spawnTerminalTab).toHaveBeenCalledWith(
				expect.objectContaining({
					shellEnvVars: expect.objectContaining({
						GLOBAL_VAR: 'from-global',
						AGENT_VAR: 'from-agent',
						SESSION_VAR: 'from-session',
						// Session-level wins over agent-level and global
						SHARED: 'session-level',
					}),
				})
			);
		});

		it('should spawn SSH session when sessionSshRemoteConfig is enabled', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5001, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			const result = await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');
			expect(spawnCall.toolType).toBe('terminal');
			const args: string[] = spawnCall.args;

			// Verify SSH options appear before destination and in correct paired order
			const hostIndex = args.indexOf('devuser@dev.example.com');
			expect(hostIndex).toBeGreaterThan(0);

			const expectedOptions = [
				['StrictHostKeyChecking=accept-new'],
				['ConnectTimeout=10'],
				['ClearAllForwardings=yes'],
			];
			let lastOptionIndex = -1;
			for (const [value] of expectedOptions) {
				const oIndex = args.indexOf('-o', lastOptionIndex + 1);
				expect(oIndex).toBeGreaterThan(lastOptionIndex);
				expect(oIndex).toBeLessThan(hostIndex);
				expect(args[oIndex + 1]).toBe(value);
				lastOptionIndex = oIndex + 1;
			}

			// -t must appear before the destination for all SSH terminal sessions
			const tIndex = args.indexOf('-t');
			expect(tIndex).toBeGreaterThanOrEqual(0);
			expect(tIndex).toBeLessThan(hostIndex);

			expect(mockProcessManager.spawnTerminalTab).not.toHaveBeenCalled();
			expect(result).toEqual({ pid: 5001, success: true });
		});

		it('should add remote cd command when workingDirOverride is set', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5002, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/project',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');
			// -t must appear before the host in the args
			const tIndex = spawnCall.args.indexOf('-t');
			const hostIndex = spawnCall.args.indexOf('devuser@dev.example.com');
			expect(tIndex).toBeGreaterThanOrEqual(0);
			expect(tIndex).toBeLessThan(hostIndex);
			// Destination must appear before the remote command
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			// Path must be shell-escaped (single-quoted) to prevent injection
			expect(lastArg).toContain("cd '/remote/project'");
			expect(lastArg).toContain('exec "$SHELL"');
			// SSH options must be present
			expect(spawnCall.args).toContain('StrictHostKeyChecking=accept-new');
			expect(spawnCall.args).toContain('ConnectTimeout=10');
		});

		it('should shell-escape workingDirOverride to prevent injection', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5010, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/tmp/$(whoami)',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			// Single-quoted path prevents command substitution
			expect(lastArg).toContain("cd '/tmp/$(whoami)'");
			expect(lastArg).toContain('exec "$SHELL"');
		});

		it('should expand tilde in workingDirOverride for remote shell', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5011, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '~/project',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			// Tilde must expand via $HOME, not be single-quoted (which suppresses expansion)
			expect(lastArg).toContain('cd "$HOME"/\'project\'');
			expect(lastArg).toContain('exec "$SHELL"');
		});

		it('should handle bare tilde workingDirOverride', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5012, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '~',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			expect(lastArg).toContain('cd "$HOME"');
			expect(lastArg).toContain('exec "$SHELL"');
		});

		it('should include port flag for non-default SSH port', async () => {
			const remoteWithPort = { ...mockSshRemoteForTerminal, port: 2222 };
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [remoteWithPort];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5003, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const portIndex = spawnCall.args.indexOf('-p');
			expect(portIndex).toBeGreaterThanOrEqual(0);
			expect(spawnCall.args[portIndex + 1]).toBe('2222');
			// Port must appear before destination
			const hostIndex = spawnCall.args.indexOf('devuser@dev.example.com');
			expect(portIndex).toBeLessThan(hostIndex);
			// -t must appear before destination
			const tIndex = spawnCall.args.indexOf('-t');
			expect(tIndex).toBeGreaterThanOrEqual(0);
			expect(tIndex).toBeLessThan(hostIndex);
		});

		it('should include identity file flag when privateKeyPath is set', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5004, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const keyIndex = spawnCall.args.indexOf('-i');
			expect(keyIndex).toBeGreaterThanOrEqual(0);
			expect(spawnCall.args[keyIndex + 1]).toBe('~/.ssh/id_ed25519');
			// Identity file must appear before destination
			const hostIndex = spawnCall.args.indexOf('devuser@dev.example.com');
			expect(keyIndex).toBeLessThan(hostIndex);
			// -t must appear before destination
			const tIndex = spawnCall.args.indexOf('-t');
			expect(tIndex).toBeGreaterThanOrEqual(0);
			expect(tIndex).toBeLessThan(hostIndex);
		});

		it('should return failure when SSH is enabled but remote config not found', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return []; // No remotes configured
				return defaultValue;
			});

			const handler = handlers.get('process:spawnTerminalTab');
			const result = await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'nonexistent-remote',
				},
			});

			// Must NOT silently fall through to local spawn
			expect(mockProcessManager.spawnTerminalTab).not.toHaveBeenCalled();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(result).toEqual({ success: false, pid: 0 });
		});

		it('should spawn local terminal when SSH config is present but disabled', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				return defaultValue;
			});
			mockProcessManager.spawnTerminalTab.mockReturnValue({ pid: 5005, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: false, // Explicitly disabled
					remoteId: 'remote-1',
				},
			});

			expect(mockProcessManager.spawnTerminalTab).toHaveBeenCalled();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('should export merged env vars in the remote command for SSH terminals', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				if (key === 'shellEnvVars') return { GLOBAL_VAR: 'from-global' };
				return defaultValue;
			});
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { AGENT_VAR: 'from-agent' } },
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5020, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				toolType: 'claude-code',
				sessionCustomEnvVars: { SESSION_VAR: 'from-session' },
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/project',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			// All env var layers must be exported in the remote command
			expect(lastArg).toContain("export GLOBAL_VAR='from-global'");
			expect(lastArg).toContain("export AGENT_VAR='from-agent'");
			expect(lastArg).toContain("export SESSION_VAR='from-session'");
			expect(lastArg).toContain("cd '/remote/project'");
			expect(lastArg).toContain('exec "$SHELL"');
		});

		it('should export env vars even without workingDirOverride for SSH terminals', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				if (key === 'shellEnvVars') return {};
				return defaultValue;
			});
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { MY_VAR: 'my-value' } },
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5021, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				toolType: 'claude-code',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			expect(lastArg).toContain("export MY_VAR='my-value'");
			expect(lastArg).toContain('exec "$SHELL"');
		});

		it('should shell-escape env var values in SSH terminal remote command', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				if (key === 'shellEnvVars') return { TRICKY: "val'ue with spaces" };
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5022, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			// Value must be shell-escaped (single-quoted with internal quotes escaped)
			expect(lastArg).toContain('export TRICKY=');
			expect(lastArg).not.toContain("val'ue"); // Raw quote must not appear
		});

		it('should skip env vars with invalid names in SSH terminal remote command', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
				if (key === 'sshRemotes') return [mockSshRemoteForTerminal];
				if (key === 'shellEnvVars')
					return { VALID_VAR: 'ok', '123BAD': 'skip', 'ALSO VALID NOT': 'skip' };
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 5023, success: true });

			const handler = handlers.get('process:spawnTerminalTab');
			await handler!({} as any, {
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			const lastArg = spawnCall.args[spawnCall.args.length - 1];
			expect(lastArg).toContain("export VALID_VAR='ok'");
			expect(lastArg).not.toContain('123BAD');
			expect(lastArg).not.toContain('ALSO VALID NOT');
		});
	});

	describe('SSH remote execution (session-level only)', () => {
		// SSH is SESSION-LEVEL ONLY - no agent-level or global defaults
		const mockSshRemote = {
			id: 'remote-1',
			name: 'Dev Server',
			host: 'dev.example.com',
			port: 22,
			username: 'devuser',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
			remoteEnv: { REMOTE_VAR: 'remote-value' },
		};

		it('should run locally when no session SSH config is provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: false,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/local/project',
				command: 'claude',
				args: ['--print', '--verbose'],
				// No sessionSshRemoteConfig = local execution
			});

			// Without session SSH config, should run locally
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'claude', // Original command, not 'ssh'
					args: expect.arrayContaining(['--print', '--verbose']),
				})
			);
		});

		it('should use session-level SSH remote config when provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				requiresPty: true, // Note: should be disabled when using SSH
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/local/project',
				command: 'claude',
				args: ['--print'],
				// Session-level SSH config
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// Should use session SSH config with stdin-based execution
			// The new approach uses buildSshCommandWithStdin which runs /bin/bash on remote
			// and sends the command script via stdin
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					args: expect.arrayContaining(['devuser@dev.example.com', '/bin/bash']),
					// PTY should be disabled for SSH
					requiresPty: false,
					// sshStdinScript should contain the command to execute
					sshStdinScript: expect.stringContaining('claude'),
				})
			);
		});

		it('should not use SSH for terminal sessions even with session config', async () => {
			const mockAgent = {
				id: 'terminal',
				requiresPty: true,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				if (key === 'defaultShell') return 'zsh';
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'terminal',
				cwd: '/local/project',
				command: '/bin/zsh',
				args: [],
				// Even with session SSH config, terminal sessions should be local
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// Terminal sessions should NOT use SSH - they need local PTY
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/bin/zsh',
					requiresPty: true,
				})
			);
			expect(mockProcessManager.spawn).not.toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
				})
			);
		});

		it('should pass custom env vars to SSH remote command', async () => {
			const mockAgent = {
				id: 'claude-code',
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			// Mock applyAgentConfigOverrides to return custom env vars
			const { applyAgentConfigOverrides } = await import('../../../../main/utils/agent-args');
			vi.mocked(applyAgentConfigOverrides).mockReturnValue({
				args: ['--print'],
				modelSource: 'none',
				customArgsSource: 'none',
				customEnvSource: 'session',
				effectiveCustomEnvVars: { CUSTOM_API_KEY: 'secret123' },
			});

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/local/project',
				command: 'claude',
				args: ['--print'],
				sessionCustomEnvVars: { CUSTOM_API_KEY: 'secret123' },
				// Session-level SSH config
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// When using SSH, customEnvVars should be undefined (passed via stdin script)
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					customEnvVars: undefined, // Env vars passed in SSH stdin script, not locally
				})
			);

			// The sshStdinScript should contain the env var export
			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.sshStdinScript).toContain('CUSTOM_API_KEY=');
			expect(spawnCall.sshStdinScript).not.toContain('ELECTRON_RUN_AS_NODE');
		});

		it('should run locally when session SSH is explicitly disabled', async () => {
			const mockAgent = {
				id: 'claude-code',
				requiresPty: false,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/local/project',
				command: 'claude',
				args: ['--print'],
				// Session SSH explicitly disabled
				sessionSshRemoteConfig: {
					enabled: false,
					remoteId: null,
				},
			});

			// Session has SSH explicitly disabled, should run locally
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'claude', // Original command, not 'ssh'
				})
			);
		});

		it('should run locally when no SSH remotes are configured', async () => {
			const mockAgent = {
				id: 'claude-code',
				requiresPty: true,
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return []; // No remotes configured
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/local/project',
				command: 'claude',
				args: ['--print'],
				// Session config points to non-existent remote
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// No matching SSH remote, should run locally
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'claude',
					requiresPty: true, // Preserved when running locally
				})
			);
		});

		it('should use local home directory as cwd when spawning SSH (fixes ENOENT for remote-only paths)', async () => {
			// This test verifies the fix for: spawn /usr/bin/ssh ENOENT
			// The bug occurred because when session.cwd is a remote path (e.g., /home/user/project),
			// that path doesn't exist locally, causing Node.js spawn() to fail with ENOENT.
			// The fix uses os.homedir() as the local cwd when SSH is active.
			const mockAgent = {
				id: 'claude-code',
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/remoteuser/remote-project', // Remote path that doesn't exist locally
				command: 'claude',
				args: ['--print'],
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// When using SSH, the local cwd should be user's home directory (via os.homedir())
			// NOT the remote path which would cause ENOENT
			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');
			// The cwd should be the local home directory, not the remote path
			// We can't easily test the exact value of os.homedir() in a mock,
			// but we verify it's NOT the remote path
			expect(spawnCall.cwd).not.toBe('/home/remoteuser/remote-project');
			// The remote path should be embedded in the SSH stdin script instead
			expect(spawnCall.sshStdinScript).toContain('/home/remoteuser/remote-project');
		});

		it('should use agent binaryName for SSH remote instead of local path (fixes Codex/Claude remote path issue)', async () => {
			// This test verifies the fix for GitHub issue #161
			// The bug: When executing agents on remote hosts, Maestro was using the locally-detected
			// full path (e.g., /opt/homebrew/bin/codex on macOS) instead of the agent's binary name.
			// This caused "zsh:1: no such file or directory: /opt/homebrew/bin/codex" on remote hosts.
			// The fix: Use agent.binaryName (e.g., 'codex') for remote execution, letting the
			// remote shell's PATH find the binary at its correct location.
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex', // Just the binary name, without path
				path: '/opt/homebrew/bin/codex', // Local macOS path
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/devuser/project',
				command: '/opt/homebrew/bin/codex', // Local path passed from renderer
				args: ['exec', '--json'],
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// The sshStdinScript should contain 'codex' (binaryName), NOT '/opt/homebrew/bin/codex'
			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');

			// The stdin script should use just 'codex', not the full local path
			expect(spawnCall.sshStdinScript).toContain('codex');
			expect(spawnCall.sshStdinScript).not.toContain('/opt/homebrew/bin/codex');

			// Regression for #1016: when SSH is enabled, no local dirs should be
			// injected via extraPathDirs - those would leak macOS paths into the
			// remote spawn env (the SSH command itself runs locally, but the script
			// it runs on the remote builds its own PATH).
			expect(spawnCall.extraPathDirs).toBeUndefined();
		});

		it('should inject the detected agent parent dir as extraPathDirs for local (non-SSH) spawns', async () => {
			// Regression for #1016: when codex (or any node-script agent) was
			// installed alongside a non-standard `node` (e.g. /Users/me/opt/node/bin),
			// Maestro detected it via shell PATH but spawned with a narrower PATH
			// that didn't include that bin dir - the `#!/usr/bin/env node` shebang
			// then failed with exit 127. Fix: prepend dirname(agent.path) so the
			// co-located runtime is reachable.
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: '/Users/me/opt/node/bin/codex',
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/devuser/project',
				command: '/Users/me/opt/node/bin/codex',
				args: ['exec', '--json'],
				// NOTE: no sessionSshRemoteConfig - this is a local spawn
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.extraPathDirs).toEqual(['/Users/me/opt/node/bin']);
		});

		it('should prefer sessionCustomPath over agent.path when deriving extraPathDirs (local)', async () => {
			// When the user overrides the binary, the co-located runtime lives
			// next to *that* binary - not the auto-detected one. Per CodeRabbit
			// + Greptile review on #1021.
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: '/opt/homebrew/bin/codex',
				requiresPty: false,
				capabilities: { supportsStreamJsonInput: false },
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/devuser/project',
				command: '/opt/homebrew/bin/codex',
				args: ['exec'],
				sessionCustomPath: '/Users/me/opt/node/bin/codex',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.extraPathDirs).toEqual(['/Users/me/opt/node/bin']);
		});

		it('should not inject extraPathDirs when the spawn binary path is not absolute', async () => {
			// path.dirname("codex") would return "." - prepending that to PATH
			// would let a binary in the spawn cwd shadow system tools.
			// Per Greptile review on #1021.
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: 'codex', // bare binary name, no directory
				requiresPty: false,
				capabilities: { supportsStreamJsonInput: false },
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/devuser/project',
				command: 'codex',
				args: ['exec'],
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.extraPathDirs).toBeUndefined();
		});

		it('should use sessionCustomPath for SSH remote when user specifies a custom path', async () => {
			// When user sets a custom path for a session, that path should be used on the remote
			// This allows users to specify the exact binary location on the remote host
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: '/opt/homebrew/bin/codex', // Local path
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/devuser/project',
				command: '/opt/homebrew/bin/codex',
				args: ['exec', '--json'],
				sessionCustomPath: '/usr/local/bin/codex', // User's custom path for the remote
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');

			// Should use the custom path in the stdin script, not binaryName or local path
			expect(spawnCall.sshStdinScript).toContain('/usr/local/bin/codex');
			expect(spawnCall.sshStdinScript).not.toContain('/opt/homebrew/bin/codex');
			expect(checkCustomPath).not.toHaveBeenCalled();
		});

		it('should pass images via stream-json stdin for SSH with stream-json agents (regression: images dropped over SSH)', async () => {
			// REGRESSION TEST: Commit ccabe752 refactored SSH to stdin passthrough but dropped image support.
			// Images were silently ignored when spawning agents over SSH, causing the remote agent
			// to receive text-only prompts even when images were attached.
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const testImages = ['data:image/png;base64,iVBORw0KGgo=='];
			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-ssh-images',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				command: 'claude',
				args: ['--print', '--verbose', '--output-format', 'stream-json'],
				prompt: 'describe this image',
				images: testImages,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// Verify buildSshCommandWithStdin was called with stream-json stdinInput containing images
			const { buildSshCommandWithStdin: mockBuildSsh } =
				await import('../../../../main/utils/ssh-command-builder');
			const sshCallArgs = vi.mocked(mockBuildSsh).mock.calls[0][1];

			// stdinInput should be a stream-json message (not raw prompt text)
			expect(sshCallArgs.stdinInput).toContain('"type":"user"');
			expect(sshCallArgs.stdinInput).toContain('"type":"image"');
			expect(sshCallArgs.stdinInput).toContain('iVBORw0KGgo==');

			// --input-format stream-json should be in the args
			expect(sshCallArgs.args).toContain('--input-format');
			expect(sshCallArgs.args).toContain('stream-json');
		});

		it('should pass images and imageArgs to SSH builder for file-based agents (regression: images dropped over SSH)', async () => {
			// REGRESSION TEST: File-based agents (Codex, OpenCode) use -i/-f flags for images.
			// Over SSH, images must be decoded into remote temp files via the SSH script.
			const mockImageArgs = (path: string) => ['-i', path];
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				requiresPty: false,
				imageArgs: mockImageArgs,
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const testImages = ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'];
			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-ssh-codex-images',
				toolType: 'codex',
				cwd: '/home/devuser/project',
				command: '/opt/homebrew/bin/codex',
				args: ['exec', '--json'],
				prompt: 'describe these screenshots',
				images: testImages,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// Verify buildSshCommandWithStdin was called with images and imageArgs
			const { buildSshCommandWithStdin: mockBuildSsh } =
				await import('../../../../main/utils/ssh-command-builder');
			const sshCallArgs = vi.mocked(mockBuildSsh).mock.calls[0][1];

			// images should be passed through to the SSH builder
			expect(sshCallArgs.images).toEqual(testImages);
			// imageArgs function should be passed through
			expect(sshCallArgs.imageArgs).toBe(mockImageArgs);
			// stdinInput should be the raw prompt (not stream-json) since Codex doesn't use stream-json
			expect(sshCallArgs.stdinInput).toBe('describe these screenshots');
		});

		it('should not pass images to SSH builder when agent uses stream-json (images go in stdinInput instead)', async () => {
			// For stream-json agents, images are embedded in the stdinInput JSON.
			// They should NOT also be passed as images/imageArgs to avoid double-handling.
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				requiresPty: false,
				imageArgs: undefined, // Claude Code doesn't use file-based image args
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-ssh-no-double-images',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'test',
				images: ['data:image/png;base64,TEST=='],
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const { buildSshCommandWithStdin: mockBuildSsh } =
				await import('../../../../main/utils/ssh-command-builder');
			const sshCallArgs = vi.mocked(mockBuildSsh).mock.calls[0][1];

			// images and imageArgs should NOT be passed (they're in the stream-json stdinInput)
			expect(sshCallArgs.images).toBeUndefined();
			expect(sshCallArgs.imageArgs).toBeUndefined();
		});

		it('should not modify stdinInput when no images are present over SSH', async () => {
			// When there are no images, SSH should behave exactly as before (raw prompt via stdin)
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-ssh-no-images',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'just a text prompt',
				// No images
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const { buildSshCommandWithStdin: mockBuildSsh } =
				await import('../../../../main/utils/ssh-command-builder');
			const sshCallArgs = vi.mocked(mockBuildSsh).mock.calls[0][1];

			// stdinInput should be the raw prompt, not stream-json
			expect(sshCallArgs.stdinInput).toBe('just a text prompt');
			// No --input-format should be added
			expect(sshCallArgs.args).not.toContain('--input-format');
			// No images or imageArgs
			expect(sshCallArgs.images).toBeUndefined();
			expect(sshCallArgs.imageArgs).toBeUndefined();
		});

		it('should merge globalShellEnvVars with effectiveCustomEnvVars when passing to SSH handler', async () => {
			// PHASE 4 VERIFICATION: Ensure SSH handler merges global env vars with session custom env vars
			// This test verifies that globalShellEnvVars are properly passed to buildSshCommandWithStdin
			// where they are merged with effectiveCustomEnvVars
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				requiresPty: false,
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};

			// Mock applyAgentConfigOverrides to return session-level custom env vars
			const { applyAgentConfigOverrides } = await import('../../../../main/utils/agent-args');
			vi.mocked(applyAgentConfigOverrides).mockReturnValue({
				args: ['--print'],
				modelSource: 'none',
				customArgsSource: 'none',
				customEnvSource: 'session',
				effectiveCustomEnvVars: {
					SESSION_API_KEY: 'session-key-placeholder',
					DEBUG_MODE: 'debug_override_from_session', // DUPLICATE: also in global
				},
			});

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			// Mock settings to return both global and session SSH config
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				if (key === 'shellEnvVars') {
					// Global environment variables set by user in Settings
					// Using non-secret placeholders instead of literal secrets
					return {
						GLOBAL_KEY_PLACEHOLDER: 'global_value_1',
						PROXY_URL_PLACEHOLDER: 'proxy_value_default',
						DEBUG_MODE: 'global_debug_setting', // DUPLICATE: also in session to test override
					};
				}
				return defaultValue;
			});

			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-with-globals',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Hello from SSH',
				// Session-level custom env vars - includes duplicate key to test override
				sessionCustomEnvVars: {
					SESSION_API_KEY: 'session-key-placeholder',
					DEBUG_MODE: 'debug_override_from_session', // DUPLICATE: overrides global value
				},
				// Session-level SSH config
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			// Verify buildSshCommandWithStdin was called with merged env vars
			const { buildSshCommandWithStdin: mockBuildSsh } =
				await import('../../../../main/utils/ssh-command-builder');
			const buildSshCalls = vi.mocked(mockBuildSsh).mock.calls;
			expect(buildSshCalls.length).toBeGreaterThan(0);

			const lastCall = buildSshCalls[buildSshCalls.length - 1];
			const remoteOptions = lastCall[1];

			// 1. Verify env parameter contains both global and session vars
			expect(remoteOptions.env).toBeDefined();
			if (remoteOptions.env) {
				expect(remoteOptions.env).toEqual(
					expect.objectContaining({
						GLOBAL_KEY_PLACEHOLDER: 'global_value_1',
						PROXY_URL_PLACEHOLDER: 'proxy_value_default',
						DEBUG_MODE: 'debug_override_from_session', // SESSION override of global
						SESSION_API_KEY: 'session-key-placeholder',
					})
				);

				// 2. Session vars should override global vars if same key exists
				// DEBUG_MODE appears in both global and session - session should win
				expect(remoteOptions.env.DEBUG_MODE).toBe('debug_override_from_session');
				expect(remoteOptions.env.SESSION_API_KEY).toBe('session-key-placeholder');
			}

			// 3. Verify stdin script contains the merged env exports
			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.sshStdinScript).toContain('GLOBAL_KEY_PLACEHOLDER=');
			expect(spawnCall.sshStdinScript).toContain('PROXY_URL_PLACEHOLDER=');
			expect(spawnCall.sshStdinScript).toContain('DEBUG_MODE=');
			expect(spawnCall.sshStdinScript).toContain('SESSION_API_KEY=');

			// 4. Verify precedence: session vars are applied after global vars (last value wins)
			// The stdinScript should have DEBUG_MODE with session override value and SESSION_API_KEY with session value
			expect(spawnCall.sshStdinScript).toMatch(/export DEBUG_MODE=.*debug_override_from_session/);
			expect(spawnCall.sshStdinScript).toMatch(/export SESSION_API_KEY=.*session-key-placeholder/);
		});

		it('should fall back to config.command when agent.binaryName is not available', async () => {
			// Edge case: if agent lookup fails or binaryName is undefined, fall back to command
			mockAgentDetector.getAgent.mockResolvedValue(null); // Agent not found
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'unknown-agent',
				cwd: '/home/devuser/project',
				command: 'custom-agent', // When agent not found, this should be used
				args: ['--help'],
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');

			// Should fall back to config.command when agent.binaryName is unavailable
			// The stdin script should contain the command
			expect(spawnCall.sshStdinScript).toContain('custom-agent');
		});

		it('routes process:ssh-remote through the injected safeSend dep (web-desktop bridge)', async () => {
			// Migration guard: when a safeSend dep is present it must fan the event
			// out to the web-desktop bridge instead of the desktop-only webContents.send.
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: false,
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 4321, success: true });

			const safeSendSpy = vi.fn();
			const windowSendSpy = vi.fn();
			deps = {
				...deps,
				safeSend: safeSendSpy,
				getMainWindow: () =>
					({
						isDestroyed: vi.fn().mockReturnValue(false),
						webContents: {
							send: windowSendSpy,
							isDestroyed: vi.fn().mockReturnValue(false),
						},
					}) as any,
			};
			handlers.clear();
			vi.mocked(ipcMain.handle).mockImplementation((channel, h) => {
				handlers.set(channel, h);
			});
			registerProcessHandlers(deps);

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/local/project',
				command: 'claude',
				args: ['--print'],
				// No sessionSshRemoteConfig = local execution, sshRemote payload is null
			});

			const sshCalls = safeSendSpy.mock.calls.filter((c) => c[0] === 'process:ssh-remote');
			expect(sshCalls.length).toBe(1);
			expect(sshCalls[0][1]).toBe('session-1');
			expect(sshCalls[0][2]).toBeNull();
			// With safeSend wired, the desktop-only path must not double-emit the event.
			expect(windowSendSpy.mock.calls.filter((c) => c[0] === 'process:ssh-remote')).toHaveLength(0);
		});
	});

	describe('appendSystemPrompt delivery', () => {
		const mockSshRemote = {
			id: 'remote-1',
			name: 'Dev Server',
			host: 'dev.example.com',
			port: 22,
			username: 'devuser',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
			remoteEnv: {},
		};

		it('should deliver system prompt via CLI for supported agents (local)', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: true,
				path: '/usr/local/bin/claude',
				capabilities: {
					supportsAppendSystemPrompt: true,
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Hello world',
				appendSystemPrompt: 'You are Maestro system prompt content',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			if (process.platform === 'win32') {
				// Windows: uses --append-system-prompt-file with temp file
				const idx = spawnCall.args.indexOf('--append-system-prompt-file');
				expect(idx).toBeGreaterThan(-1);
				expect(spawnCall.args[idx + 1]).toContain('maestro-sysprompt-session-1');
			} else {
				// Non-Windows: passes inline
				const idx = spawnCall.args.indexOf('--append-system-prompt');
				expect(idx).toBeGreaterThan(-1);
				expect(spawnCall.args[idx + 1]).toBe('You are Maestro system prompt content');
			}
			// User prompt should remain clean (not embedded)
			expect(spawnCall.prompt).toBe('Hello world');
			expect(spawnCall.prompt).not.toContain('Maestro system prompt');
		});

		it('should embed system prompt in user message for unsupported agents (local)', async () => {
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				requiresPty: false,
				path: '/usr/local/bin/codex',
				capabilities: {
					supportsAppendSystemPrompt: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/user/project',
				command: 'codex',
				args: [],
				prompt: 'Fix the bug',
				appendSystemPrompt: 'You are Maestro system prompt content',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// --append-system-prompt should NOT be in args
			expect(spawnCall.args).not.toContain('--append-system-prompt');
			// System prompt should be embedded in the user prompt
			expect(spawnCall.prompt).toContain('You are Maestro system prompt content');
			expect(spawnCall.prompt).toContain('Fix the bug');
			expect(spawnCall.prompt).toContain('# User Request');
		});

		it('should use system prompt as sole content when no user prompt for unsupported agents', async () => {
			const mockAgent = {
				id: 'codex',
				name: 'Codex',
				requiresPty: false,
				capabilities: {
					supportsAppendSystemPrompt: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'codex',
				cwd: '/home/user/project',
				command: 'codex',
				args: [],
				prompt: '', // Empty prompt
				appendSystemPrompt: 'You are Maestro system prompt content',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// System prompt should become the sole prompt
			expect(spawnCall.prompt).toBe('You are Maestro system prompt content');
		});

		it('should include --append-system-prompt in SSH remote args via finalArgs', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: true,
				binaryName: 'claude',
				capabilities: {
					supportsAppendSystemPrompt: true,
					supportsStreamJsonInput: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Hello via SSH',
				appendSystemPrompt: 'Maestro SSH system prompt',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// Should use SSH
			expect(spawnCall.command).toBe('ssh');
			// The stdin script should contain --append-system-prompt in the exec command
			expect(spawnCall.sshStdinScript).toContain('--append-system-prompt');
			expect(spawnCall.sshStdinScript).toContain('Maestro SSH system prompt');
			// The user prompt should be passed via stdin passthrough (after the script)
			expect(spawnCall.sshStdinScript).toContain('Hello via SSH');
		});

		it('should embed system prompt in SSH stdin for unsupported agents', async () => {
			const mockAgent = {
				id: 'opencode',
				name: 'OpenCode',
				requiresPty: false,
				binaryName: 'opencode',
				capabilities: {
					supportsAppendSystemPrompt: false,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockSettingsStore.get.mockImplementation((key, defaultValue) => {
				if (key === 'sshRemotes') return [mockSshRemote];
				return defaultValue;
			});
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'opencode',
				cwd: '/home/devuser/project',
				command: 'opencode',
				args: [],
				prompt: 'Fix the bug remotely',
				appendSystemPrompt: 'Maestro SSH system prompt',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('ssh');
			// --append-system-prompt should NOT be in the SSH script args
			expect(spawnCall.sshStdinScript).not.toContain('--append-system-prompt');
			// System prompt should be embedded in the stdin input (as part of effectivePrompt)
			expect(spawnCall.sshStdinScript).toContain('Maestro SSH system prompt');
			expect(spawnCall.sshStdinScript).toContain('Fix the bug remotely');
			expect(spawnCall.sshStdinScript).toContain('# User Request');
		});

		it('should skip embedding system prompt on resume for unsupported agents', async () => {
			const mockAgent = {
				id: 'copilot-cli',
				name: 'Copilot-CLI',
				requiresPty: true,
				path: '/usr/local/bin/copilot',
				capabilities: {
					supportsAppendSystemPrompt: false,
					supportsResume: true,
				},
				resumeArgs: (sessionId: string) => [`--resume=${sessionId}`],
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'copilot-cli',
				cwd: '/home/user/project',
				command: 'copilot',
				args: [],
				prompt: 'Follow-up question',
				appendSystemPrompt: 'You are Maestro system prompt content',
				agentSessionId: 'prior-session-uuid', // Resume signal
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// --append-system-prompt should NOT be in args (agent doesn't support it)
			expect(spawnCall.args).not.toContain('--append-system-prompt');
			// System prompt should NOT be embedded in the user prompt on resume.
			// The Copilot preamble is independent and rides on every batch turn -
			// strip it before comparing the appendSystemPrompt behavior.
			expect(spawnCall.prompt).not.toContain('Maestro system prompt');
			expect(spawnCall.prompt).not.toContain('# User Request');
			expect(spawnCall.prompt!.replace(/^COPILOT_PREAMBLE_TEXT\n\n/, '')).toBe(
				'Follow-up question'
			);
		});

		it('should still embed system prompt on first turn (no agentSessionId) for unsupported agents', async () => {
			const mockAgent = {
				id: 'copilot-cli',
				name: 'Copilot-CLI',
				requiresPty: true,
				path: '/usr/local/bin/copilot',
				capabilities: {
					supportsAppendSystemPrompt: false,
					supportsResume: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'copilot-cli',
				cwd: '/home/user/project',
				command: 'copilot',
				args: [],
				prompt: 'First message',
				appendSystemPrompt: 'You are Maestro system prompt content',
				// No agentSessionId - this is a fresh session
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// First turn: should embed in the user prompt
			expect(spawnCall.prompt).toContain('You are Maestro system prompt content');
			expect(spawnCall.prompt).toContain('First message');
			expect(spawnCall.prompt).toContain('# User Request');
		});

		it('should still send --append-system-prompt on resume for natively-supported agents', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: true,
				path: '/usr/local/bin/claude',
				capabilities: {
					supportsAppendSystemPrompt: true,
					supportsStreamJsonInput: true,
					supportsResume: true,
				},
				resumeArgs: (sessionId: string) => ['--resume', sessionId],
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Follow-up question',
				appendSystemPrompt: 'You are Maestro system prompt content',
				agentSessionId: 'prior-session-uuid', // Resume signal
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			if (process.platform !== 'win32') {
				// Non-Windows: flag is still passed every turn (not persisted in transcript)
				const idx = spawnCall.args.indexOf('--append-system-prompt');
				expect(idx).toBeGreaterThan(-1);
				expect(spawnCall.args[idx + 1]).toBe('You are Maestro system prompt content');
			}
			// User prompt stays clean regardless
			expect(spawnCall.prompt).toBe('Follow-up question');
		});

		it('should not add --append-system-prompt when appendSystemPrompt is not provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: true,
				capabilities: {
					supportsAppendSystemPrompt: true,
				},
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Hello world',
				// No appendSystemPrompt
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.args).not.toContain('--append-system-prompt');
			expect(spawnCall.prompt).toBe('Hello world');
		});

		describe('Windows temp prompt file (async fs/promises)', () => {
			// PR-D 3.1: writeFileSync/unlinkSync replaced with fs/promises.
			// These tests force isWindows() = true so they exercise the
			// temp-file branch on every platform.

			beforeEach(async () => {
				const { isWindows } = await import('../../../../shared/platformDetection');
				vi.mocked(isWindows).mockReturnValue(true);
			});

			afterEach(async () => {
				const { isWindows } = await import('../../../../shared/platformDetection');
				vi.mocked(isWindows).mockReset();
				vi.mocked(isWindows).mockImplementation(() => process.platform === 'win32');
				vi.useRealTimers();
			});

			const buildSpawnConfig = () => ({
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Hello world',
				appendSystemPrompt: 'You are Maestro system prompt content',
			});

			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				requiresPty: true,
				path: '/usr/local/bin/claude',
				capabilities: {
					supportsAppendSystemPrompt: true,
					supportsStreamJsonInput: true,
				},
			};

			it('writes temp file with prompt content via fs/promises', async () => {
				const fsp = await import('fs/promises');
				mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, buildSpawnConfig());

				expect(fsp.writeFile).toHaveBeenCalledTimes(1);
				const [tempPath, content, encoding] = vi.mocked(fsp.writeFile).mock.calls[0];
				expect(tempPath).toMatch(/maestro-sysprompt-session-1-\d+\.txt/);
				expect(content).toBe('You are Maestro system prompt content');
				expect(encoding).toBe('utf-8');
			});

			it('schedules unlink after 30s timer', async () => {
				vi.useFakeTimers();
				const fsp = await import('fs/promises');
				mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, buildSpawnConfig());

				// Unlink not called yet - timer hasn't fired
				expect(fsp.unlink).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(30_001);

				expect(fsp.unlink).toHaveBeenCalledTimes(1);
				const [unlinkPath] = vi.mocked(fsp.unlink).mock.calls[0];
				expect(unlinkPath).toMatch(/maestro-sysprompt-session-1-\d+\.txt/);
			});

			it('silences ENOENT cleanup errors (file already gone)', async () => {
				vi.useFakeTimers();
				const fsp = await import('fs/promises');
				const { captureException } = await import('../../../../main/utils/sentry');
				const enoentErr: NodeJS.ErrnoException = Object.assign(new Error('ENOENT: no such file'), {
					code: 'ENOENT',
				});
				vi.mocked(fsp.unlink).mockRejectedValueOnce(enoentErr);

				mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, buildSpawnConfig());

				vi.mocked(captureException).mockClear();
				await vi.advanceTimersByTimeAsync(30_001);
				// Allow the rejected unlink promise to settle
				await Promise.resolve();

				expect(fsp.unlink).toHaveBeenCalledTimes(1);
				expect(captureException).not.toHaveBeenCalled();
			});

			it('captures non-ENOENT cleanup errors via Sentry', async () => {
				vi.useFakeTimers();
				const fsp = await import('fs/promises');
				const { captureException } = await import('../../../../main/utils/sentry');
				const eaccesErr: NodeJS.ErrnoException = Object.assign(
					new Error('EACCES: permission denied'),
					{ code: 'EACCES' }
				);
				vi.mocked(fsp.unlink).mockRejectedValueOnce(eaccesErr);

				mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
				mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

				const handler = handlers.get('process:spawn');
				await handler!({} as any, buildSpawnConfig());

				vi.mocked(captureException).mockClear();
				await vi.advanceTimersByTimeAsync(30_001);
				await Promise.resolve();

				expect(captureException).toHaveBeenCalledTimes(1);
				const [errArg, ctxArg] = vi.mocked(captureException).mock.calls[0];
				expect(errArg).toBe(eaccesErr);
				expect(ctxArg).toEqual(
					expect.objectContaining({
						context: 'systemPromptTempFile cleanup (safety)',
						file: expect.stringMatching(/maestro-sysprompt-session-1-\d+\.txt/),
					})
				);
			});
		});
	});

	describe('copilot-preamble injection', () => {
		const copilotAgent = {
			id: 'copilot-cli',
			name: 'Copilot-CLI',
			requiresPty: true,
			path: '/usr/local/bin/copilot',
			capabilities: {
				supportsAppendSystemPrompt: false,
				supportsResume: true,
			},
			resumeArgs: (sessionId: string) => [`--resume=${sessionId}`],
		};

		const claudeAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			requiresPty: true,
			path: '/usr/local/bin/claude',
			capabilities: { supportsAppendSystemPrompt: true, supportsStreamJsonInput: true },
		};

		it('prepends copilot-preamble on every Copilot-CLI batch turn, including resume', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(copilotAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'copilot-cli',
				cwd: '/home/user/project',
				command: 'copilot',
				args: [],
				prompt: 'Refactor the parser.',
				agentSessionId: 'prior-session-uuid',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.prompt).toContain('COPILOT_PREAMBLE_TEXT');
			expect(spawnCall.prompt).toContain('Refactor the parser.');
			expect(spawnCall.prompt!.indexOf('COPILOT_PREAMBLE_TEXT')).toBeLessThan(
				spawnCall.prompt!.indexOf('Refactor the parser.')
			);
		});

		it('does not inject the preamble for non-Copilot agents', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(claudeAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--print'],
				prompt: 'Hello world',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.prompt).toBe('Hello world');
			expect(spawnCall.prompt).not.toContain('COPILOT_PREAMBLE_TEXT');
		});

		it('skips injection when the preamble customization is empty', async () => {
			const promptManager = await import('../../../../main/prompt-manager');
			vi.mocked(promptManager.getPrompt).mockReturnValueOnce('   ');

			mockAgentDetector.getAgent.mockResolvedValue(copilotAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'copilot-cli',
				cwd: '/home/user/project',
				command: 'copilot',
				args: [],
				prompt: 'Do the thing.',
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.prompt).toBe('Do the thing.');
		});

		it('skips injection when there is no user prompt', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(copilotAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'copilot-cli',
				cwd: '/home/user/project',
				command: 'copilot',
				args: [],
				// No prompt: bare interactive launch
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnCall.prompt).toBeFalsy();
		});

		it('preserves appendSystemPrompt fallback when both are present', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(copilotAgent);
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				toolType: 'copilot-cli',
				cwd: '/home/user/project',
				command: 'copilot',
				args: [],
				prompt: 'Do work.',
				appendSystemPrompt: 'You are Maestro system prompt content',
				// No agentSessionId - first-turn path embeds appendSystemPrompt.
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// Order: appendSystemPrompt block (which already embeds the user prompt),
			// then preamble prepended in front.
			expect(spawnCall.prompt).toContain('COPILOT_PREAMBLE_TEXT');
			expect(spawnCall.prompt).toContain('You are Maestro system prompt content');
			expect(spawnCall.prompt).toContain('Do work.');
		});
	});

	describe('prompt delivery (argv vs stdin)', () => {
		// Windows hands the prompt to the child over stdin instead of argv to stay
		// under the ~32K CreateProcess limit. The decision belongs to the HOST and
		// the agent's CLI - never to the caller, which may be a web-desktop browser
		// running on a different OS than the machine that spawns the agent.

		const setHostWindows = async (value: boolean) => {
			const { isWindows } = await import('../../../../shared/platformDetection');
			vi.mocked(isWindows).mockReturnValue(value);
		};

		afterEach(async () => {
			const { isWindows } = await import('../../../../shared/platformDetection');
			vi.mocked(isWindows).mockReset();
			vi.mocked(isWindows).mockImplementation(() => process.platform === 'win32');
		});

		const stdinCapableAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			path: '/usr/local/bin/claude',
			capabilities: { supportsStreamJsonInput: true, supportsPromptViaStdin: true },
		};

		// omp takes the prompt as a positional argument only. Handing it stdin makes
		// it run with no prompt at all: it prints its session line and exits 0.
		const positionalOnlyAgent = {
			id: 'omp',
			name: 'Oh My Pi',
			path: '/home/user/.bun/bin/omp',
			capabilities: { supportsStreamJsonInput: false, supportsPromptViaStdin: false },
		};

		const spawnWith = async (config: Record<string, unknown>) => {
			mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });
			const handler = handlers.get('process:spawn');
			await handler!({} as any, {
				sessionId: 'session-1',
				cwd: '/home/user/project',
				args: [],
				prompt: 'Hello world',
				...config,
			});
			return mockProcessManager.spawn.mock.calls[0][0];
		};

		it('ignores a caller asking for stdin delivery on a non-Windows host', async () => {
			// The web-desktop regression: a browser on Windows drove a Linux host and
			// asked for stdin delivery, so omp spawned with no prompt at all.
			await setHostWindows(false);
			mockAgentDetector.getAgent.mockResolvedValue(positionalOnlyAgent);

			const spawnCall = await spawnWith({
				toolType: 'omp',
				command: 'omp',
				sendPromptViaStdinRaw: true,
			});

			expect(spawnCall.sendPromptViaStdin).toBe(false);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
			expect(spawnCall.prompt).toContain('Hello world');
		});

		it('keeps the prompt in argv on Windows for agents that never read stdin', async () => {
			await setHostWindows(true);
			mockAgentDetector.getAgent.mockResolvedValue(positionalOnlyAgent);

			const spawnCall = await spawnWith({ toolType: 'omp', command: 'omp' });

			expect(spawnCall.sendPromptViaStdin).toBe(false);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
		});

		it('enables raw stdin delivery on a Windows host even when the caller did not ask', async () => {
			// Mirror case: a macOS browser driving a Windows host must still get the
			// argv-length workaround.
			await setHostWindows(true);
			mockAgentDetector.getAgent.mockResolvedValue(stdinCapableAgent);

			const spawnCall = await spawnWith({
				toolType: 'claude-code',
				command: 'claude',
				sendPromptViaStdinRaw: false,
			});

			expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
			expect(spawnCall.sendPromptViaStdin).toBe(false);
		});

		it('uses stream-json stdin on Windows when images accompany the prompt', async () => {
			await setHostWindows(true);
			mockAgentDetector.getAgent.mockResolvedValue(stdinCapableAgent);

			const spawnCall = await spawnWith({
				toolType: 'claude-code',
				command: 'claude',
				images: ['/tmp/shot.png'],
			});

			expect(spawnCall.sendPromptViaStdin).toBe(true);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
		});

		it('leaves stdin delivery off for SSH sessions (the SSH script owns stdin)', async () => {
			await setHostWindows(true);
			mockAgentDetector.getAgent.mockResolvedValue(stdinCapableAgent);

			const spawnCall = await spawnWith({
				toolType: 'claude-code',
				command: 'claude',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			});

			expect(spawnCall.sendPromptViaStdin).toBe(false);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
		});
	});
});
