/**
 * useSnoozeScheduler - brings snoozed AI tabs back when their time arrives.
 *
 * Mounted once from App.tsx. Sweeps every session for due snoozes, restores
 * those tabs, and fires a sticky (must-dismiss) notification carrying the
 * user's note.
 *
 * Two properties worth keeping:
 *  - The first sweep runs on mount, and `getDueSnoozes` treats overdue entries
 *    as due, so a wake that came and went while Maestro was closed still fires
 *    on next launch instead of being silently dropped.
 *  - All due wakes across all agents are applied in ONE setSessions call, so a
 *    batch of simultaneous wakes costs a single re-render and a single
 *    persistence write rather than N of each.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { notifyToast } from '../../stores/notificationStore';
import { useEventListener } from '../utils/useEventListener';
import {
	wakeSnoozedTab,
	wakeSnoozedTabGroup,
	isSnoozeRestorable,
	isSnoozedGroup,
	getDueSnoozes,
	getSnoozedTabLabel,
	buildSnoozeHistoryRecord,
} from '../../utils/snoozeHelpers';
import { recordSnoozeResolution } from '../../stores/snoozeHistoryStore';
import { releaseSnoozedTranscript } from '../../utils/snoozeTranscriptMirror';
import { logger } from '../../utils/logger';
import type { Session, SnoozedTabEntry } from '../../types';

/** How often to check for due snoozes. */
const SWEEP_INTERVAL_MS = 15_000;

/** A wake that happened, pending its notification. */
interface PendingWake {
	sessionId: string;
	sessionName: string;
	tabId: string;
	label: string;
	note?: string;
	wakeAt: number;
	/** Session and entry as they were at wake time, for releasing the mirror. */
	session: Session;
	entry: SnoozedTabEntry;
}

export function useSnoozeScheduler(): void {
	// Snooze IDs already woken this run. Guards against a sweep firing while a
	// prior setSessions is still in flight, which would double-notify.
	const wokenRef = useRef<Set<string>>(new Set());

	const sweep = useCallback(async () => {
		const now = Date.now();
		const { sessions, setSessions } = useSessionStore.getState();

		// Nothing due? Bail before touching the store at all - this runs every
		// 15s for the entire life of the app.
		const hasDue = sessions.some((session) =>
			getDueSnoozes(session, now).some((entry) => !wokenRef.current.has(entry.id))
		);
		if (!hasDue) return;

		// A file can be deleted while its tab sleeps. Checking that touches the
		// filesystem, and the reducer below has to stay synchronous, so resolve
		// every due entry's restorability FIRST and hand the reducer a plain set.
		// Keyed by tab id, which is unique across kinds.
		const unrestorable = new Set<string>();
		await Promise.all(
			sessions.flatMap((session) =>
				getDueSnoozes(session, now)
					.filter((entry) => !wokenRef.current.has(entry.id))
					.flatMap((entry) =>
						isSnoozedGroup(entry)
							? entry.members.map(async (member) => {
									if (!(await isSnoozeRestorable({ ...member, ...entry } as SnoozedTabEntry))) {
										unrestorable.add(member.tab.id);
									}
								})
							: [
									(async () => {
										if (!(await isSnoozeRestorable(entry))) unrestorable.add(entry.tab.id);
									})(),
								]
					)
			)
		);

		const pending: PendingWake[] = [];
		/** Entries dropped entirely because the one thing they held is gone. */
		const dropped: PendingWake[] = [];

		setSessions((prev: Session[]) =>
			prev.map((session) => {
				const due = getDueSnoozes(session, now).filter((entry) => !wokenRef.current.has(entry.id));
				if (due.length === 0) return session;

				// Apply each due wake in turn, threading the session through so
				// several tabs waking at once all land correctly.
				let next = session;
				for (const entry of due) {
					wokenRef.current.add(entry.id);
					const common = {
						sessionId: session.id,
						sessionName: session.name,
						label: getSnoozedTabLabel(entry),
						note: entry.note,
						wakeAt: entry.wakeAt,
						session,
						entry,
					};

					// A group rebuilds a layout rather than restoring one tab, so it
					// takes the group entry point. Panes whose file has gone are
					// dropped and the split rebalances around the survivors.
					if (isSnoozedGroup(entry)) {
						const result = wakeSnoozedTabGroup(
							next,
							entry.id,
							(member) => !unrestorable.has(member.tab.id)
						);
						if (!result) continue;
						next = result.session;
						(result.droppedMembers.length === entry.members.length ? dropped : pending).push({
							...common,
							tabId: result.groupId,
						});
						continue;
					}

					// A single tab whose file is gone is not restored at all: a tab
					// pointing at nothing is worse than a notification saying so.
					if (!isSnoozedGroup(entry) && unrestorable.has(entry.tab.id)) {
						next = {
							...next,
							snoozedTabs: (next.snoozedTabs || []).filter((s) => s.id !== entry.id),
						};
						dropped.push({ ...common, tabId: entry.tab.id });
						continue;
					}

					const result = wakeSnoozedTab(next, entry.id);
					if (!result) continue;
					next = result.session;
					pending.push({ ...common, tabId: result.tabId });
				}
				return next;
			})
		);

		for (const wake of pending) {
			const wasOverdue = now - wake.wakeAt > SWEEP_INTERVAL_MS * 2;
			logger.info(
				`[snooze] woke tab ${wake.tabId} in session ${wake.sessionId}${
					wasOverdue ? ' (overdue - fired late after app restart)' : ''
				}`
			);

			// The tab is back, so the snooze no longer needs to hold its transcript
			// mirror. This rehydrates first, restoring the conversation if the
			// provider aged it out while the tab was away.
			releaseSnoozedTranscript(wake.session, wake.entry);

			// Log the completed snooze so the note outlives the notification.
			recordSnoozeResolution(
				buildSnoozeHistoryRecord(wake.entry, 'woke', wake.session, wake.tabId)
			);

			notifyToast({
				color: 'theme',
				title: wake.label,
				// The note is the whole point of the feature when present; fall back
				// to a plain statement of what happened when it isn't.
				message: wake.note || 'Snoozed tab is back.',
				project: wake.sessionName,
				tabName: wake.label,
				// Sticky: a reminder the user never sees is a reminder that failed.
				dismissible: true,
				sessionId: wake.sessionId,
				tabId: wake.tabId,
				clickAction: { kind: 'jump-session', sessionId: wake.sessionId, tabId: wake.tabId },
			});
		}

		// A snooze that came due but had nothing left to restore still has to be
		// reported. Silently dropping it would look like the reminder never fired.
		for (const wake of dropped) {
			logger.info(`[snooze] dropped ${wake.tabId} in session ${wake.sessionId} - file is gone`);
			recordSnoozeResolution(
				buildSnoozeHistoryRecord(wake.entry, 'woke', wake.session, wake.tabId)
			);
			notifyToast({
				color: 'orange',
				title: wake.label,
				message: wake.note
					? `${wake.note} (the file is no longer there, so nothing was reopened)`
					: 'This snooze came due, but the file is no longer there.',
				project: wake.sessionName,
				dismissible: true,
				sessionId: wake.sessionId,
			});
		}
	}, []);

	useEffect(() => {
		// Immediate sweep catches wakes missed while the app was closed. The sweep
		// is async now (it stats files before restoring them); nothing awaits it,
		// and a failure inside it must not become an unhandled rejection.
		void sweep();
		const timer = window.setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [sweep]);

	// The interval stalls while the machine is asleep, so re-sweep whenever the
	// window regains focus - otherwise a wake due overnight waits for the next
	// tick after wake-from-sleep.
	useEventListener('focus', () => void sweep());
}
