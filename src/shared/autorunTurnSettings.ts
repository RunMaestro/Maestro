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
 *
 * A tier names a TARGET, not only a model: {@link resolveTierTarget} reads the
 * agent's own tier targets, then the harness defaults, then the built-in table.
 * So a `low` task can launch on a local source and a `high` task on the
 * provider. A target a layer names and that cannot be used is not a warning: it
 * sets `refusal`, and the task must not launch (never on some other model).
 */

import type { ToolType } from './types';
import type { ModelHint } from './autorunModelHints';
import type { RunOnTarget } from './local-models/run-on';
import { describeEffortRejection } from './effortRejection';
import {
	rejectedEffortForLevel,
	resolveEffortLevel,
	resolveTierTarget,
	supportsEffortSelection,
	tierTargetLaunch,
	TIER_TARGET_SOURCE_LABELS,
	type TierRouting,
	type TierTargetRefusal,
	type TierTargetSource,
} from './modelTiers';

export interface ResolvedTurnSettings {
	/** Model to spawn with, or `undefined` to let the agent's config decide. */
	model?: string;
	/** Effort to spawn with, or `undefined` to let the agent's config decide. */
	effort?: string;
	/**
	 * Where the turn launches, when the tier's target decides it: the provider,
	 * or a source (then `model` is the source's model). `undefined` means the
	 * agent's own Run on target stands.
	 */
	runOn?: RunOnTarget;
	/** The layer the tier's target came from. Absent when no tier was applied. */
	tierSource?: TierTargetSource;
	/**
	 * Set when a layer names a target for the tier that cannot be used. The turn
	 * must fail with this message; it must not launch on the agent's own model.
	 */
	refusal?: Pick<TierTargetRefusal, 'code' | 'message'>;
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
 * `routing` carries the agent's tier targets and the harness defaults.
 */
export function resolveTurnSettings(
	toolType: ToolType,
	hint: ModelHint | null,
	agentModel?: string,
	agentEffort?: string,
	routing?: TierRouting
): ResolvedTurnSettings {
	const notes: string[] = [];
	const warnings: string[] = [];
	let model = agentModel;
	let effort = agentEffort;
	let runOn: RunOnTarget | undefined;
	let tierSource: TierTargetSource | undefined;
	let refusal: ResolvedTurnSettings['refusal'];

	for (const invalid of hint?.invalid ?? []) {
		warnings.push(
			`Ignored ${invalid.attribute}="${invalid.value}" on line ${(hint?.line ?? 0) + 1}: expected low, medium, high, or default.`
		);
	}

	// `'default'` reaches here as an explicit "use the agent's value", which is
	// what `model` already holds - so it is skipped exactly like an absent axis.
	// The two only differ when scopes merge, upstream of this.
	if (hint?.tier && hint.tier !== 'default') {
		const resolved = resolveTierTarget(
			{ toolType, tierTargets: routing?.tierTargets, runOn: routing?.runOn },
			hint.tier,
			routing?.harnessDefaults
		);
		if (resolved.kind === 'resolved') {
			const launch = tierTargetLaunch(resolved, agentModel);
			model = launch.model;
			runOn = launch.runOn;
			tierSource = resolved.source;
			notes.push(
				`tier="${hint.tier}" (${hint.scopes?.tier ?? 'document'}) -> ${describeTierLaunch(launch)} (${TIER_TARGET_SOURCE_LABELS[resolved.source]})`
			);
		} else if (resolved.blocksLaunch) {
			refusal = { code: resolved.code, message: resolved.message };
			warnings.push(resolved.message);
		} else {
			warnings.push(resolved.message);
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
			// A level the provider refused earlier in this process is a different
			// story from one Maestro never mapped: say which, so the author knows
			// the document is fine and the provider's catalogue moved.
			const rejection = rejectedEffortForLevel(toolType, hint.effort);
			warnings.push(
				rejection
					? `${describeEffortRejection(toolType, rejection)} effort="${hint.effort}" was ignored; using the agent's configured effort.`
					: supportsEffortSelection(toolType)
						? `No "${hint.effort}" effort level is mapped for ${toolType}; using the agent's configured effort.`
						: `${toolType} has no effort setting, so effort="${hint.effort}" was ignored.`
			);
		}
	}

	return {
		model,
		effort,
		...(runOn ? { runOn } : {}),
		...(tierSource ? { tierSource } : {}),
		...(refusal ? { refusal } : {}),
		notes,
		warnings,
	};
}

/**
 * The Run on target a resolved turn launches on, as data for the Run on path
 * (`prepareLaunchRunOn`, which validates it): the tier's target when a layer
 * the user wrote decided the place, else the agent's own stored one. Every
 * surface that launches a resolved turn passes this, never the agent's `runOn`
 * alone: that would launch a source tier's model name on the provider.
 */
export function turnRunOnTarget(turn: { runOn?: unknown }, agentRunOn: unknown): unknown {
	return turn.runOn ?? agentRunOn;
}

/** What a tier resolved to, for a note: the model, and the source when it names one. */
function describeTierLaunch(launch: { model: string | undefined; runOn?: RunOnTarget }): string {
	if (launch.runOn?.type === 'source') {
		return `model ${launch.runOn.model} on source ${launch.runOn.endpointId}`;
	}
	const model = launch.model ? `model ${launch.model}` : "the agent's model";
	return launch.runOn ? `${model} on the provider` : model;
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
