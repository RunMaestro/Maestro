/**
 * Failover overlay registry (main process).
 *
 * When the renderer fails an agent over to a backup endpoint, the swapped env
 * vars have to reach every spawn surface for that agent - the interactive turn,
 * Auto Run, Cue, tab naming, background synopsis - not just the one code path
 * that noticed the error. There are ~20 renderer call sites that build a spawn
 * payload, so threading a `failoverEnv` field through all of them would be both
 * a large diff and a standing invitation for the next spawn surface to forget it.
 *
 * Instead the renderer registers the overlay here once, and the spawn IPC handler
 * (the single choke point every renderer spawn passes through) layers it over
 * `sessionCustomEnvVars`. New spawn surfaces inherit failover for free.
 *
 * State is deliberately in-memory and NOT persisted: it mirrors the retry engine's
 * rule that a closed app should not silently keep routing prompts to a backup
 * provider. On restart every agent comes back on its primary.
 *
 * Keyed by the BARE agent id. Desktop AI-tab spawns use a compound
 * `{agentId}-ai-{tabId}` session id, so callers must strip that suffix (the spawn
 * handler already computes `baseSessionId` for exactly this reason) - otherwise
 * the overlay set for an agent would miss the turn that needs it.
 */

import { logger } from '../utils/logger';

const LOG_CONTEXT = 'FailoverOverlay';

/** Live env overlays keyed by bare agent id. */
const overlays = new Map<string, Record<string, string>>();
/** Live model overrides keyed by bare agent id (backup providers use their own model ids). */
const modelOverrides = new Map<string, string>();

/**
 * Pin an agent to a backup endpoint's env (and optional model), or clear the pin
 * when `env` is null (back to primary).
 */
export function setFailoverOverlay(
	baseSessionId: string,
	env: Record<string, string> | null,
	model?: string
): void {
	if (!baseSessionId) return;
	if (env === null) {
		const had = overlays.delete(baseSessionId);
		modelOverrides.delete(baseSessionId);
		if (had) logger.info('Cleared failover overlay', LOG_CONTEXT, { sessionId: baseSessionId });
		return;
	}
	overlays.set(baseSessionId, env);
	if (model && model.trim()) modelOverrides.set(baseSessionId, model.trim());
	else modelOverrides.delete(baseSessionId);
	logger.info('Applied failover overlay', LOG_CONTEXT, {
		sessionId: baseSessionId,
		// Log which vars are being overridden, never their values (tokens live here).
		keys: Object.keys(env),
		model: modelOverrides.get(baseSessionId),
	});
}

/** The env overlay for an agent, or undefined when it is on its primary. */
export function getFailoverOverlay(baseSessionId: string): Record<string, string> | undefined {
	return overlays.get(baseSessionId);
}

/** The model override for an agent, or undefined when it is on its primary. */
export function getFailoverModel(baseSessionId: string): string | undefined {
	return modelOverrides.get(baseSessionId);
}

/** Drop all overlays. Used when the renderer reloads so stale pins can't leak. */
export function clearAllFailoverOverlays(): void {
	if (overlays.size === 0) return;
	logger.info('Cleared all failover overlays', LOG_CONTEXT, { count: overlays.size });
	overlays.clear();
	modelOverrides.clear();
}
