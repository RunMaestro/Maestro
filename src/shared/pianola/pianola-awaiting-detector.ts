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
 * Hardening: option extraction is deliberately strict (short, word-like tokens;
 * no file paths, markdown links, version numbers, or sentences), and a "choice"
 * is only emitted when the text actually reads like a question/choice. This
 * stops ordinary prose - including an adversarial transcript - from being shaped
 * into a structured choice that could trip an auto-answer rule.
 *
 * Precedence: plan_review > permission > choice > question.
 */

import type { AwaitingInputSignal, PianolaMessage } from './types';

/** Plan-mode review: agent is presenting a plan and asking to proceed. */
const PLAN_REVIEW_RE =
	/\b(here'?s\s+(the|my)\s+plan|ready\s+to\s+(code|implement|build)|exit\s+plan\s+mode|proceed\s+with\s+(this|the)\s+plan|approve\s+(the|this)\s+plan|does\s+this\s+plan\s+look|shall\s+i\s+implement\s+(this|the)\s+plan)\b/i;

/** Permission request: agent is asking to be allowed to do something. */
const PERMISSION_RE =
	/\b(do you want me to|would you like me to|may i\b|can i\b|allow me to|permission to|do you approve|is it ok(?:ay)?\s+to|shall i (?:go ahead|proceed)|want me to proceed|ok to proceed|confirm before i)\b/i;

/** Direct decision question intent (only counts when the text is a question). */
const QUESTION_INTENT_RE =
	/\b(should i|shall i|which (?:one|option|approach|do you)|would you prefer|do you want|how (?:should|would) (?:i|we)|what (?:should|would) (?:i|we))\b/i;

/** Words that signal the text is inviting a choice/decision. */
const CHOICE_CONTEXT_RE = /\b(choose|choice|which|option|options|prefer|proceed|select|pick|or)\b/i;

/** True if the text reads like it is asking the user to decide. */
export function looksLikeAsking(content: string): boolean {
	return (
		content.trim().endsWith('?') ||
		QUESTION_INTENT_RE.test(content) ||
		CHOICE_CONTEXT_RE.test(content)
	);
}

/**
 * A clean option token: starts with a letter, short, word-like (letters,
 * digits, spaces, +/-). Rejects file paths (foo.ts), urls, version numbers, and
 * full sentences so prose is not mistaken for a discrete option.
 */
function isCleanOptionToken(token: string): boolean {
	return /^[a-zA-Z][\w +-]{0,23}$/.test(token);
}

/**
 * Extract a discrete option list, if the text presents one. Returns [] unless it
 * finds 2-5 clean tokens in a slash/bracket form ([keep/discard], (y/n)) or a
 * numbered list (1) a 2) b). Markdown links ([label](url)) are rejected.
 */
export function extractOptions(content: string): string[] {
	// Slash/bracket form: [keep/discard], (yes/no). Not a markdown link.
	const bracket = content.match(/[[(]\s*([^[\]()]*\/[^[\]()]*?)\s*[\])](?!\()/);
	if (bracket) {
		const parts = bracket[1]
			.split('/')
			.map((s) => s.trim())
			.filter(Boolean);
		if (parts.length >= 2 && parts.length <= 5 && parts.every(isCleanOptionToken)) {
			return parts;
		}
	}
	// Numbered form: "1) keep it 2) remove it" (inline or across lines).
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
		// Plan steps are not pickable options; report the kind only.
		return { kind: 'plan_review', prompt };
	}
	if (PERMISSION_RE.test(content)) {
		return signal('permission', prompt, options);
	}
	// A choice needs both a real option list AND a question/choice context, so
	// changelog-style numbered lists and incidental brackets are not choices.
	if (options.length >= 2 && looksLikeAsking(content)) {
		return signal('choice', prompt, options);
	}
	// A question intent only becomes a structured signal when the text is
	// actually a question; weaker phrasing is left to the classifier heuristics.
	if (QUESTION_INTENT_RE.test(content) && content.trim().endsWith('?')) {
		return { kind: 'question', prompt };
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
