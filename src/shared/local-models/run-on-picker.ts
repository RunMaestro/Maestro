/**
 * The choices an agent's Run on picker offers, as plain data so the rules are
 * testable without rendering a `<select>`.
 *
 * - Provider (default), always.
 * - Every model each source lists: the Maestro model server first, then each
 *   enabled source in the order the user saved them. A model on the Maestro
 *   server is a catalog model, so it carries what the Library says about it:
 *   its fit on this computer, and the "Agent-ready" badge when it passed the
 *   agent qualification with THIS harness. Another source does not report what
 *   a model is, so its models carry neither.
 * - The agent's CURRENT target, even when no source lists it (a source that
 *   was removed or disabled, a model it no longer serves): a `<select>` whose
 *   value matches no option renders its first option, so the picker would read
 *   "Provider" while the launch is refused for a source the user cannot see.
 *
 * Option values are the shared target spelling (`formatRunOnSpec`), the one
 * `maestro-cli` takes.
 */

import type { LocalModelEndpoint } from './endpoints';
import { LOCAL_MODEL_ROLE_LABELS } from './library';
import { getLocalModel } from './model-catalog';
import { MODEL_FIT_LABELS, modelFit, type HardwareProfile, type ModelFit } from './model-fit';
import { MODEL_SERVER_ENDPOINT_ID } from './model-server';
import {
	formatRunOnSpec,
	RUN_ON_PROVIDER_SPEC,
	runOnDefaultContextTokens,
	runOnTargetLabel,
	type RunOnSourceTarget,
	type RunOnTarget,
} from './run-on';
import type { LocalModelAgentHarness } from './types';

/** Shown under the picker for a model that has not passed the agent qualification. */
export const RUN_ON_UNTESTED_WARNING = 'Not tested as an agent. Turns may fail or loop.';

/** The first option: the provider's own cloud model. */
export const RUN_ON_PROVIDER_OPTION_LABEL = 'Provider (default)';

/** One source and the models it lists right now. */
export interface RunOnPickerSource {
	endpointId: string;
	name: string;
	models: readonly string[];
}

export interface RunOnOption {
	/** A target spec, readable by `parseRunOnSpec`. */
	value: string;
	label: string;
}

export interface RunOnOptionGroup {
	/** `null` for the ungrouped head (Provider, and a current target no source lists). */
	label: string | null;
	options: RunOnOption[];
}

/** What the Library knows about one target's model. */
export interface RunOnModelFacts {
	/** The model for a person: the catalog name, or the source's own name for it. */
	displayName: string;
	/** Whether it passed the agent qualification with this harness. */
	qualified: boolean;
	/** Whether it fits this computer. Absent off the Maestro server, or with no hardware profile. */
	fit?: ModelFit;
	/** The context the picker's field starts at. */
	defaultContextTokens: number;
	/** Its size in billions of parameters, when the Library states one. */
	parametersB?: number;
}

/**
 * What the Library says about a target's model for one harness. Only a model on
 * the Maestro model server is a catalog model; any other is named as its source
 * names it, is not qualified, and starts at the smallest agent context.
 */
export function runOnModelFacts(
	toolType: string,
	target: Pick<RunOnSourceTarget, 'endpointId' | 'model'>,
	hardware?: HardwareProfile | null
): RunOnModelFacts {
	const entry =
		target.endpointId === MODEL_SERVER_ENDPOINT_ID ? getLocalModel(target.model) : undefined;
	const defaultContextTokens = runOnDefaultContextTokens(target);
	if (!entry) {
		return { displayName: target.model, qualified: false, defaultContextTokens };
	}
	return {
		displayName: entry.displayName,
		qualified: (entry.agentHarnesses ?? []).includes(toolType as LocalModelAgentHarness),
		...(hardware ? { fit: modelFit(entry, hardware) } : {}),
		defaultContextTokens,
		...(entry.parameters ? { parametersB: entry.parameters.totalB } : {}),
	};
}

function optionLabel(facts: RunOnModelFacts): string {
	const notes = [
		...(facts.fit ? [MODEL_FIT_LABELS[facts.fit.fit]] : []),
		...(facts.qualified ? [LOCAL_MODEL_ROLE_LABELS.agent] : []),
	];
	return notes.length > 0 ? `${facts.displayName} (${notes.join(', ')})` : facts.displayName;
}

/** How a current target no source lists is labeled, so the reason shows in the picker. */
function unlistedLabel(
	target: RunOnSourceTarget,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'enabled'>[]
): string {
	const label = runOnTargetLabel(target, endpoints);
	if (target.endpointId === MODEL_SERVER_ENDPOINT_ID) return `${label} (not installed)`;
	const endpoint = endpoints.find((candidate) => candidate.id === target.endpointId);
	if (!endpoint) return `${label} (source removed)`;
	return `${label} (${endpoint.enabled ? 'not listed' : 'source disabled'})`;
}

export interface RunOnOptionInput {
	/** The agent's provider, e.g. `claude-code`: which qualification a badge reads. */
	toolType: string;
	current: RunOnTarget;
	/** Each source with what it lists, in the order to show them. */
	sources: readonly RunOnPickerSource[];
	/** The saved endpoints, to name a current target whose source lists nothing. */
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'enabled'>[];
	hardware?: HardwareProfile | null;
}

export function buildRunOnOptionGroups(input: RunOnOptionInput): RunOnOptionGroup[] {
	const head: RunOnOption[] = [
		{ value: RUN_ON_PROVIDER_SPEC, label: RUN_ON_PROVIDER_OPTION_LABEL },
	];
	const groups: RunOnOptionGroup[] = [{ label: null, options: head }];

	for (const source of input.sources) {
		const options = source.models.map((model) => {
			const target = { endpointId: source.endpointId, model };
			return {
				value: formatRunOnSpec({ type: 'source', ...target }),
				label: optionLabel(runOnModelFacts(input.toolType, target, input.hardware)),
			};
		});
		if (options.length > 0) groups.push({ label: source.name, options });
	}

	if (input.current.type === 'source') {
		const currentValue = formatRunOnSpec(input.current);
		const covered = groups.some((group) =>
			group.options.some((option) => option.value === currentValue)
		);
		if (!covered) {
			head.push({ value: currentValue, label: unlistedLabel(input.current, input.endpoints) });
		}
	}
	return groups;
}
