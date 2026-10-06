/**
 * Exit evaluator for Goal-Driven Auto Run mode.
 *
 * Pure decision function: given the run's history and config, decide whether
 * the next iteration should run or the run should stop (and why). It is the
 * goal-driven counterpart to the task-mode stop logic in
 * `src/renderer/hooks/batch/internal/useBatchRunner.ts` (all-tasks-checked,
 * loop-limit, stall detection), but driven by self-reported progress instead
 * of `- [ ]` checkbox counts.
 *
 * No Electron, React, or IPC - just data in, decision out.
 */

import type { GoalExitDecision, GoalIterationRecord, GoalRunConfig } from './types';
import { STALL_THRESHOLD } from './types';

/**
 * Build a progress series for the stall check, normalizing any missing report.
 *
 * A record's `progress` is typed as a number, but a "silent" iteration (the
 * agent emitted no progress marker) can surface here as a nullish/non-finite
 * value. We treat that as no-progress by carrying the previous record's value
 * forward (or 0 for the first iteration) so a silent iteration counts toward a
 * stall rather than crashing the comparison.
 */
function normalizeProgressSeries(history: GoalIterationRecord[]): number[] {
	const series: number[] = [];
	for (let i = 0; i < history.length; i++) {
		const raw = history[i].progress;
		if (typeof raw === 'number' && Number.isFinite(raw)) {
			series.push(raw);
		} else {
			series.push(i > 0 ? series[i - 1] : 0);
		}
	}
	return series;
}

/**
 * Detect a stall against the (already normalized) progress series.
 *
 * A stall means the last `STALL_THRESHOLD` iterations show no upward progress
 * movement - every consecutive pair within that window is flat or declining.
 * Requires at least `STALL_THRESHOLD` entries. Returns the normalized value the
 * run is stuck at (for the human-readable detail), or `null` when not stalled.
 */
function detectStall(series: number[]): number | null {
	if (series.length < STALL_THRESHOLD) {
		return null;
	}
	const window = series.slice(series.length - STALL_THRESHOLD);
	for (let i = 1; i < window.length; i++) {
		if (window[i] > window[i - 1]) {
			return null; // an upward tick within the window resets the stall
		}
	}
	return window[window.length - 1];
}

/**
 * Evaluate whether a goal-driven run should continue or stop.
 *
 * Stop conditions are checked in strict priority order; the first match wins:
 *   1. Completion    - latest `complete` (or `progress === 100`)
 *   2. Deadlock      - latest `deadlock`
 *   3. Max iterations - finite `config.maxIterations` reached
 *   4. Stall          - no upward progress across the last `STALL_THRESHOLD` records
 *   5. otherwise      - continue
 *
 * `detail` is a concise, human-readable string surfaced in History.
 */
export function evaluateGoalExit(
	history: GoalIterationRecord[],
	config: GoalRunConfig
): GoalExitDecision {
	// Nothing has run yet - keep going.
	if (history.length === 0) {
		return { action: 'continue' };
	}

	const latest = history[history.length - 1];

	// 1. Completion beats everything, including a simultaneous iteration cap.
	if (latest.complete || latest.progress === 100) {
		return {
			action: 'stop',
			reason: 'completed',
			detail: `Agent self-reported the goal is complete (${latest.progress}%).`,
		};
	}

	// 2. Deadlock - the agent declared it cannot make further progress. Prefer the
	// reason from the deadlock marker itself (what the prompt instructs the agent
	// to emit); fall back to the progress rationale only when no deadlock reason
	// was given.
	if (latest.deadlock) {
		const reason = latest.deadlockReason?.trim() || latest.rationale?.trim();
		return {
			action: 'stop',
			reason: 'deadlock',
			detail: reason
				? `Agent reported a deadlock: ${reason}`
				: 'Agent reported a deadlock with no stated reason.',
		};
	}

	// 3. Max iterations - only when a finite cap is configured.
	if (config.maxIterations !== null && history.length >= config.maxIterations) {
		return {
			action: 'stop',
			reason: 'max-iterations',
			detail: `Reached the maximum of ${config.maxIterations} iteration${
				config.maxIterations === 1 ? '' : 's'
			}.`,
		};
	}

	// 4. Stall - running without moving the number is no real progress. Use the
	// normalized series so a silent (missing-progress) latest iteration reports
	// the value it's stuck at rather than a raw null.
	const stuckAt = detectStall(normalizeProgressSeries(history));
	if (stuckAt !== null) {
		return {
			action: 'stop',
			reason: 'stalled',
			detail: `No progress across the last ${STALL_THRESHOLD} iterations (stuck at ${stuckAt}%).`,
		};
	}

	// 5. Healthy - keep going.
	return { action: 'continue' };
}
