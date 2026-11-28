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
 * The restore in 3 records the copy still to remove (`hostCopyLeft`), and a second write clears it
 * once 4 is done. A crash, a lost link, or a refused removal in between leaves the agent home with
 * the marker, and the next return of that agent (the come-home job at the next launch) finishes:
 * the copy may have taken turns or messages since, so it is read again (transcripts merge row by
 * row, so nothing comes twice), the queue items that came home already (`carried`) are skipped,
 * and then the copy is removed.
 *
 * `offline` skips 2 and 4 for a host that cannot be reached (and needs no SSH remote, so an agent
 * whose SSH settings are off or gone is never stranded): the agent comes back with only what
 * this machine kept, and the result says the host's copy is still there. The marker says so too
 * (`fetched: false`): a later return that reaches the host brings what the host wrote since (the
 * transcripts merge row by row, so the rows this machine wrote meanwhile stay), then removes it.
 *
 * Tabs are never dropped: a local tab the host no longer has stays, and a host transcript shorter
 * than the local one does not replace it.
 */

import type { ClientError, MaestroClient } from '../client/types';
import type { AITabRecord, AgentRecord } from '../store/records';
import { peerAgentRef, readLiftedTo, type LiftedToPointer } from './lift-pointer';
import { LiftRunError } from './lift-run';
import { readHostCopyLeft, type HostCopyLeft, type ReturnedFromHost } from './lift-return-record';

export {
	readHostCopyLeft,
	readReturnedFromHost,
	returnRestoreRefusal,
	withReturnedFromHost,
	type HostCopyLeft,
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
	/** Epoch milliseconds, for `HostCopyLeft.returnedAt`. Default `Date.now()`. */
	now?(): number;
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
	// Home already, with a host copy an earlier return did not get to remove: finish that return.
	const left: HostCopyLeft | undefined = readLiftedTo(agent.liftedTo)
		? undefined
		: readHostCopyLeft(agent.hostCopyLeft);
	const pointer: LiftedToPointer | undefined = readLiftedTo(agent.liftedTo) ?? left;
	if (!pointer) {
		throw new LiftRunError(
			'RETURN_NOT_HOSTED',
			`"${agent.name}" is not hosted: nothing to move back.`
		);
	}
	const from = peerAgentRef(pointer.peer, pointer.agentId);
	const summary = { id: agent.id, name: agent.name };
	const now = deps.now ?? Date.now;
	const copyLeft = (fetched: boolean, carried: readonly string[] = []): HostCopyLeft => {
		const all = [...new Set([...(left?.carried ?? []), ...carried])];
		return {
			peer: pointer.peer,
			agentId: pointer.agentId,
			at: pointer.at,
			fetched: fetched || left?.fetched === true,
			returnedAt: left?.returnedAt ?? now(),
			...(all.length > 0 ? { carried: all } : {}),
		};
	};

	if (options.offline) {
		if (left) {
			throw new LiftRunError(
				'RETURN_NOT_HOSTED',
				`"${agent.name}" is home already. Its copy on the host (${from}) is removed once the host answers.`
			);
		}
		await restoreOrThrow(deps, agent, { tabs: [], hostCopyLeft: copyLeft(false) });
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

	// Only the offline return above may run without an SSH remote: the host is reached through it.
	const remoteId = sshRemoteIdOf(agent);
	if (!remoteId) {
		throw new LiftRunError(
			'RETURN_NO_SSH',
			`"${agent.name}" has no SSH remote to reach its host through. Move it back offline, or set one in Edit Agent first.`
		);
	}
	const connection = await deps.connect(remoteId, pointer.peer);
	let released = false;
	try {
		const hostError = deps.hostCallError ?? defaultHostCallError;
		const notices: string[] = [];
		let returned: ReturnedFromHost = { tabs: [] };
		/** Messages this return held on the host: released again when the return fails. */
		const heldIds: string[] = [];
		/** Items an earlier return brought home that still wait, held, in the host copy. */
		let carriedOnHost: string[] = [];
		const hostAgent = await connection.client.agents.get(pointer.agentId);
		const hostGone = !hostAgent.ok && hostAgent.error.code === 'not-found';
		if (!hostAgent.ok && !hostGone) throw hostError(connection.peer, hostAgent.error);
		/** Queue items an earlier return of this agent brought home already. */
		const carried = new Set(left?.carried ?? []);

		if (hostAgent.ok) {
			const busy = (hostAgent.value.aiTabs ?? []).some((tab) => tab.state === 'busy');
			if (busy) {
				throw new LiftRunError(
					'RETURN_BUSY',
					left
						? `The old copy of "${agent.name}" on its host is running a turn. Wait for it to finish, then it is removed.`
						: `"${agent.name}" is running a turn on its host. Wait for it to finish, or stop it, then move it back.`
				);
			}
			const listed = await connection.client.turns.queue.list(pointer.agentId);
			if (!listed.ok) throw hostError(connection.peer, listed.error);
			const queue = listed.value.filter((item) => !carried.has(item.itemId));
			carriedOnHost = listed.value
				.filter((item) => carried.has(item.itemId))
				.map((item) => item.itemId);
			// Hold each waiting message on the host, so it cannot start there while it moves here.
			for (const item of queue) {
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
			if (!tabs.ok) return await failRead(tabs.error);
			const withLogs: AITabRecord[] = [];
			for (const tab of tabs.value) {
				const transcript = await connection.client.tabs.transcript(pointer.agentId, tab.id);
				if (!transcript.ok) return await failRead(transcript.error);
				withLogs.push({ ...tab, logs: transcript.value });
			}
			// A turn may have started on the host since the first look (a message that left the queue
			// before it was held, or a send typed on the host): look again before anything is written.
			const recheck = await connection.client.agents.get(pointer.agentId);
			if (!recheck.ok) return await failRead(recheck.error);
			if ((recheck.value.aiTabs ?? []).some((tab) => tab.state === 'busy')) {
				await releaseHeld(connection, pointer.agentId, heldIds);
				throw new LiftRunError(
					'RETURN_BUSY',
					`"${agent.name}" started a turn on its host. Wait for it to finish, then move it back.`
				);
			}
			returned = {
				tabs: withLogs,
				...(options.keepHostCopy
					? {}
					: {
							hostCopyLeft: copyLeft(
								true,
								queue.map((item) => item.itemId)
							),
						}),
				...(hostAgent.value.activeTabId ? { activeTabId: hostAgent.value.activeTabId } : {}),
				...(queue.length > 0
					? {
							queue: queue.map((item) => ({
								itemId: item.itemId,
								tabId: item.tabId,
								queuedAt: item.queuedAt,
								text: item.text,
								paused: item.paused,
								...(item.kind === 'command' ? { kind: item.kind } : {}),
							})),
						}
					: {}),
			};
		} else if (!left) {
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

		// The agent is home from here on: a failure is the host copy's, reported, never the agent's.
		let hostCopyRemoved = false;
		try {
			if (hostAgent.ok && !options.keepHostCopy) {
				const removed = await connection.client.agents.remove(pointer.agentId);
				if (removed.ok) {
					hostCopyRemoved = true;
					await clearHostCopyLeft(deps, agent, notices);
				} else {
					notices.push(
						`The agent is back, but its copy on the host (${from}) could not be removed: ${removed.error.message} Maestro removes it at the next launch, or on the remote run: maestro-cli remove-agent ${pointer.agentId}`
					);
				}
			} else if (hostAgent.ok) {
				notices.push(`The host keeps its copy (${from}). Do not send to both.`);
				const cameHome = [...(returned.queue ?? []).map((item) => item.itemId), ...carriedOnHost];
				for (const itemId of cameHome) {
					const removed = await connection.client.turns.queue.remove(pointer.agentId, itemId);
					if (!removed.ok) {
						notices.push(
							`A message that came back still waits, held, in the host's queue (${from}): ${removed.error.message} Remove it there so it does not run twice.`
						);
					}
				}
			}
		} catch (error) {
			notices.push(
				options.keepHostCopy
					? `The agent is back, but the host (${from}) stopped answering before the messages that came back left its queue: ${errorText(error)} Remove them there so they do not run twice.`
					: `The agent is back, but the host (${from}) stopped answering before its copy was removed: ${errorText(error)} Maestro removes it at the next launch.`
			);
		}
		released = true;
		try {
			await connection.release();
		} catch (error) {
			notices.push(
				`The agent is back, but the connection to ${from} did not close: ${errorText(error)}`
			);
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
		if (!released) await connection.release();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The host copy is gone: write the record without the marker, so no later run dials for it. A
 * failure here is not the agent's: it is home, and the next run finds the copy gone and clears the
 * marker then. Reported as a notice.
 */
async function clearHostCopyLeft(
	deps: ReturnRunDeps,
	agent: AgentRecord,
	notices: string[]
): Promise<void> {
	try {
		await deps.restore(agent.id, { tabs: [] });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notices.push(
			`The host copy is removed, but "${agent.name}" could not be saved without its note of it (${message}). Maestro clears it at the next launch.`
		);
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
