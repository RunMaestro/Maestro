/**
 * The three ways to put a message into a document chat.
 *
 * One vocabulary, in one place, because three surfaces read it: the composer's
 * mode switch, the persisted preference (`usePersistedChoice` validates against
 * this list), and the copy that tells the user what the push button will do.
 *
 * The distinction that matters is between the two microphone modes, and it is
 * about where the words LAND rather than about which engine hears them:
 *
 *   - `push-to-type` puts them in the text box. You read them, fix them, and
 *     send when you are ready. Nothing is spoken back.
 *   - `push-to-conversation` opens a voice session about the document. The turn
 *     is routed and the reply is spoken, which is a different thing entirely
 *     from dictation and needs to be a different mode rather than a setting
 *     buried behind the same button.
 *
 * A mode is a preference, not per-document state: someone who works by talking
 * works by talking in every file. It is stored under one localStorage key.
 */

export const DOCUMENT_CHAT_MODES = ['type', 'push-to-type', 'push-to-conversation'] as const;

export type DocumentChatMode = (typeof DOCUMENT_CHAT_MODES)[number];

/**
 * Typing, because it is the mode that always works: it needs no microphone
 * permission, no speech engine, and no Encore Feature switched on.
 */
export const DEFAULT_DOCUMENT_CHAT_MODE: DocumentChatMode = 'type';

/** localStorage key for the remembered mode. */
export const DOCUMENT_CHAT_MODE_STORAGE_KEY = 'documentChat.mode';

/** Short label for the mode switch. */
export const DOCUMENT_CHAT_MODE_LABELS: Record<DocumentChatMode, string> = {
	type: 'Type',
	'push-to-type': 'Push to type',
	'push-to-conversation': 'Push to talk',
};

/** What the mode does, for the switch's tooltip. */
export const DOCUMENT_CHAT_MODE_HINTS: Record<DocumentChatMode, string> = {
	type: 'Type your message and press Enter',
	'push-to-type': 'Hold the microphone and speak; the words land in the box for you to send',
	'push-to-conversation': 'Hold the microphone and speak; the reply is spoken back',
};

/** True for the two modes that put a microphone button beside the box. */
export function isPushMode(mode: DocumentChatMode): boolean {
	return mode === 'push-to-type' || mode === 'push-to-conversation';
}

/**
 * Narrow an untrusted value. Anything unrecognised reads as the default rather
 * than stranding the composer in a mode it has no control for.
 */
export function asDocumentChatMode(value: unknown): DocumentChatMode {
	return (DOCUMENT_CHAT_MODES as readonly string[]).includes(value as string)
		? (value as DocumentChatMode)
		: DEFAULT_DOCUMENT_CHAT_MODE;
}
