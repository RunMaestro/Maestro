/**
 * Keep-alive pins for browser tabs an active-session coworking agent is driving.
 *
 * By default (browserTabKeepAlive 'off') only the visible browser tab is mounted;
 * the instant the user clicks to another surface the backgrounded tab's <webview>
 * unmounts, so an agent mid-task can no longer type into or read it. When a
 * focused agent runs a browser op we "pin" that tab here for a short TTL, and
 * useBrowserTabMounting keeps every currently-pinned tab mounted (hidden) so the
 * agent can keep driving it without stealing the user's focus. Each op refreshes
 * the pin; once the agent goes idle past the TTL the pin lapses and the tab
 * unmounts, freeing the renderer process.
 *
 * Pins are keyed by browser-tab UUID (the active session's own tab ids). Only the
 * focused agent's ops pin; cross-session agents use the off-screen background host
 * (coworkingBackgroundBrowserStore) instead.
 */

import { create } from 'zustand';

/** How long a browser tab stays kept-alive after an agent's most recent op. */
export const BROWSER_KEEPALIVE_TTL_MS = 120_000;

interface CoworkingBrowserKeepAliveState {
	/** tabUuid -> expiry epoch ms. */
	pins: Record<string, number>;
	/** Pin (or refresh) a tab so it stays mounted for `ttlMs` from now. */
	pin: (tabUuid: string, ttlMs?: number) => void;
	/** Drop every pin (e.g. when coworking is disabled). */
	clear: () => void;
}

/** Prune timer shared across the store; scheduled for the soonest pin expiry so
 *  an expired pin triggers a re-render that unmounts the tab. */
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/** Non-expired pinned tab ids at call time. */
export function activePinnedTabIds(pins: Record<string, number>): string[] {
	const now = Date.now();
	return Object.keys(pins).filter((id) => pins[id] > now);
}

export const useCoworkingBrowserKeepAliveStore = create<CoworkingBrowserKeepAliveState>(
	(set, get) => {
		const reschedulePrune = () => {
			if (pruneTimer) {
				clearTimeout(pruneTimer);
				pruneTimer = null;
			}
			const expiries = Object.values(get().pins);
			if (expiries.length === 0) return;
			const soonest = Math.min(...expiries);
			pruneTimer = setTimeout(
				() => {
					pruneTimer = null;
					const now = Date.now();
					const next: Record<string, number> = {};
					for (const [id, exp] of Object.entries(get().pins)) {
						if (exp > now) next[id] = exp;
					}
					set({ pins: next });
					reschedulePrune();
				},
				Math.max(0, soonest - Date.now()) + 50
			);
		};

		return {
			pins: {},
			pin: (tabUuid, ttlMs = BROWSER_KEEPALIVE_TTL_MS) => {
				set((s) => ({ pins: { ...s.pins, [tabUuid]: Date.now() + ttlMs } }));
				reschedulePrune();
			},
			clear: () => {
				if (pruneTimer) {
					clearTimeout(pruneTimer);
					pruneTimer = null;
				}
				set({ pins: {} });
			},
		};
	}
);
