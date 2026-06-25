/**
 * Pianola awaiting-input detector - PURE functions.
 *
 * Derives a structured AwaitingInputSignal from an assistant message's text:
 * the unambiguous, high-confidence cases where an agent is clearly waiting on
 * the user (permission requests, plan-mode review, explicit choices, direct
 * questions), plus the extracted options.
 *
 * Why a detector module rather than the parser hot path: the watcher consumes
 * `maestro-cli session show --json` (the SessionHistoryMessage shape, which has
 * no awaiting-input field), so deriving the signal here keeps Pianola cohesive,
 * avoids touching the parser/IPC/WebSocket contracts, and stays pure and
 * testable. The classifier treats a returned signal as authoritative; weaker
 * cues fall through to its heuristics.
 *
 * Precedence: plan_review > permission > choice > question.
 */

import type { AwaitingInputSignal, PianolaMessage } from '../../shared/pianola/types';

/** Plan-mode review: agent is presenting a plan and asking to proceed. */
const PLAN_REVIEW_RE =
	/\b(here'?s\s+(the|my)\s+plan|ready\s+to\s+(code|implement|build)|exit\s+plan\s+mode|proceed\s+with\s+(this|the)\s+plan|approve\s+(the|this)\s+plan|does\s+this\s+plan\s+look|shall\s+i\s+implement\s+(this|the)\s+plan)\b/i;

/** Permission request: agent is asking to be allowed to do something. */
const PERMISSION_RE =
	/\b(do you want me to|would you like me to|may i\b|can i\b|allow me to|permission to|do you approve|is it ok(?:ay)?\s+to|shall i (?:go ahead|proceed)|want me to proceed|ok to proceed|confirm before i)\b/i;

/** Direct decision question intent (only counts when the text is a question). */
const QUESTION_INTENT_RE =
	/\b(should i|shall i|which (?:one|option|approach|do you)|would you prefer|do you want|how (?:should|would) (?:i|we)|what (?:should|would) (?:i|we))\b/i;

/** Extract a discrete option list, if the text presents one. */
function extractOptions(content: string): string[] {
	// Slash/bracket form: [keep/discard], (yes/no)
	const bracket = content.match(/[[(]([^\])]*\/[^\])]*)[\])]/);
	if (bracket) {
		const parts = bracket[1]
			.split('/')
			.map((s) => s.trim())
			.filter(Boolean);
		if (parts.length >= 2) return parts;
	}
	// Numbered form: "1) keep it 2) remove it" (inline or across lines)
	const numbered = [...content.matchAll(/(?:^|\n|\s)\d+[.)]\s+([^\n]+?)(?=(?:\s+\d+[.)]\s)|\n|$)/g)]
		.map((m) => m[1].trim())
		.filter(Boolean);
	if (numbered.length >= 2) return numbered;

	return [];
}

/** A short prompt string: the last question sentence, else the first line. */
function extractPrompt(content: string): string | undefined {
	const trimmed = content.trim();
	if (!trimmed) return undefined;
	const questions = trimmed.match(/[^.?!\n]*\?/g);
	const lastQuestion =
		questions && questions.length > 0 ? questions[questions.length - 1].trim() : '';
	const firstLine = trimmed
		.split('\n')
		.map((l) => l.trim())
		.find(Boolean);
	const prompt = lastQuestion || firstLine || trimmed;
	return prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt;
}

/** Build a signal, omitting an empty options array. */
function signal(
	kind: AwaitingInputSignal['kind'],
	prompt: string | undefined,
	options: string[]
): AwaitingInputSignal {
	return options.length > 0 ? { kind, prompt, options } : { kind, prompt };
}

/**
 * Detect a structured awaiting-input signal in assistant text, or null when
 * there is no high-confidence signal.
 */
export function detectAwaitingInput(content: string): AwaitingInputSignal | null {
	if (!content || !content.trim()) return null;

	const options = extractOptions(content);
	const prompt = extractPrompt(content);

	if (PLAN_REVIEW_RE.test(content)) {
		return signal('plan_review', prompt, options);
	}
	if (PERMISSION_RE.test(content)) {
		return signal('permission', prompt, options);
	}
	if (options.length >= 2) {
		return signal('choice', prompt, options);
	}
	// A question intent only becomes a structured signal when the text is
	// actually a question; weaker phrasing is left to the classifier heuristics.
	if (QUESTION_INTENT_RE.test(content) && content.trim().endsWith('?')) {
		return signal('question', prompt, options);
	}

	return null;
}

/** True if the message is the assistant speaking. */
function isAssistant(message: PianolaMessage): boolean {
	return message.role === 'assistant' || message.source === 'ai';
}

/**
 * Return a copy of the transcript with structured awaiting-input signals filled
 * in for assistant messages that don't already carry one. Pure: inputs are not
 * mutated. The watcher runs this before handing messages to the classifier.
 */
export function enrichWithAwaitingInput(messages: readonly PianolaMessage[]): PianolaMessage[] {
	return messages.map((message) => {
		if (message.awaitingInput || !isAssistant(message)) return message;
		const detected = detectAwaitingInput(message.content);
		return detected ? { ...message, awaitingInput: detected } : message;
	});
}
