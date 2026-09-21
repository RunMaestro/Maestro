/**
 * Operator interrupt handling for long-running CLI commands.
 *
 * A CLI run that drives an agent has to be stoppable without corrupting its
 * own bookkeeping: the first Ctrl+C (or SIGTERM) aborts an `AbortSignal` that
 * `spawnAgent` turns into a graceful stop of the running agent, so the run can
 * record "stopped" and unregister itself. A second Ctrl+C means the operator
 * does not want to wait, so it exits immediately (130, the shell convention
 * for SIGINT).
 */

/** Conventional exit status for a process ended by SIGINT (128 + 2). */
const SIGINT_EXIT_CODE = 130;

export interface InterruptController {
	signal: AbortSignal;
	/** Remove the handlers. Call in `finally` so a later run is unaffected. */
	dispose: () => void;
}

export interface InterruptHandlerOptions {
	/** Called once, on the first interrupt (e.g. to print "Stopping..."). */
	onFirst?: () => void;
	/** Injectable for tests; defaults to the real process. */
	target?: NodeJS.Process;
}

export function installInterruptHandler(
	options: InterruptHandlerOptions = {}
): InterruptController {
	const target = options.target ?? process;
	const controller = new AbortController();

	const onSignal = () => {
		if (controller.signal.aborted) {
			target.exit(SIGINT_EXIT_CODE);
			return;
		}
		controller.abort();
		options.onFirst?.();
	};

	target.on('SIGINT', onSignal);
	target.on('SIGTERM', onSignal);

	return {
		signal: controller.signal,
		dispose: () => {
			target.off('SIGINT', onSignal);
			target.off('SIGTERM', onSignal);
		},
	};
}
