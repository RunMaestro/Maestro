/**
 * useMaestroConnection - Lifecycle-aware WebSocket wrapper for Maestro mobile
 *
 * VERIFICATION STEPS (M2 task) - VERIFIED 2026-06-19:
 * 1. Boot simulator (iPhone 16 Pro), connect to Maestro desktop via dev-pairing.local.json
 * 2. Open drawer, verify sessions list populated from WebSocket (14 sessions displayed)
 * 3. Tap session row (MonoRepo), verify navigation to /session/[sessionId] route
 * 4. Send a prompt message, verify user message bubble appears
 * 5. Press home button to background the app
 * 6. Wait 16 seconds (exceeds BACKGROUND_STALENESS_MS = 10s threshold)
 * 7. Tap app icon to return to foreground
 * 8. VERIFIED: Socket reconnected (green dot visible), no partial streaming bubble
 *    persisted (stale buffer discarded), connection status shows "Session: MonoRepo"
 *
 * Note: NetInfo native module required pod install + native rebuild after adding
 * @react-native-community/netinfo dependency. Error "NativeModule.RNCNetInfo is null"
 * indicates missing native linking - run `npx expo run:ios` to rebuild.
 *
 * Implementation per decision 13A:
 * - AppState listener: disconnect() immediately on background, connect() on foreground
 * - NetInfo listener: reconnect() on network changes when foregrounded
 * - shouldBeConnected gate for auto-reconnect (only when foregrounded)
 * - Background staleness: marks streaming buffer stale after 10s, discards on reconnect
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import {
	useMaestroWebSocket,
	type UseMaestroWebSocketOptions,
	type UseMaestroWebSocketReturn,
	type WebSocketState,
} from '@/lib/useMaestroWebSocket';

// How long in background before streaming buffer is considered stale
const BACKGROUND_STALENESS_MS = 10_000;

export type MaestroConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';

export interface UseMaestroConnectionOptions extends UseMaestroWebSocketOptions {
	/** Called when streaming buffer is discarded due to staleness */
	onStaleBufferDiscarded?: () => void;
}

export interface UseMaestroConnectionReturn extends Omit<UseMaestroWebSocketReturn, 'state'> {
	/** High-level connection state for UI (includes reconnecting) */
	connectionState: MaestroConnectionState;
	/** Raw WebSocket state */
	wsState: WebSocketState;
	/** Whether the app is in foreground */
	isForeground: boolean;
}

export function useMaestroConnection(
	options: UseMaestroConnectionOptions = {}
): UseMaestroConnectionReturn {
	const { onStaleBufferDiscarded, handlers, ...wsOptions } = options;

	// Track foreground state
	const [isForeground, setIsForeground] = useState(true);
	const [isReconnecting, setIsReconnecting] = useState(false);

	// Track when we went to background (for staleness check)
	const backgroundedAtRef = useRef<number | null>(null);
	const hasStaleBufferRef = useRef(false);

	// Gate for auto-reconnect
	const shouldBeConnectedRef = useRef(true);

	// Wrap handlers to inject staleness logic
	const wrappedHandlers = {
		...handlers,
		onConnectionChange: (state: WebSocketState) => {
			// The mobile pairing handshake settles as a bare `connected` (the
			// desktop never sends `authenticated: true` for it), so treat both as
			// "reconnected" - otherwise the reconnecting flag and the stale-buffer
			// discard would never clear on mobile.
			if (state === 'authenticated' || state === 'connected') {
				setIsReconnecting(false);
				// Check for stale buffer on reconnect
				if (hasStaleBufferRef.current) {
					hasStaleBufferRef.current = false;
					onStaleBufferDiscarded?.();
				}
			}
			handlers?.onConnectionChange?.(state);
		},
	};

	// Inner WebSocket hook
	const ws = useMaestroWebSocket({
		...wsOptions,
		autoReconnect: shouldBeConnectedRef.current,
		handlers: wrappedHandlers,
	});

	const {
		state: wsState,
		connect,
		disconnect,
		send,
		isAuthenticated,
		error,
		requestSessionHistory,
	} = ws;

	// Derive high-level connection state
	const connectionState: MaestroConnectionState = (() => {
		if (isReconnecting) return 'reconnecting';
		if (wsState === 'authenticated' || wsState === 'connected') return 'connected';
		if (wsState === 'connecting') return 'connecting';
		return 'disconnected';
	})();

	// Handle AppState changes
	const handleAppStateChange = useCallback(
		(nextState: AppStateStatus) => {
			const wasBackground = !isForeground;
			const isNowForeground = nextState === 'active';

			setIsForeground(isNowForeground);

			if (isNowForeground && wasBackground) {
				// Returning to foreground
				shouldBeConnectedRef.current = true;

				// Check if buffer should be marked stale
				if (backgroundedAtRef.current) {
					const elapsed = Date.now() - backgroundedAtRef.current;
					if (elapsed > BACKGROUND_STALENESS_MS) {
						hasStaleBufferRef.current = true;
					}
				}
				backgroundedAtRef.current = null;

				// Reconnect if needed
				if (wsState === 'disconnected') {
					setIsReconnecting(true);
					connect();
				}
			} else if (!isNowForeground && !wasBackground) {
				// Going to background
				backgroundedAtRef.current = Date.now();
				shouldBeConnectedRef.current = false;
				disconnect();
			}
		},
		[isForeground, wsState, connect, disconnect]
	);

	// Handle network changes
	const handleNetworkChange = useCallback(
		(state: NetInfoState) => {
			// Only reconnect if foregrounded and we should be connected
			if (!isForeground || !shouldBeConnectedRef.current) return;

			// Network became available
			if (state.isConnected && wsState === 'disconnected') {
				setIsReconnecting(true);
				connect();
			}
		},
		[isForeground, wsState, connect]
	);

	// Set up AppState listener
	useEffect(() => {
		const subscription = AppState.addEventListener('change', handleAppStateChange);
		return () => subscription.remove();
	}, [handleAppStateChange]);

	// Set up NetInfo listener
	useEffect(() => {
		const unsubscribe = NetInfo.addEventListener(handleNetworkChange);
		return () => unsubscribe();
	}, [handleNetworkChange]);

	// Auto-connect on mount if foregrounded
	useEffect(() => {
		if (isForeground && wsState === 'disconnected') {
			connect();
		}
		// Only run on mount
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return {
		connectionState,
		wsState,
		isForeground,
		isAuthenticated,
		error,
		connect,
		disconnect,
		send,
		requestSessionHistory,
	};
}

export default useMaestroConnection;
