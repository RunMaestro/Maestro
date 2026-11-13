/**
 * The model ONE run picks for itself (the Auto Run dialog's "Model for this
 * run"), across every place a model can run: the provider's own models and
 * every model a Local Models source lists. Plain data, so the rules are
 * testable without a `<select>`.
 *
 * A choice is spelled like a tier target (`formatTierTargetSpec`), because it
 * is one: "the agent's default" (`default`), the provider on the agent's own
 * model (`provider`), a provider model (`provider:<model>`), or a model on a
 * source (`<source id>:<model>`). The options are the tier picker's own
 * (`buildTierTargetOptionGroups`), so a source model reads the same way in
 * both, fit label and "Agent-ready" badge included.
 *
 * What a choice launches ({@link runModelChoiceLaunch}) is the run's model and
 * Run on target, as `BatchRunConfig.model` / `runOn` carry them:
 *
 * - The agent's default, or the agent's own source and model: nothing. The run
 *   takes whatever the agent is set to.
 * - A provider model on an agent that runs on a source: that model, AND the
 *   provider as the run's target. Without the target the launch would replace
 *   the model with the source's (Run on rule 4) and the pick would do nothing.
 * - A source model: that target, with the context the agent already gives it
 *   when it is the agent's own source and model, else what the source reports
 *   (`namedRunOnContextTokens`, the rule `--run-on` follows).
 */

import { getAgentDisplayName } from '../agentMetadata';
import { AUTO_MODEL_LABEL, isAutoModel, ownModel } from '../autoModel';
import { parseTierTargetSpec, TIER_TARGET_DEFAULT_SPEC } from '../modelTiers';
import type { LocalModelEndpoint } from './endpoints';
import type { HardwareProfile } from './model-fit';
import {
	namedRunOnContextTokens,
	parseRunOnTarget,
	RUN_ON_PROVIDER_SPEC,
	runOnTargetLabel,
	type RunOnSourceTarget,
	type RunOnTarget,
} from './run-on';
import {
	reportedRunOnContextTokens,
	type RunOnOptionGroup,
	type RunOnPickerSource,
} from './run-on-picker';
import { buildTierTargetOptionGroups, type HarnessTierOptions } from './tier-options';

/** The spelling of "use whatever the agent is set to": the picker's first option. */
export const RUN_MODEL_DEFAULT_SPEC = TIER_TARGET_DEFAULT_SPEC;

/** The agent a run belongs to, as far as its model is concerned. */
export interface RunModelAgent {
	toolType: string;
	customModel?: string;
	/** The agent's stored Run on target, as data. */
	runOn?: unknown;
}

/** What a run launches on: absent members leave the agent's own value. */
export interface RunModelLaunch {
	model?: string;
	runOn?: RunOnTarget;
}

function agentSource(agent: RunModelAgent): RunOnSourceTarget | undefined {
	const parsed = parseRunOnTarget(agent.runOn);
	return parsed.ok && parsed.target.type === 'source' ? parsed.target : undefined;
}

/** What a choice launches. See the file header for the rules. */
export function runModelChoiceLaunch(
	spec: string,
	agent: RunModelAgent,
	sources: readonly RunOnPickerSource[] = []
): RunModelLaunch {
	const parsed = parseTierTargetSpec(spec);
	if (!parsed.ok || !parsed.target) return {};
	const target = parsed.target;
	const stored = agentSource(agent);

	if (target.type === 'source') {
		if (stored && stored.endpointId === target.endpointId && stored.model === target.model) {
			return {};
		}
		const runOn: RunOnSourceTarget = {
			type: 'source',
			endpointId: target.endpointId,
			model: target.model,
			contextTokens: namedRunOnContextTokens(
				target,
				agent.runOn,
				reportedRunOnContextTokens(sources, target)
			),
		};
		return { model: target.model, runOn };
	}

	// `provider` or `provider:<model>`: the provider, on the named model or the
	// agent's own. On an agent already on its provider that is only a model.
	const model = target.type === 'provider-model' ? target.model : undefined;
	const launchModel = model ?? (stored ? ownModel(agent.customModel) : undefined);
	return {
		...(launchModel ? { model: launchModel } : {}),
		...(stored ? { runOn: { type: 'provider' } } : {}),
	};
}

/** What "the agent's default" is, for the first option's label. */
export function runModelDefaultLabel(
	agent: RunModelAgent,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string {
	const stored = agentSource(agent);
	const value = stored
		? runOnTargetLabel(stored, endpoints)
		: isAutoModel(agent.customModel)
			? AUTO_MODEL_LABEL
			: agent.customModel;
	return value ? `Use agent default (${value})` : 'Use agent default';
}

export interface RunModelChoiceInput {
	agent: RunModelAgent;
	/** What the harness can launch on, from `listHarnessTierOptions`. */
	options: Pick<HarnessTierOptions, 'harness' | 'name' | 'catalog' | 'runOn' | 'sources'>;
	/**
	 * The provider's models as this agent's own discovery lists them (its
	 * account, its host). Used in place of the harness catalogue when given.
	 */
	providerModels?: readonly string[];
	/** The current choice, so one nothing lists still shows (with its reason). */
	spec: string;
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'enabled'>[];
	hardware?: HardwareProfile | null;
}

/**
 * The picker's options: the agent's default, the provider on the agent's own
 * model (only when the agent runs on a source, where it means something else),
 * the provider's models, then each source's models.
 */
export function buildRunModelChoiceGroups(input: RunModelChoiceInput): RunOnOptionGroup[] {
	const { agent } = input;
	const parsed = parseTierTargetSpec(input.spec);
	const stored = agentSource(agent);
	const groups = buildTierTargetOptionGroups({
		options:
			input.providerModels && input.providerModels.length > 0
				? { ...input.options, catalog: input.providerModels.map((id) => ({ id })) }
				: input.options,
		current: parsed.ok ? parsed.target : undefined,
		fallthroughLabel: runModelDefaultLabel(agent, input.endpoints),
		endpoints: input.endpoints,
		hardware: input.hardware,
	});
	const own = ownModel(agent.customModel);
	return groups.map((group) =>
		group.label !== null
			? group
			: {
					...group,
					options: group.options.flatMap((option) => {
						if (option.value !== RUN_ON_PROVIDER_SPEC) return [option];
						// On an agent already on its provider this is the default again.
						if (!stored) return [];
						const name = getAgentDisplayName(agent.toolType);
						return [
							{ ...option, label: own ? `${name} on ${own}` : `${name} on its default model` },
						];
					}),
				}
	);
}

/** Whether the groups offer anything beyond the agent's default. */
export function hasRunModelChoices(groups: readonly RunOnOptionGroup[]): boolean {
	return groups.some((group) =>
		group.options.some((option) => option.value !== RUN_MODEL_DEFAULT_SPEC)
	);
}
