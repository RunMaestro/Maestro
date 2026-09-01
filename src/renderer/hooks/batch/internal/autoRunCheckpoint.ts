/**
 * Auto Run task-boundary checkpoints.
 *
 * When `autoRunCheckpointsEnabled` is on, Auto Run snapshots the working tree
 * each time a task completes, so a playbook left running overnight can be
 * rewound to any finished step rather than only to the last commit.
 *
 * The whole thing is opt-in and best-effort, and both of those are load-bearing:
 *
 * - Opt-in, because a snapshot per task is cheap but not free, and the payoff
 *   only exists on a long unattended run. Charging every user for it silently
 *   would be a cost most never collect on.
 * - Best-effort, because a checkpoint is a SAFETY NET, not a step of the work.
 *   Aborting a six-hour run because a snapshot failed would destroy far more
 *   than the missing snapshot protects. Failures are logged to the Auto Run log,
 *   where a user reconstructing a run will actually find them, and the run
 *   continues.
 */

import { gitService } from '../../../services/git';
import { useSettingsStore } from '../../../stores/settingsStore';

export interface AutoRunCheckpointContext {
	/** Repo the run is operating in (already worktree- and terminal-resolved). */
	cwd: string;
	sshRemoteId?: string;
	/** Agent name, for the Auto Run log. */
	sessionName: string;
	/** Document the task came from, e.g. `plan.md`. */
	documentName: string;
	/** 1-based index of the task across the whole run. */
	taskNumber: number;
	/** The agent's own one-line summary of what it just did, when it gave one. */
	taskSummary?: string;
}

/**
 * Build the checkpoint label for a completed task.
 *
 * The document and task number come first so the list reads as a run timeline
 * even when the agent's summary is missing or unhelpful, and the summary is
 * truncated because a label is a list row, not a paragraph. (The full text is
 * already in the Auto Run transcript; this only has to be enough to pick the
 * right row out of a list of forty.)
 */
export function autoRunCheckpointLabel(context: AutoRunCheckpointContext): string {
	const base = `${context.documentName} - task ${context.taskNumber}`;
	const summary = context.taskSummary?.replace(/\s+/g, ' ').trim();
	if (!summary) return base;
	const clipped = summary.length > 80 ? `${summary.slice(0, 79)}...` : summary;
	return `${base}: ${clipped}`;
}

/**
 * Take a checkpoint if the user has asked for one at task boundaries.
 *
 * Resolves regardless of outcome. Callers must NOT branch on the return value
 * to decide whether the run proceeds - it is returned only so tests can assert
 * the gate, and so a future caller can report it.
 */
export async function maybeCheckpointAfterTask(
	context: AutoRunCheckpointContext
): Promise<{ taken: boolean; checkpointId?: string; error?: string }> {
	// Read at call time, not at run start: a user who turns this on mid-run
	// wants it from the next task, and one who turns it off wants it to stop.
	const { autoRunCheckpointsEnabled, autoRunCheckpointsIncludeIgnored } =
		useSettingsStore.getState();
	if (!autoRunCheckpointsEnabled) return { taken: false };

	try {
		const result = await gitService.createCheckpoint(
			context.cwd,
			{
				label: autoRunCheckpointLabel(context),
				includeIgnored: autoRunCheckpointsIncludeIgnored,
				origin: 'auto-run',
			},
			context.sshRemoteId
		);

		if (!result.success || !result.checkpoint) {
			// AUTORUN LOG: a missing checkpoint is invisible until someone tries to
			// roll back and finds nothing there, so the reason is recorded now.
			window.maestro.logger.autorun(
				`Auto Run checkpoint failed: ${result.error ?? 'unknown error'}`,
				context.sessionName,
				{ document: context.documentName, taskNumber: context.taskNumber }
			);
			return { taken: false, error: result.error };
		}

		window.maestro.logger.autorun(
			`Auto Run checkpoint ${result.checkpoint.id}`,
			context.sessionName,
			{
				document: context.documentName,
				taskNumber: context.taskNumber,
				label: result.checkpoint.label,
				includesIgnored: result.checkpoint.includesIgnored,
			}
		);
		return { taken: true, checkpointId: result.checkpoint.id };
	} catch (error) {
		// The service layer already swallows IPC faults into `{ success: false }`,
		// so reaching here means something unforeseen. Still non-fatal - see the
		// note at the top of this file about why a failed net must not stop the run.
		const message = error instanceof Error ? error.message : String(error);
		window.maestro.logger.autorun(`Auto Run checkpoint threw: ${message}`, context.sessionName, {
			document: context.documentName,
			taskNumber: context.taskNumber,
		});
		return { taken: false, error: message };
	}
}
