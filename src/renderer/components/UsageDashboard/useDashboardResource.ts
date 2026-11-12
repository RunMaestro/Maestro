/**
 * useDashboardResource - a Usage Dashboard panel's data, cached across opens and
 * refreshed when the stats database changes.
 *
 * The dashboard unmounts on close, so a panel holding its fetch in `useState`
 * comes back as a spinner on every reopen. Panels read through here instead:
 * the last result for the key renders on the first frame, a refetch runs on
 * mount, and `stats:updated` refreshes it in place without blanking the panel
 * (see `useCachedResource`).
 */

import { useEffect } from 'react';
import {
	useCachedResource,
	type UseCachedResourceResult,
} from '../../hooks/utils/useCachedResource';
import { captureException } from '../../utils/sentry';

export function useDashboardResource<T>(
	key: string,
	fetcher: () => Promise<T>,
	/** Names the panel in the error report. */
	operation: string
): UseCachedResourceResult<T> {
	const resource = useCachedResource(key, fetcher, {
		onError: (err) => captureException(err, { extra: { operation } }),
	});
	const { refresh } = resource;

	useEffect(() => window.maestro.stats.onStatsUpdate(() => void refresh()), [refresh]);

	return resource;
}
