/**
 * Provider-normalized model tiers and effort levels.
 *
 * Maestro speaks one vocabulary for "how much horsepower does this turn need":
 * `low | medium | high`, for both the model TIER and the EFFORT level. Every
 * provider spells those differently (or not at all), so this module is the one
 * place that translates. An Auto Run document says `tier="high"`; what actually
 * reaches the command line depends on which agent is running it.
 *
 * Two separate axes, deliberately:
 *
 * - **Tier** picks WHICH model. Only meaningful where we can name a model with
 *   confidence, which is fewer providers than you would hope (see below).
 * - **Effort** picks how hard that model thinks. Orthogonal: a low-tier model
 *   at high effort is a perfectly sensible request.
 *
 * The ladder rule for effort: `low` is the FLOOR of the provider's ladder,
 * `high` is the CEILING, `medium` is the middle rung. That is why the mapping
 * is not the identity even where the provider happens to use the same three
 * words. Claude's ladder runs `low, medium, high, xhigh, max`, so Maestro's
 * `high` means `max` (the actual ceiling) and Maestro's `medium` means `high`
 * (the actual middle). Codex's ceiling is `xhigh`, the top rung every one of
 * its models accepts. The tables below
 * are written out per provider rather than computed from an index so the
 * resolution is auditable by reading it - a surprising row should be obvious
 * here rather than discovered at runtime.
 *
 * Unmapped is a first-class answer. `undefined` means "we have no opinion for
 * this provider, use the agent's own configured default", and callers surface
 * that as a visible warning rather than a silent substitution. Quietly running
 * a deep-planning task on whatever the default model is - when the document
 * asked for the top tier - is the failure this module exists to prevent.
 */

import type { ToolType } from './types';
import { FALLBACK_CONTEXT_WINDOW, getModelContextWindowOverride } from './agentConstants';
import { getEffortRejection, type EffortRejection } from './effortRejection';

/** The one vocabulary: model tier and effort level both use these three rungs. */
export const TIER_LEVELS = ['low', 'medium', 'high'] as const;

/** Which model to use. Resolved per provider by {@link resolveTierModel}. */
export type ModelTier = (typeof TIER_LEVELS)[number];

/** How hard the model should think. Resolved by {@link resolveEffortLevel}. */
export type EffortLevel = (typeof TIER_LEVELS)[number];

/** Narrow an unknown value to a tier/effort rung, or `undefined` if it isn't one. */
export function asTierLevel(value: unknown): ModelTier | undefined {
	return TIER_LEVELS.includes(value as ModelTier) ? (value as ModelTier) : undefined;
}

/**
 * Effort ladders, per provider, floor to ceiling.
 *
 * Mirrors the `effort` / `reasoningEffort` option in `src/main/agents/definitions.ts`
 * minus the leading empty string (which means "provider default", not a rung).
 * OpenCode is absent on purpose: it exposes no effort knob at all, so an effort
 * hint on an OpenCode agent has nothing to write and resolves to `undefined`.
 *
 * These are static rather than read from runtime discovery because a document
 * must resolve identically on every machine. Discovery can ADD rungs a given
 * install supports; it cannot be allowed to silently change what `high` means
 * for a playbook someone else wrote.
 *
 * The one runtime input is a REFUSAL. A static table goes stale the day a
 * provider retires a rung, and the provider then fails the turn outright rather
 * than clamping. A value the provider has refused in this process resolves to
 * `undefined` from then on (see `effortRejection.ts`): never a different value,
 * only "inherit the agent's own", and always reported.
 */
const EFFORT_LADDERS: Partial<Record<ToolType, Record<EffortLevel, string>>> = {
	// Ladder: low, medium, high, xhigh, max
	'claude-code': { low: 'low', medium: 'high', high: 'max' },
	// Ladder: low, medium, high, xhigh (then max / ultra on some models).
	// The floor is `low`, NOT `minimal`: no model in Codex's catalogue accepts
	// `minimal` any more, and the API answers it with a 400 rather than
	// clamping, so every cheap turn (tab naming, synopsis) died with no output.
	// `xhigh` stays the ceiling because it is the highest rung EVERY model
	// lists; `max` and `ultra` are per-model.
	codex: { low: 'low', medium: 'medium', high: 'xhigh' },
	// Ladder: low, medium, high - the one provider where the mapping IS the identity.
	'factory-droid': { low: 'low', medium: 'medium', high: 'high' },
	// Ladder: low, medium, high, xhigh. Even-length, so "middle" is a judgment
	// call: medium takes the lower of the two central rungs, matching the name.
	'copilot-cli': { low: 'low', medium: 'medium', high: 'xhigh' },
};

/**
 * Model tiers, per provider.
 *
 * Deliberately sparse. A tier map is only shipped where the identifiers are
 * stable enough that a playbook written today still resolves correctly in six
 * months:
 *
 * - `claude-code` uses the permanent aliases, which always resolve to the
 *   current model in each tier. Safe indefinitely.
 * - `factory-droid` takes one model family so the three tiers are genuinely
 *   comparable. The IDs are versioned and will need revising, but they are
 *   already hard-coded in the agent definition, so this is no new exposure.
 *
 * Absent on purpose: `codex` and `copilot-cli` discover their catalogues at
 * runtime (`models_cache.json`, models.dev) and their IDs churn per release;
 * `opencode` runs whatever the user configured, which may be a local Ollama
 * model with no knowable tier. Guessing for those would produce a table that
 * silently rots into naming models the user cannot run. They resolve to the
 * agent default, and the caller says so out loud.
 */
const TIER_MODELS: Partial<Record<ToolType, Record<ModelTier, string>>> = {
	'claude-code': { low: 'haiku', medium: 'sonnet', high: 'opus' },
	'factory-droid': {
		low: 'claude-haiku-4-5-20251001',
		medium: 'claude-sonnet-4-5-20250929',
		high: 'claude-opus-4-5-20251101',
	},
};

/**
 * The model for a tier on this provider, or `undefined` when Maestro has no
 * opinion. `undefined` means "fall back to the agent's configured model" - the
 * caller is expected to report that it did, so the author learns their hint had
 * no effect rather than silently getting the wrong model.
 */
export function resolveTierModel(toolType: ToolType, tier: ModelTier): string | undefined {
	return TIER_MODELS[toolType]?.[tier];
}

/**
 * The provider's effort string for a level, or `undefined` when the provider
 * has no effort knob (OpenCode) or is not mapped. Same contract as
 * {@link resolveTierModel}: `undefined` is inherit-and-say-so.
 */
export function resolveEffortLevel(toolType: ToolType, level: EffortLevel): string | undefined {
	return rejectedEffortForLevel(toolType, level) ? undefined : EFFORT_LADDERS[toolType]?.[level];
}

/**
 * The provider's refusal of the value this level maps to, when it has refused
 * it in this process (see `effortRejection.ts`).
 *
 * The ladders above are a snapshot of each provider's catalogue, and a provider
 * can retire a rung without notice. Once it has said no, the level resolves to
 * `undefined` - inherit the agent's own effort - instead of sending a value
 * that is known to fail the turn. Callers that explain an unmapped level to the
 * user read the refusal from here so they can say what actually happened.
 */
export function rejectedEffortForLevel(
	toolType: ToolType,
	level: EffortLevel
): EffortRejection | undefined {
	const value = EFFORT_LADDERS[toolType]?.[level];
	return value === undefined ? undefined : getEffortRejection(toolType, value);
}

/**
 * True when `value` is one a ladder above hands out for this provider.
 *
 * Tells a refusal of something MAESTRO chose (the shipped table has drifted
 * from the provider's catalogue, fixable only in a release) apart from a
 * refusal of something the user picked on a tab, which is theirs to change.
 */
export function isLadderEffortValue(toolType: string, value: string): boolean {
	const ladder = EFFORT_LADDERS[toolType as ToolType];
	return ladder !== undefined && Object.values(ladder).includes(value);
}

/** True when this provider can act on a tier hint at all. */
export function supportsTierSelection(toolType: ToolType): boolean {
	return TIER_MODELS[toolType] !== undefined;
}

/** True when this provider can act on an effort hint at all. */
export function supportsEffortSelection(toolType: ToolType): boolean {
	return EFFORT_LADDERS[toolType] !== undefined;
}

/**
 * Model and effort for a throwaway summarization turn.
 *
 * A synopsis reads a conversation that already happened and writes a few
 * sentences about it. It is the cheapest useful thing an agent does, and
 * running it on the same model that just did the engineering is pure waste -
 * on a long Auto Run that is one premium turn per task, forever, for prose
 * nobody reads twice. So every synopsis is pinned to the bottom of both
 * ladders regardless of what the agent or the task was configured with.
 *
 * Safe because a synopsis is a LEAF: it resumes the finished session, and every
 * caller discards the `agentSessionId` it returns rather than adopting it. The
 * downgrade therefore cannot follow the conversation forward into the next real
 * turn. If a future caller ever DOES adopt that id, this pin has to be revisited
 * first, or the tab silently continues on the cheap model.
 */
export function cheapTurnSettings(toolType: ToolType): {
	model: string | undefined;
	effort: string | undefined;
} {
	return {
		model: resolveTierModel(toolType, 'low'),
		effort: resolveEffortLevel(toolType, 'low'),
	};
}

/**
 * `cheapTurnSettings` for a turn that RESUMES the session it summarizes, with
 * the fallbacks already applied. This is what a synopsis spawn should pass.
 *
 * The cheap tier is a MODEL swap, and a model carries a context window with
 * it. Resuming replays the whole transcript, so downgrading a session running
 * Anthropic's 1M beta (`opus[1m]`) onto a 200k model makes the synopsis of a
 * long conversation fail with "Prompt is too long": the transcript fit the
 * session's model and cannot fit the cheap one. So the session's model is kept
 * whenever the downgrade would shrink the window. Effort still drops to the
 * bottom rung, since that costs nothing to read.
 *
 * `current` is what the summarized turn ran at. It is also what the turn
 * inherits on a provider with no tier mapping (codex, opencode), where there
 * is nothing to downgrade TO.
 */
export function cheapResumeTurnSettings(
	toolType: ToolType,
	current: { model?: string; effort?: string } = {}
): {
	model: string | undefined;
	effort: string | undefined;
} {
	const cheap = cheapTurnSettings(toolType);
	const shrinksWindow =
		(getModelContextWindowOverride(current.model) ?? FALLBACK_CONTEXT_WINDOW) >
		(getModelContextWindowOverride(cheap.model) ?? FALLBACK_CONTEXT_WINDOW);
	return {
		model: shrinksWindow ? current.model : (cheap.model ?? current.model),
		effort: cheap.effort ?? current.effort,
	};
}
