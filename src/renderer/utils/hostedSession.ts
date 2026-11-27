/**
 * A hosted agent IS its Left Bar record. The record keeps everything an SSH agent has (cwd, SSH
 * remote, file tabs, browser tabs, terminal), so it renders through the same Main Window and Right
 * Bar as any agent. The only thing that differs is where its AI turns run: on the Federation host.
 *
 * `projectHostedSession()` folds what the host reports into that record: its AI tabs (name, star,
 * provider session, busy state), each tab's transcript (the persisted tail the mirror read, plus
 * the live entries of a turn still running), and the messages waiting in the host's queue. The
 * record then draws exactly like a local agent's, and the local copy stays current, so a Move Back
 * from Host has every conversation.
 *
 * Rules, so nothing is lost and nothing runs twice:
 * - Tabs match by id (a lift keeps tab ids). A host tab this record lacks is appended, unless it
 *   was just closed here and the host has not caught up (`closing`). A tab the host reported in
 *   this hosting (`hostSeenAt`) and no longer lists was closed on the host: it goes here too. A
 *   local tab the host never reported stays (a conversation kept from before the move), idle.
 * - A transcript is merged, never replaced: local entries the host's read window does not hold
 *   stay, in time order among the host's. Live entries carry `hostLive` and are rebuilt on every
 *   sync.
 * - Host queue items carry `hostQueued`: drawn as queued cards, never run by a local drain.
 *
 * Pure. Returns the same `session` reference when nothing changed.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import type { LiveTurn } from '../../shared/maestro-lib/client/live-turn';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { QueuedTurn } from '../../shared/maestro-lib/client/types';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import type { AgentError } from '../../shared/types';
import type { AITab, LogEntry, QueuedItem, Session, UnifiedTabRef } from '../types';
import { mirrorLogEntry, mirrorQueuedItem, mirrorTab, mirrorUsageStats } from './peerMirrorView';
import { isAiTabHidden } from './unifiedTabOrderUtils';
import { normalizeTabGroups } from './panelLayout';
import { closeTab } from './tabHelpers';

/** One tab's transcript as the mirror holds it (`MirrorTranscriptSlot`, the fields read here). */
export interface HostedTranscript {
	entries: LogEntryRecord[];
	loaded: boolean;
	carryover?: LogEntryRecord[];
}

export interface HostedProjectionInput {
	/** The host's record of the agent. */
	agent: AgentRecord;
	/** By `liveTurnKey(agentId, tabId)`. */
	transcripts?: Readonly<Record<string, HostedTranscript>>;
	/** By `liveTurnKey(agentId, tabId)`. */
	liveTurns?: Readonly<Record<string, LiveTurn>>;
	/** What waits in the host's queue for this agent. */
	queue?: readonly QueuedTurn[];
	/** This record is the agent the window shows now (the unread rule reads it). */
	viewing?: boolean;
	/** Tabs closed here whose close the host has not reported yet: never drawn back. */
	closing?: ReadonlySet<string>;
	/**
	 * The link to the host is down (a confirmed outage of its remote, or a connection the mirror gave
	 * up). The mirror keeps the host's last report through a disconnect, so a turn it last reported
	 * running would draw Thinking forever. Each such tab is drawn ended instead, with this error and
	 * a note in its transcript, as an SSH tab whose link is cut mid-turn. The next connected report
	 * draws the host's real state again, and the error clears (`source: 'host-link'`).
	 */
	linkLost?: AgentError;
	/** Tabs whose turn was stopped here while the host could not be told: drawn idle until it can. */
	endedHere?: ReadonlySet<string>;
	/**
	 * Tabs whose cut turn's message is kept for a resend (`hostedCutsKept()`): drawn ended like any
	 * cut tab, with no link note and no link error, because the auto-retry card and its error stand
	 * for the cut, as they do for an SSH turn whose link is cut.
	 */
	keptCuts?: ReadonlySet<string>;
}

/**
 * The transcript note a tab gets when the link to its host is lost mid-turn. Keyed on the cut: the
 * tab and the message whose turn it ended, so the loss moving from "connection lost" to "outage
 * confirmed" (or the same turn cut again) rewords one note instead of adding another. A note this
 * cut already drew keeps its id (the error keeps its timestamp for one loss), so a transcript that
 * lands during the loss, with the turn's message in it, does not add a second note.
 */
export function hostLinkNoteId(
	tabId: string,
	logs: readonly LogEntry[],
	error: AgentError
): string {
	const prefix = `host-link-${tabId}-`;
	const drawn = logs.find(
		(entry) =>
			entry.id.startsWith(prefix) &&
			entry.agentError?.source === 'host-link' &&
			entry.agentError.timestamp === error.timestamp
	);
	if (drawn) return drawn.id;
	for (let i = logs.length - 1; i >= 0; i -= 1) {
		// A kept message's bubble never reached the host: the cut turn answers the one before it.
		if (logs[i].source === 'user' && !logs[i].keptForHost) return `${prefix}${logs[i].id}`;
	}
	return `${prefix}${error.timestamp}`;
}

/**
 * `logs` with the link note last: after the turn's live entries, where an SSH tab's error lands.
 * The same array back when it is already there with the same words, so the projection settles.
 */
function withLinkNote(logs: LogEntry[], prior: readonly LogEntry[], note: LogEntry): LogEntry[] {
	const last = logs[logs.length - 1];
	if (last?.id === note.id && last.text === note.text) return logs;
	const next = [...logs.filter((entry) => entry.id !== note.id), note];
	return sameEntries(next, prior) ? (prior as LogEntry[]) : next;
}

/**
 * Whether two transcripts draw the same: the same entries in the same order, each with the same
 * text, tool card, and delivered tick (the fields a pass of `mergeHostedLogs()` can move on).
 */
function sameEntries(a: readonly LogEntry[], b: readonly LogEntry[]): boolean {
	if (!sameIds(a, b)) return false;
	return a.every(
		(entry, i) =>
			entry === b[i] ||
			(entry.text === b[i].text &&
				!!entry.delivered === !!b[i].delivered &&
				sameMetadata(entry.metadata, b[i].metadata))
	);
}

const persistedViews = new WeakMap<readonly LogEntryRecord[], LogEntry[]>();

function persistedView(entries: readonly LogEntryRecord[]): LogEntry[] {
	let view = persistedViews.get(entries);
	if (!view) {
		view = entries.map(mirrorLogEntry);
		persistedViews.set(entries, view);
	}
	return view;
}

function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false;
	return true;
}

/**
 * Two transcripts as one, in time order; each keeps its own order and a tie goes to `local`. A
 * local entry older than the host's read window lands ahead of it, and one written here during
 * the conversation (a wizard's flattened turns, a system note) lands where it happened, as it
 * does in a local agent's tab.
 */
function byTime(local: readonly LogEntry[], host: readonly LogEntry[]): LogEntry[] {
	if (local.length === 0) return [...host];
	if (host.length === 0) return [...local];
	const out: LogEntry[] = [];
	let i = 0;
	let j = 0;
	while (i < local.length && j < host.length) {
		if (local[i].timestamp <= host[j].timestamp) out.push(local[i++]);
		else out.push(host[j++]);
	}
	while (i < local.length) out.push(local[i++]);
	while (j < host.length) out.push(host[j++]);
	return out;
}

/** Sources of an agent's answer text. */
const ANSWER_SOURCES = new Set<LogEntry['source']>(['stdout', 'ai']);

/**
 * The host's user entries with "Message delivered" set by the rule a local tab follows: a local
 * send marks its message delivered when the agent's answer reaches the tab as data
 * (`markDelivered()`), which the main process emits when the provider reports its result, at the
 * end of the turn (partial text streams as thinking, which marks nothing). The host records
 * `delivered` when its turn starts and streams partial text as live entries; here the tick waits
 * for the answer the host recorded when the turn ended (a persisted answer entry after the
 * message, before the next one). Only entries in `fromHost` are judged; one written here keeps its
 * own flag. An entry whose flag is already right is kept as is.
 */
function withAnswerDelivery(entries: LogEntry[], fromHost: ReadonlySet<string>): LogEntry[] {
	let out: LogEntry[] | undefined;
	let pendingUser = -1;
	let answered = false;
	const settle = () => {
		if (pendingUser === -1) return;
		const entry = entries[pendingUser];
		if (fromHost.has(entry.id) && !!entry.delivered !== answered) {
			out ??= [...entries];
			out[pendingUser] = { ...entry, delivered: answered };
		}
	};
	entries.forEach((entry, i) => {
		if (entry.source === 'user') {
			settle();
			pendingUser = i;
			answered = false;
		} else if (ANSWER_SOURCES.has(entry.source) && !entry.hostLive) {
			answered = true;
		}
	});
	settle();
	return out ?? entries;
}

/** Whether two entries carry the same tool card data. */
function sameMetadata(a: LogEntry['metadata'], b: LogEntry['metadata']): boolean {
	return a === b || canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * `older` without the bubbles of kept messages (`LogEntry.keptForHost`) the host now has. A host
 * that takes the sent `entryId` writes the same id, and the bubble is replaced by id above. One
 * that does not (a desktop host) writes the message under its own id: once this machine handed the
 * message over (`keptSentAt`), the first user entry new to this tab with the same text and the
 * same number of images replaces one bubble. Each host entry replaces at most one. Never an entry
 * this tab already drew before (an earlier message with the same words), never before the send
 * (a message another client sent with the same words), and never a host entry written before the
 * bubble itself (R28): the host writes its copy after the message was typed, so an earlier message
 * with the same words, read in now, is not this one. A kept bubble waits for its own copy. The
 * mirror holds no reading of the host's clock, so no skew is allowed: the time a message was kept
 * (from the bubble to its send) is what absorbs a host clock that runs behind this one.
 */

function withoutKeptCopies(
	older: LogEntry[],
	host: readonly LogEntry[],
	local: readonly LogEntry[]
): LogEntry[] {
	if (!older.some((entry) => entry.keptForHost)) return older;
	const drawn = new Set(local.map((entry) => entry.id));
	const copies = host.filter((entry) => entry.source === 'user' && !drawn.has(entry.id));
	if (copies.length === 0) return older;
	return older.filter((entry) => {
		if (!entry.keptForHost || entry.keptSentAt === undefined) return true;
		const at = copies.findIndex(
			(copy) =>
				copy.text === entry.text &&
				(copy.images?.length ?? 0) === (entry.images?.length ?? 0) &&
				// Written at or after the bubble: an older message the host read in now, with the same
				// words, is not this one (R28).
				copy.timestamp >= entry.timestamp
		);
		if (at === -1) return true;
		copies.splice(at, 1);
		return false;
	});
}

/**
 * A tab's transcript with the host's folded in. `persisted` undefined (never read) keeps the local
 * entries; the live tail still shows. Returns `local` itself when nothing changed. A host user
 * entry shows "Message delivered" when the agent's answer to it arrived (`withAnswerDelivery()`).
 */
export function mergeHostedLogs(
	local: LogEntry[],
	persisted: readonly LogEntryRecord[] | undefined,
	tail: readonly LogEntryRecord[] | undefined
): LogEntry[] {
	// A live entry with the id of one already drawn is that entry rewritten in place while a turn
	// runs (a `/history` progress line settled to its outcome, M22): the line takes its new text.
	const rewrites = new Map((tail ?? []).map((record) => [record.id, record.text]));
	const rewritten = (entry: LogEntry): LogEntry => {
		const text = rewrites.get(entry.id);
		return text === undefined || text === entry.text ? entry : { ...entry, text };
	};
	// A kept message the host now runs under its own id (its live entry has that id) is the
	// host's from here on: no longer kept, so a later cut finds it as the turn's message.
	const hostHolds = (entry: LogEntry) => rewrites.has(entry.id);
	const kept = local
		.filter((entry) => !entry.hostLive)
		.map(rewritten)
		.map((entry) =>
			entry.keptForHost && hostHolds(entry)
				? { ...entry, keptForHost: undefined, keptSentAt: undefined }
				: entry
		);
	const hostEntries = persisted ? persistedView(persisted).map(rewritten) : [];
	const hostIds = new Set(hostEntries.map((entry) => entry.id));
	const older = persisted ? kept.filter((entry) => !hostIds.has(entry.id)) : kept;
	const seen = new Set([...older.map((entry) => entry.id), ...hostIds]);
	const live: LogEntry[] = [];
	for (const record of tail ?? []) {
		if (seen.has(record.id)) continue;
		seen.add(record.id);
		live.push({ ...mirrorLogEntry(record), hostLive: true });
	}
	const fromHost = new Set([...hostIds, ...live.map((entry) => entry.id)]);
	const shown = withoutKeptCopies(older, [...hostEntries, ...live], local);
	const next = withAnswerDelivery([...byTime(shown, hostEntries), ...live], fromHost);
	if (sameIds(next, local)) {
		// Same entries in the same order: keep the old array unless a live entry's text moved on,
		// its tool card did, or a message's delivered tick did. `mirrorLogEntry()` builds a new
		// `metadata` object on every pass, so a tool card is compared by value: by identity it would
		// never match, every pass would write, and the sync that follows the store would never settle.
		const liveChanged = live.some((entry, i) => {
			const prior = local[older.length + hostEntries.length + i];
			return prior?.text !== entry.text || !sameMetadata(prior?.metadata, entry.metadata);
		});
		const tickChanged = next.some((entry, i) => !!entry.delivered !== !!local[i].delivered);
		// A saved entry the host rewrote in place (a command's progress line settled to its
		// outcome, M22) keeps its id: its text is what changed.
		const savedChanged = next.some((entry, i) => !entry.hostLive && entry.text !== local[i].text);
		const keptChanged = next.some((entry, i) => !!entry.keptForHost !== !!local[i].keptForHost);
		if (!liveChanged && !tickChanged && !savedChanged && !keptChanged) return local;
	}
	return withDrawnEntriesKept(next, local);
}

/**
 * `next` with each entry that draws the same as the one `local` holds under its id replaced by
 * that one, so only the rows that changed render again. Every pass builds new entry objects (the
 * host's saved entries, the live tail, the delivered tick); a local turn appends to one entry and
 * leaves the others' identity alone, and a hosted turn must cost the same (R8).
 */
function withDrawnEntriesKept(next: LogEntry[], local: readonly LogEntry[]): LogEntry[] {
	if (local.length === 0) return next;
	const prior = new Map(local.map((entry) => [entry.id, entry]));
	let kept = 0;
	const out = next.map((entry) => {
		const before = prior.get(entry.id);
		if (!before || before === entry || !drawsTheSame(before, entry)) return entry;
		kept += 1;
		return before;
	});
	return kept === 0 ? next : out;
}

/** Whether two entries under one id draw the same: every field equal, nested ones by value. */
function drawsTheSame(a: LogEntry, b: LogEntry): boolean {
	const fields = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LogEntry>;
	for (const field of fields) {
		const x = a[field];
		const y = b[field];
		if (x === y) continue;
		if (Array.isArray(x) && Array.isArray(y)) {
			if (x.length !== y.length || x.some((value, i) => value !== y[i])) return false;
			continue;
		}
		if (x && y && typeof x === 'object' && typeof y === 'object') {
			if (canonicalJson(x) !== canonicalJson(y)) return false;
			continue;
		}
		return false;
	}
	return true;
}

/**
 * Whether two queues draw the same cards. Every field `mirrorQueuedItem()` writes is compared, so
 * an edit on the host that changes only the images, the model or effort, or a command's arguments
 * reaches the card and its editor instead of being dropped as "unchanged".
 */
function sameQueue(a: readonly QueuedItem[], b: readonly QueuedItem[]): boolean {
	return (
		a.length === b.length &&
		a.every((item, i) => {
			const other = b[i];
			return (
				item.id === other.id &&
				item.paused === other.paused &&
				item.type === other.type &&
				item.text === other.text &&
				item.command === other.command &&
				item.commandArgs === other.commandArgs &&
				item.tabId === other.tabId &&
				item.hostImagesPending === other.hostImagesPending &&
				sameImages(item.images, other.images) &&
				canonicalJson(item.turnSettings ?? null) === canonicalJson(other.turnSettings ?? null)
			);
		})
	);
}

/** Whether two image lists hold the same images in the same order (absent reads as none). */
export function sameImages(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined
): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((image, i) => image === right[i]);
}

/**
 * The tab's error banner, raised and cleared as a local tab's is: an error the host's running turn
 * reports while this tab watches (a live entry not drawn here before) raises it, and the start of
 * the next turn clears it, as a local send does. A dismissed banner stays dismissed, because an
 * error already drawn never raises it again, and an old error in a transcript that loads later is
 * not live, so it raises nothing.
 */
function hostedTabError(
	local: AITab,
	busy: boolean,
	logs: readonly LogEntry[],
	linkDown: boolean
): AgentError | undefined {
	let error = busy && local.state !== 'busy' ? undefined : local.agentError;
	// The link is back: the host's own report says how the turn ended.
	if (!linkDown && error?.source === 'host-link') error = undefined;
	if (logs === local.logs) return error;
	const drawn = new Set((local.logs ?? []).map((entry) => entry.id));
	for (const entry of logs) {
		if (entry.hostLive && entry.source === 'error' && entry.agentError && !drawn.has(entry.id)) {
			error = entry.agentError;
		}
	}
	return error;
}

/**
 * Whether the answer of a turn this record watched run reached `logs`: an answer entry the host
 * recorded (not a live one) that `prior` did not draw, while the tab was running or showing the
 * turn's live entries. The same moment a local tab gets its answer as data (`markDelivered()`,
 * `markUnread()`), at the provider's result. An answer that was already there when the
 * transcript was first read (a conversation loaded at startup) is no new answer.
 */
function answerArrived(local: AITab, logs: readonly LogEntry[]): boolean {
	const prior = local.logs ?? [];
	if (logs === prior) return false;
	const watchedRun = local.state === 'busy' || prior.some((entry) => entry.hostLive);
	if (!watchedRun) return false;
	const drawn = new Set(prior.map((entry) => entry.id));
	return logs.some(
		(entry) => !entry.hostLive && ANSWER_SOURCES.has(entry.source) && !drawn.has(entry.id)
	);
}

/**
 * A tab's unread flag once its answer arrived, by the rule a local tab follows
 * (`useAgentDataListener`): the answer marks it unread unless its agent is the active agent, it
 * is the agent's active AI tab (`activeTabId`, whichever panel is drawn), and it is scrolled to
 * the bottom; then the answer clears it. A hidden tab is never set unread: it has no chip to clear
 * it from.
 */
function hostedTabUnread(
	local: AITab,
	logs: readonly LogEntry[],
	watched: boolean
): boolean | undefined {
	if (!answerArrived(local, logs)) return local.hasUnread;
	const unread = !watched || local.isAtBottom === false;
	return unread && isAiTabHidden(local) ? local.hasUnread : unread;
}

/**
 * When the turn a host tab runs started, as the host tells it (its record, else the live turn's
 * first event); undefined when the tab is idle or the host has not said. The projection draws this
 * as the tab's `thinkingStartTime`.
 */
export function hostTabTurnStartedAt(
	host: Pick<AITabRecord, 'state' | 'thinkingStartTime'>,
	liveTurn: Pick<LiveTurn, 'startedAt'> | undefined
): number | undefined {
	if (host.state !== 'busy') return undefined;
	return host.thinkingStartTime ?? liveTurn?.startedAt;
}

function projectTab(
	local: AITab,
	host: AITabRecord,
	merged: LogEntry[],
	liveTurn: LiveTurn | undefined,
	watched: boolean,
	hostSeenAt: number | undefined,
	link: { lost?: AgentError; endedHere: boolean; kept: boolean }
): AITab {
	// A turn the host last reported running that nobody here can follow or finish ends here.
	const cut = host.state === 'busy' && link.lost !== undefined;
	const busy = host.state === 'busy' && !cut && !link.endedHere;
	// A kept cut has the retry card for its note, and the kept message's error for its own.
	const noted = cut && !link.kept;
	const logs =
		noted && link.lost
			? withLinkNote(merged, local.logs ?? [], {
					id: hostLinkNoteId(local.id, merged, link.lost),
					timestamp: link.lost.timestamp,
					source: 'error',
					text: link.lost.message,
					agentError: link.lost,
				})
			: merged;
	const thinkingStartTime = busy
		? (hostTabTurnStartedAt(host, liveTurn) ?? local.thinkingStartTime)
		: undefined;
	const name = host.name ?? null;
	const agentSessionId = host.agentSessionId ?? local.agentSessionId ?? null;
	const starred = host.starred === true;
	const state = busy ? 'busy' : 'idle';
	const agentError =
		noted && link.lost ? link.lost : hostedTabError(local, busy, logs, link.lost !== undefined);
	const hasUnread = hostedTabUnread(local, logs, watched);
	// The host runs the turns, so its tab's usage is what the header's gauge and cost pill read. A
	// host that reports none (an older host) leaves the usage this tab already had.
	const hostUsage = mirrorUsageStats(host.usageStats);
	const usageStats =
		hostUsage && !(local.usageStats && canonicalJson(local.usageStats) === canonicalJson(hostUsage))
			? hostUsage
			: local.usageStats;
	if (
		local.name === name &&
		local.agentSessionId === agentSessionId &&
		local.starred === starred &&
		local.state === state &&
		local.thinkingStartTime === thinkingStartTime &&
		local.logs === logs &&
		local.agentError === agentError &&
		local.hasUnread === hasUnread &&
		local.hostSeenAt === hostSeenAt &&
		local.usageStats === usageStats
	) {
		return local;
	}
	return {
		...local,
		name,
		agentSessionId,
		starred,
		state,
		thinkingStartTime,
		logs,
		agentError,
		...(hasUnread !== undefined ? { hasUnread } : {}),
		...(hostSeenAt !== undefined ? { hostSeenAt } : {}),
		...(usageStats ? { usageStats } : {}),
	};
}

/**
 * The agent as its host runs it. The record keeps its SSH remote for the files, terminal, and git
 * that run from this machine, but the host spawns each AI turn on its own machine: no SSH hop. A
 * check about the turn itself (can it be steered) reads this view, so a hosted agent answers as a
 * local agent on the host would, never as an SSH agent.
 */
export function hostRunView<T extends Pick<Session, 'sshRemoteId' | 'sessionSshRemoteConfig'>>(
	session: T
): T {
	if (!session.sshRemoteId && !session.sessionSshRemoteConfig) return session;
	return { ...session, sshRemoteId: undefined, sessionSshRemoteConfig: undefined };
}

/** `session` with the host's tabs, transcripts, busy state, and queue folded in. */
export function projectHostedSession(incoming: Session, input: HostedProjectionInput): Session {
	const { agent } = input;
	const hostTabs = (agent.aiTabs ?? []).filter((tab) => !tab.hidden);
	const hostById = new Map(hostTabs.map((tab) => [tab.id, tab]));
	// Every tab the host lists, hidden ones too: a tab it hid is not a tab it closed.
	const hostListed = new Set((agent.aiTabs ?? []).map((tab) => tab.id));
	// The hosting these tabs belong to: a mark from an earlier one says nothing about this host.
	const hostingAt = readLiftedTo(incoming.liftedTo)?.at;
	// Reported by the host in this hosting and no longer listed: the host closed it (another
	// client, or a close from here the host took). A record that lists no tabs at all is not
	// known yet, and closes nothing.
	const closedOnHost = (tab: AITab) =>
		Array.isArray(agent.aiTabs) &&
		hostingAt !== undefined &&
		tab.hostSeenAt === hostingAt &&
		!hostListed.has(tab.id);
	// Close each such tab here as a local close does (`closeTab()`): the closed-tab history keeps
	// what only this machine holds (a draft, staged images), so Cmd+Shift+T brings it back, and
	// the strip, the active tab, and the tile groups settle as they do after any close.
	let session = incoming;
	for (const tab of incoming.aiTabs) {
		if (closedOnHost(tab)) session = closeTab(session, tab.id)?.session ?? session;
	}
	const logsFor = (tabId: string, local: LogEntry[]): LogEntry[] => {
		const key = liveTurnKey(agent.id, tabId);
		const slot = input.transcripts?.[key];
		const live = input.liveTurns?.[key];
		return mergeHostedLogs(
			local,
			slot?.loaded ? slot.entries : undefined,
			live?.entries ?? slot?.carryover
		);
	};

	let changed = session !== incoming;
	const localIds = new Set(session.aiTabs.map((tab) => tab.id));
	// An added agent starts with one blank local tab; once the host has a tab to show it is only
	// noise. A tab the host lists (a hidden one too) is the host's, never this placeholder.
	// A tab opened here while the host was down waits to be made there (`pendingHostTab`): kept.
	const isBlankLocalOnly = (tab: AITab) =>
		!tab.pendingHostTab &&
		!hostListed.has(tab.id) &&
		!tab.agentSessionId &&
		(tab.logs?.length ?? 0) === 0 &&
		!tab.inputValue &&
		(tab.stagedImages?.length ?? 0) === 0;
	const dropped = new Set(
		hostTabs.length > 0
			? session.aiTabs.filter((tab) => isBlankLocalOnly(tab)).map((tab) => tab.id)
			: []
	);

	const aiTabs: AITab[] = [];
	for (const local of session.aiTabs) {
		if (dropped.has(local.id)) {
			changed = true;
			continue;
		}
		const host = hostById.get(local.id);
		if (!host && hostListed.has(local.id)) {
			// A tab the host lists as hidden: the host's, so marked as reported, and closed here when
			// the host stops listing it.
			if (hostingAt !== undefined && local.hostSeenAt !== hostingAt) {
				aiTabs.push({ ...local, hostSeenAt: hostingAt });
				changed = true;
			} else aiTabs.push(local);
			continue;
		}
		if (!host) {
			// The host does not have it: a conversation kept from before the move. Nothing runs it.
			if (local.state === 'busy' && !local.hidden) {
				aiTabs.push({ ...local, state: 'idle', thinkingStartTime: undefined });
				changed = true;
			} else aiTabs.push(local);
			continue;
		}
		// The host made a tab opened here while it was down: from now on it is the host's.
		const reported = local.pendingHostTab ? { ...local, pendingHostTab: undefined } : local;
		const projected = projectTab(
			reported,
			host,
			logsFor(local.id, local.logs ?? []),
			input.liveTurns?.[liveTurnKey(agent.id, local.id)],
			input.viewing === true && local.id === session.activeTabId,
			hostingAt ?? local.hostSeenAt,
			{
				lost: input.linkLost,
				endedHere: input.endedHere?.has(local.id) === true,
				kept: input.keptCuts?.has(local.id) === true,
			}
		);
		// Its first report is the host's blank tab: the name and pills given here stay, and go to
		// the host with the answer to its creation (`createPendingHostTab()`).
		const next = local.pendingHostTab
			? {
					...projected,
					name: local.name ?? projected.name,
					saveToHistory: local.saveToHistory,
					showThinking: local.showThinking,
				}
			: projected;
		if (next !== local) changed = true;
		aiTabs.push(next);
	}
	const added: AITab[] = [];
	for (const host of hostTabs) {
		if (localIds.has(host.id) || input.closing?.has(host.id)) continue;
		const tab = mirrorTab(host);
		tab.logs = logsFor(host.id, []);
		if (hostingAt !== undefined) tab.hostSeenAt = hostingAt;
		if (input.linkLost && tab.state === 'busy') {
			// First drawn while the link is down: nothing here can follow its turn either.
			tab.state = 'idle';
			tab.thinkingStartTime = undefined;
		}
		added.push(tab);
	}
	if (added.length > 0) {
		aiTabs.push(...added);
		changed = true;
	}

	let unifiedTabOrder = session.unifiedTabOrder;
	if (added.length > 0 || dropped.size > 0) {
		unifiedTabOrder = [
			...(session.unifiedTabOrder ?? []).filter(
				(ref) => !(ref.type === 'ai' && dropped.has(ref.id))
			),
			...added.map((tab): UnifiedTabRef => ({ type: 'ai', id: tab.id })),
		];
	}
	let activeTabId = session.activeTabId;
	if (dropped.has(activeTabId) || !aiTabs.some((tab) => tab.id === activeTabId)) {
		activeTabId =
			(agent.activeTabId && aiTabs.some((tab) => tab.id === agent.activeTabId)
				? agent.activeTabId
				: aiTabs[0]?.id) ?? activeTabId;
		if (activeTabId !== session.activeTabId) changed = true;
	}

	const hostQueue = (input.queue ?? []).map(
		(item): QueuedItem => ({ ...mirrorQueuedItem(item), hostQueued: true })
	);
	const localQueue = session.executionQueue ?? [];
	const ownQueue = localQueue.filter((item) => !item.hostQueued);
	const executionQueue = [...ownQueue, ...hostQueue];
	const queueChanged = !sameQueue(executionQueue, localQueue);
	if (queueChanged) changed = true;

	// A terminal command owns the agent's busy state while it runs; it is local, not the host's.
	const terminalBusy = session.state === 'busy' && session.busySource === 'terminal';
	const anyBusy = aiTabs.some((tab) => tab.state === 'busy');

	// The agent's error, as a local error sets it: the tab that last raised a banner names it (the
	// error modal reads it there), and it clears with that tab's banner. The queue pause a local
	// error adds is the host's to keep: it runs the queue.
	const priorById = new Map(session.aiTabs.map((tab) => [tab.id, tab]));
	const raised = aiTabs.find(
		(tab) => tab.agentError && tab.agentError !== priorById.get(tab.id)?.agentError
	);
	const errorTab =
		raised ??
		(session.agentErrorTabId
			? aiTabs.find((tab) => tab.id === session.agentErrorTabId)
			: undefined);
	// An error no tab owns (one raised here, not by the host) stays until it is cleared here.
	const agentError = raised || session.agentErrorTabId ? errorTab?.agentError : session.agentError;
	const agentErrorTabId = errorTab?.agentError ? errorTab.id : undefined;
	if (agentError !== session.agentError || agentErrorTabId !== session.agentErrorTabId) {
		changed = true;
	}

	const state = terminalBusy ? session.state : anyBusy ? 'busy' : agentError ? 'error' : 'idle';
	const busySource = terminalBusy ? session.busySource : anyBusy ? 'ai' : undefined;
	if (state !== session.state || busySource !== session.busySource) changed = true;

	if (!changed) return session;
	const projected: Session = {
		...session,
		aiTabs,
		activeTabId,
		...(unifiedTabOrder ? { unifiedTabOrder } : {}),
		executionQueue: queueChanged ? executionQueue : localQueue,
		state,
		busySource,
		agentError,
		agentErrorTabId,
	};
	// A tab left the strip: its pane leaves its tile group, as after a local close.
	return session !== incoming || dropped.size > 0 ? normalizeTabGroups(projected) : projected;
}

/**
 * `session` with everything the host sync put in it that only the host can settle taken out: its
 * queue cards (`hostQueued`), the live entries of a turn (`hostLive`), and the busy state of a host
 * turn. Used once when hosted agents are switched off, so the record works as its SSH agent with no
 * card or busy tab nobody here can finish. The host's conversations stay. Same reference back when
 * there is nothing to take out.
 */
export function releaseHostedSession(session: Session): Session {
	let changed = false;
	const aiTabs = session.aiTabs.map((tab) => {
		const logs = tab.logs?.some((entry) => entry.hostLive)
			? tab.logs.filter((entry) => !entry.hostLive)
			: tab.logs;
		if (logs === tab.logs && tab.state !== 'busy') return tab;
		changed = true;
		return { ...tab, logs, state: 'idle' as const, thinkingStartTime: undefined };
	});
	const queue = session.executionQueue ?? [];
	const executionQueue = queue.some((item) => item.hostQueued)
		? queue.filter((item) => !item.hostQueued)
		: queue;
	if (executionQueue !== queue) changed = true;
	const aiBusy = session.state === 'busy' && session.busySource !== 'terminal';
	if (aiBusy) changed = true;
	if (!changed) return session;
	return {
		...session,
		aiTabs,
		executionQueue,
		...(aiBusy ? { state: 'idle' as const, busySource: undefined } : {}),
	};
}
