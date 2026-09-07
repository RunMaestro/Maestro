/**
 * useVoiceRuntimes - the connection between Settings and the native runtimes.
 *
 * The runtime counterpart of `useVoiceModels`, deliberately the same shape: a
 * listing, a live progress map, and the actions. A model is useless without an
 * engine to read it, so any surface offering to make voice work has to be able
 * to fetch both, and it should not have to learn two different idioms to do it.
 *
 * Mounting it issues exactly ONE call, `runtimes:list`, which is a disk read
 * against a frozen table. That is the same property Voice Setup is built around:
 * the panel can show the full bill of materials - what, how big, and whether
 * this platform has a build at all - before the user agrees to fetch anything.
 *
 * Progress is throttled here for the same reason it is in `useVoiceModels`: the
 * installer already throttles at the source, and this second stage keeps a burst
 * of events from causing one React commit each.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceRuntimeListing } from '../../../../main/ipc/handlers/acappella-models';
import type { RuntimeInstallProgress } from '../../../../main/acappella/runtime/runtime-installer';
import { useThrottledCallback } from '../../../hooks/utils/useThrottle';

/** How often mirrored progress is allowed to re-render the panel. */
const PROGRESS_RENDER_MS = 200;

export interface VoiceRuntimesState {
	listings: VoiceRuntimeListing[];
	/** Live install progress, keyed by runtime id. Absent means "no job". */
	progress: Record<string, RuntimeInstallProgress>;
	loading: boolean;
	/** Set when a call rejected. `ACappellaDisabled` is normal and not surfaced. */
	error: string | null;
	refresh: () => Promise<void>;
	install: (runtimeId: string) => Promise<void>;
}

/**
 * @param enabled Mirror of the A Cappella Encore flag. When false the listing is
 *                skipped, because the channel would reject.
 */
export function useVoiceRuntimes(enabled: boolean): VoiceRuntimesState {
	const [listings, setListings] = useState<VoiceRuntimeListing[]>([]);
	const [progress, setProgress] = useState<Record<string, RuntimeInstallProgress>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Progress arrives faster than React should commit, so events accumulate here
	// and are flushed on a throttled tick.
	const pendingProgress = useRef<Record<string, RuntimeInstallProgress>>({});
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const flushProgress = useThrottledCallback(() => {
		if (!mounted.current) return;
		setProgress({ ...pendingProgress.current });
	}, PROGRESS_RENDER_MS);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const next = enabled ? await window.maestro.voice.runtimes.list() : [];
			if (!mounted.current) return;
			setListings(next);
			setError(null);
		} catch (err) {
			if (!mounted.current) return;
			const message = err instanceof Error ? err.message : String(err);
			// The feature being off is not an error worth showing; every channel
			// rejects with it by design.
			setError(message.includes('ACappellaDisabled') ? null : message);
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, [enabled]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		// The bridge owns its own teardown, so this returns the unsubscribe rather
		// than hand-pairing add/remove.
		return window.maestro.voice.runtimes.onProgress((update) => {
			pendingProgress.current = { ...pendingProgress.current, [update.runtimeId]: update };
			flushProgress();
			// `done` changes what is on disk, so the listing has to be re-read. Only
			// on the terminal phase: refreshing per chunk would stat the install
			// directory hundreds of times a second.
			if (update.phase === 'done') void refresh();
		});
	}, [flushProgress, refresh]);

	const install = useCallback(
		async (runtimeId: string) => {
			try {
				await window.maestro.voice.runtimes.install(runtimeId);
				setError(null);
			} catch (err) {
				if (!mounted.current) return;
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				// Cleared whatever happened: a failed install leaves a stale bar at
				// whatever percentage it died on, which reads as a download that is
				// still running and will never finish.
				delete pendingProgress.current[runtimeId];
				setProgress({ ...pendingProgress.current });
				await refresh();
			}
		},
		[refresh]
	);

	return { listings, progress, loading, error, refresh, install };
}
