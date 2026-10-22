/**
 * A Cue subscription's model and effort, resolved for the agent that runs it.
 *
 * A subscription may set `tier` OR an exact `model`, plus `effort`. Tier and
 * effort speak Maestro's one `low | medium | high` vocabulary and resolve
 * through {@link resolveTurnSettings}, the same join Auto Run uses, so a
 * `tier: high` in cue.yaml and a `tier="high"` marker in a playbook land on the
 * same model. A pinned `model` is handed to the agent verbatim: it exists for
 * providers with no tier table (Codex, OpenCode) and for a model a tier cannot
 * name.
 *
 * Precedence, highest first: the subscription, the agent's own configured
 * value, the provider default. A tier or effort the provider cannot honor falls
 * back to the agent's value and lands in `warnings`, so the run still happens
 * and the activity log says why it ran on a different model than asked.
 *
 * `model: auto` is how a subscription opts its runs into model routing
 * ({@link cueRunIsAutoRouted}). Routing needs the prompt, which only exists
 * once the run's variables are substituted, so such a run is resolved in two
 * steps: {@link resolveCueTurnSettings} gives what it launches with when the
 * router has no decision, and the executor asks the host to finish it
 * (`CueExecutionConfig.resolveLateTurn`) when the prompt is known. A
 * subscription that does not opt in is never routed, whatever the agent's own
 * model is: an agent set to Auto then runs its Cue turns on its default.
 */

import type { ToolType } from '../types';
import { isAutoModel, ownModel } from '../autoModel';
import type { ModelHint } from '../autorunModelHints';
import {
	resolveTurnSettings,
	turnRunOnTarget,
	type ResolvedTurnSettings,
} from '../autorunTurnSettings';
import { TIER_LEVELS, asTierLevel, type TierRouting } from '../modelTiers';
import type { CueSubscription } from './contracts';

/** The three per-subscription model fields, carried from dispatch to spawn. */
export type CueTurnSettings = Pick<CueSubscription, 'tier' | 'model' | 'effort'>;

/**
 * Lift the model fields off a subscription. `undefined` when none is set, so an
 * ordinary subscription threads nothing through the queue.
 */
export function cueTurnSettingsOf(sub: CueTurnSettings): CueTurnSettings | undefined {
	const settings: CueTurnSettings = {};
	if (sub.tier) settings.tier = sub.tier;
	const model = sub.model?.trim();
	if (model) settings.model = model;
	if (sub.effort) settings.effort = sub.effort;
	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Resolve a subscription's settings against the agent that runs it.
 * `agentModel` / `agentEffort` are the agent's own configured values, and
 * `routing` its tier targets and the harness defaults, so a subscription's
 * tier launches where the same tier launches in a playbook. A pinned model
 * names the model only: the run stays on the agent's own Run on target.
 */
export function resolveCueTurnSettings(
	toolType: ToolType,
	settings: CueTurnSettings | undefined,
	agentModel?: string,
	agentEffort?: string,
	routing?: TierRouting
): ResolvedTurnSettings {
	// `auto` pins nothing: it is the word for "route this run", and neither the
	// subscription's nor the agent's is ever a model name to launch on.
	const pinnedModel = ownModel(settings?.model?.trim());
	// A pinned model replaces the tier outright. The validator refuses both on
	// one subscription; dropping the tier here keeps a hand-built value from
	// reporting a tier note for a model it did not choose.
	const tier = pinnedModel ? undefined : settings?.tier;
	const effort = settings?.effort;
	const resolved = resolveTurnSettings(
		toolType,
		tier || effort
			? { tier, effort, line: 0, scopes: { tier: 'subscription', effort: 'subscription' } }
			: null,
		ownModel(agentModel),
		agentEffort,
		routing
	);
	if (pinnedModel) {
		resolved.model = pinnedModel;
		resolved.notes.unshift(`model="${pinnedModel}" (subscription)`);
	}
	return resolved;
}

/** Whether a subscription opts its runs into model routing: `model: auto`. */
export function cueRunIsAutoRouted(settings: CueTurnSettings | undefined): boolean {
	return isAutoModel(settings?.model);
}

/**
 * What a routed subscription still fixes for its run, as the marker
 * `resolveAutoTurn` takes: its `effort`. The router decides the tier (a
 * subscription cannot set both `tier` and `model`), and the effort too when
 * the subscription names none.
 */
export function cueAutoMarker(settings: CueTurnSettings | undefined): ModelHint | null {
	return settings?.effort
		? { line: 0, effort: settings.effort, scopes: { effort: 'subscription' } }
		: null;
}

/** The launch fields of a Cue run that a resolved turn decides. */
export interface CueTurnLaunch {
	customModel?: string;
	customEffort?: string;
	/** The Run on target the run launches on, as data for the Run on path. */
	runOn?: unknown;
	/** Set when the turn's tier names a target that cannot be used. The run must not start. */
	launchRefusal?: string;
}

/**
 * A resolved turn as the launch fields `executeCuePrompt` takes. One mapping
 * for both hosts (the desktop app and the standalone CLI engine) and for both
 * moments a turn is resolved (at dispatch, and once the prompt is known), so a
 * tier's place and a refusal cannot be carried one way here and another there.
 */
export function cueTurnLaunch(turn: ResolvedTurnSettings, agentRunOn: unknown): CueTurnLaunch {
	return {
		customModel: turn.model,
		customEffort: turn.effort,
		runOn: turnRunOnTarget(turn, agentRunOn),
		...(turn.refusal ? { launchRefusal: turn.refusal.message } : {}),
	};
}

/** Whether two holders carry the same model choice. Absent matches absent. */
export function sameCueTurnSettings(a: CueTurnSettings, b: CueTurnSettings): boolean {
	const x = cueTurnSettingsOf(a) ?? {};
	const y = cueTurnSettingsOf(b) ?? {};
	return x.tier === y.tier && x.model === y.model && x.effort === y.effort;
}

/**
 * Compact label for a model choice as written in YAML (`tier high, effort low`,
 * `model gpt-5.5-codex`). Empty when none is set. For listings, not for the
 * resolved per-provider value, which only exists at spawn time.
 */
export function formatCueTurnSettings(sub: CueTurnSettings): string {
	const settings = cueTurnSettingsOf(sub);
	if (!settings) return '';
	return [
		settings.model ? `model ${settings.model}` : settings.tier ? `tier ${settings.tier}` : '',
		settings.effort ? `effort ${settings.effort}` : '',
	]
		.filter(Boolean)
		.join(', ');
}

/**
 * An edit to a subscription's model choice. `undefined` leaves an axis alone,
 * `null` clears it back to the agent's own value. `null` rather than
 * `undefined` for "clear" because the patch crosses IPC as JSON, which drops
 * `undefined` keys.
 */
export interface CueTurnSettingsPatch {
	tier?: CueTurnSettings['tier'] | null;
	model?: string | null;
	effort?: CueTurnSettings['effort'] | null;
}

/** Whether a patch asks for any change at all. */
export function hasCueTurnSettingsPatch(patch: CueTurnSettingsPatch | undefined): boolean {
	return (
		!!patch && (patch.tier !== undefined || patch.model !== undefined || patch.effort !== undefined)
	);
}

/**
 * Apply a model-choice patch to a raw subscription record, in place.
 *
 * Tier and exact model are one choice with two spellings, so setting either
 * removes the other: a caller that says `tier: high` on a subscription pinned
 * to a model gets the tier, never a record the validator rejects for carrying
 * both. Returns the reason the patch was refused, or `null` when applied.
 */
export function applyCueTurnSettingsPatch(
	target: Record<string, unknown>,
	patch: CueTurnSettingsPatch
): string | null {
	const model = typeof patch.model === 'string' ? patch.model.trim() : patch.model;
	if (patch.tier && model) return 'set a model tier or an exact model, not both';
	if (patch.tier !== undefined && patch.tier !== null && !asTierLevel(patch.tier)) {
		return `tier must be one of: ${TIER_LEVELS.join(', ')}`;
	}
	if (patch.effort !== undefined && patch.effort !== null && !asTierLevel(patch.effort)) {
		return `effort must be one of: ${TIER_LEVELS.join(', ')}`;
	}
	if (model === '') return 'model needs a model id';

	const setsAny = !!patch.tier || !!model || !!patch.effort;
	if (setsAny && (target.action === 'command' || target.action === 'notify')) {
		return `a model, tier, or effort applies to agent runs, not to an action "${String(target.action)}" subscription`;
	}

	if (patch.tier !== undefined) {
		if (patch.tier === null) delete target.tier;
		else {
			target.tier = patch.tier;
			delete target.model;
		}
	}
	if (model !== undefined) {
		if (model === null) delete target.model;
		else {
			target.model = model;
			delete target.tier;
		}
	}
	if (patch.effort !== undefined) {
		if (patch.effort === null) delete target.effort;
		else target.effort = patch.effort;
	}
	return null;
}

/** A parsed `--tier` / `--model` / `--effort` set, or why it was refused. */
export type CueTurnSettingsInputResult =
	| { ok: true; settings: CueTurnSettings }
	| { ok: false; error: string; code: string };

/**
 * Validate the raw strings a caller typed for tier / model / effort. Shared by
 * every CLI verb that accepts the three flags, so they refuse the same typos
 * with the same words.
 */
export function parseCueTurnSettingsInput(input: {
	tier?: string;
	model?: string;
	effort?: string;
}): CueTurnSettingsInputResult {
	const levels = TIER_LEVELS.join(', ');
	const tier = input.tier !== undefined ? asTierLevel(input.tier.trim().toLowerCase()) : undefined;
	if (input.tier !== undefined && !tier) {
		return { ok: false, error: `--tier must be one of: ${levels}`, code: 'BAD_TIER' };
	}
	const effort =
		input.effort !== undefined ? asTierLevel(input.effort.trim().toLowerCase()) : undefined;
	if (input.effort !== undefined && !effort) {
		return { ok: false, error: `--effort must be one of: ${levels}`, code: 'BAD_EFFORT' };
	}
	const model = input.model?.trim() || undefined;
	if (input.model !== undefined && !model) {
		return { ok: false, error: '--model needs a model id', code: 'BAD_MODEL' };
	}
	if (tier && model) {
		return { ok: false, error: 'pass --tier or --model, not both', code: 'TIER_AND_MODEL' };
	}
	return { ok: true, settings: cueTurnSettingsOf({ tier, model, effort }) ?? {} };
}
