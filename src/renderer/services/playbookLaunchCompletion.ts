/**
 * Playbook Launch completion in the renderer: telling main that a launched
 * Auto Run has ended.
 *
 * The renderer runs the Auto Run, so it is the one that knows when the run
 * ends (`onComplete` in `useBatchHandlers`). Main does the rest
 * (`completeMarketplaceLaunch()` in `src/main/services/marketplace-service.ts`):
 * it ends the launch record, cleans up the launch folder and broadcasts
 * `marketplace:launchChanged`, which is what opens the outro.
 *
 * Nothing here knows which Auto Run is a launched one. A launch is a record in
 * main, so the renderer asks main whether the agent has a running launch when
 * any Auto Run on it ends, and reports only when it does.
 */

import type {
	PlaybookLaunchCompletion,
	PlaybookLaunchRecord,
} from '../../shared/marketplace-types';
import type { BatchCompleteInfo } from '../hooks/batch/useBatchProcessor';
import { notifyToast } from '../stores/notificationStore';
import { ipcErrorMessage, ipcResultErrorMessage } from '../utils/ipcErrorMessage';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = '[PlaybookLaunchCompletion]';

/**
 * What the report needs of a finished Auto Run: the agent, and the fields of
 * {@link BatchCompleteInfo} that a launch record keeps.
 */
export type LaunchedRunEnd = Pick<
	BatchCompleteInfo,
	'sessionId' | 'completedTasks' | 'totalTasks' | 'elapsedTimeMs' | 'totalCostUsd' | 'wasStopped'
>;

/**
 * The launch that is running on an agent. An agent has at most one: main
 * refuses to start a second while one runs. `undefined` for an ordinary Auto
 * Run, and when main cannot say (the answer is logged, or reported when the call
 * itself failed, and the run is treated as an ordinary one).
 */
async function findRunningLaunch(sessionId: string): Promise<PlaybookLaunchRecord | undefined> {
	try {
		const result = await window.maestro.marketplace.listLaunches({ sessionId });
		if (!result.success) {
			logger.warn(
				`Could not read the launches of ${sessionId}: ${ipcResultErrorMessage(result.error, 'no reason given')}`,
				LOG_CONTEXT
			);
			return undefined;
		}
		return result.launches?.find((launch) => launch.status === 'running');
	} catch (thrown) {
		captureException(thrown, {
			extra: { operation: 'playbookLaunchCompletion:listLaunches', sessionId },
		});
		return undefined;
	}
}

/**
 * Report that an Auto Run has ended, when the run was a Playbook Launch. Main
 * ends the launch record, cleans up the launch folder as the playbook's launch
 * block says, and broadcasts the result, which opens the outro.
 *
 * Call it for every Auto Run that ends, from the window that owns app-wide side
 * effects: an ordinary run has no running launch on its agent and the call does
 * nothing more than ask. It reports a stopped run as well, with `wasStopped`,
 * so the launch ends and its folder is kept for a resume.
 *
 * Resolves `true` when this report ended a launch, so the outro follows, and
 * `false` otherwise: an ordinary Auto Run, a launch main could not end (the
 * person is told, and the failure is reported), or a question main could not
 * answer. It never rejects, so a caller can wait on it without a guard.
 */
export async function reportLaunchedRunCompletion(end: LaunchedRunEnd): Promise<boolean> {
	const launch = await findRunningLaunch(end.sessionId);
	if (!launch) return false;

	const completion: PlaybookLaunchCompletion = {
		completedTasks: end.completedTasks,
		totalTasks: end.totalTasks,
		elapsedTimeMs: end.elapsedTimeMs,
		totalCostUsd: end.totalCostUsd,
		wasStopped: end.wasStopped,
	};

	let error: string;
	try {
		const result = await window.maestro.marketplace.completeLaunch(launch.launchId, completion);
		if (result.success) return true;
		error = ipcResultErrorMessage(result.error, 'no reason given');
	} catch (thrown) {
		captureException(thrown, {
			extra: {
				operation: 'playbookLaunchCompletion:completeLaunch',
				launchId: launch.launchId,
				sessionId: end.sessionId,
			},
		});
		error = ipcErrorMessage(thrown);
	}

	logger.warn(
		`Launch ${launch.launchId} of ${launch.playbookId} ended but main could not complete it: ${error}`,
		LOG_CONTEXT
	);
	notifyToast({
		color: 'red',
		title: 'Playbook launch not completed',
		message: `"${launch.playbookTitle}" has ended, but Maestro could not finish the launch: ${error}`,
		sessionId: end.sessionId,
	});
	return false;
}
