/**
 * Renderer-side cache of Claude usage snapshots.
 *
 * The main process owns the authoritative `claudeUsageStore` (electron-store +
 * `maestro-p --status` samples). This zustand store is a thin renderer mirror
 * that the badge UI, settings, and Usage Dashboard subscribe to so they don't
 * each issue their own IPC round-trips on every render.
 *
 * Population strategy: fetch on first read (`ensureLoaded()`), and re-fetch
 * whenever `process:claude-mode-resolved` arrives — that's the only event
 * that signals a fresh `sampleUsage()` may have run in the main process. A
 * `refresh()` action is exposed so the settings panel and dashboard refresh
 * buttons (phase 3 tasks 4/5) can force-pull without involving the spawner.
 */

import { create } from 'zustand';

export interface ClaudeUsageSnapshot {
	sampledAt: string;
	configDirKey: string;
	session: { percent: number; resetsAt: string };
	weekAllModels: { percent: number; resetsAt: string };
	weekSonnetOnly: { percent: number; resetsAt: string };
}

interface ClaudeUsageStoreState {
	snapshots: Record<string, ClaudeUsageSnapshot>;
	loaded: boolean;
	loading: boolean;
	error: string | null;
	/** Trigger a fresh IPC read. Idempotent — concurrent calls share one request. */
	refresh: () => Promise<void>;
	/** Fetch once if not already loaded. Cheap to call from any consumer. */
	ensureLoaded: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useClaudeUsageStore = create<ClaudeUsageStoreState>((set, get) => ({
	snapshots: {},
	loaded: false,
	loading: false,
	error: null,
	refresh: async () => {
		if (inflight) return inflight;
		set({ loading: true, error: null });
		inflight = (async () => {
			try {
				const snapshots = await window.maestro.agents.getClaudeUsageSnapshots();
				set({ snapshots, loaded: true, loading: false });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn('[claudeUsageStore] refresh failed', err);
				set({ loading: false, error: message });
			} finally {
				inflight = null;
			}
		})();
		return inflight;
	},
	ensureLoaded: async () => {
		if (get().loaded || get().loading) return;
		await get().refresh();
	},
}));

/**
 * Subscribe to the snapshot for a given `configDirKey`. Triggers a one-time
 * load on first mount so a freshly opened tab eventually sees its account's
 * quota state without callers having to call `refresh()` themselves.
 *
 * Returns `null` while loading, when the key is unknown, or when the cached
 * snapshot has aged out of the main-process TTL.
 */
export function useClaudeUsageSnapshot(
	configDirKey: string | undefined | null
): ClaudeUsageSnapshot | null {
	const snapshot = useClaudeUsageStore((s) =>
		configDirKey ? (s.snapshots[configDirKey] ?? null) : null
	);
	const ensureLoaded = useClaudeUsageStore((s) => s.ensureLoaded);
	// Fire-and-forget: the store guards against duplicate fetches.
	if (typeof window !== 'undefined' && !useClaudeUsageStore.getState().loaded) {
		void ensureLoaded();
	}
	return snapshot;
}
