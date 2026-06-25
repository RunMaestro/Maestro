/**
 * Pianola classifier - PURE functions.
 *
 * Given the tail of an agent transcript, decide whether the agent is asking the
 * user something / is blocked, summarize the topic, and rate the risk of acting
 * on it. No I/O, no Electron, no app state: this is the brain, and it is unit
 * tested against fixture transcripts.
 *
 * Detection prefers a structured AwaitingInputSignal (authoritative, high
 * confidence) and falls back to conservative heuristics over message text.
 */

import type {
	AwaitingInputSignal,
	PianolaClassification,
	PianolaMessage,
	PianolaRisk,
	PianolaSignalKind,
} from '../../shared/pianola/types';

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

/** High-risk: destructive, security-sensitive, or irreversible/outward-facing. */
const HIGH_RISK_TERMS = [
	'delete',
	'rm -rf',
	'drop table',
	'drop database',
	'truncate',
	'force push',
	'force-push',
	'git push --force',
	'reset --hard',
	'deploy',
	'production',
	'prod ',
	'secret',
	'secrets',
	'password',
	'credential',
	'api key',
	'api-key',
	'token',
	'auth',
	'payment',
	'charge',
	'invoice',
	'migrate',
	'migration',
	'wipe',
	'overwrite',
	'revoke',
	'sudo',
];

/** Medium-risk: meaningful but recoverable engineering choices. */
const MEDIUM_RISK_TERMS = [
	'install',
	'upgrade',
	'downgrade',
	'bump',
	'dependency',
	'dependencies',
	'package',
	'refactor',
	'rename',
	'move file',
	'delete comment',
	'test strategy',
	'restructure',
	'schema',
	'config',
];

const RISK_ORDER: Record<PianolaRisk, number> = { low: 0, medium: 1, high: 2 };

/** True if risk `a` is at most as severe as `b`. */
export function riskAtMost(a: PianolaRisk, b: PianolaRisk): boolean {
	return RISK_ORDER[a] <= RISK_ORDER[b];
}

/** The more severe of two risks. */
export function maxRisk(a: PianolaRisk, b: PianolaRisk): PianolaRisk {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
	return needles.some((n) => haystack.includes(n));
}

/** Rate risk from free text. */
function rateRisk(text: string): PianolaRisk {
	const lower = text.toLowerCase();
	if (containsAny(lower, HIGH_RISK_TERMS)) return 'high';
	if (containsAny(lower, MEDIUM_RISK_TERMS)) return 'medium';
	return 'low';
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
	// Permission/plan-review prompts inherit risk from what is being requested.
	let risk = rateRisk(promptText);
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
	const hasQuestionMark = content.includes('?');
	const hasQuestionPhrase = containsAny(lower, QUESTION_PHRASES);
	const hasBlockedPhrase = containsAny(lower, BLOCKED_PHRASES);
	// Bracketed prompts like [y/n], (yes/no), 1) ... 2) ...
	const hasChoiceMarker = /\[[^\]]*\/[^\]]*\]|\((?:y\/n|yes\/no)\)/i.test(content);

	let kind: PianolaSignalKind = 'none';
	let confidence: PianolaClassification['confidence'] = 'low';
	let reason = 'no question or blocked signal detected';

	if (hasQuestionPhrase || hasChoiceMarker) {
		kind = 'question';
		confidence = 'medium';
		reason = hasChoiceMarker ? 'explicit choice marker in text' : 'question phrase in text';
	} else if (hasBlockedPhrase) {
		kind = 'blocked';
		confidence = 'medium';
		reason = 'blocked phrase in text';
	} else if (hasQuestionMark) {
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

	if (assistant.awaitingInput) {
		return classifyFromStructured(assistant, assistant.awaitingInput);
	}

	return classifyHeuristic(assistant);
}
