// Which transcript rows prove claude started the turn.
//
// maestro-p treats the first row claude writes after the prompt as proof the
// prompt was submitted: it stops the first-byte timer and the Enter resubmit
// loop. On `--resume`, claude also writes rows BEFORE it reads any input: a
// SessionStart hook's result and the context it injects are logged as
// `attachment` rows the moment the TUI boots. Counting those as the turn
// starting switched off both safety nets while the prompt was still parked in
// claude's editor, so a lost Enter left it there until the 300s idle watchdog
// fired, or until a Stop typed `/quit` onto the end of it and submitted
// "<prompt>/quit" into the session (rc synopsis runs, 2026-10-20).

/** True for a row claude writes before it has read the prompt. */
export function isPreTurnRow(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const row = entry as { type?: unknown; attachment?: unknown };
	if (row.type !== 'attachment' || !row.attachment || typeof row.attachment !== 'object') {
		return false;
	}
	return (row.attachment as { hookEvent?: unknown }).hookEvent === 'SessionStart';
}

// On `--resume` the tailer starts at the end of the transcript, but the end can
// still move after that for reasons that are not this turn: the PREVIOUS turn's
// claude, terminated after its `/quit` grace ran out, flushes its last rows
// (`<command-name>/exit`, its output, the cost-state row) after the maestro-p
// that drove it has exited. When the next turn starts in that window, those
// rows reach it as new. The old `/exit` row was then checked as this turn's
// prompt echo, and a 10 KB prompt failed as `prompt_truncated` ("128 of 8396
// bytes") with nothing lost (2026-11-26). The same rows would also count as the
// turn starting, and end a slash-command turn on the wrong output.
//
// Every row claude writes carries the wall-clock time it was made, so a row
// made before this run started cannot be this run's. Rows with no timestamp
// (cost-state, file-history snapshots) are not judged by their own time; the
// caller treats the ones that follow a stale row as part of the same flush.

/** When claude made this row (epoch ms), or null for a row with no timestamp. */
export function rowTimestampMs(entry: unknown): number | null {
	if (!entry || typeof entry !== 'object') return null;
	const { timestamp } = entry as { timestamp?: unknown };
	if (typeof timestamp !== 'string') return null;
	const madeAt = Date.parse(timestamp);
	return Number.isFinite(madeAt) ? madeAt : null;
}

/** True for a row timestamped before `runStartedAt` (epoch ms). */
export function isRowFromBeforeRun(entry: unknown, runStartedAt: number): boolean {
	const madeAt = rowTimestampMs(entry);
	return madeAt !== null && madeAt < runStartedAt;
}

/**
 * True for a row that proves claude read this run's prompt and started the
 * turn: a row TIMESTAMPED at or after `runStartedAt` (epoch ms) that is not a
 * SessionStart hook's.
 *
 * Untimestamped rows never count. They are bookkeeping (`last-prompt`,
 * `tools-used`, `file-history-snapshot`, `mode`, `cost-state`), and an exiting
 * claude flushes them as a block. When that flush is ALL unstamped, no stale
 * timestamped row precedes it for the stale-flush guard to key on, so it reached
 * the next run as new:
 * - On `--resume` the rows arrived while the TUI was still booting, and counting
 *   one opened the steer gate before the editor was drawn: a Quick Chat steer
 *   10s into a Pedsidian turn was refused as "the input editor is not on screen"
 *   three seconds before claude received the prompt (2026-11-27).
 * - A synopsis claude's flush landed after the next user turn began tailing, and
 *   its `tools-used` row switched off the first-byte timer and the Enter
 *   resubmit loop with that turn's prompt still parked in the editor. The 300s
 *   idle watchdog then failed the turn with the prompt unsent (rc 1.1.1,
 *   2026-11-27).
 *
 * Every row a started turn writes (the prompt echo, a reply, a tool result, a
 * non-SessionStart hook) is stamped.
 */
export function provesTurnStarted(entry: unknown, runStartedAt: number): boolean {
	const madeAt = rowTimestampMs(entry);
	return madeAt !== null && madeAt >= runStartedAt && !isPreTurnRow(entry);
}
