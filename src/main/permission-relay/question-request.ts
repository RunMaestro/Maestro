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

import { isNativeQuestionContent } from '../../shared/currentTurn';
import { serializedJsonByteLength } from '../../shared/jsonUtils';
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
