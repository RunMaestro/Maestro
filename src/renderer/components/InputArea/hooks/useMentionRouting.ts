/**
 * useMentionRouting - how the draft's `@agent` mentions will run if sent now,
 * for `MentionRoutingBar`.
 *
 * Runs the SAME planner the send path does (`planCrossAgentMentions`), so the
 * strip can never describe a routing the send would not take. Debounced: the
 * planner walks the agent roster, and a draft changes on every keystroke. A
 * draft with no `@` short-circuits on the live value, so the strip vanishes
 * the moment the composer clears instead of lingering for the debounce.
 */

import { useMemo } from 'react';
import { useDebouncedValue } from '../../../hooks/utils/useThrottle';
import { planCrossAgentMentions } from '../../../services/crossAgentMentions';
import { resolveConsultTargets } from '../../../services/crossAgentConsultHold';
import type { MentionRouting } from '../../../../shared/crossAgentContext';

/** Debounce for re-planning while the user types. */
const MENTION_ROUTING_DEBOUNCE_MS = 150;

export interface MentionRoutingPreview {
	routing: MentionRouting;
	agentNames: string[];
}

export function useMentionRouting(
	draft: string,
	sessionId: string,
	enabled: boolean
): MentionRoutingPreview | null {
	const debouncedDraft = useDebouncedValue(draft, MENTION_ROUTING_DEBOUNCE_MS);
	const live = enabled && draft.includes('@');
	return useMemo(() => {
		if (!live || !debouncedDraft.includes('@')) return null;
		const plan = planCrossAgentMentions(debouncedDraft, sessionId);
		if (!plan) return null;
		return {
			routing: plan.routing,
			agentNames: resolveConsultTargets(plan.targetSessionIds).map((t) => t.targetAgentName),
		};
	}, [live, debouncedDraft, sessionId]);
}
