// Plan-mode (`--permission-mode plan`) turn detection for the run-mode loop.
//
// When a Claude agent runs in read-only/plan mode, the model finishes a turn by
// calling the `ExitPlanMode` tool to present its plan and ask the user to
// approve before leaving plan mode. On the headless `claude --print` path that
// approval is implicit: print mode emits the plan and exits. But maestro-p
// drives the INTERACTIVE TUI, where ExitPlanMode parks on a blocking
// "Ready to code? 1. Yes / 2. No, keep planning" dialog that maestro-p has no
// human to answer. The model therefore never emits a `stop_reason: 'end_turn'`
// assistant message, so the runner's only completion signal never arrives and
// the idle watchdog kills the turn at `--max-wait` with a `timeout` error -
// discarding the plan text it had already captured. (Surfaced as a ~302s
// exitCode 3 / `response: undefined` on every interactive plan-mode turn.)
//
// The plan IS the deliverable for a read-only turn, so the runner treats an
// ExitPlanMode tool call as a terminal completion: it finalizes the turn
// successfully and folds the plan body (carried in the tool_use input, not in a
// `text` block) into the result, mirroring `claude --print --permission-mode
// plan`. This helper extracts that plan body and, by returning non-null,
// signals "this assistant message ends the turn".

const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/**
 * Inspect an assistant `message` for an `ExitPlanMode` tool_use block.
 *
 * Returns:
 * - `null` when the message contains no ExitPlanMode call (a normal turn; the
 *   caller keeps waiting for `end_turn`).
 * - the plan body string when ExitPlanMode is present and carries an
 *   `input.plan` string (the empty string if the model omitted the body).
 *
 * A non-null return means the turn is terminal and should be finalized.
 */
export function extractExitPlanText(message: unknown): string | null {
	if (!message || typeof message !== 'object') return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (
			!block ||
			typeof block !== 'object' ||
			(block as { type?: unknown }).type !== 'tool_use' ||
			(block as { name?: unknown }).name !== EXIT_PLAN_MODE_TOOL
		) {
			continue;
		}
		const input = (block as { input?: unknown }).input;
		const plan =
			input && typeof input === 'object' ? (input as { plan?: unknown }).plan : undefined;
		return typeof plan === 'string' ? plan : '';
	}
	return null;
}
