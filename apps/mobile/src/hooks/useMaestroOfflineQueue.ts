/**
 * useMaestroOfflineQueue - Offline queue wrapper for Maestro mobile
 *
 * Integrates useOfflineQueue with useMaestroConnection to provide automatic
 * command queueing when disconnected. Commands typed while offline are persisted
 * to AsyncStorage and automatically dispatched when the connection is restored.
 *
 * Usage:
 * ```tsx
 * const { queueCommand, queueLength, canQueue } = useMaestroOfflineQueue({
 *   isOnline: connectionState !== 'disconnected',
 *   isConnected: connectionState === 'ready',
 *   sendCommand: (sessionId, command) => {
 *     send({ type: 'send_command', sessionId, command, inputMode: 'ai' });
 *     return true;
 *   },
 * });
 * ```
 */

import { useOfflineQueue } from '@maestro/web-hooks/useOfflineQueue';
import { asyncStorageAdapter } from '@/storage/asyncStorageAdapter';

export interface UseMaestroOfflineQueueOptions {
	/** Whether network connectivity is available */
	isOnline: boolean;
	/** Whether WebSocket is authenticated and ready */
	isConnected: boolean;
	/**
	 * Send function that dispatches to WebSocket. The optional `tabId` is
	 * supplied during queue replay so the command lands in the same AI tab the
	 * user originally targeted, even if the desktop's active tab moved while
	 * offline.
	 */
	sendCommand: (sessionId: string, command: string, tabId?: string) => boolean;
	/** Callback when a queued command is sent */
	onCommandSent?: () => void;
	/** Callback when a queued command fails */
	onCommandFailed?: (error: string) => void;
}

/**
 * Hook that provides offline queue functionality using AsyncStorage persistence.
 *
 * When disconnected, commands are queued and persisted to AsyncStorage.
 * On reconnection, queued commands are automatically dispatched in order.
 */
export function useMaestroOfflineQueue(options: UseMaestroOfflineQueueOptions) {
	const { isOnline, isConnected, sendCommand, onCommandSent, onCommandFailed } = options;

	return useOfflineQueue({
		isOnline,
		isConnected,
		sendCommand,
		storage: asyncStorageAdapter,
		onCommandSent: onCommandSent ? () => onCommandSent() : undefined,
		onCommandFailed: onCommandFailed ? (cmd, error) => onCommandFailed(error) : undefined,
	});
}

export default useMaestroOfflineQueue;
