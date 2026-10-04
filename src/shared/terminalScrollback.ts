/**
 * Terminal scrollback persistence - limits and key grammar shared by the
 * renderer (which serializes the xterm buffer) and the main-process store
 * (which writes it to disk).
 *
 * A terminal tab's scrollback lives only inside its xterm instance, so without
 * this it is gone the moment the app quits. The snapshot is kept OUT of the
 * sessions JSON on purpose: it is large, it changes on every burst of output,
 * and the sessions store is a hot file rewritten on every agent mutation.
 */

/** Most rows of scrollback a snapshot keeps (the live terminal holds 10,000). */
export const TERMINAL_SCROLLBACK_MAX_ROWS = 5000;

/**
 * Largest snapshot accepted, in UTF-16 code units (the renderer halves the row
 * count until it fits). Serialized output carries SGR color codes, so a
 * colorful buffer is far bigger than its plain text.
 */
export const TERMINAL_SCROLLBACK_MAX_CHARS = 1024 * 1024;

/** Quiet period after output before a snapshot is written. */
export const TERMINAL_SCROLLBACK_SAVE_DELAY_MS = 5000;

/**
 * Longest a snapshot may lag behind output that never goes quiet (a dev
 * server, a `tail -f`), so a crash mid-stream loses at most this much.
 */
export const TERMINAL_SCROLLBACK_MAX_SAVE_WAIT_MS = 60_000;

/**
 * Serialize the newest rows that fit under the size cap. `serializeRows(n)`
 * returns the buffer with `n` rows of scrollback above the viewport; the row
 * count is halved until the result fits. Returns '' when even one row is too
 * big, which the store treats as "no snapshot".
 */
export function serializeScrollbackWithinCap(
	serializeRows: (rows: number) => string,
	maxRows: number = TERMINAL_SCROLLBACK_MAX_ROWS,
	maxChars: number = TERMINAL_SCROLLBACK_MAX_CHARS
): string {
	for (let rows = maxRows; rows >= 1; rows = Math.floor(rows / 2)) {
		const serialized = serializeRows(rows);
		if (serialized.length <= maxChars) return serialized;
	}
	return '';
}

/**
 * A snapshot is keyed by the terminal's IPC routing key
 * (`{agentId}-terminal-{tabId}`), which doubles as its file name, so anything
 * outside this grammar is refused rather than allowed near a path join.
 */
const SCROLLBACK_KEY_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function isValidTerminalScrollbackKey(key: unknown): key is string {
	return typeof key === 'string' && SCROLLBACK_KEY_PATTERN.test(key);
}
