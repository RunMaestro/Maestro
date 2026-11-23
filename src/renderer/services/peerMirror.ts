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

import { normalizeTurnOverrides, type TurnOverrides } from '../../shared/maestro-lib/client/types';
import type {
	PeerAgentAction,
	PeerAgentActionKind,
	PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
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

/** Force the peer's forward or client back up and reload its agents (`federation reconnect`). */
export async function reconnectPeer(peerId: string): Promise<void> {
	const api = window.maestro?.federation;
	if (!api) return;
	let error: string | undefined;
	try {
		const result = await api.reconnect(peerId);
		if (!result.ok) error = result.error ?? 'The host did not answer.';
	} catch (caught) {
		error = ipcErrorMessage(caught);
	}
	if (error) {
		notifyToast({ color: 'red', title: `Could not reconnect to ${peerId}`, message: error });
	}
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
	'update-agent': 'Could not change the agent on its host',
	'update-tab': 'Could not change the tab on its host',
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
 * one turn. True when the host took it (ran or queued).
 */
export async function sendToMirroredTab(
	peerId: string,
	agentId: string,
	tabId: string,
	text: string,
	overrides?: TurnOverrides,
	images?: readonly string[]
): Promise<boolean> {
	const clean = normalizeTurnOverrides(overrides);
	return (
		(await actOnMirroredAgent(peerId, agentId, {
			kind: 'send',
			tabId,
			text,
			...(images && images.length > 0 ? { images: [...images] } : {}),
			...(clean ? { overrides: clean } : {}),
		})) !== null
	);
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
 * Take a waiting message out of a mirrored agent's host queue (the queued card's remove button).
 * The host's `queue.changed` then updates every window. A message that already started is not an
 * error to fix, so it is a notice, not a red toast.
 */
export async function removeMirrorQueuedItem(
	peerId: string,
	agentId: string,
	itemId: string
): Promise<void> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'remove-queued', itemId });
	if (result?.kind === 'remove-queued' && !result.removed) {
		notifyToast({
			color: 'yellow',
			title: 'Message not removed',
			message: 'It no longer waits on the host: it may have started already.',
		});
	}
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
): Promise<void> {
	const result = await actOnMirroredAgent(peerId, agentId, {
		kind: 'pause-queued',
		itemId,
		paused,
	});
	if (result?.kind === 'pause-queued' && !result.found) {
		notifyToast({
			color: 'yellow',
			title: paused ? 'Message not held' : 'Message not resumed',
			message: 'It no longer waits on the host: it may have started already.',
		});
	}
}

/** Close a mirrored tab on its host: it moves to the host's closed-tab history. */
export async function closeMirrorTab(
	peerId: string,
	agentId: string,
	tabId: string
): Promise<void> {
	await actOnMirroredAgent(peerId, agentId, { kind: 'close-tab', tabId });
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
