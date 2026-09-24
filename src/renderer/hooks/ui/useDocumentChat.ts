/**
 * useDocumentChat - live state and actions for one document's chat.
 *
 * The seam between `services/documentChat` (which owns the conversation and is
 * callable from a menu builder) and the panel that draws it. Everything
 * persistent lives in the service; everything here is subscription and the draft
 * the user is currently typing.
 *
 * The draft is local rather than parked on the tab's `inputValue`: that field is
 * the MAIN composer's draft for the same tab, and sharing it would mean typing
 * in the bubble silently rewrote what the user had half-written in the tab they
 * popped out earlier.
 */

import { useCallback, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useSettingsStore, selectACappellaEnabled } from '../../stores/settingsStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { isDocumentScope } from '../../../shared/acappella/document-scope';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { talkWithDocument } from '../../services/documentVoice';
import {
	buildDocumentChatView,
	findDocumentChatTab,
	popOutDocumentChat,
	resetDocumentChat,
	sendDocumentChatMessage,
	type DocumentChatView,
} from '../../services/documentChat';
import type { Session } from '../../types';

/**
 * The agent this chat belongs to, resolved inside the selector so both
 * subscriptions read the same one on every store update.
 */
function resolveSession(
	state: { sessions: Session[]; activeSessionId: string },
	sessionId?: string
): Session | undefined {
	return state.sessions.find((candidate) => candidate.id === (sessionId ?? state.activeSessionId));
}

export interface UseDocumentChatOptions {
	/** Absolute path of the document, as the owning agent sees it. */
	path: string;
	/** Agent the chat belongs to. Defaults to the active one. */
	sessionId?: string;
}

export interface UseDocumentChatReturn extends DocumentChatView {
	draft: string;
	setDraft: (value: string) => void;
	/** Send the draft (or explicit text) and clear the box. */
	send: (text?: string) => void;
	/** Retire this conversation and start a fresh one. */
	reset: () => void;
	/** Reveal and focus the chat's tab. No-op before the first message. */
	popOut: () => void;
	/** Whether push-to-conversation can be offered at all. */
	voiceEnabled: boolean;
	/** True while the live voice session is about THIS document. */
	voiceActive: boolean;
	/** Open a spoken conversation about this document. */
	startVoice: () => void;
	/** End it. */
	stopVoice: () => void;
	/** Tap-vs-hold threshold, mirrored from the voice control settings. */
	holdThresholdMs: number;
}

export function useDocumentChat({
	path,
	sessionId,
}: UseDocumentChatOptions): UseDocumentChatReturn {
	const [draft, setDraft] = useState('');

	// Two narrow subscriptions rather than one on the whole session. The panel
	// depends on exactly two things - the bound tab and the execution queue - and
	// both are stable by identity, so an agent streaming output into some OTHER
	// tab (which replaces the session object on every chunk) does not re-render a
	// conversation nothing happened in.
	const tab = useSessionStore((s) => findDocumentChatTab(resolveSession(s, sessionId), path));
	const executionQueue = useSessionStore((s) => resolveSession(s, sessionId)?.executionQueue);

	const view = useMemo(() => buildDocumentChatView(tab, executionQueue), [tab, executionQueue]);

	const voiceEnabled = useSettingsStore(selectACappellaEnabled);
	const holdThresholdMs = useVoiceUiStore((s) => s.holdThresholdMs);

	// Matched on the PATH rather than on "a session exists", so the button only
	// reads as active for the document it belongs to. A conversation about some
	// other file must not make this panel claim the floor.
	const voiceActive = useVoiceSessionStore(
		(s) => isVoiceSessionActive(s.state) && isDocumentScope(s.scope) && s.scope.path === path
	);

	const send = useCallback(
		(text?: string) => {
			const message = (text ?? draft).trim();
			if (!message) return;
			const sent = sendDocumentChatMessage({ path, text: message, sessionId });
			// Only clear on a message that actually went somewhere: a send refused
			// for want of an agent must leave the user's words in the box.
			if (sent) setDraft('');
		},
		[draft, path, sessionId]
	);

	const reset = useCallback(() => {
		resetDocumentChat({ path, sessionId });
		setDraft('');
	}, [path, sessionId]);

	const popOut = useCallback(() => {
		popOutDocumentChat({ path, sessionId });
	}, [path, sessionId]);

	const startVoice = useCallback(() => {
		void talkWithDocument({ path, sessionId });
	}, [path, sessionId]);

	const stopVoice = useCallback(() => {
		void window.maestro.voice.stop().catch(() => undefined);
	}, []);

	return {
		...view,
		draft,
		setDraft,
		send,
		reset,
		popOut,
		voiceEnabled,
		voiceActive,
		startVoice,
		stopVoice,
		holdThresholdMs,
	};
}

export default useDocumentChat;
