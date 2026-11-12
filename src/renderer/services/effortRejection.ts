/**
 * effortRejection - the renderer's half of recovering from a provider that
 * refuses the effort level a turn asked for.
 *
 * The detector and the per-process memory live in `shared/effortRejection.ts`.
 * This module binds them to what only the renderer has: the `agent:error`
 * stream (every agent error in the app is forwarded here, including the ones
 * from main-process spawns like tab naming) and the toast surface.
 *
 * Three jobs:
 *
 * 1. NOTE the refusal in this process, so `resolveEffortLevel` stops handing
 *    the value to Auto Run hints and synopses for the rest of the session.
 * 2. TELL the user, once per provider and value. Before this the failure was
 *    silent: a tab that never got a name, a History entry with no synopsis.
 * 3. Let a spawn that sent an effort RETRY once without it. A spawn "arms" its
 *    process id before it starts; a refusal that arrives for an armed id is
 *    held until that spawn's exit handler collects it with
 *    {@link settleEffortFallback} and runs the turn again.
 *
 * Arming is also what keeps the refusal out of the ordinary error path: the
 * error listener returns early for an armed id, because an Auto Run task that
 * is about to be retried must not also park the whole run behind an error
 * banner. An id nobody armed is never held, so the map cannot grow from the
 * many spawns (tab turns, naming, grooming) that have no renderer-side retry.
 */

import {
	describeEffortRejection,
	noteEffortRejection,
	parseAgentErrorEffortRejection,
	type AgentErrorText,
	type EffortRejection,
} from '../../shared/effortRejection';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { notifyToast } from '../stores/notificationStore';

const armed = new Set<string>();
const held = new Map<string, EffortRejection>();

/**
 * Inspect one agent error. Returns the refusal it describes, or `null`.
 *
 * Called for EVERY agent error, before any other handling, so the note and the
 * toast happen no matter which spawn hit the refusal or whether that spawn can
 * retry.
 */
export function observeEffortRejection(
	processSessionId: string,
	error: AgentErrorText & { agentId?: string }
): EffortRejection | null {
	const rejection = parseAgentErrorEffortRejection(error);
	if (!rejection) return null;

	if (error.agentId && noteEffortRejection(error.agentId, rejection)) {
		const providerName = getAgentDisplayName(error.agentId);
		notifyToast({
			color: 'yellow',
			title: `${providerName} rejected effort "${rejection.value}"`,
			message:
				`${describeEffortRejection(providerName, rejection)} Tab naming, synopses, and ` +
				`effort hints that map to "${rejection.value}" use the agent's configured effort ` +
				`until Maestro restarts.`,
		});
	}

	if (armed.has(processSessionId)) {
		held.set(processSessionId, rejection);
	}
	return rejection;
}

/**
 * Declare that the spawn running under `processSessionId` sent an effort it can
 * do without, and will retry itself if the provider refuses it. Must be called
 * BEFORE the spawn, and paired with {@link settleEffortFallback} at its exit.
 */
export function armEffortFallback(processSessionId: string): void {
	armed.add(processSessionId);
}

/** True while the spawn under this id is armed and has not yet exited. */
export function isEffortFallbackArmed(processSessionId: string): boolean {
	return armed.has(processSessionId);
}

/**
 * Disarm at process exit and hand back the refusal that arrived, if one did.
 *
 * Disarming here is what stops an error that turns up AFTER the exit from being
 * swallowed: the listener only steps aside for an armed id, and nothing would
 * be left to run the retry it was stepping aside for.
 */
export function settleEffortFallback(processSessionId: string): EffortRejection | null {
	armed.delete(processSessionId);
	const rejection = held.get(processSessionId) ?? null;
	held.delete(processSessionId);
	return rejection;
}
