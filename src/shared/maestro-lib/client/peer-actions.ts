// The input a person or a script gives a Federation peer's agent (FED-SSH-06), shared by
// maestro-cli's `peer:agent` verbs and the desktop's peer mirror.
//
// Each action is one call on the host's client, the same bridge message either caller sends:
// a send is `turns.send` (`enqueue_command`), Stop is `turns.interrupt` (`process:interrupt`) per
// tab, and the tab actions are `tabs.create`, `tabs.rename`, `tabs.star`. The CLI reaches the host
// over its own short-lived forward (`withPeerAgent()`), the desktop over the mirror service's held
// one; both run the action through `runPeerAgentAction()`, so there is one copy.
//
// Nothing here queues or retries. A client that is not attached fails at once
// (`host-unavailable`), so a send while disconnected is an error, never a message held for later.
// A send to a busy tab waits in the HOST's execution queue, as it would for a local agent.

import type { AgentRecord } from '../store/records';
import type { ClientError, ClientResult, MaestroClient, TurnSendReceipt } from './types';

/** One thing to do to a peer's agent. */
export type PeerAgentAction =
	/** Send a message to a tab. The host adds its own system prompt and template variables. */
	| { kind: 'send'; tabId: string; text: string; dispatchId?: string }
	/** Stop a tab's turn; without `tabId`, every busy tab of the agent (the Stop pill). */
	| { kind: 'interrupt'; tabId?: string }
	| { kind: 'new-tab' }
	/** An empty name clears it, so the tab shows its session id label again. */
	| { kind: 'rename-tab'; tabId: string; name: string }
	| { kind: 'star-tab'; tabId: string; starred: boolean };

export type PeerAgentActionKind = PeerAgentAction['kind'];

/** What the host answered, per action. */
export type PeerAgentActionResult =
	| { kind: 'send'; receipt: TurnSendReceipt }
	| {
			kind: 'interrupt';
			/** The tabs the action asked the host to stop. */
			targetTabIds: string[];
			/** The tabs the host reports it stopped. */
			stoppedTabIds: string[];
	  }
	| { kind: 'new-tab'; tabId: string }
	| { kind: 'rename-tab'; tabId: string }
	| { kind: 'star-tab'; tabId: string; starred: boolean };

/** The agent fields an action reads: interrupt picks the busy tabs from the record. */
export type PeerActionAgent = Pick<AgentRecord, 'id' | 'aiTabs'>;

const ACTION_KINDS: readonly PeerAgentActionKind[] = [
	'send',
	'interrupt',
	'new-tab',
	'rename-tab',
	'star-tab',
];

/**
 * Run one action against the host's agent. A host failure comes back as the client's own
 * `ClientError`, so the CLI keeps its exit codes and the desktop shows the message.
 */
export async function runPeerAgentAction(
	client: MaestroClient,
	agent: PeerActionAgent,
	action: PeerAgentAction
): Promise<ClientResult<PeerAgentActionResult>> {
	switch (action.kind) {
		case 'send': {
			const sent = await client.turns.send(agent.id, action.tabId, {
				text: action.text,
				...(action.dispatchId ? { dispatchId: action.dispatchId } : {}),
			});
			return sent.ok ? { ok: true, value: { kind: 'send', receipt: sent.value } } : sent;
		}
		case 'interrupt': {
			const targetTabIds = action.tabId
				? [action.tabId]
				: (agent.aiTabs ?? []).filter((tab) => tab.state === 'busy').map((tab) => tab.id);
			const stoppedTabIds: string[] = [];
			for (const tabId of targetTabIds) {
				const stopped = await client.turns.interrupt(agent.id, tabId);
				if (!stopped.ok) return stopped;
				if (stopped.value.stopped) stoppedTabIds.push(tabId);
			}
			return { ok: true, value: { kind: 'interrupt', targetTabIds, stoppedTabIds } };
		}
		case 'new-tab': {
			const created = await client.tabs.create(agent.id);
			return created.ok
				? { ok: true, value: { kind: 'new-tab', tabId: created.value.tabId } }
				: created;
		}
		case 'rename-tab': {
			const renamed = await client.tabs.rename(agent.id, action.tabId, action.name);
			return renamed.ok
				? { ok: true, value: { kind: 'rename-tab', tabId: action.tabId } }
				: renamed;
		}
		case 'star-tab': {
			const starred = await client.tabs.star(agent.id, action.tabId, action.starred);
			return starred.ok
				? {
						ok: true,
						value: { kind: 'star-tab', tabId: action.tabId, starred: action.starred },
					}
				: starred;
		}
	}
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Read an action that crossed a process boundary (IPC). Throws a message that names the bad field;
 * an unknown kind or a missing tab is refused before any host call.
 */
export function parsePeerAgentAction(raw: unknown): PeerAgentAction {
	if (!raw || typeof raw !== 'object') throw new Error('Missing action');
	const value = raw as Record<string, unknown>;
	const kind = value.kind as PeerAgentActionKind;
	if (!ACTION_KINDS.includes(kind)) throw new Error(`Unknown action: ${String(value.kind)}`);
	const tabId = (): string => {
		if (!nonEmptyString(value.tabId)) throw new Error('Missing tab id');
		return value.tabId;
	};
	switch (kind) {
		case 'send': {
			if (typeof value.text !== 'string' || !value.text.trim()) {
				throw new Error('There is nothing to send.');
			}
			return {
				kind,
				tabId: tabId(),
				text: value.text,
				...(nonEmptyString(value.dispatchId) ? { dispatchId: value.dispatchId } : {}),
			};
		}
		case 'interrupt':
			return value.tabId === undefined ? { kind } : { kind, tabId: tabId() };
		case 'new-tab':
			return { kind };
		case 'rename-tab':
			if (typeof value.name !== 'string') throw new Error('Missing tab name');
			return { kind, tabId: tabId(), name: value.name.trim() };
		case 'star-tab':
			if (typeof value.starred !== 'boolean') throw new Error('starred must be true or false');
			return { kind, tabId: tabId(), starred: value.starred };
	}
}

/** The action failed on the host, or never reached it, in words a person can act on. */
export function peerActionErrorMessage(
	peerId: string,
	error: Pick<ClientError, 'code' | 'message'>
): string {
	if (error.code === 'host-unavailable') {
		return `Not connected to peer "${peerId}". Nothing was sent. ${error.message}`;
	}
	// Dropped mid-call: the host may or may not have acted, so do not claim either.
	if (error.code === 'host-lost') {
		return `The connection to peer "${peerId}" dropped. ${error.message}`;
	}
	return `Peer "${peerId}": ${error.message}`;
}
