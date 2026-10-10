// Transcript-side detection of claude's terminal API-error rows (plan limits,
// bad models, rejected credentials) for the run-mode loop.
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
// when the banner is reworded. `rate_limit` is terminal and gets its own exit
// code (2) because callers fail over on it. A second family is terminal too:
// errors claude does not retry because nothing about the next attempt would
// differ - a model that does not exist, a rejected credential, an account with
// no billing, a request the API refuses outright. Claude writes the same kind
// of synthetic row for those and goes idle, so without this the turn rode the
// idle watchdog to `--max-wait` and reported a misleading `timeout` (#1753):
//
//   { type: 'assistant', isApiErrorMessage: true, error: 'model_not_found',
//     message: { model: '<synthetic>', stop_reason: 'stop_sequence',
//       content: [{ type: 'text', text: "There's an issue with the selected model ..." }] } }
//
// This is an ALLOWLIST on purpose. Claude's other API-error rows
// (`server_error`, `unknown`, and any tag it adds later) are provisional -
// claude retries the call and carries on with the turn (see
// `isProvisionalErrorNotice` in src/main/parsers/claude-output-parser.ts) - and
// ending the turn on one would throw away a response that was still coming.
// An unlisted tag costs a slow failure; a wrongly listed one costs a good turn.

/** Error tags on claude's synthetic API-error row that end the turn for good. */
export const TERMINAL_API_ERROR_TAGS: ReadonlySet<string> = new Set([
	'model_not_found',
	'authentication_failed',
	'billing_error',
	'invalid_request',
]);

function isApiErrorRow(e: Record<string, unknown>): boolean {
	if (e.type !== 'assistant') return false;
	return e.isApiErrorMessage === true || e.is_api_error_message === true;
}

/**
 * True when a transcript entry is claude's synthetic API-error row reporting a
 * plan limit. The transcript spells the flag in camelCase and stream-json
 * stdout in snake_case; both are accepted.
 */
export function isRateLimitErrorRow(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const e = entry as Record<string, unknown>;
	return e.error === 'rate_limit' && isApiErrorRow(e);
}

/**
 * The error tag when a transcript entry is claude's synthetic API-error row for
 * a failure claude will not retry (see {@link TERMINAL_API_ERROR_TAGS}), else
 * null. `rate_limit` is deliberately not included: it has its own exit code and
 * is caught by {@link isRateLimitErrorRow}.
 */
export function terminalApiErrorTag(entry: unknown): string | null {
	if (!entry || typeof entry !== 'object') return null;
	const e = entry as Record<string, unknown>;
	if (typeof e.error !== 'string' || !TERMINAL_API_ERROR_TAGS.has(e.error)) return null;
	return isApiErrorRow(e) ? e.error : null;
}
