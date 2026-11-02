/**
 * documentVoice - the single "talk with this document" flow.
 *
 * Three surfaces offer it (the document chat's microphone, the Files
 * panel right-click menu, and the command palette's "File: Talk with Document"
 * entry) and all three route to the document chat's own microphone. The file
 * and its panel open before recording starts; no separate voice HUD is needed.
 *
 * It is a module function rather than a hook because two of those three callers
 * are not components: the palette builds plain command objects, and
 * `FilePreview` reaches for the active session the same way its deep-link code
 * already does. `useVoiceAgentActions` exposes it as `talkToDocument` so a
 * component with a `Session` in hand does not have to resolve one.
 */

import { resolveDocumentChatAgentId } from './documentChat';
import { openVoiceMic } from './voiceListening';
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
 * Open the document and ask its chat panel to start its own microphone.
 */
export async function talkWithDocument({
	path,
	sessionId,
}: TalkWithDocumentRequest): Promise<void> {
	if (!canTalkWithDocument() || !path) return;

	// Use the same owning-agent resolution as the document chat.
	const agentSessionId = resolveDocumentChatAgentId(sessionId);
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

	// Reuse the normal file-open path, including SSH reads and existing tabs.
	window.dispatchEvent(
		new CustomEvent('maestro:openFileTab', {
			detail: { sessionId: agentSessionId, filePath: path, documentChat: 'voice' },
		})
	);
}

/** The panel's microphone, shared with the navigation shortcut once it opens. */
export async function startDocumentVoice(
	{ path, sessionId }: TalkWithDocumentRequest,
	hold = false
): Promise<void> {
	if (!canTalkWithDocument() || !path) return;
	const agentSessionId = resolveDocumentChatAgentId(sessionId);
	if (!agentSessionId) return;
	await openVoiceMic({ scope: { kind: 'document', sessionId: agentSessionId, path }, hold });
}
