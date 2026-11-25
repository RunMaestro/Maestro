/**
 * Side questions (`/btw`) in flight and their answers.
 *
 * A side question is asked about a tab's conversation but is never part of it:
 * the answer shows on a card above that tab's composer until the user dismisses
 * it, and nothing here is persisted. Keyed per AI tab so a question asked in one
 * tab keeps its card there while the user works in another.
 */

import { create } from 'zustand';

export type SideQuestionStatus = 'thinking' | 'answered' | 'error';

export interface SideQuestionEntry {
	/**
	 * Identifies this attempt. The model call cannot be cancelled once sent, so a
	 * reply that lands after the user dismissed the card (or asked again) must be
	 * recognised and dropped instead of bringing a closed card back.
	 */
	requestId: string;
	sessionId: string;
	tabId: string;
	question: string;
	status: SideQuestionStatus;
	/** Present when status is 'answered'. */
	answer?: string;
	/** Present when status is 'error'. */
	error?: string;
	/** Model the question ran under, for the card's provenance line. */
	model?: string;
	startedAt: number;
}

interface SideQuestionState {
	/** Entries keyed by `${sessionId}:${tabId}`. */
	entries: Record<string, SideQuestionEntry>;
	beginSideQuestion: (entry: Omit<SideQuestionEntry, 'status' | 'startedAt'>) => void;
	resolveSideQuestion: (requestId: string, answer: string) => void;
	failSideQuestion: (requestId: string, error: string) => void;
	clearSideQuestion: (key: string) => void;
}

/** The map key for a tab. Exported so consumers never re-derive the format. */
export function sideQuestionKey(sessionId: string, tabId: string): string {
	return `${sessionId}:${tabId}`;
}

function findByRequestId(
	entries: Record<string, SideQuestionEntry>,
	requestId: string
): [string, SideQuestionEntry] | null {
	for (const [key, entry] of Object.entries(entries)) {
		if (entry.requestId === requestId) return [key, entry];
	}
	return null;
}

export const useSideQuestionStore = create<SideQuestionState>()((set) => ({
	entries: {},

	// A new question replaces the tab's card, answered or not: the card holds
	// one exchange, and the newest question is the one the user is waiting on.
	beginSideQuestion: (entry) =>
		set((s) => ({
			entries: {
				...s.entries,
				[sideQuestionKey(entry.sessionId, entry.tabId)]: {
					...entry,
					status: 'thinking',
					startedAt: Date.now(),
				},
			},
		})),

	resolveSideQuestion: (requestId, answer) =>
		set((s) => {
			const found = findByRequestId(s.entries, requestId);
			if (!found) return s;
			const [key, entry] = found;
			return { entries: { ...s.entries, [key]: { ...entry, status: 'answered', answer } } };
		}),

	failSideQuestion: (requestId, error) =>
		set((s) => {
			const found = findByRequestId(s.entries, requestId);
			if (!found) return s;
			const [key, entry] = found;
			return { entries: { ...s.entries, [key]: { ...entry, status: 'error', error } } };
		}),

	clearSideQuestion: (key) =>
		set((s) => {
			if (!s.entries[key]) return s;
			const entries = { ...s.entries };
			delete entries[key];
			return { entries };
		}),
}));

/** Selector factory: the entry for one tab, or undefined. */
export const selectSideQuestionEntry =
	(sessionId: string | undefined, tabId: string | undefined) =>
	(s: SideQuestionState): SideQuestionEntry | undefined =>
		sessionId && tabId ? s.entries[sideQuestionKey(sessionId, tabId)] : undefined;

/** Non-reactive read of one tab's entry, for keyboard handlers. */
export function getSideQuestionEntry(
	sessionId: string | undefined,
	tabId: string | undefined
): SideQuestionEntry | undefined {
	if (!sessionId || !tabId) return undefined;
	return useSideQuestionStore.getState().entries[sideQuestionKey(sessionId, tabId)];
}
