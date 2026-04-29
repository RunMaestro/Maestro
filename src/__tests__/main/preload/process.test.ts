/**
 * Tests for process preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createProcessApi, type ProcessConfig } from '../../../main/preload/process';

describe('Process Preload API', () => {
	let api: ReturnType<typeof createProcessApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createProcessApi();
	});

	describe('spawn', () => {
		it('should invoke process:spawn with config', async () => {
			const config: ProcessConfig = {
				sessionId: 'session-123',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--json'],
			};
			mockInvoke.mockResolvedValue({ pid: 1234, success: true });

			const result = await api.spawn(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:spawn', config);
			expect(result.pid).toBe(1234);
			expect(result.success).toBe(true);
		});

		it('should handle SSH remote response', async () => {
			const config: ProcessConfig = {
				sessionId: 'session-123',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: [],
			};
			mockInvoke.mockResolvedValue({
				pid: 1234,
				success: true,
				sshRemote: { id: 'remote-1', name: 'My Server', host: 'example.com' },
			});

			const result = await api.spawn(config);

			expect(result.sshRemote).toEqual({ id: 'remote-1', name: 'My Server', host: 'example.com' });
		});
	});

	describe('write', () => {
		it('should invoke process:write with sessionId and data', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.write('session-123', 'Hello');

			expect(mockInvoke).toHaveBeenCalledWith('process:write', 'session-123', 'Hello');
			expect(result).toBe(true);
		});
	});

	describe('interrupt', () => {
		it('should invoke process:interrupt with sessionId', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.interrupt('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('process:interrupt', 'session-123');
			expect(result).toBe(true);
		});
	});

	describe('kill', () => {
		it('should invoke process:kill with sessionId', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.kill('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('process:kill', 'session-123');
			expect(result).toBe(true);
		});
	});

	describe('resize', () => {
		it('should invoke process:resize with sessionId, cols, and rows', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.resize('session-123', 120, 40);

			expect(mockInvoke).toHaveBeenCalledWith('process:resize', 'session-123', 120, 40);
			expect(result).toBe(true);
		});
	});

	describe('runCommand', () => {
		it('should invoke process:runCommand with config', async () => {
			const config = {
				sessionId: 'session-123',
				command: 'ls -la',
				cwd: '/home/user',
				shell: '/bin/bash',
			};
			mockInvoke.mockResolvedValue({ exitCode: 0 });

			const result = await api.runCommand(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:runCommand', config);
			expect(result.exitCode).toBe(0);
		});

		it('should handle SSH remote config', async () => {
			const config = {
				sessionId: 'session-123',
				command: 'ls -la',
				cwd: '/home/user',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/path',
				},
			};
			mockInvoke.mockResolvedValue({ exitCode: 0 });

			await api.runCommand(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:runCommand', config);
		});
	});

	describe('getActiveProcesses', () => {
		it('should invoke process:getActiveProcesses', async () => {
			const mockProcesses = [
				{
					sessionId: 'session-123',
					toolType: 'claude-code',
					pid: 1234,
					cwd: '/home/user',
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now(),
				},
			];
			mockInvoke.mockResolvedValue(mockProcesses);

			const result = await api.getActiveProcesses();

			expect(mockInvoke).toHaveBeenCalledWith('process:getActiveProcesses');
			expect(result).toEqual(mockProcesses);
		});
	});

	describe('getTerminalCommandState', () => {
		it('should invoke process:getTerminalCommandState with sessionId', async () => {
			mockInvoke.mockResolvedValue({
				currentCommand: 'btop',
				commandRunning: true,
				currentCwd: '/home/user',
			});

			const result = await api.getTerminalCommandState('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('process:getTerminalCommandState', 'session-123');
			expect(result).toEqual({
				currentCommand: 'btop',
				commandRunning: true,
				currentCwd: '/home/user',
			});
		});

		it('should pass through null when session is unknown or not a terminal', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.getTerminalCommandState('unknown-session');

			expect(mockInvoke).toHaveBeenCalledWith('process:getTerminalCommandState', 'unknown-session');
			expect(result).toBeNull();
		});

		it('should pass through idle snapshot (commandRunning: false, no command)', async () => {
			mockInvoke.mockResolvedValue({
				commandRunning: false,
				currentCwd: '/tmp',
			});

			const result = await api.getTerminalCommandState('session-123');

			expect(result).toEqual({
				commandRunning: false,
				currentCwd: '/tmp',
			});
		});
	});

	describe('onData', () => {
		it('should register event listener for process:data', () => {
			const callback = vi.fn();

			const cleanup = api.onData(callback);

			expect(mockOn).toHaveBeenCalledWith('process:data', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback with sessionId and data', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, data: string) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:data') {
					registeredHandler = handler;
				}
			});

			api.onData(callback);
			registeredHandler!({}, 'session-123', 'output data');

			expect(callback).toHaveBeenCalledWith('session-123', 'output data');
		});
	});

	describe('onExit', () => {
		it('should register event listener for process:exit', () => {
			const callback = vi.fn();

			const cleanup = api.onExit(callback);

			expect(mockOn).toHaveBeenCalledWith('process:exit', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});
	});

	describe('onUsage', () => {
		it('should register event listener for process:usage', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, usageStats: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:usage') {
					registeredHandler = handler;
				}
			});

			api.onUsage(callback);

			const usageStats = {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 25,
				totalCostUsd: 0.01,
				contextWindow: 100000,
			};
			registeredHandler!({}, 'session-123', usageStats);

			expect(callback).toHaveBeenCalledWith('session-123', usageStats);
		});
	});

	describe('onAgentError', () => {
		it('should register event listener for agent:error', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, error: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'agent:error') {
					registeredHandler = handler;
				}
			});

			api.onAgentError(callback);

			const error = {
				type: 'auth_expired',
				message: 'Authentication expired',
				recoverable: true,
				agentId: 'claude-code',
				timestamp: Date.now(),
			};
			registeredHandler!({}, 'session-123', error);

			expect(callback).toHaveBeenCalledWith('session-123', error);
		});
	});

	describe('onTerminalCommandState', () => {
		it('should register event listener for process:terminal-command-state', () => {
			const callback = vi.fn();

			const cleanup = api.onTerminalCommandState(callback);

			expect(mockOn).toHaveBeenCalledWith('process:terminal-command-state', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback with sessionId and state', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, state: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:terminal-command-state') {
					registeredHandler = handler;
				}
			});

			api.onTerminalCommandState(callback);

			const state = {
				currentCommand: 'btop',
				commandRunning: true,
				lastExitCode: undefined,
			};
			registeredHandler!({}, 'session-123', state);

			expect(callback).toHaveBeenCalledWith('session-123', state);
		});

		it('should remove listener on cleanup', () => {
			const callback = vi.fn();

			const cleanup = api.onTerminalCommandState(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith(
				'process:terminal-command-state',
				expect.any(Function)
			);
		});
	});

	describe('onTerminalCwd', () => {
		it('should register event listener for process:terminal-cwd', () => {
			const callback = vi.fn();

			const cleanup = api.onTerminalCwd(callback);

			expect(mockOn).toHaveBeenCalledWith('process:terminal-cwd', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback with sessionId and cwd', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, cwd: string) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:terminal-cwd') {
					registeredHandler = handler;
				}
			});

			api.onTerminalCwd(callback);
			registeredHandler!({}, 'session-123', '/Users/me/Downloads');

			expect(callback).toHaveBeenCalledWith('session-123', '/Users/me/Downloads');
		});

		it('should remove listener on cleanup', () => {
			const callback = vi.fn();

			const cleanup = api.onTerminalCwd(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith('process:terminal-cwd', expect.any(Function));
		});
	});

	describe('sendRemoteNewTabResponse', () => {
		it('should send response via ipcRenderer.send', () => {
			api.sendRemoteNewTabResponse('response-channel', { tabId: 'tab-123' });

			expect(mockSend).toHaveBeenCalledWith('response-channel', { tabId: 'tab-123' });
		});

		it('should send null result', () => {
			api.sendRemoteNewTabResponse('response-channel', null);

			expect(mockSend).toHaveBeenCalledWith('response-channel', null);
		});
	});

	describe('onRemoteCommand', () => {
		it('should register listener and invoke callback with all parameters including tabId and force', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!({}, 'session-123', 'test command', 'ai', 'tab-7', true);

			expect(callback).toHaveBeenCalledWith('session-123', 'test command', 'ai', 'tab-7', true);
		});

		it('forwards undefined tabId/force when the IPC sender omits them (legacy callers)', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!({}, 'session-123', 'test command', 'ai');

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				undefined,
				undefined
			);
		});
	});
});
