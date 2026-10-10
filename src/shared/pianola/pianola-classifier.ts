/**
 * Pianola classifier - PURE functions.
 *
 * Given the tail of an agent transcript, decide whether the agent is asking the
 * user something / is blocked, summarize the topic, and rate the risk of acting
 * on it. No I/O, no Electron, no app state: this is the brain, and it is unit
 * tested against fixture transcripts.
 *
 * Detection prefers a structured AwaitingInputSignal (authoritative, high
 * confidence) and falls back to conservative heuristics over message text. Risk
 * rating lives in pianola-risk.ts.
 */

import type {
	AwaitingInputSignal,
	PianolaClassification,
	PianolaMessage,
	PianolaRisk,
	PianolaSignalKind,
} from './types';
import { maxRisk, rateRisk } from './pianola-risk';
import { extractOptions, looksLikeAsking } from './pianola-awaiting-detector';

// Re-exported for convenience so callers can pull risk helpers from the classifier.
export { riskAtMost, maxRisk } from './pianola-risk';

/** Phrases that strongly suggest the assistant is asking the user to decide. */
const QUESTION_PHRASES = [
	'which would you prefer',
	'would you like',
	'do you want',
	'should i',
	'shall i',
	'let me know',
	'please choose',
	'please confirm',
	'please advise',
	'need your input',
	'need confirmation',
	'waiting for your',
	'how would you like',
	'can you confirm',
	'are you sure',
];

/** Phrases that suggest the agent is blocked / cannot proceed without the user. */
const BLOCKED_PHRASES = [
	'i need',
	'i am blocked',
	"i'm blocked",
	'i cannot proceed',
	"i can't proceed",
	'unable to proceed',
	'requires your',
	'permission to',
	'awaiting approval',
	'needs approval',
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
	return needles.some((n) => haystack.includes(n));
}

/**
 * True if the text presents an explicit set of choices. Reuses the detector's
 * hardened option extraction and asking-context check so both tiers agree (a
 * changelog-style numbered list or an incidental bracket is not a choice).
 */
function hasChoiceMarker(content: string): boolean {
	return extractOptions(content).length >= 2 && looksLikeAsking(content);
}

/** Build a short topic summary from a prompt: first sentence/line, trimmed. */
function summarizeTopic(text: string): string {
	const firstLine = text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	const base = firstLine ?? text.trim();
	const sentence = base.split(/(?<=[.?!])\s/)[0] ?? base;
	const trimmed = sentence.trim();
	return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

/** Is this the assistant speaking (vs user/tool/system)? */
function isAssistant(message: PianolaMessage): boolean {
	return message.role === 'assistant' || message.source === 'ai';
}

/** Find the last assistant message in chronological order. */
function lastAssistantMessage(messages: readonly PianolaMessage[]): PianolaMessage | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (isAssistant(messages[i])) return messages[i];
	}
	return null;
}

/**
 * If the last message is from the user (chronologically after the last
 * assistant turn), the agent is not currently waiting on the user.
 */
function userHasRepliedSince(
	messages: readonly PianolaMessage[],
	assistant: PianolaMessage
): boolean {
	const idx = messages.lastIndexOf(assistant);
	if (idx < 0) return false;
	return messages.slice(idx + 1).some((m) => m.role === 'user');
}

function classifyFromStructured(
	message: PianolaMessage,
	signal: AwaitingInputSignal
): PianolaClassification {
	const promptText = signal.prompt ?? message.content;
	const kind: PianolaSignalKind = signal.kind === 'question' ? 'question' : 'blocked';
	// Risk MUST be rated over the FULL assistant message, never just the
	// extracted prompt. `extractPrompt` keeps only the last question sentence, so
	// "Delete the prod database and drop all tables. Shall I proceed?" collapses
	// to "Shall I proceed?" and loses every destructive keyword. Rating that
	// slice let an attacker- or agent-authored transcript slip a high-risk action
	// past decide()'s high-risk guard and harvest an auto-answer approval. Rate
	// the whole message and the prompt, then keep the most severe, so a truncated
	// prompt can only ever raise the rating, never lower it.
	let risk = maxRisk(rateRisk(message.content ?? ''), rateRisk(promptText));
	if (signal.kind === 'permission' || signal.kind === 'plan_review') {
		risk = maxRisk(risk, 'medium');
	}
	return {
		kind,
		risk,
		topic: summarizeTopic(promptText),
		confidence: 'high',
		evidence: {
			messageId: message.id,
			reason: `structured awaiting-input signal: ${signal.kind}`,
			structured: true,
		},
	};
}

function classifyHeuristic(message: PianolaMessage): PianolaClassification {
	const content = message.content ?? '';
	const lower = content.toLowerCase();
	// "trailing question mark only" means the message ends with '?', not that it
	// contains one somewhere (diagnostic text often contains stray '?').
	const endsWithQuestion = content.trimEnd().endsWith('?');
	const hasQuestionPhrase = containsAny(lower, QUESTION_PHRASES);
	const hasBlockedPhrase = containsAny(lower, BLOCKED_PHRASES);
	const choiceMarker = hasChoiceMarker(content);

	let kind: PianolaSignalKind = 'none';
	let confidence: PianolaClassification['confidence'] = 'low';
	let reason = 'no question or blocked signal detected';

	if (hasQuestionPhrase || choiceMarker) {
		kind = 'question';
		confidence = 'medium';
		reason = choiceMarker ? 'explicit choice marker in text' : 'question phrase in text';
	} else if (hasBlockedPhrase) {
		kind = 'blocked';
		confidence = 'medium';
		reason = 'blocked phrase in text';
	} else if (endsWithQuestion) {
		kind = 'question';
		confidence = 'low';
		reason = 'trailing question mark only';
	}

	return {
		kind,
		risk: kind === 'none' ? 'low' : rateRisk(content),
		topic: kind === 'none' ? '' : summarizeTopic(content),
		confidence,
		evidence: { messageId: kind === 'none' ? null : message.id, reason, structured: false },
	};
}

/**
 * Max risk across EVERY assistant message since the last user turn (the whole
 * current turn), not just the single message we classify. An agent can split a
 * destructive intent ("I'll drop the prod database.") into an earlier assistant
 * message and leave only an innocuous awaiting question ("Ready to continue?") in
 * the last one - the per-message rating would read low and a permissive low-risk
 * auto_answer rule could auto-advance straight into the destructive action,
 * bypassing decide()'s "high-risk always escalates" guard. Folding in the max
 * risk of the full turn means a later question can only ever raise the rating,
 * never launder a high-risk earlier statement down to low.
 */
function currentTurnMaxRisk(messages: readonly PianolaMessage[]): PianolaRisk {
	let risk: PianolaRisk = 'low';
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m.role === 'user') break;
		if (isAssistant(m)) risk = maxRisk(risk, rateRisk(m.content ?? ''));
	}
	return risk;
}

/** A classification meaning "nothing actionable". */
export function noneClassification(reason: string): PianolaClassification {
	return {
		kind: 'none',
		risk: 'low',
		topic: '',
		confidence: 'high',
		evidence: { messageId: null, reason, structured: false },
	};
}

/**
 * Classify the tail of a transcript. Messages must be in chronological order
 * (oldest first), matching `maestro-cli session show --json`.
 */
export function classifyMessages(messages: readonly PianolaMessage[]): PianolaClassification {
	if (messages.length === 0) {
		return noneClassification('empty transcript');
	}

	const assistant = lastAssistantMessage(messages);
	if (!assistant) {
		return noneClassification('no assistant message in transcript');
	}

	// If the user already replied after the last assistant turn, not waiting.
	if (userHasRepliedSince(messages, assistant)) {
		return noneClassification('user has replied since the last assistant turn');
	}

	const classification = assistant.awaitingInput
		? classifyFromStructured(assistant, assistant.awaitingInput)
		: classifyHeuristic(assistant);

	// Nothing actionable - leave the (low) risk untouched; decide() ignores it.
	if (classification.kind === 'none') return classification;

	// Rate risk over the FULL current turn and keep the most severe, so a
	// destructive intent in an earlier assistant message of this turn still
	// escalates even when the awaiting question itself reads low-risk. Preserves
	// the existing kind/topic; only the risk severity incorporates the turn max.
	return { ...classification, risk: maxRisk(classification.risk, currentTurnMaxRisk(messages)) };
}
