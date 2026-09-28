import type { Session } from '../types';

/**
 * Live wizard activity for one AI tab, keyed by tab id.
 *
 * `useInlineWizard` owns the only copy of this that is authoritative: it holds
 * the conversation session and the streaming state for each wizard. `AITab.wizardState`
 * is a RENDER MIRROR of it, and only for the tab that is currently active (the sync
 * effect in `useWizardHandlers` writes one tab), so it drifts both ways - a wizard
 * started on a background tab has no mirror, and a wizard that ends while its tab is
 * in the background keeps a stale one. Read activity from here, not from the mirror.
 */
export interface WizardTabActivity {
	/** Agent (`Session.id`) that owns the wizard tab. */
	sessionId: string | null;
	/** True while the wizard is writing Auto Run documents. Drives the wand's pulse. */
	isGeneratingDocs: boolean;
}

/** Shared empty map so provider-less consumers don't allocate one per render. */
export const NO_WIZARD_TABS: ReadonlyMap<string, WizardTabActivity> = new Map();

/** True when the inline wizard is running on `tabId` right now. */
export function isWizardTab(
	activity: ReadonlyMap<string, WizardTabActivity>,
	tabId: string | null | undefined
): boolean {
	return !!tabId && activity.has(tabId);
}

/**
 * Roll per-tab wizard activity up to the agents that own it, keeping ONLY tabs that
 * are still open in the tab strip.
 *
 * The liveness check is the point. Wizard state lives in a hook map keyed by tab id
 * and every path that makes a tab go away (close, close-all, snooze, agent delete) has
 * to remember to evict its entry; one that forgets used to strand an entry whose
 * `isActive` stayed true forever, and the Left Bar rendered a wand for an agent with no
 * wizard tab in it and no way to reach one. Filtering at read time means a forgotten
 * eviction can no longer produce a wand that points at nothing.
 *
 * Snoozed tabs deliberately do NOT count: the tab is not in the strip, so a wand on
 * the agent row would be the same lie.
 */
export function rollUpWizardActivityToSessions(
	activity: ReadonlyMap<string, WizardTabActivity>,
	sessions: Session[]
): Map<string, { isGeneratingDocs: boolean }> {
	const bySession = new Map<string, { isGeneratingDocs: boolean }>();
	if (activity.size === 0) return bySession;

	for (const [tabId, info] of activity) {
		if (!info.sessionId) continue;
		const session = sessions.find((s) => s.id === info.sessionId);
		if (!session?.aiTabs?.some((tab) => tab.id === tabId)) continue;
		const existing = bySession.get(info.sessionId);
		bySession.set(info.sessionId, {
			isGeneratingDocs: (existing?.isGeneratingDocs ?? false) || info.isGeneratingDocs,
		});
	}

	return bySession;
}
