/**
 * useTokenUsage - the Usage Dashboard's token payload for a time range.
 *
 * One cache entry per range, shared by every surface that reads it (the Tokens
 * tab, the Overview speed cards, and the charts' Tokens metric modes), so they
 * cost one IPC round trip between them and a reopened dashboard renders the
 * last result immediately while it refreshes (see `useCachedResource`).
 */

import { useCallback } from 'react';
import type { StatsTimeRange } from '../../../shared/stats-types';
import { tokenUsageQueryForRange, type TokenUsageAggregate } from '../../../shared/tokenUsage';
import { revalidateCachedResource, useCachedResource } from '../../hooks/utils/useCachedResource';
import { captureException } from '../../utils/sentry';

function tokenUsageKey(timeRange: StatsTimeRange): string {
	return `token-usage:${timeRange}`;
}

function fetchTokenUsage(timeRange: StatsTimeRange, force: boolean): Promise<TokenUsageAggregate> {
	// Guard the bridge call: a renderer running against an older preload (or a
	// test harness with a partial `window.maestro` mock) would otherwise throw
	// synchronously and unmount the whole dashboard.
	const getTokenUsage = window.maestro?.stats?.getTokenUsage;
	if (typeof getTokenUsage !== 'function') {
		return Promise.reject(new Error('Token usage is unavailable in this build.'));
	}
	return getTokenUsage(tokenUsageQueryForRange(timeRange), force);
}

export function useTokenUsage(timeRange: StatsTimeRange, enabled = true) {
	const key = tokenUsageKey(timeRange);
	const resource = useCachedResource(key, () => fetchTokenUsage(timeRange, false), {
		enabled,
		onError: captureException,
	});

	/** Re-read changed transcripts now, bypassing main's short-lived memo. */
	const forceRefresh = useCallback(
		() => revalidateCachedResource(key, () => fetchTokenUsage(timeRange, true), captureException),
		[key, timeRange]
	);

	return { ...resource, forceRefresh };
}
