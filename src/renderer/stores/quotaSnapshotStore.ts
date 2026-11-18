/**
 * createQuotaSnapshotStore - the one renderer mirror shape behind every
 * provider plan-usage store (`claudeUsageStore`, `codexUsageStore`).
 *
 * Two operations, with different costs:
 *   - `refresh()` re-pulls the cached snapshot map from main. Cheap (one IPC
 *     read). A call that lands while a pull is in flight is coalesced into one
 *     trailing pull, so a caller that just finished sampling never has its
 *     fresh data dropped behind an older pull that started first.
 *   - `sample()` asks main to re-sample every account (slow: one provider
 *     spawn or network call per account), then re-pulls. It is single-flight
 *     and lives HERE, not in the panel that started it, so it outlives the
 *     panel: leaving the Usage Dashboard tab or closing the dashboard does not
 *     abandon it, the data lands in the store when it finishes, and a panel
 *     that remounts mid-sample reads `sampling` and shows the spinner again.
 *
 * The snapshot map is renderer-local and not persisted; main owns it on disk.
 */

import { create } from 'zustand';

export interface QuotaSnapshotState<TSnapshot> {
	snapshots: Record<string, TSnapshot>;
	/** True once the first pull has resolved (success or empty). Drives lazy first-read. */
	loaded: boolean;
	/** True while a cheap snapshot pull is in flight. */
	refreshing: boolean;
	/** True while a full main-side re-sample is in flight (outlives any panel). */
	sampling: boolean;
	/** Replace the full snapshot map. */
	setSnapshots: (next: Record<string, TSnapshot>) => void;
	/** Pull the latest map from main. Concurrent calls coalesce into one trailing pull. */
	refresh: () => Promise<void>;
	/** Re-sample every account on main, then pull. Concurrent calls share one run. */
	sample: () => Promise<void>;
	/** Test-only: reset to initial state. */
	__resetForTests: () => void;
}

export interface QuotaSnapshotStoreOptions<TSnapshot> {
	/** Read the cached snapshot map from main. */
	fetchSnapshots: () => Promise<Record<string, TSnapshot> | null | undefined>;
	/** Ask main to re-sample every account. Failures are logged on main. */
	sampleOnMain: () => Promise<unknown>;
}

export function createQuotaSnapshotStore<TSnapshot>({
	fetchSnapshots,
	sampleOnMain,
}: QuotaSnapshotStoreOptions<TSnapshot>) {
	// Each run holds a token while it owns its slot. The token (not the promise)
	// decides ownership because a body that throws synchronously finishes before
	// its promise is assigned, and a reset must orphan runs started before it.
	let pullToken: object | null = null;
	let inFlightPull: Promise<void> | null = null;
	let pullAgain = false;
	let sampleToken: object | null = null;
	let inFlightSample: Promise<void> | null = null;

	const initial = {
		snapshots: {} as Record<string, TSnapshot>,
		loaded: false,
		refreshing: false,
		sampling: false,
	};

	return create<QuotaSnapshotState<TSnapshot>>((set, get) => ({
		...initial,
		setSnapshots: (next) => set({ snapshots: next, loaded: true }),
		refresh: () => {
			if (inFlightPull) {
				pullAgain = true;
				return inFlightPull;
			}
			const token = {};
			pullToken = token;
			const pull = (async () => {
				set({ refreshing: true });
				try {
					do {
						pullAgain = false;
						try {
							const next = await fetchSnapshots();
							set({ snapshots: next ?? {}, loaded: true });
						} catch {
							// Main-side errors surface in main logs; keep the last good map.
							set({ loaded: true });
						}
					} while (pullAgain);
				} finally {
					if (pullToken === token) {
						pullToken = null;
						inFlightPull = null;
						set({ refreshing: false });
					}
				}
			})();
			if (pullToken === token) inFlightPull = pull;
			return pull;
		},
		sample: () => {
			if (inFlightSample) return inFlightSample;
			const token = {};
			sampleToken = token;
			const run = (async () => {
				set({ sampling: true });
				try {
					try {
						await sampleOnMain();
					} catch {
						// Main logs carry the detail; still pull whatever is cached.
					}
					await get().refresh();
				} finally {
					if (sampleToken === token) {
						sampleToken = null;
						inFlightSample = null;
						set({ sampling: false });
					}
				}
			})();
			if (sampleToken === token) inFlightSample = run;
			return run;
		},
		__resetForTests: () => {
			pullToken = null;
			inFlightPull = null;
			pullAgain = false;
			sampleToken = null;
			inFlightSample = null;
			set({ ...initial });
		},
	}));
}
