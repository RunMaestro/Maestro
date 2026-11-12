/**
 * Turns a claude-code AskUserQuestion tool call into the typed shape the
 * renderer's question picker renders without re-parsing raw input. The input
 * shape and the defensive parser live in `src/shared/askUserQuestion.ts`. If no
 * usable question survives parsing, the caller falls back to an ordinary
 * allow/deny prompt.
 */

import {
	ASK_USER_QUESTION_TOOL,
	parseAskUserQuestions,
	type ParsedQuestion,
} from '../../shared/askUserQuestion';

/**
 * If `toolName` is AskUserQuestion and its input parses into at least one
 * usable question, return the `kind: 'question'` fields to spread onto a
 * PermissionRequest. Otherwise return `null` (ordinary allow/deny handling).
 */
export function parseQuestionRequest(
	toolName: string,
	input: Record<string, unknown>
): { kind: 'question'; questions: ParsedQuestion[] } | null {
	if (toolName !== ASK_USER_QUESTION_TOOL) {
		return null;
	}
	const questions = parseAskUserQuestions(input);
	if (questions.length === 0) {
		return null;
	}
	return { kind: 'question', questions };
}
