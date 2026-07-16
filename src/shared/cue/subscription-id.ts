/**
 * Stable composite identity for a Cue subscription as exposed to remote
 * callers (the CLI, the web/mobile UI). The Cue YAML itself doesn't carry a
 * per-subscription primary key - subscription `name` is unique only *within*
 * a pipeline, and a single session can host multiple pipelines that each
 * legitimately define a sub with the same name. Composing
 * `${sessionId}::${pipeline}::${name}` gives a stable, parseable id that
 * survives that collision without needing to introduce a persisted uuid
 * onto every YAML row.
 *
 * Used by the web-server factory's `setGetCueSubscriptionsCallback` and the
 * follow-up `setSubscriptionEnabled` engine method so both sides agree on
 * the same identity contract.
 */

/** Minimal shape needed to derive the pipeline discriminator. Kept narrow so
 *  this module never has to import the full CueSubscription type (and so
 *  tests don't need to construct a full subscription either). */
export interface CueSubscriptionIdInput {
	name: string;
	pipeline_name?: string;
}

/** Field separator inside a composite id. Chosen to be visually distinctive
 *  while still URL-safe and unambiguous against typical pipeline / sub names
 *  (which never legitimately contain `::`). */
export const CUE_SUBSCRIPTION_ID_SEP = '::';

/**
 * Derive the pipeline discriminator for a subscription. Prefers the
 * authoritative `pipeline_name` field when present and non-empty; otherwise
 * falls back to the legacy convention of stripping `-chain-N`, `-fanin`,
 * `-cmd-<id>`, and `-cli-out` suffixes off the subscription name. Mirrors
 * `getBasePipelineName` in `yamlToPipeline.ts` so both sides classify the
 * same YAML into the same group.
 */
export function pipelineKeyForSubscription(sub: CueSubscriptionIdInput): string {
	if (typeof sub.pipeline_name === 'string' && sub.pipeline_name.length > 0) {
		return sub.pipeline_name;
	}
	return sub.name
		.replace(/-chain-\d+$/, '')
		.replace(/-fanin$/, '')
		.replace(/-cmd-[a-z0-9]+$/i, '')
		.replace(/-cli-out$/, '');
}

/**
 * Compose the remote-exposed subscription id. Always
 * `${sessionId}::${pipeline}::${name}`. Names containing `::` would break
 * round-trip parsing - Cue validator rejects names with these characters, so
 * this should never fire in practice, but we throw in dev to surface a hand-
 * edited YAML mistake instead of silently producing a degenerate id.
 */
export function composeCueSubscriptionId(sessionId: string, sub: CueSubscriptionIdInput): string {
	const pipeline = pipelineKeyForSubscription(sub);
	if (
		sessionId.includes(CUE_SUBSCRIPTION_ID_SEP) ||
		pipeline.includes(CUE_SUBSCRIPTION_ID_SEP) ||
		sub.name.includes(CUE_SUBSCRIPTION_ID_SEP)
	) {
		// Falling through silently would let a malformed component produce
		// an unparseable id that the toggle path would then reject as
		// "no such subscription" - worse than the YAML error this catches.
		throw new Error(
			`Cue subscription id components must not contain "${CUE_SUBSCRIPTION_ID_SEP}" (session=${sessionId}, pipeline=${pipeline}, name=${sub.name})`
		);
	}
	return `${sessionId}${CUE_SUBSCRIPTION_ID_SEP}${pipeline}${CUE_SUBSCRIPTION_ID_SEP}${sub.name}`;
}

/**
 * Inverse of {@link composeCueSubscriptionId}. Returns `null` when the input
 * doesn't carry exactly three non-empty `::`-separated components - callers
 * must treat `null` as "no matching subscription" rather than falling back
 * to a partial match.
 */
export function parseCueSubscriptionId(
	id: string
): { sessionId: string; pipeline: string; name: string } | null {
	const parts = id.split(CUE_SUBSCRIPTION_ID_SEP);
	if (parts.length !== 3) return null;
	const [sessionId, pipeline, name] = parts;
	if (!sessionId || !pipeline || !name) return null;
	return { sessionId, pipeline, name };
}
