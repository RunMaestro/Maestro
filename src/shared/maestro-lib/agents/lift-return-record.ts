/**
 * The record half of moving a hosted agent back from its Federation host: what the host held,
 * and the local record once it is merged in. Pure, with no runtime import beyond `lift-pointer`,
 * so the renderer can apply a restore without pulling the SSH and peer-connection stack that
 * `runReturnFromHost()` in `lift-return.ts` needs (that stack reaches `fs` and `child_process`,
 * which a browser bundle cannot load). `lift-return.ts` re-exports everything here.
 */

import type { QueuedTurn } from '../client/types';
import type { AITabRecord } from '../store/records';
import { readLiftedTo } from './lift-pointer';

/** A message that waited in the host's queue, to wait in the local queue once the agent is back. */
export type ReturnedQueuedMessage = Pick<
	QueuedTurn,
	'itemId' | 'tabId' | 'queuedAt' | 'text' | 'paused'
>;

/** What the host held, to merge into the local record. Each tab carries its transcript. */
export interface ReturnedFromHost {
	tabs: AITabRecord[];
	activeTabId?: string;
	/** The host's queue, in its order. A held (paused) message stays held here. */
	queue?: ReturnedQueuedMessage[];
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
 * The local record once the agent is back: no `liftedTo`, `hostedOptOut` set, and the host's tabs
 * merged in by tab id. A tab both sides have takes the host's transcript (the conversation went on
 * there) unless the host's is shorter, plus its name, star, and provider session. A host tab this
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
	const hostById = new Map(returned.tabs.map((tab) => [tab.id, tab]));
	const merged: AITabRecord[] = localTabs.map((local) => {
		const host = hostById.get(local.id);
		if (!host) return local;
		const hostLogs = Array.isArray(host.logs) ? host.logs : [];
		const localLogs = Array.isArray(local.logs) ? local.logs : [];
		return {
			...local,
			agentSessionId: host.agentSessionId ?? local.agentSessionId ?? null,
			name: host.name ?? local.name ?? null,
			starred: host.starred === true,
			logs: hostLogs.length >= localLogs.length ? hostLogs : localLogs,
			...(host.usageStats ? { usageStats: host.usageStats } : {}),
			state: 'idle',
		};
	});
	const localIds = new Set(localTabs.map((tab) => tab.id));
	const added = returned.tabs.filter((tab) => !localIds.has(tab.id)).map(asLocalTab);
	const aiTabs = [...merged, ...added];

	const order = Array.isArray(record.unifiedTabOrder)
		? [...(record.unifiedTabOrder as { type: string; id: string }[])]
		: undefined;
	if (order) for (const tab of added) order.push({ type: 'ai', id: tab.id });

	const activeTabId =
		returned.activeTabId && aiTabs.some((tab) => tab.id === returned.activeTabId)
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
		return [
			{
				id: item.itemId,
				timestamp: item.queuedAt,
				tabId,
				type: 'message',
				text: item.text,
				...(item.paused ? { paused: true } : {}),
			},
		];
	});

	const { liftedTo: _liftedTo, ...rest } = record;
	return {
		...rest,
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
	const raw = value as { tabs?: unknown; activeTabId?: unknown; queue?: unknown };
	if (!Array.isArray(raw.tabs)) return undefined;
	const queue = raw.queue === undefined ? [] : readReturnedQueue(raw.queue);
	if (!queue) return undefined;
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
	};
}

/** Why `record` cannot take a restore right now, or undefined when it can. */
export function returnRestoreRefusal(record: { liftedTo?: unknown }): string | undefined {
	return readLiftedTo(record.liftedTo) ? undefined : 'Agent is not hosted';
}
