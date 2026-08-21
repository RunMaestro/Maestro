/**
 * useTranscriptBackfill - page older history into an AI tab when the user
 * scrolls to the top of the transcript (issue #1407).
 *
 * An AI tab only ever holds the newest slice of its conversation. Resuming a
 * session reads the newest 500 provider messages, and persistence truncates
 * each tab to the newest 100 entries so `sessions.json` stays small, so after a
 * restart the tab starts even shorter. The full transcript is still on disk;
 * nothing was wired up to go back for it, so scrolling up hit a hard stop at an
 * arbitrary older message with no way to reach the start of the conversation.
 *
 * The storage layer already pages from the newest message backwards
 * (`BaseSessionStorage.applyMessagePagination`), so each step here re-reads a
 * window that is one page larger and prepends whatever falls above the boundary
 * (see `selectOlderEntries`). Growing the window rather than tracking a raw
 * offset is deliberate: the tab's entry count is only a lower bound on the
 * messages it represents (tool-only messages are dropped on the way in), so
 * there is no offset the renderer could compute that would stay correct.
 *
 * That lower bound is why one read is not always enough. A tool-heavy
 * conversation can show 60 entries for the newest 500 provider messages, so a
 * window sized from the entry count alone can land entirely INSIDE what is
 * already on screen, prepend nothing, and leave the user parked at the top with
 * no way to ask again (they are already at scrollTop 0, so no further scroll
 * event fires). Two things prevent that: the first window is seeded from the
 * depth the resume path actually read rather than from `logs.length`, and a
 * single `loadEarlier()` keeps widening until it either prepends something or
 * reaches the start of the file.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AITab, Session } from '../../types';
import { selectSessionById, updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';
import {
	TRANSCRIPT_RESUME_READ_LIMIT,
	selectOlderEntries,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../../utils/transcriptMessages';

/** Provider messages pulled in per "load earlier" step. */
export const TRANSCRIPT_BACKFILL_PAGE = 250;

/**
 * How many times one `loadEarlier()` will widen its window while the reads keep
 * coming back entirely inside the visible transcript. Each step costs a full
 * transcript read, so this is a backstop against a pathological ratio of
 * tool-only messages, not the expected path: seeding from
 * `TRANSCRIPT_RESUME_READ_LIMIT` means the common case resolves on the first
 * read. Hitting the cap is not an error - the user simply gets the next page on
 * their next scroll instead.
 */
const MAX_WIDEN_STEPS_PER_LOAD = 8;

export interface UseTranscriptBackfillOptions {
	/**
	 * Called synchronously with the number of entries just prepended, in the
	 * same tick as the store update so both land in one React commit. The
	 * transcript uses this to keep its progressive render window from mounting a
	 * whole page of markdown in a single blocking commit (issue #1342).
	 */
	onPrepend?: (count: number) => void;
}

export interface TranscriptBackfill {
	/** True while a page is being read from disk. */
	isLoading: boolean;
	/** True once a read has proven the tab now starts at the first message. */
	reachedStart: boolean;
	/** Set when the last read failed; the caller offers a retry. */
	error: string | null;
	/** Pull in the next page of older history. No-op when already loading or done. */
	loadEarlier: () => void;
}

export function useTranscriptBackfill(
	session: Session,
	activeTab: AITab | undefined,
	options: UseTranscriptBackfillOptions = {}
): TranscriptBackfill {
	const sessionId = session.id;
	const projectRoot = session.projectRoot;
	const toolType = session.toolType;
	const sshRemoteId = session.sshRemoteId;
	const tabId = activeTab?.id ?? null;
	const agentSessionId = activeTab?.agentSessionId ?? null;

	const [isLoading, setIsLoading] = useState(false);
	const [reachedStart, setReachedStart] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Provider-message count covered by the last read, tracked separately from
	// `logs.length` for the reason in the file header.
	const windowRef = useRef<number | null>(null);
	const inFlightRef = useRef(false);

	// Bumped whenever the hook retargets (tab switch, agent session change). Every
	// read captures the value it started with and drops its results if it no
	// longer matches, so a read that outlives its tab cannot prepend into the new
	// tab's render window, overwrite the new tab's window size, clear the new
	// tab's in-flight flag, or falsely mark it as having reached the start.
	const generationRef = useRef(0);

	const onPrependRef = useRef(options.onPrepend);
	onPrependRef.current = options.onPrepend;

	// The transcript is remounted per tab today, but reset explicitly so a future
	// caller that keeps this hook alive across tabs cannot page one tab's window
	// against another tab's transcript.
	useEffect(() => {
		generationRef.current += 1;
		windowRef.current = null;
		inFlightRef.current = false;
		setIsLoading(false);
		setReachedStart(false);
		setError(null);
	}, [tabId, agentSessionId]);

	const loadEarlier = useCallback(() => {
		if (inFlightRef.current || reachedStart) return;
		if (!tabId || !agentSessionId || !projectRoot) return;

		inFlightRef.current = true;
		setIsLoading(true);
		setError(null);

		const generation = generationRef.current;
		const isStale = () => generationRef.current !== generation;

		void (async () => {
			try {
				const tab = selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs?.find(
					(t) => t.id === tabId
				);
				const visible = tab?.logs ?? [];

				for (let step = 0; step < MAX_WIDEN_STEPS_PER_LOAD; step++) {
					// Seed the first window from the depth the resume path actually read,
					// not from `visible.length` - see the note in the file header on why
					// the entry count is only a lower bound on the messages it covers.
					const nextWindow =
						(windowRef.current ?? Math.max(visible.length, TRANSCRIPT_RESUME_READ_LIMIT)) +
						TRANSCRIPT_BACKFILL_PAGE;

					const result = await window.maestro.agentSessions.read(
						toolType || 'claude-code',
						projectRoot,
						agentSessionId,
						{ offset: 0, limit: nextWindow },
						sshRemoteId
					);
					// The tab may have changed while that read was outstanding. Anything
					// below this point would write into whatever tab is on screen NOW.
					if (isStale()) return;
					windowRef.current = nextWindow;

					const loaded = transcriptMessagesToLogEntries(
						stripSynopsisTurns((result.messages ?? []) as TranscriptMessage[])
					);
					const older = selectOlderEntries(loaded, visible);

					if (older.length > 0) {
						// Prepend onto the tab's CURRENT logs, not the snapshot above: the
						// agent may have streamed new entries onto the tail during the read.
						updateSessionWith(sessionId, (s) => ({
							...s,
							aiTabs: s.aiTabs?.map((t) =>
								t.id === tabId ? { ...t, logs: [...older, ...t.logs] } : t
							),
						}));
						onPrependRef.current?.(older.length);
					}

					// `hasMore` is false once the window spans the whole file, so there is
					// nothing left to reach even when this page did prepend entries.
					if (!result.hasMore) {
						setReachedStart(true);
						return;
					}
					// Made progress: stop here and let the next scroll ask for more.
					if (older.length > 0) return;
					// Otherwise the window is still inside the visible transcript. Widen
					// again rather than handing back a "load" that changed nothing.
				}
			} catch (e) {
				if (isStale()) return;
				logger.warn('[useTranscriptBackfill] Failed to load earlier messages', undefined, e);
				setError('Could not load earlier messages');
			} finally {
				// A stale read must not clear the in-flight flag or the spinner that
				// belong to the request the CURRENT tab has running.
				if (!isStale()) {
					inFlightRef.current = false;
					setIsLoading(false);
				}
			}
		})();
	}, [reachedStart, tabId, agentSessionId, projectRoot, sessionId, toolType, sshRemoteId]);

	return { isLoading, reachedStart, error, loadEarlier };
}
