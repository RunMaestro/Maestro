/**
 * useModelUsage
 *
 * Loads the record the Usage Dashboard's Models tab draws: what every model
 * other than a provider's own did over a time range
 * (`window.maestro.stats.getModelUsage`, the same `readModelUsage()` that
 * `maestro-cli stats models` prints).
 *
 * Three rules, each one a way a self-fetching panel goes wrong:
 *
 *   - A refresh keeps the last record on screen. Only the first load of a range
 *     reports `loading`, so new data does not flash the skeleton over a tab the
 *     user is reading.
 *   - An answer for a range the user has already left is dropped. Without that,
 *     a slow "All Time" read lands after a fast "Today" one and the tab shows
 *     the wrong range under the right label.
 *   - `stats:updated` is debounced. A burst of housekeeping runs would otherwise
 *     re-read four tables once per run.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelUsage } from '../../../shared/local-models/model-usage';
import type { StatsTimeRange } from '../../../shared/stats-types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { useDebouncedCallback } from '../utils/useThrottle';

/** How long a burst of `stats:updated` events is collected before one re-read. */
const UPDATE_DEBOUNCE_MS = 1000;

export interface UseModelUsageResult {
	/** The record for `range`. Null until the first load of a range answers, and after a failure. */
	usage: ModelUsage | null;
	/** True while a range has no record yet. A background refresh does not set it. */
	loading: boolean;
	/** Why the last load failed, unwrapped for display. Null otherwise. */
	error: string | null;
	/** Read the range again, showing the loading state. */
	reload: () => void;
}

export function useModelUsage(range: StatsTimeRange): UseModelUsageResult {
	const [usage, setUsage] = useState<ModelUsage | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// The newest request. An answer that is not for it is stale and is dropped;
	// unmounting bumps it too, so nothing sets state on a panel that is gone.
	const requestRef = useRef(0);

	const load = useCallback(
		async (background: boolean) => {
			const request = ++requestRef.current;
			if (!background) {
				setLoading(true);
				setError(null);
			}
			try {
				const next = await window.maestro.stats.getModelUsage(range);
				if (request !== requestRef.current) return;
				setUsage(next);
				setError(null);
			} catch (err) {
				if (request !== requestRef.current) return;
				logger.error('Failed to fetch model usage:', undefined, err);
				captureException(err, { extra: { operation: 'fetchModelUsage', range } });
				// A failed background refresh leaves the record on screen: it is
				// still true for the moment it was read, and blanking a working
				// tab over one missed refresh is worse than a second of staleness.
				if (!background) {
					setUsage(null);
					setError(ipcErrorMessage(err));
				}
			} finally {
				if (request === requestRef.current) setLoading(false);
			}
		},
		[range]
	);

	const { debouncedCallback: refreshSoon, cancel: cancelRefresh } = useDebouncedCallback(
		() => void load(true),
		UPDATE_DEBOUNCE_MS
	);

	useEffect(() => {
		// A new range starts from nothing: the last range's record under this
		// range's label would be a wrong answer, not a stale one.
		setUsage(null);
		void load(false);
		const unsubscribe = window.maestro.stats.onStatsUpdate(refreshSoon);
		return () => {
			requestRef.current++;
			cancelRefresh();
			unsubscribe();
		};
	}, [load, refreshSoon, cancelRefresh]);

	const reload = useCallback(() => void load(false), [load]);

	return { usage, loading, error, reload };
}
