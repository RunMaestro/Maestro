/**
 * The "Auto-Run Complete" toast, for every run this window draws.
 *
 * A run this window drives raises it from its own end (`onComplete` in `useBatchHandlers`). A run a
 * Federation host drives for a hosted agent is drawn here as a mirror (`applyAutoRunMirrorFrame()`),
 * and its end is the host's last frame: the host sync (`hostedAgentSync.ts`) raises the same toast,
 * with the same words, from the last state the mirror drew. Only the toast: a desktop host credits
 * its own run (achievements, leaderboard), so this window must not count it a second time.
 */

import type { BatchRunState } from '../types';
import type { BatchCompleteInfo } from '../hooks/batch/useBatchProcessor';
import { autoRunActiveElapsedMs } from '../hooks/batch/useTimeTracking';
import { notifyToast } from '../stores/notificationStore';
import { useSessionStore } from '../stores/sessionStore';

/** What the toast reads off a finished run. */
export type AutoRunCompleteToastInfo = Pick<
	BatchCompleteInfo,
	'sessionId' | 'sessionName' | 'completedTasks' | 'totalTasks' | 'wasStopped' | 'elapsedTimeMs'
>;

/**
 * The group a toast names for an agent, falling back to the parent's group for a worktree child
 * whose groupId may not be in sync.
 */
export function resolveAutoRunGroupName(
	sessionId: string,
	sessions: { id: string; groupId?: string; parentSessionId?: string }[],
	groups: { id: string; name: string }[]
): string {
	const session = sessions.find((s) => s.id === sessionId);
	const effectiveGroupId =
		session?.groupId ||
		(session?.parentSessionId
			? sessions.find((s) => s.id === session.parentSessionId)?.groupId
			: undefined);
	const group = effectiveGroupId ? groups.find((g) => g.id === effectiveGroupId) : null;
	return group?.name || 'Ungrouped';
}

/** Raise the "Auto-Run Complete" toast for a finished run. */
export function notifyAutoRunComplete(info: AutoRunCompleteToastInfo): void {
	const { sessions, groups } = useSessionStore.getState();
	const allDone = info.completedTasks === info.totalTasks;
	const type = info.wasStopped ? 'warning' : allDone ? 'success' : 'info';
	let message: string;
	if (info.wasStopped) {
		message = `Stopped after completing ${info.completedTasks} of ${info.totalTasks} tasks`;
	} else if (allDone) {
		message = `All ${info.totalTasks} ${info.totalTasks === 1 ? 'task' : 'tasks'} completed successfully`;
	} else {
		message = `Completed ${info.completedTasks} of ${info.totalTasks} tasks`;
	}
	notifyToast({
		type,
		title: 'Auto-Run Complete',
		message,
		group: resolveAutoRunGroupName(info.sessionId, sessions, groups),
		project: info.sessionName,
		taskDuration: info.elapsedTimeMs,
		sessionId: info.sessionId,
	});
}

/**
 * The toast's facts for a mirrored run that just ended, from the last state the mirror drew, as the
 * local runners count them: a goal run on its 0 to 100 scale, a task run by the tasks done in THIS
 * run (tasks checked before it do not count) over the run's task total.
 */
export function mirroredRunCompleteInfo(
	sessionId: string,
	sessionName: string,
	last: BatchRunState,
	now: number = Date.now()
): AutoRunCompleteToastInfo {
	const elapsedTimeMs = last.startTime ? autoRunActiveElapsedMs(last, now) : 0;
	if (last.goalMode) {
		return {
			sessionId,
			sessionName,
			completedTasks: Math.round(Math.min(100, Math.max(0, last.goalProgress ?? 0))),
			totalTasks: 100,
			wasStopped: last.isStopping === true,
			elapsedTimeMs,
		};
	}
	const completedTasks = Math.max(
		0,
		last.completedTasksAcrossAllDocs - (last.initialCompletedTasks ?? 0)
	);
	return {
		sessionId,
		sessionName,
		completedTasks,
		totalTasks: Math.max(last.totalTasksAcrossAllDocs, completedTasks),
		wasStopped: last.isStopping === true,
		elapsedTimeMs,
	};
}
