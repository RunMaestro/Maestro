/**
 * Background webview host registry for cross-session coworking browser access.
 *
 * The live <webview> for a browser tab normally exists only for the focused
 * agent (useBrowserTabMounting is active-agent-only). To let an agent read/drive
 * its own browser tab while the user is focused on a DIFFERENT agent, we mount a
 * hidden, off-screen <webview> for that (sessionId, tabUuid) via
 * CoworkingBackgroundBrowsers and expose its handle here.
 *
 * Each webview is a full renderer PROCESS, so this is opt-in (a setting) and
 * capped with LRU eviction (a limit setting). Partitions are preserved because
 * BrowserTabView mounts with the tab's own `partition` (per-session).
 */

import { create } from 'zustand';
import type { BrowserTabViewHandle } from '../components/MainPanel/BrowserTabView';

export interface BackgroundBrowserMount {
	key: string;
	sessionId: string;
	tabUuid: string;
	lastUsed: number;
}

interface CoworkingBackgroundBrowserState {
	mounts: BackgroundBrowserMount[];
	handles: Map<string, BrowserTabViewHandle>;
	/** Request a hidden background mount for a tab; LRU-evicts beyond `limit`. */
	requestMount: (sessionId: string, tabUuid: string, limit: number) => void;
	/** Mark a mount as recently used (keeps it from being evicted). */
	touch: (key: string) => void;
	/** Mark a tab as having a browser op in flight so it is never LRU-evicted
	 *  mid-op (its webview would unmount and the op would spuriously fail). */
	markOpStart: (key: string) => void;
	/** Clear the in-flight guard once the op resolves. */
	markOpEnd: (key: string) => void;
	/** Host callback: register/unregister a mounted webview's handle. */
	setHandle: (key: string, handle: BrowserTabViewHandle | null) => void;
	/** Drop all background mounts + handles (e.g. when the feature is disabled). */
	clear: () => void;
}

/** Composite key for a background-mounted tab. Used by the store, host, and responder. */
export function backgroundBrowserKey(sessionId: string, tabUuid: string): string {
	return `${sessionId}::${tabUuid}`;
}

/** Keys with a browser op in flight. Module-level (not reactive) so op bookkeeping
 *  never triggers a re-render of the background host. Consulted during eviction. */
const inFlightKeys = new Set<string>();

export const useCoworkingBackgroundBrowserStore = create<CoworkingBackgroundBrowserState>(
	(set, get) => ({
		mounts: [],
		handles: new Map(),
		requestMount: (sessionId, tabUuid, limit) => {
			const key = backgroundBrowserKey(sessionId, tabUuid);
			const now = Date.now();
			set((s) => {
				const existing = s.mounts.some((m) => m.key === key);
				let mounts = existing
					? s.mounts.map((m) => (m.key === key ? { ...m, lastUsed: now } : m))
					: [...s.mounts, { key, sessionId, tabUuid, lastUsed: now }];
				const cap = Math.min(10, Math.max(1, Math.floor(limit) || 1));
				if (mounts.length > cap) {
					const sorted = [...mounts].sort((a, b) => b.lastUsed - a.lastUsed);
					const kept = sorted.slice(0, cap);
					// Never evict a tab with an op in flight, even if it falls outside the
					// cap: unmounting its webview mid-op would make the op fail.
					for (const m of sorted.slice(cap)) {
						if (inFlightKeys.has(m.key)) kept.push(m);
					}
					mounts = kept;
				}
				return { mounts };
			});
		},
		touch: (key) =>
			set((s) => ({
				mounts: s.mounts.map((m) => (m.key === key ? { ...m, lastUsed: Date.now() } : m)),
			})),
		markOpStart: (key) => {
			inFlightKeys.add(key);
		},
		markOpEnd: (key) => {
			inFlightKeys.delete(key);
		},
		setHandle: (key, handle) => {
			const handles = new Map(get().handles);
			if (handle) {
				handles.set(key, handle);
			} else {
				handles.delete(key);
			}
			set({ handles });
		},
		clear: () => set({ mounts: [], handles: new Map() }),
	})
);
