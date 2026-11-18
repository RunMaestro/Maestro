/**
 * Claude Code's `AskUserQuestion` tool: the typed shape of its input, a
 * defensive parser, and a plain-text rendering.
 *
 * Two surfaces read this tool call:
 * - The permission relay (`src/main/permission-relay/`), on the API/print
 *   path, renders the questions as a picker and returns the user's choice.
 * - maestro-p, on the TUI path, has no human to answer the TUI's picker. It
 *   ends the turn and shows the questions as the reply, so the user answers
 *   them in their next message.
 *
 * The input claude sends looks like:
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
 * Parsing is deliberately defensive (the input is off the wire): malformed
 * entries are dropped rather than thrown.
 */

/** The claude-code tool that presents multiple-choice questions. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** One selectable option within an AskUserQuestion question. */
export interface QuestionOption {
	label: string;
	description?: string;
}

/** A single parsed question from an AskUserQuestion tool call. */
export interface ParsedQuestion {
	/** The question text shown to the user. */
	question: string;
	/** Short header/category label claude attaches to the question. */
	header?: string;
	/** The offered choices. */
	options: QuestionOption[];
	/** Whether more than one option may be selected. */
	multiSelect: boolean;
}

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
	return {
		question,
		header: asString(obj.header),
		options: parseOptions(obj.options),
		multiSelect: obj.multiSelect === true,
	};
}

/**
 * The usable questions in an AskUserQuestion tool input. Returns an empty
 * array when the input carries none.
 */
export function parseAskUserQuestions(input: unknown): ParsedQuestion[] {
	if (!input || typeof input !== 'object') {
		return [];
	}
	const rawQuestions = (input as { questions?: unknown }).questions;
	if (!Array.isArray(rawQuestions)) {
		return [];
	}
	const questions: ParsedQuestion[] = [];
	for (const raw of rawQuestions) {
		const parsed = parseQuestion(raw);
		if (parsed) {
			questions.push(parsed);
		}
	}
	return questions;
}

/**
 * Markdown the user can answer by reply: each question with its options
 * numbered, so "1" or "2 and 3" is a complete answer. Several questions are
 * numbered too, so "Q1: 2, Q2: 1" works.
 */
export function formatAskUserQuestionsAsText(questions: readonly ParsedQuestion[]): string {
	const numbered = questions.length > 1;
	const blocks = questions.map((q, index) => {
		const prefix = numbered ? `Q${index + 1}. ` : '';
		const header = q.header ? `**${q.header}:** ` : '';
		const lines = [`${prefix}${header}${q.question}`];
		if (q.options.length > 0) {
			lines.push('');
			q.options.forEach((option, optionIndex) => {
				const description = option.description ? ` - ${option.description}` : '';
				lines.push(`${optionIndex + 1}. **${option.label}**${description}`);
			});
		}
		if (q.multiSelect) {
			lines.push('', '_Pick one or more._');
		}
		return lines.join('\n');
	});
	return blocks.join('\n\n');
}
