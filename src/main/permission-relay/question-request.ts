/**
 * Parses a claude-code AskUserQuestion tool input into the typed shape the
 * renderer renders without re-parsing raw input.
 *
 * The AskUserQuestion input claude sends over the relay looks like:
 *
 *   {
 *     "questions": [
 *       {
 *         "question": "Which color do you prefer?",
 *         "header": "Color",
 *         "options": [ { "label": "Red", "description": "Red" }, ... ],
 *         "multiSelect": false
 *       }
 *     ]
 *   }
 *
 * Parsing is deliberately defensive (the input is `Record<string, unknown>`
 * off the wire): malformed entries are dropped rather than thrown, and if no
 * usable question survives, the caller falls back to an ordinary allow/deny
 * prompt.
 */

import { ASK_USER_QUESTION_TOOL, type ParsedQuestion, type QuestionOption } from './types';

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseOptions(raw: unknown): QuestionOption[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const options: QuestionOption[] = [];
	for (const entry of raw) {
		// Options are normally objects, but tolerate a bare string label too.
		if (typeof entry === 'string') {
			const label = asString(entry);
			if (label) {
				options.push({ label });
			}
			continue;
		}
		if (entry && typeof entry === 'object') {
			const obj = entry as Record<string, unknown>;
			const label = asString(obj.label);
			if (!label) {
				continue;
			}
			const description = asString(obj.description);
			options.push(description ? { label, description } : { label });
		}
	}
	return options;
}

function parseQuestion(raw: unknown): ParsedQuestion | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const question = asString(obj.question);
	if (!question) {
		return null;
	}
	const options = parseOptions(obj.options);
	return {
		question,
		header: asString(obj.header),
		options,
		multiSelect: obj.multiSelect === true,
	};
}

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
	const rawQuestions = input?.questions;
	if (!Array.isArray(rawQuestions)) {
		return null;
	}
	const questions: ParsedQuestion[] = [];
	for (const raw of rawQuestions) {
		const parsed = parseQuestion(raw);
		if (parsed) {
			questions.push(parsed);
		}
	}
	if (questions.length === 0) {
		return null;
	}
	return { kind: 'question', questions };
}
