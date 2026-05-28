import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOfflineQueue, type QueuedCommand } from '../../web/hooks/useOfflineQueue';
import { webLogger } from '../../web/utils/logger';

const STORAGE_KEY = 'maestro-offline-queue';
let localStorageStore: Record<string, string> = {};

const localStorageMock = {
	clear: vi.fn(() => {
		localStorageStore = {};
	}),
	getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
	key: vi.fn((index: number) => Object.keys(localStorageStore)[index] ?? null),
	get length() {
		return Object.keys(localStorageStore).length;
	},
	removeItem: vi.fn((key: string) => {
		delete localStorageStore[key];
	}),
	setItem: vi.fn((key: string, value: string) => {
		localStorageStore[key] = value;
	}),
};

describe('useOfflineQueue integration', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: Date.parse('2026-05-26T12:00:00.000Z') });
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: localStorageMock,
			writable: true,
		});
		localStorageMock.clear.mockClear();
		localStorageMock.getItem.mockClear();
		localStorageMock.key.mockClear();
		localStorageMock.removeItem.mockClear();
		localStorageMock.setItem.mockClear();
		localStorage.clear();
		webLogger.setEnabled(false);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		localStorage.clear();
		webLogger.reset();
	});

	it('queues, persists, removes, and clears commands through real localStorage', async () => {
		const { result } = renderHook(() =>
			useOfflineQueue({
				isConnected: false,
				isOnline: false,
				sendCommand: vi.fn(),
			})
		);

		let queued: QueuedCommand | null = null;
		act(() => {
			queued = result.current.queueCommand('session-1', 'plan offline work', 'ai');
		});

		expect(queued).toMatchObject({
			attempts: 0,
			command: 'plan offline work',
			inputMode: 'ai',
			sessionId: 'session-1',
		});
		expect(result.current.queueLength).toBe(1);
		await act(async () => {
			await Promise.resolve();
		});
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toHaveLength(1);

		act(() => {
			result.current.removeCommand(queued!.id);
		});
		expect(result.current.queueLength).toBe(0);

		act(() => {
			result.current.queueCommand('session-2', 'terminal retry', 'terminal');
			result.current.clearQueue();
		});
		expect(result.current.queue).toEqual([]);
		expect(result.current.canQueue).toBe(true);
	});

	it('processes persisted commands sequentially and keeps retryable failures queued', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([
				createQueuedCommand({ command: 'first success', id: 'cmd-1' }),
				createQueuedCommand({ command: 'second retry', id: 'cmd-2' }),
			])
		);
		const sendCommand = vi.fn((_sessionId: string, command: string) => command === 'first success');
		const onCommandSent = vi.fn();
		const onCommandFailed = vi.fn();
		const onProcessingStart = vi.fn();
		const onProcessingComplete = vi.fn();
		const { result } = renderHook(() =>
			useOfflineQueue({
				isConnected: true,
				isOnline: true,
				maxRetries: 2,
				onCommandFailed,
				onCommandSent,
				onProcessingComplete,
				onProcessingStart,
				sendCommand,
			})
		);

		await act(async () => {
			const processing = result.current.processQueue();
			await vi.advanceTimersByTimeAsync(200);
			await processing;
		});

		expect(sendCommand).toHaveBeenCalledTimes(2);
		expect(onCommandSent).toHaveBeenCalledWith(
			expect.objectContaining({ attempts: 1, command: 'first success' })
		);
		expect(onProcessingStart).toHaveBeenCalledTimes(1);
		expect(onProcessingComplete).toHaveBeenLastCalledWith(1, 0);
		expect(result.current.queue).toEqual([
			expect.objectContaining({
				attempts: 1,
				command: 'second retry',
				lastError: 'Send failed - will retry',
			}),
		]);

		await act(async () => {
			const processing = result.current.processQueue();
			await vi.advanceTimersByTimeAsync(100);
			await processing;
		});

		expect(onCommandFailed).toHaveBeenCalledWith(
			expect.objectContaining({
				attempts: 2,
				command: 'second retry',
				lastError: 'Max retries exceeded',
			}),
			'Max retries exceeded'
		);
		expect(onProcessingComplete).toHaveBeenLastCalledWith(0, 1);
		expect(result.current.queue).toEqual([]);
	});

	it('pauses processing, resumes, and auto-processes when connection returns', async () => {
		const sendCommand = vi.fn().mockReturnValue(true);
		const { result, rerender } = renderHook(
			({ isConnected, isOnline }) =>
				useOfflineQueue({
					isConnected,
					isOnline,
					sendCommand,
				}),
			{ initialProps: { isConnected: false, isOnline: false } }
		);

		act(() => {
			result.current.queueCommand('session-1', 'queued while offline', 'ai');
			result.current.pauseProcessing();
		});
		expect(result.current.status).toBe('paused');

		await act(async () => {
			await result.current.processQueue();
		});
		expect(sendCommand).not.toHaveBeenCalled();

		act(() => {
			result.current.resumeProcessing();
		});
		expect(result.current.status).toBe('idle');

		rerender({ isConnected: true, isOnline: true });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		expect(sendCommand).toHaveBeenCalledWith('session-1', 'queued while offline');
		expect(result.current.queueLength).toBe(0);
	});

	it('handles storage failures, full queues, disconnected guards, and empty queue processing', async () => {
		localStorageMock.getItem.mockImplementationOnce(() => {
			throw new Error('load failed');
		});
		localStorageMock.setItem.mockImplementationOnce(() => {
			throw new Error('save failed');
		});

		const offlineHook = renderHook(() =>
			useOfflineQueue({
				isConnected: false,
				isOnline: false,
				sendCommand: vi.fn(),
			})
		);

		expect(offlineHook.result.current.queue).toEqual([]);
		await act(async () => {
			await offlineHook.result.current.processQueue();
		});
		expect(offlineHook.result.current.status).toBe('idle');
		offlineHook.unmount();

		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(
				Array.from({ length: 50 }, (_, index) =>
					createQueuedCommand({ id: `full-${index}`, command: `queued ${index}` })
				)
			)
		);
		const fullHook = renderHook(() =>
			useOfflineQueue({
				isConnected: true,
				isOnline: true,
				sendCommand: vi.fn(),
			})
		);

		expect(fullHook.result.current.canQueue).toBe(false);
		expect(fullHook.result.current.queueCommand('session-1', 'too much', 'ai')).toBeNull();
		fullHook.unmount();

		localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
		const emptyHook = renderHook(() =>
			useOfflineQueue({
				isConnected: true,
				isOnline: true,
				sendCommand: vi.fn(),
			})
		);

		await act(async () => {
			await emptyHook.result.current.processQueue();
		});
		expect(emptyHook.result.current.status).toBe('idle');
	});

	it('keeps paused work queued and retries thrown send failures before final failure', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([
				createQueuedCommand({ id: 'pause-1', command: 'send before pause' }),
				createQueuedCommand({ id: 'pause-2', command: 'keep paused' }),
			])
		);
		let pauseHook: {
			result: { current: ReturnType<typeof useOfflineQueue> };
			unmount: () => void;
		};
		const sendBeforePause = vi.fn(() => {
			pauseHook.result.current.pauseProcessing();
			return true;
		});
		pauseHook = renderHook(() =>
			useOfflineQueue({
				isConnected: true,
				isOnline: true,
				sendCommand: sendBeforePause,
			})
		);

		await act(async () => {
			const processing = pauseHook.result.current.processQueue();
			await vi.advanceTimersByTimeAsync(200);
			await processing;
		});

		expect(sendBeforePause).toHaveBeenCalledTimes(1);
		expect(pauseHook.result.current.status).toBe('paused');
		expect(pauseHook.result.current.queue).toEqual([
			expect.objectContaining({ id: 'pause-2', attempts: 0 }),
		]);
		pauseHook.unmount();

		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([createQueuedCommand({ id: 'throw-1', command: 'throw then fail' })])
		);
		const thrownFailure = new Error('transport down');
		const sendWithThrow = vi.fn(() => {
			throw thrownFailure;
		});
		const onCommandFailed = vi.fn();
		const retryHook = renderHook(() =>
			useOfflineQueue({
				isConnected: true,
				isOnline: true,
				maxRetries: 2,
				onCommandFailed,
				sendCommand: sendWithThrow,
			})
		);

		await act(async () => {
			const processing = retryHook.result.current.processQueue();
			await vi.advanceTimersByTimeAsync(100);
			await processing;
		});
		expect(retryHook.result.current.queue).toEqual([
			expect.objectContaining({ attempts: 1, lastError: 'transport down' }),
		]);

		await act(async () => {
			const processing = retryHook.result.current.processQueue();
			await vi.advanceTimersByTimeAsync(100);
			await processing;
		});
		expect(onCommandFailed).toHaveBeenCalledWith(
			expect.objectContaining({ attempts: 2, lastError: 'transport down' }),
			'transport down'
		);
		expect(retryHook.result.current.queue).toEqual([]);
	});

	it('starts processing immediately when resuming an online queue', async () => {
		const sendCommand = vi.fn().mockReturnValue(true);
		const { result } = renderHook(() =>
			useOfflineQueue({
				isConnected: true,
				isOnline: true,
				sendCommand,
			})
		);

		act(() => {
			result.current.queueCommand('session-1', 'resume now', 'ai');
			result.current.pauseProcessing();
		});

		await act(async () => {
			result.current.resumeProcessing();
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(sendCommand).toHaveBeenCalledWith('session-1', 'resume now');
		expect(result.current.queueLength).toBe(0);
	});
});

function createQueuedCommand(overrides: Partial<QueuedCommand> = {}): QueuedCommand {
	return {
		attempts: 0,
		command: 'queued command',
		id: 'queued-id',
		inputMode: 'ai',
		sessionId: 'session-1',
		timestamp: Date.now(),
		...overrides,
	};
}
