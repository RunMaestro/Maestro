import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Session } from '../../../types';
import type { FileTreeChanges } from '../../../utils/fileExplorer';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';

interface UseAutoRefreshArgs {
	sessionId: string;
	autoRefreshInterval: number;
	refreshFileTree: (
		sessionId: string,
		options?: { maxEntriesOverride?: number }
	) => Promise<FileTreeChanges | undefined>;
	onAutoRefreshChange?: (interval: number) => void;
	onShowFlash?: (message: string) => void;
	setSessions: Dispatch<SetStateAction<Session[]>>;
}

interface UseAutoRefreshResult {
	isRefreshing: boolean;
	overlayOpen: boolean;
	overlayPosition: { top: number; left: number } | null;
	refreshButtonRef: React.RefObject<HTMLButtonElement>;
	handleRefresh: () => Promise<void>;
	handleRefreshMouseEnter: () => void;
	handleRefreshMouseLeave: () => void;
	handleOverlayMouseEnter: () => void;
	handleOverlayMouseLeave: () => void;
	handleIntervalSelect: (interval: number) => void;
}

export function useAutoRefresh({
	sessionId,
	autoRefreshInterval,
	refreshFileTree,
	onAutoRefreshChange,
	onShowFlash,
}: UseAutoRefreshArgs): UseAutoRefreshResult {
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [overlayPosition, setOverlayPosition] = useState<{ top: number; left: number } | null>(
		null
	);

	const refreshButtonRef = useRef<HTMLButtonElement>(null);
	const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isOverOverlayRef = useRef(false);
	const autoRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
	const autoRefreshSpinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const autoRefreshInFlightRef = useRef(false);

	// Use refs to avoid recreating the timer when callbacks change
	const refreshFileTreeRef = useRef(refreshFileTree);
	const sessionIdRef = useRef(sessionId);

	useEffect(() => {
		refreshFileTreeRef.current = refreshFileTree;
	}, [refreshFileTree]);

	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	// Handle refresh with animation and flash notification
	const handleRefresh = useCallback(async () => {
		setIsRefreshing(true);

		try {
			const changes = await refreshFileTree(sessionId);

			if (changes && onShowFlash) {
				const message =
					changes.totalChanges === 0
						? 'No changes detected'
						: `Detected ${changes.totalChanges} change${changes.totalChanges === 1 ? '' : 's'}`;
				onShowFlash(message);
			}
		} finally {
			// Keep spinner visible for at least 500ms for visual feedback
			setTimeout(() => setIsRefreshing(false), 500);
		}
	}, [refreshFileTree, sessionId, onShowFlash]);

	// Auto-refresh timer - uses refs to avoid resetting timer when callbacks change
	useEffect(() => {
		if (autoRefreshTimerRef.current) {
			clearInterval(autoRefreshTimerRef.current);
			autoRefreshTimerRef.current = null;
		}

		if (autoRefreshInterval > 0) {
			autoRefreshTimerRef.current = setInterval(async () => {
				// Skip if a previous auto-refresh is still in flight
				if (autoRefreshInFlightRef.current) return;
				autoRefreshInFlightRef.current = true;

				// Brief spin animation so user can see auto-refresh is active
				setIsRefreshing(true);
				try {
					await refreshFileTreeRef.current(sessionIdRef.current);
				} catch (error) {
					logger.error('[FileExplorer] Auto-refresh failed:', undefined, error);
					captureException(error, {
						extra: {
							sessionId: sessionIdRef.current,
							operation: 'fileExplorer.autoRefresh',
						},
					});
				} finally {
					autoRefreshSpinTimeoutRef.current = setTimeout(() => {
						setIsRefreshing(false);
						autoRefreshInFlightRef.current = false;
					}, 500);
				}
			}, autoRefreshInterval * 1000);
		}

		return () => {
			if (autoRefreshTimerRef.current) {
				clearInterval(autoRefreshTimerRef.current);
				autoRefreshTimerRef.current = null;
			}
			if (autoRefreshSpinTimeoutRef.current) {
				clearTimeout(autoRefreshSpinTimeoutRef.current);
				autoRefreshSpinTimeoutRef.current = null;
			}
			autoRefreshInFlightRef.current = false;
		};
	}, [autoRefreshInterval]);

	// Hover handlers for refresh button overlay
	const handleRefreshMouseEnter = useCallback(() => {
		hoverTimeoutRef.current = setTimeout(() => {
			if (refreshButtonRef.current) {
				const rect = refreshButtonRef.current.getBoundingClientRect();
				setOverlayPosition({ top: rect.bottom + 4, left: rect.right });
			}
			setOverlayOpen(true);
		}, 400);
	}, []);

	const handleRefreshMouseLeave = useCallback(() => {
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		// Delay closing to allow mouse to reach overlay
		hoverTimeoutRef.current = setTimeout(() => {
			if (!isOverOverlayRef.current) {
				setOverlayOpen(false);
			}
		}, 100);
	}, []);

	const handleOverlayMouseEnter = useCallback(() => {
		isOverOverlayRef.current = true;
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
	}, []);

	const handleOverlayMouseLeave = useCallback(() => {
		isOverOverlayRef.current = false;
		setOverlayOpen(false);
	}, []);

	const handleIntervalSelect = useCallback(
		(interval: number) => {
			onAutoRefreshChange?.(interval);
			setOverlayOpen(false);
		},
		[onAutoRefreshChange]
	);

	return {
		isRefreshing,
		overlayOpen,
		overlayPosition,
		refreshButtonRef,
		handleRefresh,
		handleRefreshMouseEnter,
		handleRefreshMouseLeave,
		handleOverlayMouseEnter,
		handleOverlayMouseLeave,
		handleIntervalSelect,
	};
}
