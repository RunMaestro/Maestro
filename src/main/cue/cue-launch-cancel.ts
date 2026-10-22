/**
 * Cancelling a Cue launch that has not spawned its process yet.
 *
 * `CueRunManager.stopRun` aborts the run's `AbortSignal`, which travels on the
 * `onCueRun` request through the router to every executor. A launch can be
 * awaiting an executor load, an agent path probe, an SSH resolution or a
 * shell PATH probe when that happens, and nothing it awaits is cancellable.
 * So each executor checks the signal after its awaits and, last of all,
 * synchronously right before it spawns: nothing awaited after that check can
 * reopen the window, and a stopped run never starts a process.
 *
 * Dependency-free on purpose: the router (statically imported by the CLI) and
 * every executor import it.
 */

import type { CueEvent, CueRunResult } from './cue-types';

/** True once the run this launch belongs to was stopped. */
export function isLaunchCancelled(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * The result of a launch cancelled before its process started: `stopped`,
 * with no output and no exit code, so the run manager's post-stop fix-up
 * records the row as `stopped` (never `failed`).
 */
export function stoppedBeforeLaunchResult(args: {
	runId: string;
	sessionId: string;
	sessionName: string;
	subscriptionName: string;
	pipelineName?: string;
	event: CueEvent;
	startedAt?: string;
}): CueRunResult {
	const endedAt = new Date().toISOString();
	const startedAt = args.startedAt ?? endedAt;
	return {
		runId: args.runId,
		sessionId: args.sessionId,
		sessionName: args.sessionName,
		subscriptionName: args.subscriptionName,
		pipelineName: args.pipelineName,
		event: args.event,
		status: 'stopped',
		stdout: '',
		stderr: '',
		exitCode: null,
		durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
		startedAt,
		endedAt,
	};
}
