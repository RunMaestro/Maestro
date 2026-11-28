/**
 * The record half of moving a hosted agent back from its Federation host: what the host held,
 * and the local record once it is merged in. Pure, with no runtime import beyond `lift-pointer`,
 * so the renderer can apply a restore without pulling the SSH and peer-connection stack that
 * `runReturnFromHost()` in `lift-return.ts` needs (that stack reaches `fs` and `child_process`,
 * which a browser bundle cannot load). `lift-return.ts` re-exports everything here.
 */

import { canonicalJson } from '../../canonicalJson';
import { sessionImageRefSha256 } from '../../sessionImageRefs';
import { collapseWhitespace } from '../../stringUtils';
import type { QueuedTurn } from '../client/types';
import type { AITabRecord } from '../store/records';
import { readLiftedTo, type LiftedToPointer } from './lift-pointer';

/** A message that waited in the host's queue, to wait in the local queue once the agent is back. */
export type ReturnedQueuedMessage = Pick<
	QueuedTurn,
	'itemId' | 'tabId' | 'queuedAt' | 'text' | 'paused'
> & {
	/** Absent: a message (a value written before the kind was carried). */
	kind?: QueuedTurn['kind'];
	/** The images it was queued with, as data URLs, when the host sent them. */
	images?: string[];
	/** Model and effort captured when it was queued, when the host sent them. */
	turnSettings?: { model?: string; effort?: string };
};

/**
 * A host queue item as a local queue item. A slash command keeps its kind, split into command and
 * arguments the way the composer queues one (`buildQueuedMessageItem()`), so the local queue runs
 * it through its command path rather than sending its text as a prompt. Its images and model and
 * effort come with it, so it runs as it was sent.
 */
function asLocalQueueItem(item: ReturnedQueuedMessage, tabId: string): Record<string, unknown> {
	const base = {
		id: item.itemId,
		timestamp: item.queuedAt,
		tabId,
		...(item.images && item.images.length > 0 ? { images: item.images } : {}),
		...(item.turnSettings ? { turnSettings: item.turnSettings } : {}),
		...(item.paused ? { paused: true } : {}),
	};
	const commandText = item.text.trim();
	if (item.kind !== 'command' || !commandText.startsWith('/')) {
		return { ...base, type: 'message', text: item.text };
	}
	const space = commandText.search(/\s/);
	return {
		...base,
		type: 'command',
		command: space === -1 ? commandText : commandText.slice(0, space),
		commandArgs: space === -1 ? '' : commandText.slice(space + 1).trim(),
	};
}

/**
 * The host's copy of an agent that is home again but was not removed yet: the restore is written
 * first, the copy removed after it, so a crash, a lost link, or a host that did not answer in
 * between leaves this on the record, and the next come-home run finishes the job.
 */
export interface HostCopyLeft extends LiftedToPointer {
	/**
	 * The host's tabs, transcripts, and queue came home once. False after an offline return. Either
	 * way the host may have written rows or taken messages since, so finishing reads it again.
	 */
	fetched: boolean;
	/** When the agent came home, in epoch milliseconds. */
	returnedAt: number;
	/**
	 * The host queue items that came home already (they wait, held, in the host copy until it is
	 * removed). Finishing skips them, so none comes home twice, even one that has run here since.
	 */
	carried?: string[];
	/**
	 * The tabs this machine had once the agent was home (written by `withReturnedFromHost()`).
	 * Finishing does not bring back a host tab named here that is gone here: the user closed it.
	 */
	homeTabIds?: string[];
}

/** The stored marker, or undefined when the field is absent or malformed. */
export function readHostCopyLeft(value: unknown): HostCopyLeft | undefined {
	const pointer = readLiftedTo(value);
	if (!pointer) return undefined;
	const { fetched, returnedAt, carried, homeTabIds } = value as Record<string, unknown>;
	if (typeof fetched !== 'boolean') return undefined;
	if (typeof returnedAt !== 'number' || !Number.isFinite(returnedAt)) return undefined;
	if (
		carried !== undefined &&
		!(Array.isArray(carried) && carried.every((id) => typeof id === 'string' && id.length > 0))
	) {
		return undefined;
	}
	const tabIds = Array.isArray(homeTabIds)
		? homeTabIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
		: [];
	return {
		...pointer,
		fetched,
		returnedAt,
		...(Array.isArray(carried) && carried.length > 0 ? { carried: [...carried] } : {}),
		...(tabIds.length > 0 ? { homeTabIds: tabIds } : {}),
	};
}

/** What the host held, to merge into the local record. Each tab carries its transcript. */
export interface ReturnedFromHost {
	tabs: AITabRecord[];
	activeTabId?: string;
	/**
	 * The host's copy this move back leaves behind (the host was not reached, or the caller kept
	 * it). Recorded on the local agent as `leftOnHost`, so the next Move to Host of the SAME agent
	 * replaces that copy instead of being refused for its name (`runLift()`).
	 */
	leftOnHost?: LiftedToPointer;
	/**
	 * A stale-copy merge (`keepDivergentHostTabs()`): for each tab both sides have, by tab id, the
	 * side whose transcript (`containingTranscript()`), usage stats and provider session the tab
	 * keeps, never recounted here. The local tab itself survives: its id, name, draft, staged images,
	 * pins and queue items, starred when either side starred it (`keepLocalTab()`). Without an entry
	 * (a Move Back), the tab keeps every row of both sides (`returnedLogs()`) and takes the host's
	 * name, star and provider session.
	 */
	transcriptSides?: Record<string, TranscriptSide>;
	/**
	 * The host's queue, in its order. A message the person held there stays held here; one that was
	 * waiting to run was held on the host by the return, and runs here.
	 */
	queue?: ReturnedQueuedMessage[];
	/** The host's copy still to remove once this is written. Absent: none is left. */
	hostCopyLeft?: HostCopyLeft;
}

/** Which copy of a tab's transcript a merge keeps. */
export type TranscriptSide = 'host' | 'local';

/** The host copy a move back left behind, or undefined when the field is absent or malformed. */
export function readLeftOnHost(record: { leftOnHost?: unknown }): LiftedToPointer | undefined {
	return readLiftedTo(record.leftOnHost);
}

/**
 * A transcript's conversation, one key per turn: the person's message and the reply to it (every
 * reply entry up to the next message, joined, whitespace collapsed). Notes, tools, and thinking are
 * left out, and so are entry ids. Used only by `furtherTranscript()`, so only by a plain Move Back
 * (the host reached, its tabs coming home); a stale-copy merge never counts turns, it is told which
 * side holds the other (`containingTranscript()`, `ReturnedFromHost.transcriptSides`).
 */
export function conversationTurns(logs: unknown): string[] {
	const turns: string[] = [];
	let user: string | undefined;
	let reply: string[] = [];
	const close = () => {
		if (user !== undefined) turns.push(`${user}\u0000${collapseWhitespace(reply.join(' '))}`);
	};
	for (const entry of Array.isArray(logs) ? logs : []) {
		if (!entry || typeof entry !== 'object') continue;
		const { source, text } = entry as { source?: unknown; text?: unknown };
		const body = typeof text === 'string' ? text : '';
		if (source === 'user') {
			close();
			user = collapseWhitespace(body);
			reply = [];
		} else if ((source === 'ai' || source === 'stdout') && user !== undefined) {
			reply.push(body);
		}
	}
	close();
	return turns;
}

/**
 * Of two transcripts of one tab, the one that went further: more turns of its conversation
 * (`conversationTurns()`), else more entries, else the host's. Counting entries alone would let a
 * side with more notes win over a side with one more turn. Only a plain Move Back asks this (a tab
 * with no `transcriptSides` entry), where the host held the agent last; a stale-copy merge, whose
 * two sides may both have gone on, keeps the side `containingTranscript()` names instead, since a
 * count can drop the other side's turns.
 */
export function furtherTranscript<T>(hostLogs: T[], localLogs: T[]): T[] {
	const hostTurns = conversationTurns(hostLogs).length;
	const localTurns = conversationTurns(localLogs).length;
	if (hostTurns !== localTurns) return hostTurns > localTurns ? hostLogs : localLogs;
	return hostLogs.length >= localLogs.length ? hostLogs : localLogs;
}

/** The id of a transcript entry, or undefined when it has none. */
function entryId(entry: unknown): string | undefined {
	if (!entry || typeof entry !== 'object') return undefined;
	const id = (entry as { id?: unknown }).id;
	return typeof id === 'string' && id ? id : undefined;
}

/**
 * How a transcript match reads an image. One pasted image is a `maestro-image://` ref on this
 * machine and a data URL in a headless host's transcript read (M10): `imageKey` answers the same
 * key for both (`sessionImageContentSha256()`, which needs Node, so the caller passes it). Without
 * one, a ref is keyed by the sha256 its name carries and anything else by itself.
 */
export interface TranscriptMatchOptions {
	imageKey?: (image: unknown) => string | null | undefined;
}

/** What a transcript entry is matched by (`holdsEntry()`). */
interface EntryKey {
	id: string | undefined;
	/**
	 * Its source, text, timestamp and images: one entry stored under other ids. Undefined without a
	 * numeric timestamp: two short replies ("yes") with no time of their own are not one entry.
	 */
	signature: string | undefined;
	/** Its source and images: what one entry under one id keeps while its text grows. */
	frame: string | undefined;
	text: unknown;
}

/** `canonicalJson()` of an untrusted value, or undefined when it is not JSON (it matches nothing). */
function canonicalOrUndefined(value: unknown): string | undefined {
	try {
		return canonicalJson(value);
	} catch {
		return undefined;
	}
}

/** An entry's images by content (`TranscriptMatchOptions.imageKey`), never by the string. */
function imageKeys(images: unknown, options: TranscriptMatchOptions): unknown {
	if (!Array.isArray(images)) return images;
	return images.map((image) => options.imageKey?.(image) ?? sessionImageRefSha256(image) ?? image);
}

function entryKey(entry: unknown, options: TranscriptMatchOptions): EntryKey {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		return { id: undefined, signature: undefined, frame: undefined, text: undefined };
	}
	const { source, text, timestamp } = entry as Record<string, unknown>;
	const images = imageKeys((entry as Record<string, unknown>).images, options);
	return {
		id: entryId(entry),
		signature:
			typeof timestamp === 'number' && Number.isFinite(timestamp)
				? canonicalOrUndefined({ source, text, timestamp, images })
				: undefined,
		frame: canonicalOrUndefined({ source, images }),
		text,
	};
}

/**
 * Whether the entry `outer` holds the entry `inner`: the same thing said (`signature`), or the
 * same entry id whose text `outer` goes on from. A reply streams into one entry, so a copy taken
 * mid-stream holds the start of the text under the same id: the finished copy holds it, never the
 * other way round, and an id whose text was changed otherwise matches nothing.
 */
function holdsEntry(outer: EntryKey, inner: EntryKey): boolean {
	if (inner.signature !== undefined && outer.signature === inner.signature) return true;
	if (inner.id === undefined || outer.id !== inner.id) return false;
	if (inner.frame === undefined || outer.frame !== inner.frame) return false;
	return (
		typeof outer.text === 'string' &&
		typeof inner.text === 'string' &&
		outer.text.startsWith(inner.text)
	);
}

/**
 * Where `outer` holds each entry of `inner`, in order (`holdsEntry()`): `outer`'s index for each,
 * or undefined when an entry of `inner` is not there. `outer` may hold more entries anywhere (a
 * note one side wrote, a turn it went on with).
 */
function matchTranscript(
	outer: unknown,
	inner: unknown,
	options: TranscriptMatchOptions
): number[] | undefined {
	const outerKeys = (Array.isArray(outer) ? outer : []).map((entry) => entryKey(entry, options));
	const at: number[] = [];
	let next = 0;
	for (const entry of Array.isArray(inner) ? inner : []) {
		const key = entryKey(entry, options);
		while (next < outerKeys.length && !holdsEntry(outerKeys[next], key)) next++;
		if (next === outerKeys.length) return undefined;
		at.push(next++);
	}
	return at;
}

/** Whether `outer` holds every entry of `inner`, in order, entry for entry (`matchTranscript()`). */
export function transcriptContains(
	outer: unknown,
	inner: unknown,
	options: TranscriptMatchOptions = {}
): boolean {
	return matchTranscript(outer, inner, options) !== undefined;
}

/**
 * Of two transcripts of one tab, the side that holds the other entry for entry
 * (`transcriptContains()`): the local side when both do (the same transcript), undefined when each
 * holds an entry the other lacks. Undefined means both sides went on: two conversations, never one
 * tab, since keeping either transcript would drop the other's entries.
 */
export function containingTranscript(
	hostLogs: unknown,
	localLogs: unknown,
	options: TranscriptMatchOptions = {}
): TranscriptSide | undefined {
	if (transcriptContains(localLogs, hostLogs, options)) return 'local';
	if (transcriptContains(hostLogs, localLogs, options)) return 'host';
	return undefined;
}

/** A host tab as a local tab record: the fields a local tab needs, idle, with its transcript. */
function asLocalTab(tab: AITabRecord): AITabRecord {
	const {
		state: _state,
		thinkingStartTime: _thinkingStartTime,
		hidden: _hidden,
		consultOrigin: _consultOrigin,
		...rest
	} = tab;
	return {
		...rest,
		agentSessionId: tab.agentSessionId ?? null,
		name: tab.name ?? null,
		starred: tab.starred === true,
		logs: Array.isArray(tab.logs) ? tab.logs : [],
		inputValue: typeof tab.inputValue === 'string' ? tab.inputValue : '',
		stagedImages: Array.isArray(tab.stagedImages) ? tab.stagedImages : [],
		createdAt: typeof tab.createdAt === 'number' ? tab.createdAt : Date.now(),
		state: 'idle',
	};
}

/**
 * The local tab's pins, moved onto the host transcript a merge keeps: a pin made on a local entry
 * that the host stored under another id names the host's id, so it still finds its row. Undefined
 * when nothing moves.
 */
function pinsOnHostEntries(
	local: AITabRecord,
	host: AITabRecord,
	options: TranscriptMatchOptions
): unknown[] | undefined {
	const pins = (local as { pinnedMessages?: unknown }).pinnedMessages;
	if (!Array.isArray(pins) || pins.length === 0) return undefined;
	const localLogs = Array.isArray(local.logs) ? local.logs : [];
	const hostLogs = Array.isArray(host.logs) ? host.logs : [];
	const at = matchTranscript(hostLogs, localLogs, options);
	if (!at) return undefined;
	const hostIdOf = new Map<string, string>();
	localLogs.forEach((entry, index) => {
		const localId = entryId(entry);
		const hostId = entryId(hostLogs[at[index]]);
		if (localId && hostId && localId !== hostId) hostIdOf.set(localId, hostId);
	});
	if (hostIdOf.size === 0) return undefined;
	return pins.map((pin) => {
		const logId = (pin as { logId?: unknown } | null)?.logId;
		const moved = typeof logId === 'string' ? hostIdOf.get(logId) : undefined;
		return moved ? { ...(pin as object), logId: moved } : pin;
	});
}

/**
 * A tab of a stale-copy merge (`ReturnedFromHost.transcriptSides`): the local tab, with the
 * transcript, usage stats and provider session of the side that holds the other's transcript
 * (that session is the one the transcript went on in), starred when either side starred it.
 */
function keepLocalTab(
	local: AITabRecord,
	host: AITabRecord,
	side: TranscriptSide,
	options: TranscriptMatchOptions
): AITabRecord {
	const winner = side === 'host' ? host : local;
	const other = side === 'host' ? local : host;
	const { usageStats: _usageStats, ...rest } = local;
	const pins = side === 'host' ? pinsOnHostEntries(local, host, options) : undefined;
	return {
		...rest,
		...(pins ? { pinnedMessages: pins } : {}),
		agentSessionId: winner.agentSessionId ?? other.agentSessionId ?? null,
		name: local.name ?? host.name ?? null,
		starred: local.starred === true || host.starred === true,
		logs: Array.isArray(winner.logs) ? winner.logs : [],
		...(winner.usageStats ? { usageStats: winner.usageStats } : {}),
		state: 'idle',
	};
}

const rowTime = (row: unknown): number | undefined => {
	const at = (row as { timestamp?: unknown } | null)?.timestamp;
	return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
};

/** A row with no id, by its whole content; undefined when it is not JSON (it then matches nothing). */
function contentKey(row: unknown): string | undefined {
	return entryId(row) === undefined ? canonicalOrUndefined(row) : undefined;
}

/**
 * One transcript from two that BOTH went on: every host row, plus every local row the host does not
 * hold, so a row either side wrote after the other last saw it is kept and none is dropped or
 * doubled. A local row is the host's when the host has a row with its id (one row per id; the
 * local copy wins only when it goes on from the host's, a reply that streamed further here), the
 * same thing said (`EntryKey.signature`), or, for a row with no id, the same content. In time order
 * (host rows first on a tie) when every row has a timestamp; otherwise the host's rows, then this
 * machine's.
 */
function mergeLogs(
	hostLogs: unknown[],
	localLogs: unknown[],
	options: TranscriptMatchOptions
): unknown[] {
	const rows = [...hostLogs];
	const hostKeys = hostLogs.map((row) => entryKey(row, options));
	const atId = new Map<string, number>();
	hostKeys.forEach((key, index) => {
		if (key.id !== undefined && !atId.has(key.id)) atId.set(key.id, index);
	});
	const signatures = new Set(
		hostKeys.map((key) => key.signature).filter((key): key is string => key !== undefined)
	);
	const contents = new Set(
		hostLogs.map(contentKey).filter((key): key is string => key !== undefined)
	);
	const localOnly: unknown[] = [];
	for (const row of localLogs) {
		const key = entryKey(row, options);
		const index = key.id === undefined ? undefined : atId.get(key.id);
		if (index !== undefined) {
			if (holdsEntry(key, hostKeys[index]) && !holdsEntry(hostKeys[index], key)) rows[index] = row;
			continue;
		}
		if (key.signature !== undefined && signatures.has(key.signature)) continue;
		const content = contentKey(row);
		if (content !== undefined && contents.has(content)) continue;
		localOnly.push(row);
	}
	if (localOnly.length === 0) return rows;
	const all = [...rows, ...localOnly];
	if (all.some((row) => rowTime(row) === undefined)) return all;
	return all
		.map((row, index) => ({ row, index }))
		.sort((x, y) => (rowTime(x.row) ?? 0) - (rowTime(y.row) ?? 0) || x.index - y.index)
		.map(({ row }) => row);
}

/**
 * The transcript a returned tab keeps (a Move Back, not a stale-copy merge): when one side holds
 * the other entry for entry (`transcriptContains()`), the one that went further
 * (`furtherTranscript()`, the same side); when both went on, every row of both (`mergeLogs()`), so
 * a turn taken here while the agent was away and one taken on the host both stay.
 */
function returnedLogs(
	hostLogs: unknown[],
	localLogs: unknown[],
	options: TranscriptMatchOptions
): unknown[] {
	if (
		transcriptContains(hostLogs, localLogs, options) ||
		transcriptContains(localLogs, hostLogs, options)
	) {
		return furtherTranscript(hostLogs, localLogs);
	}
	return mergeLogs(hostLogs, localLogs, options);
}

function draftOf(tab: AITabRecord): string {
	return typeof tab.inputValue === 'string' ? tab.inputValue : '';
}

function stagedImagesOf(tab: AITabRecord): unknown[] {
	return Array.isArray(tab.stagedImages) ? tab.stagedImages : [];
}

/**
 * A tab's draft and staged images once the host's are merged in: the host's draft fills an empty
 * local one (a local draft is never overwritten, see `hostDraftsNotKept()`), and the host's
 * staged images are added to the local ones, each once.
 */
function mergedComposer(host: AITabRecord, local: AITabRecord): Partial<AITabRecord> {
	const hostDraft = draftOf(host);
	const localImages = stagedImagesOf(local);
	const hostImages = stagedImagesOf(host).filter((image) => !localImages.includes(image));
	return {
		...(hostDraft.trim() && !draftOf(local).trim() ? { inputValue: hostDraft } : {}),
		...(hostImages.length > 0 ? { stagedImages: [...localImages, ...hostImages] } : {}),
	};
}

/**
 * The host drafts the merge does not keep, because the same tab has a different draft here: the
 * caller names each one, with its text, so nothing typed on the host is dropped unseen.
 */
export function hostDraftsNotKept(
	localTabs: readonly AITabRecord[],
	returned: ReturnedFromHost
): Array<{ tabId: string; tabName?: string; draft: string }> {
	const localById = new Map(localTabs.map((tab) => [tab.id, tab]));
	return returned.tabs.flatMap((host) => {
		const local = localById.get(host.id);
		const hostDraft = draftOf(host).trim();
		if (!local || !hostDraft) return [];
		const localDraft = draftOf(local).trim();
		if (!localDraft || localDraft === hostDraft) return [];
		const tabName = host.name ?? local.name ?? undefined;
		return [{ tabId: host.id, ...(tabName ? { tabName } : {}), draft: draftOf(host) }];
	});
}

/**
 * The local record once the agent is back: no `liftedTo`, `hostedOptOut` set, and the host's tabs
 * merged in by tab id.
 *
 * - A tab both sides have keeps its transcript by `returnedLogs()` (the side that holds the other,
 *   or every row of both when both went on), the host's name, star and provider session, and the
 *   draft and staged images the host has and this machine does not (`mergedComposer()`). A
 *   stale-copy merge says per tab which transcript to keep instead (`transcriptSides`,
 *   `keepLocalTab()`, matching entries for the pins with `options`, as the caller matched the
 *   transcripts).
 * - An agent already home (finishing a host copy left behind, `hostCopyLeft`) may have run turns
 *   here since: its tabs keep their own session, name, star, state and active tab, and the host's
 *   only fill a gap.
 * - A host tab this machine lacks is appended, unless it was home once and the user closed it
 *   here since (`HostCopyLeft.homeTabIds`). Local tabs the host closed stay.
 * - The host's queued messages go first in the local queue (they were sent before anything this
 *   machine held while the agent was away), held when the host held them; one this queue already
 *   has (same id) is not added twice, and one whose tab is gone waits for the active tab. The
 *   host's queue cards (`hostQueued`) are dropped.
 *
 * Pure.
 */
export function withReturnedFromHost<T extends Record<string, unknown>>(
	record: T,
	returned: ReturnedFromHost,
	options: TranscriptMatchOptions = {}
): T {
	const localTabs = (Array.isArray(record.aiTabs) ? record.aiTabs : []) as AITabRecord[];
	const homeAlready =
		readLiftedTo(record.liftedTo) === undefined &&
		readHostCopyLeft(record.hostCopyLeft) !== undefined;
	const hostById = new Map(returned.tabs.map((tab) => [tab.id, tab]));
	const sides = returned.transcriptSides;
	const merged: AITabRecord[] = localTabs.map((local) => {
		const host = hostById.get(local.id);
		if (!host) return local;
		const hostLogs = Array.isArray(host.logs) ? host.logs : [];
		const localLogs = Array.isArray(local.logs) ? local.logs : [];
		const side =
			sides && Object.prototype.hasOwnProperty.call(sides, local.id) ? sides[local.id] : undefined;
		if (side === 'host' || side === 'local') return keepLocalTab(local, host, side, options);
		return {
			...local,
			agentSessionId: homeAlready
				? (local.agentSessionId ?? host.agentSessionId ?? null)
				: (host.agentSessionId ?? local.agentSessionId ?? null),
			name: homeAlready ? (local.name ?? host.name ?? null) : (host.name ?? local.name ?? null),
			starred: homeAlready ? local.starred === true : host.starred === true,
			logs: returnedLogs(hostLogs, localLogs, options),
			...mergedComposer(host, local),
			...(host.usageStats ? { usageStats: host.usageStats } : {}),
			...(homeAlready ? {} : { state: 'idle' }),
		} as AITabRecord;
	});
	const localIds = new Set(localTabs.map((tab) => tab.id));
	// A tab that was home once and is gone here now was closed by the user: it does not come back.
	const homeTabIds = new Set(readHostCopyLeft(record.hostCopyLeft)?.homeTabIds ?? []);
	const added = returned.tabs
		.filter((tab) => !localIds.has(tab.id) && !homeTabIds.has(tab.id))
		.map(asLocalTab);
	const aiTabs = [...merged, ...added];

	const order = Array.isArray(record.unifiedTabOrder)
		? [...(record.unifiedTabOrder as { type: string; id: string }[])]
		: undefined;
	if (order) for (const tab of added) order.push({ type: 'ai', id: tab.id });

	// An agent already home keeps the tab the user is on.
	const activeTabId =
		!homeAlready && returned.activeTabId && aiTabs.some((tab) => tab.id === returned.activeTabId)
			? returned.activeTabId
			: record.activeTabId;

	// The host's own queue cards (`hostQueued`, drawn while hosted agents were on) go: the host's
	// messages arrive below as local items, and a card nothing here runs would hide one.
	const localQueue = (
		(Array.isArray(record.executionQueue) ? record.executionQueue : []) as {
			id?: unknown;
			hostQueued?: unknown;
		}[]
	).filter((item) => item.hostQueued !== true);
	const queuedIds = new Set(localQueue.map((item) => item.id));
	const fallbackTabId =
		typeof activeTabId === 'string' && aiTabs.some((tab) => tab.id === activeTabId)
			? activeTabId
			: aiTabs[0]?.id;
	const fromHost = (returned.queue ?? []).flatMap((item) => {
		if (queuedIds.has(item.itemId)) return [];
		const tabId = aiTabs.some((tab) => tab.id === item.tabId) ? item.tabId : fallbackTabId;
		if (!tabId) return [];
		queuedIds.add(item.itemId);
		return [asLocalQueueItem(item, tabId)];
	});

	const {
		liftedTo: _liftedTo,
		leftOnHost: _leftOnHost,
		hostCopyLeft: _hostCopyLeft,
		...rest
	} = record;
	return {
		...rest,
		...(returned.hostCopyLeft
			? {
					hostCopyLeft: {
						...returned.hostCopyLeft,
						homeTabIds: [...new Set([...homeTabIds, ...aiTabs.map((tab) => tab.id)])],
					},
				}
			: {}),
		aiTabs,
		...(order ? { unifiedTabOrder: order } : {}),
		...(activeTabId !== undefined ? { activeTabId } : {}),
		...(Array.isArray(record.executionQueue) || fromHost.length > 0
			? { executionQueue: [...fromHost, ...localQueue] }
			: {}),
		...(returned.leftOnHost ? { leftOnHost: returned.leftOnHost } : {}),
		hostedOptOut: true,
	} as unknown as T;
}

function readTurnSettings(value: unknown): ReturnedQueuedMessage['turnSettings'] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const { model, effort } = value as { model?: unknown; effort?: unknown };
	return {
		...(typeof model === 'string' ? { model } : {}),
		...(typeof effort === 'string' ? { effort } : {}),
	};
}

function readReturnedQueue(value: unknown): ReturnedQueuedMessage[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const queue: ReturnedQueuedMessage[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
		const raw = item as Record<string, unknown>;
		if (
			typeof raw.itemId !== 'string' ||
			!raw.itemId ||
			typeof raw.tabId !== 'string' ||
			typeof raw.text !== 'string' ||
			typeof raw.queuedAt !== 'number'
		) {
			return undefined;
		}
		const images = Array.isArray(raw.images)
			? raw.images.filter((image): image is string => typeof image === 'string')
			: [];
		const turnSettings = readTurnSettings(raw.turnSettings);
		queue.push({
			itemId: raw.itemId,
			tabId: raw.tabId,
			queuedAt: raw.queuedAt,
			text: raw.text,
			paused: raw.paused === true,
			...(raw.kind === 'command' ? { kind: 'command' as const } : {}),
			...(images.length > 0 ? { images } : {}),
			...(turnSettings ? { turnSettings } : {}),
		});
	}
	return queue;
}

/**
 * A `returnedFromHost` value that crossed a process boundary (the bridge, IPC), or undefined when
 * it is malformed. Tabs need an id; everything else is kept as the host sent it. A malformed
 * `leftOnHost` is dropped (it only lets a later Move to Host replace the copy); a malformed queue or
 * `hostCopyLeft` refuses the whole value, because dropping either could lose a message or a copy.
 */
export function readReturnedFromHost(value: unknown): ReturnedFromHost | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as {
		tabs?: unknown;
		activeTabId?: unknown;
		leftOnHost?: unknown;
		queue?: unknown;
		hostCopyLeft?: unknown;
	};
	if (!Array.isArray(raw.tabs)) return undefined;
	const queue = raw.queue === undefined ? [] : readReturnedQueue(raw.queue);
	if (!queue) return undefined;
	const hostCopyLeft =
		raw.hostCopyLeft === undefined ? undefined : readHostCopyLeft(raw.hostCopyLeft);
	if (raw.hostCopyLeft !== undefined && !hostCopyLeft) return undefined;
	const tabs: AITabRecord[] = [];
	for (const tab of raw.tabs) {
		if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return undefined;
		const id = (tab as { id?: unknown }).id;
		if (typeof id !== 'string' || !id) return undefined;
		tabs.push(tab as AITabRecord);
	}
	const leftOnHost = readLiftedTo(raw.leftOnHost);
	return {
		tabs,
		...(typeof raw.activeTabId === 'string' && raw.activeTabId
			? { activeTabId: raw.activeTabId }
			: {}),
		...(leftOnHost ? { leftOnHost } : {}),
		...(queue.length > 0 ? { queue } : {}),
		...(hostCopyLeft ? { hostCopyLeft } : {}),
	};
}

/**
 * Why `record` cannot take a restore right now, or undefined when it can: it is moved, or it is
 * home with a host copy still to remove (the restore that finishes the job).
 */
export function returnRestoreRefusal(record: {
	liftedTo?: unknown;
	hostCopyLeft?: unknown;
}): string | undefined {
	return readLiftedTo(record.liftedTo) || readHostCopyLeft(record.hostCopyLeft)
		? undefined
		: 'Agent is not hosted';
}
