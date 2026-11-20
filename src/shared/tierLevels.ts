/**
 * The three rungs Maestro uses for "how much horsepower does this turn need":
 * `low | medium | high`, for both the model TIER and the EFFORT level.
 *
 * This is a leaf on purpose: it imports nothing. What each rung MEANS for a
 * provider (which model, which effort flag) is `modelTiers.ts`, which re-exports
 * everything here, so import from there unless you are a module `modelTiers.ts`
 * itself reaches. The Local Models task registry is one: `modelTiers.ts` reads
 * it through `local-models/run-on.ts`, so the registry and what it imports
 * (`local-models/model-routing.ts`, `local-models/model-routing-task.ts`) take
 * the vocabulary from here. Importing `modelTiers.ts` from one of those closes
 * a cycle, and a constant `modelTiers.ts` builds while it loads is then built
 * from a value that is not there yet.
 */

/** The one vocabulary: model tier and effort level both use these three rungs. */
export const TIER_LEVELS = ['low', 'medium', 'high'] as const;

/** Which model to use. Resolved per provider by `resolveTierModel` in `modelTiers.ts`. */
export type ModelTier = (typeof TIER_LEVELS)[number];

/** How hard the model should think. Resolved by `resolveEffortLevel` in `modelTiers.ts`. */
export type EffortLevel = (typeof TIER_LEVELS)[number];

/** Narrow an unknown value to a tier/effort rung, or `undefined` if it isn't one. */
export function asTierLevel(value: unknown): ModelTier | undefined {
	return TIER_LEVELS.includes(value as ModelTier) ? (value as ModelTier) : undefined;
}
