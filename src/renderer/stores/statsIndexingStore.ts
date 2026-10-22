/**
 * Renderer mirror of the main-process stats indexing state, plus how it is
 * being presented.
 *
 * The state is written ONLY from main (`stats:indexingUpdate`, and the one
 * `getIndexingState` read the host performs on mount, since a window can open
 * mid-scan). What the renderer owns is the presentation: a scan the user has
 * not seen yet opens as a modal, "Continue in background" turns it into the
 * corner card, and the card can be hidden for the rest of that scan.
 *
 * Choosing background is remembered for the life of the window: a usage-data
 * upgrade runs as several scans back to back (global totals, then the session
 * list), and re-raising the modal for each one would undo the choice the user
 * just made.
 */

import { create } from 'zustand';
import {
	EMPTY_STATS_INDEXING_STATE,
	summarizeStatsIndexing,
	type StatsIndexingState,
} from '../../shared/statsIndexing';

export type StatsIndexingPresentation = 'modal' | 'card' | 'hidden';

interface StatsIndexingStore {
	state: StatsIndexingState;
	presentation: StatsIndexingPresentation;
	/** Set by the first "Continue in background"; later scans start as the card. */
	preferBackground: boolean;
	applyState: (state: StatsIndexingState) => void;
	/** Modal -> corner card. The scan keeps running either way. */
	sendToBackground: () => void;
	/** Card -> nothing on screen, until the next scan starts. */
	hideCard: () => void;
	/** Card (or hidden) -> modal. */
	bringToFront: () => void;
}

const isScanVisible = (state: StatsIndexingState) => summarizeStatsIndexing(state, 0) !== null;

export const useStatsIndexingStore = create<StatsIndexingStore>()((set) => ({
	state: EMPTY_STATS_INDEXING_STATE,
	presentation: 'modal',
	preferBackground: false,
	applyState: (next) =>
		set((s) => {
			const startedNow = !isScanVisible(s.state) && isScanVisible(next);
			return startedNow
				? { state: next, presentation: s.preferBackground ? 'card' : 'modal' }
				: { state: next };
		}),
	sendToBackground: () => set({ presentation: 'card', preferBackground: true }),
	hideCard: () => set({ presentation: 'hidden' }),
	bringToFront: () => set({ presentation: 'modal' }),
}));

/** Whether a scan large enough to report is running. */
export function selectStatsIndexingActive(s: { state: StatsIndexingState }): boolean {
	return isScanVisible(s.state);
}
