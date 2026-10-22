/**
 * Live figures for one Auto Run, folded from the events a client receives (AR-6).
 *
 * The host's `autorun_state` carries counts and a pause, but no clock, no
 * tokens, no cost, and no output. Those come from the run's own process stream
 * (`<agentId>-batch-<ts>`), so this reducer joins the two. It is pure: every
 * event carries its own `at`, so a test replays a recorded run and gets the
 * same figures, and the clock never reads the wall time except through
 * `runElapsedMs(run, now)`.
 *
 * Two rules worth knowing:
 *   - the clock excludes paused time (an error pause or a gate waiting for a
 *     person is not work). A pause that began before this client attached
 *     cannot be seen, so a run joined mid-pause counts that wait as work until
 *     the pause ends;
 *   - usage is the latest report per process, summed. A process's reports
 *     describe that process, so summing every report would count the same
 *     tokens again with each one.
 */

import { stripAnsiCodes } from '../../stringUtils';
import type { UsageStats } from '../../types';
import type { AutoRunProgress } from './progress';

/** Lines of output kept. A screen shows the last few; the rest is a buffer for resizing. */
export const AUTO_RUN_TAIL_LINES = 200;

export interface AutoRunUsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costUsd: number;
}

export interface AutoRunRun {
	/** The latest state the host pushed. `null` before the first, and after the host clears it. */
	progress: AutoRunProgress | null;
	/** When the clock started: the host's `startTime`, else when this client first saw the run. */
	startedAt?: number;
	/** Epoch ms the run ended, once it has. */
	endedAt?: number;
	/** Paused time already closed out. */
	pausedMs: number;
	/** Set while a pause is open. */
	pausedSince?: number;
	usageByProcess: Record<string, UsageStats>;
	/** The last lines the run printed, oldest first. */
	tail: string[];
}

export type AutoRunRunEvent =
	| { kind: 'state'; at: number; state: AutoRunProgress | null }
	| { kind: 'output'; at: number; processId: string; text: string }
	| { kind: 'usage'; at: number; processId: string; usage: UsageStats };

export const EMPTY_AUTO_RUN: AutoRunRun = {
	progress: null,
	pausedMs: 0,
	usageByProcess: {},
	tail: [],
};

/** Closes an open pause at `at`. */
function closePause(run: AutoRunRun, at: number): AutoRunRun {
	if (run.pausedSince === undefined) return run;
	return {
		...run,
		pausedMs: run.pausedMs + Math.max(0, at - run.pausedSince),
		pausedSince: undefined,
	};
}

export function reduceAutoRun(run: AutoRunRun, event: AutoRunRunEvent): AutoRunRun {
	switch (event.kind) {
		case 'state': {
			const { state, at } = event;
			if (state === null || !state.isRunning) {
				const closed = closePause(run, at);
				// Only a run this client saw start can end. A `null` keeps the last counts for the final readout.
				const endedAt = closed.endedAt ?? (closed.startedAt !== undefined ? at : undefined);
				return {
					...closed,
					progress: state ?? closed.progress,
					...(endedAt !== undefined ? { endedAt } : {}),
				};
			}
			// A running frame after an end is a new run: start its figures from nothing.
			const base = run.endedAt !== undefined ? EMPTY_AUTO_RUN : run;
			const startedAt = base.startedAt ?? state.startTime ?? at;
			let next: AutoRunRun = { ...base, progress: state, startedAt };
			if (state.pause && next.pausedSince === undefined) next = { ...next, pausedSince: at };
			else if (!state.pause) next = closePause(next, at);
			return next;
		}
		case 'output': {
			const text = stripAnsiCodes(event.text).replace(/\r\n?/g, '\n');
			const lines = text.split('\n').filter((line) => line.trim() !== '');
			if (lines.length === 0) return run;
			const tail = [...run.tail, ...lines].slice(-AUTO_RUN_TAIL_LINES);
			return { ...run, tail };
		}
		case 'usage':
			return {
				...run,
				usageByProcess: { ...run.usageByProcess, [event.processId]: event.usage },
			};
	}
}

/** Work time so far: wall time minus every pause, open or closed. `0` before the run is seen. */
export function runElapsedMs(run: AutoRunRun, now: number): number {
	if (run.startedAt === undefined) return 0;
	const end = run.endedAt ?? now;
	const openPause = run.pausedSince !== undefined ? Math.max(0, end - run.pausedSince) : 0;
	return Math.max(0, end - run.startedAt - run.pausedMs - openPause);
}

export function runUsageTotals(run: AutoRunRun): AutoRunUsageTotals {
	const totals: AutoRunUsageTotals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		costUsd: 0,
	};
	for (const usage of Object.values(run.usageByProcess)) {
		totals.inputTokens += usage.inputTokens || 0;
		totals.outputTokens += usage.outputTokens || 0;
		totals.cacheReadTokens += usage.cacheReadInputTokens || 0;
		totals.costUsd += usage.totalCostUsd || 0;
	}
	return totals;
}

/** A run is on screen worth watching: it is running, or it ended and its figures are still held. */
export function hasAutoRun(run: AutoRunRun | undefined): run is AutoRunRun {
	return run !== undefined && (run.progress !== null || run.startedAt !== undefined);
}

/** The run is still going: seen starting, not yet seen ending. */
export function isAutoRunActive(run: AutoRunRun | undefined): boolean {
	return run !== undefined && run.startedAt !== undefined && run.endedAt === undefined;
}
