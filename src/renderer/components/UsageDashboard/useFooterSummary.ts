/**
 * useFooterSummary
 *
 * Lets the panel that owns a tab's data write that tab's footer line.
 *
 * Most dashboard tabs are summarized by the modal itself, which already holds
 * the `StatsAggregation` (see `buildModalOwnedFooterSummary`). The rest - Cue,
 * Auto Run, Shortcuts, the plan quota panels, and the two card grids that own
 * their own filter state - fetch or compute numbers the modal cannot see. Those
 * publish through this store instead of the modal re-fetching to describe them,
 * which would put two loaders on one dataset and let them disagree.
 *
 * A store rather than a React context on purpose. A provider would have to wrap
 * the dashboard modal's entire body, and re-indenting that file is exactly the
 * kind of whitespace churn that turns a main -> rc merge into hand-resolution
 * work (`rc` has split `UsageDashboardModal` into a directory). The store is
 * per-renderer-process, so a second dashboard in a second window gets its own.
 *
 * Summaries are keyed BY TAB rather than kept as a single current value. A bare
 * "latest publisher wins" slot breaks on every tab switch: React mounts the
 * incoming panel before unmounting the outgoing one, so the outgoing panel's
 * cleanup would erase the summary the new tab just published. Keying by tab
 * makes that ordering irrelevant - a panel can only ever clear its own key.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { FooterSummaryTab } from './footerSummary';

type FooterSummaries = Partial<Record<FooterSummaryTab, string>>;

interface FooterSummaryState {
	summaries: FooterSummaries;
	publish: (tab: FooterSummaryTab, summary: string | null) => void;
	clear: (tab: FooterSummaryTab) => void;
}

export const useFooterSummaryStore = create<FooterSummaryState>((set) => ({
	summaries: {},
	publish: (tab, summary) =>
		set((state) => {
			const current = state.summaries[tab];
			// A null summary means "nothing to say" and is stored as absence, so
			// the footer's `published ?? fallback` can fall through to the modal.
			if (summary === null) {
				if (current === undefined) return state;
				const next = { ...state.summaries };
				delete next[tab];
				return { summaries: next };
			}
			if (current === summary) return state;
			return { summaries: { ...state.summaries, [tab]: summary } };
		}),
	clear: (tab) =>
		set((state) => {
			if (state.summaries[tab] === undefined) return state;
			const next = { ...state.summaries };
			delete next[tab];
			return { summaries: next };
		}),
}));

/**
 * Publish this tab's footer line for as long as the calling panel is mounted.
 * Pass `null` while loading or when the tab has nothing worth stating.
 *
 * Call it unconditionally, above any early return for loading / empty / error
 * states - it is a hook, and a panel that bails early is exactly the panel that
 * needs to clear a stale summary.
 */
export function usePublishFooterSummary(tab: FooterSummaryTab, summary: string | null): void {
	useEffect(() => {
		useFooterSummaryStore.getState().publish(tab, summary);
		return () => useFooterSummaryStore.getState().clear(tab);
	}, [tab, summary]);
}

/** Read the published summary for a tab, if any panel has written one. */
export function usePublishedFooterSummary(tab: FooterSummaryTab): string | null {
	return useFooterSummaryStore((s) => s.summaries[tab] ?? null);
}
