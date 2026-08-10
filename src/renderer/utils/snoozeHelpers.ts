// Snooze helpers for AI tabs.
//
// Snoozing hides a tab until a chosen moment, then brings it back with a
// notification - the email-snooze model, applied to conversations.
//
// The tab is physically removed from `session.aiTabs` and parked in
// `session.snoozedTabs`. That's deliberate: every consumer of the tab list
// (rendering, Cmd+1..9 navigation, cross-tab search, the thinking pill) then
// hides snoozed tabs for free, with no filtering to keep in sync. Snoozing is
// literally "close it, remember it, reopen it later", so these helpers delegate
// removal to closeTab() and restoration to the same position math that
// reopenUnifiedClosedTab() uses.

import {
	Session,
	AITab,
	SnoozedTabEntry,
	SnoozeHistoryEntry,
	SnoozeResolution,
	UnifiedTabRef,
} from '../types';
import { generateId } from './ids';
import { closeTab, getRepairedUnifiedTabOrder, ensureInUnifiedTabOrder } from './tabHelpers';

/** Result of snoozing a tab. */
export interface SnoozeTabResult {
	session: Session; // Session with the tab removed and the snooze recorded
	entry: SnoozedTabEntry; // The stored snooze
}

/** Result of waking a snoozed tab. */
export interface WakeSnoozedTabResult {
	session: Session; // Session with the tab restored and the snooze cleared
	entry: SnoozedTabEntry; // The snooze that fired (carries the note)
	tabId: string; // Tab to focus - the restored tab, or the existing duplicate
	/** True when an equivalent tab was already open, so nothing was restored. */
	wasDuplicate: boolean;
}

/** A snooze plus the session it belongs to, for the cross-agent list view. */
export interface SnoozedTabListItem {
	entry: SnoozedTabEntry;
	sessionId: string;
	sessionName: string;
}

/**
 * Snooze an AI tab until `wakeAt`.
 *
 * Delegates removal to {@link closeTab} so the surrounding behaviour matches
 * closing a tab exactly: the neighbouring tab is selected when the snoozed tab
 * was active, and snoozing an agent's only tab leaves a fresh empty tab behind
 * rather than an empty workspace. `skipHistory` keeps it out of the Cmd+Shift+T
 * undo stack - a snoozed tab isn't closed, and reopening it there would
 * duplicate the conversation that's already scheduled to return.
 *
 * @param session - Session owning the tab
 * @param tabId - AI tab to snooze
 * @param wakeAt - When the tab should come back (ms epoch)
 * @param note - Optional note-to-self shown in the wake notification
 * @param showUnreadOnly - Current unread-filter state (affects which tab is selected next)
 * @returns Updated session and the stored entry, or null if the tab doesn't exist
 */
export function snoozeTab(
	session: Session,
	tabId: string,
	wakeAt: number,
	note?: string,
	showUnreadOnly = false
): SnoozeTabResult | null {
	if (!session?.aiTabs?.length) return null;

	const tab = session.aiTabs.find((t) => t.id === tabId);
	if (!tab) return null;

	// Capture the visual position before closing so the tab wakes up where the
	// user left it rather than at the end of the strip.
	const unifiedIndex = getRepairedUnifiedTabOrder(session).findIndex(
		(ref) => ref.type === 'ai' && ref.id === tabId
	);

	// preserveTabScopedWork: a snoozed tab is hidden, not gone - it must not
	// cancel anything main is holding against it (e.g. an armed dispatch callback).
	const closed = closeTab(session, tabId, showUnreadOnly, {
		skipHistory: true,
		preserveTabScopedWork: true,
	});
	if (!closed) return null;

	const trimmedNote = note?.trim();
	const entry: SnoozedTabEntry = {
		id: generateId(),
		tab: { ...tab, state: 'idle', thinkingStartTime: undefined, agentError: undefined },
		unifiedIndex: unifiedIndex === -1 ? session.aiTabs.length : unifiedIndex,
		snoozedAt: Date.now(),
		wakeAt,
		...(trimmedNote ? { note: trimmedNote } : {}),
	};

	return {
		session: {
			...closed.session,
			snoozedTabs: [...(closed.session.snoozedTabs || []), entry],
		},
		entry,
	};
}

/**
 * Restore a snoozed tab to the tab bar and clear its snooze.
 *
 * Used by both the scheduled wake and the manual "Unsnooze now" action. The tab
 * keeps its original ID so deep links and any still-running agent process
 * re-attach cleanly.
 *
 * @param session - Session owning the snooze
 * @param snoozeId - Snooze entry to wake
 * @returns Updated session and the tab to focus, or null if the snooze is gone
 */
export function wakeSnoozedTab(session: Session, snoozeId: string): WakeSnoozedTabResult | null {
	const entry = session.snoozedTabs?.find((s) => s.id === snoozeId);
	if (!entry) return null;

	const remaining = (session.snoozedTabs || []).filter((s) => s.id !== snoozeId);

	// If an equivalent conversation is already open (the user reopened it from
	// history while it was snoozed), focus that instead of restoring a duplicate.
	const existing =
		session.aiTabs.find((t) => t.id === entry.tab.id) ??
		(entry.tab.agentSessionId
			? session.aiTabs.find((t) => t.agentSessionId === entry.tab.agentSessionId)
			: undefined);

	if (existing) {
		return {
			session: {
				...session,
				snoozedTabs: remaining,
				activeTabId: existing.id,
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
				unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder || [], 'ai', existing.id),
			},
			entry,
			tabId: existing.id,
			wasDuplicate: true,
		};
	}

	const restoredTab: AITab = { ...entry.tab, state: 'idle', hasUnread: true };

	// Translate the saved unified position into an aiTabs insertion index by
	// counting how many AI tabs precede it (same math as reopenUnifiedClosedTab).
	const order = session.unifiedTabOrder || [];
	const targetUnifiedIndex = Math.max(0, Math.min(entry.unifiedIndex, order.length));
	let aiTabsBefore = 0;
	for (let i = 0; i < targetUnifiedIndex; i++) {
		if (order[i].type === 'ai') aiTabsBefore++;
	}
	const insertIndex = Math.min(aiTabsBefore, session.aiTabs.length);

	const tabRef: UnifiedTabRef = { type: 'ai', id: restoredTab.id };

	return {
		session: {
			...session,
			snoozedTabs: remaining,
			aiTabs: [
				...session.aiTabs.slice(0, insertIndex),
				restoredTab,
				...session.aiTabs.slice(insertIndex),
			],
			unifiedTabOrder: [
				...order.slice(0, targetUnifiedIndex),
				tabRef,
				...order.slice(targetUnifiedIndex),
			],
		},
		entry,
		tabId: restoredTab.id,
		wasDuplicate: false,
	};
}

/**
 * Drop a snooze without restoring its tab - the user no longer cares about it.
 * The conversation itself is untouched on disk; only Maestro's tab is discarded.
 *
 * @param session - Session owning the snooze
 * @param snoozeId - Snooze entry to discard
 * @returns Updated session (unchanged if the snooze wasn't found)
 */
export function removeSnoozedTab(session: Session, snoozeId: string): Session {
	const snoozedTabs = session.snoozedTabs || [];
	if (!snoozedTabs.some((s) => s.id === snoozeId)) return session;
	return { ...session, snoozedTabs: snoozedTabs.filter((s) => s.id !== snoozeId) };
}

/**
 * Reschedule a snooze (and optionally rewrite its note).
 *
 * Passing `note` as undefined leaves the existing note alone; passing an empty
 * string clears it.
 *
 * @param session - Session owning the snooze
 * @param snoozeId - Snooze entry to update
 * @param wakeAt - New wake time (ms epoch)
 * @param note - New note, or undefined to keep the current one
 * @returns Updated session (unchanged if the snooze wasn't found)
 */
export function updateSnoozedTab(
	session: Session,
	snoozeId: string,
	wakeAt: number,
	note?: string
): Session {
	const snoozedTabs = session.snoozedTabs || [];
	if (!snoozedTabs.some((s) => s.id === snoozeId)) return session;

	return {
		...session,
		snoozedTabs: snoozedTabs.map((entry) => {
			if (entry.id !== snoozeId) return entry;
			const trimmed = note?.trim();
			const next: SnoozedTabEntry = { ...entry, wakeAt };
			if (note !== undefined) {
				if (trimmed) next.note = trimmed;
				else delete next.note;
			}
			return next;
		}),
	};
}

/**
 * Snoozes that are due to wake at `now`.
 * Includes overdue entries, so wakes missed while the app was closed still fire
 * on next launch instead of being silently dropped.
 */
export function getDueSnoozes(session: Session, now: number = Date.now()): SnoozedTabEntry[] {
	return (session.snoozedTabs || []).filter((entry) => entry.wakeAt <= now);
}

/**
 * Flatten every agent's snoozes into one list for the "Snoozed Tabs" modal,
 * soonest wake first.
 */
export function collectSnoozedTabs(sessions: Session[]): SnoozedTabListItem[] {
	const items: SnoozedTabListItem[] = [];
	for (const session of sessions) {
		for (const entry of session.snoozedTabs || []) {
			items.push({ entry, sessionId: session.id, sessionName: session.name });
		}
	}
	return items.sort((a, b) => a.entry.wakeAt - b.entry.wakeAt);
}

/**
 * Build the history record for a snooze that just ended.
 *
 * Shared by all three resolution paths (scheduled wake, manual unsnooze,
 * dismiss) so the log reads consistently no matter how the snooze finished.
 * Snapshots the label and agent name as they are now, since the tab may be
 * closed or renamed by the time anyone reads the history.
 */
export function buildSnoozeHistoryRecord(
	entry: SnoozedTabEntry,
	resolution: SnoozeResolution,
	session: Session | null | undefined,
	tabId?: string
): Omit<SnoozeHistoryEntry, 'id'> {
	return {
		label: getSnoozedTabLabel(entry),
		sessionId: session?.id ?? '',
		sessionName: session?.name ?? '',
		tabId: tabId ?? entry.tab.id,
		...(entry.note ? { note: entry.note } : {}),
		snoozedAt: entry.snoozedAt,
		wakeAt: entry.wakeAt,
		resolvedAt: Date.now(),
		resolution,
	};
}

/**
 * Display label for a snoozed tab: the user's tab name, else the first line of
 * the conversation, else the agent session's short ID.
 */
export function getSnoozedTabLabel(entry: SnoozedTabEntry): string {
	const { tab } = entry;
	if (tab.name) return tab.name;

	const firstUserLog = tab.logs?.find((log) => log.source === 'user' && log.text?.trim());
	if (firstUserLog?.text) {
		const firstLine = firstUserLog.text.trim().split('\n')[0];
		return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
	}

	return tab.agentSessionId ? tab.agentSessionId.slice(0, 8) : 'Untitled tab';
}
