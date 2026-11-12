/**
 * The four single-snooze operations, with everything that has to happen around
 * them.
 *
 * Parking a tab is never just the store write. Each verb drags a fixed sequence
 * behind it, and getting one step wrong is invisible until months later:
 *
 * - **park**: capture the session BEFORE the write (the parked tabs leave it,
 *   taking their `agentSessionId`s with them), then mirror the transcripts. A
 *   snooze can outlive the provider's retention, so the moment a tab is put
 *   away is the loss boundary.
 * - **wake / dismiss**: release the mirror (which rehydrates first, restoring a
 *   transcript the provider aged out) and record the resolution, or the note
 *   the user wrote dies with the entry.
 *
 * Those sequences were written out per call site, and a fourth caller
 * (`maestro-cli snooze`) would have been a fourth copy. They live here instead
 * so a snooze driven from the CLI is indistinguishable from a clicked one.
 *
 * Every function resolves the session and entry from the LIVE store rather than
 * taking them as arguments: the remote path has no render snapshot to read
 * from, and a stale one is how a wake ends up releasing the wrong mirror.
 */

import type { SnoozeContent, SnoozedTabEntry, SnoozeHistoryEntry, Session } from '../types';
import type {
	SnoozeCommandRequest,
	SnoozeCommandResult,
	SnoozeHistorySummary,
} from '../../shared/snoozeCommands';
import { readBackgroundField } from '../../shared/focusPlacement';
import { useSessionStore } from '../stores/sessionStore';
import { useTabStore } from '../stores/tabStore';
import { recordSnoozeResolution, useSnoozeHistoryStore } from '../stores/snoozeHistoryStore';
import { notifyToast } from '../stores/notificationStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import {
	buildSnoozeHistoryRecord,
	collectSnoozedTabs,
	getSnoozedTabLabel,
	toSnoozedTabSummary,
} from '../utils/snoozeHelpers';
import { mirrorSnoozedTranscript, releaseSnoozedTranscript } from '../utils/snoozeTranscriptMirror';
import { formatSnoozeTarget } from '../../shared/snooze';

/** Look up a session and one of its snoozes as they are right now. */
function readSnooze(
	sessionId: string,
	snoozeId: string
): { session: Session; entry: SnoozedTabEntry } | null {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const entry = session?.snoozedTabs?.find((s) => s.id === snoozeId);
	return session && entry ? { session, entry } : null;
}

/**
 * Park a tab (or tiled group) until `wakeAt`.
 *
 * @param sessionId Agent owning the tab. Omit for the active agent, which is
 *   what every click path means.
 * @param announce Raise the center-flash ack. The click paths do; a scripted
 *   snooze passes `false` when it does not want to interrupt the human.
 * @returns The stored entry, or null when the id names no tab or group.
 */
export function snoozeTabWithMirror(
	tabId: string,
	wakeAt: number,
	content?: SnoozeContent,
	options?: { sessionId?: string; showUnreadOnly?: boolean; announce?: boolean }
): SnoozedTabEntry | null {
	// Read BEFORE the write: the snooze removes the parked tabs from the
	// session, so afterwards there is nothing left to resolve a transcript from.
	const { sessions, activeSessionId } = useSessionStore.getState();
	const targetId = options?.sessionId ?? activeSessionId;
	const sessionBefore = sessions.find((s) => s.id === targetId) ?? null;

	const entry = useTabStore
		.getState()
		.snoozeTab(tabId, wakeAt, content, options?.showUnreadOnly ?? false, options?.sessionId);
	if (!entry) return null;

	// A no-op for the kinds that have no transcript (file, terminal, browser).
	mirrorSnoozedTranscript(sessionBefore, entry);

	if (options?.announce !== false) {
		notifyCenterFlash({ message: `Snoozed until ${formatSnoozeTarget(wakeAt)}`, color: 'theme' });
	}
	return entry;
}

/** What a wake produced, for a caller that has to report or navigate to it. */
export interface WakeSnoozeOutcome {
	entry: SnoozedTabEntry;
	/** Tab to focus - the restored tab, or the duplicate that was already open. */
	tabId: string;
	wasDuplicate: boolean;
}

/**
 * Bring a snoozed tab back right now, ahead of its wake time.
 *
 * Recorded as `unsnoozed` rather than `woke`: the user pulled this back early,
 * which reads very differently in the history from one that came due.
 */
export function wakeSnoozeNow(sessionId: string, snoozeId: string): WakeSnoozeOutcome | null {
	const found = readSnooze(sessionId, snoozeId);
	const result = useTabStore.getState().unsnoozeTab(sessionId, snoozeId);
	if (!result) return null;

	if (found) {
		// Rehydrates before releasing, so a transcript the provider aged out
		// during the snooze is restored rather than lost.
		releaseSnoozedTranscript(found.session, found.entry);
		recordSnoozeResolution(
			buildSnoozeHistoryRecord(found.entry, 'unsnoozed', found.session, result.tabId)
		);
	}
	return { entry: result.entry, tabId: result.tabId, wasDuplicate: result.wasDuplicate };
}

/**
 * Discard a snooze without bringing its tab back.
 *
 * @param announce Raise the "snooze dismissed" toast. The click path does.
 * @returns The entry that was dropped, or null when the id names no snooze.
 */
export function dismissSnoozeNow(
	sessionId: string,
	snoozeId: string,
	options?: { announce?: boolean }
): SnoozedTabEntry | null {
	const found = readSnooze(sessionId, snoozeId);
	if (!found) return null;

	useTabStore.getState().dismissSnoozedTab(sessionId, snoozeId);

	// Dismiss discards Maestro's tab, not the conversation - rehydrate the
	// provider file before releasing so it stays reachable from the Session
	// Explorer, as the docs promise.
	releaseSnoozedTranscript(found.session, found.entry);
	recordSnoozeResolution(buildSnoozeHistoryRecord(found.entry, 'dismissed', found.session));

	if (options?.announce !== false) {
		notifyToast({
			color: 'theme',
			title: 'Snooze dismissed',
			message: `"${getSnoozedTabLabel(found.entry)}" won't come back.`,
		});
	}
	return found.entry;
}

/**
 * Move a snooze to a new time, optionally rewriting its note or wake prompt.
 *
 * Each field of `content` that is present rewrites its value (empty string
 * clears it); an omitted field is left alone. Nothing is mirrored or released
 * here - the tab stays parked, so its transcript copy stays held.
 *
 * @returns The updated entry, or null when the id names no snooze.
 */
export function rescheduleSnoozeNow(
	sessionId: string,
	snoozeId: string,
	wakeAt: number,
	content?: SnoozeContent
): SnoozedTabEntry | null {
	if (!readSnooze(sessionId, snoozeId)) return null;
	useTabStore.getState().rescheduleSnoozedTab(sessionId, snoozeId, wakeAt, content);
	return readSnooze(sessionId, snoozeId)?.entry ?? null;
}

/** Name of the agent a snooze belongs to, for a summary built outside a render. */
function agentNameFor(sessionId: string): string {
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.name ?? '';
}

/**
 * Run one `maestro-cli snooze` verb.
 *
 * The renderer is where snooze state actually lives, so this is the far end of
 * the `snooze_command` round trip. It answers rather than throws for every
 * outcome including a target that does not exist: the caller is a CLI process
 * reporting to a human, and "no snooze with that id" is an answer, not a crash.
 *
 * Deliberately synchronous. Every verb is a store read or a store write, and
 * the IPC reply has a timeout on the other side - awaiting anything here would
 * put a window between the write and the ack in which the caller is told
 * nothing.
 */
export function runRemoteSnoozeCommand(request: SnoozeCommandRequest): SnoozeCommandResult {
	const { action, sessionId, targetId } = request;
	// Present-but-empty means "clear this field" on a reschedule, so the two are
	// only folded into a content object when at least one was actually sent.
	const content: SnoozeContent | undefined =
		request.note === undefined && request.wakePrompt === undefined
			? undefined
			: {
					...(request.note !== undefined ? { note: request.note } : {}),
					...(request.wakePrompt !== undefined ? { wakePrompt: request.wakePrompt } : {}),
				};
	// `--background` suppresses the notice only. The parked tab leaving the strip
	// is the verb, not placement.
	const announce = !readBackgroundField(request);

	if (action === 'list') {
		const sessions = useSessionStore.getState().sessions;
		const scoped = sessionId ? sessions.filter((s) => s.id === sessionId) : sessions;
		return {
			success: true,
			snoozes: collectSnoozedTabs(scoped).map((item) =>
				toSnoozedTabSummary(item.entry, item.sessionId, item.sessionName)
			),
		};
	}

	if (action === 'history') {
		const entries = useSnoozeHistoryStore.getState().entries;
		const scoped = request.limit === undefined ? entries : entries.slice(0, request.limit);
		return { success: true, history: scoped.map(toSnoozeHistorySummary) };
	}

	// Everything below writes, and every write names both ids. The main process
	// already refuses a request missing either, but this is also reachable from a
	// browser client on a different build, and a write addressed to `undefined`
	// would silently park or drop the wrong thing.
	if (!sessionId || !targetId) {
		return { success: false, error: `snooze ${action} requires an agent and a target id` };
	}

	switch (action) {
		case 'snooze': {
			if (request.wakeAt === undefined) {
				return { success: false, error: 'snooze requires a wake time' };
			}
			const entry = snoozeTabWithMirror(targetId, request.wakeAt, content, {
				sessionId,
				announce,
			});
			if (!entry) return { success: false, error: `No tab or tab group with id ${targetId}` };
			return {
				success: true,
				snooze: toSnoozedTabSummary(entry, sessionId, agentNameFor(sessionId)),
			};
		}

		case 'wake': {
			// Snapshot BEFORE the wake: the entry leaves `snoozedTabs` as part of it,
			// so afterwards there is nothing left to describe in the reply.
			const before = readSnooze(sessionId, targetId);
			if (!before) return { success: false, error: `No snooze with id ${targetId}` };
			const summary = toSnoozedTabSummary(before.entry, sessionId, before.session.name);
			const result = wakeSnoozeNow(sessionId, targetId);
			if (!result) return { success: false, error: `Could not restore snooze ${targetId}` };
			return {
				success: true,
				snooze: summary,
				tabId: result.tabId,
				...(result.wasDuplicate ? { wasDuplicate: true } : {}),
			};
		}

		case 'dismiss': {
			const before = readSnooze(sessionId, targetId);
			if (!before) return { success: false, error: `No snooze with id ${targetId}` };
			const summary = toSnoozedTabSummary(before.entry, sessionId, before.session.name);
			dismissSnoozeNow(sessionId, targetId, { announce });
			return { success: true, snooze: summary };
		}

		case 'reschedule': {
			if (request.wakeAt === undefined) {
				return { success: false, error: 'snooze reschedule requires a wake time' };
			}
			const entry = rescheduleSnoozeNow(sessionId, targetId, request.wakeAt, content);
			if (!entry) return { success: false, error: `No snooze with id ${targetId}` };
			return {
				success: true,
				snooze: toSnoozedTabSummary(entry, sessionId, agentNameFor(sessionId)),
			};
		}
	}
}

/** Flatten one resolved snooze for the wire. */
function toSnoozeHistorySummary(entry: SnoozeHistoryEntry): SnoozeHistorySummary {
	return {
		id: entry.id,
		label: entry.label,
		agentId: entry.sessionId,
		agentName: entry.sessionName,
		tabId: entry.tabId,
		...(entry.note ? { note: entry.note } : {}),
		snoozedAt: entry.snoozedAt,
		wakeAt: entry.wakeAt,
		resolvedAt: entry.resolvedAt,
		resolution: entry.resolution,
	};
}
