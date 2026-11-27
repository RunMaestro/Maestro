/** Pure captured turn configuration shared by host queue admission and the renderer. */
import type { AgentRecord, AITabRecord } from './maestro-lib/store/records';
import type { TurnOverrides } from './maestro-lib/client/types';

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

/** The queued-item fields a sender's own chips (`TurnOverrides`, Federation) set. */
export interface QueuedTurnOverrideFields {
	turnSettings?: { model?: string; effort?: string };
	readOnlyMode?: boolean;
	/**
	 * The sender's read-only choice for this one message. Set only from `TurnOverrides`; when set,
	 * it decides read-only in place of the tab's own chip ({@link queuedItemRunsReadOnly}).
	 */
	turnReadOnly?: boolean;
	/**
	 * The sender's save to History choice for this one message. Copied onto the user log entry the
	 * dispatch writes, where the exit synopsis reads it in place of the tab's own chip.
	 */
	turnSaveToHistory?: boolean;
}

/**
 * Lay a sender's own tab chips (`TurnInput.overrides`, Federation) onto a queued item built from
 * the host tab, for that one message: the model and effort replace the captured ones, and the
 * read-only and save to History choices replace the tab's own. The tab itself is never changed,
 * so other conductors and the host keep their chips.
 */
export function withQueuedTurnOverrides<T extends QueuedTurnOverrideFields>(
	item: T,
	overrides: TurnOverrides | undefined
): T {
	if (!overrides) return item;
	const next: T = { ...item };
	if (overrides.model !== undefined || overrides.effort !== undefined) {
		next.turnSettings = {
			model: overrides.model ?? item.turnSettings?.model,
			effort: overrides.effort ?? item.turnSettings?.effort,
		};
	}
	if (overrides.readOnly !== undefined) {
		next.turnReadOnly = overrides.readOnly;
		next.readOnlyMode = overrides.readOnly;
	}
	if (overrides.saveToHistory !== undefined) next.turnSaveToHistory = overrides.saveToHistory;
	return next;
}

/**
 * Whether a queued item runs read-only when it is dispatched. A sender's own choice
 * (`turnReadOnly`) decides when present; otherwise the item's flag or the target tab's current
 * read-only setting does. Every dispatch path, and the main process's check of a dispatch, asks
 * this one rule, so they cannot disagree.
 */
export function queuedItemRunsReadOnly(
	item: Pick<QueuedTurnOverrideFields, 'readOnlyMode' | 'turnReadOnly'> | undefined,
	tab: { readOnlyMode?: boolean; permissionMode?: string } | undefined
): boolean {
	if (typeof item?.turnReadOnly === 'boolean') return item.turnReadOnly;
	return (
		item?.readOnlyMode === true || tab?.readOnlyMode === true || tab?.permissionMode === 'readonly'
	);
}

/**
 * The choices a queued item froze when it was queued, as per-turn overrides for a host
 * (`TurnInput.overrides`): its model and effort, its read-only choice (by
 * {@link queuedItemRunsReadOnly}, sent only when the item made one), and its save to History
 * choice. The inverse of {@link withQueuedTurnOverrides}. Undefined when it froze none, so the
 * host tab's own chips decide, as a local drain falls back to the tab's.
 */
export function queuedTurnOverrides(
	item: Pick<
		QueuedTurnOverrideFields,
		'turnSettings' | 'readOnlyMode' | 'turnReadOnly' | 'turnSaveToHistory'
	>
): TurnOverrides | undefined {
	const choseReadOnly =
		typeof item.turnReadOnly === 'boolean' || typeof item.readOnlyMode === 'boolean';
	const overrides: TurnOverrides = {
		...(item.turnSettings?.model ? { model: item.turnSettings.model } : {}),
		...(item.turnSettings?.effort ? { effort: item.turnSettings.effort } : {}),
		...(choseReadOnly ? { readOnly: queuedItemRunsReadOnly(item, undefined) } : {}),
		...(typeof item.turnSaveToHistory === 'boolean'
			? { saveToHistory: item.turnSaveToHistory }
			: {}),
	};
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}
