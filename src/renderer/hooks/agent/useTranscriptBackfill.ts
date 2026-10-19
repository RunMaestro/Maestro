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
import { logger } from '../../utils/logger';
import { isTabWindow } from '../../utils/runtimeContext';
import {
	TRANSCRIPT_BACKFILL_PAGE,
	backfillTranscriptPage,
} from '../../services/transcriptBackfill';
import { resolveSessionProjectPath } from '../../components/AgentSessionsBrowser/utils/sessionProjectPath';

// The page logic lives in services/transcriptBackfill.ts, shared with a tab
// window's owner (which loads a popped tab's history for it).
export { TRANSCRIPT_BACKFILL_PAGE };

/**
 * How long a tab window waits before asking its owner for another page. The
 * owner runs one load per tab at a time and the next patch carries the page;
 * this only keeps a user parked at the top from sending a request per scroll
 * event.
 */
export const TAB_WINDOW_BACKFILL_REQUEST_INTERVAL_MS = 1500;

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
	// Same host and path the tab was resumed from (see handleResumeSession).
	const { projectPathForSessions: projectRoot, sshRemoteId } = resolveSessionProjectPath(session);
	const toolType = session.toolType;
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

	// When this tab window last asked its owner for a page.
	const lastOwnerRequestRef = useRef(0);

	const loadEarlier = useCallback(() => {
		if (inFlightRef.current || reachedStart) return;
		if (!tabId || !agentSessionId || !projectRoot) return;
		// A tab window's transcript is its owner's, kept in step by patches that
		// splice it at an index (Tab Windows, D2). A page prepended here would
		// shift every later splice, so the owner loads it (the
		// `loadEarlierTranscript` intent) and the next patch carries it.
		if (isTabWindow()) {
			const now = Date.now();
			if (now - lastOwnerRequestRef.current < TAB_WINDOW_BACKFILL_REQUEST_INTERVAL_MS) return;
			lastOwnerRequestRef.current = now;
			window.maestro?.tabWindows?.sendIntent({
				kind: 'loadEarlierTranscript',
				agentId: sessionId,
				tabRef: { type: 'ai', id: tabId },
			});
			return;
		}

		inFlightRef.current = true;
		setIsLoading(true);
		setError(null);

		const generation = generationRef.current;
		const isStale = () => generationRef.current !== generation;

		void (async () => {
			try {
				const result = await backfillTranscriptPage(
					{ sessionId, tabId, agentSessionId, toolType, projectRoot, sshRemoteId },
					windowRef.current,
					{
						isStale,
						onWindow: (readWindow) => {
							windowRef.current = readWindow;
						},
						onPrepend: (count) => onPrependRef.current?.(count),
					}
				);
				if (result?.reachedStart) setReachedStart(true);
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
