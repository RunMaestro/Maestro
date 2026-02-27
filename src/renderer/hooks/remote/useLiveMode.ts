/**
 * useLiveMode — extracted from App.tsx (Tier 3B)
 *
 * Manages the global live mode (web interface for all sessions):
 *   - isLiveMode state (whether web server is running)
 *   - webInterfaceUrl state (current URL)
 *   - toggleGlobalLive (start/stop server + tunnel)
 *   - restartWebServer (restart when port settings change)
 *
 * Calls IPC: window.maestro.tunnel, window.maestro.live
 */

import { useState, useCallback } from 'react';

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

export function useLiveMode(): UseLiveModeReturn {
	const [isLiveMode, setIsLiveMode] = useState(false);
	const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);

	const toggleGlobalLive = useCallback(async () => {
		try {
			if (isLiveMode) {
				// Stop tunnel first (if running), then stop web server
				await (window as any).maestro.tunnel.stop();
				await (window as any).maestro.live.disableAll();
				setIsLiveMode(false);
				setWebInterfaceUrl(null);
			} else {
				// Turn on - start the server and get the URL
				const result = await (window as any).maestro.live.startServer();
				if (result.success && result.url) {
					setIsLiveMode(true);
					setWebInterfaceUrl(result.url);
				} else {
					console.error('[toggleGlobalLive] Failed to start server:', result.error);
				}
			}
		} catch (error) {
			console.error('[toggleGlobalLive] Error:', error);
		}
	}, [isLiveMode]);

	const restartWebServer = useCallback(async (): Promise<string | null> => {
		if (!isLiveMode) return null;
		try {
			// Stop and restart the server to pick up new port settings
			await (window as any).maestro.live.stopServer();
			const result = await (window as any).maestro.live.startServer();
			if (result.success && result.url) {
				setWebInterfaceUrl(result.url);
				return result.url;
			} else {
				console.error('[restartWebServer] Failed to restart server:', result.error);
				return null;
			}
		} catch (error) {
			console.error('[restartWebServer] Error:', error);
			return null;
		}
	}, [isLiveMode]);

	return { isLiveMode, webInterfaceUrl, toggleGlobalLive, restartWebServer };
}
