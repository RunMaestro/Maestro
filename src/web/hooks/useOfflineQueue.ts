/**
 * useOfflineQueue hook for Maestro web interface
 *
 * Provides offline command queueing functionality that stores commands
 * typed while offline and automatically sends them when reconnected.
 *
 * Features:
 * - Persists queued commands via injected storage adapter for survival across app reloads
 * - Automatically sends queued commands when connection is restored
 * - Tracks queue status and provides progress feedback
 * - Allows manual retry and clearing of queued commands
 * - Handles partial queue failures gracefully
 *
 * Storage contract:
 * - storage.getItem(key): Promise<string | null>
 * - storage.setItem(key, value): Promise<void>
 * - storage.removeItem(key): Promise<void>
 *
 * When storage is null/undefined, persistence calls are no-ops (useful for testing
 * or environments without persistent storage).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { webLogger } from '../utils/logger';

/** Storage key for persisting offline queue */
const STORAGE_KEY = 'maestro-offline-queue';

/** Maximum number of commands to queue (prevent unbounded growth) */
const MAX_QUEUE_SIZE = 50;

/** Delay between sending queued commands (ms) */
const SEND_DELAY = 100;

/**
 * Storage adapter interface for queue persistence.
 * Matches the async contract used by AsyncStorage, SecureStore, etc.
 */
export interface StorageAdapter {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
}

/**
 * Queued command entry
 */
export interface QueuedCommand {
	/** Unique ID for the queued command */
	id: string;
	/** The command text */
	command: string;
	/** Target session ID */
	sessionId: string;
	/**
	 * Target AI tab ID at queue time. Persisted so that when the queue replays
	 * after reconnect the command lands in the same tab the user was looking
	 * at, even if the desktop's active tab changed in the meantime.
	 */
	tabId?: string;
	/** Timestamp when command was queued */
	timestamp: number;
	/** Input mode (ai or terminal) */
	inputMode: 'ai' | 'terminal';
	/** Number of send attempts */
	attempts: number;
	/** Last error message if send failed */
	lastError?: string;
}

/**
 * Queue processing status
 */
export type QueueStatus = 'idle' | 'processing' | 'paused';

/**
 * Options for the useOfflineQueue hook
 */
export interface UseOfflineQueueOptions {
	/** Whether the device is currently online */
	isOnline: boolean;
	/** Whether connected to the WebSocket server */
	isConnected: boolean;
	/**
	 * Function to send a command to the server. `tabId` is supplied during
	 * queue replay when the queued command carried a target tab, so the
	 * replay lands in the same conversation the user originally targeted.
	 */
	sendCommand: (sessionId: string, command: string, tabId?: string) => boolean;
	/** Maximum retry attempts per command (default: 3) */
	maxRetries?: number;
	/** Storage adapter for queue persistence. When null/undefined, persistence is disabled. */
	storage?: StorageAdapter | null;
	/** Callback when a queued command is successfully sent */
	onCommandSent?: (command: QueuedCommand) => void;
	/** Callback when a queued command fails after all retries */
	onCommandFailed?: (command: QueuedCommand, error: string) => void;
	/** Callback when queue processing starts */
	onProcessingStart?: () => void;
	/** Callback when queue processing completes */
	onProcessingComplete?: (successCount: number, failCount: number) => void;
}

/**
 * Return value from useOfflineQueue hook
 */
export interface UseOfflineQueueReturn {
	/** Current queued commands */
	queue: QueuedCommand[];
	/** Number of commands in queue */
	queueLength: number;
	/** Whether the queue is currently being processed */
	status: QueueStatus;
	/** Add a command to the queue (call when offline) */
	queueCommand: (
		sessionId: string,
		command: string,
		inputMode: 'ai' | 'terminal',
		tabId?: string
	) => QueuedCommand | null;
	/** Remove a specific command from the queue */
	removeCommand: (commandId: string) => void;
	/** Clear all commands from the queue */
	clearQueue: () => void;
	/** Manually trigger queue processing */
	processQueue: () => Promise<void>;
	/** Pause queue processing */
	pauseProcessing: () => void;
	/** Resume queue processing */
	resumeProcessing: () => void;
	/** Check if a command can be queued (not at max capacity) */
	canQueue: boolean;
}

/**
 * Generate a unique ID for queued commands
 */
function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a thin Promise wrapper around localStorage for web environments.
 * Returns null in environments where localStorage is not available.
 */
export function createLocalStorageAdapter(): StorageAdapter | null {
	if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
		return null;
	}
	return {
		getItem: (key: string) => Promise.resolve(localStorage.getItem(key)),
		setItem: (key: string, value: string) => {
			localStorage.setItem(key, value);
			return Promise.resolve();
		},
		removeItem: (key: string) => {
			localStorage.removeItem(key);
			return Promise.resolve();
		},
	};
}

/**
 * useOfflineQueue hook for managing offline command queueing
 *
 * @example
 * ```tsx
 * // Web usage with localStorage adapter
 * function WebApp() {
 *   const storage = createLocalStorageAdapter();
 *   const { queue, queueLength, queueCommand, status } = useOfflineQueue({
 *     isOnline: navigator.onLine,
 *     isConnected: wsState === 'authenticated',
 *     sendCommand: (sessionId, command) => {
 *       return send({ type: 'send_command', sessionId, command });
 *     },
 *     storage,
 *     onCommandSent: (cmd) => {
 *       console.log('Queued command sent:', cmd.command);
 *     },
 *   });
 *
 *   const handleSubmit = (command: string) => {
 *     if (!isOnline || !isConnected) {
 *       // Queue for later
 *       queueCommand(activeSessionId, command, inputMode);
 *     } else {
 *       // Send immediately
 *       sendCommand(activeSessionId, command);
 *     }
 *   };
 *
 *   return (
 *     <div>
 *       {queueLength > 0 && (
 *         <Badge>{queueLength} command(s) queued</Badge>
 *       )}
 *     </div>
 *   );
 * }
 *
 * // React Native usage with AsyncStorage adapter
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * const asyncStorageAdapter = {
 *   getItem: AsyncStorage.getItem,
 *   setItem: AsyncStorage.setItem,
 *   removeItem: AsyncStorage.removeItem,
 * };
 * ```
 */
export function useOfflineQueue(options: UseOfflineQueueOptions): UseOfflineQueueReturn {
	const {
		isOnline,
		isConnected,
		sendCommand,
		maxRetries = 3,
		storage,
		onCommandSent,
		onCommandFailed,
		onProcessingStart,
		onProcessingComplete,
	} = options;

	// State
	const [queue, setQueue] = useState<QueuedCommand[]>([]);
	const [status, setStatus] = useState<QueueStatus>('idle');
	const [isInitialized, setIsInitialized] = useState(false);

	// Refs for async processing
	const isProcessingRef = useRef(false);
	const isPausedRef = useRef(false);
	const sendCommandRef = useRef(sendCommand);
	const storageRef = useRef(storage);

	// Keep refs up to date
	useEffect(() => {
		sendCommandRef.current = sendCommand;
	}, [sendCommand]);

	useEffect(() => {
		storageRef.current = storage;
	}, [storage]);

	/**
	 * Load queue from storage on mount
	 */
	useEffect(() => {
		let cancelled = false;

		async function loadQueue() {
			if (!storage) {
				setIsInitialized(true);
				return;
			}

			try {
				const stored = await storage.getItem(STORAGE_KEY);
				if (cancelled) return;

				if (stored) {
					const parsed = JSON.parse(stored);
					if (Array.isArray(parsed)) {
						// queueCommand is usable before this async read resolves (cold
						// start, or replay adding state). Merge instead of overwriting so a
						// command queued during the load window isn't clobbered by the
						// persisted snapshot. Dedupe by id; stored entries come first.
						setQueue((current) => {
							if (current.length === 0) return parsed;
							const storedIds = new Set(parsed.map((cmd: QueuedCommand) => cmd.id));
							return [...parsed, ...current.filter((cmd) => !storedIds.has(cmd.id))];
						});
					}
				}
			} catch (error) {
				webLogger.warn('Failed to load queue from storage', 'OfflineQueue', error);
			}
			setIsInitialized(true);
		}

		loadQueue();

		return () => {
			cancelled = true;
		};
	}, [storage]);

	/**
	 * Save queue to storage whenever it changes (after initialization)
	 */
	useEffect(() => {
		if (!isInitialized) return;

		async function saveQueue() {
			const currentStorage = storageRef.current;
			if (!currentStorage) return;

			try {
				await currentStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
			} catch (error) {
				webLogger.warn('Failed to save queue to storage', 'OfflineQueue', error);
			}
		}

		saveQueue();
	}, [queue, isInitialized]);

	/**
	 * Queue a command for later sending
	 */
	const queueCommand = useCallback(
		(
			sessionId: string,
			command: string,
			inputMode: 'ai' | 'terminal',
			tabId?: string
		): QueuedCommand | null => {
			// Check if we're at capacity
			if (queue.length >= MAX_QUEUE_SIZE) {
				webLogger.warn('Queue at maximum capacity, cannot add more commands', 'OfflineQueue');
				return null;
			}

			const newCommand: QueuedCommand = {
				id: generateId(),
				command,
				sessionId,
				tabId,
				timestamp: Date.now(),
				inputMode,
				attempts: 0,
			};

			setQueue((prev) => [...prev, newCommand]);
			webLogger.debug(`Command queued: ${command.substring(0, 50)}`, 'OfflineQueue');

			return newCommand;
		},
		[queue.length]
	);

	/**
	 * Remove a specific command from the queue
	 */
	const removeCommand = useCallback((commandId: string) => {
		setQueue((prev) => prev.filter((cmd) => cmd.id !== commandId));
		webLogger.debug(`Command removed: ${commandId}`, 'OfflineQueue');
	}, []);

	/**
	 * Clear all commands from the queue
	 */
	const clearQueue = useCallback(() => {
		setQueue([]);
		webLogger.debug('Queue cleared', 'OfflineQueue');
	}, []);

	/**
	 * Process the queue - send all queued commands
	 */
	const processQueue = useCallback(async () => {
		// Don't start if already processing or paused
		if (isProcessingRef.current || isPausedRef.current) {
			return;
		}

		// Don't process if not connected
		if (!isOnline || !isConnected) {
			webLogger.debug('Cannot process queue - not connected', 'OfflineQueue');
			return;
		}

		// Don't process empty queue
		if (queue.length === 0) {
			return;
		}

		isProcessingRef.current = true;
		setStatus('processing');
		onProcessingStart?.();

		webLogger.debug(`Starting queue processing, items: ${queue.length}`, 'OfflineQueue');

		let successCount = 0;
		let failCount = 0;
		const failedCommands: QueuedCommand[] = [];

		// Process each command sequentially
		for (const cmd of queue) {
			// Check if processing was paused
			if (isPausedRef.current) {
				webLogger.debug('Processing paused', 'OfflineQueue');
				failedCommands.push(cmd);
				continue;
			}

			// Check if still connected
			if (!isOnline || !isConnected) {
				webLogger.debug('Lost connection during processing', 'OfflineQueue');
				failedCommands.push(cmd);
				continue;
			}

			// Attempt to send the command
			const updatedCmd = { ...cmd, attempts: cmd.attempts + 1 };

			try {
				const success = sendCommandRef.current(cmd.sessionId, cmd.command, cmd.tabId);

				if (success) {
					successCount++;
					webLogger.debug(
						`Command sent successfully: ${cmd.command.substring(0, 50)}`,
						'OfflineQueue'
					);
					onCommandSent?.(updatedCmd);
				} else {
					// Send returned false - likely disconnected
					if (updatedCmd.attempts < maxRetries) {
						updatedCmd.lastError = 'Send failed - will retry';
						failedCommands.push(updatedCmd);
					} else {
						failCount++;
						updatedCmd.lastError = 'Max retries exceeded';
						onCommandFailed?.(updatedCmd, 'Max retries exceeded');
					}
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : 'Unknown error';
				if (updatedCmd.attempts < maxRetries) {
					updatedCmd.lastError = errorMsg;
					failedCommands.push(updatedCmd);
				} else {
					failCount++;
					updatedCmd.lastError = errorMsg;
					onCommandFailed?.(updatedCmd, errorMsg);
				}
			}

			// Small delay between commands to avoid overwhelming the server
			await new Promise((resolve) => setTimeout(resolve, SEND_DELAY));
		}

		// Update queue with any failed commands that should be retried
		setQueue(failedCommands);

		isProcessingRef.current = false;
		setStatus(isPausedRef.current ? 'paused' : 'idle');

		webLogger.debug(
			`Processing complete. Success: ${successCount}, Failed: ${failCount}`,
			'OfflineQueue'
		);
		onProcessingComplete?.(successCount, failCount);
	}, [
		isOnline,
		isConnected,
		queue,
		maxRetries,
		onCommandSent,
		onCommandFailed,
		onProcessingStart,
		onProcessingComplete,
	]);

	/**
	 * Pause queue processing
	 */
	const pauseProcessing = useCallback(() => {
		isPausedRef.current = true;
		setStatus('paused');
		webLogger.debug('Processing paused', 'OfflineQueue');
	}, []);

	/**
	 * Resume queue processing
	 */
	const resumeProcessing = useCallback(() => {
		isPausedRef.current = false;
		if (!isProcessingRef.current) {
			setStatus('idle');
		}
		webLogger.debug('Processing resumed', 'OfflineQueue');
		// Trigger processing if there are queued items
		if (queue.length > 0 && isOnline && isConnected) {
			processQueue();
		}
	}, [queue.length, isOnline, isConnected, processQueue]);

	/**
	 * Automatically process queue when connection is restored
	 */
	useEffect(() => {
		if (isOnline && isConnected && queue.length > 0 && !isPausedRef.current) {
			// Small delay to ensure connection is stable
			const timer = setTimeout(() => {
				processQueue();
			}, 500);

			return () => clearTimeout(timer);
		}
	}, [isOnline, isConnected, queue.length, processQueue]);

	return {
		queue,
		queueLength: queue.length,
		status,
		queueCommand,
		removeCommand,
		clearQueue,
		processQueue,
		pauseProcessing,
		resumeProcessing,
		canQueue: queue.length < MAX_QUEUE_SIZE,
	};
}

export default useOfflineQueue;
