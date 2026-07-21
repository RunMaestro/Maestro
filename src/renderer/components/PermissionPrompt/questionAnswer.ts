/**
 * Encodes a user's AskUserQuestion selection into the free-text `message`
 * string delivered back to claude-code via a `{ behavior: 'deny', message }`
 * relay decision.
 *
 * Why deny+message: empirically (see the Tool Display Phase 3 playbook
 * Findings) `allow` + `updatedInput` does NOT deliver an answer on the headless
 * path - claude runs AskUserQuestion itself and gets "the user did not answer".
 * Only the deny message reaches the model as the answer, which it reads as the
 * user's response. So we format the selection into a clear, human-readable
 * string here.
 *
 * Pure function: no React, no store, no IPC - trivially unit-testable.
 */

/** The parts of a question the encoder needs to label an answer line. */
export interface QuestionForAnswer {
	question: string;
	header?: string;
}

/** The user's answer to a single question. */
export interface QuestionSelection {
	/** Labels the user picked (one for single-select, many for multiSelect). */
	selectedLabels: string[];
	/** Optional free-text "Other" answer the user typed. */
	otherText?: string;
}

/** True when a selection has at least one label or a non-blank free-text answer. */
export function hasAnswer(selection: QuestionSelection): boolean {
	return selection.selectedLabels.length > 0 || (selection.otherText?.trim().length ?? 0) > 0;
}

/**
 * Format the answers to `questions` into the `message` string. Each question
 * becomes one line: `<header or question>: <answer(s)>`. Multiple selected
 * labels are comma-joined; a non-blank free-text answer is appended. A question
 * with no answer is rendered as `(no answer)` so the model still sees it was
 * skipped rather than silently dropped.
 */
export function encodeQuestionAnswer(
	questions: QuestionForAnswer[],
	selections: QuestionSelection[]
): string {
	const lines = questions.map((q, i) => {
		const selection = selections[i] ?? { selectedLabels: [] };
		const answers = [...selection.selectedLabels];
		const other = selection.otherText?.trim();
		if (other) {
			answers.push(other);
		}
		const label = q.header?.trim() || q.question.trim();
		return `${label}: ${answers.length > 0 ? answers.join(', ') : '(no answer)'}`;
	});
	return lines.join('\n');
}
