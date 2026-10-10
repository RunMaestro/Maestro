/**
 * useAutoRunReclaim - pick an Auto Run back up after this page reloads.
 *
 * Auto Run is renderer-owned: the loop is a live async closure in the page that
 * pressed Go, and "task finished, start the next one" is an exit listener that
 * page registered. A reload destroys all of it while main keeps the spawned task
 * running, so the task finishes and nothing starts the next one (#1470). On a
 * web-desktop browser tab this is common, not rare: a backgrounded tab is
 * routinely discarded and reloaded when the user comes back to it.
 *
 * Main survives the reload, and it records who started each run and with what
 * config (`claimAutoRunStart`'s owner). On load, a page that IS a reload of the
 * same tab (`isReloadedClientInstance`) asks main for the runs that tab owned,
 * waits for the orphaned task to finish, and starts each run again from the
 * same config. Task progress is durable - finished tasks are checked off in the
 * documents - so the restarted loop continues where the old one stopped.
 *
 * Only the owning tab can reclaim, which is what keeps this from double-spawning
 * tasks: a run started by the desktop app or another browser tab is never handed
 * to this page, however dead it looks from here. Main also cancels a reclaim the
 * moment the original loop publishes again, so an owner that was not actually
 * gone keeps its run.
 */

import { useEffect } from 'react';
import type { BatchRunConfig } from '../../types';
import type { AutoRunBroadcastState, OrphanedAutoRun } from '../../../shared/autoRunBroadcast';
import { useBatchStore } from '../../stores/batchStore';
import { notifyToast } from '../../stores/notificationStore';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getClientInstanceId, isReloadedClientInstance } from '../../utils/clientInstance';
import { useStableCallback } from '../utils/useStableCallback';

export type ReclaimedAutoRun = OrphanedAutoRun<Partial<AutoRunBroadcastState>, BatchRunConfig>;

type StartBatchRun = (sessionId: string, config: BatchRunConfig, folderPath: string) => unknown;

export type AutoRunResumePlan =
	| { kind: 'resume'; config: BatchRunConfig }
	| { kind: 'abandon'; reason: string };

/** How often to check whether the orphaned task has finished. */
const ORPHAN_EXIT_POLL_MS = 5_000;

/**
 * Decide whether an orphaned run should be restarted, and with what config.
 * Pure; exported for tests.
 *
 * A run the user had asked to stop, or one paused waiting on the user, is not
 * restarted: either would turn a reload into the run doing something the user
 * did not ask for. Loop and iteration limits are reduced by what the dead loop
 * had already used, so a reload does not buy the run extra passes.
 */
export function planAutoRunResume(run: ReclaimedAutoRun): AutoRunResumePlan {
	const { config, state } = run;
	if (!config || !Array.isArray(config.documents)) {
		return { kind: 'abandon', reason: 'its configuration could not be recovered' };
	}
	if (state?.isStopping) {
		return { kind: 'abandon', reason: 'it was already stopping' };
	}
	if (state?.errorPaused) {
		return { kind: 'abandon', reason: 'it was paused on an error waiting for you' };
	}

	if (config.goalConfig) {
		const { maxIterations } = config.goalConfig;
		if (maxIterations === null || maxIterations === undefined) return { kind: 'resume', config };
		const remaining = maxIterations - (state?.goalIteration ?? 0);
		if (remaining <= 0) {
			return { kind: 'abandon', reason: 'it had reached its iteration limit' };
		}
		return {
			kind: 'resume',
			config: { ...config, goalConfig: { ...config.goalConfig, maxIterations: remaining } },
		};
	}

	if (config.documents.length === 0) {
		return { kind: 'abandon', reason: 'it had no documents' };
	}
	if (config.loopEnabled && config.maxLoops !== null && config.maxLoops !== undefined) {
		// `loopIteration` is the 0-based pass the dead loop was on, and that pass
		// is not finished: its unchecked tasks are what the restart picks up.
		const remaining = Math.max(1, config.maxLoops - (state?.loopIteration ?? 0));
		return { kind: 'resume', config: { ...config, maxLoops: remaining } };
	}
	return { kind: 'resume', config };
}

/**
 * Resolve once main has no Auto Run task process left for this agent. The
 * orphaned task is still writing to the working tree; starting the next one
 * beside it is exactly the double-spawn this must not cause. A failed probe is
 * "could not find out", so it waits and asks again rather than proceeding.
 * Exported for tests.
 */
export async function waitForOrphanedTaskExit(
	agentId: string,
	pollMs: number = ORPHAN_EXIT_POLL_MS
): Promise<void> {
	const prefix = `${agentId}-batch-`;
	for (;;) {
		try {
			const active = await window.maestro.process.getActiveProcesses({
				includeChildProcesses: false,
			});
			const stillRunning = (active ?? []).some(
				(entry: { sessionId?: unknown }) =>
					typeof entry?.sessionId === 'string' && entry.sessionId.startsWith(prefix)
			);
			if (!stillRunning) return;
		} catch {
			// could not find out - wait and ask again
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/**
 * The reloaded page was replayed the dead loop's last state as a read-only
 * mirror, and `startBatchRun` refuses to start over a mirror. This page is the
 * owner, so the mirror goes.
 */
function dropMirror(agentId: string): void {
	useBatchStore.getState().setBatchRunStates((prev) => {
		if (prev[agentId]?.mirrored !== true) return prev;
		const next = { ...prev };
		delete next[agentId];
		return next;
	});
}

async function resumeOrphanedRun(
	run: ReclaimedAutoRun,
	instanceId: string,
	startBatchRun: StartBatchRun
): Promise<void> {
	const session = selectSessionById(run.agentId)(useSessionStore.getState());
	let plan = planAutoRunResume(run);
	if (plan.kind === 'resume' && !session) {
		plan = { kind: 'abandon', reason: 'its agent no longer exists' };
	}
	if (plan.kind === 'resume' && useSettingsStore.getState().autoRunDisabled) {
		plan = { kind: 'abandon', reason: 'Auto Run is disabled in Settings' };
	}

	if (plan.kind === 'abandon') {
		window.maestro.logger.log('info', 'Not resuming Auto Run after reload', 'BatchProcessor', {
			sessionId: run.agentId,
			reason: plan.reason,
		});
		try {
			if (await window.maestro.web.abandonAutoRunReclaim(run.agentId, instanceId)) {
				// Every other client is still mirroring the dead loop's last frame.
				// Publishing the clear is what takes the run off their screens.
				await window.maestro.web.broadcastAutoRunState(run.agentId, null);
			}
		} catch (error) {
			window.maestro.logger.log('error', 'Failed to release Auto Run', 'BatchProcessor', {
				sessionId: run.agentId,
				error: String(error),
			});
		}
		dropMirror(run.agentId);
		notifyToast({
			color: 'yellow',
			title: 'Auto Run Not Resumed',
			message: `The page reloaded during an Auto Run, and it was not resumed because ${plan.reason}. Start it again to continue.`,
			project: session?.name,
			sessionId: session ? run.agentId : undefined,
		});
		return;
	}

	window.maestro.logger.log('info', 'Resuming Auto Run after reload', 'BatchProcessor', {
		sessionId: run.agentId,
		folderPath: run.folderPath,
	});
	notifyToast({
		color: 'theme',
		title: 'Resuming Auto Run',
		message:
			'The page reloaded during an Auto Run. It will continue once the task in progress finishes.',
		project: session?.name,
		sessionId: run.agentId,
	});

	await waitForOrphanedTaskExit(run.agentId);
	dropMirror(run.agentId);
	await startBatchRun(run.agentId, plan.config, run.folderPath);
}

/**
 * Ask main for the runs this tab left running before it reloaded, and resume
 * each. Exported for tests.
 */
export async function reclaimOrphanedAutoRuns(startBatchRun: StartBatchRun): Promise<void> {
	const instanceId = getClientInstanceId();
	let runs: ReclaimedAutoRun[];
	try {
		runs = await window.maestro.web.takeOrphanedAutoRuns(instanceId);
	} catch (error) {
		window.maestro.logger.log('error', 'Failed to look up orphaned Auto Runs', 'BatchProcessor', {
			error: String(error),
		});
		return;
	}
	await Promise.all(runs.map((run) => resumeOrphanedRun(run, instanceId, startBatchRun)));
}

/** Once per page: a remount must not reclaim (and restart) a second time. */
let reclaimAttempted = false;

/** Test-only: allow the next mount to reclaim again. */
export function resetAutoRunReclaimForTests(): void {
	reclaimAttempted = false;
}

/**
 * Mount once, beside the batch processor. Waits for the agents to load (a run's
 * agent has to exist before it can be restarted), then reclaims.
 */
export function useAutoRunReclaim(startBatchRun: StartBatchRun): void {
	const start = useStableCallback(startBatchRun);
	const initialLoadComplete = useSessionStore((s) => s.initialLoadComplete);

	useEffect(() => {
		if (!initialLoadComplete || reclaimAttempted) return;
		if (!window.maestro?.web?.takeOrphanedAutoRuns) return;
		if (!isReloadedClientInstance()) return;
		reclaimAttempted = true;
		void reclaimOrphanedAutoRuns(start);
	}, [initialLoadComplete, start]);
}
