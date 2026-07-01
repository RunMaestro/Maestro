/**
 * Terminal-status derivation for agent runs (F5 / ISC-5.8, ISC-8.4) - PURE.
 *
 * Decides what status a run should settle to when its process exits. A clean
 * exit (code 0) is normally `completed`, but when the run carries open review
 * findings at critical/high severity it settles to `needs_review` instead so a
 * risky-but-successful run is not silently marked done. A nonzero exit is always
 * `failed`.
 *
 * Runtime-agnostic: no fs, electron, child_process, or network. F8 / the capture
 * service consume this to pick the exit target; the signal producers reuse the
 * open-finding predicates for their own guards.
 */

import type { AgentRun, AgentRunStatus } from './types';

/** True when the run has at least one open review finding of any severity. */
export function hasOpenReviewFinding(run: Pick<AgentRun, 'reviews'>): boolean {
	return run.reviews.some((finding) => finding.status === 'open');
}

/**
 * True when the run has at least one open review finding at `critical` or `high`
 * severity - the bar for diverting a clean exit into `needs_review`.
 */
export function hasOpenCriticalOrHighFinding(run: Pick<AgentRun, 'reviews'>): boolean {
	return run.reviews.some(
		(finding) =>
			finding.status === 'open' && (finding.severity === 'critical' || finding.severity === 'high')
	);
}

/**
 * Pick the terminal status for a run given its process `exitCode`:
 *   - nonzero exit               -> `failed`
 *   - exit 0 + open crit/high    -> `needs_review` (settle for review, not done)
 *   - exit 0 otherwise           -> `completed`
 */
export function deriveTerminalStatus(
	run: Pick<AgentRun, 'reviews'>,
	exitCode: number
): AgentRunStatus {
	if (exitCode !== 0) return 'failed';
	if (hasOpenCriticalOrHighFinding(run)) return 'needs_review';
	return 'completed';
}
