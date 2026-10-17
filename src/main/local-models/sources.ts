/**
 * Where a Local Models call runs: a catalog model on this machine, or a model
 * on one of the user's saved endpoints. Every service (text generation,
 * embeddings, classifiers) takes the same shape, so the task router turns an
 * assignment into a source once for all of them.
 */

import {
	formatLocalModelAssignmentSpec,
	type LocalModelAssignment,
	type LocalModelAssignments,
} from '../../shared/local-models/tasks';
import { getSettingsStore } from '../stores/getters';

export type LocalModelSource =
	| { type: 'local'; modelId: string }
	| { type: 'endpoint'; endpointId: string; model: string };

/** The source an assignment runs on, or null for `off` and `utility-agent`. */
export function sourceForAssignment(assignment: LocalModelAssignment): LocalModelSource | null {
	if (assignment.type === 'local') return { type: 'local', modelId: assignment.modelId };
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
 * The persisted `localModelAssignments` setting, unparsed. The task router and
 * task readiness both resolve it through `resolveLocalModelAssignment`, so they
 * cannot disagree about which source a task is on.
 */
export function readLocalModelAssignments(): LocalModelAssignments | undefined {
	return getSettingsStore().get('localModelAssignments', {}) as LocalModelAssignments | undefined;
}
