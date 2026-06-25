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

import type {
	PianolaMessage,
	PianolaClassification,
	PianolaSignalKind,
	PianolaRisk,
} from './types';
import { classifyMessages } from './pianola-classifier';
import { enrichWithAwaitingInput } from './pianola-awaiting-detector';

/** Which installed agent a transcript came from. */
export type TranscriptAgent = 'claude-code' | 'codex';

/** Coarse read of how the user responded to an awaiting-input moment. */
export type ReplyPolarity = 'affirmative' | 'negative' | 'other';

/** One mined "agent asked -> user answered" decision. */
export interface DecisionPair {
	agent: TranscriptAgent;
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
}

/** Per-topic rollup with polarity split, for surfacing dominant patterns. */
export interface TopicRollup {
	topic: string;
	count: number;
	affirmative: number;
	negative: number;
	other: number;
}

/** Aggregate view over a set of decision pairs. */
export interface DecisionAggregates {
	total: number;
	byKind: Record<string, number>;
	byRisk: Record<string, number>;
	byPolarity: Record<ReplyPolarity, number>;
	topTopics: TopicRollup[];
}

/** Max characters kept for ask/reply excerpts in the corpus. */
const EXCERPT_LIMIT = 400;
/** How many messages of context to classify ending at the awaiting turn. */
const CLASSIFY_WINDOW = 5;

function truncate(text: string, limit = EXCERPT_LIMIT): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}...`;
}

/**
 * Flatten a transcript message's `content` into plain text. Content may be a
 * bare string (typed user text) or an array of blocks (Claude/Codex). Only text
 * is kept: tool-use and tool-result blocks contribute nothing, so a "user" turn
 * that is purely a tool result flattens to empty and is dropped as non-human.
 */
export function flattenContent(content: unknown): string {
	if (typeof content === 'string') return content;
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
	return parts.join('\n').trim();
}

function safeParse(line: string): Record<string, unknown> | null {
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
 * assistant turn flagged as awaiting input, classify a short window ending at
 * that turn and pair it with the next non-empty user turn. Turns that classify
 * as 'none' (no real ask) are skipped.
 */
export function extractDecisionPairs(
	messages: readonly PianolaMessage[],
	meta: { agent: TranscriptAgent; sessionId: string; projectPath?: string }
): DecisionPair[] {
	const enriched = enrichWithAwaitingInput(messages);
	const pairs: DecisionPair[] = [];

	for (let i = 0; i < enriched.length; i++) {
		const turn = enriched[i];
		if (turn.role !== 'assistant' || !turn.awaitingInput) continue;

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
		});
	}

	return pairs;
}

/** Roll a set of decision pairs up into counts and dominant topics. */
export function aggregateDecisionPairs(
	pairs: readonly DecisionPair[],
	topN = 15
): DecisionAggregates {
	const byKind: Record<string, number> = {};
	const byRisk: Record<string, number> = {};
	const byPolarity: Record<ReplyPolarity, number> = { affirmative: 0, negative: 0, other: 0 };
	const topicMap = new Map<string, TopicRollup>();

	for (const pair of pairs) {
		const kind: PianolaSignalKind = pair.classification.kind;
		const risk: PianolaRisk = pair.classification.risk;
		byKind[kind] = (byKind[kind] ?? 0) + 1;
		byRisk[risk] = (byRisk[risk] ?? 0) + 1;
		byPolarity[pair.polarity] += 1;

		const topic = pair.classification.topic || '(untopiced)';
		const rollup = topicMap.get(topic) ?? {
			topic,
			count: 0,
			affirmative: 0,
			negative: 0,
			other: 0,
		};
		rollup.count += 1;
		rollup[pair.polarity] += 1;
		topicMap.set(topic, rollup);
	}

	const topTopics = [...topicMap.values()].sort((a, b) => b.count - a.count).slice(0, topN);

	return { total: pairs.length, byKind, byRisk, byPolarity, topTopics };
}
