/**
 * Tests for useOfflineQueue hook
 *
 * This hook provides offline command queueing functionality that stores commands
 * typed while offline and automatically sends them when reconnected.
 *
 * Tests cover:
 * - Round-trip queue persistence via storage adapter
 * - Load on mount behavior
 * - Save on queue change behavior
 * - Queue operations (add, remove, clear)
 * - Processing behavior
 * - Storage adapter injection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useOfflineQueue,
	type QueuedCommand,
	type StorageAdapter,
	createLocalStorageAdapter,
} from '../useOfflineQueue';

// Storage key used by the hook
const STORAGE_KEY = 'maestro-offline-queue';

// Mock webLogger to avoid console noise
vi.mock('../../utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

/**
 * Create a mock storage adapter that wraps an in-memory store
 */
function createMockStorageAdapter(): { adapter: StorageAdapter; store: Record<string, string> } {
	const store: Record<string, string> = {};
	const adapter: StorageAdapter = {
		getItem: vi.fn((key: string) => Promise.resolve(store[key] ?? null)),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
			return Promise.resolve();
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
			return Promise.resolve();
		}),
	};
	return { adapter, store };
}

describe('useOfflineQueue', () => {
	// Default options for hook
	const defaultOptions = {
		isOnline: true,
		isConnected: true,
		sendCommand: vi.fn().mockReturnValue(true),
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('load on mount', () => {
		it('should load queued commands from storage adapter on mount', async () => {
			const { adapter, store } = createMockStorageAdapter();
			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test command 1',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'test command 2',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'terminal',
					attempts: 1,
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			// Wait for async loading
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.queue).toHaveLength(2);
			expect(result.current.queue[0].command).toBe('test command 1');
			expect(result.current.queue[1].command).toBe('test command 2');
			expect(adapter.getItem).toHaveBeenCalledWith(STORAGE_KEY);
		});

		it('should initialize with empty queue when storage is empty', async () => {
			const { adapter } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.queue).toHaveLength(0);
			expect(result.current.queueLength).toBe(0);
		});

		it('should initialize with empty queue when storage has invalid JSON', async () => {
			const { adapter, store } = createMockStorageAdapter();
			store[STORAGE_KEY] = 'invalid json {{';

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.queue).toHaveLength(0);
		});

		it('should initialize with empty queue when storage has non-array data', async () => {
			const { adapter, store } = createMockStorageAdapter();
			store[STORAGE_KEY] = JSON.stringify({ foo: 'bar' });

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.queue).toHaveLength(0);
		});

		it('should work without storage adapter (no-op persistence)', async () => {
			const { result } = renderHook(() =>
				useOfflineQueue({ ...defaultOptions, isOnline: false, isConnected: false, storage: null })
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.queue).toHaveLength(0);

			// Should still be able to queue commands (in-memory)
			act(() => {
				result.current.queueCommand('session-1', 'test', 'ai');
			});

			expect(result.current.queueLength).toBe(1);
		});
	});

	describe('save on change', () => {
		it('should persist queue to storage when command is added', async () => {
			const { adapter, store } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			// Wait for initialization
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.queueCommand('session-1', 'test command', 'ai');
			});

			// Allow async effect to run
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(adapter.setItem).toHaveBeenCalled();
			const savedData = JSON.parse(store[STORAGE_KEY]);
			expect(savedData).toHaveLength(1);
			expect(savedData[0].command).toBe('test command');
		});

		it('should persist queue to storage when command is removed', async () => {
			const { adapter, store } = createMockStorageAdapter();
			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test command 1',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'test command 2',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.removeCommand('cmd-1');
			});

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const savedData = JSON.parse(store[STORAGE_KEY]);
			expect(savedData).toHaveLength(1);
			expect(savedData[0].id).toBe('cmd-2');
		});

		it('should persist empty queue to storage when cleared', async () => {
			const { adapter, store } = createMockStorageAdapter();
			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test command',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.clearQueue();
			});

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const savedData = JSON.parse(store[STORAGE_KEY]);
			expect(savedData).toHaveLength(0);
		});
	});

	describe('round-trip persistence', () => {
		it('should survive unmount/remount with queue intact', async () => {
			const { adapter, store } = createMockStorageAdapter();

			// First render: queue some commands
			const { result: result1, unmount } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result1.current.queueCommand('session-1', 'command 1', 'ai');
				result1.current.queueCommand('session-1', 'command 2', 'terminal');
			});

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Unmount first hook
			unmount();

			// Second render: queue should be restored
			const { result: result2 } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result2.current.queue).toHaveLength(2);
			expect(result2.current.queue[0].command).toBe('command 1');
			expect(result2.current.queue[1].command).toBe('command 2');
		});
	});

	describe('queue operations', () => {
		it('should add command to queue', async () => {
			const { adapter } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				const cmd = result.current.queueCommand('session-1', 'test command', 'ai');
				expect(cmd).not.toBeNull();
				expect(cmd!.command).toBe('test command');
				expect(cmd!.sessionId).toBe('session-1');
				expect(cmd!.inputMode).toBe('ai');
			});

			expect(result.current.queueLength).toBe(1);
		});

		it('should not queue beyond max capacity (50)', async () => {
			const { adapter } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Queue 50 commands
			for (let i = 0; i < 50; i++) {
				act(() => {
					result.current.queueCommand('session-1', `command ${i}`, 'ai');
				});
			}

			expect(result.current.queueLength).toBe(50);
			expect(result.current.canQueue).toBe(false);

			// Try to queue one more
			act(() => {
				const cmd = result.current.queueCommand('session-1', 'overflow', 'ai');
				expect(cmd).toBeNull();
			});

			expect(result.current.queueLength).toBe(50);
		});

		it('should remove specific command', async () => {
			const { adapter } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			let cmdId: string;
			act(() => {
				const cmd1 = result.current.queueCommand('session-1', 'command 1', 'ai');
				cmdId = cmd1!.id;
				result.current.queueCommand('session-1', 'command 2', 'ai');
			});

			expect(result.current.queueLength).toBe(2);

			act(() => {
				result.current.removeCommand(cmdId);
			});

			expect(result.current.queueLength).toBe(1);
			expect(result.current.queue[0].command).toBe('command 2');
		});

		it('should clear all commands', async () => {
			const { adapter } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.queueCommand('session-1', 'command 1', 'ai');
				result.current.queueCommand('session-1', 'command 2', 'ai');
			});

			expect(result.current.queueLength).toBe(2);

			act(() => {
				result.current.clearQueue();
			});

			expect(result.current.queueLength).toBe(0);
			expect(result.current.queue).toEqual([]);
		});
	});

	describe('queue processing', () => {
		it('should process queue when connected', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const onCommandSent = vi.fn();
			const { adapter, store } = createMockStorageAdapter();

			// Start disconnected with a queued command
			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test command',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			const { result, rerender } = renderHook(
				({ isOnline, isConnected }) =>
					useOfflineQueue({
						isOnline,
						isConnected,
						sendCommand,
						onCommandSent,
						storage: adapter,
					}),
				{ initialProps: { isOnline: false, isConnected: false } }
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.queueLength).toBe(1);

			// Reconnect
			rerender({ isOnline: true, isConnected: true });

			// Allow auto-processing timer to fire
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600); // 500ms delay + buffer
			});

			// Allow async processing to complete
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200); // SEND_DELAY
			});

			expect(sendCommand).toHaveBeenCalledWith('session-1', 'test command', undefined);
			expect(onCommandSent).toHaveBeenCalled();
		});

		it('should not process when offline', async () => {
			const sendCommand = vi.fn();
			const { adapter, store } = createMockStorageAdapter();

			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test command',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			const { result } = renderHook(() =>
				useOfflineQueue({
					isOnline: false,
					isConnected: false,
					sendCommand,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			await act(async () => {
				await result.current.processQueue();
			});

			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('should pause and resume processing', async () => {
			const { adapter } = createMockStorageAdapter();

			const { result } = renderHook(() =>
				useOfflineQueue({
					...defaultOptions,
					isOnline: false,
					isConnected: false,
					storage: adapter,
				})
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.status).toBe('idle');

			act(() => {
				result.current.pauseProcessing();
			});

			expect(result.current.status).toBe('paused');

			act(() => {
				result.current.resumeProcessing();
			});

			expect(result.current.status).toBe('idle');
		});
	});

	describe('callbacks', () => {
		it('should call onCommandFailed after max retries', async () => {
			const sendCommand = vi.fn().mockReturnValue(false);
			const onCommandFailed = vi.fn();
			const { adapter, store } = createMockStorageAdapter();

			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'failing command',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 2, // Already tried twice, next is third (max)
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			renderHook(() =>
				useOfflineQueue({
					isOnline: true,
					isConnected: true,
					sendCommand,
					maxRetries: 3,
					onCommandFailed,
					storage: adapter,
				})
			);

			// Wait for storage load + initialization
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Wait for auto-process timer (500ms) to start processing
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});

			// Wait for SEND_DELAY between commands
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			expect(onCommandFailed).toHaveBeenCalled();
		});

		it('should call onProcessingStart and onProcessingComplete', async () => {
			const onProcessingStart = vi.fn();
			const onProcessingComplete = vi.fn();
			const sendCommand = vi.fn().mockReturnValue(true);
			const { adapter, store } = createMockStorageAdapter();

			const storedCommands: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 'session-1',
					timestamp: Date.now(),
					inputMode: 'ai',
					attempts: 0,
				},
			];
			store[STORAGE_KEY] = JSON.stringify(storedCommands);

			renderHook(() =>
				useOfflineQueue({
					isOnline: true,
					isConnected: true,
					sendCommand,
					onProcessingStart,
					onProcessingComplete,
					storage: adapter,
				})
			);

			// Wait for storage load + initialization
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Wait for auto-process timer (500ms) to start processing
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});

			// Wait for SEND_DELAY between commands
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			expect(onProcessingStart).toHaveBeenCalled();
			expect(onProcessingComplete).toHaveBeenCalledWith(1, 0);
		});
	});

	describe('createLocalStorageAdapter', () => {
		it('should create a localStorage-backed adapter', async () => {
			// Mock localStorage
			const mockStorage: Record<string, string> = {};
			vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
				(key: string) => mockStorage[key] ?? null
			);
			vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
				mockStorage[key] = value;
			});
			vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
				delete mockStorage[key];
			});

			const adapter = createLocalStorageAdapter();
			expect(adapter).not.toBeNull();

			// Test the adapter works
			await adapter!.setItem('test-key', 'test-value');
			const value = await adapter!.getItem('test-key');
			expect(value).toBe('test-value');

			await adapter!.removeItem('test-key');
			const removed = await adapter!.getItem('test-key');
			expect(removed).toBeNull();
		});
	});
});
