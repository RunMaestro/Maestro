import type { CueSubscription } from './cue-types';

export const SOURCE_OUTPUT_MAX_CHARS = 5000;

export interface FanInSourceCompletion {
	sessionId: string;
	sessionName: string;
	output: string;
	truncated: boolean;
	chainDepth: number;
}

export interface FilteredOutputs {
	outputCompletions: FanInSourceCompletion[];
	perSourceOutputs: Record<string, string>;
	forwardedOutputs: Record<string, string>;
}

/**
 * Build filtered output maps from completed agent outputs, honoring the
 * subscription's `include_output_from` / `forward_output_from` lists.
 *
 * Shared by the fan-in tracker and the single-source completion path so both
 * paths respect the same include/forward semantics. When the include/forward
 * lists are undefined, every completion is treated as both included and (if
 * forward semantics are off) not forwarded — matching the legacy default.
 */
export function buildFilteredOutputs(
	completions: FanInSourceCompletion[],
	sub: CueSubscription
): FilteredOutputs {
	const includeSet = sub.include_output_from ? new Set(sub.include_output_from) : null;
	const outputCompletions = includeSet
		? completions.filter((c) => includeSet.has(c.sessionName) || includeSet.has(c.sessionId))
		: completions;

	const perSourceOutputs: Record<string, string> = {};
	for (const c of outputCompletions) {
		perSourceOutputs[c.sessionName] = c.output;
	}

	const forwardSet = sub.forward_output_from ? new Set(sub.forward_output_from) : null;
	const forwardedOutputs: Record<string, string> = {};
	if (forwardSet) {
		for (const c of completions) {
			if (forwardSet.has(c.sessionName) || forwardSet.has(c.sessionId)) {
				forwardedOutputs[c.sessionName] = c.output;
			}
		}
	}

	return { outputCompletions, perSourceOutputs, forwardedOutputs };
}

/**
 * Merge upstream-forwarded data into the current completion's forwardedOutputs
 * map. Preserves the pre-existing pass-through behavior for single-source
 * chains — if `forward_output_from` is set on the subscription, the upstream
 * map is filtered to only the listed names; if unset, everything passes
 * through (backward-compatible default).
 */
export function mergeUpstreamForwarded(
	forwardedOutputs: Record<string, string>,
	upstreamForwarded: Record<string, string> | undefined,
	sub: CueSubscription
): Record<string, string> {
	if (!upstreamForwarded) return forwardedOutputs;
	const forwardSet = sub.forward_output_from ? new Set(sub.forward_output_from) : null;
	const merged = { ...forwardedOutputs };
	for (const [name, output] of Object.entries(upstreamForwarded)) {
		if (!forwardSet || forwardSet.has(name)) {
			merged[name] = output;
		}
	}
	return merged;
}
