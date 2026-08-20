/**
 * Provider Tab Sessions
 *
 * Per-provider parking for an AI tab's provider-specific state.
 *
 * A tab holds one live `agentSessionId`, and that value is a resume token only
 * the tab's current provider understands. Changing an agent's provider used to
 * resolve that by deleting every tab in the agent, which destroyed the user's
 * transcripts to avoid carrying one invalid field. Instead, park the outgoing
 * provider's values under `AITab.providerSessions` and restore the incoming
 * provider's, so switching away and back lands on the same conversation.
 *
 * The invariant, relied on everywhere `agentSessionId` is read (700+ sites):
 * the live fields ALWAYS belong to `session.toolType`, and `providerSessions`
 * never contains an entry for it.
 */

import type { AITab, ProviderTabSession, Session } from '../types';
import type { ToolType } from '../../shared/types';

/**
 * Move a tab's live provider-specific state into `providerSessions` under
 * `fromProvider`, and lift `toProvider`'s parked state into the live fields.
 *
 * Everything else on the tab - `logs` above all - is left untouched: the
 * transcript is not provider-specific and survives any number of switches.
 * Returns the tab unchanged when the provider did not actually change.
 */
export function switchTabProvider(tab: AITab, fromProvider: ToolType, toProvider: ToolType): AITab {
	if (fromProvider === toProvider) return tab;

	const parked: Partial<Record<ToolType, ProviderTabSession>> = {
		...(tab.providerSessions ?? {}),
	};

	// Park the outgoing provider's live values. A tab that never ran under the
	// outgoing provider still gets an entry, so switching back restores its
	// "fresh tab" state rather than inheriting whatever the detour left behind.
	parked[fromProvider] = {
		agentSessionId: tab.agentSessionId,
		usageStats: tab.usageStats,
		customModel: tab.customModel,
		customEffort: tab.customEffort,
	};

	const restored = parked[toProvider];
	// The incoming provider must never keep an entry in the map - the live
	// fields are its home now.
	delete parked[toProvider];

	return {
		...tab,
		agentSessionId: restored?.agentSessionId ?? null,
		usageStats: restored?.usageStats,
		customModel: restored?.customModel,
		customEffort: restored?.customEffort,
		// A restored session ID is a real resume target, not something we are
		// waiting on the agent to hand back.
		awaitingSessionId: false,
		providerSessions: parked,
	};
}

/**
 * The provider that owns this tab's most recent turn.
 *
 * Settings are codified at send: an in-flight turn keeps running under the
 * provider it was sent with, even if the user changes the agent's provider
 * while it works. Async agent events (session ID, usage, exit) therefore have
 * to be attributed to the provider that STARTED the turn, not to whatever the
 * agent is configured with by the time they land - otherwise a mid-turn switch
 * writes the old provider's resume token into the new provider's live slot and
 * the next spawn tries to resume a session that provider has never heard of.
 *
 * Falls back to the session's current provider for tabs that predate
 * `turnProvider` or have never sent a message.
 */
export function resolveTurnProvider(tab: AITab | undefined, session: Session): ToolType {
	return tab?.turnProvider ?? session.toolType;
}

/**
 * The tab fields that codify a turn's configuration at send time.
 *
 * Spread this into the tab patch that marks the tab busy, so every send path
 * freezes the same three values: the provider that owns the turn, and the model
 * and effort it runs under. Resolution order matches what the spawn call
 * actually passes to the agent (tab override, then agent override); a value
 * left undefined means the agent's own default applies, and consumers render
 * nothing rather than inventing a label.
 */
export function codifyTurnSettings(
	tab: AITab | undefined,
	session: Session
): Pick<AITab, 'turnProvider' | 'turnModel' | 'turnEffort'> {
	return {
		turnProvider: session.toolType,
		turnModel: tab?.customModel ?? session.customModel,
		turnEffort: tab?.customEffort ?? session.customEffort,
	};
}

/**
 * Apply an update to whichever slot belongs to `owningProvider` - the live
 * fields when it is the session's current provider, the parked entry otherwise.
 *
 * This is how a late event from a turn that outlived a provider switch is
 * recorded without corrupting the current provider's state. The parked entry is
 * created if the tab has never run under that provider.
 */
export function updateProviderSlot(
	tab: AITab,
	session: Session,
	owningProvider: ToolType,
	update: Partial<ProviderTabSession>
): AITab {
	if (owningProvider === session.toolType) {
		return { ...tab, ...update };
	}

	const existing = tab.providerSessions?.[owningProvider];
	return {
		...tab,
		providerSessions: {
			...(tab.providerSessions ?? {}),
			[owningProvider]: {
				agentSessionId: existing?.agentSessionId ?? null,
				...existing,
				...update,
			},
		},
	};
}
