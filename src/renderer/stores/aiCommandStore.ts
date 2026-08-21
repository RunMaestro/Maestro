/**
 * AI command mode's in-flight request and its proposed command.
 *
 * AI command mode (the second rung of the bang ladder - see
 * `utils/shellCommandInput.ts`) turns a plain-English request into one command
 * line, shows it, and waits for a yes/no before running anything. That is three
 * transient states the composer has to render, and none of them belong on the
 * session model: nothing here survives a restart, and a proposal the user never
 * answered must not come back days later attached to a stale working directory.
 *
 * Keyed per AI tab so a request started in one tab keeps rendering there while
 * the user works in another. The composer only draws the entry whose key
 * matches the tab it is rendering, so switching away parks the proposal rather
 * than losing it.
 */

import { create } from 'zustand';

/** Where an AI command request is in its lifecycle. */
export type AiCommandStatus = 'thinking' | 'proposed' | 'error';

/** Which confirmation button is highlighted. Run is the default. */
export type AiCommandChoice = 'run' | 'cancel';

export interface AiCommandEntry {
	/**
	 * Identifies this attempt. The model call is a slow async round trip that
	 * cannot be cancelled once dispatched, so a reply that lands after the user
	 * dismissed (or restarted) the request has to be recognised and dropped -
	 * otherwise Escape would appear to work and then a proposal would pop back
	 * onto the screen a few seconds later.
	 */
	requestId: string;
	sessionId: string;
	tabId: string;
	/** Exactly what the user typed, kept so cancelling can hand it back. */
	request: string;
	status: AiCommandStatus;
	/** The command line the model returned. Present when status is 'proposed'. */
	command?: string;
	/** Model/effort the request ran under, for the card's provenance line. */
	model?: string;
	effort?: string;
	/** Failure text. Present when status is 'error'. */
	error?: string;
	choice: AiCommandChoice;
	startedAt: number;
}

interface AiCommandState {
	/** Entries keyed by `${sessionId}:${tabId}`. */
	entries: Record<string, AiCommandEntry>;
	beginAiCommand: (entry: Omit<AiCommandEntry, 'status' | 'choice' | 'startedAt'>) => void;
	resolveAiCommand: (requestId: string, command: string) => void;
	failAiCommand: (requestId: string, error: string) => void;
	setAiCommandChoice: (key: string, choice: AiCommandChoice) => void;
	clearAiCommand: (key: string) => void;
}

/** The map key for a tab. Exported so consumers never re-derive the format. */
export function aiCommandKey(sessionId: string, tabId: string): string {
	return `${sessionId}:${tabId}`;
}

/** Locate an entry by its request id, ignoring superseded attempts. */
function findByRequestId(
	entries: Record<string, AiCommandEntry>,
	requestId: string
): [string, AiCommandEntry] | null {
	for (const [key, entry] of Object.entries(entries)) {
		if (entry.requestId === requestId) return [key, entry];
	}
	return null;
}

export const useAiCommandStore = create<AiCommandState>()((set) => ({
	entries: {},

	beginAiCommand: (entry) =>
		set((s) => ({
			entries: {
				...s.entries,
				[aiCommandKey(entry.sessionId, entry.tabId)]: {
					...entry,
					status: 'thinking',
					// Run is preselected: the user asked for this command, so the common
					// case is Enter-to-run. Cancel is always one arrow key away.
					choice: 'run',
					startedAt: Date.now(),
				},
			},
		})),

	resolveAiCommand: (requestId, command) =>
		set((s) => {
			const found = findByRequestId(s.entries, requestId);
			if (!found) return s;
			const [key, entry] = found;
			return {
				entries: { ...s.entries, [key]: { ...entry, status: 'proposed', command } },
			};
		}),

	failAiCommand: (requestId, error) =>
		set((s) => {
			const found = findByRequestId(s.entries, requestId);
			if (!found) return s;
			const [key, entry] = found;
			return { entries: { ...s.entries, [key]: { ...entry, status: 'error', error } } };
		}),

	setAiCommandChoice: (key, choice) =>
		set((s) => {
			const entry = s.entries[key];
			if (!entry || entry.choice === choice) return s;
			return { entries: { ...s.entries, [key]: { ...entry, choice } } };
		}),

	clearAiCommand: (key) =>
		set((s) => {
			if (!s.entries[key]) return s;
			const entries = { ...s.entries };
			delete entries[key];
			return { entries };
		}),
}));

/** Selector factory: the entry for one tab, or undefined. */
export const selectAiCommandEntry =
	(sessionId: string | undefined, tabId: string | undefined) =>
	(s: AiCommandState): AiCommandEntry | undefined =>
		sessionId && tabId ? s.entries[aiCommandKey(sessionId, tabId)] : undefined;

/** Non-reactive read of one tab's entry, for keyboard handlers. */
export function getAiCommandEntry(
	sessionId: string | undefined,
	tabId: string | undefined
): AiCommandEntry | undefined {
	if (!sessionId || !tabId) return undefined;
	return useAiCommandStore.getState().entries[aiCommandKey(sessionId, tabId)];
}
