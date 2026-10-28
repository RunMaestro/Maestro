/**
 * useVoiceScopeFollow - keep a Tab or Agent mode voice session on the agent and
 * tab the user is working in.
 *
 * Tab mode means "this tab" and Agent mode means "this agent". Both used to be
 * bound once, when the mode was picked, and then stay there: switch to another
 * agent and the next sentence still went to the first one, with nothing but the
 * HUD's header to say so. Now a move to another agent or tab re-binds the
 * session, and the header and the switch follow it.
 *
 * What it follows is a CHANGE of focus, never a mismatch. A session opened by
 * an agent's own wake phrase is bound to that agent whatever is on screen, and
 * picking Agent mode from the Conductor binds to the agent the last request
 * went to; neither is "wrong" and neither is corrected. The binding moves only
 * when the user goes somewhere. A change that the session itself caused (a
 * dispatch that brought its own tab to the front) arrives here too and is a
 * no-op, because the tab in front is then the one already bound.
 *
 * The rule is `scopeFollowingFocus`; this hook only watches for the change and
 * delivers the result. A live session is re-bound through main, which owns the
 * session. A session that has ended while the HUD stayed up has nothing to
 * re-bind, so the scope the talk button will restart on is updated instead.
 */

import { useEffect, useRef } from 'react';

import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { scopeFollowingFocus, type VoiceFocus } from '../../../shared/acappella/voice-mode';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { resolveFocusedAiTabId } from '../../utils/panelLayout';

/** Separates the two ids in the focus key. Not a character either can contain. */
const FOCUS_KEY_SEPARATOR = '\n';

/**
 * What the user is looking at right now, read from the store.
 *
 * Exported for the mode switch, which binds to the same thing: one reader, so
 * "this tab" cannot mean one tab when a mode is picked and another on the next
 * move.
 */
export function readVoiceFocus(): VoiceFocus {
	const state = useSessionStore.getState();
	// `activeSessionId`, not the selector's fallback to the first agent: with no
	// agent selected there is nothing on screen to follow.
	const session = state.activeSessionId ? selectActiveSession(state) : null;
	return {
		agentSessionId: session?.id ?? null,
		tabId: resolveFocusedAiTabId(session),
	};
}

/**
 * @param enabled This window owns the voice surface. Voice events reach every
 *                window, so an unowned one must not re-bind a session that
 *                belongs to another.
 */
export function useVoiceScopeFollow(enabled: boolean): void {
	// A string, so the HUD re-renders when the focus moves and not on every
	// session-store write (a streaming reply writes several times a second).
	const focusKey = useSessionStore((state) => {
		const session = state.activeSessionId ? selectActiveSession(state) : null;
		return `${session?.id ?? ''}${FOCUS_KEY_SEPARATOR}${resolveFocusedAiTabId(session) ?? ''}`;
	});
	// There is a surface to follow for: a live session, or the HUD still up after
	// one ended. With neither, the scope in the store is a finished session's
	// leftover and the next trigger supplies its own.
	const following = useVoiceSessionStore(
		(s) => enabled && (isVoiceSessionActive(s.state) || s.surfaced)
	);

	/** The focus last seen while following, or null before the first look. */
	const seenKey = useRef<string | null>(null);

	useEffect(() => {
		if (!following) {
			// Forget it: a move made while not following is not a move to act on
			// later, when a session happens to start.
			seenKey.current = null;
			return;
		}
		const previous = seenKey.current;
		seenKey.current = focusKey;
		// First look since following began: this is where the user already was.
		if (previous === null || previous === focusKey) return;

		const voice = useVoiceSessionStore.getState();
		const next = scopeFollowingFocus(voice.scope, readVoiceFocus());
		if (!next) return;

		if (isVoiceSessionActive(voice.state)) {
			// False means the session ended in between; the next move finds it idle.
			void window.maestro.voice.setScope(next).catch(() => undefined);
		} else {
			voice.rememberScope(next);
		}
	}, [focusKey, following]);
}
