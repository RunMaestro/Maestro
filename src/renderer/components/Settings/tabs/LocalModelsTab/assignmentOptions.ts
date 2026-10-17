/**
 * The source choices a task's Assignments picker offers, as plain data so the
 * filtering rules are testable without rendering a `<select>`.
 *
 * A task is offered only sources that can do its job:
 * - Off, always.
 * - Utility Agent, only when the task has an agent path to fall back on.
 * - System One, only when the task declares typed questions for an engine
 *   (`taskAcceptsSystemOne`) and an engine is chosen. Its label names the engine
 *   in force (`systemOneAssignmentLabel`), so a local judge is never read as Jev.
 * - Installed local models of a kind the task accepts (`taskAcceptsLocalKind`),
 *   except one the task records as measured-unfit (`unofferedLocalModels`).
 * - Models of enabled endpoints, only when an endpoint can serve that need
 *   (`endpointServesNeed`). Endpoints do not report a model's kind, so every
 *   listed model is offered and readiness names a wrong pick.
 *
 * A `localFirst` task (model routing) treats System One as one router among
 * several, so its picker reads differently: local models first, in the order
 * they are recommended (an embedding model, then judge text models smallest
 * first, then the other text models), then endpoints, and System One LAST.
 * Every source says which router it is and whether its answer is calibrated
 * (`modelRouterSourceNote`).
 *
 * The task's CURRENT assignment is always present, even when it fits none of
 * the above (a model not downloaded yet, an endpoint that was removed): a
 * `<select>` whose value matches no option renders its first option, so the
 * picker would read "Off" while the stored source is what the task runs on.
 * Option values are the shared assignment spelling
 * (`formatLocalModelAssignmentSpec`), the same one `maestro-cli models assign`
 * takes.
 */

import type { LocalModelListing } from '../../../../../main/local-models/service';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import { getLocalModel } from '../../../../../shared/local-models/model-catalog';
import {
	modelRouterKind,
	modelRouterSourceNote,
} from '../../../../../shared/local-models/model-routing-task';
import {
	systemOneAssignmentLabel,
	type SystemOneEngineChoice,
} from '../../../../../shared/local-models/system-one-settings';
import {
	endpointServesNeed,
	formatLocalModelAssignmentSpec,
	isLocalModelOfferedForTask,
	localModelAssignmentSourceLabel,
	SYSTEM_ONE_ASSIGNMENT,
	taskAcceptsLocalKind,
	taskAcceptsSystemOne,
	type LocalModelAssignment,
	type LocalModelTaskDefinition,
} from '../../../../../shared/local-models/tasks';
import type { EndpointModelsState } from '../../../../hooks/localModels';

export interface AssignmentOption {
	/** An assignment spec, readable by `parseLocalModelAssignmentSpec`. */
	value: string;
	label: string;
}

export interface AssignmentOptionGroup {
	/** `null` for the ungrouped head (Off, Utility Agent). */
	label: string | null;
	options: AssignmentOption[];
}

export interface AssignmentOptionSources {
	listings: readonly LocalModelListing[];
	endpoints: readonly LocalModelEndpoint[];
	/** Per endpoint id, as `useLocalModelEndpoints` reports it. */
	endpointModels: Readonly<Record<string, EndpointModelsState>>;
	/**
	 * The System One engine in force, from `useSystemOne()`. Absent (a surface
	 * that does not read it, or a report still loading) reads as no engine.
	 */
	systemOneEngine?: SystemOneEngineChoice;
}

export const LOCAL_MODELS_GROUP_LABEL = 'Local models';
export const SYSTEM_ONE_GROUP_LABEL = 'System One';

/**
 * Where a catalog model stands in a `localFirst` picker: the task's other
 * kinds first (for model routing, the embedding model: the fastest router),
 * then text models that carry the judge role, then the rest.
 */
function localFirstRank(task: LocalModelTaskDefinition, entry: LocalModelListing['entry']): number {
	if (entry.kind !== task.needs) return 0;
	return entry.roles?.includes('judge') ? 1 : 2;
}

/** A `localFirst` task's installed models in the order they are recommended. */
function recommendedFirst(
	task: LocalModelTaskDefinition,
	listings: readonly LocalModelListing[]
): LocalModelListing[] {
	return [...listings].sort(
		(a, b) =>
			localFirstRank(task, a.entry) - localFirstRank(task, b.entry) || a.entry.bytes - b.entry.bytes
	);
}

/**
 * A source's label with what a `localFirst` picker says beside it: which
 * router the source is, and whether its answer is calibrated.
 */
function withRouterNote(
	label: string,
	assignment: LocalModelAssignment,
	systemOneEngine: SystemOneEngineChoice
): string {
	const kind = modelRouterKind(assignment);
	if (!kind) return label;
	const note = modelRouterSourceNote(kind, systemOneEngine);
	return kind === 'system-one' ? `${label}, ${note}` : `${label} (${note})`;
}

/** The models an endpoint listed, or none while loading or after a failure. */
function listedModelIds(state: EndpointModelsState | undefined): string[] {
	if (!state || !('ok' in state) || !state.ok) return [];
	return state.models.map((model) => model.id);
}

/** How a current assignment no option covers is labeled, so the reason is visible in the picker. */
function unlistedLabel(
	assignment: LocalModelAssignment,
	endpoints: readonly LocalModelEndpoint[],
	installedModelIds: ReadonlySet<string>,
	systemOneEngine: SystemOneEngineChoice
): string {
	const source = localModelAssignmentSourceLabel(assignment, endpoints);
	if (assignment.type === 'local') {
		if (installedModelIds.has(assignment.modelId)) return `${source} (not recommended)`;
		return `${source} (${getLocalModel(assignment.modelId) ? 'not installed' : 'not in catalog'})`;
	}
	if (assignment.type === 'endpoint') {
		const endpoint = endpoints.find((candidate) => candidate.id === assignment.endpointId);
		if (!endpoint) return `${source} (endpoint removed)`;
		return `${source} (${endpoint.enabled ? 'not listed' : 'disabled'})`;
	}
	// System One is offered whenever an engine is chosen, so this is a task left
	// on it after the engine was switched off. The label says so.
	if (assignment.type === 'system-one') return systemOneAssignmentLabel(systemOneEngine);
	// Off and Utility Agent are always offered when they are valid, so this is
	// only reached for a Utility Agent assignment the task does not accept.
	return 'Utility Agent (not available for this task)';
}

export function buildAssignmentOptionGroups(
	task: LocalModelTaskDefinition,
	current: LocalModelAssignment,
	sources: AssignmentOptionSources
): AssignmentOptionGroup[] {
	const localFirst = task.localFirst === true;
	const systemOneEngine = sources.systemOneEngine ?? 'off';
	/** An option for a source, labeled the way this task's picker labels one. */
	const option = (assignment: LocalModelAssignment, label: string): AssignmentOption => ({
		value: formatLocalModelAssignmentSpec(assignment),
		label: localFirst ? withRouterNote(label, assignment, systemOneEngine) : label,
	});

	const head: AssignmentOption[] = [{ value: 'off', label: 'Off' }];
	if (task.allowsUtilityAgent) head.push({ value: 'utility-agent', label: 'Utility Agent' });
	const systemOneOption =
		taskAcceptsSystemOne(task) && systemOneEngine !== 'off'
			? option(SYSTEM_ONE_ASSIGNMENT, systemOneAssignmentLabel(systemOneEngine))
			: null;
	if (systemOneOption && !localFirst) head.push(systemOneOption);
	const groups: AssignmentOptionGroup[] = [{ label: null, options: head }];

	const installed = sources.listings.filter(
		(listing) =>
			taskAcceptsLocalKind(task, listing.entry.kind) && listing.status.status === 'installed'
	);
	const localOptions = (localFirst ? recommendedFirst(task, installed) : installed)
		.filter((listing) => isLocalModelOfferedForTask(task.id, listing.entry.id))
		.map((listing) =>
			option({ type: 'local', modelId: listing.entry.id }, listing.entry.displayName)
		);
	if (localOptions.length > 0) {
		groups.push({ label: LOCAL_MODELS_GROUP_LABEL, options: localOptions });
	}

	if (endpointServesNeed(task.needs)) {
		for (const endpoint of sources.endpoints) {
			if (!endpoint.enabled) continue;
			const options = listedModelIds(sources.endpointModels[endpoint.id]).map((model) =>
				option({ type: 'endpoint', endpointId: endpoint.id, model }, model)
			);
			if (options.length > 0) groups.push({ label: endpoint.name, options });
		}
	}
	// Last for a local-first task: an engine is one option among several there.
	if (systemOneOption && localFirst) {
		groups.push({ label: SYSTEM_ONE_GROUP_LABEL, options: [systemOneOption] });
	}

	const currentValue = formatLocalModelAssignmentSpec(current);
	const covered = groups.some((group) =>
		group.options.some((option) => option.value === currentValue)
	);
	if (!covered) {
		const installedIds = new Set(installed.map((listing) => listing.entry.id));
		head.push({
			value: currentValue,
			label: unlistedLabel(current, sources.endpoints, installedIds, systemOneEngine),
		});
	}
	return groups;
}
