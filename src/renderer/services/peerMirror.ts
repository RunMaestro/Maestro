/**
 * The actions a window takes on a Federation peer it mirrors (FED-SSH-05, read-only).
 *
 * Every one goes through `window.maestro.federation` to the one main-process service, the same
 * one `maestro-cli federation` reaches. None writes a local store: a transcript read lands in
 * `peerMirrorStore` only, and a reconnect changes the main service's own memory.
 */

import { mirrorKey } from '../../shared/maestro-lib/client/peer-mirror';
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
