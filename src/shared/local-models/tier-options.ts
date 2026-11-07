/**
 * What a harness can run on this machine, and the choices a tier picker offers
 * from it, as plain data so the rules are testable without a `<select>`.
 *
 * `HarnessTierOptions` is the wire record the main process answers with
 * (`listHarnessTierOptions` in `main/local-models/tier-options.ts`), to the
 * Tier defaults table over IPC and to `maestro-cli models tiers` over the
 * bridge. Suggest (`suggestHarnessTierDefaults`) and the stale check
 * (`staleTierModels`) read the same record, so the table, the CLI and the
 * warning cannot disagree about what a harness lists.
 *
 * A tier picker offers, in order:
 *
 * - the next layer down ("Built-in (haiku)", or "Harness default (...)" on an
 *   agent), which is the absence of a target;
 * - the provider on the agent's own model;
 * - every model in the harness's own catalogue;
 * - for a harness with a Run on recipe, every model each source lists, from the
 *   Run on picker's own builder, so a model carries the same fit label and
 *   "Agent-ready" badge in both pickers;
 * - the CURRENT target when nothing lists it, labeled with the reason, because
 *   a `<select>` whose value matches no option shows its first option.
 *
 * Option values are the shared target spelling (`formatTierTargetSpec`), the
 * one `maestro-cli models tiers set` takes.
 */

import type { AgentId } from '../agentIds';
import {
	formatTierTargetSpec,
	TIER_AGENT_MODEL_LABEL,
	TIER_NOT_MAPPED_LABEL,
	TIER_TARGET_DEFAULT_SPEC,
	TIER_TARGET_SOURCE_LABELS,
	tierTargetLabel,
	type AgentTierRow,
	type HarnessCatalogModel,
	type TierTarget,
} from '../modelTiers';
import type { LocalModelEndpoint } from './endpoints';
import type { HardwareProfile } from './model-fit';
import { RUN_ON_PROVIDER_SPEC } from './run-on';
import {
	buildRunOnOptionGroups,
	type RunOnOption,
	type RunOnOptionGroup,
	type RunOnPickerSource,
} from './run-on-picker';

/** A source that could not be asked what it serves, with the reason. */
export interface TierSourceProblem {
	endpointId: string;
	name: string;
	message: string;
}

/** Everything one harness can launch a tier on, on this machine. */
export interface HarnessTierOptions {
	harness: AgentId;
	/** The harness for a person, e.g. "Claude Code". */
	name: string;
	/** Whether the harness was found on this machine. */
	installed: boolean;
	/** The harness's own catalogue. Empty when it lists nothing. */
	catalog: HarnessCatalogModel[];
	/** Whether the harness can run on a source, and the reason when it cannot. */
	runOn: { supported: true } | { supported: false; reason: string };
	/** Each source that lists a model. Empty for a harness with no Run on recipe. */
	sources: RunOnPickerSource[];
	/** Sources that could not be listed, so a missing model has a reason. */
	problems: TierSourceProblem[];
}

export interface TierTargetOptionInput {
	options: Pick<HarnessTierOptions, 'harness' | 'name' | 'catalog' | 'runOn' | 'sources'>;
	/** The tier's own target in the layer being edited, or none. */
	current: TierTarget | undefined;
	/** What the tier falls through to when it has no target, for the first option's label. */
	fallthroughLabel: string;
	/** The saved endpoints, to name a current source target nothing lists. */
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'enabled'>[];
	hardware?: HardwareProfile | null;
}

/** The choices one tier's picker offers. See the file header for the order. */
export function buildTierTargetOptionGroups(input: TierTargetOptionInput): RunOnOptionGroup[] {
	const { options, current } = input;
	const head: RunOnOption[] = [
		{ value: TIER_TARGET_DEFAULT_SPEC, label: input.fallthroughLabel },
		{ value: RUN_ON_PROVIDER_SPEC, label: TIER_AGENT_MODEL_LABEL },
	];
	const groups: RunOnOptionGroup[] = [{ label: null, options: head }];

	if (options.catalog.length > 0) {
		groups.push({
			label: `${options.name} models`,
			options: options.catalog.map((model) => ({
				value: formatTierTargetSpec({ type: 'provider-model', model: model.id }),
				label: model.id,
			})),
		});
	}

	// The Run on picker's own groups, so the two pickers label a model alike.
	// Its head holds "Provider (default)", which a tier spells differently, and
	// the current source target when no source lists it.
	const runOnGroups = buildRunOnOptionGroups({
		toolType: options.harness,
		current: current?.type === 'source' ? current : { type: 'provider' },
		sources: options.runOn.supported ? options.sources : [],
		endpoints: input.endpoints,
		hardware: input.hardware,
	});
	for (const group of runOnGroups) {
		if (group.label !== null) groups.push(group);
		else head.push(...group.options.filter((option) => option.value !== RUN_ON_PROVIDER_SPEC));
	}

	if (current?.type === 'provider-model' && current.model) {
		const value = formatTierTargetSpec(current);
		const covered = groups.some((group) => group.options.some((option) => option.value === value));
		if (!covered) {
			head.push({
				value,
				label:
					options.catalog.length > 0 ? `${current.model} (not in the catalogue)` : current.model,
			});
		}
	}
	return groups;
}

/**
 * The first choice of an AGENT's tier picker: what the tier follows when the
 * agent sets no target of its own, with the value the layers below give it
 * ("Harness default (haiku)"). `fallthrough` is the tier's row for the agent
 * with no tier of its own (`agentTierRows`), so the label names what a launch
 * would use. The layer that value comes from is the badge beside the picker.
 */
export function agentTierFallthroughLabel(
	fallthrough: Pick<AgentTierRow, 'target' | 'problem'>,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[] = []
): string {
	const value = fallthrough.target
		? tierTargetLabel(fallthrough.target, endpoints)
		: fallthrough.problem
			? 'cannot be used'
			: TIER_NOT_MAPPED_LABEL.toLowerCase();
	return `${TIER_TARGET_SOURCE_LABELS['harness-default']} (${value})`;
}
