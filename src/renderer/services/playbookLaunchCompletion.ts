/**
 * Playbook Launch completion in the renderer, in both directions: telling main
 * that a launched Auto Run has ended, and showing the person the result when
 * main says the launch is over.
 *
 * The renderer runs the Auto Run, so it is the one that knows when the run
 * ends (`onComplete` in `useBatchHandlers`). Main does the rest
 * (`completeMarketplaceLaunch()` in `src/main/services/marketplace-service.ts`):
 * it ends the launch record, cleans up the launch folder and broadcasts
 * `marketplace:launchChanged`. {@link announceLaunchEnd} answers that
 * broadcast, from the window that owns app-wide side effects.
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
import { getModalActions, useModalStore } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
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

/**
 * Where the end of a launch is shown.
 *
 * - `open`: the outro opens now, because the run's agent is the one on screen and the result
 *   belongs to what the person is looking at.
 * - `toast`: a toast whose click opens the outro. The person is on another agent, or is reading
 *   another outro, and a dialog must not take that over.
 * - `ignore`: the record did not end. The broadcast reports any change to a launch record.
 */
export type LaunchEndPresentation = 'open' | 'toast' | 'ignore';

/** What this window is showing when a launch ends. */
export interface LaunchEndContext {
	/** The agent this window has selected; blank when there is none. */
	activeSessionId: string;
	/** An outro is already open. */
	outroOpen: boolean;
}

/**
 * Decide how the end of a launch reaches the person. Pure: {@link announceLaunchEnd} reads the
 * window and acts on the answer.
 */
export function presentLaunchEnd(
	launch: Pick<PlaybookLaunchRecord, 'status' | 'sessionId'>,
	context: LaunchEndContext
): LaunchEndPresentation {
	if (launch.status !== 'completed' && launch.status !== 'stopped') return 'ignore';
	return launch.sessionId === context.activeSessionId && !context.outroOpen ? 'open' : 'toast';
}

/**
 * A toast for a launch that ended out of the person's sight. It names the agent, and a click goes
 * to that agent and opens the outro (`open-playbook-outro`). The click is data, so the entry in the
 * notification center keeps it.
 */
function toastLaunchEnd(launch: PlaybookLaunchRecord): void {
	const name = selectSessionById(launch.sessionId)(useSessionStore.getState())?.name;
	const where = name ? ` on "${name}"` : '';
	const stopped = launch.status === 'stopped';
	notifyToast({
		color: stopped ? 'yellow' : 'green',
		title: stopped ? 'Playbook stopped' : 'Playbook finished',
		message: stopped
			? `"${launch.playbookTitle}" was stopped${where}. Click to see where it left off.`
			: `"${launch.playbookTitle}" finished${where}. Click to see what it did and what to do next.`,
		project: name,
		sessionId: launch.sessionId,
		clickAction: {
			kind: 'open-playbook-outro',
			sessionId: launch.sessionId,
			launchId: launch.launchId,
		},
	});
}

/**
 * Show the person that a launch is over: the outro when the run's agent is on screen, else a toast
 * that opens it. Call it with each record main broadcasts on `marketplace:launchChanged`, from the
 * window that owns app-wide side effects (`useLaunchEndAnnouncement`). Never moves the person: it
 * does not switch agents, and it does not replace an outro that is already open.
 */
export function announceLaunchEnd(launch: PlaybookLaunchRecord): void {
	const presentation = presentLaunchEnd(launch, {
		activeSessionId: useSessionStore.getState().activeSessionId,
		outroOpen: useModalStore.getState().isOpen('playbookOutro'),
	});
	if (presentation === 'open') {
		getModalActions().openPlaybookOutro(launch);
	} else if (presentation === 'toast') {
		toastLaunchEnd(launch);
	}
}

/**
 * Open the outro of a launch that ended, by id: what a click on {@link announceLaunchEnd}'s toast
 * does. The toast carries the id and not the record, so a notification restored after a reload
 * opens the same outro, read from main (`marketplace:getLaunch`).
 *
 * Resolves `true` when the outro opened. A record main cannot give is told to the person with a
 * toast, and a rejected call is also reported. It never rejects.
 */
export async function openLaunchOutro(launchId: string): Promise<boolean> {
	let reason: string;
	try {
		const result = await window.maestro.marketplace.getLaunch(launchId);
		if (result.success && result.launch) {
			getModalActions().openPlaybookOutro(result.launch);
			return true;
		}
		reason = ipcResultErrorMessage(result.error, 'no reason given');
	} catch (thrown) {
		captureException(thrown, {
			extra: { operation: 'playbookLaunchCompletion:getLaunch', launchId },
		});
		reason = ipcErrorMessage(thrown);
	}
	logger.warn(`The outro of launch ${launchId} was not opened: ${reason}`, LOG_CONTEXT);
	notifyToast({
		color: 'yellow',
		title: 'Playbook outro not available',
		message: `Maestro could not read the launch record: ${reason}`,
	});
	return false;
}
