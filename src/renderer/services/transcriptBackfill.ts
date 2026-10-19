/**
 * transcriptBackfill - read a page of an AI tab's older history from disk and
 * prepend it to the tab (issue #1407).
 *
 * The page logic lives here once. `useTranscriptBackfill` runs it for the tab
 * on screen when the user scrolls to the top. A tab window cannot: its
 * transcript is its owner's, kept in step by patches that splice at an index,
 * so a page prepended there would shift every later splice (Tab Windows, D2).
 * It sends the `loadEarlierTranscript` intent instead, and its owner runs
 * {@link loadEarlierTranscriptForTab}; the next patch carries the page.
 *
 * Why the read window grows instead of tracking an offset, and why one load
 * may read more than once: see the header of `useTranscriptBackfill.ts`.
 */

import type { Session } from '../types';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { logger } from '../utils/logger';
import {
	TRANSCRIPT_RESUME_READ_LIMIT,
	selectOlderEntries,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../utils/transcriptMessages';
import { resolveSessionProjectPath } from '../components/AgentSessionsBrowser/utils/sessionProjectPath';

/** Provider messages pulled in per "load earlier" step. */
export const TRANSCRIPT_BACKFILL_PAGE = 250;

/**
 * How many times one load will widen its window while the reads keep coming
 * back entirely inside the visible transcript. Each step costs a full
 * transcript read, so this is a backstop against a pathological ratio of
 * tool-only messages, not the expected path: seeding from
 * `TRANSCRIPT_RESUME_READ_LIMIT` means the common case resolves on the first
 * read. Hitting the cap is not an error - the user simply gets the next page on
 * their next scroll instead.
 */
const MAX_WIDEN_STEPS_PER_LOAD = 8;

/** Where a tab's transcript lives on disk. */
export interface TranscriptBackfillTarget {
	sessionId: string;
	tabId: string;
	agentSessionId: string;
	toolType: Session['toolType'];
	projectRoot: string;
	sshRemoteId?: string;
}

export interface TranscriptBackfillHooks {
	/** True once the caller has moved on: results after that are dropped. */
	isStale?: () => boolean;
	/** The provider-message window each read covered, as it is read. */
	onWindow?: (window: number) => void;
	/** Entries just prepended, in the same tick as the store write. */
	onPrepend?: (count: number) => void;
}

/**
 * Read one page of older history and prepend what falls above the visible
 * transcript. Widens until it prepends something or reaches the start of the
 * file. Resolves to whether the tab now starts at the first message, or null
 * when `isStale` turned true mid-read. Rejects when a read fails.
 *
 * @param startWindow - The window the previous load ended on; null for a
 *                      tab's first load.
 */
export async function backfillTranscriptPage(
	target: TranscriptBackfillTarget,
	startWindow: number | null,
	hooks: TranscriptBackfillHooks = {}
): Promise<{ reachedStart: boolean } | null> {
	const { sessionId, tabId } = target;
	const isStale = hooks.isStale ?? (() => false);
	const tab = selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs?.find(
		(t) => t.id === tabId
	);
	const visible = tab?.logs ?? [];
	let readWindow = startWindow;

	for (let step = 0; step < MAX_WIDEN_STEPS_PER_LOAD; step++) {
		// Seed the first window from the depth the resume path actually read,
		// not from `visible.length`: the entry count is only a lower bound on the
		// messages it covers.
		const nextWindow =
			(readWindow ?? Math.max(visible.length, TRANSCRIPT_RESUME_READ_LIMIT)) +
			TRANSCRIPT_BACKFILL_PAGE;

		const result = await readTranscript(target, nextWindow);
		// The caller may have moved on while that read was outstanding. Anything
		// below this point would write into whatever it shows NOW.
		if (isStale()) return null;
		readWindow = nextWindow;
		hooks.onWindow?.(nextWindow);

		const loaded = transcriptMessagesToLogEntries(
			stripSynopsisTurns((result.messages ?? []) as TranscriptMessage[])
		);
		const older = selectOlderEntries(loaded, visible);

		if (older.length > 0) {
			// Prepend onto the tab's CURRENT logs, not the snapshot above: the
			// agent may have streamed new entries onto the tail during the read.
			updateSessionWith(sessionId, (s) => ({
				...s,
				aiTabs: s.aiTabs?.map((t) => (t.id === tabId ? { ...t, logs: [...older, ...t.logs] } : t)),
			}));
			hooks.onPrepend?.(older.length);
		}

		// `hasMore` is false once the window spans the whole file, so there is
		// nothing left to reach even when this page did prepend entries.
		if (!result.hasMore) return { reachedStart: true };
		// Made progress: stop here and let the next scroll ask for more.
		if (older.length > 0) return { reachedStart: false };
		// Otherwise the window is still inside the visible transcript. Widen
		// again rather than handing back a "load" that changed nothing.
	}
	return { reachedStart: false };
}

/** One read of the newest `limit` provider messages of the tab's transcript. */
function readTranscript(target: TranscriptBackfillTarget, limit: number) {
	return window.maestro.agentSessions.read(
		target.toolType || 'claude-code',
		target.projectRoot,
		target.agentSessionId,
		{ offset: 0, limit },
		target.sshRemoteId
	);
}

/** Where a tab's transcript lives, or null when it has none on disk yet. */
export function transcriptBackfillTarget(
	session: Session,
	tabId: string
): TranscriptBackfillTarget | null {
	const agentSessionId = session.aiTabs.find((t) => t.id === tabId)?.agentSessionId;
	// Same host and path the tab was resumed from (see handleResumeSession).
	const { projectPathForSessions: projectRoot, sshRemoteId } = resolveSessionProjectPath(session);
	if (!agentSessionId || !projectRoot) return null;
	return {
		sessionId: session.id,
		tabId,
		agentSessionId,
		toolType: session.toolType,
		projectRoot,
		sshRemoteId,
	};
}

/** Paging state per tab for {@link loadEarlierTranscriptForTab}. */
interface OwnerBackfillState {
	window: number | null;
	reachedStart: boolean;
	inFlight: boolean;
}

const ownerBackfill = new Map<string, OwnerBackfillState>();

/**
 * Load the next page of a popped tab's older history, in its owner window (the
 * `loadEarlierTranscript` intent). Keeps the same per-tab paging state the
 * hook keeps for a tab on screen: one load at a time, and none once the tab
 * starts at the first message. A failed read is logged, like the hook's; the
 * user's next scroll to the top asks again.
 */
export async function loadEarlierTranscriptForTab(sessionId: string, tabId: string): Promise<void> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const target = session ? transcriptBackfillTarget(session, tabId) : null;
	if (!target) return;
	// A new provider session on the tab starts over.
	const key = `${sessionId}\n${tabId}\n${target.agentSessionId}`;
	const state = ownerBackfill.get(key) ?? { window: null, reachedStart: false, inFlight: false };
	ownerBackfill.set(key, state);
	if (state.inFlight || state.reachedStart) return;
	state.inFlight = true;
	try {
		const result = await backfillTranscriptPage(target, state.window, {
			onWindow: (readWindow) => {
				state.window = readWindow;
			},
		});
		if (result?.reachedStart) state.reachedStart = true;
	} catch (error) {
		logger.warn('[transcriptBackfill] Failed to load earlier messages', undefined, error);
	} finally {
		state.inFlight = false;
	}
}

/** Test helper: forget every tab's paging state. */
export function resetTranscriptBackfillForTests(): void {
	ownerBackfill.clear();
}
