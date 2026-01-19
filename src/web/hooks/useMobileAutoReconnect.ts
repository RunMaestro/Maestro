/**
 * useMobileAutoReconnect - Auto-reconnect with countdown timer hook
 *
 * Manages automatic WebSocket reconnection with a visible countdown timer.
 * When disconnected (and not offline), counts down from 30 seconds before
 * attempting to reconnect. The countdown resets after each reconnect attempt.
 *
 * Extracted from mobile App.tsx for code organization.
 *
 * @example
 * ```tsx
 * const { reconnectCountdown } = useMobileAutoReconnect({
 *   connectionState,
 *   isOffline,
 *   connect,
 * });
 * ```
 */

import { useEffect, useState } from 'react';
import { webLogger } from '../utils/logger';

/**
 * WebSocket connection states
 */
export type ConnectionState =
	| 'connecting'
	| 'authenticating'
	| 'connected'
	| 'authenticated'
	| 'disconnected'
	| 'error';

/**
 * Default countdown duration in seconds
 */
const DEFAULT_COUNTDOWN_SECONDS = 30;

/**
 * Dependencies for useMobileAutoReconnect hook
 */
export interface UseMobileAutoReconnectDeps {
	/** Current WebSocket connection state */
	connectionState: ConnectionState;
	/** Whether the device is offline (no network) */
	isOffline: boolean;
	/** Function to initiate a WebSocket connection */
	connect: () => void;
}

/**
 * Return type for useMobileAutoReconnect hook
 */
export interface UseMobileAutoReconnectReturn {
	/** Seconds remaining until auto-reconnect (30 down to 0) */
	reconnectCountdown: number;
}

/**
 * Hook for managing automatic WebSocket reconnection with countdown
 *
 * Features:
 * - 30-second countdown timer when disconnected
 * - Automatic reconnection when countdown reaches 0
 * - Timer resets when connection state changes
 * - Disabled when device is offline (no network)
 *
 * @param deps - Dependencies including connection state and connect function
 * @returns Object containing the current countdown value
 */
export function useMobileAutoReconnect(
	deps: UseMobileAutoReconnectDeps
): UseMobileAutoReconnectReturn {
	const { connectionState, isOffline, connect } = deps;

	// Countdown timer state (in seconds)
	const [reconnectCountdown, setReconnectCountdown] = useState(DEFAULT_COUNTDOWN_SECONDS);

	// Auto-reconnect every 30 seconds when disconnected with countdown
	useEffect(() => {
		// Only auto-reconnect if disconnected and not offline
		if (connectionState !== 'disconnected' || isOffline) {
			// Reset countdown when not disconnected
			setReconnectCountdown(DEFAULT_COUNTDOWN_SECONDS);
			return;
		}

		// Reset countdown to 30 when entering disconnected state
		setReconnectCountdown(DEFAULT_COUNTDOWN_SECONDS);

		// Countdown timer - decrements every second
		const countdownId = setInterval(() => {
			setReconnectCountdown((prev) => {
				if (prev <= 1) {
					// Time to reconnect
					webLogger.info('Auto-reconnecting...', 'MobileAutoReconnect');
					connect();
					return DEFAULT_COUNTDOWN_SECONDS; // Reset for next cycle
				}
				return prev - 1;
			});
		}, 1000);

		return () => clearInterval(countdownId);
	}, [connectionState, isOffline, connect]);

	return {
		reconnectCountdown,
	};
}

export default useMobileAutoReconnect;
