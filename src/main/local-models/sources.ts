/**
 * Where a Local Models call runs: a catalog model on this machine, or a model
 * on one of the user's saved endpoints. Every service (text generation,
 * embeddings, classifiers) takes the same shape, so the task router turns an
 * assignment into a source once for all of them.
 */

import {
	formatLocalModelAssignmentSpec,
	inheritsProviderWithoutAgentPath,
	resolveLocalModelAssignments,
	type LocalModelAssignment,
	type LocalModelAssignments,
	type LocalModelTaskId,
} from '../../shared/local-models/tasks';
import {
	readModelMap,
	type ModelMap,
	type ModelMapRole,
} from '../../shared/local-models/model-map';
import { getSettingsStore } from '../stores/getters';
import type { SettingsStoreInterface } from '../stores/types';

export type LocalModelSource =
	| { type: 'local'; modelId: string; language?: string }
	| { type: 'endpoint'; endpointId: string; model: string };

/** The source an assignment runs on, or null for `off`, `system-one` and a Model Map slot left on a provider. */
export function sourceForAssignment(assignment: LocalModelAssignment): LocalModelSource | null {
	if (assignment.type === 'local') return { ...assignment };
	if (assignment.type === 'endpoint') {
		return { type: 'endpoint', endpointId: assignment.endpointId, model: assignment.model };
	}
	return null;
}

/**
 * A source as one string: `local:<id>` or `endpoint:<id>:<model>`, the same
 * spelling the assignments picker and `maestro-cli models assign` use.
 *
 * It is the embedding index's `model_id`. A bare model name would not do: the
 * same name served by two endpoints, or by an endpoint and the local catalog,
 * is two different vector spaces, and rows from both under one key would be
 * compared as if they were one.
 */
export function localModelSourceKey(source: LocalModelSource): string {
	return formatLocalModelAssignmentSpec(source);
}

/**
 * A settings store as the getter the shared readers take (`readModelMap`,
 * `resolveTaskProvider`). Defaults to the app's store; a handler passes its
 * injected one so its tests drive the same reads.
 */
export function settingsReader(store: object = getSettingsStore()): (key: string) => unknown {
	const settings = store as SettingsStoreInterface;
	return (key) => settings.get(key);
}

/** The Model Map in force, including the migration from the old Utility source. */
export function readStoredModelMap(): ModelMap {
	return readModelMap(settingsReader());
}

/**
 * Effective assignments, with each Model Map slot a task inherits resolved.
 * Both execution and readiness read this so an inherited source is checked
 * and run alike.
 */
export function readLocalModelAssignments(): LocalModelAssignments | undefined {
	return resolveLocalModelAssignments(
		getSettingsStore().get('localModelAssignments', {}) as LocalModelAssignments | undefined,
		readStoredModelMap()
	);
}

/**
 * The Model Map slot a task is off because of: a provider it cannot run on. Reads the STORED choice, which
 * {@link readLocalModelAssignments} has already resolved away.
 */
export function readInheritsProviderWithoutAgentPath(
	taskId: LocalModelTaskId
): ModelMapRole | null {
	return inheritsProviderWithoutAgentPath(
		getSettingsStore().get('localModelAssignments', {}) as LocalModelAssignments | undefined,
		taskId,
		readStoredModelMap()
	);
}
