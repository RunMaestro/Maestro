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
 * 4. The History the host copy wrote comes home (`lift-history.ts`), re-filed under the local id,
 *    before anything else is written, so the agent's History stays one list.
 * 5. The host's copy is removed, unless the caller keeps it, so the agent has one owner again. A
 *    host that does not send an agent's History (an older Maestro) keeps its copy too: that History
 *    stays with it, and the result says so.
 *
 * `offline` skips 2, 4, and 5 for a host that cannot be reached: the agent comes back with only
 * what this machine kept, and the result says the host's copy, and the History it wrote, are still
 * there (the next Move to Host brings that History home). `dryRun` reads 2 and 4 and stops: the
 * counts a person confirms before anything moves.
 *
 * Tabs are never dropped: a local tab the host no longer has stays, and a host transcript shorter
 * than the local one does not replace it.
 */

import type { ClientError, MaestroClient } from '../client/types';
import type { AITabRecord, AgentRecord } from '../store/records';
import type { HistoryEntry } from '../../types';
import { peerAgentRef, readLiftedTo, type LiftedToPointer } from './lift-pointer';
import { LiftRunError } from './lift-run';
import { readLeftOnHost, type ReturnedFromHost, type ReturnedHeldItem } from './lift-return-record';
import {
	bringHostHistoryHome,
	historyEntryCount,
	hostHistoryUnsupportedNotice,
	planHostHistoryHome,
	type AgentHistoryStore,
} from './lift-history';

export { describeReturn } from './lift-history';

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
	/** Read what would come back (tabs, History) and stop: nothing is written on either side. */
	dryRun?: boolean;
}

/** A client attached to the agent's host. `release()` is the caller's. */
export interface ReturnHostConnection {
	peer: string;
	client: Pick<MaestroClient, 'agents' | 'tabs' | 'turns' | 'history'>;
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
	/** This machine's History of its agents: the host copy's entries come home into it. */
	history: AgentHistoryStore;
}

export interface ReturnResult {
	agent: { id: string; name: string };
	/** `peer:agentId` the agent was hosted as. */
	from: string;
	/** Host tabs read back (0 when offline). */
	tabs: number;
	/** Host tabs this machine did not have, added as new tabs. */
	newTabs: number;
	/** History entries the host copy wrote that came home (0 when offline or none). */
	history: number;
	hostCopyRemoved: boolean;
	/**
	 * The host's copy stays (or would stay, on a dry run): kept on request, the host not reached,
	 * or a host that does not send its History (the copy keeps it).
	 */
	hostCopyKept?: boolean;
	/** Set on a dry run: the counts are what WOULD come back; nothing was written. */
	dryRun?: boolean;
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

/**
 * The notice of a copy an earlier Move Back left on ANOTHER host that this move can no longer
 * track (the agent holds one such pointer): the History written there stays with that copy.
 */
function untrackedCopyNotice(earlier: LiftedToPointer): string {
	const ref = peerAgentRef(earlier.peer, earlier.agentId);
	return `The copy an earlier Move Back left on ${earlier.peer} (${ref}) is no longer tracked, and the History written there stays with it. Remove it once it is not needed: maestro-cli remove-agent ${ref}`;
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
	// A copy an earlier offline Move Back left on ANOTHER host, with the History written there: the
	// pointer survives a lift to this host (the lift only sets `liftedTo`), and this Move Back keeps
	// it whenever this host's copy is gone after it, so the next Move to Host onto that host still
	// brings that History home (L45 a).
	const earlier = readLeftOnHost(agent);
	const earlierElsewhere = earlier && earlier.peer !== pointer.peer ? earlier : undefined;

	if (options.offline) {
		if (!options.dryRun) await restoreOrThrow(deps, agent, { tabs: [], leftOnHost: pointer });
		return {
			agent: summary,
			from,
			tabs: 0,
			newTabs: 0,
			history: 0,
			hostCopyRemoved: false,
			hostCopyKept: true,
			...(options.dryRun ? { dryRun: true } : {}),
			notices: [
				`The host was not reached, so conversations started there after the move stay there, and so does the History written there; its copy (${from}) still exists. The next Move to Host onto ${pointer.peer} brings that History home. ${hostCopyLeftAdvice(from)}`,
				...(earlierElsewhere ? [untrackedCopyNotice(earlierElsewhere)] : []),
			],
		};
	}

	const connection = await deps.connect(remoteId, pointer.peer);
	try {
		const hostError = deps.hostCallError ?? defaultHostCallError;
		const notices: string[] = [];
		let returned: ReturnedFromHost = { tabs: [] };
		let heldQueue: ReturnedHeldItem[] = [];
		let historyHome: HistoryEntry[] = [];
		// The host does not send an agent's History: its copy, which holds that History, is kept.
		let historyStaysOnHost = false;
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
			// The History the copy wrote, read before anything changes: a copy whose History cannot be
			// read is not removed, and nothing moves.
			try {
				const planned = await planHostHistoryHome(
					connection.client.history,
					pointer.agentId,
					agent.id,
					deps.history
				);
				if (planned === null) {
					historyStaysOnHost = true;
					notices.push(hostHistoryUnsupportedNotice(connection.peer, from));
				} else historyHome = planned;
			} catch (error) {
				throw new LiftRunError(
					'RETURN_HISTORY_FAILED',
					`Could not move "${agent.name}" back: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`
				);
			}
			// The host keeps its copy then, so a held message would be held on both sides and could
			// run twice: refused, as with the copy kept on request (CodeRabbit on #2181).
			if (historyStaysOnHost && heldQueue.length > 0) {
				throw new LiftRunError(
					'RETURN_QUEUED',
					`"${agent.name}" has ${heldQueue.length} held message(s) on its host, and the host keeps its copy (it does not send an agent's History). Nothing changed; send or remove them there, then move it back.`
				);
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

		const localIds = new Set((agent.aiTabs ?? []).map((tab) => tab.id));
		const newTabs = returned.tabs.filter((tab) => !localIds.has(tab.id)).length;
		if (options.dryRun) {
			return {
				agent: summary,
				from,
				tabs: returned.tabs.length,
				newTabs,
				history: historyHome.length,
				hostCopyRemoved: false,
				...(hostAgent.ok && (options.keepHostCopy || historyStaysOnHost)
					? { hostCopyKept: true }
					: {}),
				dryRun: true,
				...(notices.length > 0 ? { notices } : {}),
			};
		}

		// The History comes home first: when it cannot be written here, nothing has changed yet.
		let history = 0;
		try {
			history = await bringHostHistoryHome(deps.history, agent.id, historyHome);
		} catch (error) {
			throw new LiftRunError(
				'RETURN_HISTORY_FAILED',
				`Could not move "${agent.name}" back: ${historyEntryCount(historyHome.length)} from the host could not be written here (${error instanceof Error ? error.message : String(error)}). Nothing changed on the host.`
			);
		}

		// The held messages come home only as they were listed: one another client resumed or
		// sent on the host while the tabs were read could run there and come home held too
		// (CodeRabbit on #2171). Read the queue again after the History came home, just before the
		// restore; any change refuses the move with nothing changed on the host (the History written
		// here is the agent's own, filed once by id, and harmless).
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
					`"${agent.name}"'s queue on its host changed while it was being moved back. Nothing changed on the host; move it back again.`
				);
			}
		}

		// The host's copy is recorded on the agent until its removal is confirmed (it is removed
		// below, after the restore), so a kept copy, or one whose removal fails, is replaced by a
		// later Move to Host. A pointer to a copy since removed is harmless: the lift finds no copy.
		// A copy left on another host keeps its pointer instead when this copy goes (its History came
		// home above, so this one holds nothing that is not here) or is gone already.
		const copyStays = hostAgent.ok && (options.keepHostCopy === true || historyStaysOnHost);
		const recorded =
			copyStays || !earlierElsewhere ? (hostAgent.ok ? pointer : undefined) : earlierElsewhere;
		if (earlierElsewhere && recorded !== earlierElsewhere) {
			notices.push(untrackedCopyNotice(earlierElsewhere));
		}
		await restoreOrThrow(deps, agent, recorded ? { ...returned, leftOnHost: recorded } : returned);

		let hostCopyRemoved = false;
		if (hostAgent.ok && !copyStays) {
			const removed = await connection.client.agents.remove(pointer.agentId);
			if (removed.ok) hostCopyRemoved = true;
			else {
				// Moving to the host again replaces the copy only while the agent points at it.
				const advice =
					recorded === pointer
						? hostCopyLeftAdvice(from)
						: `Remove it once the host is back: maestro-cli remove-agent ${from}`;
				notices.push(
					`The agent is back, but its copy on the host (${from}) could not be removed: ${removed.error.message} ${advice}`
				);
			}
		} else if (hostAgent.ok && options.keepHostCopy) {
			notices.push(`The host keeps its copy (${from}). Do not send to both.`);
		}

		return {
			agent: summary,
			from,
			tabs: returned.tabs.length,
			newTabs,
			history,
			hostCopyRemoved,
			...(hostAgent.ok && !hostCopyRemoved ? { hostCopyKept: true } : {}),
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
