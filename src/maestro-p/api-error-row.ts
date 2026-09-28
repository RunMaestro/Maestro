// Transcript-side plan-limit detection for the run-mode loop.
//
// When a Max-plan window runs out mid-turn, claude does not end the turn with
// an `end_turn` row. It writes one synthetic assistant row that reports the
// limit, then sits idle:
//
//   { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
//     message: { model: '<synthetic>', stop_reason: 'stop_sequence',
//       content: [{ type: 'text', text: "You've hit your weekly limit · resets ..." }] } }
//
// maestro-p used to detect a limit only by matching the TUI banner
// (`LIMIT_REGEX` in tui-driver.ts). That match is line-anchored and tied to the
// wording, so a banner painted with cursor addressing and no line feed, or a
// reworded one, never fired. And because this row carries the `<synthetic>`
// model, `processEntry` dropped it as bookkeeping. The turn then rode the idle
// watchdog out to `--max-wait` and exited 3 (`timeout`) instead of 2 (limit
// hit), so a caller that fails over on exit 2 burned its whole budget against
// an account that could not answer.
//
// The structured `error` tag is the signal, not the text: it does not change
// when the banner is reworded. Only `rate_limit` is terminal. Claude's other
// API-error rows (`server_error` and friends) are provisional - claude retries
// the call and carries on with the turn (see `isProvisionalErrorNotice` in
// src/main/parsers/claude-output-parser.ts) - so they must not end the turn.

/**
 * True when a transcript entry is claude's synthetic API-error row reporting a
 * plan limit. The transcript spells the flag in camelCase and stream-json
 * stdout in snake_case; both are accepted.
 */
export function isRateLimitErrorRow(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const e = entry as Record<string, unknown>;
	if (e.type !== 'assistant' || e.error !== 'rate_limit') return false;
	return e.isApiErrorMessage === true || e.is_api_error_message === true;
}
