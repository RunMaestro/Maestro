/**
 * useDashboardResource - a Usage Dashboard panel's data, cached across opens and
 * refreshed when the stats database changes.
 *
 * The dashboard unmounts on close, so a panel holding its fetch in `useState`
 * comes back as a spinner on every reopen. Panels read through here instead:
 * the last result for the key renders on the first frame, a refetch runs on
 * mount, and `stats:updated` refreshes it in place without blanking the panel
 * (see `useCachedResource`).
 *
 * `stats:updated` fires once per recorded row, and names the table it wrote.
 * Pass `options.tables` with the tables the fetcher reads so a write to an
 * unrelated table (a shortcut press, a resilience retry) does not refetch the
 * panel. A burst of updates collapses into ONE trailing refetch after
 * `debounceMs` of quiet. An event without a table name (older main, or a bulk
 * change such as clearing data) always refetches.
 *
 * Render the result through `<DashboardPanelState>`: `error` must be shown as an
 * error, never as "no data".
 */

import { useEffect, useRef } from 'react';
import { useCachedResource } from '../../hooks/utils/useCachedResource';
import { captureException } from '../../utils/sentry';
import type { StatsTable } from '../../../shared/stats-types';

/** Quiet period before a burst of `stats:updated` events triggers a refetch. */
export const DASHBOARD_RESOURCE_DEBOUNCE_MS = 750;

export interface UseDashboardResourceOptions {
	/** The tables the fetcher reads. Omit to refetch on a change to any table. */
	tables?: readonly StatsTable[];
	/** Quiet period before a refetch. Defaults to `DASHBOARD_RESOURCE_DEBOUNCE_MS`. */
	debounceMs?: number;
}

export interface UseDashboardResourceResult<T> {
	data: T | undefined;
	/** Nothing to show yet and a fetch is pending. */
	loading: boolean;
	/** The last fetch failed; `data` (if any) is from an earlier fetch. */
	error: string | null;
	/** Fetch again now. */
	refresh: () => Promise<void>;
}

/** Whether a `stats:updated` for `table` concerns a panel reading `tables`. */
export function statsUpdateConcerns(
	table: StatsTable | undefined,
	tables: readonly StatsTable[] | undefined
): boolean {
	if (!table || !tables) return true;
	return tables.includes(table);
}

export function useDashboardResource<T>(
	key: string,
	fetcher: () => Promise<T>,
	/** Names the panel in the error report. */
	operation: string,
	options: UseDashboardResourceOptions = {}
): UseDashboardResourceResult<T> {
	const { data, loading, error, refresh } = useCachedResource(key, fetcher, {
		onError: (err) => captureException(err, { extra: { operation } }),
	});

	// Read through a ref so a caller's inline `tables` array does not resubscribe
	// (and drop a pending refetch) on every render.
	const tablesRef = useRef(options.tables);
	tablesRef.current = options.tables;
	const debounceMs = options.debounceMs ?? DASHBOARD_RESOURCE_DEBOUNCE_MS;

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = window.maestro.stats.onStatsUpdate((table) => {
			if (!statsUpdateConcerns(table, tablesRef.current)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void refresh();
			}, debounceMs);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, [refresh, debounceMs]);

	return { data, loading, error, refresh };
}
