/**
 * Tests for process/core preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createProcessCoreApi, type ProcessConfig } from '../../../../main/preload/process/core';
import type { NativeSessionLaunch } from '../../../../main/process-manager/types';

vi.mock('../../../../shared/uuid', () => ({ generateUUID: vi.fn(() => 'colliding-uuid') }));

describe('Process Core Preload API', () => {
	let api: ReturnType<typeof createProcessCoreApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockReset();
		mockOn.mockReset();
		mockRemoveListener.mockReset();
		api = createProcessCoreApi();
	});

	describe('pending permission runtime', () => {
		it('reads only the metadata snapshot through the native IPC channel', async () => {
			const snapshot = { version: 4, processIds: ['agent-ai-tab'] };
			mockInvoke.mockResolvedValue(snapshot);
			expect(await api.getPendingPermissions()).toEqual(snapshot);
			expect(mockInvoke).toHaveBeenCalledWith('process:getPendingPermissions');
		});
		it('forwards versioned status events and unregisters its listener', () => {
			const callback = vi.fn();
			const off = api.onPendingPermissionsChanged(callback);
			const handler = mockOn.mock.calls.find(
				([channel]) => channel === 'process:pending-permissions'
			)![1];
			handler({}, { version: 5, processIds: [] });
			expect(callback).toHaveBeenCalledWith({ version: 5, processIds: [] });
			off();
			expect(mockRemoveListener).toHaveBeenCalledWith('process:pending-permissions', handler);
		});
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

			expect(mockInvoke).toHaveBeenCalledWith('process:spawn', {
				...config,
				nativeSessionRequestId: expect.stringMatching(/^colliding-uuid-\d+$/),
			});
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

	describe('native spawn attempts', () => {
		const config: ProcessConfig = {
			sessionId: 'agent-ai-tab-a',
			tabId: 'tab-a',
			toolType: 'grok',
			cwd: path.resolve('fixture', 'project'),
			command: 'grok',
			args: ['--resume', 'native-requested'],
			agentSessionId: 'native-requested',
		};

		it('announces a frozen snapshot before IPC and isolates caller mutations', async () => {
			const caller = { ...structuredClone(config), nativeSessionRequestId: 'caller-token' };
			const observer = vi.fn((attempt) => {
				expect(mockInvoke).not.toHaveBeenCalled();
				expect(Object.isFrozen(attempt)).toBe(true);
				caller.tabId = 'changed-tab';
				caller.agentSessionId = 'changed-native';
				caller.cwd = path.resolve('changed');
				caller.args.push('--changed');
			});
			api.onSpawnAttempt(observer);
			const result = { pid: 1234, success: true };
			mockInvoke.mockResolvedValue(result);
			const pending = api.spawn(caller);
			const attempt = observer.mock.calls[0][0];
			expect(attempt).toEqual({
				sessionId: config.sessionId,
				tabId: config.tabId,
				toolType: 'grok',
				requestedNativeSessionId: 'native-requested',
				nativeSessionRequestId: expect.stringMatching(/^colliding-uuid-\d+$/),
			});
			expect(mockInvoke.mock.calls).toEqual([
				[
					'process:spawn',
					{
						...config,
						nativeSessionRequestId: attempt.nativeSessionRequestId,
					},
				],
			]);
			await expect(pending).resolves.toBe(result);
		});

		it('gives AI successors and other API instances unique tokens despite UUID collisions', async () => {
			const observer = vi.fn();
			const other = createProcessCoreApi();
			api.onSpawnAttempt(observer);
			other.onSpawnAttempt(observer);
			for (const [bridge, toolType] of [
				[api, 'grok'],
				[api, 'codex'],
				[other, 'grok'],
			] as const) {
				await bridge.spawn({ ...config, toolType });
			}
			const attempts = observer.mock.calls.map(([attempt]) => attempt);
			expect(attempts.map((attempt) => attempt.toolType)).toEqual(['grok', 'codex', 'grok']);
			expect(new Set(attempts.map((attempt) => attempt.nativeSessionRequestId)).size).toBe(3);
			expect(mockInvoke.mock.calls.map(([, payload]) => payload.nativeSessionRequestId)).toEqual(
				attempts.map((attempt) => attempt.nativeSessionRequestId)
			);
		});

		it('does not invent a tab or native ID for an untargeted fresh attempt', async () => {
			const observer = vi.fn();
			api.onSpawnAttempt(observer);
			await api.spawn({ ...config, tabId: undefined, agentSessionId: undefined });
			expect(observer.mock.calls).toEqual([
				[
					{
						sessionId: config.sessionId,
						toolType: 'grok',
						nativeSessionRequestId: expect.stringMatching(/^colliding-uuid-\d+$/),
					},
				],
			]);
		});

		it('keeps all subscribers and IPC in order for reentrant spawns without waiting for replies', async () => {
			const order: string[] = [];
			const pending: Array<ReturnType<typeof api.spawn>> = [];
			mockInvoke.mockImplementation((_channel, payload) => {
				order.push(`ipc:${payload.toolType}`);
				return Promise.resolve({ pid: 1234, success: true });
			});
			api.onSpawnAttempt((attempt) => {
				order.push(`first:${attempt.toolType}`);
				if (attempt.toolType === 'grok') pending.push(api.spawn({ ...config, toolType: 'codex' }));
			});
			api.onSpawnAttempt((attempt) => order.push(`second:${attempt.toolType}`));
			pending.push(api.spawn(config));
			expect(order).toEqual([
				'first:grok',
				'second:grok',
				'ipc:grok',
				'first:codex',
				'second:codex',
				'ipc:codex',
			]);
			await Promise.all(pending);
		});

		it('notifies remaining subscribers after callback failure and still delivers a queued successor', async () => {
			const error = new Error('observer failed');
			const observer = vi.fn();
			const pending: Array<ReturnType<typeof api.spawn>> = [];
			api.onSpawnAttempt((attempt) => {
				if (attempt.toolType === 'grok') {
					pending.push(api.spawn({ ...config, toolType: 'codex' }));
					throw error;
				}
			});
			api.onSpawnAttempt(observer);
			await expect(api.spawn(config)).rejects.toBe(error);
			await Promise.all(pending);
			expect(observer.mock.calls.map(([attempt]) => attempt.toolType)).toEqual(['grok', 'codex']);
			expect(mockInvoke.mock.calls).toEqual([
				[
					'process:spawn',
					{
						...config,
						toolType: 'codex',
						nativeSessionRequestId: observer.mock.calls[1][0].nativeSessionRequestId,
					},
				],
			]);
		});

		it('unsubscribes immediately during delivery and never replays across subscriptions or API lifetimes', async () => {
			const removed = vi.fn();
			const removeFirst = api.onSpawnAttempt(() => removeSecond());
			const removeSecond = api.onSpawnAttempt(removed);
			await api.spawn(config);
			expect(removed).not.toHaveBeenCalled();
			removeFirst();
			removeSecond();
			const late = vi.fn();
			const removeLate = api.onSpawnAttempt(late);
			createProcessCoreApi().onSpawnAttempt(removed);
			expect(late).not.toHaveBeenCalled();
			await api.spawn(config);
			expect(late).toHaveBeenCalledTimes(1);
			expect(removed).not.toHaveBeenCalled();
			removeLate();
			await api.spawn(config);
			expect(late).toHaveBeenCalledTimes(1);
			expect(mockOn).not.toHaveBeenCalled();
		});

		it('announces uncloneable requests but refuses IPC', async () => {
			const observer = vi.fn();
			api.onSpawnAttempt(observer);
			await expect(
				api.spawn({ ...config, unsupported: () => {} } as ProcessConfig)
			).rejects.toThrow();
			expect(observer).toHaveBeenCalledTimes(1);
			expect(observer.mock.calls[0][0].requestedNativeSessionId).toBe('native-requested');
			expect(mockInvoke).not.toHaveBeenCalled();
		});

		it.each(['throw', 'reject', 'false'] as const)(
			'retains the latest announcement after invoke %s',
			async (failure) => {
				const observer = vi.fn();
				api.onSpawnAttempt(observer);
				await api.spawn(config);
				const error = new Error('spawn failed');
				mockInvoke.mockImplementationOnce(() => {
					if (failure === 'throw') throw error;
					return failure === 'reject' ? Promise.reject(error) : { pid: 0, success: false };
				});
				const failed = api.spawn(config);
				if (failure === 'false') await expect(failed).resolves.toEqual({ pid: 0, success: false });
				else await expect(failed).rejects.toBe(error);
				expect(observer).toHaveBeenCalledTimes(2);
				expect(observer.mock.calls[1][0].nativeSessionRequestId).not.toBe(
					observer.mock.calls[0][0].nativeSessionRequestId
				);
				await api.spawn(config);
				expect(observer).toHaveBeenCalledTimes(3);
			}
		);

		it('leaves terminal spawns and cancellation outside AI attempt notifications', async () => {
			const observer = vi.fn();
			api.onSpawnAttempt(observer);
			const terminal = { ...config, toolType: 'terminal' };
			await api.spawn(terminal);
			expect(mockInvoke.mock.calls).toEqual([['process:spawn', terminal]]);
			expect(mockInvoke.mock.calls[0][1]).toBe(terminal);
			expect(observer).not.toHaveBeenCalled();
			await api.spawn(config);
			await api.interrupt(config.sessionId);
			await api.kill(config.sessionId);
			expect(observer).toHaveBeenCalledTimes(1);
		});
	});

	describe('onSessionId', () => {
		it.each(['local', 'ssh', 'unknown'] as const)(
			'forwards exact %s launch provenance and distinct observed ID',
			(kind) => {
				const receipt: NativeSessionLaunch = {
					scope:
						kind === 'unknown'
							? { version: 1, state: 'unknown', reason: 'unobserved' }
							: {
									version: 1,
									state: 'bound',
									provider: 'grok',
									accountRef: 'account-α',
									cwd: kind === 'local' ? path.resolve('fixture', 'project') : '/srv/project',
									host: { kind, identity: `${kind}-endpoint-a` },
								},
					processGeneration: 17,
					tabId: 'tab-a',
					requestedNativeSessionId: 'requested-native',
					nativeSessionRequestId: 'request-a',
				};
				const callback = vi.fn();
				const original = structuredClone(receipt);
				const unsubscribe = api.onSessionId(callback);
				expect(mockOn).toHaveBeenCalledWith('process:session-id', expect.any(Function));
				const handler = mockOn.mock.calls[0][1];
				handler({}, 'agent-ai-tab-a', 'different-observed-native', receipt);
				handler({}, 'agent-ai-tab-b', 'same-native-id');
				expect(callback.mock.calls).toEqual([
					['agent-ai-tab-a', 'different-observed-native', original],
					['agent-ai-tab-b', 'same-native-id'],
				]);
				expect(receipt).toEqual(original);
				expect(callback.mock.calls[0][2]).toBe(receipt);
				expect(mockInvoke).not.toHaveBeenCalled();
				unsubscribe();
				expect(mockRemoveListener.mock.calls).toEqual([['process:session-id', handler]]);
			}
		);

		it('keeps receipt-free events exactly two arguments, including absent native IDs', () => {
			const callback = vi.fn();
			api.onSessionId(callback);
			const handler = mockOn.mock.calls[0][1];
			handler({}, 'agent-ai-tab-a', 'legacy-native');
			handler({}, 'agent-ai-tab-a', '', undefined);
			expect(callback.mock.calls).toEqual([
				['agent-ai-tab-a', 'legacy-native'],
				['agent-ai-tab-a', ''],
			]);
			expect(mockInvoke).not.toHaveBeenCalled();
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

	describe('broadcastUserInput', () => {
		it('should invoke process:broadcast-user-input with payload', async () => {
			const payload = {
				originId: 'origin-1',
				sessionId: 'session-123',
				tabId: 'tab-1',
				inputMode: 'ai' as const,
				entry: {
					id: 'entry-1',
					timestamp: 123,
					source: 'user' as const,
					text: 'Hello',
				},
			};
			mockInvoke.mockResolvedValue(undefined);

			await api.broadcastUserInput(payload);

			expect(mockInvoke).toHaveBeenCalledWith('process:broadcast-user-input', payload);
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

	describe('cancelCommand', () => {
		it('should invoke process:cancelCommand with the session id', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.cancelCommand('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('process:cancelCommand', {
				sessionId: 'session-123',
			});
			expect(result).toBe(true);
		});

		it('should return false when nothing was running', async () => {
			mockInvoke.mockResolvedValue(false);

			await expect(api.cancelCommand('session-gone')).resolves.toBe(false);
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

		it('should pass active-process query options', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.getActiveProcesses({ includeChildProcesses: false });

			expect(mockInvoke).toHaveBeenCalledWith('process:getActiveProcesses', {
				includeChildProcesses: false,
			});
		});
	});

	describe('isTerminalBusy', () => {
		it('should invoke process:isTerminalBusy with the session id', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.isTerminalBusy('session-1-terminal-tab-1');

			expect(mockInvoke).toHaveBeenCalledWith('process:isTerminalBusy', 'session-1-terminal-tab-1');
			expect(result).toBe(true);
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

	describe('onCallUsage', () => {
		it('should register event listener for process:call-usage and unsubscribe it', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, usage: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:call-usage') {
					registeredHandler = handler;
				}
			});

			const cleanup = api.onCallUsage(callback);

			const usage = {
				inputTokens: 2,
				outputTokens: 300,
				cacheReadInputTokens: 160000,
				cacheCreationInputTokens: 1000,
			};
			registeredHandler!({}, 'session-123', usage);

			expect(callback).toHaveBeenCalledWith('session-123', usage);
			cleanup();
			expect(mockRemoveListener).toHaveBeenCalledWith('process:call-usage', registeredHandler!);
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

	describe('onAuthExpired', () => {
		it('should register event listener for agent:authExpired', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, payload: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'agent:authExpired') {
					registeredHandler = handler;
				}
			});

			api.onAuthExpired(callback);

			const payload = {
				sessionId: 'session-123',
				agentId: 'claude-code',
				message: 'OAuth token has expired.',
				fromPipeline: true,
			};
			registeredHandler!({}, payload);

			expect(callback).toHaveBeenCalledWith(payload);
		});

		it('should remove the listener on unsubscribe', () => {
			const unsubscribe = api.onAuthExpired(vi.fn());
			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('agent:authExpired', expect.any(Function));
		});
	});
});
