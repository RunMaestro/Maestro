/**
 * The Primary Agent (#2050): one app-level setting naming the agent the user
 * treats as their right hand. Features that need "the agent to talk to when the
 * user named none" (Quick Chat today; voice routing, Cue schedule defaults and
 * fleet notices later) fall back to it, and each feature can still override it
 * with its own setting.
 *
 * Primary means the DEFAULT RECEIVER of the user's input. It grants nothing:
 * no agent gains a peer grant to the primary agent because it is primary. Grants
 * to it stay explicit, the same as for any other agent, because the primary
 * agent usually holds context from several compartments.
 *
 * The setting stores the agent's id under {@link PRIMARY_AGENT_SETTING_KEY};
 * `null` (or an empty string) means no Primary Agent is set.
 */

/** Settings-store key that holds the Primary Agent's id. */
export const PRIMARY_AGENT_SETTING_KEY = 'primaryAgentId';

/**
 * The first candidate that names a live agent, for seeding the Primary Agent
 * from the per-feature defaults that existed before it. Candidates are in
 * priority order; anything that is not a known agent id is skipped.
 */
export function pickPrimaryAgentSeed(
	candidates: readonly unknown[],
	liveAgentIds: ReadonlySet<string>
): string | null {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate !== '' && liveAgentIds.has(candidate)) {
			return candidate;
		}
	}
	return null;
}
