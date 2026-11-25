/**
 * Carry running Auto Runs across an app quit: an update restart, or a normal
 * quit the user confirmed with a run going.
 *
 * Before the app quits, `saveAutoRunsForRestart` writes
 * each run this client owns to main (`autorun:saveRestartResume`). On the next
 * launch, `resumeAutoRunsAfterRestart` takes the saved runs and starts each one
 * again at the place it stopped. The format and its rules are in
 * `src/shared/autorunRestartResume.ts`.
 *
 * The batch store knows where a run is (document index, loop pass, goal
 * iteration) but not how it was launched, so the runners report their launch
 * config and active working copy here. That registry is module scope and
 * dies with the renderer on purpose: it only has to live until the quit.
 *
 * The task in flight at the quit is not finished: its box is still unchecked,
 * so the resumed run picks it up again from the top. That is the same contract
 * as a resume after an agent error.
 */

import type { BatchRunConfig } from '../types';
import { useBatchStore } from '../stores/batchStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { logger } from '../utils/logger';
import {
	isRestartEntryFresh,
	remainingGoalIterations,
	type AutoRunRestartEntry,
	type AutoRunRestartReason,
} from '../../shared/autorunRestartResume';

const LOG_CONTEXT = '[AutoRunRestartResume]';

interface TrackedLaunch {
	/** Launch config without any resume point it was started from. */
	config: BatchRunConfig;
	folderPath: string;
	/** Working copy of the reset-on-completion document now being processed. */
	workingCopy?: { documentIndex: number; loopIteration: number; path: string };
}

const launches = new Map<string, TrackedLaunch>();

/** Called by a runner once it has claimed the agent and is about to start. */
export function trackAutoRunLaunch(
	sessionId: string,
	config: BatchRunConfig,
	folderPath: string
): void {
	const { resumeFrom: _resumeFrom, ...launchConfig } = config;
	launches.set(sessionId, { config: launchConfig, folderPath });
}

/** Called by the document runner when it starts work in a working copy. */
export function noteAutoRunWorkingCopy(
	sessionId: string,
	documentIndex: number,
	loopIteration: number,
	path: string
): void {
	const launch = launches.get(sessionId);
	if (launch) launch.workingCopy = { documentIndex, loopIteration, path };
}

/** Called by a runner when its run ends, however it ends. */
export function untrackAutoRunLaunch(sessionId: string): void {
	launches.delete(sessionId);
}

/**
 * Agents whose Auto Run would resume after a restart: running here (not a
 * mirror of another client's run), not already stopping, and launched through
 * a runner that reported its config.
 */
export function selectResumableAutoRunIds(
	batchRunStates: ReturnType<typeof useBatchStore.getState>['batchRunStates']
): string[] {
	return Object.entries(batchRunStates)
		.filter(
			([sessionId, state]) =>
				state.isRunning && !state.isStopping && !state.mirrored && launches.has(sessionId)
		)
		.map(([sessionId]) => sessionId);
}

/** Build the entries for every resumable run. Exported for tests. */
export function buildRestartEntries(
	reason: AutoRunRestartReason,
	now: number = Date.now()
): AutoRunRestartEntry<BatchRunConfig>[] {
	const { batchRunStates } = useBatchStore.getState();
	const sessionState = useSessionStore.getState();
	const entries: AutoRunRestartEntry<BatchRunConfig>[] = [];

	for (const sessionId of selectResumableAutoRunIds(batchRunStates)) {
		const state = batchRunStates[sessionId];
		const launch = launches.get(sessionId)!;
		const lastDocumentIndex = Math.max(0, launch.config.documents.length - 1);
		const documentIndex = Math.min(Math.max(0, state.currentDocumentIndex || 0), lastDocumentIndex);
		const loopIteration = Math.max(0, state.loopIteration || 0);
		const workingCopy = launch.workingCopy;
		const workingCopyPath =
			workingCopy &&
			workingCopy.documentIndex === documentIndex &&
			workingCopy.loopIteration === loopIteration
				? workingCopy.path
				: undefined;
		const sessionName = selectSessionById(sessionId)(sessionState)?.name;

		entries.push({
			sessionId,
			...(sessionName && { sessionName }),
			folderPath: launch.folderPath,
			config: launch.config,
			resumeFrom: { documentIndex, loopIteration, ...(workingCopyPath && { workingCopyPath }) },
			...(state.goalMode && {
				// `goalIteration` is the 1-based iteration in flight, which did not finish.
				goalIterationsCompleted: Math.max(0, (state.goalIteration ?? 1) - 1),
			}),
			reason,
			savedAt: now,
		});
	}
	return entries;
}

/**
 * Save every resumable run so the next launch continues it. Resolves to the
 * number saved. Rejects when the save fails, so the caller can keep the app
 * running instead of restarting into a run that will not come back.
 */
export async function saveAutoRunsForRestart(reason: AutoRunRestartReason): Promise<number> {
	const entries = buildRestartEntries(reason);
	if (entries.length === 0) return 0;
	const saved = await window.maestro.autorun.saveRestartResume(entries);
	logger.info(`${LOG_CONTEXT} Saved Auto Runs for restart`, undefined, {
		reason,
		sessionIds: entries.map((e) => e.sessionId),
	});
	return saved;
}

/** The config a saved run is launched with on the next start. */
export function buildResumedConfig(entry: AutoRunRestartEntry<BatchRunConfig>): BatchRunConfig {
	const { config } = entry;
	if (config.goalConfig) {
		return {
			...config,
			goalConfig: {
				...config.goalConfig,
				maxIterations: remainingGoalIterations(
					config.goalConfig.maxIterations,
					entry.goalIterationsCompleted ?? 0
				),
			},
		};
	}
	return { ...config, resumeFrom: entry.resumeFrom };
}

type StartBatchRun = (
	sessionId: string,
	config: BatchRunConfig,
	folderPath: string
) => Promise<void>;

/**
 * Take the runs saved by the previous launch and start them again. Resolves to
 * the number started. Runs that cannot resume (stale entry, agent deleted,
 * agent already running Auto Run) are skipped and named in a toast.
 */
export async function resumeAutoRunsAfterRestart(
	startBatchRun: StartBatchRun,
	now: number = Date.now()
): Promise<number> {
	const entries =
		(await window.maestro.autorun.takeRestartResume()) as AutoRunRestartEntry<BatchRunConfig>[];
	if (entries.length === 0) return 0;

	const resumed: string[] = [];
	const skipped: string[] = [];

	for (const entry of entries) {
		const label = entry.sessionName || entry.sessionId;
		if (!isRestartEntryFresh(entry, now)) {
			logger.warn(`${LOG_CONTEXT} Dropping stale saved Auto Run`, undefined, {
				sessionId: entry.sessionId,
				savedAt: entry.savedAt,
			});
			continue;
		}
		const session = selectSessionById(entry.sessionId)(useSessionStore.getState());
		if (!session || useBatchStore.getState().batchRunStates[entry.sessionId]?.isRunning) {
			skipped.push(label);
			continue;
		}

		resumed.push(session.name || label);
		// startBatchRun resolves when the RUN ends, so it is never awaited here.
		void startBatchRun(entry.sessionId, buildResumedConfig(entry), entry.folderPath).catch(
			(error: unknown) => {
				logger.error(`${LOG_CONTEXT} Resumed Auto Run failed to start`, undefined, {
					sessionId: entry.sessionId,
					error: String(error),
				});
			}
		);
	}

	if (resumed.length > 0) {
		notifyToast({
			type: 'success',
			title: resumed.length === 1 ? 'Auto Run Resumed' : `${resumed.length} Auto Runs Resumed`,
			message: `Picked up where Maestro left off before it quit: ${resumed.join(', ')}`,
		});
	}
	if (skipped.length > 0) {
		notifyToast({
			type: 'warning',
			title: 'Auto Run Not Resumed',
			message: `Could not continue after the restart: ${skipped.join(', ')}`,
			dismissible: true,
		});
	}
	return resumed.length;
}

/** Test seam: forget every tracked launch. */
export function resetAutoRunRestartTrackingForTests(): void {
	launches.clear();
}
