/**
 * useVoiceAgentActions - the voice actions available for a single agent.
 *
 * Three surfaces offer "Talk to this agent": the microphone under the composer's
 * Send button, the Left Bar right-click menu, and the command palette. They all
 * call this hook rather than each re-deriving the Encore gate, the scope shape,
 * and the IPC call, for the same reason `useGitAgentActions` exists - three
 * implementations of one menu entry drift, and the one that drifts is always the
 * one the user reaches for.
 *
 * It also owns jumping to a tab a turn was dispatched into, because that is the
 * other direction of the same relationship: the transcript's route chips, and
 * anything else that wants to answer "where did that go", land here.
 */

import { useCallback, useMemo } from 'react';
import { updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { selectACappellaEnabled, useSettingsStore } from '../../stores/settingsStore';
import { beginVoiceSession, useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { notifyToast } from '../../stores/notificationStore';
import { focusAiTabInSession } from '../../utils/tabHelpers';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import type { Session } from '../../types';

export interface VoiceAgentActions {
	/** The A Cappella Encore flag. False means every surface renders nothing. */
	enabled: boolean;
	/** True when the live voice session is bound to THIS agent. */
	hasVoiceFloor: boolean;
	/** True when a reply from THIS agent is being spoken right now. */
	isSpeaking: boolean;
	/** This agent's wake phrase, or null when it has none. */
	wakePhrase: string | null;
	/**
	 * Open a voice session bound to this agent, and un-hide the HUD.
	 *
	 * Un-hiding is not incidental: a user who closed the HUD earlier and then
	 * picked "Talk to this agent" has just asked for a microphone, and opening one
	 * with no visible surface attached is precisely the thing the close button
	 * exists to prevent.
	 */
	talkToAgent: () => Promise<void>;
	/**
	 * Open a conductor-scoped session, and un-hide the HUD.
	 *
	 * Same un-hiding as {@link talkToAgent}, and here for the same reason: the
	 * palette used to call `voice.start()` straight through, so asking for the
	 * conductor while the HUD was minimized opened a microphone whose only
	 * on-screen surface was still collapsed.
	 */
	talkToConductor: () => Promise<void>;
	/** End whatever voice session is running. */
	endVoiceSession: () => Promise<void>;
	/** Bring a minimized or closed HUD back without touching the session. */
	showHud: () => void;
	/** True when a session is running behind a HUD the user has put away. */
	hudHidden: boolean;
}

/**
 * Put an agent's tab on screen.
 *
 * Exported on its own because callers that only have ids (a transcript route
 * chip, a notification) have no `Session` to hand the hook. Reuses
 * `focusAiTabInSession`, which knows how to reveal a snoozed tab and reopen a
 * closed one - a voice turn's destination is very often a tab the user has since
 * put away, and a naive `activeAiTabId` write would land on nothing.
 */
export function jumpToVoiceTab(agentSessionId: string, tabId?: string): boolean {
	const store = useSessionStore.getState();
	const target = store.sessions.find((session: Session) => session.id === agentSessionId);
	if (!target) return false;
	updateSessionWith(agentSessionId, (session) => focusAiTabInSession(session, tabId));
	store.setActiveSessionId(agentSessionId);
	return true;
}

export function useVoiceAgentActions(session: Session | undefined): VoiceAgentActions {
	const enabled = useSettingsStore(selectACappellaEnabled);
	const scope = useVoiceSessionStore((s) => s.scope);
	const state = useVoiceSessionStore((s) => s.state);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);
	const wakePhrases = useVoiceUiStore((s) => s.wakePhrases);
	const minimized = useVoiceUiStore((s) => s.minimized);
	const setDismissed = useVoiceSessionStore((s) => s.setDismissed);
	const setMinimized = useVoiceUiStore((s) => s.setMinimized);

	const agentSessionId = session?.id;

	const hasVoiceFloor = useMemo(() => {
		if (!agentSessionId || !isVoiceSessionActive(state)) return false;
		return scope?.kind === 'agent' && scope.sessionId === agentSessionId;
	}, [agentSessionId, scope, state]);

	// Speaking is tracked against the last DISPATCH rather than the scope: a
	// conductor session speaks replies from whichever agent it routed to, and
	// that agent is the one whose row should animate.
	const isSpeaking =
		!!agentSessionId && state === 'speaking' && lastDispatch?.agentSessionId === agentSessionId;

	const talkToAgent = useCallback(async () => {
		if (!enabled || !agentSessionId) return;
		setDismissed(false);
		setMinimized(false);
		try {
			await beginVoiceSession({ kind: 'agent', sessionId: agentSessionId });
		} catch (error) {
			// A refusal here is expected and specific: the capability gate says a
			// model is missing, or the microphone was denied. It reaches the user as
			// a toast rather than as silence, because the menu entry they clicked
			// otherwise appears to do nothing at all.
			notifyToast({
				color: 'orange',
				title: 'Voice session could not start',
				message: (error as Error).message,
			});
		}
	}, [agentSessionId, enabled, setDismissed, setMinimized]);

	const talkToConductor = useCallback(async () => {
		if (!enabled) return;
		setDismissed(false);
		setMinimized(false);
		try {
			await beginVoiceSession();
		} catch (error) {
			notifyToast({
				color: 'orange',
				title: 'Voice session could not start',
				message: (error as Error).message,
			});
		}
	}, [enabled, setDismissed, setMinimized]);

	const endVoiceSession = useCallback(async () => {
		await window.maestro.voice.stop().catch(() => undefined);
	}, []);

	const showHud = useCallback(() => {
		setDismissed(false);
		setMinimized(false);
	}, [setDismissed, setMinimized]);

	return {
		enabled,
		hasVoiceFloor,
		isSpeaking,
		wakePhrase: agentSessionId ? (wakePhrases[agentSessionId] ?? null) : null,
		talkToAgent,
		talkToConductor,
		endVoiceSession,
		showHud,
		// Minimized only, matching `VoiceStatusIndicator`: `dismissed` is the close
		// button, and it ends the session, so it is never a HUD worth restoring.
		hudHidden: isVoiceSessionActive(state) && minimized,
	};
}
