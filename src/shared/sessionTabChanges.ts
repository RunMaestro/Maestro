/**
 * AI tab lifecycle a client reports alongside a `sessions:setMany` write.
 *
 * Every client (each desktop window, each web-desktop browser tab) flushes a
 * FULL copy of each dirty agent, so the stored record of an agent two clients
 * both hold is whichever copy was written last. That is how a tab closed in the
 * browser came back: the desktop still held it, the desktop's copy of the agent
 * went dirty for any reason at all, and its flush wrote the tab straight back
 * (issue #1492).
 *
 * A full copy cannot say which of its tabs are deliberate and which are merely
 * stale, but the client that wrote it can: it diffs each agent against its OWN
 * last flush. A tab that was there and is gone was closed HERE; a tab that was
 * not there and now is was opened (or reopened) HERE. Main keeps the closes as
 * tombstones and refuses a later write that carries one of those tabs back.
 */
export interface SessionTabChanges {
	/** AI tab ids this client closed since its previous flush. */
	closed?: string[];
	/** AI tab ids this client opened or reopened since its previous flush. */
	opened?: string[];
}

/** {@link SessionTabChanges} keyed by agent id. Agents with no change are absent. */
export type SessionTabChangesById = Record<string, SessionTabChanges>;

/** One AI tab another client closed, as pushed in `sessions:lifecycleSync`. */
export interface ClosedSessionTab {
	sessionId: string;
	tabId: string;
}
