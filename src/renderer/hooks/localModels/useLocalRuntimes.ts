/**
 * useLocalRuntimes - the connection between a surface and the native runtimes
 * local models run on.
 *
 * The runtime counterpart of `useLocalModels`, deliberately the same shape: a
 * listing, a live progress map, and the actions. A model is useless without an
 * engine to read it, so any surface offering to make a local model work has to
 * be able to fetch both, and it should not have to learn two idioms to do it.
 * A Cappella's `useVoiceRuntimes` is a thin wrapper over it.
 *
 * Mounting it issues exactly ONE call, the runtime listing, which is a disk read
 * against a frozen table: the surface can show what, how big, and whether this
 * platform has a build at all before the user agrees to fetch anything.
 *
 * The source defaults to `window.maestro.localModels.runtimes`, the ungated
 * core namespace; a consumer that gates its own channels passes its namespace.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { LocalModelsApi } from '../../../main/preload/localModels';
import type { LocalRuntimeListing } from '../../../main/local-models/service';
import type { RuntimeInstallProgress } from '../../../main/local-models/runtime/runtime-installer';
import { useThrottledProgressMap } from './useThrottledProgressMap';

/** The calls this hook makes against a runtime namespace. */
export type LocalRuntimesSource<L extends LocalRuntimeListing = LocalRuntimeListing> = Pick<
	LocalModelsApi['runtimes'],
	'install' | 'onProgress'
> & {
	list: () => Promise<L[]>;
};

export interface UseLocalRuntimesOptions<L extends LocalRuntimeListing> {
	/** Defaults to `window.maestro.localModels.runtimes`. Must be a stable object. */
	source?: LocalRuntimesSource<L>;
	/** When false the listing is skipped (the consumer's channel would reject). Defaults to true. */
	listEnabled?: boolean;
	/** Rejections the consumer expects and does not want shown. Must be stable. */
	isQuietError?: (message: string) => boolean;
}

export interface LocalRuntimesState<L extends LocalRuntimeListing = LocalRuntimeListing> {
	listings: L[];
	/** Live install progress, keyed by runtime id. Absent means "no job". */
	progress: Record<string, RuntimeInstallProgress>;
	loading: boolean;
	/** Set when a call rejected, unless `isQuietError` claimed it. */
	error: string | null;
	refresh: () => Promise<void>;
	install: (runtimeId: string) => Promise<void>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function useLocalRuntimes<L extends LocalRuntimeListing = LocalRuntimeListing>(
	options: UseLocalRuntimesOptions<L> = {}
): LocalRuntimesState<L> {
	const { listEnabled = true, isQuietError } = options;
	// Resolved per render rather than at module load: the bridge is installed by
	// the preload, and a test swaps it per case.
	const source: LocalRuntimesSource<L> =
		options.source ?? (window.maestro.localModels.runtimes as unknown as LocalRuntimesSource<L>);

	const [listings, setListings] = useState<L[]>([]);
	const [loading, setLoading] = useState(true);
	// Two errors, not one: every action ends in a refresh, and a refresh that
	// succeeds would otherwise wipe the message of the action that just failed.
	const [listError, setListError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const error = actionError ?? listError;

	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const { progress, record, clear } = useThrottledProgressMap<RuntimeInstallProgress>(mounted);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const next = listEnabled ? await source.list() : [];
			if (!mounted.current) return;
			setListings(next);
			setListError(null);
		} catch (err) {
			if (!mounted.current) return;
			const message = errorMessage(err);
			setListError(isQuietError?.(message) ? null : message);
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, [source, listEnabled, isQuietError]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		// The bridge owns its own teardown, so this returns the unsubscribe rather
		// than hand-pairing add/remove.
		return source.onProgress((update) => {
			record(update.runtimeId, update);
			// `done` changes what is on disk, so the listing has to be re-read. Only
			// on the terminal phase: refreshing per chunk would stat the install
			// directory hundreds of times a second.
			if (update.phase === 'done') void refresh();
		});
	}, [source, record, refresh]);

	const install = useCallback(
		async (runtimeId: string) => {
			try {
				await source.install(runtimeId);
				setActionError(null);
			} catch (err) {
				if (!mounted.current) return;
				setActionError(errorMessage(err));
			} finally {
				// Cleared whatever happened: a failed install leaves a stale bar at
				// whatever percentage it died on, which reads as a download that is
				// still running and will never finish.
				clear(runtimeId);
				await refresh();
			}
		},
		[source, clear, refresh]
	);

	return { listings, progress, loading, error, refresh, install };
}
