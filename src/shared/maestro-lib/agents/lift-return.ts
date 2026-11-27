/**
 * Moving a hosted agent back from its Federation host: the reverse of a lift. Shared by
 * `maestro-cli unlift` and the desktop's "Move Back from Host" right-click action.
 *
 * A lift kept the local record (every tab and transcript) and gave it a `liftedTo` pointer. Moving
 * back turns that pointer into an SSH agent again:
 *
 * 1. Refusals that cost no dial: not hosted, or no SSH remote to run on once it is back.
 * 2. The host's copy is read: its tabs and each tab's transcript. A running turn or a message that
 *    still waits in the host's queue is refused: it would be lost or run twice. The host's tab ids
 *    and provider session ids are the ones the lift sent, so a tab that moved comes back onto its
 *    own local tab, and the next turn over SSH resumes the same provider session.
 * 3. The local record is restored (`withReturnedFromHost()`): no pointer, the host's tabs merged
 *    in, and `hostedOptOut`, so automatic Federation does not move it straight back.
 * 4. The host's copy is removed, unless the caller keeps it, so the agent has one owner again.
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
import type { ReturnedFromHost, ReturnedHeldItem } from './lift-return-record';

export {
	readLeftOnHost,
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
	hostCopyRemoved: boolean;
	notices?: string[];
}

function defaultHostCallError(peer: string, error: Pick<ClientError, 'code' | 'message'>): Error {
	return new LiftRunError('RETURN_HOST_FAILED', `Peer "${peer}": ${error.message}`);
}

/**
 * What to do about a host copy left behind, named as commands run on THIS machine once the host is
 * back: `peer:agent` reaches the host over Federation, a headless host as well as a desktop one.
 */
export function hostCopyLeftAdvice(from: string): string {
	return `Moving the agent to the host again replaces that copy. To remove it instead, once the host is back: maestro-cli remove-agent ${from} (check it with: maestro-cli show agent ${from}).`;
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
		await restoreOrThrow(deps, agent, { tabs: [], leftOnHost: pointer });
		return {
			agent: summary,
			from,
			tabs: 0,
			newTabs: 0,
			hostCopyRemoved: false,
			notices: [
				`The host was not reached, so conversations started there after the move stay there, and its copy (${from}) still exists. ${hostCopyLeftAdvice(from)}`,
			],
		};
	}

	const connection = await deps.connect(remoteId, pointer.peer);
	try {
		const hostError = deps.hostCallError ?? defaultHostCallError;
		const notices: string[] = [];
		let returned: ReturnedFromHost = { tabs: [] };
		let heldQueue: ReturnedHeldItem[] = [];
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
			// A message the person held (paused) comes home held, with the agent (R50). One that
			// waits to run would run there or here, or twice: refused. With the host's copy kept, a
			// held one would be held on both: refused too.
			const waiting = queue.value.filter(
				(item) => item.paused !== true || options.keepHostCopy === true
			);
			if (waiting.length > 0) {
				throw new LiftRunError(
					'RETURN_QUEUED',
					`${waiting.length} message(s) still wait in "${agent.name}"'s queue on its host. Let them run or remove them, then move it back.`
				);
			}
			heldQueue = queue.value.map((item) => ({
				id: item.itemId,
				tabId: item.tabId,
				timestamp: item.queuedAt,
				kind: item.kind,
				text: item.text,
				...(item.images && item.images.length > 0 ? { images: item.images } : {}),
				...(item.turnSettings ? { turnSettings: item.turnSettings } : {}),
			}));
			const tabs = await connection.client.tabs.list(pointer.agentId);
			if (!tabs.ok) throw hostError(connection.peer, tabs.error);
			const withLogs: AITabRecord[] = [];
			for (const tab of tabs.value) {
				const transcript = await connection.client.tabs.transcript(pointer.agentId, tab.id);
				if (!transcript.ok) throw hostError(connection.peer, transcript.error);
				withLogs.push({ ...tab, logs: transcript.value });
			}
			// A held message waits for a tab that comes home (one the host lists, or this machine
			// has): one for a tab the host does not list (a hidden consult tab) would be dropped by
			// the restore and lost with the host's copy. Refused, nothing changed (CodeRabbit on #2171).
			const restorable = new Set([
				...tabs.value.map((tab) => tab.id),
				...(agent.aiTabs ?? []).map((tab) => tab.id),
			]);
			if (heldQueue.some((item) => !restorable.has(item.tabId))) {
				throw new LiftRunError(
					'RETURN_QUEUED',
					`"${agent.name}" has a held message on its host for a tab that does not come back. Nothing changed; send or remove that message, then move it back.`
				);
			}
			// The held messages come home only as they were listed: one another client resumed or
			// sent on the host while the tabs were read could run there and come home held too
			// (CodeRabbit on #2171). Read the queue again just before the restore; any change refuses
			// the move with nothing changed.
			if (heldQueue.length > 0) {
				const again = await connection.client.turns.queue.list(pointer.agentId);
				if (!again.ok) throw hostError(connection.peer, again.error);
				const unchanged =
					again.value.length === heldQueue.length &&
					again.value.every(
						(item) => item.paused === true && heldQueue.some((held) => held.id === item.itemId)
					);
				if (!unchanged) {
					throw new LiftRunError(
						'RETURN_QUEUED',
						`"${agent.name}"'s queue on its host changed while it was being moved back. Nothing changed; move it back again.`
					);
				}
			}
			returned = {
				tabs: withLogs,
				...(hostAgent.value.activeTabId ? { activeTabId: hostAgent.value.activeTabId } : {}),
				...(heldQueue.length > 0 ? { heldQueue } : {}),
			};
		} else {
			notices.push(
				`The host no longer has ${from}: the agent comes back with this machine's copy.`
			);
		}

		// The host's copy is recorded on the agent until its removal is confirmed (it is removed
		// below, after the restore), so a kept copy, or one whose removal fails, is replaced by a
		// later Move to Host. A pointer to a copy since removed is harmless: the lift finds no copy.
		await restoreOrThrow(
			deps,
			agent,
			hostAgent.ok ? { ...returned, leftOnHost: pointer } : returned
		);

		let hostCopyRemoved = false;
		if (hostAgent.ok && !options.keepHostCopy) {
			const removed = await connection.client.agents.remove(pointer.agentId);
			if (removed.ok) hostCopyRemoved = true;
			else {
				notices.push(
					`The agent is back, but its copy on the host (${from}) could not be removed: ${removed.error.message} ${hostCopyLeftAdvice(from)}`
				);
			}
		} else if (hostAgent.ok) {
			notices.push(`The host keeps its copy (${from}). Do not send to both.`);
		}

		const localIds = new Set((agent.aiTabs ?? []).map((tab) => tab.id));
		return {
			agent: summary,
			from,
			tabs: returned.tabs.length,
			newTabs: returned.tabs.filter((tab) => !localIds.has(tab.id)).length,
			hostCopyRemoved,
			...(notices.length > 0 ? { notices } : {}),
		};
	} finally {
		await connection.release();
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
