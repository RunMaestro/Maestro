/**
 * documentVoice - the single "talk with this document" flow.
 *
 * Three surfaces offer it (the File Preview toolbar's microphone, the Files
 * panel right-click menu, and the command palette's "File: Talk with Document"
 * entry) and all three route here, so the Encore gate, the owning agent, the
 * un-hiding of the HUD, and the refusal toast can never drift apart between
 * them. Same arrangement as `fileDeletion.ts`, and for the same reason.
 *
 * It is a module function rather than a hook because two of those three callers
 * are not components: the palette builds plain command objects, and
 * `FilePreview` reaches for the active session the same way its deep-link code
 * already does. `useVoiceAgentActions` exposes it as `talkToDocument` so a
 * component with a `Session` in hand does not have to resolve one.
 */

import { beginVoiceSession, useVoiceSessionStore } from '../stores/voiceSessionStore';
import { useVoiceUiStore } from '../stores/voiceUiStore';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore, selectACappellaEnabled } from '../stores/settingsStore';
import { notifyToast } from '../stores/notificationStore';
import { getBasename } from '../../shared/formatters';

export interface TalkWithDocumentRequest {
	/** Absolute path of the document, as the owning agent sees it. */
	path: string;
	/**
	 * Agent whose workspace the document is in. Defaults to the active session,
	 * which is what the preview toolbar and the palette are scoped to; the Files
	 * panel passes its own agent explicitly, because the panel can be showing a
	 * different one from the tab in front of it.
	 */
	sessionId?: string;
}

/**
 * Whether to offer the action at all.
 *
 * Read as a plain store value rather than as a hook so a menu builder can call
 * it. Components subscribing to the flag should keep using
 * `useSettingsStore(selectACappellaEnabled)` so they re-render when it flips.
 */
export function canTalkWithDocument(): boolean {
	return selectACappellaEnabled(useSettingsStore.getState());
}

/**
 * Open a voice session about one document.
 *
 * Un-hiding the HUD is not incidental, and it is the same rule
 * `useVoiceAgentActions.talkToAgent` follows: someone who minimized the HUD
 * earlier and has now asked to talk to a file has asked for a microphone, and
 * opening one with no visible surface attached is exactly what the close button
 * exists to prevent.
 */
export async function talkWithDocument({
	path,
	sessionId,
}: TalkWithDocumentRequest): Promise<void> {
	if (!canTalkWithDocument() || !path) return;

	// `selectActiveSession` rather than `activeSessionId` straight: the id is `''`
	// on a fresh launch and can name an agent that has since been closed, and this
	// is the same resolution every other surface uses to answer "which agent".
	const agentSessionId = sessionId ?? selectActiveSession(useSessionStore.getState())?.id;
	if (!agentSessionId) {
		// No agent means no workspace to read the document in. Saying so beats a
		// menu entry that quietly does nothing.
		notifyToast({
			color: 'orange',
			title: 'No agent to talk to',
			message: `Open an agent before talking about ${getBasename(path)}.`,
		});
		return;
	}

	useVoiceSessionStore.getState().setDismissed(false);
	useVoiceUiStore.getState().setMinimized(false);

	try {
		await beginVoiceSession({ kind: 'document', sessionId: agentSessionId, path });
	} catch (error) {
		// A refusal here is expected and specific: the capability gate says a model
		// is missing, or the microphone was denied. It reaches the user as a toast
		// rather than as silence, because the entry they clicked otherwise appears
		// to do nothing at all.
		notifyToast({
			color: 'orange',
			title: 'Voice session could not start',
			message: (error as Error).message,
		});
	}
}
