/** The value stored where a model name goes (`customModel`, a queued item's `model`). */
export const AUTO_MODEL = 'auto';

/** How the choice reads to a person, in a picker and at the front of a pill. */
export const AUTO_MODEL_LABEL = 'Auto';

/** True when a stored model value is the Auto choice. Spelling is not case sensitive. */
export function isAutoModel(model: unknown): model is string {
	return typeof model === 'string' && model.trim().toLowerCase() === AUTO_MODEL;
}
