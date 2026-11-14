// `maestro-cli models status [task-id]` - whether each Local Models task's
// assigned source would answer now, and if not, why and what to do.
//
// It runs in the desktop over the WS bridge, through the same resolver as the
// `localModels:taskReadiness` IPC channel, so the CLI and the app read the same
// assignment, the same model store, and the same endpoint list. It never runs a
// model; the only network it reaches is one model listing per endpoint a task
// is assigned to.
//
// Exit codes, for scripts:
// - with a task id: 0 only when the task would run (ready, or the Utility
//   Agent path), so `maestro-cli models status semantic-search && ...` guards
//   a dependent step. Off and unavailable exit non-zero.
// - without one: 0 unless an assigned task is unavailable. Most tasks are off
//   by default, so off alone is not a failure there.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { formatLocalModelTaskReadiness } from '../output/formatter';
import { isLocalModelTaskId, LOCAL_MODEL_TASK_IDS } from '../../shared/local-models/tasks';
import {
	isTaskRunnable,
	type LocalModelTaskReadiness,
} from '../../shared/local-models/task-readiness';
import { failCommand, failFromError } from '../services/session-command';

/**
 * Above the app's endpoint list budget (5s), with room for several endpoints
 * listed in parallel, so a slow server comes back as the app's own
 * `endpoint-unreachable` verdict rather than the CLI giving up first.
 */
const STATUS_TIMEOUT_MS = 15_000;

interface StatusOptions {
	json?: boolean;
}

export async function modelsStatus(
	taskId: string | undefined,
	options: StatusOptions
): Promise<void> {
	if (taskId !== undefined && !isLocalModelTaskId(taskId)) {
		failCommand(
			`Unknown task "${taskId}". Tasks: ${LOCAL_MODEL_TASK_IDS.join(', ')}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	let reply: { success: boolean; readiness?: LocalModelTaskReadiness[]; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_task_readiness', ...(taskId ? { taskId } : {}) },
				'local_models_task_readiness_result',
				STATUS_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.readiness) {
		failCommand(reply.error || 'Readiness check failed', options.json);
	}
	const readiness = reply.readiness;
	const ok = taskId
		? readiness.every(isTaskRunnable)
		: readiness.every((row) => row.state !== 'unavailable');

	if (options.json) {
		console.log(JSON.stringify({ success: ok, tasks: readiness }));
	} else {
		console.log(formatLocalModelTaskReadiness(readiness, { single: taskId !== undefined }));
	}
	if (!ok) exitWith(ExitCode.GeneralError);
}
