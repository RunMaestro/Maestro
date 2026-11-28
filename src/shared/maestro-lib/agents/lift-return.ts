/**
 * Moving a hosted agent back from its Federation host: the reverse of a lift. Shared by
 * `maestro-cli unlift` and the desktop's "Move Back from Host" right-click action.
 *
 * A lift kept the local record (every tab and transcript) and gave it a `liftedTo` pointer. Moving
 * back turns that pointer into an SSH agent again:
 *
 * 1. Refusals that cost no dial: not hosted, or no SSH remote to run on once it is back.
 * 2. The host's copy is read: its tabs, each tab's transcript, and its queue. A running turn is
 *    refused: it would be lost. Each waiting message is held on the host first (so the host cannot
 *    start it while this runs; one that started anyway is a running turn), then comes back into the
 *    local queue. The host's tab ids and provider session ids are the ones the lift sent, so a tab
 *    that moved comes back onto its own local tab, and the next turn over SSH resumes the same
 *    provider session.
 * 3. The local record is restored (`withReturnedFromHost()`): no pointer, the host's tabs merged
 *    in, and `hostedOptOut`, so automatic Federation does not move it straight back.
 * 4. The host's copy is removed, unless the caller keeps it, so the agent has one owner again. A
 *    kept copy loses the messages that came back, so they cannot run twice.
 *
 * `offline` skips 2 and 4 for a host that cannot be reached: the agent comes back with only what
 * this machine kept, and the result says the host's copy is still there.
 *
 * Tabs are never dropped: a local tab the host no longer has stays, and a host transcript shorter
 * than the local one does not replace it.
 */

import type { ClientError, MaestroClient } from '../client/types';
import type { AITabRecord, AgentRecord } from '../store/records';
import { peerAgentRef, readLiftedTo, type LiftedToPointer } from './lift-pointer';
import { LiftRunError } from './lift-run';
import type { ReturnedFromHost } from './lift-return-record';

export {
	readReturnedFromHost,
	returnRestoreRefusal,
	withReturnedFromHost,
	type ReturnedFromHost,
} from './lift-return-record';

export interface ReturnRunOptions {
	/** The host cannot be reached: restore from this machine's copy only, and keep the host's. */
	offline?: boolean;
	/** Leave the agent on the host too (it then has two owners until one is removed). */
	keepHostCopy?: boolean;
}

/** A client attached to the agent's host. `release()` is the caller's. */
export interface ReturnHostConnection {
	peer: string;
	client: Pick<MaestroClient, 'agents' | 'tabs' | 'turns'>;
	release(): Promise<void>;
}

export interface ReturnRunDeps {
	readAgents(): AgentRecord[];
	/** The agent id `ref` names. Throws when it names none. Default: `ref` is the id. */
	resolveAgentId?(ref: string): string;
	/** Reach the host that runs on SSH remote `remoteId`. Throws when it cannot. */
	connect(remoteId: string, peer: string): Promise<ReturnHostConnection>;
	hostCallError?(peer: string, error: Pick<ClientError, 'code' | 'message'>): Error;
	/** Write the restored record (see `withReturnedFromHost()`). Throws on failure. */
	restore(agentId: string, returned: ReturnedFromHost): Promise<void>;
}

export interface ReturnResult {
	agent: { id: string; name: string };
	/** `peer:agentId` the agent was hosted as. */
	from: string;
	/** Host tabs read back (0 when offline). */
	tabs: number;
	/** Host tabs this machine did not have, added as new tabs. */
	newTabs: number;
	/** Messages that waited in the host's queue and now wait in this one. */
	queued?: number;
	hostCopyRemoved: boolean;
	notices?: string[];
}

function defaultHostCallError(peer: string, error: Pick<ClientError, 'code' | 'message'>): Error {
	return new LiftRunError('RETURN_HOST_FAILED', `Peer "${peer}": ${error.message}`);
}

function sshRemoteIdOf(agent: AgentRecord): string | undefined {
	const ssh = (agent as { sessionSshRemoteConfig?: { enabled?: boolean; remoteId?: unknown } })
		.sessionSshRemoteConfig;
	return ssh?.enabled && typeof ssh.remoteId === 'string' && ssh.remoteId
		? ssh.remoteId
		: undefined;
}

/**
 * Every step of moving a hosted agent back. Throws `LiftRunError` (`RETURN_*` codes), or whatever
 * `connect` / `hostCallError` throw.
 */
export async function runReturnFromHost(
	agentRef: string,
	options: ReturnRunOptions,
	deps: ReturnRunDeps
): Promise<ReturnResult> {
	let agentId: string;
	try {
		agentId = deps.resolveAgentId ? deps.resolveAgentId(agentRef) : agentRef;
	} catch (error) {
		throw new LiftRunError(
			'AGENT_NOT_FOUND',
			error instanceof Error ? error.message : String(error)
		);
	}
	const agent = deps.readAgents().find((record) => record.id === agentId);
	if (!agent) throw new LiftRunError('AGENT_NOT_FOUND', `Agent not found: ${agentRef}`);
	const pointer: LiftedToPointer | undefined = readLiftedTo(agent.liftedTo);
	if (!pointer) {
		throw new LiftRunError(
			'RETURN_NOT_HOSTED',
			`"${agent.name}" is not hosted: nothing to move back.`
		);
	}
	const remoteId = sshRemoteIdOf(agent);
	if (!remoteId) {
		throw new LiftRunError(
			'RETURN_NO_SSH',
			`"${agent.name}" has no SSH remote to run on once it is back. Set one in Edit Agent first.`
		);
	}
	const from = peerAgentRef(pointer.peer, pointer.agentId);
	const summary = { id: agent.id, name: agent.name };

	if (options.offline) {
		await restoreOrThrow(deps, agent, { tabs: [] });
		return {
			agent: summary,
			from,
			tabs: 0,
			newTabs: 0,
			hostCopyRemoved: false,
			notices: [
				`The host was not reached, so conversations started there after the move stay there, and its copy (${from}) still exists. Remove it on the host when it is back: maestro-cli remove-agent ${pointer.agentId}`,
			],
		};
	}

	const connection = await deps.connect(remoteId, pointer.peer);
	try {
		const hostError = deps.hostCallError ?? defaultHostCallError;
		const notices: string[] = [];
		let returned: ReturnedFromHost = { tabs: [] };
		/** Messages this return held on the host: released again when the return fails. */
		const heldIds: string[] = [];
		const hostAgent = await connection.client.agents.get(pointer.agentId);
		const hostGone = !hostAgent.ok && hostAgent.error.code === 'not-found';
		if (!hostAgent.ok && !hostGone) throw hostError(connection.peer, hostAgent.error);

		if (hostAgent.ok) {
			const busy = (hostAgent.value.aiTabs ?? []).some((tab) => tab.state === 'busy');
			if (busy) {
				throw new LiftRunError(
					'RETURN_BUSY',
					`"${agent.name}" is running a turn on its host. Wait for it to finish, or stop it, then move it back.`
				);
			}
			const queue = await connection.client.turns.queue.list(pointer.agentId);
			if (!queue.ok) throw hostError(connection.peer, queue.error);
			// Hold each waiting message on the host, so it cannot start there while it moves here.
			for (const item of queue.value) {
				if (item.paused) continue;
				const held = await connection.client.turns.queue.setPaused(
					pointer.agentId,
					item.itemId,
					true
				);
				if (!held.ok) {
					await releaseHeld(connection, pointer.agentId, heldIds);
					throw hostError(connection.peer, held.error);
				}
				if (!held.value.found) {
					await releaseHeld(connection, pointer.agentId, heldIds);
					throw new LiftRunError(
						'RETURN_BUSY',
						`"${agent.name}" started a queued message on its host. Wait for it to finish, then move it back.`
					);
				}
				heldIds.push(item.itemId);
			}
			const failRead = async (error: Pick<ClientError, 'code' | 'message'>): Promise<never> => {
				await releaseHeld(connection, pointer.agentId, heldIds);
				throw hostError(connection.peer, error);
			};
			const tabs = await connection.client.tabs.list(pointer.agentId);
			if (!tabs.ok) return failRead(tabs.error);
			const withLogs: AITabRecord[] = [];
			for (const tab of tabs.value) {
				const transcript = await connection.client.tabs.transcript(pointer.agentId, tab.id);
				if (!transcript.ok) return failRead(transcript.error);
				withLogs.push({ ...tab, logs: transcript.value });
			}
			returned = {
				tabs: withLogs,
				...(hostAgent.value.activeTabId ? { activeTabId: hostAgent.value.activeTabId } : {}),
				...(queue.value.length > 0
					? {
							queue: queue.value.map((item) => ({
								itemId: item.itemId,
								tabId: item.tabId,
								queuedAt: item.queuedAt,
								text: item.text,
								paused: item.paused,
							})),
						}
					: {}),
			};
		} else {
			notices.push(
				`The host no longer has ${from}: the agent comes back with this machine's copy.`
			);
		}

		try {
			await restoreOrThrow(deps, agent, returned);
		} catch (error) {
			await releaseHeld(connection, pointer.agentId, heldIds);
			throw error;
		}

		let hostCopyRemoved = false;
		if (hostAgent.ok && !options.keepHostCopy) {
			const removed = await connection.client.agents.remove(pointer.agentId);
			if (removed.ok) hostCopyRemoved = true;
			else {
				notices.push(
					`The agent is back, but its copy on the host (${from}) could not be removed: ${removed.error.message} On the remote, run: maestro-cli remove-agent ${pointer.agentId}`
				);
			}
		} else if (hostAgent.ok) {
			notices.push(`The host keeps its copy (${from}). Do not send to both.`);
			for (const item of returned.queue ?? []) {
				const removed = await connection.client.turns.queue.remove(pointer.agentId, item.itemId);
				if (!removed.ok) {
					notices.push(
						`A message that came back still waits, held, in the host's queue (${from}): ${removed.error.message} Remove it there so it does not run twice.`
					);
				}
			}
		}

		const localIds = new Set((agent.aiTabs ?? []).map((tab) => tab.id));
		return {
			agent: summary,
			from,
			tabs: returned.tabs.length,
			newTabs: returned.tabs.filter((tab) => !localIds.has(tab.id)).length,
			...(returned.queue?.length ? { queued: returned.queue.length } : {}),
			hostCopyRemoved,
			...(notices.length > 0 ? { notices } : {}),
		};
	} finally {
		await connection.release();
	}
}

/**
 * Let the host run the messages this return held, because the return failed. A failure to release
 * one is not reported over the error the caller is about to see: that message stays held on the
 * host, where Hold / Resume reaches it.
 */
async function releaseHeld(
	connection: ReturnHostConnection,
	hostAgentId: string,
	heldIds: string[]
): Promise<void> {
	for (const itemId of heldIds) {
		await connection.client.turns.queue.setPaused(hostAgentId, itemId, false);
	}
}

async function restoreOrThrow(
	deps: ReturnRunDeps,
	agent: AgentRecord,
	returned: ReturnedFromHost
): Promise<void> {
	try {
		await deps.restore(agent.id, returned);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new LiftRunError(
			'RETURN_RESTORE_FAILED',
			`Could not move "${agent.name}" back: ${message}. Nothing changed on the host.`
		);
	}
}
