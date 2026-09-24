/**
 * useVoiceModels - the one connection between Settings and the model manager.
 *
 * Both A Cappella surfaces (Voice Setup and the Models page) read from this
 * hook, so they cannot disagree about what is installed. It owns three things:
 * the catalog-plus-status listing, the live progress map, and the actions.
 *
 * Mounting it issues exactly ONE call: `models:list`, which is a disk read
 * against a frozen local catalog. That is the property Phase 03 is built around
 * and the one `VoiceSetupPanel.test.tsx` asserts - opening Voice Setup must not
 * touch the network, so the panel can show a full bill of materials before the
 * user has agreed to fetch anything.
 *
 * Progress is throttled here with `useThrottledCallback`, per the guide: the
 * downloader already throttles at the source, and this second stage keeps a
 * burst of per-model events from causing one React commit each.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DownloadProgress } from '../../../../main/acappella/models/model-downloader';
import type { VoiceModelListing } from '../../../../main/ipc/handlers/acappella-models';
import type { ModelFootprint, VerifyResult } from '../../../../main/acappella/models/model-store';
import type { VoiceReadiness } from '../../../../shared/acappella/readiness';
import { useThrottledCallback } from '../../../hooks/utils/useThrottle';

/** How often mirrored progress is allowed to re-render the panel. */
const PROGRESS_RENDER_MS = 200;

export interface VoiceModelsState {
	listings: VoiceModelListing[];
	/** Live download progress, keyed by model id. Absent means "no job". */
	progress: Record<string, DownloadProgress>;
	footprint: ModelFootprint | null;
	readiness: VoiceReadiness | null;
	loading: boolean;
	/** Set when a call rejected. `ACappellaDisabled` is normal and not surfaced. */
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

/**
 * @param enabled Mirror of the A Cappella Encore flag. When false the catalog
 *                listing is skipped (the channel would reject) but the footprint
 *                is still read, because the reclaim-disk offer exists precisely
 *                for the moment after the feature was switched off.
 */
export function useVoiceModels(enabled: boolean): VoiceModelsState {
	const [listings, setListings] = useState<VoiceModelListing[]>([]);
	const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
	const [footprint, setFootprint] = useState<ModelFootprint | null>(null);
	const [readiness, setReadiness] = useState<VoiceReadiness | null>(null);
	const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Progress arrives faster than React should commit, so events accumulate here
	// and are flushed on a throttled tick.
	const pendingProgress = useRef<Record<string, DownloadProgress>>({});
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
			const [nextFootprint, nextListings, nextReadiness] = await Promise.all([
				window.maestro.voice.models.footprint(),
				enabled ? window.maestro.voice.models.list() : Promise.resolve([]),
				enabled ? window.maestro.voice.models.readiness() : Promise.resolve(null),
			]);
			if (!mounted.current) return;
			setFootprint(nextFootprint);
			setListings(nextListings);
			setReadiness(nextReadiness);
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
		return window.maestro.voice.models.onProgress((update) => {
			pendingProgress.current = { ...pendingProgress.current, [update.modelId]: update };
			flushProgress();
			// A terminal phase changes what is on disk, so the listing has to be
			// re-read. Only on terminal phases: refreshing per chunk would stat every
			// model file hundreds of times a second.
			if (update.phase === 'complete' || update.phase === 'cancelled' || update.phase === 'error') {
				void refresh();
			}
		});
	}, [flushProgress, refresh]);

	const runAction = useCallback(
		async (action: () => Promise<unknown>) => {
			try {
				await action();
				setError(null);
			} catch (err) {
				if (!mounted.current) return;
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				await refresh();
			}
		},
		[refresh]
	);

	const download = useCallback(
		(modelId: string) => runAction(() => window.maestro.voice.models.download(modelId)),
		[runAction]
	);

	const downloadMany = useCallback(
		async (modelIds: string[]) => {
			// Fired together on purpose: the downloader owns the concurrency limit, so
			// staggering them here would only mean the queue is shorter than it should
			// be and the second file starts later than it could.
			await runAction(() =>
				Promise.all(modelIds.map((id) => window.maestro.voice.models.download(id)))
			);
		},
		[runAction]
	);

	const pause = useCallback(
		(modelId: string) => runAction(() => window.maestro.voice.models.pause(modelId)),
		[runAction]
	);

	const resume = useCallback(
		(modelId: string) => runAction(() => window.maestro.voice.models.resume(modelId)),
		[runAction]
	);

	const cancel = useCallback(
		(modelId: string) => runAction(() => window.maestro.voice.models.cancel(modelId)),
		[runAction]
	);

	const verify = useCallback(
		async (modelId: string) => {
			await runAction(async () => {
				const result = await window.maestro.voice.models.verify(modelId);
				if (mounted.current) setVerifyResults((prev) => ({ ...prev, [modelId]: result }));
			});
		},
		[runAction]
	);

	const remove = useCallback(
		(modelId: string) => runAction(() => window.maestro.voice.models.remove(modelId)),
		[runAction]
	);

	const removeAll = useCallback(
		() => runAction(() => window.maestro.voice.models.removeAll()),
		[runAction]
	);

	return useMemo(
		() => ({
			listings,
			progress,
			footprint,
			readiness,
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
			readiness,
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
