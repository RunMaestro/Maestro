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
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useSettingsStore, selectACappellaEnabled } from '../../stores/settingsStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { isDocumentScope } from '../../../shared/acappella/document-scope';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { talkWithDocument } from '../../services/documentVoice';
import {
	buildDocumentChatView,
	keepDocumentChat,
	cycleDocumentChatThinking,
	restoreDocumentChat,
	stopDocumentChat,
	findDocumentChatTab,
	popOutDocumentChat,
	resetDocumentChat,
	sendDocumentChatMessage,
	type DocumentChatView,
} from '../../services/documentChat';
import type { Session, AITab } from '../../types';

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
	/** Project earlier threads only while the history picker is visible. */
	includeHistory?: boolean;
}

export interface UseDocumentChatReturn extends DocumentChatView {
	draft: string;
	setDraft: (value: string) => void;
	/** Send the draft (or explicit text) and clear the box. */
	send: (text?: string, images?: string[]) => boolean;
	keep: () => void;
	cycleThinking: () => void;
	stop: () => void;
	restore: (tabId: string) => void;
	history: (DocumentChatView & { tab: AITab })[];
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
	includeHistory = false,
}: UseDocumentChatOptions): UseDocumentChatReturn {
	const [draft, setDraft] = useState('');

	// Subscribe to this document's tabs and queue without following other tabs' output.
	const tab = useSessionStore((s) => findDocumentChatTab(resolveSession(s, sessionId), path));
	const executionQueue = useSessionStore((s) => resolveSession(s, sessionId)?.executionQueue);
	const tabs = useSessionStore(
		useShallow((s) =>
			(resolveSession(s, sessionId)?.aiTabs ?? []).filter((t) => t.documentOrigin?.path === path)
		)
	);
	const history = useMemo(
		() =>
			(includeHistory ? tabs : [])
				.slice()
				.reverse()
				.map((tab) => ({ ...buildDocumentChatView(tab, executionQueue), tab })),
		[tabs, includeHistory, executionQueue]
	);

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
		(text?: string, images?: string[]) => {
			const message = (text ?? draft).trim();
			if (!message && !images?.length) return false;
			const sent = sendDocumentChatMessage({ path, text: message, sessionId, images });
			// Only clear on a message that actually went somewhere: a send refused
			// for want of an agent must leave the user's words in the box.
			if (sent) setDraft('');
			return !!sent;
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

	const keep = useCallback(() => keepDocumentChat({ path, sessionId }), [path, sessionId]);
	const cycleThinking = useCallback(
		() => cycleDocumentChatThinking({ path, sessionId }),
		[path, sessionId]
	);
	const stop = useCallback(() => {
		void stopDocumentChat({ path, sessionId }).catch(() => undefined);
	}, [path, sessionId]);
	const restore = useCallback(
		(tabId: string) => {
			restoreDocumentChat({ path, sessionId, tabId });
			setDraft('');
		},
		[path, sessionId]
	);

	const startVoice = useCallback(() => {
		void talkWithDocument({ path, sessionId });
	}, [path, sessionId]);

	const stopVoice = useCallback(() => {
		void window.maestro.voice.stop().catch(() => undefined);
	}, []);

	return {
		...view,
		history,
		keep,
		cycleThinking,
		stop,
		restore,
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
