/**
 * The actions a window takes on a Federation peer it mirrors: reads (FED-SSH-05) and input
 * (FED-SSH-06).
 *
 * Every one goes through `window.maestro.federation` to the one main-process service, the same
 * one `maestro-cli federation` reaches. Input runs there through `runPeerAgentAction()`, the
 * function the CLI's `peer:agent` verbs run. None writes a local store: a transcript read lands in
 * `peerMirrorStore` only, a reconnect changes the main service's own memory, and an action's
 * effect comes back as the host's own events. Nothing is queued: a peer that is not connected
 * answers an error at once, shown as a toast.
 */

import {
	normalizeTurnOverrides,
	type QueuedTurnEdit,
	type TurnInput,
	type TurnOverrides,
	type TurnSendReceipt,
} from '../../shared/maestro-lib/client/types';
import type {
	PeerAgentAction,
	PeerAgentActionKind,
	PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
import type { QueueSteerResult } from '../../shared/chatSteering';
import type { ClosedTabSummary } from '../../shared/closedTabCommands';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** Newest entries a tab shows. The host keeps the rest; "load earlier" is a follow-up. */
export const MIRROR_TRANSCRIPT_TAIL = 500;

/**
 * Read a mirrored tab's transcript from its host into `peerMirrorStore`. A failure (the peer is
 * down, the tab is gone) is an expected state of a remote: it is kept on the slot and shown in the
 * view with a retry, not raised.
 */
export async function readMirrorTranscript(
	peerId: string,
	agentId: string,
	tabId: string
): Promise<void> {
	const api = window.maestro?.federation;
	if (!api) return;
	const staleVersion = usePeerMirrorStore.getState().beginTranscriptRead(peerId, agentId, tabId);
	try {
		const entries = await api.transcript(peerId, agentId, tabId, { tail: MIRROR_TRANSCRIPT_TAIL });
		usePeerMirrorStore
			.getState()
			.finishTranscriptRead(peerId, agentId, tabId, entries, staleVersion);
	} catch (error) {
		usePeerMirrorStore
			.getState()
			.failTranscriptRead(peerId, agentId, tabId, ipcErrorMessage(error));
	}
}

/**
 * Force the peer's forward or client back up and reload its agents (`federation reconnect`).
 * A failure raises a toast, unless `quiet`: a retry the user did not ask for (New Agent picking a
 * dropped host) says nothing. Resolves to whether the host answered.
 */
export async function reconnectPeer(
	peerId: string,
	options: { quiet?: boolean } = {}
): Promise<boolean> {
	const api = window.maestro?.federation;
	if (!api) return false;
	let error: string | undefined;
	try {
		const result = await api.reconnect(peerId);
		if (!result.ok) error = result.error ?? 'The host did not answer.';
	} catch (caught) {
		error = ipcErrorMessage(caught);
	}
	if (error && !options.quiet) {
		notifyToast({ color: 'red', title: `Could not reconnect to ${peerId}`, message: error });
	}
	return !error;
}

/** The toast title for a failed action, by kind. */
const ACTION_FAILURE_TITLES: Record<PeerAgentActionKind, string> = {
	send: 'Message not sent',
	interrupt: 'Could not stop the turn',
	'new-tab': 'Could not open a tab',
	'rename-tab': 'Could not rename the tab',
	'star-tab': 'Could not change the star',
	'close-tab': 'Could not close the tab',
	'remove-queued': 'Could not remove the queued message',
	'pause-queued': 'Could not hold or resume the queued message',
	'merge-queued': 'Could not merge the queued message',
	'steer-queued': 'Could not steer this turn',
	'edit-queued': 'Could not edit the queued message',
	'move-queued': 'Could not move the queued message',
	'send-now-queued': 'Could not send the queued message now',
	'side-question': 'Could not ask the side question',
	consult: 'Could not consult the agent',
	'consult-cancel': 'Could not stop the consult',
	'closed-tabs': 'Could not read the closed tabs',
	'reopen-tab': 'Could not reopen the tab',
	'update-agent': 'Could not change the agent on its host',
	'update-tab': 'Could not change the tab on its host',
	'auto-run': 'Auto Run did not start',
	'goal-run': 'Auto Run did not start',
	'auto-run-control': 'Auto Run control failed',
};

/** What the main-process service answered for one action (`PeerMirrorService.act()`). */
export type MirroredActionAnswer = Awaited<
	ReturnType<NonNullable<typeof window.maestro.federation>['act']>
>;

/**
 * Run one action on a mirrored agent and hand back the service's answer as is, with no toast:
 * for a caller that decides itself what a failure means (the settings sync retries a peer that
 * is down). An IPC failure answers `{ ok: false }` with no `code`. Null without the API.
 */
export async function callMirroredAgentAction(
	peerId: string,
	agentId: string,
	action: PeerAgentAction
): Promise<MirroredActionAnswer | null> {
	const api = window.maestro?.federation;
	if (!api) return null;
	try {
		return await api.act(peerId, agentId, action);
	} catch (caught) {
		return { ok: false, error: ipcErrorMessage(caught) };
	}
}

/**
 * Run one action on a mirrored agent through the main-process service. A failure (the peer is
 * disconnected, the host refused) is a red toast and answers null; nothing is retried or held for
 * a reconnect.
 */
export async function actOnMirroredAgent(
	peerId: string,
	agentId: string,
	action: PeerAgentAction
): Promise<PeerAgentActionResult | null> {
	const answer = await callMirroredAgentAction(peerId, agentId, action);
	if (!answer) return null;
	if (answer.ok) return answer.result;
	const error = answer.unknown
		? `${answer.error} The host may have taken it: check the tab before sending again.`
		: answer.error;
	notifyToast({ color: 'red', title: ACTION_FAILURE_TITLES[action.kind], message: error });
	return null;
}

/**
 * Send what the person typed to one mirrored tab, with this conductor's own tab choices for that
 * one turn. The host's receipt when it took it (ran, queued, or held), null when it did not.
 * `held` is Queue Held: the host queues it paused, even on an idle tab, as a local Queue Held does.
 * `agentText` is the agent-only context and notes an `@mention` adds to this one turn.
 */
export async function sendToMirroredTab(
	peerId: string,
	agentId: string,
	tabId: string,
	text: string,
	overrides?: TurnOverrides,
	images?: readonly string[],
	held?: boolean,
	agentText: Pick<TurnInput, 'agentContext' | 'agentNotes'> = {}
): Promise<TurnSendReceipt | null> {
	const clean = normalizeTurnOverrides(overrides);
	const result = await actOnMirroredAgent(peerId, agentId, {
		kind: 'send',
		tabId,
		text,
		...(images && images.length > 0 ? { images: [...images] } : {}),
		...(clean ? { overrides: clean } : {}),
		...(held === true ? { held: true } : {}),
		...(agentText.agentContext ? { agentContext: agentText.agentContext } : {}),
		...(agentText.agentNotes ? { agentNotes: agentText.agentNotes } : {}),
	});
	return result?.kind === 'send' ? result.receipt : null;
}

/** Stop a mirrored tab's turn, or every busy tab of the agent without `tabId` (the Stop pill). */
export async function interruptMirroredAgent(
	peerId: string,
	agentId: string,
	tabId?: string
): Promise<void> {
	await actOnMirroredAgent(
		peerId,
		agentId,
		tabId ? { kind: 'interrupt', tabId } : { kind: 'interrupt' }
	);
}

/** Rename a mirrored tab on its host. An empty name clears it. */
export async function renameMirrorTab(
	peerId: string,
	agentId: string,
	tabId: string,
	name: string
): Promise<void> {
	await actOnMirroredAgent(peerId, agentId, { kind: 'rename-tab', tabId, name });
}

/**
 * What a host said to an action on one of its waiting messages: `true` it did it, `false` it
 * refused (the message no longer waits, or its tab is mid-turn; a notice is already shown), and
 * `null` it did not answer (the red toast is already shown). A caller that reports the outcome,
 * such as `maestro-cli queue`, reads this instead of assuming success.
 */
export type HostQueueAnswer = boolean | null;

/**
 * Take a waiting message out of a mirrored agent's host queue (the queued card's remove button).
 * The host's `queue.changed` then updates every window. A message that already started is not an
 * error to fix, so it is a notice, not a red toast.
 */
export async function removeMirrorQueuedItem(
	peerId: string,
	agentId: string,
	itemId: string
): Promise<HostQueueAnswer> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'remove-queued', itemId });
	if (result?.kind !== 'remove-queued') return null;
	if (!result.removed) {
		notifyToast({
			color: 'yellow',
			title: 'Message not removed',
			message: 'It no longer waits on the host: it may have started already.',
		});
	}
	return result.removed;
}

/**
 * Hold a waiting message on its host, or release it (the queued card's Hold / Resume). A message
 * that already started is a notice, not a red toast.
 */
export async function setMirrorQueuedItemPaused(
	peerId: string,
	agentId: string,
	itemId: string,
	paused: boolean
): Promise<HostQueueAnswer> {
	const result = await actOnMirroredAgent(peerId, agentId, {
		kind: 'pause-queued',
		itemId,
		paused,
	});
	if (result?.kind !== 'pause-queued') return null;
	if (!result.found) {
		notifyToast({
			color: 'yellow',
			title: paused ? 'Message not held' : 'Message not resumed',
			message: 'It no longer waits on the host: it may have started already.',
		});
	}
	return result.found;
}

/**
 * What a host said to a Merge: the id of the message it folded into (the host picks the one
 * above in its own order, which can differ from the one this machine saw), `true` when it merged
 * but named no target, `false` it refused, `null` it did not answer.
 */
export type HostMergeAnswer = string | boolean | null;

/**
 * Fold a waiting message into the one above it on its host (the queued card's Merge). The host's
 * queue update redraws both cards; a message that no longer waits is a notice, not a red toast.
 */
export async function mergeMirrorQueuedItem(
	peerId: string,
	agentId: string,
	itemId: string
): Promise<HostMergeAnswer> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'merge-queued', itemId });
	if (result?.kind !== 'merge-queued') return null;
	if (!result.merged) {
		notifyToast({
			color: 'yellow',
			title: 'Messages not merged',
			message: 'They no longer both wait on the host: one may have started already.',
		});
		return false;
	}
	return result.mergedIntoId || true;
}

/**
 * Rewrite a waiting message on its host (the queued card's Edit). The host's queue update redraws
 * the card; a message that no longer waits is a notice, not a red toast.
 */
export async function editMirrorQueuedItem(
	peerId: string,
	agentId: string,
	itemId: string,
	edit: QueuedTurnEdit
): Promise<HostQueueAnswer> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'edit-queued', itemId, edit });
	if (result?.kind !== 'edit-queued') return null;
	if (!result.found) {
		notifyToast({
			color: 'yellow',
			title: 'Message not edited',
			message: 'It no longer waits on the host: it may have started already.',
		});
	}
	return result.found;
}

/**
 * Move a waiting message on its host (the queued card's drag). `toIndex` counts the host's waiting
 * messages, of `tabId` only when given. The host's queue update redraws the list; a message that
 * no longer waits is a notice, not a red toast.
 */
export async function moveMirrorQueuedItem(
	peerId: string,
	agentId: string,
	itemId: string,
	toIndex: number,
	tabId?: string
): Promise<HostQueueAnswer> {
	const result = await actOnMirroredAgent(peerId, agentId, {
		kind: 'move-queued',
		itemId,
		toIndex,
		...(tabId ? { tabId } : {}),
	});
	if (result?.kind !== 'move-queued') return null;
	if (!result.moved) {
		notifyToast({
			color: 'yellow',
			title: 'Message not moved',
			message: 'It no longer waits on the host: it may have started already.',
		});
	}
	return result.moved;
}

/**
 * Run a waiting message on its host now instead of in its turn (the queued card's Force Send).
 * The host decides as a local Force Send does; a message it cannot start is a notice.
 */
export async function sendMirrorQueuedItemNow(
	peerId: string,
	agentId: string,
	itemId: string
): Promise<HostQueueAnswer> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'send-now-queued', itemId });
	if (result?.kind !== 'send-now-queued') return null;
	if (!result.sent) {
		notifyToast({
			color: 'yellow',
			title: 'Message not sent now',
			message: 'Its tab on the host is mid-turn, or it already started.',
		});
	}
	return result.sent;
}

/**
 * Hand a waiting message to the turn running on its host tab (the queued card's Steer). The host
 * runs its own steer and answers with the outcome; the caller reports it. Null when the host could
 * not be reached (already a red toast): the message still waits there.
 */
export async function steerMirrorQueuedItem(
	peerId: string,
	agentId: string,
	itemId: string
): Promise<QueueSteerResult | null> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'steer-queued', itemId });
	return result?.kind === 'steer-queued' ? result.result : null;
}

/**
 * Ask a `/btw` side question of a mirrored tab: the host forks its own tab and answers. Answers
 * the reply text, or `{ error }` with no toast: the side-question card shows the failure where
 * the answer would have gone, as it does for a local agent.
 */
export async function askMirrorSideQuestion(
	peerId: string,
	agentId: string,
	tabId: string,
	question: string
): Promise<{ answer: string } | { error: string }> {
	const answer = await callMirroredAgentAction(peerId, agentId, {
		kind: 'side-question',
		tabId,
		question,
	});
	if (!answer) return { error: 'Federation is not available in this window.' };
	if (!answer.ok) return { error: answer.error };
	return answer.result.kind === 'side-question'
		? { answer: answer.result.answer }
		: { error: 'The host answered something else.' };
}

/**
 * Consult a mirrored agent for an agent on this machine (`@mention`, `maestro-cli ask`): the host
 * runs the consult in its own hidden consult tab and History, as a local target does here.
 * Answers the reply and the name the host reports, or `{ error }` with no toast: the consult's
 * bubble shows the failure where the answer would have gone, as it does for a local target.
 */
export async function askMirrorConsult(
	peerId: string,
	agentId: string,
	consult: Omit<Extract<PeerAgentAction, { kind: 'consult' }>, 'kind'>
): Promise<{ answer: string; agentName?: string } | { error: string }> {
	const answer = await callMirroredAgentAction(peerId, agentId, { kind: 'consult', ...consult });
	if (!answer) return { error: 'Federation is not available in this window.' };
	if (!answer.ok) return { error: answer.error };
	return answer.result.kind === 'consult'
		? {
				answer: answer.result.answer,
				...(answer.result.agentName ? { agentName: answer.result.agentName } : {}),
			}
		: { error: 'The host answered something else.' };
}

/**
 * Stop on the asking tab, carried to the host: end the consults that tab has running there, which
 * end as stopped ones in the host's consult tab and History, as main ends a local target's. The
 * bubble already shows the consult stopped; a Stop that did not reach the host is a red toast,
 * since the host may still finish that consult. Answers whether the host took it.
 */
export async function cancelMirrorConsult(
	peerId: string,
	agentId: string,
	asker: { agentId: string; tabId: string }
): Promise<boolean> {
	const answer = await callMirroredAgentAction(peerId, agentId, { kind: 'consult-cancel', asker });
	if (answer?.ok) return true;
	notifyToast({
		color: 'red',
		title: ACTION_FAILURE_TITLES['consult-cancel'],
		message: `${answer?.error ?? 'Federation is not available in this window.'} The host may still finish the consult.`,
	});
	return false;
}

/**
 * The closed-tab stack of a mirrored agent, read from its host, newest first and bounded. Empty
 * with no toast when the host cannot say (down, or an older host): a Quick Chat route then simply
 * has no closed conversation to offer, as a local agent with none.
 */
export async function readMirrorClosedTabs(
	peerId: string,
	agentId: string
): Promise<ClosedTabSummary[]> {
	const answer = await callMirroredAgentAction(peerId, agentId, { kind: 'closed-tabs' });
	return answer?.ok && answer.result.kind === 'closed-tabs' ? answer.result.closedTabs : [];
}

/**
 * Reopen a closed tab of a mirrored agent on its host, in the background: the newest, or the one
 * closed as `tabId`. The tab open there now, or null after a red toast when the host refused.
 */
export async function reopenMirrorClosedTab(
	peerId: string,
	agentId: string,
	target: { index?: number; tabId?: string }
): Promise<{ tabId: string; wasDuplicate?: boolean } | null> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'reopen-tab', ...target });
	return result?.kind === 'reopen-tab'
		? { tabId: result.tabId, ...(result.wasDuplicate ? { wasDuplicate: true } : {}) }
		: null;
}

/**
 * Close a mirrored tab on its host: it moves to the host's closed-tab history. Whether the host
 * took it (a refusal is a red toast).
 */
export async function closeMirrorTab(
	peerId: string,
	agentId: string,
	tabId: string
): Promise<boolean> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'close-tab', tabId });
	return result !== null;
}

/** Star or unstar a mirrored tab on its host. */
export async function starMirrorTab(
	peerId: string,
	agentId: string,
	tabId: string,
	starred: boolean
): Promise<void> {
	await actOnMirroredAgent(peerId, agentId, { kind: 'star-tab', tabId, starred });
}
