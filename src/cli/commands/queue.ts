// Queue commands - inspect and manage the desktop execution queue that
// `dispatch --queue` feeds. The queue lives authoritatively in the desktop
// renderer; these verbs proxy to it over the same WebSocket the `dispatch`
// verb uses, so they fail with MAESTRO_NOT_RUNNING when the app is down.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

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

function emitError(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

/**
 * Map a thrown queue-command error to the same "app down" vs "generic failure"
 * codes the dispatch verb uses, so scripts can branch on `code` consistently.
 */
function mapQueueError(error: unknown): { error: string; code: string } {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();
	if (
		lower.includes('econnrefused') ||
		lower.includes('connection refused') ||
		lower.includes('websocket') ||
		lower.includes('enotfound') ||
		lower.includes('etimedout') ||
		lower.includes('maestro desktop app is not running') ||
		lower.includes('discovery file is stale') ||
		lower.includes('not connected to maestro')
	) {
		return {
			error: 'Maestro desktop is not running or not reachable',
			code: 'MAESTRO_NOT_RUNNING',
		};
	}
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
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}
