/**
 * useTokenUsage - the Usage Dashboard's token payload for a time range.
 *
 * One cache entry per range, shared by every surface that reads it (the Tokens
 * tab, the Overview speed cards, and the charts' Tokens metric modes), so they
 * cost one IPC round trip between them and a reopened dashboard renders the
 * last result immediately while it refreshes (see `useCachedResource`).
 *
 * The agents whose conversations are on another computer are counted there,
 * which can take a while. Main answers with the local totals at once and says
 * that count is still refreshing (`excluded.remoteRefreshing`); this hook then
 * reads once more, waiting for it, so the remote rows fill in when they land.
 */

import { useCallback, useEffect } from 'react';
import type { StatsTimeRange } from '../../../shared/stats-types';
import { tokenUsageQueryForRange, type TokenUsageAggregate } from '../../../shared/tokenUsage';
import { revalidateCachedResource, useCachedResource } from '../../hooks/utils/useCachedResource';
import { captureException } from '../../utils/sentry';

function tokenUsageKey(timeRange: StatsTimeRange): string {
	return `token-usage:${timeRange}`;
}

function fetchTokenUsage(
	timeRange: StatsTimeRange,
	force: boolean,
	waitForRemote = false
): Promise<TokenUsageAggregate> {
	// Guard the bridge call: a renderer running against an older preload (or a
	// test harness with a partial `window.maestro` mock) would otherwise throw
	// synchronously and unmount the whole dashboard.
	const getTokenUsage = window.maestro?.stats?.getTokenUsage;
	if (typeof getTokenUsage !== 'function') {
		return Promise.reject(new Error('Token usage is unavailable in this build.'));
	}
	return getTokenUsage(tokenUsageQueryForRange(timeRange), force, waitForRemote);
}

export function useTokenUsage(timeRange: StatsTimeRange, enabled = true) {
	const key = tokenUsageKey(timeRange);
	const resource = useCachedResource(key, () => fetchTokenUsage(timeRange, false), {
		enabled,
		onError: captureException,
	});

	// Once per payload that says the remote count is still refreshing: read again,
	// waiting for it. The waited read never says so, so this cannot loop; every
	// surface reading this range joins the one read in flight.
	const data = resource.data;
	useEffect(() => {
		if (!enabled || data?.excluded?.remoteRefreshing !== true) return;
		// After the read that delivered `data` has left the in-flight slot, or this
		// would join it instead of asking again.
		const timer = setTimeout(() => {
			void revalidateCachedResource(
				key,
				() => fetchTokenUsage(timeRange, false, true),
				captureException
			);
		}, 0);
		return () => clearTimeout(timer);
	}, [enabled, data, key, timeRange]);

	/** Re-read changed transcripts now, bypassing main's short-lived memo. */
	const forceRefresh = useCallback(
		() => revalidateCachedResource(key, () => fetchTokenUsage(timeRange, true), captureException),
		[key, timeRange]
	);

	return { ...resource, forceRefresh };
}
