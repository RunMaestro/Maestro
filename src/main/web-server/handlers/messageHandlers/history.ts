/**
 * An agent's History over the WebSocket, as a Federation client reads and edits it on a DESKTOP
 * host: `get_history`, `delete_history_entry`, `update_history_entry`. A headless host answers the
 * same three messages (`src/shared/maestro-lib/runtime/server-requests.ts`), so a client
 * (`MaestroClient.history`) reads both host kinds alike: the hosted agent's History panel, and a
 * Move Back or a Move to Host that brings a host copy's History home before the copy is removed.
 *
 * Everything goes through this machine's ONE `HistoryManager` (its file, write queue, and
 * rotation), the same store the History panel's IPC reads and edits. The list is the agent's own
 * entries with what other Maestros shared in its project, merged by the one rule both hosts use
 * (`listAgentHistory()`). An edit finds only the agent's own entries: one another Maestro shared
 * stays theirs, as on a headless host.
 *
 * A web-desktop client already reads and edits this History through the IPC bridge
 * (`history:getAll`, `history:delete`, `history:update`), so these messages expose nothing new.
 */

import { getHistoryManager } from '../../../history-manager';
import { readRemoteEntriesLocal } from '../../../shared-history-manager';
import { listAgentHistory } from '../../../../shared/history';
import type { HistoryEntry } from '../../../../shared/types';
import { logger } from '../../../utils/logger';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

type HistoryResultType =
	| 'get_history_result'
	| 'delete_history_entry_result'
	| 'update_history_entry_result';

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The agent the message names, or a refusal already sent. */
function findAgent(
	ctx: MessageHandlerContext,
	message: WebClientMessage,
	reply: (payload: Record<string, unknown>) => void
): { id: string; cwd: string } | undefined {
	const agentId = typeof message.sessionId === 'string' ? message.sessionId : '';
	if (!agentId) {
		reply({ success: false, error: 'An agent id (sessionId) is required.' });
		return undefined;
	}
	const agent = ctx.callbacks.getSessions?.().find((session) => session.id === agentId);
	if (!agent) {
		reply({ success: false, error: `Agent not found: ${agentId}` });
		return undefined;
	}
	return { id: agent.id, cwd: agent.cwd };
}

function replier(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	type: HistoryResultType
): (payload: Record<string, unknown>) => void {
	return (payload) => ctx.send(client, { type, ...payload, requestId: message.requestId });
}

/** `get_history`: the agent's History, newest first (`limit`: the first N). */
export async function handleGetHistory(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = replier(ctx, client, message, 'get_history_result');
	const agent = findAgent(ctx, message, reply);
	if (!agent) return;
	const limit =
		typeof message.limit === 'number' && Number.isFinite(message.limit) && message.limit >= 0
			? Math.floor(message.limit)
			: undefined;
	let own: HistoryEntry[];
	try {
		own = await getHistoryManager().getEntries(agent.id);
	} catch (error) {
		logger.warn(`get_history: the History of ${agent.id} was not read`, LOG_CONTEXT, {
			error: errorText(error),
		});
		reply({ success: false, error: `The agent's History could not be read: ${errorText(error)}` });
		return;
	}
	// Never fails the read: a shared file that cannot be read is logged and left out.
	const shared = agent.cwd ? readRemoteEntriesLocal(agent.cwd) : [];
	reply({ success: true, entries: listAgentHistory(own, shared, limit) });
}

/** `delete_history_entry`: the History panel's Delete. `removed: false`: no such entry. */
export async function handleDeleteHistoryEntry(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = replier(ctx, client, message, 'delete_history_entry_result');
	const agent = findAgent(ctx, message, reply);
	if (!agent) return;
	const entryId = typeof message.entryId === 'string' ? message.entryId : '';
	if (!entryId) {
		reply({ success: false, error: 'An entry id is required.' });
		return;
	}
	try {
		reply({ success: true, removed: await getHistoryManager().deleteEntry(agent.id, entryId) });
	} catch (error) {
		reply({ success: false, error: `The entry could not be deleted: ${errorText(error)}` });
	}
}

/** `update_history_entry`: the History panel's Validate. `updated: false`: no such entry. */
export async function handleUpdateHistoryEntry(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = replier(ctx, client, message, 'update_history_entry_result');
	const agent = findAgent(ctx, message, reply);
	if (!agent) return;
	const entryId = typeof message.entryId === 'string' ? message.entryId : '';
	if (!entryId) {
		reply({ success: false, error: 'An entry id is required.' });
		return;
	}
	if (typeof message.validated !== 'boolean') {
		reply({ success: false, error: 'Nothing to change: pass validated.' });
		return;
	}
	try {
		const updated = await getHistoryManager().updateEntry(agent.id, entryId, {
			validated: message.validated,
		});
		reply({ success: true, updated });
	} catch (error) {
		reply({ success: false, error: `The entry could not be changed: ${errorText(error)}` });
	}
}
