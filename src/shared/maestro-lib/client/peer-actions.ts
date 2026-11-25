// The input a person or a script gives a Federation peer's agent (FED-SSH-06), shared by
// maestro-cli's `peer:agent` verbs and the desktop's peer mirror.
//
// Each action is one call on the host's client, the same bridge message either caller sends:
// a send is `turns.send` (`enqueue_command`), Stop is `turns.interrupt` (`process:interrupt`) per
// tab, the tab actions are `tabs.create`, `tabs.rename`, `tabs.star`, and `tabs.update`, a settings
// change is `agents.update`, and the queue actions on a waiting message are `turns.queue.remove`
// (`remove_queue_item`), `turns.queue.setPaused` (`set_queue_item_paused`), `turns.queue.merge`
// (`merge_queue_item`), `turns.queue.steer` (`steer_queue_item`), `turns.queue.edit`
// (`edit_queue_item`), `turns.queue.move` (`move_queue_item`), and `turns.queue.sendNow`
// (`send_queue_item_now`). A `/btw` side question is `consults.ask` with `sideQuestion`
// (`cross_agent_ask`): the host forks its own tab, as a `/btw` typed there does. The CLI reaches the host over its own short-lived forward
// (`withPeerAgent()`), the desktop over the mirror service's held one; both run the action
// through `runPeerAgentAction()`, so there is one copy.
//
// Nothing here queues or retries. A client that is not attached fails at once
// (`host-unavailable`), so a send while disconnected is an error, never a message held for later.
// A send to a busy tab waits in the HOST's execution queue, as it would for a local agent.

import type { QueueSteerResult } from '../../chatSteering';
import { isCodexTransport } from '../../codexTransport';
import { asThinkingMode } from '../../types';
import { isHarnessControlMode } from '../providers/native-control';
import type { AgentRecord } from '../store/records';
import type {
	AgentPatch,
	AgentPatchField,
	ClientError,
	ClientResult,
	MaestroClient,
	QueuedTurnEdit,
	TabPatch,
	TurnOverrides,
	TurnSendReceipt,
} from './types';
import { parseQueuedTurnEdit } from './types';

/** One thing to do to a peer's agent. */
export type PeerAgentAction =
	/**
	 * Send a message to a tab. The host adds its own system prompt and template variables.
	 * `overrides` are the sender's own tab chips for this one turn; the host tab is not changed.
	 */
	| {
			kind: 'send';
			tabId: string;
			text: string;
			/** Images as data URLs, sent with the text (or alone). */
			images?: string[];
			dispatchId?: string;
			overrides?: TurnOverrides;
			/** Queue Held: the host queues it paused, even on an idle tab (`TurnInput.held`). */
			held?: boolean;
	  }
	/** Stop a tab's turn; without `tabId`, every busy tab of the agent (the Stop pill). */
	| { kind: 'interrupt'; tabId?: string }
	| { kind: 'new-tab' }
	/** An empty name clears it, so the tab shows its session id label again. */
	| { kind: 'rename-tab'; tabId: string; name: string }
	| { kind: 'star-tab'; tabId: string; starred: boolean }
	/** The tab moves to the host's closed-tab history. */
	| { kind: 'close-tab'; tabId: string }
	/** Take a message that still waits out of the host's execution queue. */
	| { kind: 'remove-queued'; itemId: string }
	/** Hold a waiting message (it keeps its place) or release it. */
	| { kind: 'pause-queued'; itemId: string; paused: boolean }
	/** Fold a waiting message into the waiting message above it on its tab (the card's Merge). */
	| { kind: 'merge-queued'; itemId: string }
	/** Hand a waiting message to the turn running on its tab (the card's Steer). */
	| { kind: 'steer-queued'; itemId: string }
	/** Rewrite a waiting message in place (the card's Edit). Images, when given, are data URLs. */
	| { kind: 'edit-queued'; itemId: string; edit: QueuedTurnEdit }
	/**
	 * Move a waiting message to `toIndex` (the card's drag). With `tabId`, the index counts only
	 * that tab's waiting messages, as the tab's queue list draws them.
	 */
	| { kind: 'move-queued'; itemId: string; toIndex: number; tabId?: string }
	/** Run a waiting message now instead of in its turn (the card's Force Send). */
	| { kind: 'send-now-queued'; itemId: string }
	/**
	 * Ask a `/btw` side question about a tab's conversation. The host answers from a throwaway fork
	 * of its tab (tools off), so nothing lands in the tab's transcript and a busy tab answers too.
	 */
	| { kind: 'side-question'; tabId: string; question: string }
	/** Change the agent's settings on the host (Federation settings sync). `ssh` is never sent. */
	| { kind: 'update-agent'; patch: AgentPatch }
	/** Change one tab's composer settings on the host. */
	| { kind: 'update-tab'; tabId: string; patch: TabPatch };

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
	| { kind: 'star-tab'; tabId: string; starred: boolean }
	| { kind: 'close-tab'; tabId: string }
	/** `removed: false`: the message no longer waits (it started, or another client removed it). */
	| { kind: 'remove-queued'; itemId: string; removed: boolean }
	/** `found: false`: the message no longer waits. */
	| { kind: 'pause-queued'; itemId: string; found: boolean; paused: boolean }
	/** `merged: false`: nothing waits above it on its tab, or it no longer waits. */
	| { kind: 'merge-queued'; itemId: string; merged: boolean; mergedIntoId?: string }
	/** What the host's steer did: `outcome` is the same one a local steer reports. */
	| { kind: 'steer-queued'; itemId: string; result: QueueSteerResult }
	/** `found: false`: the message no longer waits (it started, or another client removed it). */
	| { kind: 'edit-queued'; itemId: string; found: boolean }
	/** `moved: false`: the message no longer waits, or the place is out of range. */
	| { kind: 'move-queued'; itemId: string; moved: boolean }
	/** `sent: false`: the message no longer waits, or its tab is mid-turn. */
	| { kind: 'send-now-queued'; itemId: string; sent: boolean }
	| { kind: 'side-question'; tabId: string; answer: string }
	| { kind: 'update-agent'; applied: AgentPatchField[]; notices?: string[] }
	| { kind: 'update-tab'; tabId: string };

/** The agent fields an action reads: interrupt picks the busy tabs from the record. */
export type PeerActionAgent = Pick<AgentRecord, 'id' | 'aiTabs'>;

const ACTION_KINDS: readonly PeerAgentActionKind[] = [
	'send',
	'interrupt',
	'new-tab',
	'rename-tab',
	'star-tab',
	'close-tab',
	'remove-queued',
	'pause-queued',
	'merge-queued',
	'steer-queued',
	'edit-queued',
	'move-queued',
	'send-now-queued',
	'side-question',
	'update-agent',
	'update-tab',
];

/**
 * Run one action against the host's agent. A host failure comes back as the client's own
 * `ClientError`, so the CLI keeps its exit codes and the desktop shows the message.
 */
/** What the caller knows that an action does not carry. */
export interface PeerActionContext {
	/** This machine's hostname: a send stamps its History entry with it on the host (`originHost`). */
	originHost?: string;
}

export async function runPeerAgentAction(
	client: MaestroClient,
	agent: PeerActionAgent,
	action: PeerAgentAction,
	context: PeerActionContext = {}
): Promise<ClientResult<PeerAgentActionResult>> {
	switch (action.kind) {
		case 'send': {
			const sent = await client.turns.send(agent.id, action.tabId, {
				text: action.text,
				...(action.images?.length ? { images: action.images } : {}),
				...(action.dispatchId ? { dispatchId: action.dispatchId } : {}),
				...(context.originHost ? { originHost: context.originHost } : {}),
				...(action.overrides ? { overrides: action.overrides } : {}),
				...(action.held === true ? { held: true } : {}),
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
		case 'close-tab': {
			const closed = await client.tabs.close(agent.id, action.tabId);
			return closed.ok ? { ok: true, value: { kind: 'close-tab', tabId: action.tabId } } : closed;
		}
		case 'remove-queued': {
			const removed = await client.turns.queue.remove(agent.id, action.itemId);
			return removed.ok
				? {
						ok: true,
						value: { kind: 'remove-queued', itemId: action.itemId, removed: removed.value.removed },
					}
				: removed;
		}
		case 'pause-queued': {
			const set = await client.turns.queue.setPaused(agent.id, action.itemId, action.paused);
			return set.ok
				? { ok: true, value: { kind: 'pause-queued', itemId: action.itemId, ...set.value } }
				: set;
		}
		case 'merge-queued': {
			const merged = await client.turns.queue.merge(agent.id, action.itemId);
			return merged.ok
				? { ok: true, value: { kind: 'merge-queued', itemId: action.itemId, ...merged.value } }
				: merged;
		}
		case 'steer-queued': {
			const steered = await client.turns.queue.steer(agent.id, action.itemId);
			return steered.ok
				? {
						ok: true,
						value: { kind: 'steer-queued', itemId: action.itemId, result: steered.value },
					}
				: steered;
		}
		case 'edit-queued': {
			const edited = await client.turns.queue.edit(agent.id, action.itemId, action.edit);
			return edited.ok
				? {
						ok: true,
						value: { kind: 'edit-queued', itemId: action.itemId, found: edited.value.found },
					}
				: edited;
		}
		case 'move-queued': {
			const moved = await client.turns.queue.move(
				agent.id,
				action.itemId,
				action.toIndex,
				action.tabId
			);
			return moved.ok
				? { ok: true, value: { kind: 'move-queued', itemId: action.itemId, ...moved.value } }
				: moved;
		}
		case 'send-now-queued': {
			const sent = await client.turns.queue.sendNow(agent.id, action.itemId);
			return sent.ok
				? { ok: true, value: { kind: 'send-now-queued', itemId: action.itemId, ...sent.value } }
				: sent;
		}
		case 'side-question': {
			const asked = await client.consults.ask({
				targetAgentId: agent.id,
				question: action.question,
				sideQuestion: true,
				targetTabId: action.tabId,
			});
			return asked.ok
				? {
						ok: true,
						value: { kind: 'side-question', tabId: action.tabId, answer: asked.value.answer },
					}
				: asked;
		}
		case 'update-agent': {
			const updated = await client.agents.update(agent.id, action.patch);
			return updated.ok
				? {
						ok: true,
						value: {
							kind: 'update-agent',
							applied: updated.value.applied,
							...(updated.value.notices ? { notices: updated.value.notices } : {}),
						},
					}
				: updated;
		}
		case 'update-tab': {
			const updated = await client.tabs.update(agent.id, action.tabId, action.patch);
			return updated.ok
				? { ok: true, value: { kind: 'update-tab', tabId: action.tabId } }
				: updated;
		}
	}
}

/** A send's images: data URLs only. Anything else in the list is refused, not dropped. */
function parseImages(value: unknown): string[] | undefined {
	if (value == null) return undefined;
	if (!Array.isArray(value)) throw new Error('images must be a list of data URLs');
	for (const image of value) {
		if (typeof image !== 'string' || !image.startsWith('data:image/')) {
			throw new Error('images must be a list of data URLs');
		}
	}
	return value.length > 0 ? (value as string[]) : undefined;
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
			const images = parseImages(value.images);
			if (typeof value.text !== 'string' || (!value.text.trim() && !images)) {
				throw new Error('There is nothing to send.');
			}
			const overrides = value.overrides == null ? undefined : parseTurnOverrides(value.overrides);
			return {
				kind,
				tabId: tabId(),
				text: value.text,
				...(images ? { images } : {}),
				...(nonEmptyString(value.dispatchId) ? { dispatchId: value.dispatchId } : {}),
				...(overrides ? { overrides } : {}),
				...(value.held === true ? { held: true } : {}),
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
		case 'close-tab':
			return { kind, tabId: tabId() };
		case 'remove-queued':
			if (!nonEmptyString(value.itemId)) throw new Error('Missing queued item id');
			return { kind, itemId: value.itemId };
		case 'pause-queued':
			if (!nonEmptyString(value.itemId)) throw new Error('Missing queued item id');
			if (typeof value.paused !== 'boolean') throw new Error('paused must be true or false');
			return { kind, itemId: value.itemId, paused: value.paused };
		case 'move-queued': {
			if (!nonEmptyString(value.itemId)) throw new Error('Missing queued item id');
			const toIndex = value.toIndex;
			if (typeof toIndex !== 'number' || !Number.isInteger(toIndex) || toIndex < 0) {
				throw new Error('toIndex must be a whole number, 0 or more');
			}
			return {
				kind,
				itemId: value.itemId,
				toIndex,
				...(value.tabId === undefined ? {} : { tabId: tabId() }),
			};
		}
		case 'merge-queued':
		case 'steer-queued':
		case 'send-now-queued':
			if (!nonEmptyString(value.itemId)) throw new Error('Missing queued item id');
			return { kind, itemId: value.itemId };
		case 'edit-queued': {
			if (!nonEmptyString(value.itemId)) throw new Error('Missing queued item id');
			const raw =
				value.edit && typeof value.edit === 'object' && !Array.isArray(value.edit)
					? (value.edit as Record<string, unknown>)
					: {};
			const parsed = parseQueuedTurnEdit(raw);
			if ('error' in parsed) throw new Error(parsed.error);
			// An empty list is an edit too: it clears the message's images.
			const images = raw.images === undefined ? undefined : (parseImages(raw.images) ?? []);
			return {
				kind,
				itemId: value.itemId,
				edit: { ...parsed.edit, ...(images ? { images } : {}) },
			};
		}
		case 'side-question':
			if (!nonEmptyString(value.question)) throw new Error('The question is empty.');
			return { kind, tabId: tabId(), question: value.question.trim() };
		case 'update-agent':
			return { kind, patch: parseAgentPatch(value.patch) };
		case 'update-tab':
			return { kind, tabId: tabId(), patch: parseTabPatch(value.patch) };
	}
}

type FieldCheck = (value: unknown) => boolean;

const isString: FieldCheck = (value) => typeof value === 'string';
const isNonEmptyString: FieldCheck = (value) => nonEmptyString(value);
const isBoolean: FieldCheck = (value) => typeof value === 'boolean';
const orNull =
	(check: FieldCheck): FieldCheck =>
	(value) =>
		value === null || check(value);
const isPositiveNumber: FieldCheck = (value) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0;
const isStringMap: FieldCheck = (value) =>
	!!value &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	Object.values(value).every((entry) => typeof entry === 'string');

/**
 * The fields an `update-agent` action may carry, with the type each takes. `ssh` is absent on
 * purpose: an agent on a host runs there, so an SSH setting would point it back out.
 */
const AGENT_PATCH_CHECKS: Partial<Record<AgentPatchField, FieldCheck>> = {
	name: isNonEmptyString,
	cwd: isNonEmptyString,
	groupId: orNull(isNonEmptyString),
	provider: isNonEmptyString,
	model: orNull(isString),
	effort: orNull(isString),
	contextWindow: orNull(isPositiveNumber),
	customPath: orNull(isString),
	customArgs: orNull(isString),
	env: orNull(isStringMap),
	autoRunFolderPath: isString,
	nudgeMessage: orNull(isString),
	newSessionMessage: orNull(isString),
	bookmarked: isBoolean,
	contextWindowSource: orNull(isString),
	enableMaestroP: orNull(isBoolean),
	maestroPMode: orNull((value) => value === 'interactive' || value === 'dynamic'),
	maestroPPath: orNull(isString),
	codexTransport: orNull(isCodexTransport),
	harnessControlMode: orNull(isHarnessControlMode),
};

const TAB_PATCH_CHECKS: Record<keyof TabPatch, FieldCheck> = {
	readOnly: isBoolean,
	thinking: (value) => asThinkingMode(value) !== undefined,
	model: orNull(isString),
	effort: orNull(isString),
	saveToHistory: isBoolean,
	enterToSend: orNull(isBoolean),
};

const TURN_OVERRIDE_CHECKS: Record<keyof TurnOverrides, FieldCheck> = {
	model: isNonEmptyString,
	effort: isNonEmptyString,
	readOnly: isBoolean,
	saveToHistory: isBoolean,
};

/** Keep the known fields of a patch, each checked for its type; an unknown or bad field throws. */
function parsePatch<T extends object>(
	raw: unknown,
	checks: Partial<Record<keyof T, FieldCheck>>,
	label: string
): T {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Missing ${label}`);
	const patch: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === undefined) continue;
		const check = checks[field as keyof T];
		if (!check) throw new Error(`Unknown ${label} field: ${field}`);
		if (!check(value)) throw new Error(`Invalid value for ${label} field '${field}'`);
		patch[field] = value;
	}
	if (Object.keys(patch).length === 0) throw new Error(`The ${label} changes nothing.`);
	return patch as T;
}

function parseAgentPatch(raw: unknown): AgentPatch {
	return parsePatch<AgentPatch>(raw, AGENT_PATCH_CHECKS, 'agent settings');
}

function parseTabPatch(raw: unknown): TabPatch {
	return parsePatch<TabPatch>(raw, TAB_PATCH_CHECKS, 'tab settings');
}

/**
 * A send's own tab choices, checked like a patch. An unknown or bad field throws; an object with
 * nothing in it is dropped (undefined), since it overrides nothing.
 */
function parseTurnOverrides(raw: unknown): TurnOverrides | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('Invalid turn overrides');
	}
	if (Object.values(raw).every((value) => value === undefined)) return undefined;
	return parsePatch<TurnOverrides>(raw, TURN_OVERRIDE_CHECKS, 'turn overrides');
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
