/**
 * Context Window Resolution
 *
 * Resolves an agent's effective context window from its per-agent override,
 * its agent-type config, or the agent defaults. Kept separate from the live
 * usage gauge (`useContextWindow`) so non-hook callers — e.g. Auto Run's
 * fresh-context mode picker — can resolve the same number without pulling in
 * tab usage state.
 */

import type { ToolType } from '../types';
import {
	DEFAULT_CONTEXT_WINDOWS,
	FALLBACK_CONTEXT_WINDOW,
	getModelContextWindowOverride,
} from '../../shared/agentConstants';
import { captureException } from './sentry';

interface ContextWindowSource {
	toolType?: ToolType | string;
	customContextWindow?: number;
	/** Per-agent model override; a `[1m]` variant implies the 1M extended window. */
	customModel?: string;
}

/**
 * Resolve the configured context window (tokens) for a session, following the
 * same precedence the live context gauge uses:
 *   1. `customContextWindow` (per-agent override) when > 0
 *   2. the agent-type config's `contextWindow`
 * Returns 0 when neither is set, signalling "unknown" — callers that need a
 * non-zero estimate should use {@link resolveEffectiveContextWindow}.
 */
export async function resolveConfiguredContextWindow(
	session: ContextWindowSource
): Promise<number> {
	if (typeof session.customContextWindow === 'number' && session.customContextWindow > 0) {
		return session.customContextWindow;
	}
	// A `[1m]` model picks Anthropic's 1M extended-context beta, which the agent
	// only reports through usage stats after its first turn. Detect it from the
	// selected model so the window is sized correctly before any usage lands.
	const sessionModelWindow = getModelContextWindowOverride(session.customModel);
	if (sessionModelWindow) return sessionModelWindow;
	if (!session.toolType) return 0;
	try {
		const config = await window.maestro.agents.getConfig(session.toolType);
		const configModelWindow = getModelContextWindowOverride(config?.model);
		if (configModelWindow) return configModelWindow;
		return typeof config?.contextWindow === 'number' ? config.contextWindow : 0;
	} catch (error) {
		captureException(error, {
			extra: {
				message: 'Failed to resolve configured context window',
				toolType: session.toolType,
			},
		});
		return 0;
	}
}

/**
 * Synchronous cache of resolved configured windows, so hot per-turn paths (the
 * usage listener that feeds the Context Timeline) can honor a provider-configured
 * window - which only `resolveConfiguredContextWindow` knows, via the async
 * `getConfig` step - without awaiting on every event. Keyed by the inputs that
 * determine the result. A provider-config edit that doesn't change the key
 * (e.g. changing the agent's configured contextWindow in settings) is picked up
 * on the next app load; the per-session sync inputs are part of the key, so
 * changing those re-resolves immediately.
 */
const configuredWindowCache = new Map<string, number>();
const pendingConfiguredWindowResolves = new Set<string>();

function configuredWindowCacheKey(session: ContextWindowSource): string {
	return `${session.toolType ?? ''}|${session.customContextWindow ?? ''}|${session.customModel ?? ''}`;
}

/**
 * Synchronously read the cached configured window for a session, or 0 when it has
 * not been resolved yet. Pair with {@link ensureConfiguredContextWindowCached} to
 * populate the cache off the hot path.
 */
export function getCachedConfiguredContextWindow(session: ContextWindowSource): number {
	return configuredWindowCache.get(configuredWindowCacheKey(session)) ?? 0;
}

/** Test-only: clear the configured-window cache so cases don't leak into each other. */
export function __resetConfiguredContextWindowCacheForTests(): void {
	configuredWindowCache.clear();
	pendingConfiguredWindowResolves.clear();
}

/**
 * Resolve the configured window for a session and cache it, unless a value is
 * already cached or a resolve is already in flight for the same key. Safe to
 * fire-and-forget from a hot path; the resolved value (including 0) is cached so
 * the async `getConfig` runs at most once per distinct input set.
 */
export function ensureConfiguredContextWindowCached(session: ContextWindowSource): void {
	const key = configuredWindowCacheKey(session);
	if (configuredWindowCache.has(key) || pendingConfiguredWindowResolves.has(key)) return;
	pendingConfiguredWindowResolves.add(key);
	void resolveConfiguredContextWindow(session)
		.then((value) => {
			configuredWindowCache.set(key, value);
		})
		.finally(() => {
			pendingConfiguredWindowResolves.delete(key);
		});
}

/**
 * Resolve the context window to use for decision-making: the configured window,
 * or the agent's default (then the global fallback) when the agent doesn't
 * report one. Terminal agents have no context window and resolve to 0.
 */
export async function resolveEffectiveContextWindow(session: ContextWindowSource): Promise<number> {
	const configured = await resolveConfiguredContextWindow(session);
	if (configured > 0) return configured;

	const toolType = session.toolType;
	if (toolType === 'terminal') return 0;
	if (!toolType) return FALLBACK_CONTEXT_WINDOW;
	return DEFAULT_CONTEXT_WINDOWS[toolType as ToolType] ?? FALLBACK_CONTEXT_WINDOW;
}
