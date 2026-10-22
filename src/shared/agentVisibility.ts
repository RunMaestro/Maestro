/**
 * agentVisibility - whether a stored agent is LIVE or DORMANT.
 *
 * Some agents exist in the session store but belong to an Encore Feature that
 * is switched off. Pianola is the only one today: it is a real `isPianola`
 * Session that PERSISTS after its flag is turned off, so turning the feature
 * back on restores the same agent and its chat. While the flag is off the agent
 * is dormant: it must have no footprint anywhere (agent lists, name resolution,
 * Cue, group chat, Director's Notes, plugins, git polling, audit-log folder
 * checks) except persistence itself.
 *
 * Every surface that walks the session list for anything other than saving it
 * goes through {@link filterLiveAgents}. Persistence, migrations, and pruning
 * that keys off the full list must NOT, or they would drop the dormant agent's
 * data.
 */

import { resolveEncoreFeatures } from './encoreFeatureDefaults';

/**
 * Minimal shape needed to decide whether an agent is dormant. The helpers take
 * any record (stored sessions are loosely typed, and an index-signature type is
 * not assignable to an all-optional interface) and read only `isPianola`.
 */
export interface DormancyScopableAgent {
	isPianola?: boolean;
}

function isPianolaRecord(agent: unknown): boolean {
	return (
		typeof agent === 'object' &&
		agent !== null &&
		(agent as DormancyScopableAgent).isPianola === true
	);
}

/**
 * The flags input: either the raw persisted `encoreFeatures` value (anything,
 * including undefined) or an already-resolved flag object. Both go through
 * `resolveEncoreFeatures()`, so a missing key falls back to its default.
 */
export type EncoreFeaturesInput = unknown;

/** True when the `pianola` Encore flag is on for this flags input. */
export function isPianolaEnabled(encoreFeatures: EncoreFeaturesInput): boolean {
	return resolveEncoreFeatures(encoreFeatures).pianola === true;
}

/** True when this agent belongs to a switched-off Encore Feature. */
export function isAgentDormant(agent: unknown, encoreFeatures: EncoreFeaturesInput): boolean {
	if (!isPianolaRecord(agent)) return false;
	return !isPianolaEnabled(encoreFeatures);
}

/**
 * Drop dormant agents. Returns the original array when nothing is filtered, so
 * consumers that memoize on identity stay stable.
 */
export function filterLiveAgents<T>(agents: T[], encoreFeatures: EncoreFeaturesInput): T[] {
	if (!agents.some(isPianolaRecord)) return agents;
	if (isPianolaEnabled(encoreFeatures)) return agents;
	return agents.filter((agent) => !isPianolaRecord(agent));
}

/** The user-facing reason a dormant agent cannot be targeted. */
export const DORMANT_PIANOLA_MESSAGE = 'Pianola is turned off. Turn it on in Settings > Plugins.';
