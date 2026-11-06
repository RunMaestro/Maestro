/** Pure captured turn configuration shared by host queue admission and the renderer. */
import type { AgentRecord, AITabRecord } from './maestro-lib/store/records';

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
export function codifyTurnSettings<T extends string>(
	tab: Pick<AITabRecord, 'customModel' | 'customEffort'> | undefined,
	session: Pick<AgentRecord, 'customModel' | 'customEffort'> & { toolType: T }
) {
	return {
		turnProvider: session.toolType,
		turnModel: tab?.customModel ?? session.customModel,
		turnEffort: tab?.customEffort ?? session.customEffort,
	};
}

/**
 * Freeze the model and effort onto a queued message at the moment it is
 * queued. Queuing IS the send from the user's point of view - they picked a
 * model, typed, and hit Enter - so the settings have to be captured here even
 * though the turn will not spawn until the queue drains, possibly several model
 * changes later.
 *
 * Every path that builds a QueuedItem should spread this in.
 */
export function captureQueuedTurnSettings<T extends string>(
	tab: Pick<AITabRecord, 'customModel' | 'customEffort'> | undefined,
	session: Pick<AgentRecord, 'customModel' | 'customEffort'> & { toolType: T }
) {
	const { turnModel, turnEffort } = codifyTurnSettings(tab, session);
	return { model: turnModel, effort: turnEffort };
}
