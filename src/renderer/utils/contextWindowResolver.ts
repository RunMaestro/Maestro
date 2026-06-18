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
