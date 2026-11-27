/**
 * The record half of moving a hosted agent back from its Federation host: what the host held,
 * and the local record once it is merged in. Pure, with no runtime import beyond `lift-pointer`,
 * so the renderer can apply a restore without pulling the SSH and peer-connection stack that
 * `runReturnFromHost()` in `lift-return.ts` needs (that stack reaches `fs` and `child_process`,
 * which a browser bundle cannot load). `lift-return.ts` re-exports everything here.
 */

import { collapseWhitespace } from '../../stringUtils';
import type { AITabRecord } from '../store/records';
import { readLiftedTo, type LiftedToPointer } from './lift-pointer';

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
}

/** The host copy a move back left behind, or undefined when the field is absent or malformed. */
export function readLeftOnHost(record: { leftOnHost?: unknown }): LiftedToPointer | undefined {
	return readLiftedTo(record.leftOnHost);
}

/**
 * A transcript's conversation, one key per turn: the person's message and the reply to it (every
 * reply entry up to the next message, joined, whitespace collapsed). Notes, tools, and thinking are
 * left out, and so are entry ids, so two copies of one conversation read the same on both sides
 * even when each side wrote its own notes or stored the entries under other ids.
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
 * side with more notes win over a side with one more turn.
 */
export function furtherTranscript<T>(hostLogs: T[], localLogs: T[]): T[] {
	const hostTurns = conversationTurns(hostLogs).length;
	const localTurns = conversationTurns(localLogs).length;
	if (hostTurns !== localTurns) return hostTurns > localTurns ? hostLogs : localLogs;
	return hostLogs.length >= localLogs.length ? hostLogs : localLogs;
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
 * merged in by tab id. A tab both sides have takes the transcript that went further
 * (`furtherTranscript()`: the host's, where the conversation went on there), plus the host's name,
 * star, and provider session. A host tab this
 * machine lacks is appended. Local tabs the host closed stay. Pure.
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
			logs: furtherTranscript(hostLogs, localLogs),
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

	const { liftedTo: _liftedTo, leftOnHost: _leftOnHost, ...rest } = record;
	return {
		...rest,
		aiTabs,
		...(order ? { unifiedTabOrder: order } : {}),
		...(activeTabId !== undefined ? { activeTabId } : {}),
		...(returned.leftOnHost ? { leftOnHost: returned.leftOnHost } : {}),
		hostedOptOut: true,
	} as unknown as T;
}

/**
 * A `returnedFromHost` value that crossed a process boundary (the bridge, IPC), or undefined when
 * it is malformed. Tabs need an id; everything else is kept as the host sent it.
 */
export function readReturnedFromHost(value: unknown): ReturnedFromHost | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as { tabs?: unknown; activeTabId?: unknown; leftOnHost?: unknown };
	if (!Array.isArray(raw.tabs)) return undefined;
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
	};
}

/** Why `record` cannot take a restore right now, or undefined when it can. */
export function returnRestoreRefusal(record: { liftedTo?: unknown }): string | undefined {
	return readLiftedTo(record.liftedTo) ? undefined : 'Agent is not hosted';
}
