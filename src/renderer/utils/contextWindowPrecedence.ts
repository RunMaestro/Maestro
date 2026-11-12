/**
 * contextWindowPrecedence - the ONE ranking that decides which context window
 * the header gauge divides by, and which source won.
 *
 * Extracted from `useContextWindow` so a second consumer - the Edit Agent
 * panel's "your stored value is being overridden" hint (#1370) - can ask WHICH
 * source won without re-deriving the order. A hint computed from its own copy
 * of the ranking could disagree with the gauge, which is the class of bug
 * PR #1221 fixed and findings P1/AD1 work to keep from recurring.
 *
 * Returning the winning SOURCE rather than just the number is the point: "is
 * the stored window currently outranked?" is not answerable from the resolved
 * number alone, because a stored 200k and a provider-reported 200k produce the
 * same figure for entirely different reasons.
 */

import { getModelContextWindowOverride } from '../../shared/agentConstants';

/** Which rank supplied the resolved window. Ordered highest priority first. */
export type ContextWindowSource =
	/** `[1m]` marker on the session's custom model - an explicit model choice. */
	| 'model-marker'
	/** `customContextWindow` the user deliberately set (finding AD1). */
	| 'user-edited'
	/** A window the provider reported and flagged authoritative (finding P1). */
	| 'provider'
	/** `customContextWindow` with no recorded provenance - likely materialized. */
	| 'stored'
	/** Agent-level config, resolved asynchronously. */
	| 'configured'
	/** Raw reported window, carrying no authority flag. */
	| 'reported'
	/** Nothing known. */
	| 'none';

export interface ContextWindowInputs {
	/** Per-session model override; a `[1m]` variant implies the 1M window. */
	customModel?: string;
	/** Stored per-session window, if any. */
	customContextWindow?: number;
	/** Provenance of the stored window (finding AD1); absent means materialized. */
	contextWindowSource?: 'user-edited';
	/** Window the provider reported on the latest usage event. */
	reportedWindow?: number;
	/** True when that reported window came from the provider's own payload. */
	reportedResolved?: boolean;
	/** Agent-level configured window; 0 until the async lookup resolves. */
	configuredWindow?: number;
}

export interface ResolvedContextWindow {
	/** The window to divide by. 0 when nothing is known yet. */
	window: number;
	/** Which rank supplied it. */
	source: ContextWindowSource;
}

/**
 * Resolve the effective context window and name the rank that won.
 *
 * Precedence (findings P1 and AD1):
 *   1. `[1m]` model marker
 *   2. user-edited `customContextWindow`
 *   3. provider-resolved reported window
 *   4. `customContextWindow` of unknown/materialized provenance
 *   5. async configured window
 *   6. raw reported window
 *
 * `useAgentUsageListener` mirrors this for the Context Timeline with two
 * timeline-only extras interleaved below rank 4; keep the shared ranks
 * positionally identical there. A THIRD list exists in
 * `resolveConfiguredContextWindow` (Auto Run's fresh-context picker) which
 * ranks the stored value first unconditionally; it predates P1/AD1, serves a
 * different purpose, and is deliberately not kept in sync.
 */
export function resolveContextWindow(inputs: ContextWindowInputs): ResolvedContextWindow {
	// A `[1m]` marker on the session's custom model is an explicit model choice
	// the user made per-session, so it stays at the top.
	const modelMarker = getModelContextWindowOverride(inputs.customModel) ?? 0;
	if (modelMarker > 0) return { window: modelMarker, source: 'model-marker' };

	const stored =
		typeof inputs.customContextWindow === 'number' && inputs.customContextWindow > 0
			? inputs.customContextWindow
			: 0;
	// A window the user deliberately set is intent, not a stale default, so it
	// outranks even the provider's own report (finding AD1).
	if (inputs.contextWindowSource === 'user-edited' && stored > 0) {
		return { window: stored, source: 'user-edited' };
	}

	const reported = inputs.reportedWindow ?? 0;
	// A genuinely provider-resolved window (flagged only where the value came
	// from the provider's own payload) is runtime truth, so it outranks the
	// stored value below.
	if (inputs.reportedResolved && reported > 0) return { window: reported, source: 'provider' };

	// Reaching here means the stored value has NO recorded provenance, so it
	// cannot be told apart from the agent definition's `contextWindow` default
	// materialized into every new session at creation time (finding P1).
	if (stored > 0) return { window: stored, source: 'stored' };

	const configured = inputs.configuredWindow ?? 0;
	if (configured > 0) return { window: configured, source: 'configured' };
	if (reported > 0) return { window: reported, source: 'reported' };
	return { window: 0, source: 'none' };
}

/**
 * True when a stored `customContextWindow` exists but something outranked it,
 * so the number shown in settings is NOT the one being divided by.
 *
 * Deliberately derived from {@link resolveContextWindow}'s winning source
 * rather than by comparing numbers: a stored 200k and a provider-reported 200k
 * are the same figure for different reasons, and only the source distinguishes
 * them.
 */
export function isStoredContextWindowOverridden(resolved: ResolvedContextWindow): boolean {
	return resolved.source === 'model-marker' || resolved.source === 'provider';
}
