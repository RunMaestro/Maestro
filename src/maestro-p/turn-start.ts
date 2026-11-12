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
