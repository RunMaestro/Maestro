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

	const sweep = useCallback(() => {
		const now = Date.now();
		const { sessions, setSessions } = useSessionStore.getState();

		// Nothing due? Bail before touching the store at all - this runs every
		// 15s for the entire life of the app.
		const hasDue = sessions.some((session) =>
			getDueSnoozes(session, now).some((entry) => !wokenRef.current.has(entry.id))
		);
		if (!hasDue) return;

		const pending: PendingWake[] = [];

		setSessions((prev: Session[]) =>
			prev.map((session) => {
				const due = getDueSnoozes(session, now).filter((entry) => !wokenRef.current.has(entry.id));
				if (due.length === 0) return session;

				// Apply each due wake in turn, threading the session through so
				// several tabs waking at once all land correctly.
				let next = session;
				for (const entry of due) {
					wokenRef.current.add(entry.id);
					const result = wakeSnoozedTab(next, entry.id);
					if (!result) continue;
					next = result.session;
					pending.push({
						sessionId: session.id,
						sessionName: session.name,
						tabId: result.tabId,
						label: getSnoozedTabLabel(entry),
						note: entry.note,
						wakeAt: entry.wakeAt,
						session,
						entry,
					});
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
	}, []);

	useEffect(() => {
		// Immediate sweep catches wakes missed while the app was closed.
		sweep();
		const timer = window.setInterval(sweep, SWEEP_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [sweep]);

	// The interval stalls while the machine is asleep, so re-sweep whenever the
	// window regains focus - otherwise a wake due overnight waits for the next
	// tick after wake-from-sleep.
	useEventListener('focus', sweep);
}
