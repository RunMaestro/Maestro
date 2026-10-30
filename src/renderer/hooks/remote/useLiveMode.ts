/**
 * useLiveMode - extracted from App.tsx (Tier 3B)
 *
 * Manages the global live mode (web interface for all sessions):
 *   - isLiveMode state (whether web server is running)
 *   - webInterfaceUrl state (current URL)
 *   - toggleGlobalLive (Live on/off through main's one Live switch)
 *   - restartWebServer (restart when port settings change)
 *
 * Calls IPC: window.maestro.tunnel, window.maestro.live
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { logger } from '../../utils/logger';
import { isWebDesktop } from '../../utils/runtimeContext';
import type { LiveModeStateEvent } from '../../../shared/liveMode';

// ============================================================================
// Return type
// ============================================================================

export interface UseLiveModeReturn {
	/** Whether the global web interface is active */
	isLiveMode: boolean;
	/** Current web interface URL (or null if not running) */
	webInterfaceUrl: string | null;
	/** Toggle web server on/off with tunnel management */
	toggleGlobalLive: () => Promise<void>;
	/** Restart server when port settings change; returns new URL or null */
	restartWebServer: () => Promise<string | null>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useLiveMode(autoStart = false): UseLiveModeReturn {
	const [isLiveMode, setIsLiveMode] = useState(false);
	const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);
	// True while restartWebServer runs. Its stop + start each push a state
	// change, and following the stop would flash Live off mid-restart, which
	// resets the Remote Control row before restartTunnel can act on it.
	const restartingRef = useRef(false);

	const applyState = useCallback((state: LiveModeStateEvent) => {
		setIsLiveMode(state.live);
		setWebInterfaceUrl(state.live ? state.url : null);
	}, []);

	// Main owns Live state (a LAN server is running or it is not). Read it on
	// mount, then follow every switch: one made in another window, by
	// `maestro-cli live on|off`, or before a renderer reload. Skipped in the
	// web-desktop bundle, whose bridge refuses `live:*` writes and reads alike
	// and which never draws the LIVE pill.
	useEffect(() => {
		if (isWebDesktop()) return;
		let cancelled = false;
		window.maestro.live
			.getState()
			.then((state) => {
				if (!cancelled) applyState(state);
			})
			.catch((error) => {
				logger.error('[useLiveMode] Failed to read Live state:', undefined, error);
			});
		const unsubscribe = window.maestro.live.onStateChanged?.((state) => {
			if (!restartingRef.current) applyState(state);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [applyState]);

	useEffect(() => {
		if (!autoStart) return;

		let cancelled = false;
		const enableLiveMode = async () => {
			try {
				// Idempotent: a second window (or a CLI `live on`) that already
				// turned Live on makes this a no-op that keeps the token.
				const result = await window.maestro.live.set(true);
				if (cancelled) {
					// This effect initiated the server, so disabling auto-start or
					// unmounting before it finishes must not leave an ownerless process.
					if (result.success && result.changed) {
						try {
							await window.maestro.live.set(false);
						} catch (error) {
							logger.error('[useLiveMode] Failed to stop cancelled auto-start:', undefined, error);
						}
					}
					return;
				}
				applyState(result.status);
				if (!result.success) {
					logger.error('[useLiveMode] Failed to auto-start server:', undefined, result.error);
				}
			} catch (error) {
				if (!cancelled) {
					logger.error('[useLiveMode] Auto-start failed:', undefined, error);
				}
			}
		};

		void enableLiveMode();
		return () => {
			cancelled = true;
		};
	}, [autoStart, applyState]);

	// The LIVE pill. Main runs the switch (off also stops Remote Control first)
	// and answers with the state after it, the same call `maestro-cli live`
	// reaches over the `live_command` message.
	const toggleGlobalLive = useCallback(async () => {
		try {
			const result = await window.maestro.live.set(!isLiveMode);
			applyState(result.status);
			if (!result.success) {
				logger.error('[toggleGlobalLive] Failed to switch Live mode:', undefined, result.error);
			}
		} catch (error) {
			logger.error('[toggleGlobalLive] Error:', undefined, error);
		}
	}, [isLiveMode, applyState]);

	// Moving between networks (WiFi to hotspot, dock to undock) changes the LAN
	// address the URL and QR code are built from. The server keeps running on
	// 0.0.0.0, so main just hands us the new address and the panel redraws -
	// no restart, and the token stays the same.
	useEffect(() => {
		const unsubscribe = (window as any).maestro?.live?.onUrlChanged?.(
			({ url }: { url: string }) => {
				// Only while the panel has a URL to show: with Live off the
				// server is CLI-only and its address is not user-facing.
				setWebInterfaceUrl((prev) => (prev ? url : prev));
			}
		);
		return () => unsubscribe?.();
	}, []);

	const restartWebServer = useCallback(async (): Promise<string | null> => {
		if (!isLiveMode) return null;
		restartingRef.current = true;
		try {
			// Stop and restart the server to pick up new port settings
			await (window as any).maestro.live.stopServer();
			const result = await (window as any).maestro.live.startServer();
			if (result.success && result.url) {
				setWebInterfaceUrl(result.url);
				return result.url;
			} else {
				// Server stopped but failed to restart - update state to reflect stopped server
				setIsLiveMode(false);
				setWebInterfaceUrl(null);
				logger.error('[restartWebServer] Failed to restart server:', undefined, result.error);
				return null;
			}
		} catch (error) {
			// stopServer may have succeeded - ensure state reflects server is down
			setIsLiveMode(false);
			setWebInterfaceUrl(null);
			logger.error('[restartWebServer] Error:', undefined, error);
			return null;
		} finally {
			restartingRef.current = false;
		}
	}, [isLiveMode]);

	return { isLiveMode, webInterfaceUrl, toggleGlobalLive, restartWebServer };
}
