/**
 * useMentionRouting - how the draft's `@agent` mentions will run if sent now,
 * for `MentionRoutingBar`.
 *
 * Runs the SAME planner the send path does (`planCrossAgentMentions`), with the
 * same routing override (`composerInputStore.mentionRoutingOverride`), so the
 * strip can never describe a routing the send would not take. Debounced: the
 * planner walks the agent roster, and a draft changes on every keystroke. A
 * draft with no `@` short-circuits on the live value, so the strip vanishes
 * the moment the composer clears instead of lingering for the debounce.
 *
 * Once the draft mentions nobody, a routing the user picked is dropped: it
 * qualified mentions that are gone, and the next message should start from its
 * own wording. Sending clears the draft, so a pick never outlives its message.
 */

import { useEffect, useMemo } from 'react';
import { useDebouncedValue } from '../../../hooks/utils/useThrottle';
import { planCrossAgentMentions } from '../../../services/crossAgentMentions';
import { resolveConsultTargets } from '../../../services/crossAgentConsultHold';
import {
	selectMentionRoutingOverride,
	useComposerInputStore,
} from '../../../stores/composerInputStore';
import type { MentionRouting } from '../../../../shared/crossAgentContext';

/** Debounce for re-planning while the user types. */
const MENTION_ROUTING_DEBOUNCE_MS = 150;

export interface MentionRoutingPreview {
	/** The routing the send will take. */
	routing: MentionRouting;
	/** What the wording alone says. Equals `routing` unless the user picked one. */
	inferredRouting: MentionRouting;
	/** True when `routing` is the user's pick rather than the wording's. */
	explicit: boolean;
	agentNames: string[];
}

export function useMentionRouting(
	draft: string,
	sessionId: string,
	enabled: boolean
): MentionRoutingPreview | null {
	const debouncedDraft = useDebouncedValue(draft, MENTION_ROUTING_DEBOUNCE_MS);
	const override = useComposerInputStore(selectMentionRoutingOverride);
	const live = enabled && draft.includes('@');
	const preview = useMemo(() => {
		if (!live || !debouncedDraft.includes('@')) return null;
		const plan = planCrossAgentMentions(debouncedDraft, sessionId, override);
		if (!plan) return null;
		return {
			routing: plan.routing,
			inferredRouting: plan.inferredRouting,
			explicit: plan.routingSource === 'explicit',
			agentNames: resolveConsultTargets(plan.targetSessionIds).map((t) => t.targetAgentName),
		};
	}, [live, debouncedDraft, sessionId, override]);

	const hasPreview = preview !== null;
	useEffect(() => {
		if (!hasPreview && override) {
			useComposerInputStore.getState().setMentionRoutingOverride(null);
		}
	}, [hasPreview, override]);

	return preview;
}
