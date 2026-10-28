/**
 * `auto`: the model choice that means "decide per turn".
 *
 * An agent, an AI tab, one queued message, one `maestro-cli send` and one Cue
 * subscription can each name `auto` where they would name a model. A turn sent
 * on it asks the `model-routing` task how much model and effort the prompt
 * needs, and launches on the target that tier resolves to (`autoTurn.ts`).
 *
 * `auto` is Maestro's word, never a provider's: no harness is ever handed it as
 * a model name. The one place a model name becomes a launch argument
 * (`applyAgentConfigOverrides`) drops it, so a surface with no Auto path runs
 * the agent on its default model instead of failing on `--model auto`.
 *
 * A leaf on purpose: the launch code in `maestro-lib` reads the word, and it
 * must not reach the tier tables and the task registry to do it.
 */

/** The value stored where a model name goes (`customModel`, a queued item's `model`). */
export const AUTO_MODEL = 'auto';

/** How the choice reads to a person, in a picker and at the front of a pill. */
export const AUTO_MODEL_LABEL = 'Auto';

/** True when a stored model value is the Auto choice. Spelling is not case sensitive. */
export function isAutoModel(model: unknown): model is string {
	return typeof model === 'string' && model.trim().toLowerCase() === AUTO_MODEL;
}

/**
 * The model an agent names for itself, or `undefined` when it names none: no
 * model set, or Auto. What a caller passes as "the agent's own model" to a
 * resolver that falls back to it (`resolveTurnSettings`), so a tier or a
 * subscription that defers to the agent never defers to the word `auto`.
 */
export function ownModel(model: string | undefined | null): string | undefined {
	return model && !isAutoModel(model) ? model : undefined;
}

/**
 * Whether a string can be one turn's model as a caller typed it (`maestro-cli
 * send --model`): one short line with no surrounding space, and not a flag. It
 * becomes a launch argument, so a value that starts with `-` or carries a
 * control character is refused before it is handed to a harness.
 */
export function isTurnModelName(value: string): boolean {
	return /^[^\x00-\x1f\x7f\s-][^\x00-\x1f\x7f]{0,199}$/.test(value) && value === value.trim();
}
