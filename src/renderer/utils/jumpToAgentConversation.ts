/**
 * Jump to another agent's conversation from an attribution shown in this one:
 * a cross-agent reply's header, a delegation pill.
 *
 * Resolved at click time rather than per render, so an attribution never
 * subscribes to the session store just to be clickable. The agent it names may
 * have been deleted since the entry was written, so existence is checked first
 * and a flash says so, rather than following a deep link to nothing. With a tab
 * id the jump lands on that exact conversation (revealing a hidden consult tab);
 * without one it selects the agent.
 */

import { useSessionStore } from '../stores/sessionStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { openMaestroLink } from './openMaestroLink';
import { buildSessionDeepLink } from '../../shared/deep-link-urls';

export interface AgentConversationTarget {
	sessionId: string;
	tabId?: string;
	/** Named in the flash when the agent no longer exists. */
	agentName: string;
}

export function jumpToAgentConversation(target: AgentConversationTarget): void {
	const exists = useSessionStore.getState().sessions.some((s) => s.id === target.sessionId);
	if (!exists) {
		notifyCenterFlash({
			message: `${target.agentName} is no longer available`,
			color: 'orange',
		});
		return;
	}
	openMaestroLink(buildSessionDeepLink(target.sessionId, target.tabId));
}
