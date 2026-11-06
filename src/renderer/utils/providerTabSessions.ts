/**
 * Provider Tab Sessions
 *
 * Turn settings codified at send, plus the renderer's import site for the
 * provider swap.
 *
 * Parking and turn attribution come from `maestro-lib/agents/providerSwap.ts`.
 * A provider change parks provider state without translating native
 * conversations, unless the user opts into the native translation flow.
 * Re-exports keep existing renderer import sites on the shared helpers.
 */

import type { AITab, QueuedItem, Session } from '../types';

export {
	providerOverridesFor,
	resolveTurnProvider,
	switchAgentProvider,
	switchTabProvider,
	updateProviderSlot,
} from '../../shared/maestro-lib/agents/providerSwap';

export { codifyTurnSettings, captureQueuedTurnSettings } from '../../shared/queuedTurnSettings';
import { codifyTurnSettings } from '../../shared/queuedTurnSettings';

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
	item: Pick<QueuedItem, 'turnSettings'> & Partial<Pick<QueuedItem, 'id'>>,
	tab: AITab | undefined,
	session: Session
): Pick<AITab, 'turnProvider' | 'turnModel' | 'turnEffort'> {
	const live = codifyTurnSettings(tab, session);
	if (
		!item.turnSettings ||
		(item.id &&
			session.providerTranslationQueuedOrigins?.[item.id] &&
			session.providerTranslationQueuedOrigins[item.id] !== session.toolType)
	)
		return live;
	return {
		turnProvider: live.turnProvider,
		turnModel: item.turnSettings.model,
		turnEffort: item.turnSettings.effort,
	};
}
