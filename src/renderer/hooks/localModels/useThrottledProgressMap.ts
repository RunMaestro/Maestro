/**
 * useThrottledProgressMap - the live progress map both Local Models hooks keep.
 *
 * Model downloads and runtime installs both stream progress events keyed by an
 * id, faster than React should commit. Events accumulate in a ref and are
 * flushed on a throttled tick (`useThrottledCallback`, per the guide): the main
 * process already throttles at the source, and this second stage keeps a burst
 * of per-id events from causing one React commit each.
 *
 * Internal to `hooks/localModels`; it exists so `useLocalModels` and
 * `useLocalRuntimes` share one implementation of the buffering rather than two.
 */

import { useCallback, useRef, useState, type RefObject } from 'react';

import { useThrottledCallback } from '../utils/useThrottle';

/** How often mirrored progress is allowed to re-render a surface. */
export const PROGRESS_RENDER_MS = 200;

export interface ThrottledProgressMap<P> {
	/** Live progress keyed by id. Absent means "no job". */
	progress: Record<string, P>;
	/** Buffer one update; the commit happens on the next throttled tick. */
	record: (id: string, update: P) => void;
	/** Drop one id immediately, so a dead job does not leave a stale bar behind. */
	clear: (id: string) => void;
}

/**
 * @param mounted The owning hook's mounted flag. A flush after unmount is a
 *                no-op rather than a state update on a dead component.
 */
export function useThrottledProgressMap<P>(mounted: RefObject<boolean>): ThrottledProgressMap<P> {
	const [progress, setProgress] = useState<Record<string, P>>({});
	const pending = useRef<Record<string, P>>({});

	const flush = useThrottledCallback(() => {
		if (!mounted.current) return;
		setProgress({ ...pending.current });
	}, PROGRESS_RENDER_MS);

	const record = useCallback(
		(id: string, update: P) => {
			pending.current = { ...pending.current, [id]: update };
			flush();
		},
		[flush]
	);

	const clear = useCallback(
		(id: string) => {
			if (!(id in pending.current)) return;
			const rest = { ...pending.current };
			delete rest[id];
			pending.current = rest;
			if (mounted.current) setProgress({ ...rest });
		},
		[mounted]
	);

	return { progress, record, clear };
}
