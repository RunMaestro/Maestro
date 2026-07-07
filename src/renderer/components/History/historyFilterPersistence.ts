import type { HistoryEntryType } from '../../types';

/**
 * Source-type filter selection (USER / AUTO / CUE) is persisted to
 * localStorage so a user's choice - e.g. deselecting CUE to hide heartbeat
 * noise - survives closing the view and restarting the app. Both the per-agent
 * Right Bar History (`HistoryPanel`) and the Director's Notes Unified History
 * use this, keyed by a distinct storage key each so the two surfaces stay
 * independent. Mirrors the `directorNotes.fontScale` idiom in AIOverviewTab.
 */

/**
 * Legacy global localStorage key for the Right Bar History filter. Kept as a
 * fallback so an existing selection carries over the first time an agent's
 * per-agent key is resolved (see `historyPanelFilterKeyForAgent`).
 */
export const HISTORY_PANEL_FILTERS_KEY = 'historyPanel.filters';
/** localStorage key for the Director's Notes Unified History filter. */
export const UNIFIED_HISTORY_FILTERS_KEY = 'directorNotes.historyFilters';

/**
 * Per-agent localStorage key for the Right Bar History filter. Each agent
 * keeps its own USER/AUTO/CUE selection so hiding e.g. CUE noise on one agent
 * doesn't affect the others, and the choice survives app restarts.
 */
export function historyPanelFilterKeyForAgent(sessionId: string): string {
	return `${HISTORY_PANEL_FILTERS_KEY}.${sessionId}`;
}

const ALL_FILTER_TYPES: readonly HistoryEntryType[] = ['USER', 'AUTO', 'CUE'];

/**
 * Load a persisted filter selection. Returns null when nothing was ever
 * stored (caller falls back to its all-on default). An empty set is a valid
 * persisted choice and is distinct from null.
 */
export function loadPersistedHistoryFilters(key: string): Set<HistoryEntryType> | null {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const valid = parsed.filter((t): t is HistoryEntryType =>
			ALL_FILTER_TYPES.includes(t as HistoryEntryType)
		);
		return new Set(valid);
	} catch {
		return null;
	}
}

export function savePersistedHistoryFilters(key: string, filters: Set<HistoryEntryType>): void {
	try {
		localStorage.setItem(key, JSON.stringify([...filters]));
	} catch {
		// Ignore write failures (quota, private mode) - persistence is best-effort.
	}
}

/**
 * Resolve the initial filter set for a history view: hydrate from storage,
 * else fall back to all-on for the currently-visible types. CUE is stripped
 * when the Cue feature is off (it's not a visible type then).
 *
 * When `fallbackKey` is provided and `key` has nothing stored, the fallback
 * key is consulted next. This lets a per-agent key inherit a previously-saved
 * global selection the first time an agent is resolved, so upgrading to
 * per-agent persistence doesn't reset anyone's current choice.
 */
export function resolveInitialHistoryFilters(
	key: string,
	maestroCueEnabled: boolean,
	fallbackKey?: string
): Set<HistoryEntryType> {
	const stored =
		loadPersistedHistoryFilters(key) ??
		(fallbackKey ? loadPersistedHistoryFilters(fallbackKey) : null);
	const base =
		stored ??
		new Set<HistoryEntryType>(maestroCueEnabled ? ['USER', 'AUTO', 'CUE'] : ['USER', 'AUTO']);
	if (!maestroCueEnabled) base.delete('CUE');
	return base;
}
