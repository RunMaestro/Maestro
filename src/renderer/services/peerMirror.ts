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

import { mirrorKey } from '../../shared/maestro-lib/client/peer-mirror';
import type {
	PeerAgentAction,
	PeerAgentActionKind,
	PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
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

/** Copy the `peer:agent` address maestro-cli takes for a mirrored agent. */
export async function copyPeerAgentRef(peerId: string, agentId: string): Promise<void> {
	const ref = mirrorKey(peerId, agentId);
	if (await safeClipboardWrite(ref)) flashCopiedToClipboard(ref);
}

/** The toast title for a failed action, by kind. */
const ACTION_FAILURE_TITLES: Record<PeerAgentActionKind, string> = {
	send: 'Message not sent',
	interrupt: 'Could not stop the turn',
	'new-tab': 'Could not open a tab',
	'rename-tab': 'Could not rename the tab',
	'star-tab': 'Could not change the star',
};

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
	const api = window.maestro?.federation;
	if (!api) return null;
	let error: string;
	try {
		const answer = await api.act(peerId, agentId, action);
		if (answer.ok) return answer.result;
		error = answer.unknown
			? `${answer.error} The host may have taken it: check the tab before sending again.`
			: answer.error;
	} catch (caught) {
		error = ipcErrorMessage(caught);
	}
	notifyToast({ color: 'red', title: ACTION_FAILURE_TITLES[action.kind], message: error });
	return null;
}

/** Send what the person typed to one mirrored tab. True when the host took it (ran or queued). */
export async function sendToMirroredTab(
	peerId: string,
	agentId: string,
	tabId: string,
	text: string
): Promise<boolean> {
	return (await actOnMirroredAgent(peerId, agentId, { kind: 'send', tabId, text })) !== null;
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

/** Open a new tab on the host and show it once the host's update lands. */
export async function openMirrorTab(peerId: string, agentId: string): Promise<void> {
	const result = await actOnMirroredAgent(peerId, agentId, { kind: 'new-tab' });
	if (result?.kind === 'new-tab') {
		usePeerMirrorStore.getState().selectMirrorTab(peerId, agentId, result.tabId);
	}
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

/** Star or unstar a mirrored tab on its host. */
export async function starMirrorTab(
	peerId: string,
	agentId: string,
	tabId: string,
	starred: boolean
): Promise<void> {
	await actOnMirroredAgent(peerId, agentId, { kind: 'star-tab', tabId, starred });
}
