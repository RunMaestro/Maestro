/**
 * Chain of thought export: the capture of Cue runs.
 *
 * A Cue run is spawned by the Cue engine, outside the process manager, so the
 * process listener never sees it. The engine's executor hands each finished
 * agent run to an optional `onRunTranscript` callback, and this module is what
 * that callback is bound to.
 *
 *   dispatch   `begin(agentId)`  decides, once, whether the run is recorded
 *   finished   the callback      writes the whole turn (`recordCompletedRun`)
 *
 * WHAT IT GUARANTEES
 * - Nothing here throws into a Cue run. `begin` and the callback it returns
 *   are guarded, so a fault in the log can never change a run's result.
 * - The decision is the one taken at dispatch. A switch turned on or off while
 *   the run is going applies from the next run.
 * - The write is deferred a tick, so parsing a large stdout is not part of the
 *   time the run's caller waits.
 * - A failure goes to the feature's own store and nowhere else.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import type { CueRunTranscript } from '../cue/cue-executor';
import { decideCueRun, recordCompletedRun } from './turn-assembler';
import type { CotCueRecorderDeps } from './turn-assembler';

/** The outcome string of a turn for the status a Cue run ended with. */
function outcomeForCueStatus(status: CueRunTranscript['status']): string {
	switch (status) {
		case 'failed':
			return 'crashed';
		case 'stopped':
		case 'timeout':
			// Someone, or Cue's watchdog, ended the process. Neither is a failure of
			// the agent's own.
			return 'interrupted';
		default:
			return 'completed';
	}
}

export interface CotCueRunCapture {
	/**
	 * Decides whether the run of `agentId` is recorded. Returns the callback to
	 * pass as `onRunTranscript`, or undefined when the run is not recorded, so
	 * that an agent with export off costs the run nothing.
	 */
	begin(agentId: string): ((run: CueRunTranscript) => void) | undefined;
	/** Resolves when every run handed over so far is on disk or reported lost. */
	whenIdle(): Promise<void>;
}

/**
 * Makes the capture over injected dependencies. The app's own is
 * `beginCueRunCapture` in `runtime.ts`, which binds it to the app's store and
 * its one writer. It is not made here so that this module, which the tests
 * drive, does not pull the store and `electron` in with it.
 */
export function createCueRunCapture(deps: CotCueRecorderDeps): CotCueRunCapture {
	const inFlight = new Set<Promise<void>>();

	return {
		begin(agentId) {
			const decision = decideCueRun(agentId, deps);
			if (!decision) return undefined;

			return (run) => {
				const work = new Promise<void>((resolve) => {
					setImmediate(() => {
						recordCompletedRun(
							decision,
							{
								toolType: run.toolType,
								cwd: run.cwd,
								prompt: run.prompt,
								rawStdout: run.rawStdout,
								startTime: run.startTime,
								durationMs: run.durationMs,
								exitCode: run.exitCode,
								outcome: outcomeForCueStatus(run.status),
								providerSessionId: run.providerSessionId,
								sshRemoteId: run.sshRemoteId,
							},
							deps
						).then(resolve, resolve);
					});
				});
				inFlight.add(work);
				void work.then(() => {
					inFlight.delete(work);
				});
			};
		},

		async whenIdle() {
			while (inFlight.size > 0) {
				await Promise.allSettled([...inFlight]);
			}
		},
	};
}
