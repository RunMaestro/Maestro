/**
 * runtimeFeatures.ts — ownership resolution for native runtime projections.
 *
 * OMP projects `AgentRuntimeFeatureState` at two scopes: tab-scoped events
 * (`{sessionId}-ai-{tabId}`) land on the owning AITab, base-scoped events on
 * the Session itself. Consumers (composer toolbar, right panel, model pills)
 * must render the ACTIVE tab's projection and address every control/detail
 * action to the exact id that owns it — otherwise actions for tab A get
 * applied against features projected by tab B.
 */

import type { AgentRuntimeFeatureState } from '../../shared/agent-runtime-features';
import type { Session } from '../types';

export interface OwnedRuntimeFeatures {
	features: AgentRuntimeFeatureState;
	/** The exact session/tab id owning `features`; all actions must target it. */
	ownerId: string;
}

/**
 * Resolve the runtime feature projection for the session's active tab.
 *
 * Precedence: the active tab's own projection wins; the base-session
 * projection applies only when the base session is the owner (no projection
 * exists on the active tab). A tab whose projection was cleared falls back to
 * the base projection — never to another tab's state.
 */
export function resolveRuntimeFeatures(session: Session): OwnedRuntimeFeatures | null {
	const activeTab = session.aiTabs?.find((tab) => tab.id === session.activeTabId);
	if (activeTab?.runtimeFeatures) {
		return {
			features: activeTab.runtimeFeatures,
			ownerId: `${session.id}-ai-${activeTab.id}`,
		};
	}
	if (session.runtimeFeatures) {
		return { features: session.runtimeFeatures, ownerId: session.id };
	}
	return null;
}
