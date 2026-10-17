/**
 * The three ways to talk to Maestro, and what each one lets the Conductor do.
 *
 *   - **Tab.** You are talking to one tab. Every utterance goes to that tab,
 *     verbatim, and the Conductor is not consulted: there is nothing to decide,
 *     so asking a router would only add latency and a chance to misroute.
 *   - **Agent.** You are talking to one agent. The Conductor decides only WHICH
 *     TAB - the current one, a new one ("open a new tab about the auth bug"), or
 *     one recalled by name ("back to the migration tab") - and never moves the
 *     request to a different agent, never asks which agent you meant, and never
 *     answers in place of the agent.
 *   - **Conductor.** You are talking to Maestro. The Conductor picks the agent
 *     and the tab, asks when it is unsure, and in conversational mode talks with
 *     you until there is a request.
 *
 * A fourth binding, the document conversation, is a tab binding that also knows
 * which file it is about; its rules live in `./document-scope`. A fifth, the
 * Quick Chat conversation, is locked to the Quick Chat window's chat; its rules
 * live in `./quick-chat-scope`.
 *
 * The rules are applied AFTER the Brain has read the utterance (Agent mode) or
 * instead of it (Tab mode), in the session service, so every Brain - keyword,
 * local model, hosted model - obeys the same boundaries without each one having
 * to be told.
 */

import { voiceScopeAgentId } from './document-scope';
import type { AgentVoiceScope, RosterAgent, VoiceScope } from './protocol';
import { isQuickChatScope, QUICK_CHAT_SCOPE_ROUTER_ID } from './quick-chat-scope';
import type { RouteDecision } from './route-decision';

export type VoiceMode = 'tab' | 'agent' | 'conductor' | 'document' | 'quick-chat';

/**
 * The `brainProviderId` a Tab-mode `route-decision` carries. No Brain ran, and
 * the routing log measures Brains: a dispatch stamped with this is not counted
 * as (and must not overwrite the outcome of) a routed turn.
 */
export const TAB_SCOPE_ROUTER_ID = 'tab-scope';

/**
 * The `brainProviderId` for a turn whose SCOPE decides where it goes, or null
 * when a Brain routes it.
 *
 * Tab mode and a Quick Chat session both send the utterance as the message,
 * with no Conductor in between. One function names the two, so the session
 * service stamps the decision and skips the correction path by the same test.
 */
export function scopeRouterId(scope: VoiceScope | null | undefined): string | null {
	if (isQuickChatScope(scope)) return QUICK_CHAT_SCOPE_ROUTER_ID;
	return voiceScopeTabId(scope) ? TAB_SCOPE_ROUTER_ID : null;
}

/** Whether a `route-decision` was stamped by a scope, not by a Brain. */
export function isScopeRouterId(brainProviderId: string): boolean {
	return brainProviderId === TAB_SCOPE_ROUTER_ID || brainProviderId === QUICK_CHAT_SCOPE_ROUTER_ID;
}

/** Which of the modes a scope is. */
export function voiceScopeMode(scope: VoiceScope | null | undefined): VoiceMode {
	if (!scope || scope.kind === 'conductor') return 'conductor';
	if (scope.kind === 'document') return 'document';
	if (scope.kind === 'quick-chat') return 'quick-chat';
	return scope.tabId ? 'tab' : 'agent';
}

/**
 * Whether two scopes are the same binding: the same kind, on the same agent,
 * tab and document. A missing scope equals nothing, not even another missing
 * one, because "no session" is not a binding to resume.
 */
export function isSameVoiceScope(
	a: VoiceScope | null | undefined,
	b: VoiceScope | null | undefined
): boolean {
	if (!a || !b) return false;
	if (a.kind === 'agent') {
		return b.kind === 'agent' && a.sessionId === b.sessionId && a.tabId === b.tabId;
	}
	if (a.kind === 'document') {
		return b.kind === 'document' && a.sessionId === b.sessionId && a.path === b.path;
	}
	// The Conductor and Quick Chat carry no ids: the kind is the whole binding.
	return a.kind === b.kind;
}

/** The tab a Tab-mode scope is pinned to, or null for every other mode. */
export function voiceScopeTabId(scope: VoiceScope | null | undefined): string | null {
	return scope?.kind === 'agent' && scope.tabId ? scope.tabId : null;
}

/** Narrow a scope to Tab mode. */
export function isTabScope(
	scope: VoiceScope | null | undefined
): scope is AgentVoiceScope & { tabId: string } {
	return voiceScopeTabId(scope) !== null;
}

/** Narrow a scope to Agent mode (bound to an agent, no tab pinned). */
export function isAgentModeScope(scope: VoiceScope | null | undefined): scope is AgentVoiceScope {
	return voiceScopeMode(scope) === 'agent';
}

/**
 * The decision for one utterance in Tab mode.
 *
 * The utterance is the message. Nothing is stripped (there is no routing
 * chatter to remove: you are not telling a router where to send it), and the
 * tab is recalled by id rather than "current": the binding is what decides
 * where a sentence goes, never whichever tab happens to be in front when it
 * lands. Moving to another tab does move the conversation, but by re-binding
 * the session ({@link scopeFollowingFocus}), which the HUD shows, and not as a
 * side effect of the dispatch. Recall is also what wakes a snoozed tab or
 * reopens a closed one, which is the right thing for a conversation the user
 * is bound to.
 */
export function tabScopeDecision(
	utterance: string,
	scope: AgentVoiceScope & { tabId: string }
): RouteDecision {
	return {
		target: { sessionId: scope.sessionId },
		tabAction: 'recall',
		tabId: scope.tabId,
		prompt: utterance.trim(),
		confidence: 1,
	};
}

/**
 * Hold a Brain's decision to the bound agent, in Agent mode.
 *
 * What survives from the Brain is its reading of the TAB (current, new, or a
 * recalled tab of this agent) and its cleaned prompt. What does not:
 *
 *   - A target that is another agent, or the Conductor itself. Naming another
 *     agent in Agent mode is part of the request ("compare this with what the
 *     backend agent did"), not an instruction to leave; Conductor mode is how
 *     you address the fleet.
 *   - A recalled tab that belongs to some other agent. It degrades to the
 *     current tab rather than failing the turn.
 *   - A clarifying question or a conversational reply. Both are the Conductor
 *     speaking for itself, which is exactly what Agent mode says not to do: the
 *     words go to the agent.
 *
 * @param utterance What was said, used when the Brain produced no prompt (a
 *                  conversational reply carries none).
 */
export function applyAgentScope(
	decision: RouteDecision,
	scope: AgentVoiceScope,
	roster: readonly RosterAgent[],
	utterance: string
): RouteDecision {
	const agent = roster.find((candidate) => candidate.sessionId === scope.sessionId);
	const target = { sessionId: scope.sessionId };
	// The Brain cleaned its prompt for the agent IT picked, which meant cutting
	// that agent's name out. When it picked another agent, the name is part of
	// what the bound agent has to act on, so the utterance goes over whole.
	const retargeted =
		decision.target !== 'conductor' && decision.target.sessionId !== scope.sessionId;
	const prompt = (retargeted ? '' : decision.prompt.trim()) || utterance.trim();

	const ownsTab = (tabId: string | undefined): boolean =>
		!!tabId && !!agent?.tabs.some((tab) => tab.id === tabId);

	const tabAction =
		decision.tabAction === 'recall' && !ownsTab(decision.tabId) ? 'current' : decision.tabAction;

	return {
		target,
		tabAction,
		...(tabAction === 'recall' ? { tabId: decision.tabId } : {}),
		...(tabAction === 'new' && decision.tabName ? { tabName: decision.tabName } : {}),
		prompt,
		confidence: decision.confidence,
	};
}

/**
 * The three modes a user switches between. Document and Quick Chat
 * conversations are opened, not switched to.
 */
export type SwitchableVoiceMode = Exclude<VoiceMode, 'document' | 'quick-chat'>;

/** In the order the HUD draws them, which is also the order Tab walks them. */
export const SWITCHABLE_VOICE_MODES: readonly SwitchableVoiceMode[] = ['tab', 'agent', 'conductor'];

/**
 * The mode a scope shows as in the switch.
 *
 * A document conversation is a tab binding that also knows its file, so it reads
 * as Tab; switching away from it leaves the document behind. A Quick Chat
 * session reads as Tab too (every sentence goes to one conversation), and it
 * cannot be switched away from: see `scopeRebindBlocker` in `./quick-chat-scope`.
 */
export function switchableVoiceMode(scope: VoiceScope | null | undefined): SwitchableVoiceMode {
	const mode = voiceScopeMode(scope);
	return mode === 'document' || mode === 'quick-chat' ? 'tab' : mode;
}

/**
 * The mode one step along from `mode`, wrapping at both ends.
 *
 * One function for the Tab key and Shift+Tab, so the key walks the switch in the
 * order it is drawn rather than in an order re-derived beside it.
 */
export function stepSwitchableVoiceMode(
	mode: SwitchableVoiceMode,
	direction: 1 | -1 = 1
): SwitchableVoiceMode {
	const count = SWITCHABLE_VOICE_MODES.length;
	const index = SWITCHABLE_VOICE_MODES.indexOf(mode);
	return SWITCHABLE_VOICE_MODES[(index + direction + count) % count];
}

export interface ModeTargetContext {
	/** The live session's binding. */
	scope: VoiceScope | null;
	/** Where the last utterance actually landed, when anything has been sent. */
	lastDispatch: { agentSessionId: string; tabId: string } | null;
	/** The agent on screen, or null. */
	focusedAgentId: string | null;
	/** The conversation tab in front of an agent, or null when there is none. */
	activeTabOf: (agentSessionId: string) => string | null;
}

/**
 * The binding for a mode, resolved from what the user is looking at, or null
 * when there is nothing to bind to (Agent or Tab mode with no agent).
 *
 * What is ON SCREEN wins: picking Agent means "this agent" and picking Tab
 * means "this tab". It used to prefer the agent the session was already bound
 * to and the tab the last request landed in, so picking Tab while looking at
 * one conversation could pin a different one, and the only sign was the name in
 * the HUD header. It is also the same answer {@link scopeFollowingFocus} gives
 * on the next move, so picking a mode and then moving cannot disagree.
 *
 * The rest are fallbacks for when the screen has no answer. The agent: the one
 * already bound, then the one the last utterance went to. The tab (no
 * conversation in front of that agent, e.g. a tiled file pane): the tab already
 * pinned, then the tab the last utterance landed in.
 */
export function scopeForMode(
	mode: SwitchableVoiceMode,
	context: ModeTargetContext
): VoiceScope | null {
	if (mode === 'conductor') return { kind: 'conductor' };

	const bound = voiceScopeAgentId(context.scope);
	const agentSessionId = context.focusedAgentId ?? bound ?? context.lastDispatch?.agentSessionId;
	if (!agentSessionId) return null;

	if (mode === 'agent') return { kind: 'agent', sessionId: agentSessionId };

	const pinned =
		context.scope?.kind === 'agent' && context.scope.sessionId === agentSessionId
			? (context.scope.tabId ?? null)
			: null;
	const dispatched =
		context.lastDispatch?.agentSessionId === agentSessionId ? context.lastDispatch.tabId : null;
	const tabId = context.activeTabOf(agentSessionId) ?? pinned ?? dispatched;
	return tabId ? { kind: 'agent', sessionId: agentSessionId, tabId } : null;
}

/** What the user is looking at: the agent on screen and its conversation tab. */
export interface VoiceFocus {
	/** The agent on screen, or null. */
	agentSessionId: string | null;
	/** That agent's AI tab in front, or null when none is addressed. */
	tabId: string | null;
}

/**
 * The binding after the user moved to another agent or tab, or null when the
 * session should stay where it is.
 *
 * Tab and Agent mode mean "the tab (or agent) I am working in", so the binding
 * follows the work: switch agents and Agent mode talks to the new one, switch
 * tabs and Tab mode talks to the new one. Without this the HUD kept sending to
 * wherever the mode was first picked, and the only way to move it was to leave
 * the mode and come back.
 *
 * Null, which is "do not re-bind", in five cases:
 *
 *   - **Conductor.** It is bound to nothing; the Conductor picks per sentence.
 *   - **A document conversation.** It is about a file, and stays with it.
 *   - **A Quick Chat session.** It is locked to the Quick Chat conversation.
 *   - **Tab mode with no conversation in front** (a tiled file pane, an agent
 *     with no AI tab). The pin is kept rather than degraded to Agent mode: the
 *     user picked Tab, and losing the mode because they glanced at a file would
 *     be a mode change nobody asked for.
 *   - **Nothing changed.** Re-binding clears the Conductor's pending question
 *     and conversation, so an identical scope must not be sent.
 *
 * Call it on a CHANGE of focus, not on every render. A session opened by an
 * agent's own wake phrase is bound to that agent whatever is on screen, and it
 * must stay so until the user actually goes somewhere else.
 */
export function scopeFollowingFocus(
	scope: VoiceScope | null | undefined,
	focus: VoiceFocus
): VoiceScope | null {
	const mode = voiceScopeMode(scope);
	if (!scope || scope.kind !== 'agent' || !focus.agentSessionId) return null;

	if (mode === 'agent') {
		return scope.sessionId === focus.agentSessionId
			? null
			: { kind: 'agent', sessionId: focus.agentSessionId };
	}

	if (!focus.tabId) return null;
	if (scope.sessionId === focus.agentSessionId && scope.tabId === focus.tabId) return null;
	return { kind: 'agent', sessionId: focus.agentSessionId, tabId: focus.tabId };
}
