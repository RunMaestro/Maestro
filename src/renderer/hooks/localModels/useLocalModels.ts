/**
 * useLocalModels - the one connection between a surface and the Local Models
 * model store.
 *
 * Every surface that lists, downloads, or deletes local models reads from this
 * hook, so two surfaces cannot disagree about what is installed. It owns three
 * things: the catalog-plus-status listing, the live progress map, and the
 * actions. A Cappella's `useVoiceModels` is a thin wrapper over it that points
 * it at the Encore-gated voice channels and adds voice readiness.
 *
 * Mounting it issues the listing and footprint reads and nothing else. Both are
 * disk reads against a frozen local catalog, so a surface can show the full bill
 * of materials before the user has agreed to fetch anything. Nothing here opens
 * a connection except `download`, `downloadMany`, and `resume`.
 *
 * The source defaults to `window.maestro.localModels`, the ungated core
 * namespace. A consumer that gates its own channels passes its namespace as
 * `source`; both reach the same main-process service, so the state machine here
 * is the only one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { LocalModelsApi } from '../../../main/preload/localModels';
import type {
	LocalModelInstallResult,
	LocalModelListing,
} from '../../../main/local-models/service';
import type { DownloadProgress, DownloadResult } from '../../../main/local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../../../main/local-models/model-store';
import { useThrottledProgressMap } from './useThrottledProgressMap';

/**
 * The calls this hook makes. `window.maestro.localModels` satisfies it, and so
 * does any consumer namespace that fronts the same service.
 */
export type LocalModelsSource<L extends LocalModelListing = LocalModelListing> = Pick<
	LocalModelsApi,
	'pause' | 'resume' | 'cancel' | 'verify' | 'remove' | 'removeAll' | 'footprint' | 'onProgress'
> & {
	list: () => Promise<L[]>;
	/**
	 * The core channel also installs the model's runtime and reports it
	 * (`LocalModelInstallResult`); a consumer namespace that manages runtimes
	 * itself (voice) answers with the bare download result.
	 */
	download: (modelId: string) => Promise<DownloadResult | LocalModelInstallResult>;
};

export interface UseLocalModelsOptions<L extends LocalModelListing, X> {
	/** Defaults to `window.maestro.localModels`. Must be a stable object. */
	source?: LocalModelsSource<L>;
	/**
	 * When false the listing (and `loadExtra`) is skipped but the footprint is
	 * still read: a consumer whose channels reject while it is switched off can
	 * still offer to reclaim the disk it used. Defaults to true.
	 */
	listEnabled?: boolean;
	/**
	 * A consumer-specific read that must stay in step with the listing (voice
	 * readiness, for example). Run in the same refresh, so the two can never
	 * describe different moments. Must be stable.
	 */
	loadExtra?: () => Promise<X>;
	/** Rejections the consumer expects and does not want shown. Must be stable. */
	isQuietError?: (message: string) => boolean;
}

export interface LocalModelsState<L extends LocalModelListing = LocalModelListing, X = never> {
	listings: L[];
	/** Live download progress, keyed by model id. Absent means "no job". */
	progress: Record<string, DownloadProgress>;
	footprint: ModelFootprint | null;
	/** Result of `loadExtra`, or null when there is none or the listing is off. */
	extra: X | null;
	loading: boolean;
	/** Set when a call rejected, unless `isQuietError` claimed it. */
	error: string | null;
	/** Last verify result per model, so a corrupt row can show both hashes. */
	verifyResults: Record<string, VerifyResult>;
	refresh: () => Promise<void>;
	download: (modelId: string) => Promise<void>;
	downloadMany: (modelIds: string[]) => Promise<void>;
	pause: (modelId: string) => Promise<void>;
	resume: (modelId: string) => Promise<void>;
	cancel: (modelId: string) => Promise<void>;
	verify: (modelId: string) => Promise<void>;
	remove: (modelId: string) => Promise<void>;
	removeAll: () => Promise<void>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function useLocalModels<L extends LocalModelListing = LocalModelListing, X = never>(
	options: UseLocalModelsOptions<L, X> = {}
): LocalModelsState<L, X> {
	const { listEnabled = true, loadExtra, isQuietError } = options;
	// Resolved per render rather than at module load: the bridge is installed by
	// the preload, and a test swaps it per case.
	const source: LocalModelsSource<L> =
		options.source ?? (window.maestro.localModels as unknown as LocalModelsSource<L>);

	const [listings, setListings] = useState<L[]>([]);
	const [footprint, setFootprint] = useState<ModelFootprint | null>(null);
	const [extra, setExtra] = useState<X | null>(null);
	const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
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

	const { progress, record } = useThrottledProgressMap<DownloadProgress>(mounted);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const [nextFootprint, nextListings, nextExtra] = await Promise.all([
				source.footprint(),
				listEnabled ? source.list() : Promise.resolve([] as L[]),
				listEnabled && loadExtra ? loadExtra() : Promise.resolve(null),
			]);
			if (!mounted.current) return;
			setFootprint(nextFootprint);
			setListings(nextListings);
			setExtra(nextExtra);
			setListError(null);
		} catch (err) {
			if (!mounted.current) return;
			const message = errorMessage(err);
			setListError(isQuietError?.(message) ? null : message);
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, [source, listEnabled, loadExtra, isQuietError]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		// The bridge owns its own teardown, so this returns the unsubscribe rather
		// than hand-pairing add/remove.
		return source.onProgress((update) => {
			record(update.modelId, update);
			// A terminal phase changes what is on disk, so the listing has to be
			// re-read. Only on terminal phases: refreshing per chunk would stat every
			// model file hundreds of times a second.
			if (update.phase === 'complete' || update.phase === 'cancelled' || update.phase === 'error') {
				void refresh();
			}
		});
	}, [source, record, refresh]);

	const runAction = useCallback(
		async (action: () => Promise<unknown>) => {
			try {
				await action();
				setActionError(null);
			} catch (err) {
				if (!mounted.current) return;
				setActionError(errorMessage(err));
			} finally {
				await refresh();
			}
		},
		[refresh]
	);

	const download = useCallback(
		(modelId: string) =>
			runAction(async () => {
				// The core channel installs the model's runtime alongside it and
				// reports both. Weights that arrived without their engine are not a
				// success the row can show as "Installed" and leave at that.
				const result = await source.download(modelId);
				const runtime = result && 'runtime' in result ? result.runtime : undefined;
				if (runtime?.status === 'failed') {
					throw new Error(
						`The model downloaded, but its engine did not install: ${runtime.error ?? 'unknown error'}`
					);
				}
			}),
		[source, runAction]
	);

	const downloadMany = useCallback(
		async (modelIds: string[]) => {
			// Fired together on purpose: the downloader owns the concurrency limit, so
			// staggering them here would only mean the queue is shorter than it should
			// be and the second file starts later than it could.
			await runAction(() => Promise.all(modelIds.map((id) => source.download(id))));
		},
		[source, runAction]
	);

	const pause = useCallback(
		(modelId: string) => runAction(() => source.pause(modelId)),
		[source, runAction]
	);

	const resume = useCallback(
		(modelId: string) => runAction(() => source.resume(modelId)),
		[source, runAction]
	);

	const cancel = useCallback(
		(modelId: string) => runAction(() => source.cancel(modelId)),
		[source, runAction]
	);

	const verify = useCallback(
		async (modelId: string) => {
			await runAction(async () => {
				const result = await source.verify(modelId);
				if (mounted.current) setVerifyResults((prev) => ({ ...prev, [modelId]: result }));
			});
		},
		[source, runAction]
	);

	const remove = useCallback(
		(modelId: string) => runAction(() => source.remove(modelId)),
		[source, runAction]
	);

	const removeAll = useCallback(() => runAction(() => source.removeAll()), [source, runAction]);

	return useMemo(
		() => ({
			listings,
			progress,
			footprint,
			extra,
			loading,
			error,
			verifyResults,
			refresh,
			download,
			downloadMany,
			pause,
			resume,
			cancel,
			verify,
			remove,
			removeAll,
		}),
		[
			listings,
			progress,
			footprint,
			extra,
			loading,
			error,
			verifyResults,
			refresh,
			download,
			downloadMany,
			pause,
			resume,
			cancel,
			verify,
			remove,
			removeAll,
		]
	);
}
