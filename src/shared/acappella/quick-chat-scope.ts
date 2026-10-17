/**
 * Talking to Quick Chat: what a Quick Chat voice session does differently.
 *
 * Quick Chat is a small floating window for a fast conversation with one agent
 * (see `src/shared/quickChat.ts`). Its microphone opens a voice session bound to
 * that conversation, and three rules make the binding a lock rather than a
 * starting point. They live here, in `shared/`, for the same reason the document
 * rules do: the session service applies them to every turn, the dispatch
 * executor delivers by them, and the Quick Chat window draws from the same
 * scope.
 *
 *   1. **Every sentence is the message.** Nothing is routed. The Conductor is
 *      not asked which agent or which tab, so it cannot move the turn, ask a
 *      question, or answer in place of the agent.
 *   2. **Quick Chat delivers it.** The turn goes through the same `send` command
 *      the window's Send button and `maestro-cli quick-chat send` use. That is
 *      what creates the chat's tab on the first sentence, keeps an ephemeral tab
 *      hidden, and leaves the main window's view where it is.
 *   3. **It cannot be re-bound.** The Tab / Agent / Conductor switch does not
 *      apply, and the binding does not follow focus in the main window. A Quick
 *      Chat session is started from Quick Chat and ended there.
 */

import type { QuickChatVoiceScope, VoiceScope } from './protocol';
import type { RouteDecision } from './route-decision';

/** The one Quick Chat scope. It carries no ids, so every instance is equal. */
export const QUICK_CHAT_VOICE_SCOPE: Readonly<QuickChatVoiceScope> = { kind: 'quick-chat' };

/** What a surface calls this binding. */
export const QUICK_CHAT_VOICE_LABEL = 'Quick Chat';

/**
 * The `brainProviderId` a Quick Chat `route-decision` carries. No Brain ran, so
 * the routing log must not count the turn (see `isScopeRouterId` in
 * `./voice-mode`).
 */
export const QUICK_CHAT_SCOPE_ROUTER_ID = 'quick-chat-scope';

/** Narrow a scope to the Quick Chat binding. */
export function isQuickChatScope(
	scope: VoiceScope | null | undefined
): scope is QuickChatVoiceScope {
	return !!scope && scope.kind === 'quick-chat';
}

/**
 * The decision for one utterance in a Quick Chat session.
 *
 * The utterance is the message, whole. The target is `conductor` in the wire
 * sense of "no agent is named here": Quick Chat resolves its own agent and tab
 * when the message lands, and the `dispatch` event that follows reports the ones
 * it used. `tabAction` is `current` for the same reason. The executor reads the
 * SCOPE, not these two fields, to know the turn is Quick Chat's.
 */
export function quickChatScopeDecision(utterance: string): RouteDecision {
	return {
		target: 'conductor',
		tabAction: 'current',
		prompt: utterance.trim(),
		confidence: 1,
	};
}

/**
 * Why a live session bound to `current` cannot be re-bound to `next`, or null
 * when it can.
 *
 * Both directions are refused. A Quick Chat session is locked to its
 * conversation, and a session that began somewhere else cannot become one: the
 * window that shows a session is fixed when it starts, so switching INTO Quick
 * Chat would leave the microphone open with its surface in the wrong window.
 */
export function scopeRebindBlocker(
	current: VoiceScope | null | undefined,
	next: VoiceScope
): string | null {
	if (isQuickChatScope(current)) {
		return 'This voice session is locked to Quick Chat. End it to talk somewhere else.';
	}
	if (isQuickChatScope(next)) {
		return 'A Quick Chat voice session is started from Quick Chat, not switched to.';
	}
	return null;
}
