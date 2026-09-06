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
	SnoozeContent,
	SnoozeHistoryEntry,
	SnoozeResolution,
	SnoozedGroupEntry,
	SnoozedGroupMember,
	TabGroup,
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
import {
	collectLeafTabRefs,
	countLeaves,
	removeLeafByTabRef,
	rebalanceLayout,
	resolveTabRefTitle,
} from './panelLayout';

/**
 * The SINGLE-tab kinds a snooze can hold.
 *
 * `group` is deliberately excluded: a parked group is not one tab, it is a
 * layout plus its members, and it travels through its own entry points
 * ({@link snoozeTabGroup} / {@link wakeSnoozedTabGroup}) rather than a fifth
 * branch in every per-kind switch here.
 */
export type SnoozableTabKind = Exclude<SnoozedTabEntry['type'], 'group'>;

/** Narrow a snooze entry to the group variant. */
export function isSnoozedGroup(entry: SnoozedTabEntry): entry is SnoozedGroupEntry {
	return entry.type === 'group';
}

/**
 * The stored form of a snooze's free text.
 *
 * Blank is not a value here: an all-whitespace note or prompt is the user
 * having typed nothing, and storing it would put an empty italic line under the
 * row and dispatch an empty turn on wake. Trimmed-to-nothing fields are dropped
 * so `entry.note` / `entry.wakePrompt` read as plain "is there one?" tests
 * everywhere downstream.
 */
function snoozeContentFields(content?: SnoozeContent): SnoozeContent {
	const note = content?.note?.trim();
	const wakePrompt = content?.wakePrompt?.trim();
	return {
		...(note ? { note } : {}),
		...(wakePrompt ? { wakePrompt } : {}),
	};
}

/**
 * Whether this snooze has somewhere to send a wake prompt.
 *
 * Only a conversation can be prompted, so a parked file, terminal, or browser
 * tab answers false and the dialog hides the field rather than collecting a
 * prompt that could never run. A group qualifies on holding one AI pane.
 *
 * Answers the same question `resolveWakePromptTabId` does, but ahead of time
 * and without a wake to resolve against - that one needs to know which panes
 * actually came back.
 */
export function canSnoozeRunWakePrompt(entry: SnoozedTabEntry): boolean {
	return isSnoozedGroup(entry)
		? entry.members.some((member) => member.type === 'ai')
		: entry.type === 'ai';
}

/**
 * Every AI tab a snooze is holding: one for an `ai` entry, each AI pane for a
 * group, none for the other kinds.
 *
 * Exists because "which conversations does this snooze own?" is asked at both
 * ends of a snooze's life - the transcript mirror takes a copy of each when the
 * snooze starts and releases each when it ends - and answering it per caller is
 * how a group's panes ended up mirrored on the way in and never released.
 */
export function collectSnoozedAiTabs(entry: SnoozedTabEntry): AITab[] {
	if (isSnoozedGroup(entry)) {
		return entry.members.filter((member) => member.type === 'ai').map((member) => member.tab);
	}
	return entry.type === 'ai' ? [entry.tab] : [];
}

/** What the snooze dialog needs to know about the thing it is about to park. */
export interface SnoozeTarget {
	/** Tab or GROUP id, passed straight back to `snoozeTab`, which resolves both. */
	tabId: string;
	/** Header label, so the user can see what they are snoozing. */
	tabLabel: string;
	/** Whether to offer the wake-prompt field. See {@link canSnoozeRunWakePrompt}. */
	canRunWakePrompt: boolean;
}

/**
 * Resolve the id a snooze opener was handed into what the dialog should show.
 *
 * Every entry point is handed ONE id and no kind: the tab strip passes whatever
 * chip was right-clicked (any of the four kinds, or a tiled group), while the
 * shortcut and the palette pass the active AI tab. Resolving the kind here
 * rather than at each opener is what keeps the dialog's wake-prompt field
 * honest - a hard-coded `canRunWakePrompt: true` beside a value derived from
 * the tab is exactly the pair that drifts.
 *
 * The unified order is the only place that knows an id's kind, which is the
 * same lookup `snoozeTab` itself does, so an id this resolves is an id that
 * will park.
 *
 * @returns null when the id names nothing in this session, letting an opener
 *   skip a dialog whose confirm could not commit.
 */
export function resolveSnoozeTarget(
	session: Session | null | undefined,
	id: string
): SnoozeTarget | null {
	if (!session) return null;

	// A group is not in aiTabs and not a tab, but it IS snoozable, so it is
	// checked first - its layout decides whether a prompt can run.
	const group = session.tabGroups?.find((g) => g.id === id);
	if (group) {
		const paneRefs = collectLeafTabRefs(group.layout);
		return {
			tabId: id,
			tabLabel: clampLabel(group.name) || 'Tab group',
			canRunWakePrompt: paneRefs.some((ref) => ref.type === 'ai'),
		};
	}

	const ref = getRepairedUnifiedTabOrder(session).find((entry) => entry.id === id);
	if (!ref) return null;

	return {
		tabId: id,
		tabLabel: resolveTabRefTitle(session, ref),
		canRunWakePrompt: ref.type === 'ai',
	};
}

/**
 * The AI tab a snooze's wake prompt should be dispatched into, or null when
 * there is nothing to dispatch.
 *
 * Only a conversation can be prompted, so a parked file, terminal, or browser
 * tab resolves to null however the entry was written. A group resolves to its
 * first surviving AI pane in leaf order: the layout's focused pane is stored as
 * a pane id rather than a tab id, and a group whose focus was on a file pane
 * would otherwise have nowhere to send a prompt the user did ask for.
 *
 * @param entry - The snooze that just resolved
 * @param restoredTabId - Tab id the wake actually landed on (which is the
 *   pre-existing duplicate, not `entry.tab.id`, when one was already open)
 * @param isMemberRestored - For a group, whether that pane came back at all
 */
export function resolveWakePromptTabId(
	entry: SnoozedTabEntry,
	restoredTabId: string,
	isMemberRestored: (member: SnoozedGroupMember) => boolean = () => true
): string | null {
	if (!entry.wakePrompt?.trim()) return null;
	if (isSnoozedGroup(entry)) {
		const pane = entry.members.find((member) => member.type === 'ai' && isMemberRestored(member));
		return pane ? pane.tab.id : null;
	}
	return entry.type === 'ai' ? restoredTabId : null;
}

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
		case 'group':
			// A group's identity is its own id - the layout and membership can both
			// have changed underneath without making it a different group.
			return session.tabGroups?.find((g) => g.id === entry.group.id);
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
 * @param content - Optional note-to-self and wake prompt
 * @param showUnreadOnly - Current unread-filter state (affects which tab is selected next)
 * @returns Updated session and the stored entry, or null if the tab doesn't exist
 */
export function snoozeTab(
	session: Session,
	tabId: string,
	wakeAt: number,
	content?: SnoozeContent,
	showUnreadOnly = false
): SnoozeTabResult | null {
	if (!session) return null;

	// The unified order is the only place that knows a tab id's KIND, so resolve
	// it there first rather than probing four arrays in a fixed guess order.
	const order = getRepairedUnifiedTabOrder(session);
	const unifiedIndex = order.findIndex((ref) => ref.id === tabId);
	if (unifiedIndex === -1) return null;
	// A tiled group is not a tab. It parks through snoozeTabGroup(), which has to
	// carry a layout tree and every member; refusing here keeps the per-kind
	// switch below honest instead of growing a fifth branch that cannot share it.
	if (order[unifiedIndex].type === 'group') return null;
	const kind = order[unifiedIndex].type as SnoozableTabKind;

	const common = {
		id: generateId(),
		unifiedIndex,
		snoozedAt: Date.now(),
		wakeAt,
		...snoozeContentFields(content),
	};

	let closedSession: Session;
	let entry: SnoozedTabEntry;

	switch (kind) {
		case 'ai': {
			const tab = session.aiTabs?.find((t) => t.id === tabId);
			if (!tab) return null;
			// preserveTabScopedWork: a snoozed tab is hidden, not gone - it must not
			// cancel anything main is holding against it (e.g. an armed dispatch
			// callback). rc-only; main has no such flag, so the merge must re-add it.
			const closed = closeTab(session, tabId, showUnreadOnly, {
				skipHistory: true,
				preserveTabScopedWork: true,
			});
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
	// A group rebuilds a layout, not a tab. Callers that do not care which kind
	// they woke should call wakeSnooze(); this one stays single-tab so the
	// per-kind switches below never have to answer for a group.
	if (isSnoozedGroup(entry)) return null;

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

	// A kind this switch has not been taught leaves `tabsPatch` unassigned, and
	// spreading undefined is a silent no-op: the snooze would be cleared while
	// the tab it holds is never restored, destroying the transcript. Refuse
	// instead, so the snooze survives to be woken by a build that knows the kind.
	if (!tabsPatch) return null;

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
 * Reschedule a snooze (and optionally rewrite its note and wake prompt).
 *
 * Each field of `content` is read independently: omitting one leaves the
 * snooze's existing value alone, and passing an empty string clears it. The
 * reschedule dialog always sends both fields, so an emptied box really does
 * remove what was there.
 *
 * @param session - Session owning the snooze
 * @param snoozeId - Snooze entry to update
 * @param wakeAt - New wake time (ms epoch)
 * @param content - New note / wake prompt, per field
 * @returns Updated session (unchanged if the snooze wasn't found)
 */
export function updateSnoozedTab(
	session: Session,
	snoozeId: string,
	wakeAt: number,
	content?: SnoozeContent
): Session {
	const snoozedTabs = session.snoozedTabs || [];
	if (!snoozedTabs.some((s) => s.id === snoozeId)) return session;

	const trimmed = snoozeContentFields(content);

	return {
		...session,
		snoozedTabs: snoozedTabs.map((entry) => {
			if (entry.id !== snoozeId) return entry;
			const next: SnoozedTabEntry = { ...entry, wakeAt };
			if (content?.note !== undefined) {
				if (trimmed.note) next.note = trimmed.note;
				else delete next.note;
			}
			if (content?.wakePrompt !== undefined) {
				if (trimmed.wakePrompt) next.wakePrompt = trimmed.wakePrompt;
				else delete next.wakePrompt;
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
 * A snooze parked before the kind tag existed.
 *
 * The first snooze implementation could only park AI tabs, so it wrote no
 * `type` field at all. Every per-kind switch added since falls through for
 * those entries.
 */
function isUntaggedSnooze(entry: SnoozedTabEntry): boolean {
	return !entry.type;
}

/**
 * Tag snoozes written before {@link SnoozedTabEntry} carried a `type`.
 *
 * Left untagged, a legacy entry is invisible to every kind switch: the Snoozed
 * Tabs list draws the generic fallback glyph with a BLANK label, the Usage
 * Dashboard leaves its tokens out of the breakdown, and - worst - the wake path
 * builds no tabs patch, so the snooze is cleared while the AI tab and its whole
 * transcript are dropped on the floor. The payload was always an AITab, so
 * stamping `'ai'` at load is the entire fix.
 *
 * Runs on restore rather than in a one-shot disk migration because a session
 * can also arrive from the CLI or the web bridge; normalizing where sessions
 * enter the store covers every path, and it is idempotent.
 */
export function migrateLegacySnoozedTabs(session: Session): Session {
	const entries = session.snoozedTabs;
	if (!entries?.length || !entries.some(isUntaggedSnooze)) return session;
	return {
		...session,
		snoozedTabs: entries.map((entry) =>
			isUntaggedSnooze(entry) ? ({ ...entry, type: 'ai' } as SnoozedTabEntry) : entry
		),
	};
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
		// A group has no single tab id; its own id is the stable handle.
		tabId: tabId ?? (isSnoozedGroup(entry) ? entry.group.id : entry.tab.id),
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
		case 'group':
			return clampLabel(entry.group.name) || 'Tab group';
	}
}

// ---------------------------------------------------------------------------
// Tiled groups
//
// A parked group is a layout plus its members, not a tab, so it gets its own
// pair of entry points rather than a fifth branch inside the per-kind switches
// above. That keeps this half independent of the single-tab half, which is
// still growing.
// ---------------------------------------------------------------------------

/** Result of parking a whole tiled group. */
export interface SnoozeTabGroupResult {
	session: Session;
	entry: SnoozedGroupEntry;
}

/** Result of waking a parked group. */
export interface WakeSnoozedTabGroupResult {
	session: Session;
	entry: SnoozedGroupEntry;
	groupId: string;
	/** Members that could not be restored, already dropped from the layout. */
	droppedMembers: SnoozedGroupMember[];
	/** True when a group with this id was already open, so nothing was restored. */
	wasDuplicate: boolean;
}

/** Pull one pane's tab out of the session, parked for restore. */
function captureGroupMember(session: Session, ref: UnifiedTabRef): SnoozedGroupMember | null {
	switch (ref.type) {
		case 'ai': {
			const tab = session.aiTabs?.find((t) => t.id === ref.id);
			// Park it idle - a pane mid-turn must not come back still thinking.
			return tab
				? {
						type: 'ai',
						tab: { ...tab, state: 'idle', thinkingStartTime: undefined, agentError: undefined },
					}
				: null;
		}
		case 'file': {
			const tab = session.filePreviewTabs?.find((t) => t.id === ref.id);
			return tab ? { type: 'file', tab } : null;
		}
		case 'browser': {
			const tab = session.browserTabs?.find((t) => t.id === ref.id);
			return tab ? { type: 'browser', tab } : null;
		}
		case 'terminal': {
			const tab = session.terminalTabs?.find((t) => t.id === ref.id);
			// The PTY dies with the pane. Keep the shell's identity, drop the
			// process - waking spawns a fresh shell in the same place.
			return tab
				? { type: 'terminal', tab: { ...tab, pid: 0, state: 'idle', exitCode: undefined } }
				: null;
		}
		default:
			// Groups do not nest, so a group ref inside a layout is not a member.
			return null;
	}
}

/** Remove one pane's tab from the session, using that kind's own close path. */
function closeGroupMember(session: Session, ref: UnifiedTabRef): Session {
	switch (ref.type) {
		case 'ai': {
			const closed = closeTab(session, ref.id, false, {
				skipHistory: true,
				preserveTabScopedWork: true,
			});
			return closed?.session ?? session;
		}
		case 'file':
			return closeFileTab(session, ref.id)?.session ?? session;
		case 'browser':
			return closeBrowserTab(session, ref.id)?.session ?? session;
		case 'terminal':
			return closeTerminalTab(session, ref.id);
		default:
			return session;
	}
}

/**
 * Park a whole tiled group until `wakeAt`.
 *
 * The entry carries the whole {@link TabGroup} - layout tree and focused pane -
 * so the wake replays the arrangement verbatim instead of re-deriving it from a
 * member list. Members are captured in the tree's own leaf order.
 */
export function snoozeTabGroup(
	session: Session,
	groupId: string,
	wakeAt: number,
	content?: SnoozeContent
): SnoozeTabGroupResult | null {
	if (!session) return null;
	const group = session.tabGroups?.find((g) => g.id === groupId);
	if (!group) return null;

	const order = getRepairedUnifiedTabOrder(session);
	const unifiedIndex = order.findIndex((ref) => ref.type === 'group' && ref.id === groupId);

	const refs = collectLeafTabRefs(group.layout);
	const members = refs
		.map((ref) => captureGroupMember(session, ref))
		.filter((m): m is SnoozedGroupMember => m !== null);
	// A group whose panes have all vanished is not worth parking.
	if (members.length === 0) return null;

	let next = session;
	for (const ref of refs) next = closeGroupMember(next, ref);

	const entry: SnoozedGroupEntry = {
		type: 'group',
		group,
		members,
		id: generateId(),
		unifiedIndex: unifiedIndex === -1 ? (session.unifiedTabOrder?.length ?? 0) : unifiedIndex,
		snoozedAt: Date.now(),
		wakeAt,
		...snoozeContentFields(content),
	};

	return {
		session: {
			...next,
			tabGroups: (next.tabGroups || []).filter((g) => g.id !== groupId),
			unifiedTabOrder: (next.unifiedTabOrder || []).filter(
				(ref) => !(ref.type === 'group' && ref.id === groupId)
			),
			activeGroupId: next.activeGroupId === groupId ? null : next.activeGroupId,
			snoozedTabs: [...(next.snoozedTabs || []), entry],
		},
		entry,
	};
}

/**
 * Bring a parked group back, layout intact.
 *
 * A member that can no longer be restored - a file whose path is gone - is
 * DROPPED rather than restored as a dead placeholder: its leaf comes out of the
 * tree and the remaining splits are re-balanced. A group that returns with
 * three panes instead of four is a better artifact than one with a pane the
 * user cannot interact with. The caller is handed what was dropped so it can
 * say so once, rather than the user discovering it.
 */
export function wakeSnoozedTabGroup(
	session: Session,
	snoozeId: string,
	isMemberRestorable: (member: SnoozedGroupMember) => boolean = () => true
): WakeSnoozedTabGroupResult | null {
	const found = session.snoozedTabs?.find((s) => s.id === snoozeId);
	if (!found || !isSnoozedGroup(found)) return null;
	const entry = found;
	const remaining = (session.snoozedTabs || []).filter((s) => s.id !== snoozeId);

	// Already open? Focus it rather than restoring a second copy.
	const existingGroup = session.tabGroups?.find((g) => g.id === entry.group.id);
	if (existingGroup) {
		return {
			session: { ...session, snoozedTabs: remaining, activeGroupId: existingGroup.id },
			entry,
			groupId: existingGroup.id,
			droppedMembers: [],
			wasDuplicate: true,
		};
	}

	const keep: SnoozedGroupMember[] = [];
	const droppedMembers: SnoozedGroupMember[] = [];
	for (const member of entry.members) {
		(isMemberRestorable(member) ? keep : droppedMembers).push(member);
	}

	// Every pane gone means there is no layout left to restore.
	if (keep.length === 0) {
		return {
			session: { ...session, snoozedTabs: remaining },
			entry,
			groupId: entry.group.id,
			droppedMembers,
			wasDuplicate: false,
		};
	}

	// Drop the dead panes out of the tree, then re-balance what is left so the
	// survivors share the space instead of inheriting a hole.
	let layout = entry.group.layout;
	for (const member of droppedMembers) {
		const pruned = removeLeafByTabRef(layout, { type: member.type, id: member.tab.id });
		if (pruned) layout = pruned;
	}
	if (droppedMembers.length > 0) layout = rebalanceLayout(layout);

	// The focused pane may have been one of the casualties.
	const survivingRefs = collectLeafTabRefs(layout);
	const focusStillThere =
		entry.group.focusedPaneId != null && countLeaves(layout) > 0 && survivingRefs.length > 0;

	// Sort survivors back into their own arrays. `as never` on the push is the
	// price of a discriminated union walked in a loop: the element type is
	// correct per branch, TypeScript just cannot see it across the index.
	const restored = {
		ai: [] as Session['aiTabs'],
		file: [] as NonNullable<Session['filePreviewTabs']>,
		browser: [] as NonNullable<Session['browserTabs']>,
		terminal: [] as NonNullable<Session['terminalTabs']>,
	};
	for (const member of keep) {
		restored[member.type].push(member.tab as never);
	}

	const group: TabGroup = {
		...entry.group,
		layout,
		focusedPaneId: focusStillThere ? entry.group.focusedPaneId : null,
	};

	const nextOrder = [...(session.unifiedTabOrder || [])];
	const at = Math.min(Math.max(entry.unifiedIndex, 0), nextOrder.length);
	nextOrder.splice(at, 0, { type: 'group', id: group.id });

	return {
		session: {
			...session,
			aiTabs: [...(session.aiTabs || []), ...restored.ai],
			filePreviewTabs: [...(session.filePreviewTabs || []), ...restored.file],
			browserTabs: [...(session.browserTabs || []), ...restored.browser],
			terminalTabs: [...(session.terminalTabs || []), ...restored.terminal],
			tabGroups: [...(session.tabGroups || []), group],
			unifiedTabOrder: nextOrder,
			activeGroupId: group.id,
			snoozedTabs: remaining,
		},
		entry,
		groupId: group.id,
		droppedMembers,
		wasDuplicate: false,
	};
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
