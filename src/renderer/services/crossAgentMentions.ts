/**
 * crossAgentMentions - resolve and dispatch `@agent` mentions in a message.
 *
 * Split into two steps on purpose, because *when* a consult fires is part of
 * the contract:
 *
 * - {@link planCrossAgentMentions} resolves the mentioned targets and decides
 *   whether the source agent should still answer. It sends nothing.
 * - {@link dispatchCrossAgentMentions} fires the consults.
 *
 * A message the user sends while their agent is busy goes to the execution
 * queue, and the mention inside it must NOT reach the other agent until that
 * queued message is actually dispatched - otherwise the consulted agent starts
 * working on something the user has not asked for yet, while the source agent's
 * own turn only arrives minutes later. So the send path plans at submit time
 * (it needs to know whether the local send is suppressed) and leaves the
 * dispatch to the queue drain, which calls
 * {@link dispatchCrossAgentMentionsForMessage}.
 *
 * WHEN each consult fires relative to the source agent's own turn is read from
 * the user's wording ({@link inferMentionTiming}): a leading mention is answered
 * by the mentioned agents alone, and a mid-message mention runs in parallel,
 * FIRST ("check with @X first", via a deferred consult hold), or AFTER as a
 * one-way hand-off of the turn's answer ("then send it to @X", see
 * `crossAgentHandoff`). The composer shows the decision before send
 * (`MentionRoutingBar`).
 *
 * Module-level functions, not a hook: the queue drain
 * (`agentStore.processQueuedItem`) runs outside React.
 */

import type { ConsultHoldTarget, Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import {
	buildKnownMentionNameSet,
	resolveMentionedTargetSessionIds,
} from '../hooks/input/useAgentMentionCompletion';
import {
	inferMentionTiming,
	messageStartsWithAgentMention,
	type MentionRouting,
} from '../../shared/crossAgentContext';
import { sendCrossAgentRequest } from '../hooks/agent/useCrossAgentDispatch';
import {
	holdTurnForConsults,
	resolveConsultTargets,
	withConsultPendingNote,
	withHandoffPendingNote,
} from './crossAgentConsultHold';
import { armMentionHandoff } from './crossAgentHandoff';

/** What a message's `@mentions` resolve to, before anything is sent. */
export interface CrossAgentMentionPlan {
	/**
	 * The agents to consult, de-duped, self-mention filtered. Never empty - a
	 * message with no resolvable mention plans to `null` instead.
	 */
	targetSessionIds: string[];
	/**
	 * How the mention runs relative to the source agent's turn: `only` for a
	 * message that LEADS with a mention, otherwise the timing inferred from the
	 * user's wording.
	 */
	routing: MentionRouting;
	/**
	 * The source agent must not be sent to when this message dispatches. True for
	 * a leading mention (`only`: the message is addressed at the consulted agents
	 * alone) and for `consult-first` (the source agent answers later, when the
	 * consult hold releases with the replies).
	 */
	suppressLocal: boolean;
}

/** What dispatching a plan means for the source agent's own turn. */
export interface CrossAgentMentionDispatch {
	/** Consulted in parallel: the turn waits for them (pending note). */
	consultTargets: ConsultHoldTarget[];
	/** Handed the turn's answer when it ends (hand-off note). */
	handoffTargets: ConsultHoldTarget[];
}

/** A dispatch that changes nothing about the local turn. */
export const NO_MENTION_DISPATCH: CrossAgentMentionDispatch = {
	consultTargets: [],
	handoffTargets: [],
};

/**
 * What dispatching `plan` will tell the local turn, without dispatching. For a
 * caller that must build the turn's prompt BEFORE it fires the consults (the
 * remote path spawns first, so a failed spawn consults nobody).
 */
export function previewMentionDispatch(plan: CrossAgentMentionPlan): CrossAgentMentionDispatch {
	if (plan.routing === 'parallel') {
		return { consultTargets: resolveConsultTargets(plan.targetSessionIds), handoffTargets: [] };
	}
	if (plan.routing === 'handoff') {
		return { consultTargets: [], handoffTargets: resolveConsultTargets(plan.targetSessionIds) };
	}
	return NO_MENTION_DISPATCH;
}

/**
 * Append whatever agent-only notes a dispatch calls for to the local turn's
 * prompt. Accepts a missing dispatch so call sites need no guard.
 */
export function withMentionTurnNotes(
	prompt: string,
	dispatch: CrossAgentMentionDispatch | null | undefined
): string {
	if (!dispatch) return prompt;
	return withHandoffPendingNote(
		withConsultPendingNote(prompt, dispatch.consultTargets),
		dispatch.handoffTargets
	);
}

/**
 * Resolve the mentions in `message` without sending anything.
 *
 * Returns `null` when the message mentions no other agent, so callers can treat
 * "no plan" and "nothing to do" as the same thing.
 */
export function planCrossAgentMentions(
	message: string,
	sourceSessionId: string
): CrossAgentMentionPlan | null {
	const { sessions, groups } = useSessionStore.getState();
	const targetSessionIds = resolveMentionedTargetSessionIds(
		message,
		sessions,
		groups,
		sourceSessionId
	).filter((id) => id !== sourceSessionId); // Self-mention guard (defend at dispatch).
	if (targetSessionIds.length === 0) return null;

	// Roster for the leading-mention check, so a message that leads with a
	// file-shaped agent name (`@RunMaestro.ai fix this`) suppresses the local
	// send just like a bare `@Codex` does.
	const knownMentionNames = buildKnownMentionNameSet(sessions, groups, sourceSessionId);
	const routing: MentionRouting = messageStartsWithAgentMention(message, knownMentionNames)
		? 'only'
		: inferMentionTiming(message, knownMentionNames);
	return {
		targetSessionIds,
		routing,
		suppressLocal: routing === 'only' || routing === 'consult-first',
	};
}

/**
 * Fire the consults for an already-resolved plan.
 *
 * The transcript slice is read HERE, not at plan time: for a queued message
 * that is minutes old, the consulted agent should see the conversation as it
 * stands when it is pulled in, not as it stood when the user hit send.
 *
 * Per routing:
 * - `only`: consult; the source agent does not answer.
 * - `parallel`: consult, and hold the source turn open until the replies land
 *   (a consult hold at the head of its queue, see `crossAgentConsultHold`).
 * - `consult-first`: consult, and park the message itself on a deferred hold;
 *   the source agent answers it when the hold releases with the replies.
 * - `handoff`: consult nobody yet; arm a hand-off that forwards the source
 *   turn's answer when it ends (see `crossAgentHandoff`).
 *
 * Returns what the caller must tell the local turn: the parallel consult
 * targets (pending note) and the hand-off targets (hand-off note).
 */
export function dispatchCrossAgentMentions(
	plan: CrossAgentMentionPlan,
	message: string,
	sourceSession: Session,
	sourceTabId: string,
	images?: string[]
): CrossAgentMentionDispatch {
	const targets = resolveConsultTargets(plan.targetSessionIds);
	if (plan.routing === 'handoff') {
		armMentionHandoff(sourceSession.id, sourceTabId, { targets, message });
		return { consultTargets: [], handoffTargets: targets };
	}

	// Hold BEFORE sending, so a consult that settles almost at once (a target
	// that no longer exists) still finds the hold waiting to record it.
	if (plan.routing === 'parallel') {
		holdTurnForConsults(sourceSession.id, sourceTabId, targets);
	} else if (plan.routing === 'consult-first') {
		holdTurnForConsults(sourceSession.id, sourceTabId, targets, {
			message,
			...(images && images.length > 0 && { images: [...images] }),
		});
	}

	const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
	const sourceLogs = sourceTab?.logs ?? [];
	for (const targetSessionId of plan.targetSessionIds) {
		sendCrossAgentRequest({
			sourceSessionId: sourceSession.id,
			sourceAgentName: sourceSession.name,
			sourceTabId,
			targetSessionId,
			userPrompt: message,
			sourceLogs,
			// The source agent's working directory: the consulted agent is told it
			// may READ files here to answer (see cross-agent-router prompt).
			sourceCwd: sourceSession.cwd,
		});
	}
	return plan.routing === 'parallel'
		? { consultTargets: targets, handoffTargets: [] }
		: NO_MENTION_DISPATCH;
}

/**
 * Plan + dispatch in one step, for callers that only hold the raw message (the
 * queue drain). Re-resolving at dispatch time is deliberate: an agent renamed
 * or deleted while the message sat in the queue then resolves correctly, or
 * drops out, instead of consulting a stale id. Returns what
 * `dispatchCrossAgentMentions` does.
 */
export function dispatchCrossAgentMentionsForMessage(
	message: string,
	sourceSession: Session,
	sourceTabId: string,
	images?: string[]
): CrossAgentMentionDispatch {
	const plan = planCrossAgentMentions(message, sourceSession.id);
	if (!plan) return NO_MENTION_DISPATCH;
	return dispatchCrossAgentMentions(plan, message, sourceSession, sourceTabId, images);
}
