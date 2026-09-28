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
 * Module-level functions, not a hook: the queue drain
 * (`agentStore.processQueuedItem`) runs outside React.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import {
	buildKnownMentionNameSet,
	resolveMentionedTargetSessionIds,
} from '../hooks/input/useAgentMentionCompletion';
import { messageStartsWithAgentMention } from '../../shared/crossAgentContext';
import { sendCrossAgentRequest } from '../hooks/agent/useCrossAgentDispatch';

/** What a message's `@mentions` resolve to, before anything is sent. */
export interface CrossAgentMentionPlan {
	/**
	 * The agents to consult, de-duped, self-mention filtered. Never empty - a
	 * message with no resolvable mention plans to `null` instead.
	 */
	targetSessionIds: string[];
	/**
	 * The message LEADS with an `@agent` mention, so it is addressed only at the
	 * consulted agent(s): the source agent must not be sent to at all.
	 */
	suppressLocal: boolean;
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
	return {
		targetSessionIds,
		suppressLocal: messageStartsWithAgentMention(message, knownMentionNames),
	};
}

/**
 * Fire the consults for an already-resolved plan.
 *
 * The transcript slice is read HERE, not at plan time: for a queued message
 * that is minutes old, the consulted agent should see the conversation as it
 * stands when it is pulled in, not as it stood when the user hit send.
 */
export function dispatchCrossAgentMentions(
	plan: CrossAgentMentionPlan,
	message: string,
	sourceSession: Session,
	sourceTabId: string
): void {
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
}

/**
 * Plan + dispatch in one step, for callers that only hold the raw message (the
 * queue drain). Re-resolving at dispatch time is deliberate: an agent renamed
 * or deleted while the message sat in the queue then resolves correctly, or
 * drops out, instead of consulting a stale id.
 */
export function dispatchCrossAgentMentionsForMessage(
	message: string,
	sourceSession: Session,
	sourceTabId: string
): void {
	const plan = planCrossAgentMentions(message, sourceSession.id);
	if (!plan) return;
	dispatchCrossAgentMentions(plan, message, sourceSession, sourceTabId);
}
