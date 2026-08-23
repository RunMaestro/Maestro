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
	LogEntry,
	SnoozedTabEntry,
	SnoozeHistoryEntry,
	SnoozeResolution,
	UnifiedTabRef,
} from '../types';
import { generateId } from './ids';
import {
	closeTab,
	closeFileTab,
	closeBrowserTab,
	getRepairedUnifiedTabOrder,
	ensureInUnifiedTabOrder,
	aiTabFocusFields,
	fileTabFocusFields,
	browserTabFocusFields,
	terminalTabFocusFields,
} from './tabHelpers';
import { closeTerminalTab } from './terminalTabHelpers';

/** The tab kinds a snooze can hold - the tag on {@link SnoozedTabEntry}. */
export type SnoozableTabKind = SnoozedTabEntry['type'];

/**
 * Session patch that lands on a restored tab of any kind.
 *
 * Every kind has its own precedence rules (a terminal needs `inputMode`
 * flipped; a file tab needs the browser selection cleared), and each is already
 * solved by a dedicated helper in tabHelpers. This just picks the right one, so
 * the wake path never hand-rolls the field set and can't miss one.
 */
function focusFieldsForKind(kind: SnoozableTabKind, tabId: string): Partial<Session> {
	switch (kind) {
		case 'ai':
			return aiTabFocusFields(tabId);
		case 'file':
			return fileTabFocusFields(tabId);
		case 'browser':
			return browserTabFocusFields(tabId);
		case 'terminal':
			return terminalTabFocusFields(tabId);
	}
}

/**
 * Whether an already-open tab is the same thing as a snoozed one.
 *
 * Waking must not create a duplicate when the user reopened the same thing
 * while it slept, and "the same thing" means something different per kind:
 * an AI tab is identified by its provider session, a file by its path on a
 * given host, a browser tab by its URL, a terminal by its working directory.
 * Falling back to tab id alone (the old behaviour) only catches the case where
 * the very same tab object came back.
 */
function isSameSnoozedTab(entry: SnoozedTabEntry, session: Session): { id: string } | undefined {
	switch (entry.type) {
		case 'ai': {
			const byId = session.aiTabs.find((t) => t.id === entry.tab.id);
			if (byId) return byId;
			return entry.tab.agentSessionId
				? session.aiTabs.find((t) => t.agentSessionId === entry.tab.agentSessionId)
				: undefined;
		}
		case 'file': {
			const tabs = session.filePreviewTabs || [];
			return (
				tabs.find((t) => t.id === entry.tab.id) ??
				// Same path on the same host. A path is only unique per machine, so
				// an SSH tab and a local tab on the same path are different files.
				tabs.find((t) => t.path === entry.tab.path && t.sshRemoteId === entry.tab.sshRemoteId)
			);
		}
		case 'browser': {
			const tabs = session.browserTabs || [];
			return tabs.find((t) => t.id === entry.tab.id) ?? tabs.find((t) => t.url === entry.tab.url);
		}
		case 'terminal': {
			const tabs = session.terminalTabs || [];
			return tabs.find((t) => t.id === entry.tab.id) ?? tabs.find((t) => t.cwd === entry.tab.cwd);
		}
	}
}

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
	if (!session) return null;

	// The unified order is the only place that knows a tab id's KIND, so resolve
	// it there first rather than probing four arrays in a fixed guess order.
	const order = getRepairedUnifiedTabOrder(session);
	const unifiedIndex = order.findIndex((ref) => ref.id === tabId);
	if (unifiedIndex === -1) return null;
	const kind = order[unifiedIndex].type as SnoozableTabKind;

	const trimmedNote = note?.trim();
	const common = {
		id: generateId(),
		unifiedIndex,
		snoozedAt: Date.now(),
		wakeAt,
		...(trimmedNote ? { note: trimmedNote } : {}),
	};

	let closedSession: Session;
	let entry: SnoozedTabEntry;

	switch (kind) {
		case 'ai': {
			const tab = session.aiTabs?.find((t) => t.id === tabId);
			if (!tab) return null;
			const closed = closeTab(session, tabId, showUnreadOnly, { skipHistory: true });
			if (!closed) return null;
			closedSession = closed.session;
			entry = {
				type: 'ai',
				// Park it idle: a tab that was mid-turn when it was snoozed must not
				// come back still claiming to be thinking.
				tab: { ...tab, state: 'idle', thinkingStartTime: undefined, agentError: undefined },
				...common,
			};
			break;
		}
		case 'file': {
			const tab = session.filePreviewTabs?.find((t) => t.id === tabId);
			if (!tab) return null;
			const closed = closeFileTab(session, tabId);
			if (!closed) return null;
			closedSession = closed.session;
			entry = { type: 'file', tab, ...common };
			break;
		}
		case 'browser': {
			const tab = session.browserTabs?.find((t) => t.id === tabId);
			if (!tab) return null;
			const closed = closeBrowserTab(session, tabId);
			if (!closed) return null;
			closedSession = closed.session;
			entry = { type: 'browser', tab, ...common };
			break;
		}
		case 'terminal': {
			const tab = session.terminalTabs?.find((t) => t.id === tabId);
			if (!tab) return null;
			closedSession = closeTerminalTab(session, tabId);
			// The PTY dies with the tab and is not coming back. Park the shell's
			// identity (cwd, name, shell) and nothing about the live process, so
			// waking spawns a fresh shell in the same place rather than restoring a
			// tab that points at a pid which no longer exists.
			entry = {
				type: 'terminal',
				tab: { ...tab, pid: 0, state: 'idle', exitCode: undefined },
				...common,
			};
			break;
		}
	}

	return {
		session: {
			...closedSession,
			snoozedTabs: [...(closedSession.snoozedTabs || []), entry],
		},
		entry,
	};
}

/**
 * Build the "back from snooze" transcript card for a returning tab.
 *
 * The wake notification is transient - it auto-dismisses or gets clicked away,
 * taking the note-to-self with it. This entry is the durable record: it marks
 * the gap in the conversation and keeps the note where the conversation is, so
 * weeks later the tab still explains why it's open.
 */
function buildSnoozeReturnLog(entry: SnoozedTabEntry, resolution: 'woke' | 'unsnoozed'): LogEntry {
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		// Plain-text fallback. This is what cross-tab search matches on, so the
		// note goes in the text too: searching the reminder should find the tab it
		// belongs to.
		text: entry.note ? `Back from snooze: ${entry.note}` : 'Back from snooze',
		snoozeReturn: {
			...(entry.note ? { note: entry.note } : {}),
			snoozedAt: entry.snoozedAt,
			wakeAt: entry.wakeAt,
			resolution,
		},
	};
}

/**
 * Restore a snoozed tab to the tab bar and clear its snooze.
 *
 * Used by both the scheduled wake and the manual "Unsnooze now" action. The tab
 * keeps its original ID so deep links and any still-running agent process
 * re-attach cleanly. Either way the returning tab gets a "back from snooze"
 * card appended to its transcript, so the gap (and the note) is visible in the
 * conversation itself rather than only in a toast.
 *
 * @param session - Session owning the snooze
 * @param snoozeId - Snooze entry to wake
 * @param resolution - How it came back: on schedule, or pulled back early
 * @returns Updated session and the tab to focus, or null if the snooze is gone
 */
export function wakeSnoozedTab(
	session: Session,
	snoozeId: string,
	resolution: 'woke' | 'unsnoozed' = 'woke'
): WakeSnoozedTabResult | null {
	const entry = session.snoozedTabs?.find((s) => s.id === snoozeId);
	if (!entry) return null;

	const remaining = (session.snoozedTabs || []).filter((s) => s.id !== snoozeId);

	// If the same thing is already open (the user reopened it while it slept),
	// focus that instead of restoring a duplicate. What counts as "the same
	// thing" is per-kind - see isSameSnoozedTab.
	const existing = isSameSnoozedTab(entry, session);

	if (existing) {
		return {
			session: {
				...session,
				snoozedTabs: remaining,
				// The snooze still resolved here, so the card and the unread flag
				// belong on the tab the user actually lands on - not lost with the
				// discarded duplicate. Only AI tabs have a transcript to mark; the
				// other kinds just get focused.
				...(entry.type === 'ai'
					? {
							aiTabs: session.aiTabs.map((t) =>
								t.id === existing.id
									? {
											...t,
											hasUnread: true,
											logs: [...t.logs, buildSnoozeReturnLog(entry, resolution)],
										}
									: t
							),
						}
					: {}),
				...focusFieldsForKind(entry.type, existing.id),
				unifiedTabOrder: ensureInUnifiedTabOrder(
					session.unifiedTabOrder || [],
					entry.type,
					existing.id
				),
			},
			entry,
			tabId: existing.id,
			wasDuplicate: true,
		};
	}

	// Translate the saved unified position into an insertion index for the tab's
	// OWN array, by counting how many tabs of that kind precede it (same math as
	// reopenUnifiedClosedTab, generalized past 'ai').
	const order = session.unifiedTabOrder || [];
	const targetUnifiedIndex = Math.max(0, Math.min(entry.unifiedIndex, order.length));
	let sameKindBefore = 0;
	for (let i = 0; i < targetUnifiedIndex; i++) {
		if (order[i].type === entry.type) sameKindBefore++;
	}

	const insertAt = <T>(list: T[], item: T): T[] => {
		const at = Math.min(sameKindBefore, list.length);
		return [...list.slice(0, at), item, ...list.slice(at)];
	};

	// Per-kind restore. Only AI tabs carry a transcript, so only they get the
	// "back from snooze" card and the unread flag - the other kinds have nowhere
	// to put one and nothing to mark as unread.
	let tabsPatch: Partial<Session>;
	switch (entry.type) {
		case 'ai':
			tabsPatch = {
				aiTabs: insertAt(session.aiTabs || [], {
					...entry.tab,
					state: 'idle',
					hasUnread: true,
					logs: [...entry.tab.logs, buildSnoozeReturnLog(entry, resolution)],
				} satisfies AITab),
			};
			break;
		case 'file':
			tabsPatch = { filePreviewTabs: insertAt(session.filePreviewTabs || [], entry.tab) };
			break;
		case 'browser':
			tabsPatch = { browserTabs: insertAt(session.browserTabs || [], entry.tab) };
			break;
		case 'terminal':
			// pid 0 / idle is what tells the terminal host to spawn a fresh shell at
			// this tab's cwd. The snoozed PTY is long gone; the layout is what came
			// back.
			tabsPatch = {
				terminalTabs: insertAt(session.terminalTabs || [], {
					...entry.tab,
					pid: 0,
					state: 'idle',
					exitCode: undefined,
				}),
			};
			break;
	}

	const tabRef: UnifiedTabRef = { type: entry.type, id: entry.tab.id };

	return {
		session: {
			...session,
			snoozedTabs: remaining,
			...tabsPatch,
			unifiedTabOrder: [
				...order.slice(0, targetUnifiedIndex),
				tabRef,
				...order.slice(targetUnifiedIndex),
			],
		},
		entry,
		tabId: entry.tab.id,
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

/** Trim a label to something that fits a list row. */
function clampLabel(text: string): string {
	const firstLine = text.trim().split('\n')[0];
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

/**
 * Display label for a snoozed tab.
 *
 * Each kind names itself differently, and the fallbacks matter because the list
 * is read weeks later: an AI tab falls back to its opening message, a browser
 * tab to its URL, a terminal to its working directory. "Untitled tab" is the
 * last resort, not the second one.
 */
export function getSnoozedTabLabel(entry: SnoozedTabEntry): string {
	switch (entry.type) {
		case 'ai': {
			if (entry.tab.name) return entry.tab.name;
			const firstUserLog = entry.tab.logs?.find((log) => log.source === 'user' && log.text?.trim());
			if (firstUserLog?.text) return clampLabel(firstUserLog.text);
			return entry.tab.agentSessionId ? entry.tab.agentSessionId.slice(0, 8) : 'Untitled tab';
		}
		case 'file':
			return clampLabel(`${entry.tab.name}${entry.tab.extension}`) || 'Untitled file';
		case 'browser':
			return clampLabel(entry.tab.customTitle || entry.tab.title || entry.tab.url) || 'Browser tab';
		case 'terminal':
			return entry.tab.name || clampLabel(entry.tab.cwd) || 'Terminal';
	}
}

/**
 * Whether a snoozed tab can still be restored.
 *
 * Only a FILE snooze can become unrestorable: a file can be deleted, renamed,
 * or moved while the tab sleeps, and restoring it would produce a tab pointing
 * at nothing - an empty preview the user has to work out for themselves. Every
 * other kind restores from state it carries, so it is always restorable.
 *
 * Deliberately a standalone predicate rather than a branch inside the wake
 * path: waking is otherwise pure and synchronous, and this is the one piece
 * that has to touch the filesystem. Keeping it separate means the wake logic
 * stays testable without mocking fs, and callers that restore several tabs at
 * once (a tiled group) can run the checks concurrently and decide what to do
 * with the failures themselves.
 *
 * `fs.stat` is SSH-aware, so a file on a remote is checked on that remote
 * rather than being reported missing because it is absent locally.
 */
export async function isSnoozeRestorable(entry: SnoozedTabEntry): Promise<boolean> {
	if (entry.type !== 'file') return true;
	try {
		const stat = await window.maestro.fs.stat(entry.tab.path, entry.tab.sshRemoteId);
		return !!stat?.isFile;
	} catch {
		// A failed check is not proof the file is gone - the remote could be
		// unreachable. Restore the tab and let the preview report the real error,
		// rather than silently discarding a snooze the user asked for.
		return true;
	}
}
