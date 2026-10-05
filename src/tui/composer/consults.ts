/**
 * Cross-agent mentions on send (XM-2, XM-3), as pure rules plus the two client
 * calls they drive.
 *
 * A mention is a CONSULT: one read-only question to one agent, answered in the
 * background on that agent (`client.consults.ask`, the path `maestro-cli ask`
 * uses) and shown inline in the asking tab under the consulted agent's name. The
 * exchange lives here, in memory, because a consult never writes into the asking
 * tab's transcript; the consulted agent keeps its own copy in its hidden tab.
 *
 * Handing another agent WORK is a different act and is never implied by a
 * mention. `runDelegation` is the explicit one: it starts a fresh tab on the
 * target and sends the question there as a normal turn, which can edit files and
 * run commands, so the composer says so before it fires.
 */

import {
	consultQuestionOf,
	escapeResolvedMentions,
	mentionableAgentsOf,
	mentionableGroupsOf,
	planMentions,
	type AgentRecord,
	type GroupRecord,
	type LogEntryRecord,
	type MaestroClient,
} from '../../shared/maestro-lib';
import { participantColor } from '../groupchat/entries';
import type { SourceStyle } from '../transcript/entries';

export interface ConsultTarget {
	id: string;
	name: string;
}

export interface MentionSendPlan {
	/** The agents the message names, in the order they first appear. */
	targets: ConsultTarget[];
	/** The message leads with a mention: it is addressed to the targets and the source agent does not answer. */
	suppressLocal: boolean;
	/** What each consulted agent is asked: the message without its mention tokens. */
	question: string;
	/**
	 * What the source agent is sent when it answers too: the message with each
	 * resolved mention quoted, so the desktop (which consults any mention in a
	 * message it is handed) does not consult a second time.
	 */
	localText: string;
}

/** What a draft's mentions mean for this send, or undefined when it names no other agent. */
export function planMentionSend(
	text: string,
	agents: readonly AgentRecord[],
	groups: readonly GroupRecord[],
	sourceAgentId: string
): MentionSendPlan | undefined {
	const roster = mentionableAgentsOf(agents);
	const rosterGroups = mentionableGroupsOf(groups);
	const plan = planMentions(text, roster, rosterGroups, sourceAgentId);
	if (!plan) return undefined;
	const targets = plan.targetAgentIds.map((id) => ({
		id,
		name: agents.find((agent) => agent.id === id)?.name ?? id,
	}));
	return {
		targets,
		suppressLocal: plan.suppressLocal,
		question: consultQuestionOf(text, roster, rosterGroups, sourceAgentId),
		localText: escapeResolvedMentions(text, roster, rosterGroups, sourceAgentId),
	};
}

// ---------------------------------------------------------------------------
// What is shown inline
// ---------------------------------------------------------------------------

export type ConsultStatus = 'asking' | 'answered' | 'failed' | 'delegated';

export interface ConsultItem {
	id: string;
	agentId: string;
	agentName: string;
	status: ConsultStatus;
	/** The answer, the failure, or what the delegation did. Empty while asking. */
	text: string;
	/** When it was asked, epoch ms. */
	at: number;
	/** When it settled, epoch ms. */
	settledAt?: number;
	/**
	 * The person's message, shown as their line above the answer. Only a message
	 * the source agent did NOT also receive: otherwise the transcript already has it.
	 */
	message?: string;
}

/** The items of one composer, by `agentId:tabId`. */
export type ConsultsByTab = Readonly<Record<string, readonly ConsultItem[]>>;

export function addConsult(all: ConsultsByTab, key: string, item: ConsultItem): ConsultsByTab {
	return { ...all, [key]: [...(all[key] ?? []), item] };
}

export function settleConsult(
	all: ConsultsByTab,
	key: string,
	id: string,
	patch: Pick<ConsultItem, 'status' | 'text' | 'settledAt'>
): ConsultsByTab {
	const items = all[key];
	if (!items) return all;
	return { ...all, [key]: items.map((item) => (item.id === id ? { ...item, ...patch } : item)) };
}

const SOURCE_PREFIX = 'consult:';

/** The transcript entries for a tab's consults: the person's line when it is not already stored, then each answer. */
export function consultEntries(items: readonly ConsultItem[]): LogEntryRecord[] {
	const entries: LogEntryRecord[] = [];
	const asked = new Set<string>();
	for (const item of items) {
		if (item.message !== undefined && !asked.has(item.message + item.at)) {
			asked.add(item.message + item.at);
			entries.push({
				id: `${item.id}:ask`,
				timestamp: item.at,
				source: 'user',
				text: item.message,
			});
		}
		entries.push({
			id: item.id,
			timestamp: item.settledAt ?? item.at,
			source: `${SOURCE_PREFIX}${item.status}:${item.agentName}`,
			text: item.status === 'asking' ? '_Asking..._' : item.text || '_Answered with nothing._',
		});
	}
	return entries;
}

/** Interleaves `extra` into `entries` by time, keeping each list's own order and putting `entries` first on a tie. */
export function mergeByTime(
	entries: readonly LogEntryRecord[],
	extra: readonly LogEntryRecord[]
): readonly LogEntryRecord[] {
	if (extra.length === 0) return entries;
	const merged: LogEntryRecord[] = [];
	let at = 0;
	const sorted = [...extra].sort((a, b) => a.timestamp - b.timestamp);
	for (const add of sorted) {
		while (at < entries.length && entries[at]!.timestamp <= add.timestamp) {
			merged.push(entries[at]!);
			at += 1;
		}
		merged.push(add);
	}
	while (at < entries.length) {
		merged.push(entries[at]!);
		at += 1;
	}
	return merged;
}

/** The header an inline consult entry draws: the consulted agent's name, and where its answer stands. */
export function consultStyle(entry: LogEntryRecord): SourceStyle | undefined {
	if (!entry.source.startsWith(SOURCE_PREFIX)) return undefined;
	const rest = entry.source.slice(SOURCE_PREFIX.length);
	const split = rest.indexOf(':');
	const status = rest.slice(0, split);
	const name = rest.slice(split + 1);
	switch (status) {
		case 'asking':
			return { label: `${name} (consulting)`, dimColor: true };
		case 'failed':
			return { label: `${name} (no answer)`, color: 'red' };
		case 'delegated':
			return { label: `${name} (delegated)`, color: 'yellow' };
		default:
			return { label: `${name} (consult)`, color: participantColor(name) };
	}
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export interface ConsultSource {
	agentId: string;
	tabId: string;
}

export type ConsultSettlement = Pick<ConsultItem, 'status' | 'text' | 'settledAt'>;

/**
 * Asks one agent and says how it ended. Read-only on the consulted agent; no
 * tab, unread mark, or focus change there (XM-2).
 */
export async function runConsult(
	client: MaestroClient,
	source: ConsultSource,
	target: ConsultTarget,
	question: string,
	now: () => number = Date.now
): Promise<ConsultSettlement> {
	const result = await client.consults.ask({
		targetAgentId: target.id,
		question,
		fromAgentId: source.agentId,
		fromTabId: source.tabId,
	});
	if (!result.ok) {
		return { status: 'failed', text: result.error.message, settledAt: now() };
	}
	return { status: 'answered', text: result.value.answer.trim(), settledAt: now() };
}

/** Said to the person before the delegation fires, naming exactly what it lets the other agent do (XM-3). */
export function delegationWarning(targets: readonly ConsultTarget[]): string {
	const names = targets.map((target) => target.name).join(', ');
	return `Delegating to ${names}: it gets this as a normal turn and may EDIT files and run commands in its own folder. Ctrl-D again to send, any other key cancels.`;
}

/** What the target is sent: the question, then who it came from. */
export function delegationPrompt(question: string, sourceName: string): string {
	return `${question}\n\n(Delegated from the agent "${sourceName}".)`;
}

/**
 * Hands the question to `target` as work: a new tab on it, named for who sent
 * it, with the question as its first turn. Runs with the agent's normal
 * permissions, which is why a person must have asked for it by name.
 */
export async function runDelegation(
	client: MaestroClient,
	sourceName: string,
	target: ConsultTarget,
	question: string,
	now: () => number = Date.now
): Promise<ConsultSettlement> {
	const created = await client.tabs.create(target.id);
	if (!created.ok) {
		return { status: 'failed', text: created.error.message, settledAt: now() };
	}
	const tabName = `From ${sourceName}`;
	// A name is a convenience: the work goes ahead without one.
	await client.tabs.rename(target.id, created.value.tabId, tabName);
	const sent = await client.turns.send(target.id, created.value.tabId, {
		text: delegationPrompt(question, sourceName),
	});
	if (!sent.ok) {
		return { status: 'failed', text: sent.error.message, settledAt: now() };
	}
	const where = `new tab "${tabName}"`;
	return {
		status: 'delegated',
		text:
			sent.value.status === 'queued'
				? `Delegated with edit rights. It is queued behind the agent's current turn, in a ${where}.`
				: `Delegated with edit rights. It is working in a ${where}.`,
		settledAt: now(),
	};
}
