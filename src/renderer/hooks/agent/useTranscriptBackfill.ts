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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AITab, Session } from '../../types';
import { selectSessionById, updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';
import {
	selectOlderEntries,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../../utils/transcriptMessages';

/** Provider messages pulled in per "load earlier" step. */
export const TRANSCRIPT_BACKFILL_PAGE = 250;

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

	const onPrependRef = useRef(options.onPrepend);
	onPrependRef.current = options.onPrepend;

	// The transcript is remounted per tab today, but reset explicitly so a future
	// caller that keeps this hook alive across tabs cannot page one tab's window
	// against another tab's transcript.
	useEffect(() => {
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

		void (async () => {
			try {
				const tab = selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs?.find(
					(t) => t.id === tabId
				);
				const visible = tab?.logs ?? [];
				const nextWindow = (windowRef.current ?? visible.length) + TRANSCRIPT_BACKFILL_PAGE;

				const result = await window.maestro.agentSessions.read(
					toolType || 'claude-code',
					projectRoot,
					agentSessionId,
					{ offset: 0, limit: nextWindow },
					sshRemoteId
				);
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
				if (!result.hasMore) setReachedStart(true);
			} catch (e) {
				logger.warn('[useTranscriptBackfill] Failed to load earlier messages', undefined, e);
				setError('Could not load earlier messages');
			} finally {
				inFlightRef.current = false;
				setIsLoading(false);
			}
		})();
	}, [reachedStart, tabId, agentSessionId, projectRoot, sessionId, toolType, sshRemoteId]);

	return { isLoading, reachedStart, error, loadEarlier };
}
