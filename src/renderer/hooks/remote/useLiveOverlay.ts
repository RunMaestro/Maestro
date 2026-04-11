import { useState, useEffect, useRef, useCallback, RefObject } from 'react';
import { useClickOutside } from '../ui';

/**
 * Tunnel status states for remote access via Cloudflare tunnel
 */
export type TunnelStatus = 'off' | 'starting' | 'connected' | 'error';

/**
 * URL tab selection - local network vs remote tunnel
 */
export type UrlTab = 'local' | 'remote';

/**
 * Return type for the useLiveOverlay hook
 */
export interface UseLiveOverlayReturn {
	// Overlay state
	/** Whether the live overlay panel is open */
	liveOverlayOpen: boolean;
	/** Set the live overlay open state */
	setLiveOverlayOpen: (open: boolean) => void;
	/** Ref for the overlay container (for click-outside detection) */
	liveOverlayRef: RefObject<HTMLDivElement>;

	// Cloudflared state
	/** Whether cloudflared is installed (null = not checked yet) */
	cloudflaredInstalled: boolean | null;
	/** Whether we've checked for cloudflared installation */
	cloudflaredChecked: boolean;

	// Tunnel state
	/** Current tunnel status */
	tunnelStatus: TunnelStatus;
	/** Remote tunnel URL when connected */
	tunnelUrl: string | null;
	/** Error message if tunnel fails to start */
	tunnelError: string | null;
	/** Currently active URL tab (local or remote) */
	activeUrlTab: UrlTab;
	/** Set the active URL tab */
	setActiveUrlTab: (tab: UrlTab) => void;

	// Copy flash state
	/** Flash message shown after copying URL */
	copyFlash: string | null;
	/** Set the copy flash message (auto-clears after 2s) */
	setCopyFlash: (message: string | null) => void;

	// Handlers
	/** Toggle the tunnel on/off */
	handleTunnelToggle: () => Promise<void>;
	/** Restart the tunnel (stop + start) if currently connected; no-op otherwise */
	restartTunnel: () => Promise<void>;
}

/**
 * Hook that manages the Live overlay panel state in SessionList.
 *
 * Features:
 * - Manages overlay open/close state with click-outside detection
 * - Checks cloudflared installation status when overlay opens
 * - Handles Cloudflare tunnel start/stop for remote access
 * - Manages URL tab switching between local and remote
 * - Provides copy-to-clipboard feedback
 * - Resets tunnel state when live mode is disabled
 *
 * Extracted from SessionList.tsx to reduce file size and improve maintainability.
 *
 * @param isLiveMode - Whether global live mode is enabled
 * @returns Object containing overlay state, tunnel state, and handlers
 */
export function useLiveOverlay(isLiveMode: boolean): UseLiveOverlayReturn {
	// Overlay state
	const [liveOverlayOpen, setLiveOverlayOpen] = useState(false);
	const liveOverlayRef = useRef<HTMLDivElement>(null);

	// Cloudflared installation status (cached after first check)
	const [cloudflaredInstalled, setCloudflaredInstalled] = useState<boolean | null>(null);
	const [cloudflaredChecked, setCloudflaredChecked] = useState(false);

	// Tunnel state
	const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>('off');
	const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
	const [tunnelError, setTunnelError] = useState<string | null>(null);
	const [activeUrlTab, setActiveUrlTab] = useState<UrlTab>('local');

	// Copy flash state
	const [copyFlash, setCopyFlashState] = useState<string | null>(null);

	// Wrapper for setCopyFlash that auto-clears after 2 seconds
	const setCopyFlash = useCallback((message: string | null) => {
		setCopyFlashState(message);
		if (message) {
			setTimeout(() => setCopyFlashState(null), 2000);
		}
	}, []);

	// Close live overlay when clicking outside
	useClickOutside(liveOverlayRef, () => setLiveOverlayOpen(false), liveOverlayOpen);

	// Check for cloudflared installation when Live overlay opens
	useEffect(() => {
		if (isLiveMode && liveOverlayOpen && !cloudflaredChecked) {
			window.maestro.tunnel.isCloudflaredInstalled().then((installed: boolean) => {
				setCloudflaredInstalled(installed);
				setCloudflaredChecked(true);
			});
		}
	}, [isLiveMode, liveOverlayOpen, cloudflaredChecked]);

	// Reset tunnel state when live mode is disabled
	useEffect(() => {
		if (!isLiveMode) {
			setTunnelStatus('off');
			setTunnelUrl(null);
			setTunnelError(null);
			setActiveUrlTab('local');
		}
	}, [isLiveMode]);

	// Keep tunnel UI aligned with the actual cloudflared process state.
	useEffect(() => {
		if (!isLiveMode || (tunnelStatus !== 'starting' && tunnelStatus !== 'connected')) {
			return;
		}

		let cancelled = false;
		const syncStatus = async () => {
			try {
				const status = await window.maestro.tunnel.getStatus();
				if (cancelled) return;

				if (status.isRunning && status.url) {
					setTunnelStatus('connected');
					setTunnelUrl(status.url);
					setTunnelError(null);
					return;
				}

				if (status.error) {
					setTunnelStatus('error');
					setTunnelError(status.error);
				} else {
					setTunnelStatus('off');
				}
				setTunnelUrl(null);
				setActiveUrlTab('local');
			} catch (error) {
				if (cancelled) return;
				setTunnelStatus('error');
				setTunnelError(error instanceof Error ? error.message : 'Failed to read tunnel status');
				setTunnelUrl(null);
				setActiveUrlTab('local');
			}
		};

		void syncStatus();
		const intervalId = window.setInterval(
			() => {
				void syncStatus();
			},
			tunnelStatus === 'starting' ? 500 : 2000
		);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [isLiveMode, tunnelStatus]);

	// Handle tunnel toggle (start/stop remote access)
	const handleTunnelToggle = useCallback(async () => {
		if (tunnelStatus === 'connected') {
			// Turn off tunnel
			try {
				await window.maestro.tunnel.stop();
			} catch (error) {
				console.error('[handleTunnelToggle] Failed to stop tunnel:', error);
				// Continue anyway - we still want to update UI state
			}
			setTunnelStatus('off');
			setTunnelUrl(null);
			setTunnelError(null);
			setActiveUrlTab('local'); // Switch back to local tab
		} else if (tunnelStatus === 'off') {
			// Turn on tunnel
			setTunnelStatus('starting');
			setTunnelError(null);

			try {
				const result = await window.maestro.tunnel.start();
				if (result.success && result.url) {
					setTunnelStatus('connected');
					setTunnelUrl(result.url);
					setActiveUrlTab('remote'); // Auto-switch to remote tab
				} else {
					setTunnelStatus('error');
					setTunnelError(result.error || 'Failed to start tunnel');
				}
			} catch (error) {
				console.error('[handleTunnelToggle] Failed to start tunnel:', error);
				setTunnelStatus('error');
				setTunnelError(error instanceof Error ? error.message : 'Failed to start tunnel');
			}
		}
	}, [tunnelStatus]);

	// Restart the tunnel when the underlying web server changes (e.g. port change)
	const restartTunnel = useCallback(async () => {
		if (tunnelStatus !== 'connected') return;

		setTunnelStatus('starting');
		setTunnelError(null);

		try {
			await window.maestro.tunnel.stop();
		} catch (error) {
			console.error('[restartTunnel] Failed to stop tunnel:', error);
		}

		try {
			const result = await window.maestro.tunnel.start();
			if (result.success && result.url) {
				setTunnelStatus('connected');
				setTunnelUrl(result.url);
			} else {
				setTunnelStatus('error');
				setTunnelError(result.error || 'Failed to restart tunnel');
			}
		} catch (error) {
			console.error('[restartTunnel] Failed to restart tunnel:', error);
			setTunnelStatus('error');
			setTunnelError(error instanceof Error ? error.message : 'Failed to restart tunnel');
		}
	}, [tunnelStatus]);

	return {
		// Overlay state
		liveOverlayOpen,
		setLiveOverlayOpen,
		liveOverlayRef,

		// Cloudflared state
		cloudflaredInstalled,
		cloudflaredChecked,

		// Tunnel state
		tunnelStatus,
		tunnelUrl,
		tunnelError,
		activeUrlTab,
		setActiveUrlTab,

		// Copy flash state
		copyFlash,
		setCopyFlash,

		// Handlers
		handleTunnelToggle,
		restartTunnel,
	};
}
