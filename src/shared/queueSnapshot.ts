/**
 * A desktop agent's execution queue as a reader outside the renderer sees it: `maestro-cli queue
 * list`, a Federation client's queue read (`list_queue`), and the `queue_changed` frame the
 * desktop sends a client when the queue changes (`desktopQueueChanges()`). One shape and one
 * mapping, so every reader gets the same fields.
 */

import { canonicalJson } from './canonicalJson';
import type { MentionRouting } from './crossAgentContext';
import type { QueueExit } from './maestro-lib/client/types';

/**
 * A single queued item, mirrored from the renderer's executionQueue. Tracks the renderer
 * QueuedItem shape.
 */
export interface QueuedItemSnapshot {
	id: string;
	timestamp: number;
	tabId: string;
	type: 'message' | 'command';
	text?: string;
	command?: string;
	commandArgs?: string;
	tabName?: string;
	paused?: boolean;
	/** The `@mention` routing picked for this item (strip or `dispatch --routing`). */
	mentionRouting?: MentionRouting;
	/** Model and effort captured when it was queued. */
	turnSettings?: { model?: string; effort?: string };
	/**
	 * The images it was queued with: store refs from the renderer; data URLs on the wire when the
	 * client asked for them (`list_queue` `inlineImages`), and left out otherwise.
	 */
	images?: string[];
}

/** The fields of a queued item the snapshot reads (the renderer's `QueuedItem`, or its stored copy). */
export type QueuedItemSource = Pick<QueuedItemSnapshot, 'id' | 'timestamp' | 'tabId' | 'type'> &
	Partial<Omit<QueuedItemSnapshot, 'id' | 'timestamp' | 'tabId' | 'type'>>;

/** One queued item as a snapshot: only the fields it has, images as held (store refs). */
export function toQueuedItemSnapshot(item: QueuedItemSource): QueuedItemSnapshot {
	return {
		id: item.id,
		timestamp: item.timestamp,
		tabId: item.tabId,
		type: item.type,
		...(item.text !== undefined ? { text: item.text } : {}),
		...(item.command !== undefined ? { command: item.command } : {}),
		...(item.commandArgs !== undefined ? { commandArgs: item.commandArgs } : {}),
		...(item.tabName !== undefined ? { tabName: item.tabName } : {}),
		...(item.paused !== undefined ? { paused: item.paused } : {}),
		...(item.mentionRouting ? { mentionRouting: item.mentionRouting } : {}),
		// A client's hosted queued card draws the model and effort it runs with.
		...(item.turnSettings ? { turnSettings: item.turnSettings } : {}),
		// Store refs as held: main inlines them only for a client that asks.
		...(item.images?.length ? { images: item.images } : {}),
	};
}

/** The fields of a stored agent `desktopQueueChanges()` reads. */
export interface QueueDiffAgent {
	id: string;
	/** `crossAgentMention`: a Pianola dispatch of a mention runs it with no card (see below). */
	executionQueue?: ReadonlyArray<QueuedItemSource & { crossAgentMention?: unknown }>;
	aiTabs?: ReadonlyArray<{ logs?: ReadonlyArray<{ source?: string; queuedItemId?: string }> }>;
	orphanedThinkingTabs?: ReadonlyArray<{
		logs?: ReadonlyArray<{ source?: string; queuedItemId?: string }>;
	}>;
}

/** One agent's queue after a write, and how each item the write took out of it left. */
export interface DesktopQueueChange {
	agentId: string;
	items: QueuedItemSnapshot[];
	exits: QueueExit[];
}

function wroteCardFor(agent: QueueDiffAgent, itemId: string): boolean {
	const holds = (tab: { logs?: ReadonlyArray<{ source?: string; queuedItemId?: string }> }) =>
		tab.logs?.some((log) => log.source === 'user' && log.queuedItemId === itemId) ?? false;
	return (agent.aiTabs ?? []).some(holds) || (agent.orphanedThinkingTabs ?? []).some(holds);
}

/**
 * How the desktop's queues changed between two writes of its agents, so the desktop names how each
 * item leaves its queue as a headless host does (`queue_changed` with `exit` and `namesExits`).
 *
 * A message that left the queue STARTED when the write holds its card, the user entry the desktop
 * writes for it as it runs, stamped with its id (`markTabRunningQueuedItem()`); one that left with
 * no card was REMOVED. A dispatch writes the card in the same update that takes the item out, so
 * both land in one write. An item whose start writes no card has no exit named: a command (nothing
 * waits on one: a mention is always a message), and a message with a mention a Pianola dispatch
 * runs (`applyQueuedItemDispatch(..., false)`), since naming its start a removal would drop the
 * consult of a turn that ran. An agent that is gone is not listed (its removal says so).
 */
export function desktopQueueChanges(
	previous: readonly QueueDiffAgent[],
	next: readonly QueueDiffAgent[]
): DesktopQueueChange[] {
	const before = new Map(previous.map((agent) => [agent.id, agent]));
	const changes: DesktopQueueChange[] = [];
	for (const agent of next) {
		const items = (agent.executionQueue ?? []).map(toQueuedItemSnapshot);
		const had = before.get(agent.id)?.executionQueue ?? [];
		if (canonicalJson(had.map(toQueuedItemSnapshot)) === canonicalJson(items)) continue;
		const still = new Set(items.map((item) => item.id));
		const exits: QueueExit[] = [];
		for (const item of had) {
			if (still.has(item.id) || item.type !== 'message') continue;
			if (wroteCardFor(agent, item.id)) exits.push({ itemId: item.id, exit: 'started' });
			else if (!item.crossAgentMention) exits.push({ itemId: item.id, exit: 'removed' });
		}
		changes.push({ agentId: agent.id, items, exits });
	}
	return changes;
}
