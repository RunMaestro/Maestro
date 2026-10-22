/**
 * The control half of a run that can wait: graceful stop, the pause a classified error or a
 * HITL gate parks the run in, the timed auto-resume, and the clock that leaves paused time out.
 *
 * The desktop spreads this across `useBatchControlActions` (resume, skip, abort, stop),
 * `autoRunResumeStore` (the fallback timer), and `useTimeTracking` (the frozen clock). Here it is
 * one object the runtime hands to the engine (`AutoRunDeps.controller`) and keeps hold of to
 * answer a pause. The engine never imports it: it sees only the `AutoRunController` surface.
 */

import { isLimitError } from '../../types';
import type { AutoResumePolicy } from '../../autorunAutoResume';
import type { AutoRunController, AutoRunPause, AutoRunResolution } from './engine-types';

type TimerHandle = unknown;

export interface RunControllerOptions {
	clock: { now(): number };
	/** Fallback auto-resume for error pauses. Absent or `null`: a pause waits for a person. */
	autoResume?: AutoResumePolicy | null;
	/** Injected so tests drive the timer by hand. Default: the global timers. */
	setTimer?: (callback: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
}

/** What the runtime holds: the engine's view plus the handles that answer it. */
export interface RunController extends AutoRunController {
	/** Stop after the task in flight. A run that is paused answers `abort`. */
	requestStop(): void;
	/** Answer the pending pause. False when nothing is pending, so a stale click does nothing. */
	resolve(resolution: AutoRunResolution): boolean;
	isPaused(): boolean;
	/** The pause the run is parked on, for the progress frame. */
	pending(): AutoRunPause | null;
	/** Automatic resumes spent so far this run. */
	autoResumesUsed(): number;
}

export function createRunController(options: RunControllerOptions): RunController {
	const { clock, autoResume = null } = options;
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer =
		options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

	let stopRequested = false;
	let closedPausedMs = 0;
	let autoResumes = 0;
	let current: {
		pause: AutoRunPause;
		since: number;
		timer: TimerHandle | null;
		settle: (answer: { resolution: AutoRunResolution; auto: boolean }) => void;
	} | null = null;

	const answer = (resolution: AutoRunResolution, auto: boolean): boolean => {
		if (!current) return false;
		const pending = current;
		current = null;
		if (pending.timer !== null) clearTimer(pending.timer);
		closedPausedMs += clock.now() - pending.since;
		pending.settle({ resolution, auto });
		return true;
	};

	return {
		stopRequested: () => stopRequested,

		awaitResolution(pause) {
			// A stop that arrived before the pause began has nobody left to answer it.
			if (stopRequested) return Promise.resolve({ resolution: 'abort', auto: false });
			return new Promise((settle) => {
				let timer: TimerHandle | null = null;
				// Gates never auto-resume (only a person can do the step) and a limit error wants a
				// probe on the provider's own reset schedule, not a retry in five minutes.
				if (
					pause.kind === 'error' &&
					autoResume &&
					autoResumes < autoResume.maxAttempts &&
					!isLimitError(pause.agentError)
				) {
					timer = setTimer(() => {
						autoResumes++;
						answer('resume', true);
					}, autoResume.delayMs);
				}
				current = { pause, since: clock.now(), timer, settle };
			});
		},

		pausedMs: () => closedPausedMs + (current ? clock.now() - current.since : 0),

		requestStop() {
			stopRequested = true;
			answer('abort', false);
		},
		resolve: (resolution) => answer(resolution, false),
		isPaused: () => current !== null,
		pending: () => current?.pause ?? null,
		autoResumesUsed: () => autoResumes,
	};
}
