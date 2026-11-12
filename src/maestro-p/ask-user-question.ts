// AskUserQuestion turn detection for the run-mode loop.
//
// maestro-p drives the INTERACTIVE TUI and always bypasses permission prompts,
// so Maestro's permission relay (the API/print path's question picker) is never
// attached. When the model calls AskUserQuestion, the TUI parks on its own
// picker that maestro-p has no human to answer. The model writes nothing more
// to the transcript, `end_turn` never arrives, and the idle watchdog kills the
// turn at --max-wait (exitCode 3, `timeout`). The user then sees the turn fail
// with the question never shown. (Surfaced 2026-11-10: a ~300s timeout on a
// turn whose last act was a two-question AskUserQuestion call.)
//
// This is the ExitPlanMode problem (see plan-mode.ts) in another tool, and it
// gets the same answer: the question IS the deliverable of the turn. The runner
// finalizes the turn successfully with the questions, options numbered, folded
// into the reply. The user answers in their next message, which resumes the
// session; claude records the parked call as interrupted and reads the answer
// from that message.

import {
	ASK_USER_QUESTION_TOOL,
	formatAskUserQuestionsAsText,
	parseAskUserQuestions,
} from '../shared/askUserQuestion';

/**
 * Inspect an assistant `message` for an AskUserQuestion tool_use block.
 *
 * Returns the questions rendered as reply text when the call carries at least
 * one usable question, which means the turn is terminal and should be
 * finalized. Returns `null` otherwise: a normal turn, or a malformed call that
 * claude rejects with a tool_result error rather than a picker.
 */
export function extractAskUserQuestionText(message: unknown): string | null {
	if (!message || typeof message !== 'object') return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (
			!block ||
			typeof block !== 'object' ||
			(block as { type?: unknown }).type !== 'tool_use' ||
			(block as { name?: unknown }).name !== ASK_USER_QUESTION_TOOL
		) {
			continue;
		}
		const questions = parseAskUserQuestions((block as { input?: unknown }).input);
		if (questions.length === 0) continue;
		return formatAskUserQuestionsAsText(questions);
	}
	return null;
}
