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
 *
 * **Map keying contract**: `perSourceOutputs` and `forwardedOutputs` are keyed
 * by `sessionName` — this is load-bearing because the template-variable
 * substitution downstream derives variable names like `{{CUE_OUTPUT_AGENT_A}}`
 * from the key. That means two completions with the same `sessionName` but
 * different `sessionId` values will collide: the later write wins. Session
 * names are expected to be unique within a Cue graph — enforced at the UI
 * layer — so in practice this is a theoretical concern, but it's documented
 * here so callers don't assume uniqueness by sessionId.
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
 *
 * **Known asymmetry with `buildFilteredOutputs`**: that function matches on
 * either `sessionName` or `sessionId`, but here we only have names because
 * `upstreamForwarded` is `Record<sessionName, output>` — the wire format
 * doesn't carry sessionId for forwarded entries. Users who configure
 * `forward_output_from` with session IDs will see their upstream-forwarded
 * entries dropped at every hop beyond the direct source. Practically, this
 * is fine because the Cue UI generates pipeline YAML using session names,
 * not IDs — if you're hitting this, fix the YAML to use names. A proper fix
 * would require a wire-format change (sidecar id map) and is intentionally
 * deferred.
 */
export function mergeUpstreamForwarded(
	forwardedOutputs: Record<string, string>,
	upstreamForwarded: Record<string, string> | undefined,
	sub: CueSubscription
): Record<string, string> {
	if (!upstreamForwarded) return forwardedOutputs;
	const forwardSet = sub.forward_output_from ? new Set(sub.forward_output_from) : null;
	// Invariant: `forwardedOutputs` has already been filtered by
	// `buildFilteredOutputs` against this same `sub.forward_output_from`, so
	// every entry copied from it into `merged` is already allow-listed. We
	// don't re-check it here — only the `upstreamForwarded` entries need the
	// forwardSet filter applied.
	const merged = { ...forwardedOutputs };
	for (const [name, output] of Object.entries(upstreamForwarded)) {
		if (!forwardSet || forwardSet.has(name)) {
			merged[name] = output;
		}
	}
	return merged;
}
