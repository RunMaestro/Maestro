/**
 * Turn the document's hint into the model and effort a spawn actually uses.
 *
 * This is the join between {@link findActiveModelHint} (what the document
 * asked for) and {@link resolveTierModel} (what this provider can deliver), and
 * it is shared so the desktop and CLI Auto Run engines cannot disagree. It also
 * produces the human-readable line each engine reports, because the whole point
 * of the design is that an unresolvable hint is LOUD rather than silent.
 *
 * Precedence, highest first:
 *   1. The document's hint, if the provider can act on it.
 *   2. The agent's own configured model / effort.
 *   3. The provider's default.
 *
 * A hint the provider cannot act on falls to (2) and sets `warning`. That is
 * the case worth caring about: the author wrote `tier="high"` expecting the top
 * model, and on OpenCode there is nothing to switch to. Running the task anyway
 * is right (the work still needs doing), but doing it without saying so is how
 * someone concludes the feature is broken three tasks later.
 */

import type { ToolType } from './types';
import type { ModelHint } from './autorunModelHints';
import {
	resolveEffortLevel,
	resolveTierModel,
	supportsEffortSelection,
	supportsTierSelection,
} from './modelTiers';

export interface ResolvedTurnSettings {
	/** Model to spawn with, or `undefined` to let the agent's config decide. */
	model?: string;
	/** Effort to spawn with, or `undefined` to let the agent's config decide. */
	effort?: string;
	/**
	 * One line per axis describing what was applied, for the JSONL stream and
	 * the History entry. Empty when the document set no hint.
	 */
	notes: string[];
	/**
	 * Problems the author should know about: a hint this provider cannot honor,
	 * or a misspelled attribute value. Reported at dispatch AND at document load.
	 */
	warnings: string[];
}

/**
 * Resolve one task's model and effort.
 *
 * `agentModel` / `agentEffort` are the agent's own configured values, used
 * whenever the document is silent or the provider cannot act on the hint.
 */
export function resolveTurnSettings(
	toolType: ToolType,
	hint: ModelHint | null,
	agentModel?: string,
	agentEffort?: string
): ResolvedTurnSettings {
	const notes: string[] = [];
	const warnings: string[] = [];
	let model = agentModel;
	let effort = agentEffort;

	for (const invalid of hint?.invalid ?? []) {
		warnings.push(
			`Ignored ${invalid.attribute}="${invalid.value}" on line ${(hint?.line ?? 0) + 1}: expected low, medium, high, or default.`
		);
	}

	// `'default'` reaches here as an explicit "use the agent's value", which is
	// what `model` already holds - so it is skipped exactly like an absent axis.
	// The two only differ when scopes merge, upstream of this.
	if (hint?.tier && hint.tier !== 'default') {
		const tierModel = resolveTierModel(toolType, hint.tier);
		if (tierModel) {
			model = tierModel;
			notes.push(`tier="${hint.tier}" (${hint.scopes?.tier ?? 'document'}) -> model ${tierModel}`);
		} else {
			warnings.push(
				supportsTierSelection(toolType)
					? `No "${hint.tier}" tier model is mapped for ${toolType}; using the agent's configured model.`
					: `${toolType} has no model tier mapping, so tier="${hint.tier}" was ignored; using the agent's configured model.`
			);
		}
	}

	if (hint?.effort && hint.effort !== 'default') {
		const effortValue = resolveEffortLevel(toolType, hint.effort);
		if (effortValue) {
			effort = effortValue;
			notes.push(
				`effort="${hint.effort}" (${hint.scopes?.effort ?? 'document'}) -> ${effortValue}`
			);
		} else {
			warnings.push(
				supportsEffortSelection(toolType)
					? `No "${hint.effort}" effort level is mapped for ${toolType}; using the agent's configured effort.`
					: `${toolType} has no effort setting, so effort="${hint.effort}" was ignored.`
			);
		}
	}

	return { model, effort, notes, warnings };
}

/**
 * One-line summary of a resolution, for a log line or a History entry.
 * `null` when the document set no hint, so callers can skip the line entirely
 * rather than printing "no change" on every task of every ordinary playbook.
 */
export function describeTurnSettings(resolved: ResolvedTurnSettings): string | null {
	const parts = [...resolved.notes, ...resolved.warnings];
	return parts.length > 0 ? parts.join(' ') : null;
}
