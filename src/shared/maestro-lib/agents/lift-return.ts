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
import {
	HOST_COPY_RETRY_MS,
	hostDraftsNotKept,
	readHostCopyLeft,
	type HostCopyLeft,
	type ReturnedFromHost,
} from './lift-return-record';

export {
	HOST_COPY_RETRY_MS,
	hostDraftsNotKept,
	readHostCopyLeft,
	readLeftOnHost,
	readReturnedFromHost,
	returnRestoreRefusal,
	withReturnedFromHost,
	type HostCopyLeft,
	type ReturnedFromHost,
} from './lift-return-record';

/**
 * The wait for a host transcript read that timed out once (the client's own wait is 10 s): a
 * long transcript is a large frame, and a slow answer is not a host that is gone.
 */
export const RETURN_TRANSCRIPT_RETRY_TIMEOUT_MS = 120_000;

/**
 * How many times a return reads the host queue again after the restore, to bring home a message
 * the host took meanwhile, before it removes the copy. A host that keeps taking messages past this
 * keeps its copy (marked), and the next return finishes it.
 */
export const RETURN_LATE_QUEUE_PASSES = 3;

/**
 * Thrown by `ReturnRunDeps.restore` when it cannot tell whether the restore was written (the window
 * did not answer, and may still write it). The return then releases nothing on the host: a message
 * it held there stays held, so it can never run there and here both.
 */
export class RestoreUnsettledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RestoreUnsettledError';
	}
}

export interface ReturnRunOptions {
	/** The host cannot be reached: restore from this machine's copy only, and keep the host's. */
	offline?: boolean;
	/** Leave the agent on the host too (it then has two owners until one is removed). */
	keepHostCopy?: boolean;
}

/** A client attached to the agent's host. `release()` is the caller's. */
export interface ReturnHostConnection {
	peer: string;
	/** `connection` names the host kind: a desktop host does not send a queued message's images. */
	client: Pick<MaestroClient, 'agents' | 'tabs' | 'turns'> &
		Partial<Pick<MaestroClient, 'connection'>>;
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
	/** The copy on the host as `leftOnHost` records it (a plain pointer, also when finishing). */
	const leftOnHost: LiftedToPointer = {
		peer: pointer.peer,
		agentId: pointer.agentId,
		at: pointer.at,
	};
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
				left.keep
					? `"${agent.name}" is home already. The host keeps its copy (${from}); the messages that came back leave its queue once the host answers.`
					: `"${agent.name}" is home already. Its copy on the host (${from}) is removed once the host answers.`
			);
		}
		// The copy left on the host is recorded twice: `hostCopyLeft` for the come-home job, which
		// finishes this return once the host answers, and `leftOnHost`, so a Move to Host made first
		// replaces that copy instead of being refused for its name.
		await restoreOrThrow(deps, agent, {
			tabs: [],
			hostCopyLeft: copyLeft(false),
			leftOnHost,
		});
		return {
			agent: summary,
			from,
			tabs: 0,
			newTabs: 0,
			hostCopyRemoved: false,
			notices: [
				`The host was not reached, so conversations started there after the move stay there, and its copy (${from}) still exists. At each launch for the next ${Math.round(HOST_COPY_RETRY_MS / 86_400_000)} days, Maestro tries the host again and brings home what it wrote and the messages waiting in its queue. After that, nothing is brought home: the copy (agent ${pointer.agentId} there) may still hold messages in its queue, so look at them on the host before you remove it. ${hostCopyLeftAdvice(from)}`,
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
		/** The restore is written: the agent is home, and this return releases nothing any more. */
		let home = false;
		/** Release what this return held, then throw `error`, naming any message still held there. */
		const failReleasing = async (error: Error): Promise<never> => {
			// Once the agent is home, nothing is released: a message held on the host then comes home
			// (held) at the next return, and never runs there while this machine owns the agent.
			const stuck = home ? [] : await releaseHeld(connection, pointer.agentId, heldIds);
			if (stuck.length > 0) {
				error.message += ` ${stuck.length === 1 ? 'A message' : `${stuck.length} messages`} this return held on the host (${from}) could not be released and still ${stuck.length === 1 ? 'waits' : 'wait'} there, held: resume ${stuck.length === 1 ? 'it' : 'them'} on the host.`;
			}
			throw error;
		};
		/** Items an earlier return brought home that still wait, held, in the host copy. */
		let carriedOnHost: string[] = [];
		let keptQueue: string[] = [];
		const hostAgent = await connection.client.agents.get(pointer.agentId);
		const hostGone = !hostAgent.ok && hostAgent.error.code === 'not-found';
		if (!hostAgent.ok && !hostGone) throw hostError(connection.peer, hostAgent.error);
		/**
		 * Take the messages that came home out of the kept host copy's queue. The note of the copy
		 * stays on the record for any the host would not take out, so the next return (or launch)
		 * tries again, and none of them can be resumed there unnoticed meanwhile.
		 */
		const takeOutOfKeptQueue = async (marker: HostCopyLeft, itemIds: readonly string[]) => {
			const stuck: string[] = [];
			let why = '';
			for (const itemId of itemIds) {
				const removed = await connection.client.turns.queue.remove(pointer.agentId, itemId);
				if (!removed.ok) {
					stuck.push(itemId);
					why = removed.error.message;
				}
			}
			if (stuck.length === 0) {
				await clearHostCopyLeft(deps, agent, notices, 'kept', leftOnHost);
				return;
			}
			const which =
				stuck.length === 1
					? 'A message that came back still waits'
					: `${stuck.length} messages that came back still wait`;
			try {
				await restoreOrThrow(deps, agent, {
					tabs: [],
					hostCopyLeft: { ...marker, carried: stuck },
					// The kept copy is still there: a later Move to Host replaces it (#2199).
					leftOnHost,
				});
				notices.push(
					`${which}, held, in the host's queue (${from}): ${why} Maestro takes ${stuck.length === 1 ? 'it' : 'them'} out at the next launch; do not resume ${stuck.length === 1 ? 'it' : 'them'} there.`
				);
			} catch (error) {
				notices.push(
					`${which}, held, in the host's queue (${from}): ${why} This machine could not note ${stuck.length === 1 ? 'it' : 'them'} for a retry (${errorText(error)}): remove ${stuck.length === 1 ? 'it' : 'them'} there so ${stuck.length === 1 ? 'it does' : 'they do'} not run twice.`
				);
			}
		};
		if (left?.keep) {
			// The user kept the host copy: only its queue is left to clean. It is never read or removed.
			if (hostGone) await clearHostCopyLeft(deps, agent, notices, 'kept');
			else await takeOutOfKeptQueue(left, left.carried ?? []);
			released = true;
			await connection.release();
			return {
				agent: summary,
				from,
				tabs: 0,
				newTabs: 0,
				hostCopyRemoved: false,
				...(notices.length > 0 ? { notices } : {}),
			};
		}
		/** Queue items an earlier return of this agent brought home already. */
		const carried = new Set(left?.carried ?? []);
		/** The host tabs a late batch needs that were not read yet (set once the tabs are read). */
		let readNewTabs:
			| ((items: NonNullable<ReturnedFromHost['queue']>) => Promise<AITabRecord[]>)
			| undefined;
		/** Re-reads the host queue and holds what waits there (set once the host agent is read). */
		let holdWaiting: (() => Promise<NonNullable<ReturnedFromHost['queue']>>) | undefined;
		/**
		 * Neither host sends a queued message's images (`list_queue` carries its text only), and a
		 * headless host takes none. A desktop host may hold some: each of its messages comes home held,
		 * in every batch, so none runs without the image it was sent with.
		 */
		const desktopHost = connection.client.connection?.host()?.kind === 'desktop';
		/**
		 * How a host message waits here. Held when the host held it, when its images may be missing,
		 * or when the host did not say whether it was sent read-only (a host older than that field):
		 * it must not run here with writes allowed when it was sent without.
		 */
		const asHomeItem = (item: NonNullable<ReturnedFromHost['queue']>[number]) => ({
			...item,
			paused: item.paused || desktopHost || item.readOnly === undefined,
		});
		/** A notice for the messages whose read-only choice the host did not send, or none. */
		const readOnlyUnknownNotice = (
			items: NonNullable<ReturnedFromHost['queue']>
		): string | undefined => {
			const unknown = items.filter((item) => item.readOnly === undefined && !item.paused);
			if (unknown.length === 0 || desktopHost) return undefined;
			return `${from} did not say whether ${unknown.length === 1 ? 'the message from its queue was' : `the ${unknown.length} messages from its queue were`} sent read-only, so ${unknown.length === 1 ? 'it waits' : 'they wait'} here, held: check the tab's read-only setting, then resume ${unknown.length === 1 ? 'it' : 'each one'}.`;
		};
		/** A notice for messages from a desktop host, which come home held without their images. */
		const imagesNotice = (items: NonNullable<ReturnedFromHost['queue']>): string | undefined =>
			desktopHost && items.length > 0
				? `${from} is a Maestro desktop, which does not send the images attached to queued messages. The ${items.length === 1 ? 'message' : `${items.length} messages`} from its queue ${items.length === 1 ? 'waits' : 'wait'} here, held: attach any image again, then resume ${items.length === 1 ? 'it' : 'each one'}.`
				: undefined;

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
			/**
			 * The host's waiting messages, less those an earlier return carried, each held on the host
			 * so it cannot start there while it moves here.
			 */
			holdWaiting = async (): Promise<NonNullable<ReturnedFromHost['queue']>> => {
				const listed = await connection.client.turns.queue.list(pointer.agentId);
				if (!listed.ok) return await failReleasing(hostError(connection.peer, listed.error));
				carriedOnHost = listed.value
					.filter((item) => carried.has(item.itemId))
					.map((item) => item.itemId);
				const waiting = listed.value.filter((item) => !carried.has(item.itemId));
				for (const item of waiting) {
					// Held already, by the user or by this return. One this return held that the latest
					// list shows running again (resumed on the host meanwhile) is held again: it must not
					// run there while it comes home.
					if (item.paused) continue;
					const held = await connection.client.turns.queue.setPaused(
						pointer.agentId,
						item.itemId,
						true
					);
					if (!held.ok) return await failReleasing(hostError(connection.peer, held.error));
					if (!held.value.found) {
						return await failReleasing(
							new LiftRunError(
								'RETURN_BUSY',
								`"${agent.name}" started a queued message on its host. Wait for it to finish, then move it back.`
							)
						);
					}
					if (!heldIds.includes(item.itemId)) heldIds.push(item.itemId);
				}
				return waiting.map((item) => ({
					itemId: item.itemId,
					tabId: item.tabId,
					queuedAt: item.queuedAt,
					text: item.text,
					// Held by this return or by the user: `paused` is the user's own hold only.
					paused: item.paused && !heldIds.includes(item.itemId),
					...(item.readOnly !== undefined ? { readOnly: item.readOnly } : {}),
					...(item.readOnlyChoice ? { readOnlyChoice: item.readOnlyChoice } : {}),
					...(item.saveToHistory !== undefined ? { saveToHistory: item.saveToHistory } : {}),
					...(item.kind === 'command' ? { kind: item.kind } : {}),
					...(item.images && item.images.length > 0 ? { images: item.images } : {}),
					...(item.turnSettings ? { turnSettings: item.turnSettings } : {}),
				}));
			};
			let queue = await holdWaiting();
			const failRead = (error: Pick<ClientError, 'code' | 'message'>): Promise<never> =>
				failReleasing(hostError(connection.peer, error));
			const tabs = await connection.client.tabs.list(pointer.agentId);
			if (!tabs.ok) return await failRead(tabs.error);
			/** A host tab with its transcript; a read that times out is tried once more, for longer. */
			const withTranscript = async (tab: AITabRecord): Promise<AITabRecord> => {
				let transcript = await connection.client.tabs.transcript(pointer.agentId, tab.id);
				if (!transcript.ok && transcript.error.code === 'timeout') {
					transcript = await connection.client.tabs.transcript(pointer.agentId, tab.id, {
						timeoutMs: RETURN_TRANSCRIPT_RETRY_TIMEOUT_MS,
					});
				}
				if (!transcript.ok) return await failRead(transcript.error);
				return { ...tab, logs: transcript.value };
			};
			const withLogs: AITabRecord[] = [];
			for (const tab of tabs.value) withLogs.push(await withTranscript(tab));
			/**
			 * The host tabs a late batch of messages belongs to that this return did not read yet (a tab
			 * opened on the host during the return), read now, so each message reaches its own
			 * conversation and not the tab the user is on.
			 */
			readNewTabs = async (items) => {
				const known = new Set([
					...withLogs.map((tab) => tab.id),
					...returned.tabs.map((tab) => tab.id),
					...(agent.aiTabs ?? []).map((tab) => tab.id),
				]);
				if (items.every((item) => known.has(item.tabId))) return [];
				const listed = await connection.client.tabs.list(pointer.agentId);
				if (!listed.ok) return await failRead(listed.error);
				const wanted = new Set(items.map((item) => item.tabId));
				const fresh: AITabRecord[] = [];
				for (const tab of listed.value) {
					if (known.has(tab.id) || !wanted.has(tab.id)) continue;
					fresh.push(await withTranscript(tab));
				}
				return fresh;
			};
			// A turn may have started on the host since the first look (a message that left the queue
			// before it was held, or a send typed on the host): look again before anything is written.
			const recheck = await connection.client.agents.get(pointer.agentId);
			if (!recheck.ok) return await failRead(recheck.error);
			if ((recheck.value.aiTabs ?? []).some((tab) => tab.state === 'busy')) {
				return await failReleasing(
					new LiftRunError(
						'RETURN_BUSY',
						`"${agent.name}" started a turn on its host. Wait for it to finish, then move it back.`
					)
				);
			}
			// A message queued on the host while its transcripts were read comes home too, held, in
			// its own tab: one the host opened after the tab list was read is read now (#2199).
			queue = await holdWaiting();
			withLogs.push(...(await readNewTabs(queue)));
			/** Kept copy: the messages that come home, still to take out of its queue. */
			keptQueue = [...queue.map((item) => item.itemId), ...carriedOnHost];
			returned = {
				tabs: withLogs,
				...(options.keepHostCopy
					? keptQueue.length > 0
						? { hostCopyLeft: { ...copyLeft(true, keptQueue), keep: true } }
						: {}
					: {
							hostCopyLeft: copyLeft(
								true,
								queue.map((item) => item.itemId)
							),
						}),
				...(hostAgent.value.activeTabId ? { activeTabId: hostAgent.value.activeTabId } : {}),
				...(queue.length > 0
					? {
							queue: queue.map(asHomeItem),
						}
					: {}),
			};
			for (const kept of hostDraftsNotKept(agent.aiTabs ?? [], returned)) {
				notices.push(
					`A draft typed on the host in tab "${kept.tabName ?? kept.tabId}" was not put in that tab, because it has a draft of its own here. The host's draft was: ${kept.draft}`
				);
			}
			const images = imagesNotice(queue);
			if (images) notices.push(images);
			// A desktop host sends a tab's draft text but never the images staged with it, and no call
			// fetches them: name each draft that came back as text only, so the user attaches again.
			const draftTabs = desktopHost
				? withLogs.filter((tab) => typeof tab.inputValue === 'string' && tab.inputValue.trim())
				: [];
			if (draftTabs.length > 0) {
				const names = draftTabs.map((tab) => `"${tab.name ?? tab.id}"`).join(', ');
				notices.push(
					`${from} is a Maestro desktop, which does not send the images staged with a draft. The draft in ${draftTabs.length === 1 ? 'tab' : 'tabs'} ${names} came back as text only: any image attached to it there is not here, so attach it again before you send.`
				);
			}
			const unknownReadOnly = readOnlyUnknownNotice(queue);
			if (unknownReadOnly) notices.push(unknownReadOnly);
		} else if (!left) {
			notices.push(
				`The host no longer has ${from}: the agent comes back with this machine's copy.`
			);
		}

		// The host's copy is recorded on the agent until its removal is confirmed (it is removed
		// below, after the restore), so a kept copy, or one whose removal fails, is replaced by a
		// later Move to Host. A pointer to a copy since removed is harmless: the lift finds no copy.
		try {
			await restoreOrThrow(deps, agent, hostAgent.ok ? { ...returned, leftOnHost } : returned);
		} catch (error) {
			// A restore that answered late (the window timed out) may have been written anyway: the
			// messages it carried then wait here, and releasing them on the host would run them twice.
			// A restore the window REFUSED (its save failed: a full disk) was not written, whatever
			// main's in-memory store says (it takes the record before the failed flush), so only a
			// timed-out restore is checked for having landed. Treating a refused one as home would go
			// on to remove the host copy and the messages it holds.
			const unsettled = error instanceof LiftRunError && error.code === 'RETURN_RESTORE_UNSETTLED';
			if (!unsettled || !restoreLanded(deps, agent.id, left !== undefined, heldIds)) {
				// The window may still write it: release nothing, so no message can run in both places.
				// A held message comes home held at the next return.
				if (error instanceof LiftRunError && error.code === 'RETURN_RESTORE_UNSETTLED') {
					throw new LiftRunError(
						'RETURN_RESTORE_FAILED',
						heldIds.length > 0
							? `${error.message} ${heldIds.length === 1 ? 'The message it held on the host stays held there, so it cannot run twice; it comes' : `The ${heldIds.length} messages it held on the host stay held there, so none runs twice; they come`} back held at the next try.`
							: error.message
					);
				}
				return await failReleasing(error as Error);
			}
		}

		// The agent is home from here on: a failure is the host copy's, reported, never the agent's.
		home = true;
		let hostCopyRemoved = false;
		try {
			// The messages the restore carried are home: none of them is ever released on the host.
			heldIds.length = 0;
			// A message the host took after the last read is in neither the restore nor the held set:
			// bring it home (held on the host first) before the copy goes, or keep the copy (marked)
			// for the next return when the host keeps taking them.
			let lateQueueSettled = !holdWaiting || options.keepHostCopy === true;
			let lateNotice = `The agent is back, but its host (${from}) kept taking new messages, so its copy stays for now. Each message it took came back here. Maestro removes the copy at the next launch.`;
			if (holdWaiting && !lateQueueSettled) {
				const cameHome = new Set([
					...(returned.queue ?? []).map((item) => item.itemId),
					...carried,
				]);
				for (let pass = 0; pass < RETURN_LATE_QUEUE_PASSES; pass++) {
					const late = (await holdWaiting()).filter((item) => !cameHome.has(item.itemId));
					if (late.length === 0) {
						lateQueueSettled = true;
						break;
					}
					const newTabs = readNewTabs ? await readNewTabs(late) : [];
					try {
						await restoreOrThrow(deps, agent, {
							tabs: newTabs,
							queue: late.map(asHomeItem),
							hostCopyLeft: copyLeft(true, [...cameHome, ...late.map((item) => item.itemId)]),
							// The copy is not removed yet: keep the pointer the first restore wrote (#2199).
							leftOnHost,
						});
					} catch (error) {
						// Not released: the window may still write it. Held on the host, the message
						// comes back held at the next return.
						lateNotice = `The agent is back, but ${late.length === 1 ? 'a message' : `${late.length} messages`} its host (${from}) took during the return could not be saved here (${errorText(error)}). ${late.length === 1 ? 'It waits' : 'They wait'} there, held, and ${late.length === 1 ? 'comes' : 'come'} back at the next launch, with the rest of the host copy.`;
						break;
					}
					for (const item of late) cameHome.add(item.itemId);
					heldIds.length = 0;
					const unknownReadOnly = readOnlyUnknownNotice(late);
					if (unknownReadOnly) notices.push(unknownReadOnly);
					const images = imagesNotice(late);
					if (images) notices.push(images);
					returned = {
						...returned,
						tabs: [...returned.tabs, ...newTabs],
						queue: [...(returned.queue ?? []), ...late],
					};
				}
			}
			if (hostAgent.ok && !options.keepHostCopy && !lateQueueSettled) {
				notices.push(lateNotice);
			} else if (hostAgent.ok && !options.keepHostCopy) {
				const removed = await connection.client.agents.remove(pointer.agentId);
				if (removed.ok) {
					hostCopyRemoved = true;
					await clearHostCopyLeft(deps, agent, notices);
				} else {
					notices.push(
						`The agent is back, but its copy on the host (${from}) could not be removed: ${removed.error.message} With hosted agents off, Maestro removes it at the next launch. ${hostCopyLeftAdvice(from)}`
					);
				}
			} else if (hostAgent.ok) {
				notices.push(`The host keeps its copy (${from}). Do not send to both.`);
				const marker = returned.hostCopyLeft;
				if (marker) await takeOutOfKeptQueue(marker, keptQueue);
			}
		} catch (error) {
			notices.push(
				options.keepHostCopy
					? `The agent is back, but the host (${from}) stopped answering before the messages that came back left its queue: ${errorText(error)} Maestro takes them out at the next launch; do not resume them there.`
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
 * The host copy is gone (or, `kept`, its queue holds nothing of this agent's any more): write the
 * record without the marker, so no later run dials for it. A copy that is still on the host
 * (`stillOnHost`) keeps its `leftOnHost` pointer, so a later Move to Host replaces it; only a copy
 * the host confirmed gone drops both. A failure here is not the agent's: it is home, and the next
 * run finds nothing left to do and clears the marker then. Reported as a notice.
 */
async function clearHostCopyLeft(
	deps: ReturnRunDeps,
	agent: AgentRecord,
	notices: string[],
	kept?: 'kept',
	stillOnHost?: LiftedToPointer
): Promise<void> {
	try {
		await deps.restore(agent.id, { tabs: [], ...(stillOnHost ? { leftOnHost: stillOnHost } : {}) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notices.push(
			`${kept ? "The messages that came back are out of the host's queue" : 'The host copy is removed'}, but "${agent.name}" could not be saved without its note of it (${message}). Maestro clears it at the next launch.`
		);
	}
}

/**
 * Whether the restore was written although it reported a failure: the stored record is home, and
 * (for a record that was home already, finishing an earlier return) every message this return held
 * on the host is in its queue or in its note of the host copy.
 */
function restoreLanded(
	deps: ReturnRunDeps,
	agentId: string,
	finishing: boolean,
	heldIds: readonly string[]
): boolean {
	const current = deps.readAgents().find((record) => record.id === agentId);
	if (!current || readLiftedTo(current.liftedTo)) return false;
	if (!finishing) return true;
	const carried = new Set(readHostCopyLeft(current.hostCopyLeft)?.carried ?? []);
	const queue = (current as { executionQueue?: Array<{ id?: unknown }> }).executionQueue;
	const queued = new Set((Array.isArray(queue) ? queue : []).map((item) => item?.id));
	return heldIds.length > 0 && heldIds.every((id) => carried.has(id) || queued.has(id));
}

/**
 * Let the host run the messages this return held, because the return failed. Answers the ids it
 * could not release: those stay held on the host, where Hold / Resume reaches them, and the caller
 * names them beside its own error.
 */
async function releaseHeld(
	connection: ReturnHostConnection,
	hostAgentId: string,
	heldIds: string[]
): Promise<string[]> {
	const stuck: string[] = [];
	for (const itemId of heldIds) {
		try {
			const released = await connection.client.turns.queue.setPaused(hostAgentId, itemId, false);
			if (!released.ok) stuck.push(itemId);
		} catch {
			stuck.push(itemId);
		}
	}
	return stuck;
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
		if (error instanceof RestoreUnsettledError) {
			throw new LiftRunError(
				'RETURN_RESTORE_UNSETTLED',
				`Could not move "${agent.name}" back: ${message}.`
			);
		}
		throw new LiftRunError(
			'RETURN_RESTORE_FAILED',
			`Could not move "${agent.name}" back: ${message}. Nothing changed on the host.`
		);
	}
}
