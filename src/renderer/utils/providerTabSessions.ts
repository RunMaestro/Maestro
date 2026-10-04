/**
 * Provider Tab Sessions
 *
 * Turn settings codified at send, plus the renderer's import site for the
 * provider swap.
 *
 * The swap itself (per-provider parking of each tab's provider session and of
 * the agent-level overrides) moved to `maestro-lib/agents/providerSwap.ts` so
 * the desktop, the TUI, and the CLI share one implementation (requirement
 * PS-5). It is re-exported here so renderer import sites keep working; read
 * that module for the parking invariant the rest of the renderer relies on.
 */

import type { AITab, QueuedItem, QueuedTurnSettings, Session } from '../types';

export {
	resolveTurnProvider,
	switchAgentProvider,
	switchTabProvider,
	updateProviderSlot,
} from '../../shared/maestro-lib/agents/providerSwap';

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
 * Freeze the model and effort onto a {@link QueuedItem} at the moment it is
 * queued. Queuing IS the send from the user's point of view - they picked a
 * model, typed, and hit Enter - so the settings have to be captured here even
 * though the turn will not spawn until the queue drains, possibly several model
 * changes later.
 *
 * Every path that builds a QueuedItem should spread this in.
 */
export function captureQueuedTurnSettings(
	tab: AITab | undefined,
	session: Session
): QueuedTurnSettings {
	const { turnModel, turnEffort } = codifyTurnSettings(tab, session);
	return { model: turnModel, effort: turnEffort };
}

/**
 * The turn settings a dequeued item must run under: its own capture when it has
 * one, the live values otherwise.
 *
 * The fallback is for items queued before this was captured (a queue restored
 * from an older build), NOT a per-field default - an absent `model` inside a
 * present `turnSettings` means the agent's default was deliberately in force
 * when the user queued, and substituting the current selection there is exactly
 * the bug this exists to prevent.
 *
 * The provider always comes from the live session: a queued turn spawns on
 * whatever provider the agent is on now, since its resume token and agent
 * binary belong to that provider.
 */
export function codifyQueuedTurnSettings(
	item: Pick<QueuedItem, 'turnSettings'>,
	tab: AITab | undefined,
	session: Session
): Pick<AITab, 'turnProvider' | 'turnModel' | 'turnEffort'> {
	const live = codifyTurnSettings(tab, session);
	if (!item.turnSettings) return live;
	return {
		turnProvider: live.turnProvider,
		turnModel: item.turnSettings.model,
		turnEffort: item.turnSettings.effort,
	};
}
