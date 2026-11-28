// Queue commands - inspect and manage the desktop execution queue that
// `dispatch --queue` feeds. The queue lives authoritatively in the desktop
// renderer; these verbs proxy to it over the same WebSocket the `dispatch`
// verb uses, so they fail with MAESTRO_NOT_RUNNING when the app is down.
//
// With Federation on, `--agent <peer:agent>` names a peer's agent instead: list,
// remove, hold, resume, merge, steer, and edit act on that host's queue through the same shared
// action the desktop's mirrored queued cards run (`runPeerAgentAction`).

import { withMaestroClient } from '../services/maestro-client';
import { exitIfMaestroNotRunning } from '../services/session-command';
import { resolveAgentId } from '../services/storage';
import {
	QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS,
	type QueueSteerOutcome,
	type QueueSteerResult,
} from '../../shared/chatSteering';
import type { MentionRouting } from '../../shared/crossAgentContext';
import { ExitCode, exitWith } from '../exit-codes';
import {
	PeerResolveError,
	hostCallError,
	peerAgentRef,
	peerErrorCode,
	routeAgentTarget,
	withPeerAgent,
	type PeerTarget,
} from '../services/peer-resolver';
import {
	runPeerAgentAction,
	type PeerAgentAction,
	type PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
import { queuedTurnsToWire } from '../../shared/maestro-lib/runtime/server-frames';
import type { QueuedTurnEdit } from '../../shared/maestro-lib/client/types';

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
	/** The model and effort it was queued with (a field left out: the agent's default). */
	turnSettings?: { model?: string; effort?: string };
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

export interface QueueEditOptions {
	agent?: string;
	text?: string;
	model?: string;
	effort?: string;
}

export interface QueueMoveOptions {
	agent?: string;
	to?: string;
	tab?: string;
}

export interface QueueSendNowOptions {
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
	const peer = peerQueueTarget(options.agent);
	if (peer) return queueListPeer(peer);
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

/** `--agent` as a peer target, or null for a local agent (and always null while Federation is off). */
function peerQueueTarget(agent: string | undefined): PeerTarget | null {
	if (!agent) return null;
	const route = routeAgentTarget(agent);
	return route.kind === 'peer' ? route.target : null;
}

/** A failed peer call, in the queue verbs' JSON shape, with the `PEER_*` code and its exit code. */
function failPeer(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const peerError = error instanceof PeerResolveError ? error : undefined;
	console.log(
		JSON.stringify(
			{
				success: false,
				error: message,
				code: peerError ? peerErrorCode(peerError.code) : 'COMMAND_FAILED',
				...(peerError ? { peer: peerError.peer } : {}),
			},
			null,
			2
		)
	);
	exitWith(peerError?.exitCode ?? ExitCode.GeneralError);
}

/** `queue list --agent <peer:agent>`: the host's queue, in the local verb's shape plus `peer`. */
async function queueListPeer(target: PeerTarget): Promise<void> {
	let read: { peer: string; queue: QueueListSession };
	try {
		read = await withPeerAgent(target, async ({ agent, client, peer }) => {
			const listed = await client.turns.queue.list(agent.id);
			if (!listed.ok) throw hostCallError(peer, listed.error);
			return {
				peer,
				queue: {
					sessionId: peerAgentRef(peer, agent.id),
					name: agent.name,
					state: agent.state ?? 'idle',
					// Without the images, as the local verb lists them: data URLs are not for a terminal.
					items: queuedTurnsToWire(listed.value.map(({ images: _images, ...turn }) => turn)),
				},
			};
		});
	} catch (error) {
		failPeer(error);
		return;
	}
	const queues = [read.queue];
	console.log(
		JSON.stringify(
			{ success: true, queues, totalItems: countItems(queues), peer: read.peer },
			null,
			2
		)
	);
}

/**
 * One queue action on a peer's agent. `report` reads the host's answer into the fields the JSON
 * reply adds, or null when the action did not take: by default the message no longer waits there
 * (it started, or another client took it out), the local verbs' ITEM_NOT_FOUND. `refused` names a
 * verb's own failure instead (merge's NOT_MERGEABLE).
 */
async function queueActPeer(
	target: PeerTarget,
	itemId: string,
	action: PeerAgentAction,
	report: (result: PeerAgentActionResult) => Record<string, unknown> | null,
	refused: (agentRef: string) => { message: string; code: string } = (agentRef) => ({
		message: `No queued item with id ${itemId} for agent ${agentRef}`,
		code: 'ITEM_NOT_FOUND',
	})
): Promise<void> {
	let done: { peer: string; agentId: string; result: PeerAgentActionResult };
	try {
		done = await withPeerAgent(target, async ({ agent, client, peer }) => {
			const ran = await runPeerAgentAction(client, agent, action);
			if (!ran.ok) throw hostCallError(peer, ran.error);
			return { peer, agentId: agent.id, result: ran.value };
		});
	} catch (error) {
		failPeer(error);
		return;
	}
	const agentRef = peerAgentRef(done.peer, done.agentId);
	const fields = report(done.result);
	if (!fields) {
		const failure = refused(agentRef);
		emitError(failure.message, failure.code);
		process.exit(1);
		return;
	}
	console.log(
		JSON.stringify(
			{ success: true, agentId: agentRef, itemId, ...fields, peer: done.peer },
			null,
			2
		)
	);
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
	const peer = peerQueueTarget(options.agent);
	if (peer) {
		return queueActPeer(peer, itemId, { kind: 'remove-queued', itemId }, (result) =>
			result.kind === 'remove-queued' && result.removed ? { removed: true } : null
		);
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
	const peer = peerQueueTarget(options.agent);
	if (peer) {
		const held = verb === 'hold';
		return queueActPeer(peer, itemId, { kind: 'pause-queued', itemId, paused: held }, (result) =>
			result.kind === 'pause-queued' && result.found ? { paused: held } : null
		);
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

/** Why `queue merge` did nothing, for a local agent and a peer's alike. */
function notMergeableMessage(itemId: string, agent: string): string {
	return `Queued item ${itemId} for agent ${agent} cannot be merged: it is gone, has no message above it on its tab, or one of the two is not a plain message`;
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
	const peer = peerQueueTarget(options.agent);
	if (peer) {
		return queueActPeer(
			peer,
			itemId,
			{ kind: 'merge-queued', itemId },
			(result) =>
				result.kind === 'merge-queued' && result.merged
					? { mergedIntoId: result.mergedIntoId }
					: null,
			(agentRef) => ({
				message: notMergeableMessage(itemId, agentRef),
				code: 'NOT_MERGEABLE',
			})
		);
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
			emitError(notMergeableMessage(itemId, sessionId), 'NOT_MERGEABLE');
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
 * `maestro-cli queue edit <item-id> --agent <id> --text <text> [--model <m>] [--effort <e>]` -
 * rewrite a queued message in place, like the Edit button on its queued card. It keeps its place,
 * hold, and images. `--model` / `--effort` replace the item's own pair (one left out means the
 * agent's default); with neither, the item keeps them. Fails with ITEM_NOT_FOUND when it no
 * longer waits.
 */
export async function queueEdit(itemId: string, options: QueueEditOptions): Promise<void> {
	if (!options.agent) {
		emitError('queue edit requires --agent <id>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}
	if (typeof options.text !== 'string' || !options.text.trim()) {
		emitError('queue edit requires --text <text>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}
	const turnSettings =
		options.model !== undefined || options.effort !== undefined
			? {
					...(options.model ? { model: options.model } : {}),
					...(options.effort ? { effort: options.effort } : {}),
				}
			: undefined;
	const edit: QueuedTurnEdit = { text: options.text, ...(turnSettings ? { turnSettings } : {}) };
	const peer = peerQueueTarget(options.agent);
	if (peer) {
		return queueActPeer(peer, itemId, { kind: 'edit-queued', itemId, edit }, (result) =>
			result.kind === 'edit-queued' && result.found ? {} : null
		);
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
			client.sendCommand<{ success?: boolean; found?: boolean; error?: string }>(
				{ type: 'edit_queue_item', sessionId, itemId, ...edit },
				'edit_queue_item_result'
			)
		);
		if (result.success === false) {
			emitError(result.error ?? 'Queue edit failed', 'EDIT_FAILED');
			process.exit(1);
			return;
		}
		if (!result.found) {
			emitError(`No queued item with id ${itemId} for agent ${sessionId}`, 'ITEM_NOT_FOUND');
			process.exit(1);
			return;
		}
		console.log(JSON.stringify({ success: true, agentId: sessionId, itemId }, null, 2));
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}

/**
 * `maestro-cli queue move <item-id> --agent <id> --to <position> [--tab <tab-id>]` - move a queued
 * item to another place, like dragging its queued card. `--to` counts from 0 (the first item that
 * waits); with `--tab` it counts only that tab's items, as the tab's queue list draws them. A
 * hosted agent's item moves on its host.
 */
export async function queueMove(itemId: string, options: QueueMoveOptions): Promise<void> {
	if (!options.agent) {
		emitError('queue move requires --agent <id>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}
	const toIndex = options.to !== undefined && /^\d+$/.test(options.to) ? Number(options.to) : NaN;
	if (!Number.isInteger(toIndex)) {
		emitError('queue move requires --to <position> (0 is the first item)', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}
	const tabId = options.tab?.trim() || undefined;
	const peer = peerQueueTarget(options.agent);
	if (peer) {
		return queueActPeer(
			peer,
			itemId,
			{ kind: 'move-queued', itemId, toIndex, ...(tabId ? { tabId } : {}) },
			(result) => (result.kind === 'move-queued' && result.moved ? { toIndex } : null)
		);
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
			client.sendCommand<{ success?: boolean; moved?: boolean; error?: string }>(
				{ type: 'move_queue_item', sessionId, itemId, toIndex, ...(tabId ? { tabId } : {}) },
				'move_queue_item_result'
			)
		);
		if (result.success === false) {
			emitError(result.error ?? 'Queue move failed', 'MOVE_FAILED');
			process.exit(1);
			return;
		}
		if (!result.moved) {
			emitError(
				`No queued item with id ${itemId} for agent ${sessionId} can move to position ${toIndex}`,
				'ITEM_NOT_FOUND'
			);
			process.exit(1);
			return;
		}
		console.log(JSON.stringify({ success: true, agentId: sessionId, itemId, toIndex }, null, 2));
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}

/**
 * `maestro-cli queue send-now <item-id> --agent <id>` - run a queued item now instead of in its
 * turn, like the Force Send button on its queued card. Never over a turn on its own tab; beside
 * another tab's turn it runs in parallel only when Forced Parallel Execution is on, as the button
 * does. A hosted agent's item runs on its host.
 */
export async function queueSendNow(itemId: string, options: QueueSendNowOptions): Promise<void> {
	if (!options.agent) {
		emitError('queue send-now requires --agent <id>', 'INVALID_OPTIONS');
		process.exit(1);
		return;
	}
	const peer = peerQueueTarget(options.agent);
	if (peer) {
		return queueActPeer(
			peer,
			itemId,
			{ kind: 'send-now-queued', itemId },
			(result) => (result.kind === 'send-now-queued' && result.sent ? {} : null),
			(agentRef) => ({
				message: `Queued item ${itemId} for agent ${agentRef} did not start: it is gone, its tab is mid-turn, or another tab is busy and Forced Parallel Execution is off`,
				code: 'NOT_SENT',
			})
		);
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
			client.sendCommand<{ success?: boolean; sent?: boolean; error?: string }>(
				{ type: 'send_queue_item_now', sessionId, itemId },
				'send_queue_item_now_result'
			)
		);
		if (result.success === false) {
			emitError(result.error ?? 'Queue send-now failed', 'SEND_FAILED');
			process.exit(1);
			return;
		}
		if (!result.sent) {
			emitError(
				`Queued item ${itemId} for agent ${sessionId} did not start: it is gone, its tab is mid-turn, or another tab is busy and Forced Parallel Execution is off`,
				'NOT_SENT'
			);
			process.exit(1);
			return;
		}
		console.log(JSON.stringify({ success: true, agentId: sessionId, itemId }, null, 2));
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
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

/** A steer's outcome in the verb's JSON shape; exits 1 with its code unless it delivered or settled. */
function reportSteerResult(
	agentId: string,
	itemId: string,
	result: QueueSteerResult,
	extra: Record<string, unknown> = {}
): void {
	const ok = result.outcome === 'delivered' || result.outcome === 'settled';
	const payload = {
		success: ok,
		agentId,
		itemId,
		...result,
		...(ok
			? {}
			: { code: STEER_FAILURE_CODES[result.outcome as keyof typeof STEER_FAILURE_CODES] }),
		...extra,
	};
	console.log(JSON.stringify(payload, null, 2));
	if (!ok) process.exit(1);
}

/**
 * `queue steer --agent <peer:agent>`: the host runs its own steer on its queue (a desktop host's
 * renderer runs the same steerQueuedItem() its Steer button does) and answers with the outcome.
 */
async function queueSteerPeer(target: PeerTarget, itemId: string): Promise<void> {
	let done: { peer: string; agentId: string; result: QueueSteerResult };
	try {
		done = await withPeerAgent(target, async ({ agent, client, peer }) => {
			const ran = await runPeerAgentAction(client, agent, { kind: 'steer-queued', itemId });
			if (!ran.ok) throw hostCallError(peer, ran.error);
			if (ran.value.kind !== 'steer-queued') {
				throw new Error(`The host answered the steer with ${ran.value.kind}.`);
			}
			return { peer, agentId: agent.id, result: ran.value.result };
		});
	} catch (error) {
		failPeer(error);
		return;
	}
	reportSteerResult(peerAgentRef(done.peer, done.agentId), itemId, done.result, {
		peer: done.peer,
	});
}

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
	const peer = peerQueueTarget(options.agent);
	if (peer) return queueSteerPeer(peer, itemId);

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
		reportSteerResult(sessionId, itemId, result);
	} catch (error) {
		const mapped = mapQueueError(error);
		emitError(mapped.error, mapped.code);
		process.exit(1);
	}
}
