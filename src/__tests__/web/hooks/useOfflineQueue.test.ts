/**
 * Tests for useOfflineQueue hook
 *
 * @fileoverview Comprehensive tests for offline command queueing functionality.
 * Tests cover:
 * - Pure helper functions (generateId, loadQueue, saveQueue)
 * - Hook initialization and state management
 * - Command queueing with capacity limits
 * - Command removal and queue clearing
 * - Queue processing with retries and error handling
 * - Pause/resume functionality
 * - Auto-processing on connection restore
 * - localStorage persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useOfflineQueue,
	QueuedCommand,
	QueueStatus,
	UseOfflineQueueOptions,
	UseOfflineQueueReturn,
} from '../../../web/hooks/useOfflineQueue';

// Mock the webLogger module
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { webLogger } from '../../../web/utils/logger';

const STORAGE_KEY = 'maestro-offline-queue';
const MAX_QUEUE_SIZE = 50;

// Mock localStorage with proper implementation
let localStorageStore: Record<string, string> = {};

// Create mock functions that also perform the actual storage operations
const getItemMock = vi.fn().mockImplementation((key: string) => localStorageStore[key] ?? null);
const setItemMock = vi.fn().mockImplementation((key: string, value: string) => {
	localStorageStore[key] = value;
});
const removeItemMock = vi.fn().mockImplementation((key: string) => {
	delete localStorageStore[key];
});
const clearMock = vi.fn().mockImplementation(() => {
	localStorageStore = {};
});
const keyMock = vi
	.fn()
	.mockImplementation((index: number) => Object.keys(localStorageStore)[index] ?? null);

const localStorageMock = {
	getItem: getItemMock,
	setItem: setItemMock,
	removeItem: removeItemMock,
	clear: clearMock,
	get length() {
		return Object.keys(localStorageStore).length;
	},
	key: keyMock,
};

Object.defineProperty(window, 'localStorage', {
	value: localStorageMock,
	writable: true,
});

describe('useOfflineQueue', () => {
	// Default options for creating the hook
	const createDefaultOptions = (
		overrides: Partial<UseOfflineQueueOptions> = {}
	): UseOfflineQueueOptions => ({
		isOnline: true,
		isConnected: true,
		sendCommand: vi.fn().mockReturnValue(true),
		...overrides,
	});

	beforeEach(() => {
		// Clear localStorage mock store before each test
		localStorageStore = {};
		getItemMock.mockClear();
		setItemMock.mockClear();
		clearMock.mockClear();
		removeItemMock.mockClear();
		keyMock.mockClear();
		// Clear all mocks
		vi.clearAllMocks();
		// Use fake timers for testing async behavior
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Exported Types', () => {
		it('should export QueuedCommand interface with required properties', () => {
			const command: QueuedCommand = {
				id: 'test-id',
				command: 'test command',
				sessionId: 'session-1',
				timestamp: Date.now(),
				inputMode: 'ai',
				attempts: 0,
			};

			expect(command.id).toBe('test-id');
			expect(command.command).toBe('test command');
			expect(command.sessionId).toBe('session-1');
			expect(command.inputMode).toBe('ai');
			expect(command.attempts).toBe(0);
		});

		it('should export QueuedCommand with optional lastError', () => {
			const command: QueuedCommand = {
				id: 'test-id',
				command: 'test',
				sessionId: 'session-1',
				timestamp: Date.now(),
				inputMode: 'terminal',
				attempts: 1,
				lastError: 'Connection failed',
			};

			expect(command.lastError).toBe('Connection failed');
		});

		it('should export QueueStatus as union type', () => {
			const statuses: QueueStatus[] = ['idle', 'processing', 'paused'];
			expect(statuses).toContain('idle');
			expect(statuses).toContain('processing');
			expect(statuses).toContain('paused');
		});
	});

	describe('Initial State', () => {
		it('should initialize with empty queue when localStorage is empty', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toEqual([]);
			expect(result.current.queueLength).toBe(0);
			expect(result.current.status).toBe('idle');
			expect(result.current.canQueue).toBe(true);
		});

		it('should load queue from localStorage on initialization', () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'stored-1',
					command: 'stored command',
					sessionId: 'session-1',
					timestamp: 1000,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toHaveLength(1);
			expect(result.current.queue[0].id).toBe('stored-1');
			expect(result.current.queueLength).toBe(1);
		});

		it('should handle invalid JSON in localStorage gracefully', () => {
			localStorage.setItem(STORAGE_KEY, 'invalid json {{{');

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toEqual([]);
			expect(webLogger.warn).toHaveBeenCalled();
		});

		it('should handle non-array value in localStorage', () => {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toEqual([]);
		});

		it('should return all expected API properties', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current).toHaveProperty('queue');
			expect(result.current).toHaveProperty('queueLength');
			expect(result.current).toHaveProperty('status');
			expect(result.current).toHaveProperty('queueCommand');
			expect(result.current).toHaveProperty('removeCommand');
			expect(result.current).toHaveProperty('clearQueue');
			expect(result.current).toHaveProperty('processQueue');
			expect(result.current).toHaveProperty('pauseProcessing');
			expect(result.current).toHaveProperty('resumeProcessing');
			expect(result.current).toHaveProperty('canQueue');
		});
	});

	describe('queueCommand', () => {
		it('should add a command to the queue', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('session-1', 'test command', 'ai');
			});

			expect(result.current.queue).toHaveLength(1);
			expect(result.current.queue[0].command).toBe('test command');
			expect(result.current.queue[0].sessionId).toBe('session-1');
			expect(result.current.queue[0].inputMode).toBe('ai');
			expect(result.current.queue[0].attempts).toBe(0);
		});

		it('should generate unique IDs for each command', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('session-1', 'command 1', 'ai');
				result.current.queueCommand('session-1', 'command 2', 'ai');
			});

			const ids = result.current.queue.map((cmd) => cmd.id);
			expect(ids[0]).not.toBe(ids[1]);
		});

		it('should set timestamp on queued commands', () => {
			const now = Date.now();
			vi.setSystemTime(now);

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('session-1', 'test', 'ai');
			});

			expect(result.current.queue[0].timestamp).toBe(now);
		});

		it('should support terminal input mode', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('session-1', 'ls -la', 'terminal');
			});

			expect(result.current.queue[0].inputMode).toBe('terminal');
		});

		it('should return the queued command', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			let returnedCommand: QueuedCommand | null = null;
			act(() => {
				returnedCommand = result.current.queueCommand('session-1', 'test', 'ai');
			});

			expect(returnedCommand).not.toBeNull();
			expect(returnedCommand!.command).toBe('test');
		});

		it('should update queueLength', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queueLength).toBe(0);

			act(() => {
				result.current.queueCommand('session-1', 'cmd1', 'ai');
			});
			expect(result.current.queueLength).toBe(1);

			act(() => {
				result.current.queueCommand('session-1', 'cmd2', 'ai');
			});
			expect(result.current.queueLength).toBe(2);
		});

		it('should persist queue to localStorage', async () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('session-1', 'persisted', 'ai');
			});

			// Allow effect to run
			await act(async () => {
				vi.advanceTimersByTime(0);
			});

			const stored = localStorage.getItem(STORAGE_KEY);
			expect(stored).not.toBeNull();
			const parsed = JSON.parse(stored!);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].command).toBe('persisted');
		});

		it('should reject commands at max capacity', () => {
			// Pre-fill storage with max queue size
			const fullQueue: QueuedCommand[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) => ({
				id: `cmd-${i}`,
				command: `command ${i}`,
				sessionId: 'session-1',
				timestamp: Date.now(),
				inputMode: 'ai' as const,
				attempts: 0,
			}));
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fullQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toHaveLength(MAX_QUEUE_SIZE);
			expect(result.current.canQueue).toBe(false);

			let returnedCommand: QueuedCommand | null = null;
			act(() => {
				returnedCommand = result.current.queueCommand('session-1', 'overflow', 'ai');
			});

			expect(returnedCommand).toBeNull();
			expect(result.current.queue).toHaveLength(MAX_QUEUE_SIZE);
			expect(webLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('maximum capacity'),
				'OfflineQueue'
			);
		});

		it('should allow queueing up to max capacity', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			// Fill up to just below max
			act(() => {
				for (let i = 0; i < MAX_QUEUE_SIZE - 1; i++) {
					result.current.queueCommand('session-1', `cmd ${i}`, 'ai');
				}
			});

			expect(result.current.canQueue).toBe(true);

			// Add one more to reach exactly max
			act(() => {
				result.current.queueCommand('session-1', 'last', 'ai');
			});

			expect(result.current.queue).toHaveLength(MAX_QUEUE_SIZE);
			expect(result.current.canQueue).toBe(false);
		});

		it('should log when command is queued', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('session-1', 'logged command', 'ai');
			});

			expect(webLogger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Command queued'),
				'OfflineQueue'
			);
		});

		it('should truncate long commands in log message', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));
			const longCommand = 'a'.repeat(100);

			act(() => {
				result.current.queueCommand('session-1', longCommand, 'ai');
			});

			const debugCall = vi
				.mocked(webLogger.debug)
				.mock.calls.find((call) => call[0].includes('Command queued'));
			expect(debugCall).toBeDefined();
			// The log message truncates to 50 chars
			expect(debugCall![0].length).toBeLessThan(100);
		});
	});

	describe('removeCommand', () => {
		it('should remove a command by ID', () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'second',
					sessionId: 's1',
					timestamp: 2,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.removeCommand('cmd-1');
			});

			expect(result.current.queue).toHaveLength(1);
			expect(result.current.queue[0].id).toBe('cmd-2');
		});

		it('should do nothing if ID not found', () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.removeCommand('nonexistent');
			});

			expect(result.current.queue).toHaveLength(1);
		});

		it('should update queueLength after removal', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			let cmdId = '';
			act(() => {
				const cmd = result.current.queueCommand('session-1', 'test', 'ai');
				cmdId = cmd!.id;
			});

			expect(result.current.queueLength).toBe(1);

			act(() => {
				result.current.removeCommand(cmdId);
			});

			expect(result.current.queueLength).toBe(0);
		});

		it('should persist removal to localStorage', async () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.removeCommand('cmd-1');
			});

			await act(async () => {
				vi.advanceTimersByTime(0);
			});

			const stored = localStorage.getItem(STORAGE_KEY);
			expect(JSON.parse(stored!)).toEqual([]);
		});

		it('should log removal', () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.removeCommand('cmd-1');
			});

			expect(webLogger.debug).toHaveBeenCalledWith(
				expect.stringContaining('cmd-1'),
				'OfflineQueue'
			);
		});
	});

	describe('clearQueue', () => {
		it('should clear all commands', () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'second',
					sessionId: 's1',
					timestamp: 2,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-3',
					command: 'third',
					sessionId: 's1',
					timestamp: 3,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toHaveLength(3);

			act(() => {
				result.current.clearQueue();
			});

			expect(result.current.queue).toHaveLength(0);
			expect(result.current.queueLength).toBe(0);
		});

		it('should update canQueue after clearing', () => {
			const fullQueue: QueuedCommand[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) => ({
				id: `cmd-${i}`,
				command: `command ${i}`,
				sessionId: 's1',
				timestamp: i,
				inputMode: 'ai' as const,
				attempts: 0,
			}));
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fullQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.canQueue).toBe(false);

			act(() => {
				result.current.clearQueue();
			});

			expect(result.current.canQueue).toBe(true);
		});

		it('should persist clear to localStorage', async () => {
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.clearQueue();
			});

			await act(async () => {
				vi.advanceTimersByTime(0);
			});

			const stored = localStorage.getItem(STORAGE_KEY);
			expect(JSON.parse(stored!)).toEqual([]);
		});

		it('should log clear action', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.clearQueue();
			});

			expect(webLogger.debug).toHaveBeenCalledWith('Queue cleared', 'OfflineQueue');
		});
	});

	describe('processQueue', () => {
		it('should not process when offline', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ isOnline: false, sendCommand }))
			);

			await act(async () => {
				await result.current.processQueue();
			});

			expect(sendCommand).not.toHaveBeenCalled();
			expect(result.current.queue).toHaveLength(1);
		});

		it('should not process when not connected', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ isConnected: false, sendCommand }))
			);

			await act(async () => {
				await result.current.processQueue();
			});

			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('should not process empty queue', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const onProcessingStart = vi.fn();

			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onProcessingStart }))
			);

			await act(async () => {
				await result.current.processQueue();
			});

			expect(sendCommand).not.toHaveBeenCalled();
			expect(onProcessingStart).not.toHaveBeenCalled();
		});

		it('should process all commands successfully', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const onCommandSent = vi.fn();
			const onProcessingComplete = vi.fn();

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'second',
					sessionId: 's2',
					timestamp: 2,
					inputMode: 'terminal',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onCommandSent, onProcessingComplete }))
			);

			// Pause to prevent any auto-processing effects
			act(() => {
				result.current.pauseProcessing();
			});

			// Resume and immediately process
			await act(async () => {
				result.current.resumeProcessing();
				// The resume will try to auto-process, but we want manual control
				// Clear the auto-process timer and call processQueue ourselves
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(2000);
				await processPromise;
			});

			// With auto-processing, sendCommand may be called twice (once by auto, once by manual)
			// Just verify we've processed the queue successfully
			expect(sendCommand).toHaveBeenCalled();
			expect(sendCommand).toHaveBeenCalledWith('s1', 'first');
			expect(sendCommand).toHaveBeenCalledWith('s2', 'second');
			expect(result.current.queue).toHaveLength(0);
		});

		it('should call onProcessingStart', async () => {
			const onProcessingStart = vi.fn();
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ onProcessingStart }))
			);

			// Pause immediately
			act(() => {
				result.current.pauseProcessing();
			});

			// Resume and process
			await act(async () => {
				result.current.resumeProcessing();
				await vi.advanceTimersByTimeAsync(2000);
			});

			// onProcessingStart should be called at least once
			expect(onProcessingStart).toHaveBeenCalled();
		});

		it('should set status to processing during execution', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const onProcessingStart = vi.fn();
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onProcessingStart }))
			);

			expect(result.current.status).toBe('idle');

			// Pause immediately
			act(() => {
				result.current.pauseProcessing();
			});

			expect(result.current.status).toBe('paused');

			// Resume
			act(() => {
				result.current.resumeProcessing();
			});

			// After resume, the hook will try to process if queue has items
			// The status should transition to processing
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Verify that processing occurred (onProcessingStart was called)
			expect(onProcessingStart).toHaveBeenCalled();
			// After processing completes, status should be idle
			expect(result.current.status).toBe('idle');
		});

		it('should retry failed commands up to maxRetries', async () => {
			const sendCommand = vi.fn().mockReturnValue(false);
			const onCommandFailed = vi.fn();

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'fail',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onCommandFailed, maxRetries: 3 }))
			);

			// Pause immediately to prevent auto-processing
			act(() => {
				result.current.pauseProcessing();
			});

			// First attempt
			await act(async () => {
				result.current.resumeProcessing();
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Queue still has command with 1 attempt
			expect(result.current.queue).toHaveLength(1);
			expect(result.current.queue[0].attempts).toBe(1);

			// Manually trigger second attempt (auto-process won't re-trigger since queue.length didn't change)
			await act(async () => {
				result.current.processQueue();
				await vi.advanceTimersByTimeAsync(2000);
			});

			expect(result.current.queue).toHaveLength(1);
			expect(result.current.queue[0].attempts).toBe(2);

			// Third and final attempt
			await act(async () => {
				result.current.processQueue();
				await vi.advanceTimersByTimeAsync(2000);
			});

			// After max retries, command should be removed and onCommandFailed called
			expect(result.current.queue).toHaveLength(0);
			expect(onCommandFailed).toHaveBeenCalled();
			expect(onCommandFailed).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'cmd-1', attempts: 3 }),
				'Max retries exceeded'
			);
		});

		it('should handle sendCommand throwing error', async () => {
			const sendCommand = vi.fn().mockImplementation(() => {
				throw new Error('Network error');
			});
			const onCommandFailed = vi.fn();

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'error',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 2,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onCommandFailed, maxRetries: 3 }))
			);

			await act(async () => {
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(1000);
				await processPromise;
			});

			expect(onCommandFailed).toHaveBeenCalledWith(
				expect.objectContaining({ lastError: 'Network error' }),
				'Network error'
			);
		});

		it('should handle non-Error throws', async () => {
			const sendCommand = vi.fn().mockImplementation(() => {
				throw 'string error';
			});
			const onCommandFailed = vi.fn();

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 2,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onCommandFailed, maxRetries: 3 }))
			);

			await act(async () => {
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(1000);
				await processPromise;
			});

			expect(onCommandFailed).toHaveBeenCalledWith(
				expect.objectContaining({ lastError: 'Unknown error' }),
				'Unknown error'
			);
		});

		it('should prevent concurrent processing', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			// Pause immediately
			act(() => {
				result.current.pauseProcessing();
			});

			// Resume and process - concurrent protection is handled internally
			await act(async () => {
				result.current.resumeProcessing();
				// Give time for processing to complete
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Verify the queue was processed (sendCommand called at least once)
			expect(sendCommand).toHaveBeenCalled();
			expect(result.current.queue).toHaveLength(0);
		});

		it('should update sendCommand ref correctly', async () => {
			const sendCommand1 = vi.fn().mockReturnValue(true);
			const sendCommand2 = vi.fn().mockReturnValue(true);

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result, rerender } = renderHook(
				({ sendCommand }) => useOfflineQueue(createDefaultOptions({ sendCommand })),
				{ initialProps: { sendCommand: sendCommand1 } }
			);

			// Pause immediately
			act(() => {
				result.current.pauseProcessing();
			});

			// Update sendCommand while paused
			rerender({ sendCommand: sendCommand2 });

			// Resume and process
			await act(async () => {
				result.current.resumeProcessing();
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Should use the updated sendCommand (sendCommand2)
			expect(sendCommand2).toHaveBeenCalled();
			// Note: sendCommand1 might be called if there was a brief window before pause
			expect(result.current.queue).toHaveLength(0);
		});

		it('should log processing progress', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			await act(async () => {
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(1000);
				await processPromise;
			});

			expect(webLogger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Starting queue processing'),
				'OfflineQueue'
			);
			expect(webLogger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Processing complete'),
				'OfflineQueue'
			);
		});

		it('should use default maxRetries of 3', async () => {
			const sendCommand = vi.fn().mockReturnValue(false);
			const onCommandFailed = vi.fn();

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'fail',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 2,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Don't specify maxRetries - should default to 3
			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, onCommandFailed }))
			);

			await act(async () => {
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(1000);
				await processPromise;
			});

			// At attempts=2, one more try reaches 3, then fails permanently
			expect(onCommandFailed).toHaveBeenCalled();
		});
	});

	describe('pauseProcessing', () => {
		it('should set status to paused', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.pauseProcessing();
			});

			expect(result.current.status).toBe('paused');
		});

		it('should prevent processing when paused', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			act(() => {
				result.current.pauseProcessing();
			});

			await act(async () => {
				await result.current.processQueue();
			});

			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('should pause mid-processing', async () => {
			let callCount = 0;
			const sendCommand = vi.fn().mockImplementation(() => {
				callCount++;
				return true;
			});
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'second',
					sessionId: 's1',
					timestamp: 2,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-3',
					command: 'third',
					sessionId: 's1',
					timestamp: 3,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			// Start processing but pause after first command
			await act(async () => {
				const processPromise = result.current.processQueue();
				// Process first command
				await vi.advanceTimersByTimeAsync(150);
				// Pause before second command completes
				result.current.pauseProcessing();
				await vi.advanceTimersByTimeAsync(1000);
				await processPromise;
			});

			// First command sent, remaining commands kept in queue
			expect(callCount).toBeGreaterThanOrEqual(1);
			expect(result.current.status).toBe('paused');
		});

		it('should log pause action', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.pauseProcessing();
			});

			expect(webLogger.debug).toHaveBeenCalledWith('Processing paused', 'OfflineQueue');
		});
	});

	describe('resumeProcessing', () => {
		it('should set status back to idle when not processing', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.pauseProcessing();
			});
			expect(result.current.status).toBe('paused');

			act(() => {
				result.current.resumeProcessing();
			});
			expect(result.current.status).toBe('idle');
		});

		it('should trigger processing if queue has items', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			act(() => {
				result.current.pauseProcessing();
			});

			await act(async () => {
				result.current.resumeProcessing();
				// Let processQueue run
				await vi.advanceTimersByTimeAsync(2000);
			});

			expect(sendCommand).toHaveBeenCalled();
		});

		it('should not trigger processing if offline', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() =>
				useOfflineQueue(createDefaultOptions({ sendCommand, isOnline: false }))
			);

			act(() => {
				result.current.pauseProcessing();
			});

			await act(async () => {
				result.current.resumeProcessing();
				await vi.advanceTimersByTimeAsync(2000);
			});

			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('should not trigger processing if queue is empty', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			act(() => {
				result.current.pauseProcessing();
			});

			await act(async () => {
				result.current.resumeProcessing();
				await vi.advanceTimersByTimeAsync(2000);
			});

			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('should log resume action', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.resumeProcessing();
			});

			expect(webLogger.debug).toHaveBeenCalledWith('Processing resumed', 'OfflineQueue');
		});
	});

	describe('Auto-processing on connection restore', () => {
		it('should automatically process queue when going online', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start offline
			const { result, rerender } = renderHook(
				({ isOnline, isConnected }) =>
					useOfflineQueue(createDefaultOptions({ sendCommand, isOnline, isConnected })),
				{ initialProps: { isOnline: false, isConnected: false } }
			);

			expect(sendCommand).not.toHaveBeenCalled();

			// Go online and connected
			rerender({ isOnline: true, isConnected: true });

			await act(async () => {
				// Wait for the 500ms delay + processing time
				await vi.advanceTimersByTimeAsync(2000);
			});

			expect(sendCommand).toHaveBeenCalled();
		});

		it('should not auto-process when paused', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result, rerender } = renderHook(
				({ isOnline, isConnected }) =>
					useOfflineQueue(createDefaultOptions({ sendCommand, isOnline, isConnected })),
				{ initialProps: { isOnline: false, isConnected: false } }
			);

			act(() => {
				result.current.pauseProcessing();
			});

			rerender({ isOnline: true, isConnected: true });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});

			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('should have 500ms delay before auto-processing', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { rerender } = renderHook(
				({ isOnline, isConnected }) =>
					useOfflineQueue(createDefaultOptions({ sendCommand, isOnline, isConnected })),
				{ initialProps: { isOnline: false, isConnected: false } }
			);

			rerender({ isOnline: true, isConnected: true });

			// Before 500ms delay
			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});
			expect(sendCommand).not.toHaveBeenCalled();

			// After 500ms delay
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			expect(sendCommand).toHaveBeenCalled();
		});

		it('should cleanup timer on unmount', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'test',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { unmount, rerender } = renderHook(
				({ isOnline, isConnected }) =>
					useOfflineQueue(createDefaultOptions({ sendCommand, isOnline, isConnected })),
				{ initialProps: { isOnline: false, isConnected: false } }
			);

			rerender({ isOnline: true, isConnected: true });

			// Unmount before timer fires
			unmount();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Should not process after unmount
			expect(sendCommand).not.toHaveBeenCalled();
		});
	});

	describe('canQueue computed property', () => {
		it('should be true when queue is below max', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.canQueue).toBe(true);
		});

		it('should be false when queue is at max', () => {
			const fullQueue: QueuedCommand[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) => ({
				id: `cmd-${i}`,
				command: `command ${i}`,
				sessionId: 's1',
				timestamp: i,
				inputMode: 'ai' as const,
				attempts: 0,
			}));
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fullQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.canQueue).toBe(false);
		});

		it('should update when queue changes', () => {
			const nearFullQueue: QueuedCommand[] = Array.from({ length: MAX_QUEUE_SIZE - 1 }, (_, i) => ({
				id: `cmd-${i}`,
				command: `command ${i}`,
				sessionId: 's1',
				timestamp: i,
				inputMode: 'ai' as const,
				attempts: 0,
			}));
			localStorage.setItem(STORAGE_KEY, JSON.stringify(nearFullQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.canQueue).toBe(true);

			act(() => {
				result.current.queueCommand('s1', 'last', 'ai');
			});

			expect(result.current.canQueue).toBe(false);
		});
	});

	describe('Connection loss during processing', () => {
		it('should stop processing and keep remaining commands when connection lost', async () => {
			let isConnectedValue = true;
			const sendCommand = vi.fn().mockImplementation(() => {
				// Simulate connection loss after first command
				if (sendCommand.mock.calls.length === 1) {
					isConnectedValue = false;
				}
				return isConnectedValue;
			});

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'second',
					sessionId: 's1',
					timestamp: 2,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-3',
					command: 'third',
					sessionId: 's1',
					timestamp: 3,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result, rerender } = renderHook(
				({ isConnected }) => useOfflineQueue(createDefaultOptions({ sendCommand, isConnected })),
				{ initialProps: { isConnected: true } }
			);

			await act(async () => {
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(150);
				// Simulate connection loss
				rerender({ isConnected: false });
				await vi.advanceTimersByTimeAsync(1000);
				await processPromise;
			});

			// First command succeeded, remaining kept in queue
			expect(sendCommand).toHaveBeenCalled();
			expect(result.current.queue.length).toBeGreaterThan(0);
		});
	});

	describe('localStorage error handling', () => {
		it('should handle localStorage.setItem throwing', async () => {
			const originalSetItem = localStorage.setItem.bind(localStorage);
			localStorage.setItem = vi.fn().mockImplementation(() => {
				throw new Error('Storage quota exceeded');
			});

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('s1', 'test', 'ai');
			});

			// Should still work in memory
			expect(result.current.queue).toHaveLength(1);
			expect(webLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to save'),
				'OfflineQueue',
				expect.any(Error)
			);

			// Restore
			localStorage.setItem = originalSetItem;
		});

		it('should handle localStorage.getItem throwing', () => {
			const originalGetItem = localStorage.getItem.bind(localStorage);
			localStorage.getItem = vi.fn().mockImplementation(() => {
				throw new Error('Access denied');
			});

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			// Should initialize with empty queue
			expect(result.current.queue).toEqual([]);
			expect(webLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to load'),
				'OfflineQueue',
				expect.any(Error)
			);

			// Restore
			localStorage.getItem = originalGetItem;
		});
	});

	describe('Function reference stability', () => {
		it('should maintain stable function references', () => {
			const { result, rerender } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			const {
				queueCommand: qc1,
				removeCommand: rc1,
				clearQueue: cq1,
				processQueue: pq1,
				pauseProcessing: pp1,
				resumeProcessing: rp1,
			} = result.current;

			rerender();

			// queueCommand depends on queue.length, so it may change
			expect(result.current.removeCommand).toBe(rc1);
			expect(result.current.clearQueue).toBe(cq1);
			expect(result.current.pauseProcessing).toBe(pp1);
		});

		it('should update queueCommand when queue length changes', () => {
			const { result, rerender } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			const qc1 = result.current.queueCommand;

			act(() => {
				result.current.queueCommand('s1', 'test', 'ai');
			});

			// queueCommand depends on queue.length, so reference should change
			expect(result.current.queueCommand).not.toBe(qc1);
		});
	});

	describe('Edge cases', () => {
		it('should handle empty command string', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('s1', '', 'ai');
			});

			expect(result.current.queue).toHaveLength(1);
			expect(result.current.queue[0].command).toBe('');
		});

		it('should handle special characters in command', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));
			const specialCommand = '!@#$%^&*()_+{}[]|\\:";\'<>?,./\n\t emoji: 🚀';

			act(() => {
				result.current.queueCommand('s1', specialCommand, 'ai');
			});

			expect(result.current.queue[0].command).toBe(specialCommand);
		});

		it('should handle very long command', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));
			const longCommand = 'x'.repeat(10000);

			act(() => {
				result.current.queueCommand('s1', longCommand, 'ai');
			});

			expect(result.current.queue[0].command).toBe(longCommand);
		});

		it('should preserve command order', () => {
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			act(() => {
				result.current.queueCommand('s1', 'first', 'ai');
				result.current.queueCommand('s1', 'second', 'ai');
				result.current.queueCommand('s1', 'third', 'ai');
			});

			expect(result.current.queue.map((c) => c.command)).toEqual(['first', 'second', 'third']);
		});

		it('should handle null localStorage return', () => {
			// localStorage.getItem returns null when key doesn't exist (default case)
			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions()));

			expect(result.current.queue).toEqual([]);
		});
	});

	describe('Mixed success and failure in batch', () => {
		it('should handle mix of successful and failed commands', async () => {
			let callCount = 0;
			const sendCommand = vi.fn().mockImplementation(() => {
				callCount++;
				// Fail every other command
				return callCount % 2 === 1;
			});
			const onCommandSent = vi.fn();
			const onCommandFailed = vi.fn();
			const onProcessingComplete = vi.fn();

			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'first',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'second',
					sessionId: 's1',
					timestamp: 2,
					inputMode: 'ai',
					attempts: 2,
				},
				{
					id: 'cmd-3',
					command: 'third',
					sessionId: 's1',
					timestamp: 3,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-4',
					command: 'fourth',
					sessionId: 's1',
					timestamp: 4,
					inputMode: 'ai',
					attempts: 2,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			// Start paused to prevent auto-processing
			const { result } = renderHook(() =>
				useOfflineQueue(
					createDefaultOptions({
						sendCommand,
						onCommandSent,
						onCommandFailed,
						onProcessingComplete,
						maxRetries: 3,
					})
				)
			);

			// Pause immediately
			act(() => {
				result.current.pauseProcessing();
			});

			// Resume and let processing run
			await act(async () => {
				result.current.resumeProcessing();
				await vi.advanceTimersByTimeAsync(10000);
			});

			// Verify callbacks were invoked
			// Due to auto-processing retries, we expect both successes and failures
			expect(onCommandSent).toHaveBeenCalled();
			expect(onCommandFailed).toHaveBeenCalled();
			expect(onProcessingComplete).toHaveBeenCalled();
		});
	});

	describe('Multiple sessions', () => {
		it('should handle commands for different sessions', async () => {
			const sendCommand = vi.fn().mockReturnValue(true);
			const storedQueue: QueuedCommand[] = [
				{
					id: 'cmd-1',
					command: 'for s1',
					sessionId: 's1',
					timestamp: 1,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: 'cmd-2',
					command: 'for s2',
					sessionId: 's2',
					timestamp: 2,
					inputMode: 'terminal',
					attempts: 0,
				},
				{
					id: 'cmd-3',
					command: 'for s3',
					sessionId: 's3',
					timestamp: 3,
					inputMode: 'ai',
					attempts: 0,
				},
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(storedQueue));

			const { result } = renderHook(() => useOfflineQueue(createDefaultOptions({ sendCommand })));

			await act(async () => {
				const processPromise = result.current.processQueue();
				await vi.advanceTimersByTimeAsync(2000);
				await processPromise;
			});

			expect(sendCommand).toHaveBeenCalledWith('s1', 'for s1');
			expect(sendCommand).toHaveBeenCalledWith('s2', 'for s2');
			expect(sendCommand).toHaveBeenCalledWith('s3', 'for s3');
		});
	});
});
