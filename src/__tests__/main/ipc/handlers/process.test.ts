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
import { ipcMain } from 'electron';
import {
	registerProcessHandlers,
	ProcessHandlerDependencies,
} from '../../../../main/ipc/handlers/process';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
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
		scriptLines.push('export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"');

		if (remoteOptions.cwd) {
			scriptLines.push(`cd '${remoteOptions.cwd}' || exit 1`);
		}

		// Add env vars if present
		const mergedEnv = { ...(config.remoteEnv || {}), ...(remoteOptions.env || {}) };
		for (const [key, value] of Object.entries(mergedEnv)) {
			scriptLines.push(`export ${key}='${value}'`);
		}

		// Build command with args
		const cmdWithArgs = `${remoteOptions.command} ${remoteOptions.args.map((a: string) => `'${a}'`).join(' ')}`.trim();
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

describe('process IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockProcessManager: {
		spawn: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		interrupt: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		resize: ReturnType<typeof vi.fn>;
		getAll: ReturnType<typeof vi.fn>;
		runCommand: ReturnType<typeof vi.fn>;
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
	let deps: ProcessHandlerDependencies;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Create mock process manager
		mockProcessManager = {
			spawn: vi.fn(),
			write: vi.fn(),
			interrupt: vi.fn(),
			kill: vi.fn(),
			resize: vi.fn(),
			getAll: vi.fn(),
			runCommand: vi.fn(),
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
			get: vi.fn().mockImplementation((key, defaultValue) => defaultValue),
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
				'process:spawn',
				'process:write',
				'process:interrupt',
				'process:kill',
				'process:resize',
				'process:getActiveProcesses',
				'process:runCommand',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
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
				'zsh', // default shell
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
			const { buildSshCommandWithStdin: mockBuildSsh } = await import('../../../../main/utils/ssh-command-builder');
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
			const { buildSshCommandWithStdin: mockBuildSsh } = await import('../../../../main/utils/ssh-command-builder');
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

			const { buildSshCommandWithStdin: mockBuildSsh } = await import('../../../../main/utils/ssh-command-builder');
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

			const { buildSshCommandWithStdin: mockBuildSsh } = await import('../../../../main/utils/ssh-command-builder');
			const sshCallArgs = vi.mocked(mockBuildSsh).mock.calls[0][1];

			// stdinInput should be the raw prompt, not stream-json
			expect(sshCallArgs.stdinInput).toBe('just a text prompt');
			// No --input-format should be added
			expect(sshCallArgs.args).not.toContain('--input-format');
			// No images or imageArgs
			expect(sshCallArgs.images).toBeUndefined();
			expect(sshCallArgs.imageArgs).toBeUndefined();
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
	});
});
