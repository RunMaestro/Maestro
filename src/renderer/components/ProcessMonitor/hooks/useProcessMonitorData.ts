import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { ActiveProcess } from '../types';

const POLL_INTERVAL_MS = 2000;
const REFRESH_SPINNER_MIN_MS = 500;

export interface UseProcessMonitorDataResult {
	activeProcesses: ActiveProcess[];
	isLoading: boolean;
	isRefreshing: boolean;
	refresh: () => Promise<void>;
}

// Owns the active-process polling lifecycle.
// - Initial fetch on mount.
// - Polls every POLL_INTERVAL_MS while the document is visible.
// - Pauses polling when document.hidden becomes true; resumes (and fetches once)
//   on visibilitychange back to visible.
// - Manual refresh keeps the spinner up for at least REFRESH_SPINNER_MIN_MS for visual feedback.
export function useProcessMonitorData(): UseProcessMonitorDataResult {
	const [activeProcesses, setActiveProcesses] = useState<ActiveProcess[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const fetchActiveProcesses = useCallback(async (showRefresh = false) => {
		if (showRefresh) {
			setIsRefreshing(true);
		}
		try {
			const processes = await window.maestro.process.getActiveProcesses();
			setActiveProcesses(processes);
		} catch (error) {
			logger.error('Failed to fetch active processes:', undefined, error);
			captureException(error);
		} finally {
			setIsLoading(false);
			if (showRefresh) {
				if (refreshTimeoutRef.current) {
					clearTimeout(refreshTimeoutRef.current);
				}
				refreshTimeoutRef.current = setTimeout(() => {
					setIsRefreshing(false);
					refreshTimeoutRef.current = null;
				}, REFRESH_SPINNER_MIN_MS);
			}
		}
	}, []);

	const refresh = useCallback(() => fetchActiveProcesses(true), [fetchActiveProcesses]);

	useEffect(() => {
		const startPolling = () => {
			if (intervalRef.current) return;
			intervalRef.current = setInterval(fetchActiveProcesses, POLL_INTERVAL_MS);
		};
		const stopPolling = () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};

		fetchActiveProcesses();
		if (typeof document === 'undefined' || !document.hidden) {
			startPolling();
		}

		const handleVisibilityChange = () => {
			if (document.hidden) {
				stopPolling();
			} else {
				// Catch up immediately, then resume the interval.
				fetchActiveProcesses();
				startPolling();
			}
		};

		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}

		return () => {
			stopPolling();
			if (refreshTimeoutRef.current) {
				clearTimeout(refreshTimeoutRef.current);
				refreshTimeoutRef.current = null;
			}
			if (typeof document !== 'undefined') {
				document.removeEventListener('visibilitychange', handleVisibilityChange);
			}
		};
	}, [fetchActiveProcesses]);

	return { activeProcesses, isLoading, isRefreshing, refresh };
}
