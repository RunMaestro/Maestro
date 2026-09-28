// Stop handling for maestro-p (Plans/maestro-lib-launch-and-control.md, D14).
//
// With no handler installed, SIGINT and SIGTERM make Node exit on the spot: no
// result envelope reaches the caller, `driver.quit()` never sends `/quit`, and
// the claude TUI is left to notice the closed PTY through SIGHUP, shutting its
// MCP servers down however that happens to go. That made maestro-p the one
// agent process a Stop could not end cleanly.
//
// The first signal is a graceful stop: the caller settles the turn through its
// normal ending path, which quits the TUI within QUIT_GRACE_MS and then exits.
// A second signal while that is still running is a hard stop, the same escape
// hatch as the CLI's double Ctrl+C: nothing more is waited for.

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

// 128 + the signal number, the shell convention. Kept clear of maestro-p's own
// exit codes (0-6) so a caller can tell a stop from a timeout or a quota limit,
// and in particular never 2, which makes the desktop replay the prompt through
// the API.
export const STOP_EXIT_CODES: Readonly<Record<StopSignal, number>> = {
	SIGINT: 130,
	SIGTERM: 143,
};

export interface StopSignalHandlers {
	/** First signal: settle the turn and quit the TUI gracefully. */
	onStop: (signal: StopSignal) => void;
	/** Any signal after the first: stop now, without waiting on the TUI. */
	onForce: (signal: StopSignal) => void;
}

type SignalTarget = Pick<NodeJS.EventEmitter, 'on' | 'off'>;

/**
 * Install SIGINT and SIGTERM handlers and return a function that removes them.
 * `target` is `process` in production; tests pass their own emitter.
 */
export function installStopSignalHandlers(
	handlers: StopSignalHandlers,
	target: SignalTarget = process
): () => void {
	let stopping = false;
	const listener = (signal: StopSignal): void => {
		if (stopping) {
			handlers.onForce(signal);
			return;
		}
		stopping = true;
		handlers.onStop(signal);
	};
	for (const signal of STOP_SIGNALS) target.on(signal, listener);
	return () => {
		for (const signal of STOP_SIGNALS) target.off(signal, listener);
	};
}
