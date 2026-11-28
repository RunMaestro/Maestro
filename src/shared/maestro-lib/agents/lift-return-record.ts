/**
 * The record half of moving a hosted agent back from its Federation host: what the host held,
 * and the local record once it is merged in. Pure, with no runtime import beyond `lift-pointer`,
 * so the renderer can apply a restore without pulling the SSH and peer-connection stack that
 * `runReturnFromHost()` in `lift-return.ts` needs (that stack reaches `fs` and `child_process`,
 * which a browser bundle cannot load). `lift-return.ts` re-exports everything here.
 */

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
};

/**
 * A host queue item as a local queue item. A slash command keeps its kind, split into command and
 * arguments the way the composer queues one (`buildQueuedMessageItem()`), so the local queue runs
 * it through its command path rather than sending its text as a prompt.
 */
function asLocalQueueItem(item: ReturnedQueuedMessage, tabId: string): Record<string, unknown> {
	const base = {
		id: item.itemId,
		timestamp: item.queuedAt,
		tabId,
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
}

/** The stored marker, or undefined when the field is absent or malformed. */
export function readHostCopyLeft(value: unknown): HostCopyLeft | undefined {
	const pointer = readLiftedTo(value);
	if (!pointer) return undefined;
	const { fetched, returnedAt, carried } = value as Record<string, unknown>;
	if (typeof fetched !== 'boolean') return undefined;
	if (typeof returnedAt !== 'number' || !Number.isFinite(returnedAt)) return undefined;
	if (
		carried !== undefined &&
		!(Array.isArray(carried) && carried.every((id) => typeof id === 'string' && id.length > 0))
	) {
		return undefined;
	}
	return {
		...pointer,
		fetched,
		returnedAt,
		...(Array.isArray(carried) && carried.length > 0 ? { carried: [...carried] } : {}),
	};
}

/** What the host held, to merge into the local record. Each tab carries its transcript. */
export interface ReturnedFromHost {
	tabs: AITabRecord[];
	activeTabId?: string;
	/** The host's queue, in its order. A held (paused) message stays held here. */
	queue?: ReturnedQueuedMessage[];
	/** The host's copy still to remove once this is written. Absent: none is left. */
	hostCopyLeft?: HostCopyLeft;
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

/** Row ids, or undefined when one row has none (then rows cannot be matched across machines). */
function rowIds(rows: unknown[]): Set<string> | undefined {
	const ids = new Set<string>();
	for (const row of rows) {
		const id = (row as { id?: unknown } | null)?.id;
		if (typeof id !== 'string' || !id) return undefined;
		ids.add(id);
	}
	return ids;
}

const rowTime = (row: unknown): number => {
	const at = (row as { timestamp?: unknown } | null)?.timestamp;
	return typeof at === 'number' && Number.isFinite(at) ? at : 0;
};

/**
 * One transcript from the host's and this machine's: every row of both, matched by row id, in time
 * order (host rows first on a tie). So a row either side wrote after the other last saw it is kept.
 * Rows without ids cannot be matched: then the longer transcript wins, the host's on a tie.
 */
function mergeLogs(hostLogs: unknown[], localLogs: unknown[]): unknown[] {
	const hostIds = rowIds(hostLogs);
	if (!hostIds || !rowIds(localLogs)) {
		return hostLogs.length >= localLogs.length ? hostLogs : localLogs;
	}
	const localOnly = localLogs.filter((row) => !hostIds.has((row as { id: string }).id));
	if (localOnly.length === 0) return hostLogs;
	return [...hostLogs, ...localOnly]
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rowTime(a.row) - rowTime(b.row) || a.index - b.index)
		.map(({ row }) => row);
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
 * merged in by tab id. A tab both sides have takes every transcript row of both (matched by row
 * id, see `mergeLogs()`), plus the host's name, star, provider session, and the draft and staged
 * images the host has and this machine does not (`mergedComposer()`). A host tab this
 * machine lacks is appended. Local tabs the host closed stay. The host's queued messages go first in
 * the local queue (they were sent before anything this machine held while the agent was away), as
 * messages, held when the host held them; one this queue already has (same id) is not added twice,
 * and one whose tab is gone waits for the active tab. The host's queue cards (`hostQueued`) are
 * dropped. Pure.
 */
export function withReturnedFromHost<T extends Record<string, unknown>>(
	record: T,
	returned: ReturnedFromHost
): T {
	const localTabs = (Array.isArray(record.aiTabs) ? record.aiTabs : []) as AITabRecord[];
	// An agent already home (finishing a host copy left behind) may be running a turn here: its
	// tab states stay. A moved agent ran nothing here, so its tabs come back idle.
	const wasMoved = readLiftedTo(record.liftedTo) !== undefined;
	const hostById = new Map(returned.tabs.map((tab) => [tab.id, tab]));
	const merged: AITabRecord[] = localTabs.map((local) => {
		const host = hostById.get(local.id);
		if (!host) return local;
		const hostLogs = Array.isArray(host.logs) ? host.logs : [];
		const localLogs = Array.isArray(local.logs) ? local.logs : [];
		return {
			...local,
			// A moved tab resumes the session the host advanced; a tab already home may have run
			// turns here since, so its own session stays and the host's only fills a gap.
			agentSessionId: wasMoved
				? (host.agentSessionId ?? local.agentSessionId ?? null)
				: (local.agentSessionId ?? host.agentSessionId ?? null),
			name: host.name ?? local.name ?? null,
			starred: host.starred === true,
			logs: mergeLogs(hostLogs, localLogs),
			...mergedComposer(host, local),
			...(host.usageStats ? { usageStats: host.usageStats } : {}),
			...(wasMoved ? { state: 'idle' } : {}),
		};
	});
	const localIds = new Set(localTabs.map((tab) => tab.id));
	const added = returned.tabs.filter((tab) => !localIds.has(tab.id)).map(asLocalTab);
	const aiTabs = [...merged, ...added];

	const order = Array.isArray(record.unifiedTabOrder)
		? [...(record.unifiedTabOrder as { type: string; id: string }[])]
		: undefined;
	if (order) for (const tab of added) order.push({ type: 'ai', id: tab.id });

	// An agent already home keeps the tab the user is on.
	const activeTabId =
		wasMoved && returned.activeTabId && aiTabs.some((tab) => tab.id === returned.activeTabId)
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

	const { liftedTo: _liftedTo, hostCopyLeft: _hostCopyLeft, ...rest } = record;
	return {
		...rest,
		...(returned.hostCopyLeft ? { hostCopyLeft: returned.hostCopyLeft } : {}),
		aiTabs,
		...(order ? { unifiedTabOrder: order } : {}),
		...(activeTabId !== undefined ? { activeTabId } : {}),
		...(Array.isArray(record.executionQueue) || fromHost.length > 0
			? { executionQueue: [...fromHost, ...localQueue] }
			: {}),
		hostedOptOut: true,
	} as unknown as T;
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
		queue.push({
			itemId: raw.itemId,
			tabId: raw.tabId,
			queuedAt: raw.queuedAt,
			text: raw.text,
			paused: raw.paused === true,
			...(raw.kind === 'command' ? { kind: 'command' as const } : {}),
		});
	}
	return queue;
}

/**
 * A `returnedFromHost` value that crossed a process boundary (the bridge, IPC), or undefined when
 * it is malformed. Tabs need an id; everything else is kept as the host sent it.
 */
export function readReturnedFromHost(value: unknown): ReturnedFromHost | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as {
		tabs?: unknown;
		activeTabId?: unknown;
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
	return {
		tabs,
		...(typeof raw.activeTabId === 'string' && raw.activeTabId
			? { activeTabId: raw.activeTabId }
			: {}),
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
