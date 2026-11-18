/**
 * Turns a claude-code AskUserQuestion tool call into the typed shape the
 * renderer's question picker renders without re-parsing raw input. The input
 * shape and the defensive parser live in `src/shared/askUserQuestion.ts`. If no
 * usable question survives parsing, the caller falls back to an ordinary
 * allow/deny prompt.
 */

import { isNativeQuestionContent } from '../../shared/currentTurn';
import { serializedJsonByteLength } from '../../shared/jsonUtils';
import {
	ASK_USER_QUESTION_TOOL,
	parseAskUserQuestions,
	type ParsedQuestion,
	type QuestionOption,
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

/** Automation accepts only an intact, bounded single-select raw schema.
 * The tolerant human picker above deliberately remains independent.
 */
export function parseAutomatableQuestionRequest(
	toolName: string,
	input: Record<string, unknown>
): ParsedQuestion | null {
	if (
		toolName !== ASK_USER_QUESTION_TOOL ||
		!input ||
		Array.isArray(input) ||
		!Array.isArray(input.questions) ||
		input.questions.length !== 1 ||
		(serializedJsonByteLength(input) ?? Infinity) > 16000
	)
		return null;
	const raw = input.questions[0];
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const q = raw as Record<string, unknown>;
	if (
		q.multiSelect !== false ||
		(q.header !== undefined && (typeof q.header !== 'string' || !q.header.trim())) ||
		Object.keys(q).some((key) => !['question', 'header', 'options', 'multiSelect'].includes(key)) ||
		!Array.isArray(q.options) ||
		!q.options.length ||
		q.options.length > 32
	)
		return null;
	const options: QuestionOption[] = [];
	for (const rawOption of q.options) {
		if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return null;
		const option = rawOption as Record<string, unknown>;
		if (
			typeof option.label !== 'string' ||
			!option.label.trim() ||
			(option.description !== undefined &&
				(typeof option.description !== 'string' || !option.description.trim())) ||
			Object.keys(option).some((key) => !['label', 'description'].includes(key))
		)
			return null;
		options.push({
			label: option.label,
			...(option.description !== undefined ? { description: option.description as string } : {}),
		});
	}
	if (
		new Set(options.map((o) => o.label.trim())).size !== options.length ||
		!isNativeQuestionContent({
			question: q.question,
			options: options.map((o) => (o.description ? `${o.label}: ${o.description}` : o.label)),
		})
	)
		return null;
	return {
		question: q.question as string,
		header: q.header as string | undefined,
		options,
		multiSelect: false,
	};
}
