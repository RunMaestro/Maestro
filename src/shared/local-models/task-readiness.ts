/**
 * Local Models task readiness - the shape `resolveTaskReadiness()` produces.
 *
 * One question per task: if this task ran now, would its assigned source
 * answer, and if not, exactly why and what to do about it. It lives in
 * `shared/` because the answer travels: the `localModels:taskReadiness` IPC
 * channel, the CLI's `maestro-cli models status`, and (later) the Local Models
 * settings panel all render the same structure, so none of them re-derives
 * "is this task usable" from a different set of facts.
 *
 * The resolver is main-process only (`src/main/local-models/task-readiness.ts`)
 * because deciding readiness means reading disk and reaching endpoints.
 *
 * A Cappella has its own readiness (`src/shared/acappella/readiness.ts`) because
 * a voice session is several slots with a microphone in front; this one is a
 * single assignment per task. Both follow the same rule: a verdict names the
 * source that was ASKED for, and never resolves to a different one.
 */

import type { NativeRuntimeId } from './native-runtimes';
import type { LocalModelAssignment, LocalModelTaskId, LocalModelTaskNeed } from './tasks';

/**
 * Where a task stands.
 *
 * - `ready`         - the assigned local model or endpoint should answer, or
 *                     the System One engine in force is set up to.
 * - `utility-agent` - the task runs on its existing agent path; nothing here
 *                     to check (the router never spawns that agent).
 * - `off`           - the task is switched off. Not a fault.
 * - `unavailable`   - the assigned source cannot run; `reason` says why.
 */
export type LocalModelTaskReadinessState = 'ready' | 'utility-agent' | 'off' | 'unavailable';

/**
 * Why an assigned source cannot run. Closed on purpose, and an array so the
 * resolver's test can assert every one is produced with a recovery: a reason
 * shipped without a `suggestedAction` reaches a person as a dead end.
 */
export const LOCAL_MODEL_TASK_UNREADY_REASONS = [
	// The assigned model id is not in this build's catalog.
	'model-unknown',
	// The model is in the catalog but is the wrong kind for the task.
	'model-wrong-kind',
	'model-language-unsupported',
	'model-pending',
	'model-not-installed',
	'model-corrupt',
	// The native runtime the model needs will not load here.
	'runtime-unavailable',
	// No saved endpoint has the assigned id.
	'endpoint-unknown',
	'endpoint-disabled',
	// The task's need is not something an endpoint serves (classifiers, speech synthesis).
	'endpoint-unsupported',
	// The endpoint names an API key variable that is not set.
	'endpoint-key-missing',
	// The server answered 401 or 403.
	'endpoint-rejected',
	// The server could not be reached, timed out, or answered badly.
	'endpoint-unreachable',
	// The server answered but does not list the assigned model.
	'endpoint-model-missing',
	// The task is assigned to System One and no engine is chosen.
	'system-one-off',
	// The System One engine in force cannot answer as it is set up (no key, no
	// URL, no model for the local judge).
	'system-one-not-ready',
] as const;

export type LocalModelTaskUnreadyReason = (typeof LOCAL_MODEL_TASK_UNREADY_REASONS)[number];

export interface LocalModelTaskReadiness {
	taskId: LocalModelTaskId;
	/** The task's label, so a renderer needs no second lookup. */
	label: string;
	needs: LocalModelTaskNeed;
	/** The effective assignment that was checked (stored, or the task default). */
	assignment: LocalModelAssignment;
	state: LocalModelTaskReadinessState;
	/** Present only when `state` is `unavailable`. */
	reason?: LocalModelTaskUnreadyReason;
	/** One sentence: what the task runs on, or what is missing. */
	detail: string;
	/** What the user can do. Present for `off` and `unavailable`. */
	suggestedAction?: string;
	/** The native runtime a local assignment needs. */
	runtimeId?: NativeRuntimeId;
}

/**
 * Whether a call to this task would reach a source right now. `off` is not
 * runnable; `utility-agent` is, on the caller's own path.
 */
export function isTaskRunnable(readiness: Pick<LocalModelTaskReadiness, 'state'>): boolean {
	return readiness.state === 'ready' || readiness.state === 'utility-agent';
}
