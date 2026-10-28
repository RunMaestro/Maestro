import { AGENT_IDS } from '../../shared/agentIds';
import {
	DEFAULT_BROWSER_CONFIRM_POLICY,
	type BrowserConfirmPolicy,
	type CoworkingBrowserPolicies,
} from '../../shared/coworkingBrowser';
import type { Session } from '../types';
import { resolveTabProvider, resolveTurnProvider } from './providerTabSessions';

/** Older callers without a launch identity may use only an unambiguous owner. */
export function coworkingBrowserPolicy(
	session: Session,
	interactionAgents: string[],
	confirmPolicies: Record<string, BrowserConfirmPolicy>
) {
	const providers = new Set(
		[...(session.aiTabs ?? []), ...(session.orphanedThinkingTabs ?? [])].flatMap((tab) => [
			resolveTabProvider(tab, session),
			resolveTurnProvider(tab, session),
		])
	);
	// An older connection could be a headless/default-provider caller. Never
	// grant it another tab's permission, including during a busy-state sync race.
	providers.add(session.toolType);
	const agentType = providers.size === 1 ? [...providers][0] : undefined;
	const providerPolicies: CoworkingBrowserPolicies = Object.fromEntries(
		AGENT_IDS.map((provider) => [
			provider,
			{
				interactionEnabled: interactionAgents.includes(provider),
				confirmPolicy: confirmPolicies[provider] ?? DEFAULT_BROWSER_CONFIRM_POLICY,
			},
		])
	);
	return {
		agentType,
		interactionEnabled: agentType ? providerPolicies[agentType]!.interactionEnabled : false,
		confirmPolicy: agentType ? providerPolicies[agentType]!.confirmPolicy : ('all' as const),
		providerPolicies,
	};
}
