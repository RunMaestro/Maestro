// Queue commands - inspect and manage the desktop execution queue that
// `dispatch --queue` feeds. The queue lives authoritatively in the desktop
// renderer; these verbs proxy to it over the same WebSocket the `dispatch`
// verb uses, so they fail with MAESTRO_NOT_RUNNING when the app is down.

import { withMaestroClient } from '../services/maestro-client';
import { exitIfMaestroNotRunning } from '../services/session-command';
import { resolveAgentId } from '../services/storage';
import {
	QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS,
	type QueueSteerOutcome,
	type QueueSteerResult,
} from '../../shared/chatSteering';
import type { MentionRouting } from '../../shared/crossAgentContext';

interface QueueListItem {
	id: string;
	timestamp: number;
	tabId: string;
	type: string;
	text?: string;
	command?: string;
	commandArgs?: string;
	tabName?: string;
	paused?: boolean;
	/** The `@mention` routing picked for the item (strip or `dispatch --routing`). */
	mentionRouting?: MentionRouting;
}

interface QueueListSession {
	sessionId: string;
	name: string;
	state: string;
	items: QueueListItem[];
}

export interface QueueListOptions {
	agent?: string;
}

export interface QueueRemoveOptions {
	agent?: string;
}

export interface QueuePauseOptions {
	agent?: string;
}

export interface QueueSteerOptions {
	agent?: string;
}

export interface QueueMergeOptions {
	agent?: string;
}

function emitError(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

/**
 * Map a thrown queue-command error that is NOT an absent app (those exit 3
 * through `exitIfMaestroNotRunning` first) to the verb's generic failure code.
 */
function mapQueueError(error: unknown): { error: string; code: string } {
	const msg = error instanceof Error ? error.message : String(error);
	return { error: `Command failed: ${msg}`, code: 'COMMAND_FAILED' };
}

/**
 * `maestro-cli queue list [--agent <id>]` - print the desktop execution queue
 * as JSON. With --agent, only that agent's queue is returned (even when empty);
 * without it, every agent that currently has queued items.
 */
export async function queueList(options: QueueListOptions): Promise<void> {
	let sessionId: string | undefined;
	if (options.agent) {
		try {
			sessionId = resolveAgentId(options.agent);
		} catch (error) {
			emitError(error instanceof Error ? error.message : 'Unknown error', 'AGENT_NOT_FOUND');
			process.exit(1);
			return;
		}
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{ success?: boolean; queues?: QueueListSession[]; error?: string }>(
				{ type: 'list_queue', ...(sessionId ? { sessionId } : {}) },
				'list_queue_result'
			)
		);
		if (result.success === false) {
			emitError(result.error ?? 'Failed to list queue', 'LIST_FAILED');
			process.exit(1);
			return;
		}
		const queues = result.queues ?? [];
		console.log(JSON.stringify({ success: true, queues, totalItems: countItems(queues) }, null, 2));
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}

function countItems(queues: QueueListSession[]): number {
	return queues.reduce((sum, q) => sum + (q.items?.length ?? 0), 0);
}

/**
 * `maestro-cli queue remove <item-id> --agent <id>` - drop a queued item by id
 * from the desktop execution queue. Fails with ITEM_NOT_FOUND when no item with
 * that id exists for the agent.
 */
export async function queueRemove(itemId: string, options: QueueRemoveOptions): Promise<void> {
	if (!options.agent) {
		emitError('queue remove requires --agent <id>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(options.agent);
	} catch (error) {
		emitError(error instanceof Error ? error.message : 'Unknown error', 'AGENT_NOT_FOUND');
		process.exit(1);
		return;
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{ success?: boolean; removed?: boolean; error?: string }>(
				{ type: 'remove_queue_item', sessionId, itemId },
				'remove_queue_item_result'
			)
		);
		if (result.success === false) {
			emitError(result.error ?? 'Remove failed', 'REMOVE_FAILED');
			process.exit(1);
			return;
		}
		if (!result.removed) {
			emitError(`No queued item with id ${itemId} for agent ${sessionId}`, 'ITEM_NOT_FOUND');
			process.exit(1);
			return;
		}
		console.log(
			JSON.stringify({ success: true, agentId: sessionId, itemId, removed: true }, null, 2)
		);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}

/**
 * Hold or resume one queued item: the queued card's Hold / Resume button. A held
 * item keeps its place in the queue, but nothing dispatches it until it is
 * resumed. Fails with ITEM_NOT_FOUND when no item with that id exists.
 */
async function setQueueItemPaused(
	verb: 'hold' | 'resume',
	itemId: string,
	options: QueuePauseOptions
): Promise<void> {
	if (!options.agent) {
		emitError(`queue ${verb} requires --agent <id>`, 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(options.agent);
	} catch (error) {
		emitError(error instanceof Error ? error.message : 'Unknown error', 'AGENT_NOT_FOUND');
		process.exit(1);
		return;
	}

	const paused = verb === 'hold';
	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{ success?: boolean; found?: boolean; paused?: boolean; error?: string }>(
				{ type: 'set_queue_item_paused', sessionId, itemId, paused },
				'set_queue_item_paused_result'
			)
		);
		if (result.success === false) {
			emitError(result.error ?? `Queue ${verb} failed`, 'PAUSE_FAILED');
			process.exit(1);
			return;
		}
		if (!result.found) {
			emitError(`No queued item with id ${itemId} for agent ${sessionId}`, 'ITEM_NOT_FOUND');
			process.exit(1);
			return;
		}
		console.log(JSON.stringify({ success: true, agentId: sessionId, itemId, paused }, null, 2));
	} catch (error) {
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}

/** `maestro-cli queue hold <item-id> --agent <id>` - park a queued item. */
export function queueHold(itemId: string, options: QueuePauseOptions): Promise<void> {
	return setQueueItemPaused('hold', itemId, options);
}

/** `maestro-cli queue resume <item-id> --agent <id>` - release a held item. */
export function queueResume(itemId: string, options: QueuePauseOptions): Promise<void> {
	return setQueueItemPaused('resume', itemId, options);
}

/**
 * `maestro-cli queue merge <item-id> --agent <id>` - fold a queued message into
 * the message above it on the same tab, like the Merge button on the queued
 * card. Fails with NOT_MERGEABLE when the item is gone, has no message above it,
 * or either side is not a plain message (a command, a leading-mention message,
 * or a turn waiting on a consult).
 */
export async function queueMerge(itemId: string, options: QueueMergeOptions): Promise<void> {
	if (!options.agent) {
		emitError('queue merge requires --agent <id>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(options.agent);
	} catch (error) {
		emitError(error instanceof Error ? error.message : 'Unknown error', 'AGENT_NOT_FOUND');
		process.exit(1);
		return;
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success?: boolean;
				merged?: boolean;
				mergedIntoId?: string;
				error?: string;
			}>({ type: 'merge_queue_item', sessionId, itemId }, 'merge_queue_item_result')
		);
		if (result.success === false) {
			emitError(result.error ?? 'Queue merge failed', 'MERGE_FAILED');
			process.exit(1);
			return;
		}
		if (!result.merged) {
			emitError(
				`Queued item ${itemId} for agent ${sessionId} cannot be merged: it is gone, has no message above it on its tab, or one of the two is not a plain message`,
				'NOT_MERGEABLE'
			);
			process.exit(1);
			return;
		}
		console.log(
			JSON.stringify(
				{ success: true, agentId: sessionId, itemId, mergedIntoId: result.mergedIntoId },
				null,
				2
			)
		);
	} catch (error) {
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}

/**
 * The error code each non-success steer outcome exits with, so a script can tell
 * "still queued, try later" from "may have been typed" without parsing prose.
 */
const STEER_FAILURE_CODES: Record<Exclude<QueueSteerOutcome, 'delivered' | 'settled'>, string> = {
	refused: 'STEER_REFUSED',
	unconfirmed: 'STEER_UNCONFIRMED',
	'not-found': 'ITEM_NOT_FOUND',
	'not-steerable': 'NOT_STEERABLE',
	unavailable: 'STEER_UNAVAILABLE',
};

/**
 * `maestro-cli queue steer <item-id> --agent <id>` - hand a queued message to the
 * turn already running on its tab, exactly like the Steer button on the queued
 * card: the desktop renderer runs the same steerQueuedItem(), so the item leaves
 * the queue only once claude has it and returns if claude never takes it.
 *
 * Exits 0 on `delivered` (typed and submitted; the transcript verdict follows
 * asynchronously) and `settled`; every other outcome exits 1 with a code.
 */
export async function queueSteer(itemId: string, options: QueueSteerOptions): Promise<void> {
	if (!options.agent) {
		emitError('queue steer requires --agent <id>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(options.agent);
	} catch (error) {
		emitError(error instanceof Error ? error.message : 'Unknown error', 'AGENT_NOT_FOUND');
		process.exit(1);
		return;
	}

	try {
		const response = await withMaestroClient((client) =>
			client.sendCommand<{ success?: boolean; result?: QueueSteerResult; error?: string }>(
				{ type: 'steer_queue_item', sessionId, itemId },
				'steer_queue_item_result',
				QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS
			)
		);
		const result = response.result;
		if (response.success === false || !result) {
			emitError(response.error ?? 'Steer failed', 'STEER_FAILED');
			process.exit(1);
			return;
		}
		const ok = result.outcome === 'delivered' || result.outcome === 'settled';
		const payload = {
			success: ok,
			agentId: sessionId,
			itemId,
			...result,
			...(ok
				? {}
				: { code: STEER_FAILURE_CODES[result.outcome as keyof typeof STEER_FAILURE_CODES] }),
		};
		console.log(JSON.stringify(payload, null, 2));
		if (!ok) process.exit(1);
	} catch (error) {
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}
