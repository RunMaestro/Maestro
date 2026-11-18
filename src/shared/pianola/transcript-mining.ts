/**
 * Pianola - transcript mining (PURE, runtime-agnostic).
 *
 * Reads the user's installed-CLI native transcripts and extracts a labeled
 * "decision corpus": every moment an agent stopped and waited on the user,
 * paired with how the user actually replied. This is the raw material Pianola
 * learns from to decide the way the user does (see v3 in the plan).
 *
 * This module is pure: line parsing, pairing, polarity, and aggregation. All
 * filesystem walking lives in the CLI command (`pianola learn`) so this stays
 * unit-testable with string fixtures and reusable across runtimes.
 *
 * Parsing reuses the existing pure brain: enrichWithAwaitingInput + classifyMessages.
 */

import type { PianolaMessage, PianolaClassification } from './types';
import { classifyMessages } from './pianola-classifier';
import { enrichWithAwaitingInput } from './pianola-awaiting-detector';
import {
	isValidHumanDecisionEvidence,
	type PianolaHumanDecisionEvidence,
	type PianolaDecisionRecord,
} from './storage';
import { canonicalJson } from '../canonicalJson';
import { redactSecrets } from '../redactSecrets';

/** Which installed agent a transcript came from. */
export type TranscriptAgent = 'claude-code' | 'codex' | 'grok';

/**
 * Where a mined Grok pair came from in its native `chat_history.jsonl`. Grok
 * rows carry no IDs or timestamps, so the 1-based source line is the only
 * stable provenance (the same `grok-line-N` identity the session reader uses).
 */
export interface GrokDecisionProvenance {
	format: 'grok-chat-history';
	askLine: number;
	replyLine: number;
}

/**
 * Grok's model-visible history records the assistant's prose and the user's
 * typed replies, but not the outcome of a tool-permission prompt: approvals
 * live in the UI replay stream (`updates.jsonl`), whose row schema is not
 * pinned. Mining therefore covers prose asks only and reports permission
 * decisions as unsupported instead of inferring them from assistant text.
 */
export const GROK_PERMISSION_DECISIONS_UNSUPPORTED = {
	code: 'grok-permission-decisions-unrecorded',
	reason:
		'Grok chat_history.jsonl does not record tool-permission decisions; the updates.jsonl row schema is not pinned, so permission prompts are not mined.',
} as const;

/** Coarse read of how the user responded to an awaiting-input moment. */
export type ReplyPolarity = 'affirmative' | 'negative' | 'other';

/** One mined "agent asked -> user answered" decision. */
export interface DecisionPair {
	agent: TranscriptAgent | 'native';
	sessionId: string;
	projectPath?: string;
	/** Classification of the ask (kind / risk / topic), from the shared classifier. */
	classification: PianolaClassification;
	/** Truncated text of the assistant turn that awaited input. */
	ask: string;
	/** Truncated text of the user's reply. */
	reply: string;
	/** Coarse polarity of the reply, for hard-rule hints. */
	polarity: ReplyPolarity;
	askedAt: string;
	repliedAt: string;
	/** Missing provenance remains inspectable but is never a learning sample. */
	evidence?: PianolaHumanDecisionEvidence;
	/** Conflicting snapshots of one source veto learning without increasing count. */
	conflictingEvidence?: boolean;
	/** Native source lines of the ask and the reply (Grok only). */
	provenance?: GrokDecisionProvenance;
}

/** Convert committed explicit human resolutions. Recipient delivery is a separate outcome.
 * Legacy/rule/manager records are not evidence, even when their send was accepted.
 */
export function settledDecisionPairs(
	records: readonly PianolaDecisionRecord[],
	options: { snapshots?: boolean } = {}
): DecisionPair[] {
	const pairs: DecisionPair[] = [];
	for (const record of records) {
		const evidence = record.humanEvidence;
		if (
			!isValidHumanDecisionEvidence(evidence) ||
			record.dryRun ||
			record.lifecycle?.phase !== 'answer' ||
			record.lifecycle.source.kind !== 'human' ||
			record.lifecycle.source.actorId !== evidence.actorId ||
			record.lifecycle.groupId !== evidence.groupId ||
			record.decision.action !== 'auto_answer' ||
			record.decision.answer !== evidence.answer ||
			record.agentId !== evidence.agentId ||
			record.tabId !== evidence.tabId ||
			record.classification.evidence.messageId !== evidence.questionMessageId
		)
			continue;
		pairs.push({
			agent: 'native',
			sessionId: record.tabId,
			projectPath: record.projectPath,
			classification: record.classification,
			ask: evidence.question,
			reply: evidence.answer,
			polarity: replyPolarity(evidence.answer),
			askedAt: evidence.askedAt,
			repliedAt: evidence.answeredAt,
			evidence,
		});
	}
	// Conflict review needs the actual corrected source, not only the first
	// independent sample plus a veto flag. Counting callers keep the folded view.
	return options.snapshots ? pairs : confirmedHumanDecisionPairs(pairs);
}

/** Dedup by recipient ask AND answer event, never by a generic yes or risk label. */
export function confirmedHumanDecisionPairs(pairs: readonly DecisionPair[]): DecisionPair[] {
	const asks = new Map<string, DecisionPair>();
	const answers = new Set<string>();
	const confirmed: DecisionPair[] = [];
	for (const pair of pairs) {
		const evidence = pair.evidence;
		if (
			!isValidHumanDecisionEvidence(evidence) ||
			pair.ask !== evidence.question ||
			pair.reply !== evidence.answer ||
			pair.sessionId !== evidence.tabId ||
			pair.classification.evidence.messageId !== evidence.questionMessageId ||
			pair.askedAt !== evidence.askedAt ||
			pair.repliedAt !== evidence.answeredAt
		)
			continue;
		const askKey = canonicalJson([evidence.agentId, evidence.tabId, evidence.questionMessageId]);
		const answerKey = canonicalJson([evidence.actorId, evidence.answerMessageId]);
		const previous = asks.get(askKey);
		if (previous) {
			if (
				canonicalJson([previous.evidence, previous.classification]) !==
					canonicalJson([pair.evidence, pair.classification]) ||
				pair.conflictingEvidence
			)
				previous.conflictingEvidence = true;
			continue;
		}
		if (answers.has(answerKey)) continue;
		const sample = { ...pair };
		asks.set(askKey, sample);
		answers.add(answerKey);
		confirmed.push(sample);
	}
	return confirmed;
}

/** Aggregate view over a set of decision pairs. */
export interface DecisionAggregates {
	total: number;
	byRisk: Record<string, number>;
	byPolarity: Record<ReplyPolarity, number>;
	/**
	 * risk -> polarity -> count. The meaningful cross-tab: it shows how the user
	 * tends to respond at each risk level (e.g. low-risk asks are mostly approved,
	 * high-risk asks get substantive replies). Replaces topic clustering, which was
	 * noise: the classifier's `topic` is a per-ask snippet, not a stable category.
	 */
	byRiskPolarity: Record<string, Record<ReplyPolarity, number>>;
}

/** Max characters kept for ask/reply excerpts in the corpus. */
const EXCERPT_LIMIT = 400;
/** How many messages of context to classify ending at the awaiting turn. */
const CLASSIFY_WINDOW = 5;

/**
 * Max bytes for a single JSONL transcript line we will parse. A pathologically
 * large line (e.g. a multi-megabyte tool dump serialized onto one line) is
 * skipped before any parse/regex-heavy classification runs, bounding CPU and
 * memory regardless of how hostile a local transcript is. We compare UTF-16
 * code-unit length, a lower bound on UTF-8 byte length, so a line over this many
 * code units is always over the byte cap and safe to drop.
 */
const MAX_MINED_LINE_BYTES = 256 * 1024;
/** Max chars of flattened message content handed to the classifier. */
const MAX_FLATTENED_MESSAGE_CHARS = 100_000;

/** Cap flattened content so one huge message cannot dominate classification. */
function capFlattened(text: string): string {
	return text.length > MAX_FLATTENED_MESSAGE_CHARS
		? text.slice(0, MAX_FLATTENED_MESSAGE_CHARS)
		: text;
}

function truncate(text: string, limit = EXCERPT_LIMIT): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}...`;
}

/**
 * Flatten a transcript message's `content` into plain text. Content may be a
 * bare string (typed user text) or an array of blocks (Claude/Codex/Grok). Only text
 * is kept: tool-use and tool-result blocks contribute nothing, so a "user" turn
 * that is purely a tool result flattens to empty and is dropped as non-human.
 */
export function flattenContent(content: unknown): string {
	if (typeof content === 'string') return capFlattened(content);
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === 'string') {
			parts.push(block);
			continue;
		}
		if (block && typeof block === 'object') {
			const text = (block as { text?: unknown }).text;
			if (typeof text === 'string' && text.length > 0) parts.push(text);
		}
	}
	return capFlattened(parts.join('\n').trim());
}

function safeParse(line: string): Record<string, unknown> | null {
	// Skip pathologically large lines before any parse/regex work touches them.
	if (line.length > MAX_MINED_LINE_BYTES) return null;
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function asRole(value: unknown): PianolaMessage['role'] | null {
	return value === 'user' || value === 'assistant' ? value : null;
}

/**
 * Parse one Claude Code transcript line into a normalized message, or null for
 * lines that are not a human/assistant conversation turn (headers, hook output,
 * sidechains, tool-result-only user turns).
 */
export function parseClaudeTranscriptLine(line: string): PianolaMessage | null {
	const obj = safeParse(line);
	if (!obj) return null;
	// Sub-agent sidechains are not the main conversation the user steered.
	if (obj.isSidechain === true) return null;
	const message = obj.message as { role?: unknown; content?: unknown } | undefined;
	if (!message || typeof message !== 'object') return null;
	const role = asRole(message.role);
	if (!role) return null;
	const content = flattenContent(message.content);
	// A user turn with no text is a tool-result echo, not a human reply.
	if (content.length === 0) return null;
	return {
		id: typeof obj.uuid === 'string' ? obj.uuid : `${role}-${String(obj.timestamp ?? '')}`,
		role,
		source: role,
		content,
		timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
	};
}

/**
 * Parse one Codex transcript line into a normalized message, or null for any
 * line that is not a conversation message (session_meta, turn metadata, custom
 * title, tool calls/outputs). Codex messages are `type: 'response_item'` with a
 * `payload` of `{ type: 'message', role, content: [{ type, text }] }`.
 */
export function parseCodexTranscriptLine(line: string): PianolaMessage | null {
	const obj = safeParse(line);
	if (!obj) return null;
	if (obj.type !== 'response_item') return null;
	const payload = obj.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
	if (!payload || typeof payload !== 'object' || payload.type !== 'message') return null;
	const role = asRole(payload.role);
	if (!role) return null;
	const content = flattenContent(payload.content);
	if (content.length === 0) return null;
	return {
		id: typeof obj.id === 'string' ? obj.id : `${role}-${String(obj.timestamp ?? '')}`,
		role,
		source: role,
		content,
		timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
	};
}

/**
 * `synthetic_reason` values Grok stamps on a record a person typed. Absent is a
 * plain prompt. Mirrors the session reader's `isSyntheticUserRecord`
 * (`src/main/storage/grok-session-storage.ts`) minus two values that are not a
 * reply in this conversation: `parent_human_message` is the parent's message
 * echoed into a subagent (Claude's sidechain analog) and `direct_bash` is a
 * shell command the user ran, not an answer.
 */
const GROK_HUMAN_SYNTHETIC_REASONS = new Set(['human', 'interjection']);

/** Mining line id, matching the session reader's `grok-line-N` identity. */
const GROK_LINE_ID = /^grok-line-(\d+)$/;

/** Strip the `<user_query>` wrappers Grok puts around a typed prompt. */
function stripGrokUserQuery(text: string): string {
	const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)];
	if (matches.length === 0) return text.trim();
	return matches
		.map((m) => m[1])
		.filter((part) => part.trim().length > 0)
		.join('\n\n');
}

/**
 * Parse one line of a Grok `chat_history.jsonl` (format 1 `ConversationItem`
 * rows keyed by `type`, legacy rows keyed by `role`) into a normalized message.
 * Only a person's typed text and the assistant's prose survive: system,
 * reasoning, tool_result and backend tool rows, injected context
 * (`synthetic_reason`, the `<user_info>` environment block) and tool-call-only
 * assistant rows return null. `lineNumber` is the 1-based source line, kept as
 * the id because Grok rows carry neither IDs nor timestamps. Text is redacted
 * before it reaches the classifier or the corpus.
 */
export function parseGrokTranscriptLine(line: string, lineNumber: number): PianolaMessage | null {
	const obj = safeParse(line);
	if (!obj) return null;
	const role = asRole(obj.type ?? obj.role);
	if (!role) return null;
	let content = flattenContent(obj.content);
	if (role === 'user') {
		const reason = obj.synthetic_reason;
		if (reason !== undefined && !GROK_HUMAN_SYNTHETIC_REASONS.has(String(reason))) return null;
		if (content.trim().startsWith('<user_info>')) return null;
		content = stripGrokUserQuery(content);
	}
	if (content.length === 0) return null;
	return {
		id: `grok-line-${lineNumber}`,
		role,
		source: role,
		content: redactSecrets(content).text,
		timestamp: '',
	};
}

/**
 * The project path of a Grok session from its transcript location
 * `<GROK_HOME>/sessions/<percent-encoded cwd>/<session id>/chat_history.jsonl`.
 * Undefined when the folder name does not decode.
 */
export function parseGrokCwdFromSessionDir(encodedCwd: string): string | undefined {
	try {
		const decoded = decodeURIComponent(encodedCwd);
		return decoded.length > 0 ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/** Read the originating project path (cwd) from a Codex session_meta line. */
export function parseCodexCwd(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj || obj.type !== 'session_meta') return undefined;
	const payload = obj.payload as { cwd?: unknown } | undefined;
	return payload && typeof payload.cwd === 'string' ? payload.cwd : undefined;
}

/** Read the originating project path (cwd) from a Claude transcript line. */
export function parseClaudeCwd(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	return typeof obj.cwd === 'string' ? obj.cwd : undefined;
}

const AFFIRMATIVE_RE =
	/^(y|ye|yes|yep|yeah|yup|sure|ok|okay|k|go ahead|go for it|proceed|approve|approved|do it|sounds good|lgtm|looks good|confirm|confirmed|continue|please do|👍|✅)\b/i;
const NEGATIVE_RE =
	/^(n|no|nope|nah|don'?t|do not|stop|cancel|abort|reject|rejected|hold on|wait|never|skip|leave it|undo|revert)\b/i;

/** Coarse polarity of a user reply, used only as a hint for hard-rule mining. */
export function replyPolarity(reply: string): ReplyPolarity {
	const head = reply.trim().slice(0, 40);
	if (!head) return 'other';
	if (AFFIRMATIVE_RE.test(head)) return 'affirmative';
	if (NEGATIVE_RE.test(head)) return 'negative';
	return 'other';
}

/**
 * Extract decision pairs from one transcript's normalized messages. For each
 * assistant turn followed by a user reply, classify a short window ending at
 * that turn; if it reads as a real ask (kind !== 'none'), pair it with the reply.
 *
 * The trigger is the classifier itself, not the strict structured awaiting-input
 * detector. classifyMessages uses the structured signal when present and falls
 * back to heuristics (question phrases, choice markers, trailing '?'), so this
 * captures prose-style asks the structured detector misses. That is the right
 * recall for mining: the LLM filters false positives downstream in Phase 2, and
 * the live watcher is untouched (it keeps its own conservative gating).
 */
export function extractDecisionPairs(
	messages: readonly PianolaMessage[],
	meta: { agent: TranscriptAgent; sessionId: string; projectPath?: string }
): DecisionPair[] {
	const enriched = enrichWithAwaitingInput(messages);
	const pairs: DecisionPair[] = [];

	for (let i = 0; i < enriched.length; i++) {
		const turn = enriched[i];
		if (turn.role !== 'assistant') continue;

		// Find the user's reply: the next non-empty user turn after the ask.
		let reply: PianolaMessage | undefined;
		for (let j = i + 1; j < enriched.length; j++) {
			if (enriched[j].role === 'user') {
				reply = enriched[j];
				break;
			}
		}
		if (!reply) continue;

		const window = enriched.slice(Math.max(0, i - (CLASSIFY_WINDOW - 1)), i + 1);
		const classification = classifyMessages(window);
		if (classification.kind === 'none') continue;

		pairs.push({
			agent: meta.agent,
			sessionId: meta.sessionId,
			projectPath: meta.projectPath,
			classification,
			ask: truncate(turn.content),
			reply: truncate(reply.content),
			polarity: replyPolarity(reply.content),
			askedAt: turn.timestamp,
			repliedAt: reply.timestamp,
			...(meta.agent === 'grok' ? grokProvenance(turn.id, reply.id) : {}),
		});
	}

	return pairs;
}

/** Source-line provenance for a Grok pair, when both ids are Grok line ids. */
function grokProvenance(
	askId: string,
	replyId: string
): { provenance: GrokDecisionProvenance } | Record<string, never> {
	const ask = GROK_LINE_ID.exec(askId);
	const reply = GROK_LINE_ID.exec(replyId);
	if (!ask || !reply) return {};
	return {
		provenance: {
			format: 'grok-chat-history',
			askLine: Number(ask[1]),
			replyLine: Number(reply[1]),
		},
	};
}

function emptyPolarityCounts(): Record<ReplyPolarity, number> {
	return { affirmative: 0, negative: 0, other: 0 };
}

/** Roll a set of decision pairs up into risk counts and a risk x polarity cross-tab. */
export function aggregateDecisionPairs(pairs: readonly DecisionPair[]): DecisionAggregates {
	const byRisk: Record<string, number> = {};
	const byPolarity = emptyPolarityCounts();
	const byRiskPolarity: Record<string, Record<ReplyPolarity, number>> = {};

	const confirmed = confirmedHumanDecisionPairs(pairs);
	for (const pair of confirmed) {
		const risk = pair.classification.risk;
		byRisk[risk] = (byRisk[risk] ?? 0) + 1;
		byPolarity[pair.polarity] += 1;
		if (!byRiskPolarity[risk]) byRiskPolarity[risk] = emptyPolarityCounts();
		byRiskPolarity[risk][pair.polarity] += 1;
	}

	return { total: confirmed.length, byRisk, byPolarity, byRiskPolarity };
}
