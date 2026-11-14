/**
 * Model routing by example: what a labeled prompt is, what the user's own
 * corrections are, and the vote that turns a prompt's nearest neighbours into a
 * tier and an effort.
 *
 * The embedding router (`src/main/local-models/model-router.ts`) embeds a prompt
 * and finds the labeled prompts closest to it. Everything it does that is not a
 * vector lives here, pure, so the store, the router, an eval and a CLI line all
 * read one set of rules:
 *
 *   - the shipped examples are `MODEL_ROUTING_EXAMPLES` in
 *     `model-routing-examples.ts`;
 *   - a correction is the user saying "this prompt needed THAT tier". It is kept
 *     in `userData/model-routing-corrections.json` and votes like any example;
 *   - {@link voteModelRoute} is the k-nearest-neighbour vote.
 *
 * Tier and effort share one vocabulary (`TIER_LEVELS`), so both axes are voted
 * the same way. It is imported from `tierLevels.ts`, never from `modelTiers.ts`:
 * the task registry imports this module's sibling, and `modelTiers.ts` reaches
 * the registry, so that import would close a cycle.
 */

import { asTierLevel, TIER_LEVELS, type EffortLevel, type ModelTier } from '../tierLevels';
import { redactSecrets } from '../redactSecrets';

/** One labeled prompt: the tier and effort a careful person would pick for it. */
export interface ModelRoutingExample {
	text: string;
	tier: ModelTier;
	effort: EffortLevel;
}

/**
 * One correction the user recorded. `effort` is absent when the user corrected
 * only the tier: the correction then has no say in the effort vote, instead of
 * a guess being stored as if a person had labeled it.
 */
export interface ModelRoutingCorrection {
	text: string;
	tier: ModelTier;
	effort?: EffortLevel;
	/** Epoch milliseconds. The oldest corrections are dropped first at the cap. */
	recordedAt: number;
}

/** Where a labeled prompt came from. */
export type ModelRoutingExampleOrigin = 'shipped' | 'correction';

/** A labeled prompt the router compares against, whichever list it came from. */
export interface ModelRoutingLabeledExample {
	text: string;
	tier: ModelTier;
	effort?: EffortLevel;
	origin: ModelRoutingExampleOrigin;
}

/** A labeled prompt and how close it is to the prompt being routed. */
export interface ModelRoutingNeighbour extends ModelRoutingLabeledExample {
	/** Cosine similarity to the routed prompt, -1 to 1. */
	similarity: number;
}

/** What the neighbours decided. */
export interface ModelRouteVote {
	tier: ModelTier;
	effort: EffortLevel;
	/** The tier vote's margin, 0 to 1: 1 is unanimous, 0 is a tie. */
	tierConfidence: number;
	/** The effort vote's margin, 0 to 1. 0 when no neighbour carried an effort. */
	effortConfidence: number;
}

/** The corrections file, beside the other Local Models stores in the data dir. */
export const MODEL_ROUTING_CORRECTIONS_FILE = 'model-routing-corrections.json';

/** The version of the file's shape. */
export const MODEL_ROUTING_CORRECTIONS_VERSION = 1;

/**
 * The most corrections kept. Each one is a vector in memory and a text embedded
 * after a model change, so the list is bounded; the oldest go first.
 */
export const MAX_MODEL_ROUTING_CORRECTIONS = 500;

/**
 * The longest text routed or stored. The catalog's embedding models read 512
 * tokens at least, about this many characters, so nothing past it would be
 * compared anyway.
 */
export const MODEL_ROUTING_TEXT_MAX_CHARS = 2000;

/** How many nearest neighbours vote. */
export const MODEL_ROUTING_NEIGHBOURS = 5;

/**
 * The smallest cosine distance a neighbour's weight is computed from. It bounds
 * the weight of an exact match (similarity 1) at 100 instead of infinity.
 */
const MIN_NEIGHBOUR_DISTANCE = 0.01;

/**
 * The text the router embeds and the corrections store keeps: secrets replaced,
 * trimmed, and cut to {@link MODEL_ROUTING_TEXT_MAX_CHARS}.
 *
 * One function for both, on purpose: a correction recorded for a prompt must be
 * the SAME text the router embeds for that prompt the next time, or it is only
 * a near neighbour of the thing it corrects. Secrets are replaced before the
 * cut, so a cut can never leave the first half of one in the file.
 */
export function normalizeModelRoutingText(text: string): string {
	return redactSecrets(text.trim()).text.slice(0, MODEL_ROUTING_TEXT_MAX_CHARS).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCorrection(value: unknown): ModelRoutingCorrection | null {
	if (!isRecord(value) || typeof value.text !== 'string') return null;
	const text = normalizeModelRoutingText(value.text);
	const tier = asTierLevel(value.tier);
	if (!text || !tier) return null;
	// An effort that is present but not a level is a damaged record, not "no effort".
	const effort = asTierLevel(value.effort);
	if (value.effort !== undefined && !effort) return null;
	const recordedAt =
		typeof value.recordedAt === 'number' && Number.isFinite(value.recordedAt)
			? value.recordedAt
			: 0;
	return { text, tier, ...(effort ? { effort } : {}), recordedAt };
}

/** What was read from the corrections file, and how many records were unusable. */
export interface ParsedModelRoutingCorrections {
	corrections: ModelRoutingCorrection[];
	dropped: number;
}

/**
 * Read the corrections file's contents. A record that fails its checks is
 * dropped and counted; of two records for the same text the later one wins,
 * as it does when a correction is recorded.
 */
export function parseModelRoutingCorrections(raw: unknown): ParsedModelRoutingCorrections {
	const list = isRecord(raw) && Array.isArray(raw.corrections) ? raw.corrections : [];
	let corrections: ModelRoutingCorrection[] = [];
	let dropped = 0;
	for (const item of list) {
		const correction = parseCorrection(item);
		if (!correction) {
			dropped++;
			continue;
		}
		corrections = withModelRoutingCorrection(corrections, correction).corrections;
	}
	return { corrections, dropped };
}

/** The file contents for a list of corrections. */
export function serializeModelRoutingCorrections(corrections: readonly ModelRoutingCorrection[]): {
	version: number;
	corrections: ModelRoutingCorrection[];
} {
	return { version: MODEL_ROUTING_CORRECTIONS_VERSION, corrections: [...corrections] };
}

/**
 * The list with one correction added. A correction for a text already in the
 * list replaces the earlier one (the user changed their mind), and the list is
 * held to {@link MAX_MODEL_ROUTING_CORRECTIONS} by dropping from the front,
 * which is the oldest end.
 */
export function withModelRoutingCorrection(
	corrections: readonly ModelRoutingCorrection[],
	correction: ModelRoutingCorrection
): { corrections: ModelRoutingCorrection[]; replaced: boolean } {
	const kept = corrections.filter((existing) => existing.text !== correction.text);
	const next = [...kept, correction];
	return {
		corrections: next.slice(Math.max(0, next.length - MAX_MODEL_ROUTING_CORRECTIONS)),
		replaced: kept.length !== corrections.length,
	};
}

/**
 * Every labeled prompt the router compares against: the shipped examples, then
 * the user's corrections. A correction for the exact text of a shipped example
 * REPLACES it, so the two never vote against each other over one prompt.
 */
export function mergeModelRoutingExamples(
	shipped: readonly ModelRoutingExample[],
	corrections: readonly ModelRoutingCorrection[]
): ModelRoutingLabeledExample[] {
	const merged = new Map<string, ModelRoutingLabeledExample>();
	for (const example of shipped) {
		const text = normalizeModelRoutingText(example.text);
		if (text)
			merged.set(text, { text, tier: example.tier, effort: example.effort, origin: 'shipped' });
	}
	for (const correction of corrections) {
		merged.set(correction.text, {
			text: correction.text,
			tier: correction.tier,
			...(correction.effort ? { effort: correction.effort } : {}),
			origin: 'correction',
		});
	}
	return [...merged.values()];
}

/**
 * How much one neighbour's vote counts: the inverse of its cosine distance, the
 * standard weighting for a distance-weighted k-nearest-neighbour vote.
 *
 * It needs no special case for a correction. A prompt the user corrected is its
 * own nearest neighbour at distance 0, and at weight 100 it outvotes any four
 * other neighbours, so correcting a prompt changes what that prompt routes to.
 */
export function modelRoutingNeighbourWeight(similarity: number): number {
	return 1 / Math.max(MIN_NEIGHBOUR_DISTANCE, 1 - similarity);
}

/** The winning level of one axis and its margin, or null when nothing voted. */
function voteAxis(
	votes: ReadonlyArray<{ level: ModelTier; weight: number }>
): { level: ModelTier; margin: number } | null {
	if (votes.length === 0) return null;
	const totals: Record<ModelTier, number> = { low: 0, medium: 0, high: 0 };
	let total = 0;
	for (const vote of votes) {
		totals[vote.level] += vote.weight;
		total += vote.weight;
	}
	// Highest total first. A tie goes to the HIGHER level: too much model costs
	// money, too little costs a wrong answer.
	const ranked = [...TIER_LEVELS].sort(
		(a, b) => totals[b] - totals[a] || TIER_LEVELS.indexOf(b) - TIER_LEVELS.indexOf(a)
	);
	const margin = total > 0 ? (totals[ranked[0]] - totals[ranked[1]]) / total : 0;
	return { level: ranked[0], margin };
}

/**
 * The distance-weighted vote of a prompt's nearest neighbours, or null when
 * there are none.
 *
 * Pass the neighbours that should vote (the router passes the
 * {@link MODEL_ROUTING_NEIGHBOURS} nearest). Each axis is voted on its own. A
 * neighbour with no effort label does not vote on effort; when none of them
 * carries one, the effort is the tier that won, at confidence 0.
 */
export function voteModelRoute(
	neighbours: readonly ModelRoutingNeighbour[]
): ModelRouteVote | null {
	const weighted = neighbours.map((neighbour) => ({
		neighbour,
		weight: modelRoutingNeighbourWeight(neighbour.similarity),
	}));
	const tier = voteAxis(
		weighted.map(({ neighbour, weight }) => ({ level: neighbour.tier, weight }))
	);
	if (!tier) return null;
	const effort = voteAxis(
		weighted.flatMap(({ neighbour, weight }) =>
			neighbour.effort ? [{ level: neighbour.effort, weight }] : []
		)
	);
	return {
		tier: tier.level,
		effort: effort?.level ?? tier.level,
		tierConfidence: tier.margin,
		effortConfidence: effort?.margin ?? 0,
	};
}
