/**
 * useLiveDataviewResult - a Dataview answer that stays current (DV-7).
 *
 * The result lives in the module-level resource cache (`useCachedResource`), so a
 * remounted block repaints on its first frame. On top of that, a
 * `dataview:changed` event for the root the result came from (same host, newer
 * revision) re-runs the query after a 300 ms quiet period, so a burst of saves
 * costs one query. The shown result stays on screen until the new one replaces
 * it: the cache only swaps data when a fetch succeeds.
 */

import { useEffect, useRef } from 'react';
import type { DataviewQueryResponse } from '../../../shared/dataview';
import { useCachedResource, type UseCachedResourceResult } from '../utils/useCachedResource';
import { useDebouncedCallback } from '../utils/useThrottle';
import { isDataviewChangeFor, subscribeDataviewChanges } from '../../services/dataviewChanges';

/** Quiet period between an index change and the re-run it triggers. */
export const DATAVIEW_REFRESH_DEBOUNCE_MS = 300;

type DataviewAnswer = Pick<DataviewQueryResponse<unknown>, 'root' | 'sshRemoteId' | 'revision'>;

export function useLiveDataviewResult<T extends DataviewAnswer>(
	key: string,
	fetcher: () => Promise<T>
): UseCachedResourceResult<T> {
	const resource = useCachedResource(key, fetcher);
	const { data, refresh } = resource;
	const shownRef = useRef(data);
	shownRef.current = data;

	const { debouncedCallback: scheduleRefresh } = useDebouncedCallback(() => {
		void refresh();
	}, DATAVIEW_REFRESH_DEBOUNCE_MS);

	useEffect(
		() =>
			subscribeDataviewChanges((event) => {
				// Before the first answer the root is unknown, and the pending fetch reads the newest index anyway.
				const shown = shownRef.current;
				if (shown && isDataviewChangeFor(event, shown)) scheduleRefresh();
			}),
		[scheduleRefresh]
	);

	return resource;
}
