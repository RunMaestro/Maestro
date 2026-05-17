/**
 * claudeUsageStore — renderer-side mirror of the main-process Claude Max-plan
 * usage snapshot map.
 *
 * Snapshots live on disk (electron-store namespace `claude-usage-snapshots`,
 * keyed by canonical `CLAUDE_CONFIG_DIR`). The renderer reads them via the
 * `agents:getClaudeUsageSnapshots` IPC handler and caches them here.
 *
 * Refresh contract:
 *   - First read lazily fetches the map (so a mounted badge component triggers
 *     the first IPC round-trip without each render site having to wire it).
 *   - The `process:claude-mode-resolved` listener fires `refresh()` because the
 *     spawner sampled usage as part of its mode decision; the on-disk map may
 *     have changed.
 *   - The settings UI / Usage Dashboard "Refresh now" button can also call
 *     `refresh()` after asking main to re-sample.
 *
 * This is renderer-local state, NOT persisted across app restarts — the
 * authoritative store is on the main side. We hold the same map shape here for
 * cheap synchronous reads from React components.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Snapshot shape mirrors `UsageSnapshot` in `src/main/agents/claude-mode-selector.ts`.
 * Duplicated here to keep the renderer bundle free of main-process imports.
 *
 * `authState` is optional for back-compat with snapshots persisted before the
 * field existed — readers treat absence as `'authenticated'` and only switch
 * the dashboard row into the "run /login" CTA when it's explicitly
 * `'unauthenticated'`.
 */
export interface ClaudeUsageSnapshot {
	sampledAt: string;
	configDirKey: string;
	authState?: 'authenticated' | 'unauthenticated';
	session: { percent: number; resetsAt: string };
	weekAllModels: { percent: number; resetsAt: string };
	weekSonnetOnly: { percent: number; resetsAt: string };
}

interface ClaudeUsageState {
	snapshots: Record<string, ClaudeUsageSnapshot>;
	/** True once the first fetch has resolved (success or empty). Drives lazy first-read. */
	loaded: boolean;
	/** True while a refresh is in flight. Settings/Dashboard UIs use this to disable buttons. */
	refreshing: boolean;
	/** Replace the full snapshot map. */
	setSnapshots: (next: Record<string, ClaudeUsageSnapshot>) => void;
	/** Pull the latest map from main via IPC and store it. Safe to call repeatedly. */
	refresh: () => Promise<void>;
	/** Test-only: reset to initial state. */
	__resetForTests: () => void;
}

const initial = {
	snapshots: {} as Record<string, ClaudeUsageSnapshot>,
	loaded: false,
	refreshing: false,
};

export const useClaudeUsageStore = create<ClaudeUsageState>((set, get) => ({
	...initial,
	setSnapshots: (next) => set({ snapshots: next, loaded: true }),
	refresh: async () => {
		if (get().refreshing) return;
		set({ refreshing: true });
		try {
			const next = await window.maestro.agents.getClaudeUsageSnapshots();
			set({ snapshots: next ?? {}, loaded: true });
		} catch {
			// Swallow — main-side errors surface in main logs; the renderer just
			// keeps the last good snapshot rather than blowing up the UI.
			set({ loaded: true });
		} finally {
			set({ refreshing: false });
		}
	},
	__resetForTests: () => set({ ...initial }),
}));

/**
 * Imperative accessor for non-React call sites (the
 * `process:claude-mode-resolved` listener mostly). Returns the current
 * snapshot map without subscribing.
 */
export function getAllSnapshots(): Record<string, ClaudeUsageSnapshot> {
	return useClaudeUsageStore.getState().snapshots;
}

/**
 * Read the snapshot for a specific canonical `CLAUDE_CONFIG_DIR` key. Returns
 * `null` when the key is missing or undefined. Triggers a lazy first-load
 * fetch the first time any consumer mounts so the badge tooltip has data
 * without each render site having to wire the IPC manually.
 */
export function useClaudeUsageSnapshot(
	configDirKey: string | undefined
): ClaudeUsageSnapshot | null {
	const loaded = useClaudeUsageStore((s) => s.loaded);
	const snapshots = useClaudeUsageStore((s) => s.snapshots);

	useEffect(() => {
		if (!loaded) {
			void useClaudeUsageStore.getState().refresh();
		}
	}, [loaded]);

	if (!configDirKey) return null;
	return snapshots[configDirKey] ?? null;
}
