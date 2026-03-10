/**
 * ScanProgressIndicator - Shows a brief "Scanning..." indicator when LLM Guard is processing
 *
 * Features:
 * - Appears near the input area when LLM Guard is scanning content
 * - Auto-dismisses when scan completes (typically < 100ms)
 * - Only shows for prompts above a minimum length (to avoid flicker for short inputs)
 * - Shows a subtle animation while scanning
 *
 * Behavior:
 * - Listens to scan_start/scan_complete events from the security preload API
 * - Only shows for content above MIN_LENGTH_FOR_INDICATOR (50 characters)
 * - Has a minimum display time to prevent visual jarring (MIN_DISPLAY_MS)
 */

import { memo, useState, useEffect, useRef } from 'react';
import { Shield, Loader2 } from 'lucide-react';
import type { Theme } from '../types';
import type { ScanProgressEvent } from '../../main/preload/security';

/** Minimum content length to show the indicator (avoids flicker for short inputs) */
const MIN_LENGTH_FOR_INDICATOR = 50;

/** Minimum display time in ms (prevents visual jarring for very fast scans) */
const MIN_DISPLAY_MS = 200;

interface ScanProgressIndicatorProps {
	theme: Theme;
	/** Whether LLM Guard is enabled */
	enabled: boolean;
	/** Session ID to filter events (optional - if not provided, shows for all sessions) */
	sessionId?: string;
	/** Tab ID to filter events (optional) */
	tabId?: string;
}

export const ScanProgressIndicator = memo(function ScanProgressIndicator({
	theme,
	enabled,
	sessionId,
	tabId,
}: ScanProgressIndicatorProps) {
	const [isScanning, setIsScanning] = useState(false);
	const [contentLength, setContentLength] = useState(0);

	// Track when scan started for minimum display time
	const scanStartTimeRef = useRef<number | null>(null);
	// Track pending hide timeout
	const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!enabled || !window.maestro?.security?.onScanProgress) {
			return;
		}

		const unsubscribe = window.maestro.security.onScanProgress((event: ScanProgressEvent) => {
			// Filter by session if provided
			if (sessionId && event.sessionId !== sessionId) {
				return;
			}

			// Filter by tab if provided
			if (tabId && event.tabId !== tabId) {
				return;
			}

			if (event.eventType === 'scan_start') {
				// Only show indicator for content above minimum length
				if (event.contentLength < MIN_LENGTH_FOR_INDICATOR) {
					return;
				}

				// Clear any pending hide timeout
				if (hideTimeoutRef.current) {
					clearTimeout(hideTimeoutRef.current);
					hideTimeoutRef.current = null;
				}

				setIsScanning(true);
				setContentLength(event.contentLength);
				scanStartTimeRef.current = Date.now();
			} else if (event.eventType === 'scan_complete') {
				// Calculate how long we should wait before hiding
				// to ensure minimum display time
				const elapsed = scanStartTimeRef.current
					? Date.now() - scanStartTimeRef.current
					: MIN_DISPLAY_MS;
				const remainingTime = Math.max(0, MIN_DISPLAY_MS - elapsed);

				if (remainingTime > 0) {
					// Wait for minimum display time
					hideTimeoutRef.current = setTimeout(() => {
						setIsScanning(false);
						hideTimeoutRef.current = null;
					}, remainingTime);
				} else {
					// Minimum time already elapsed, hide immediately
					setIsScanning(false);
				}
			}
		});

		return () => {
			unsubscribe();
			if (hideTimeoutRef.current) {
				clearTimeout(hideTimeoutRef.current);
			}
		};
	}, [enabled, sessionId, tabId]);

	// Don't render if guard is disabled or not scanning
	if (!enabled || !isScanning) {
		return null;
	}

	return (
		<div
			className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs animate-pulse"
			style={{
				backgroundColor: `${theme.colors.accent}15`,
				color: theme.colors.accent,
				border: `1px solid ${theme.colors.accent}30`,
			}}
			role="status"
			aria-live="polite"
			aria-label="Scanning content for security issues"
		>
			<div className="relative">
				<Shield className="w-3.5 h-3.5" />
				<Loader2
					className="w-3 h-3 absolute -top-0.5 -right-0.5 animate-spin"
					style={{ color: theme.colors.accent }}
				/>
			</div>
			<span className="font-medium">Scanning...</span>
			{contentLength > 1000 && (
				<span className="opacity-60">({Math.round(contentLength / 1000)}k chars)</span>
			)}
		</div>
	);
});
