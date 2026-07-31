/**
 * Provider Failover - spare-tire endpoints for Agent Resilience.
 *
 * Agent Resilience (see `shared/retryClassification.ts` + `stores/retryStore.ts`)
 * answers an upstream failure by waiting and resending to the SAME provider. That
 * is the right move for a 60-second "Overloaded" blip, but a poor one for plan
 * quota exhaustion: the agent sits idle until the reset window, which can be
 * hours, and any long-running autonomous work stalls with it.
 *
 * Failover adds the other half. An agent can carry an ordered list of
 * Anthropic-compatible backup endpoints (a local vLLM/Ollama server, Z.AI, an
 * enterprise proxy, or simply a second account). When resilience decides an error
 * is retryable AND failover is armed, Maestro swaps the endpoint's env vars into
 * the next spawn instead of waiting out the clock, and keeps working.
 *
 * Endpoints are plain env-var bundles because the `claude` CLI (and every
 * Anthropic-compatible CLI) already reads its base URL and token from the
 * environment. That makes this infrastructure-agnostic: no new API client, no
 * per-provider integration, just a different `env` on the spawn.
 *
 * This module is intentionally pure and dependency-free so it can run in either
 * the renderer (deciding when to switch) or the main process (applying the swap
 * at spawn time).
 */

/**
 * A single backup endpoint. `env` is applied ON TOP OF the agent's own
 * `customEnvVars` at spawn time, so an endpoint only needs to state what differs
 * (typically `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`).
 */
export interface FailoverEndpoint {
	/** Stable id; survives reordering and renames. */
	id: string;
	/** User-facing name shown in the failover banner and agent editor. */
	label: string;
	/** Env vars layered over the agent's own customEnvVars when this endpoint is live. */
	env: Record<string, string>;
	/**
	 * Optional model override for this endpoint. Backup providers rarely accept
	 * Anthropic's model ids (Z.AI wants `glm-4.6`, a local server wants whatever
	 * it loaded), so failing over without swapping the model usually just trades a
	 * quota error for a 404. Empty/undefined keeps the agent's configured model.
	 */
	model?: string;
}

/** Per-agent failover configuration, persisted on the Session record. */
export interface FailoverConfig {
	/** Ordered backup endpoints, tried first-to-last. */
	endpoints: FailoverEndpoint[];
	/**
	 * Arm failover. Off by default: swapping providers mid-task changes who sees
	 * the user's prompts and what the output costs, so it must be opted into.
	 */
	enabled?: boolean;
	/**
	 * How long to stay on a backup before the next turn probes the primary again.
	 * Defaults to {@link DEFAULT_RETURN_TO_PRIMARY_MINUTES}. The probe is lazy - it
	 * happens on the next spawn, not on a background timer - so an idle agent never
	 * burns quota just to test the water.
	 */
	returnToPrimaryMinutes?: number;
}

/** Default dwell time on a backup endpoint before re-probing the primary: 60m. */
export const DEFAULT_RETURN_TO_PRIMARY_MINUTES = 60;

/** Which endpoint an agent is currently pinned to, and since when. */
export interface FailoverState {
	/** Live endpoint id, or `null` for the primary (the agent's own config). */
	endpointId: string | null;
	/** Epoch ms the current endpoint was selected. */
	since: number;
	/**
	 * Endpoint ids already tried during this outage, in order. Cleared when the
	 * agent returns to primary. Prevents cycling back onto an endpoint that just
	 * failed within the same outage.
	 */
	exhausted: string[];
}

/** The env-var keys that carry an Anthropic-compatible endpoint's identity. */
export const ANTHROPIC_ENDPOINT_ENV_KEYS = [
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_API_KEY',
] as const;

/** True when the config has at least one usable endpoint and is armed. */
export function failoverArmed(config: FailoverConfig | undefined): boolean {
	return !!config?.enabled && (config.endpoints?.length ?? 0) > 0;
}

/** Look up an endpoint by id. Returns undefined for the primary (`null`) or a stale id. */
export function findEndpoint(
	config: FailoverConfig | undefined,
	endpointId: string | null | undefined
): FailoverEndpoint | undefined {
	if (!endpointId) return undefined;
	return config?.endpoints?.find((e) => e.id === endpointId);
}

/**
 * Pick the next endpoint to try, or `null` when every endpoint has been used in
 * this outage (the caller then falls back to plain wait-and-retry on whatever
 * endpoint is currently live).
 *
 * Order is the user's list order - first entry is the preferred spare. Endpoints
 * that no longer exist in the config are ignored, so deleting an endpoint mid
 * outage degrades cleanly instead of pinning the agent to a dangling id.
 */
export function selectNextEndpoint(
	config: FailoverConfig | undefined,
	state: FailoverState | undefined
): FailoverEndpoint | null {
	if (!failoverArmed(config)) return null;
	const tried = new Set(state?.exhausted ?? []);
	for (const endpoint of config!.endpoints) {
		if (!tried.has(endpoint.id)) return endpoint;
	}
	return null;
}

/**
 * Whether enough time has passed on a backup to probe the primary again.
 * Always false while on the primary (nothing to return from).
 */
export function shouldReturnToPrimary(
	config: FailoverConfig | undefined,
	state: FailoverState | undefined,
	now: number
): boolean {
	if (!state?.endpointId) return false;
	const minutes = config?.returnToPrimaryMinutes ?? DEFAULT_RETURN_TO_PRIMARY_MINUTES;
	if (!Number.isFinite(minutes) || minutes <= 0) return false;
	return now - state.since >= minutes * 60 * 1000;
}

/**
 * Resolve the env vars a spawn should use: the agent's own `customEnvVars` with
 * the live endpoint's `env` layered on top. Returns the base object unchanged
 * (same reference semantics as a plain merge) when on the primary.
 *
 * Endpoint env wins over the agent's own vars deliberately - the whole point of
 * failing over is to override `ANTHROPIC_BASE_URL`/token that the agent config
 * may already set for its primary provider.
 */
export function resolveFailoverEnv(
	baseEnv: Record<string, string> | undefined,
	endpoint: FailoverEndpoint | undefined
): Record<string, string> | undefined {
	if (!endpoint) return baseEnv;
	const merged: Record<string, string> = { ...(baseEnv ?? {}) };
	for (const [key, value] of Object.entries(endpoint.env ?? {})) {
		// Skip blank values so a half-filled row in the editor can't clobber a
		// working var with an empty string.
		if (value !== '') merged[key] = value;
	}
	return merged;
}

/**
 * Validate an endpoint for the agent editor. Returns a human-readable problem, or
 * null when the endpoint is usable.
 */
export function validateEndpoint(endpoint: FailoverEndpoint): string | null {
	if (!endpoint.label.trim()) return 'Name is required.';
	const keys = Object.keys(endpoint.env ?? {}).filter((k) => k.trim() !== '');
	if (keys.length === 0) return 'Add at least one environment variable.';
	if (!keys.some((k) => k === 'ANTHROPIC_BASE_URL')) {
		return 'Set ANTHROPIC_BASE_URL so the agent points at this endpoint.';
	}
	const baseUrl = endpoint.env.ANTHROPIC_BASE_URL?.trim() ?? '';
	if (!/^https?:\/\//i.test(baseUrl)) {
		return 'ANTHROPIC_BASE_URL must start with http:// or https://.';
	}
	return null;
}
