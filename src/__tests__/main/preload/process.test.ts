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

	type Callback = (...args: unknown[]) => void;

	function expectListenerBridge({
		channel,
		register,
		eventArgs,
		expectedArgs,
	}: {
		channel: string;
		register: (callback: Callback) => () => void;
		eventArgs: unknown[];
		expectedArgs: unknown[];
	}) {
		const callback = vi.fn();
		let registeredHandler: ((event: unknown, ...args: unknown[]) => void) | undefined;

		mockOn.mockImplementation(
			(receivedChannel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
				if (receivedChannel === channel) {
					registeredHandler = handler;
				}
			}
		);

		const cleanup = register(callback);
		registeredHandler!({}, ...eventArgs);
		cleanup();

		expect(mockOn).toHaveBeenCalledWith(channel, registeredHandler);
		expect(callback).toHaveBeenCalledWith(...expectedArgs);
		expect(mockRemoveListener).toHaveBeenCalledWith(channel, registeredHandler);
	}

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
		it('should register listener and invoke callback with all parameters', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal'
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!({}, 'session-123', 'test command', 'ai');

			expect(callback).toHaveBeenCalledWith('session-123', 'test command', 'ai');
		});

		it('should log callback errors instead of throwing across the preload boundary', () => {
			const callback = vi.fn(() => {
				throw new Error('callback failed');
			});
			let registeredHandler:
				| ((
						event: unknown,
						sessionId: string,
						command: string,
						inputMode?: 'ai' | 'terminal'
				  ) => void)
				| undefined;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			mockInvoke.mockClear();

			registeredHandler!({}, 'session-123', 'test command', 'terminal');

			expect(callback).toHaveBeenCalledWith('session-123', 'test command', 'terminal');
			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'error',
				'Error invoking remote command callback',
				'Preload',
				{ error: 'Error: callback failed' }
			);
		});
	});

	describe('event callback wrappers', () => {
		it('should bridge process event callbacks and remove listeners on cleanup', () => {
			const toolEvent = { toolName: 'Edit', timestamp: 1000 };
			const usageStats = {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 25,
				totalCostUsd: 0.01,
				contextWindow: 100000,
			};
			const agentError = {
				type: 'auth_expired',
				message: 'Authentication expired',
				recoverable: true,
				agentId: 'claude-code',
				timestamp: 1000,
			};
			const sshRemote = { id: 'remote-1', name: 'Remote', host: 'example.com' };

			const cases: Array<{
				channel: string;
				register: (callback: Callback) => () => void;
				eventArgs: unknown[];
				expectedArgs: unknown[];
			}> = [
				{
					channel: 'process:data',
					register: (callback) => api.onData(callback),
					eventArgs: ['session-1', 'stdout'],
					expectedArgs: ['session-1', 'stdout'],
				},
				{
					channel: 'process:exit',
					register: (callback) => api.onExit(callback),
					eventArgs: ['session-1', 0],
					expectedArgs: ['session-1', 0],
				},
				{
					channel: 'process:session-id',
					register: (callback) => api.onSessionId(callback),
					eventArgs: ['session-1', 'agent-session-1'],
					expectedArgs: ['session-1', 'agent-session-1'],
				},
				{
					channel: 'process:slash-commands',
					register: (callback) => api.onSlashCommands(callback),
					eventArgs: ['session-1', ['/help', '/clear']],
					expectedArgs: ['session-1', ['/help', '/clear']],
				},
				{
					channel: 'process:thinking-chunk',
					register: (callback) => api.onThinkingChunk(callback),
					eventArgs: ['session-1', 'partial thought'],
					expectedArgs: ['session-1', 'partial thought'],
				},
				{
					channel: 'process:tool-execution',
					register: (callback) => api.onToolExecution(callback),
					eventArgs: ['session-1', toolEvent],
					expectedArgs: ['session-1', toolEvent],
				},
				{
					channel: 'process:ssh-remote',
					register: (callback) => api.onSshRemote(callback),
					eventArgs: ['session-1', sshRemote],
					expectedArgs: ['session-1', sshRemote],
				},
				{
					channel: 'process:stderr',
					register: (callback) => api.onStderr(callback),
					eventArgs: ['session-1', 'stderr'],
					expectedArgs: ['session-1', 'stderr'],
				},
				{
					channel: 'process:command-exit',
					register: (callback) => api.onCommandExit(callback),
					eventArgs: ['session-1', 2],
					expectedArgs: ['session-1', 2],
				},
				{
					channel: 'process:usage',
					register: (callback) => api.onUsage(callback),
					eventArgs: ['session-1', usageStats],
					expectedArgs: ['session-1', usageStats],
				},
				{
					channel: 'agent:error',
					register: (callback) => api.onAgentError(callback),
					eventArgs: ['session-1', agentError],
					expectedArgs: ['session-1', agentError],
				},
			];

			for (const testCase of cases) {
				vi.clearAllMocks();
				expectListenerBridge(testCase);
			}
		});

		it('should bridge remote-control callbacks and remove listeners on cleanup', () => {
			const cases: Array<{
				channel: string;
				register: (callback: Callback) => () => void;
				eventArgs: unknown[];
				expectedArgs: unknown[];
			}> = [
				{
					channel: 'remote:executeCommand',
					register: (callback) => api.onRemoteCommand(callback),
					eventArgs: ['session-1', 'npm test', 'terminal'],
					expectedArgs: ['session-1', 'npm test', 'terminal'],
				},
				{
					channel: 'remote:switchMode',
					register: (callback) => api.onRemoteSwitchMode(callback),
					eventArgs: ['session-1', 'terminal'],
					expectedArgs: ['session-1', 'terminal'],
				},
				{
					channel: 'remote:interrupt',
					register: (callback) => api.onRemoteInterrupt(callback),
					eventArgs: ['session-1'],
					expectedArgs: ['session-1'],
				},
				{
					channel: 'remote:selectSession',
					register: (callback) => api.onRemoteSelectSession(callback),
					eventArgs: ['session-1', 'tab-1'],
					expectedArgs: ['session-1', 'tab-1'],
				},
				{
					channel: 'remote:selectTab',
					register: (callback) => api.onRemoteSelectTab(callback),
					eventArgs: ['session-1', 'tab-1'],
					expectedArgs: ['session-1', 'tab-1'],
				},
				{
					channel: 'remote:newTab',
					register: (callback) => api.onRemoteNewTab(callback),
					eventArgs: ['session-1', 'response-channel'],
					expectedArgs: ['session-1', 'response-channel'],
				},
				{
					channel: 'remote:closeTab',
					register: (callback) => api.onRemoteCloseTab(callback),
					eventArgs: ['session-1', 'tab-1'],
					expectedArgs: ['session-1', 'tab-1'],
				},
				{
					channel: 'remote:renameTab',
					register: (callback) => api.onRemoteRenameTab(callback),
					eventArgs: ['session-1', 'tab-1', 'New name'],
					expectedArgs: ['session-1', 'tab-1', 'New name'],
				},
				{
					channel: 'remote:starTab',
					register: (callback) => api.onRemoteStarTab(callback),
					eventArgs: ['session-1', 'tab-1', true],
					expectedArgs: ['session-1', 'tab-1', true],
				},
				{
					channel: 'remote:reorderTab',
					register: (callback) => api.onRemoteReorderTab(callback),
					eventArgs: ['session-1', 2, 0],
					expectedArgs: ['session-1', 2, 0],
				},
				{
					channel: 'remote:toggleBookmark',
					register: (callback) => api.onRemoteToggleBookmark(callback),
					eventArgs: ['session-1'],
					expectedArgs: ['session-1'],
				},
			];

			for (const testCase of cases) {
				vi.clearAllMocks();
				expectListenerBridge(testCase);
			}
		});
	});
});
