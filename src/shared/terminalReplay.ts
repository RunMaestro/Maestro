/**
 * The text a terminal view replays when it takes over a PTY from another
 * window (Tab Windows, D5). Shared by the renderer, which builds it from its
 * xterm, and the main process, which holds it and appends live output.
 */

/**
 * Most characters a handoff carries. A replay is the scrollback of one xterm
 * (10,000 lines) plus the output that arrived while no window showed the PTY.
 * The oldest text goes first when a handoff grows past this.
 */
export const TERMINAL_HANDOFF_MAX_CHARS = 2_000_000;

/**
 * How long main makes a claim wait for a release that a move announced. A
 * releaser that never had a view of the PTY (an agent never shown since
 * launch) never releases, and the claimer then goes live with an empty screen.
 */
export const TERMINAL_HANDOFF_WAIT_MS = 3000;

/** How long main keeps a released scrollback that no window has claimed. */
export const TERMINAL_HANDOFF_UNCLAIMED_TTL_MS = 60_000;

/** Keep the newest {@link TERMINAL_HANDOFF_MAX_CHARS} of `text`. */
export function capTerminalHandoff(text: string): string {
	return text.length > TERMINAL_HANDOFF_MAX_CHARS
		? text.slice(text.length - TERMINAL_HANDOFF_MAX_CHARS)
		: text;
}

/**
 * The replay for a view that hands its PTY over: the xterm's buffer, then the
 * raw output that reached the window after the buffer was read.
 *
 * `buffer` is `XTerminalHandle.getBuffer()`: plain lines joined with `\n`, no
 * colors (`@xterm/addon-serialize` is not installed). An xterm moves to column
 * 0 only on `\r`, so the lines are joined with `\r\n` again. No line break
 * follows the last line: it is where the cursor was, and `tail` continues it.
 * `tail` is raw PTY output, escape codes included, written as it came.
 */
export function buildTerminalReplay(buffer: string, tail: readonly string[] = []): string {
	const lines = buffer.length > 0 ? buffer.split('\n').join('\r\n') : '';
	return capTerminalHandoff(lines + tail.join(''));
}
