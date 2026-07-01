/**
 * @file crossAgentContext.ts
 * @description Pure heuristics for cross-agent @@mentions (Phase 02).
 *
 * Decides *how much* of a source agent's transcript to forward to a target
 * agent. The default is the entire transcript; natural-language hints in the
 * user's message ("the last 5 messages", "this thread", "pull them in on this")
 * narrow the slice.
 *
 * Every export here is a pure function - no IO, no logger, no globals - so it
 * can be unit-tested in isolation and reused from any process.
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * How large a slice of the source transcript to forward.
 * - `full`            - the entire transcript, verbatim (default)
 * - `recent-turns`    - the last N user+assistant pairs
 * - `recent-messages` - the last N conversational (user/ai) messages
 */
export type ContextWindowStrategy =
	| { kind: 'full' }
	| { kind: 'recent-turns'; turns: number }
	| { kind: 'recent-messages'; messages: number };

/**
 * One `@@name` occurrence inside a raw message.
 *
 * `startIndex`/`endIndex` are slice bounds against the original input:
 * `input.slice(startIndex, endIndex) === token` (endIndex is exclusive).
 */
export interface CrossAgentMention {
	/** The full matched text, including the leading `@@` (e.g. `@@review-bot`). */
	token: string;
	/** The name portion without the `@@` prefix (e.g. `review-bot`). */
	mentionName: string;
	/** Index of the first `@` in the input. */
	startIndex: number;
	/** Exclusive end index (one past the last name character). */
	endIndex: number;
}

/**
 * Minimal shape the window heuristics read from a transcript entry: just the
 * `source` discriminant. The renderer `LogEntry` satisfies this, so callers get
 * `selectContextWindow(tab.logs, ...) => LogEntry[]` back via inference - and
 * `src/shared` stays free of a renderer import that would otherwise drag
 * DOM-only renderer code into the main/cli tsconfigs.
 */
export interface TranscriptEntryLike {
	source: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default window for soft "recent" hints that don't name an explicit count. */
export const DEFAULT_RECENT_TURNS = 5;

/**
 * A mention is exactly two `@` followed by one or more name characters.
 *
 * The class is case-insensitive to faithfully match `normalizeMentionName`
 * output (`src/shared/group-chat-types.ts`), which preserves case - e.g.
 * `@@Review-Bot`. Downstream matching folds to lowercase, so restricting the
 * scanner to `[a-z0-9-]` here would silently drop every capitalized agent name.
 */
const MENTION_PATTERN = /@@[A-Za-z0-9-]+/g;

/** A `\w`-equivalent char immediately before `@@` marks a mid-word mention. */
const WORD_CHAR = /[A-Za-z0-9_]/;

// ============================================================================
// MENTION PARSING
// ============================================================================

/**
 * Scan a raw message for `@@name` mentions.
 *
 * Rules:
 * - Matches `@@[A-Za-z0-9-]+`, returned in input order with slice bounds.
 * - Mid-word mentions (`foo@@bar`) are skipped to match completion-UI behavior.
 * - Adjacent `@@@` / `@@@@` runs are treated as a single `@@` plus literal
 *   `@`s and skipped as malformed (a mention preceded by `@`). We stay
 *   conservative and drop these rather than emit a garbage token.
 */
export function parseAgentMentions(input: string): CrossAgentMention[] {
	if (!input) return [];

	const mentions: CrossAgentMention[] = [];
	// Fresh RegExp so the shared `lastIndex` state never leaks between calls.
	const scanner = new RegExp(MENTION_PATTERN.source, 'g');
	let match: RegExpExecArray | null;

	while ((match = scanner.exec(input)) !== null) {
		const startIndex = match.index;
		const prevChar = startIndex > 0 ? input[startIndex - 1] : '';

		// Reject mid-word mentions and `@@@`-style runs: a preceding word char
		// means we're glued to another token, and a preceding `@` means this is
		// the tail of an over-long `@` run.
		if (prevChar && (prevChar === '@' || WORD_CHAR.test(prevChar))) {
			continue;
		}

		const token = match[0];
		mentions.push({
			token,
			mentionName: token.slice(2),
			startIndex,
			endIndex: startIndex + token.length,
		});
	}

	return mentions;
}

/**
 * Remove every `@@mention` token from a message, leaving the surrounding text
 * (and any incidental whitespace) intact. Used so context-hint matching runs
 * against the user's prose, not the mention tokens.
 */
function stripMentions(message: string): string {
	const mentions = parseAgentMentions(message);
	if (mentions.length === 0) return message;

	let result = '';
	let cursor = 0;
	for (const mention of mentions) {
		result += message.slice(cursor, mention.startIndex);
		cursor = mention.endIndex;
	}
	result += message.slice(cursor);
	return result;
}

// ============================================================================
// CONTEXT STRATEGY INFERENCE
// ============================================================================

/** Explicit count with a unit: "last 5 messages", "last 3 turns", "last 2 exchanges". */
const EXPLICIT_UNIT = /\blast\s+(\d+)\s+(messages?|turns?|exchanges?)\b/;
/** Unit-less share: "share the last 10" - defaults to messages. */
const SHARE_LAST = /\bshare\s+(?:the\s+)?last\s+(\d+)\b/;
/** Soft "recent" hints that imply a small trailing window. */
const SOFT_HINT =
	/most recent|this (?:matter|topic|thread)|recent (?:matter|topic|thread)|pull .* in on this/;

/**
 * Infer a context-window strategy from the user's message.
 *
 * Matching is case-insensitive and runs against the message with its `@@`
 * mentions stripped out. Priority order (first hit wins):
 *   1. An explicit count with a unit -> recent-messages / recent-turns.
 *   1b. A unit-less "share the last N" -> recent-messages.
 *   2. A soft "recent" hint -> recent-turns of DEFAULT_RECENT_TURNS.
 *   3. Otherwise -> full transcript.
 *
 * An explicit count always wins over a soft hint because it is checked first.
 */
export function inferContextStrategy(message: string): ContextWindowStrategy {
	const cleaned = stripMentions(message).toLowerCase();

	// Priority 1: explicit count with an explicit unit.
	const unitMatch = cleaned.match(EXPLICIT_UNIT);
	if (unitMatch) {
		const count = Number.parseInt(unitMatch[1], 10);
		if (count > 0) {
			// "message(s)" -> messages; "turn(s)" / "exchange(s)" -> turns.
			return unitMatch[2].startsWith('message')
				? { kind: 'recent-messages', messages: count }
				: { kind: 'recent-turns', turns: count };
		}
	}

	// Priority 1b: "share (the) last N" with no unit -> messages.
	const shareMatch = cleaned.match(SHARE_LAST);
	if (shareMatch) {
		const count = Number.parseInt(shareMatch[1], 10);
		if (count > 0) {
			return { kind: 'recent-messages', messages: count };
		}
	}

	// Priority 2: soft "recent" hints -> a sensible default window of turns.
	if (SOFT_HINT.test(cleaned)) {
		return { kind: 'recent-turns', turns: DEFAULT_RECENT_TURNS };
	}

	// Priority 3: everything else -> the full transcript.
	return { kind: 'full' };
}

// ============================================================================
// CONTEXT WINDOW SELECTION
// ============================================================================

/** Conversational entries are the ones we count against; the rest are context. */
function isConversational(entry: TranscriptEntryLike): boolean {
	return entry.source === 'user' || entry.source === 'ai';
}

/**
 * Tail-slice `logs` so the result contains the last `count` conversational
 * (user/ai) entries, keeping any tool/thinking/system entries that fall inside
 * that bounding range so the slice stays coherent. If there are fewer than
 * `count` conversational entries, the whole transcript is returned.
 */
function tailByConversationalCount<T extends TranscriptEntryLike>(logs: T[], count: number): T[] {
	if (count <= 0) return [];

	let seen = 0;
	for (let i = logs.length - 1; i >= 0; i--) {
		if (isConversational(logs[i])) {
			seen++;
			if (seen === count) return logs.slice(i);
		}
	}

	// Fewer conversational entries than requested - forward everything.
	return logs.slice();
}

/**
 * Select the slice of `logs` to forward for the given strategy.
 *
 * - `full`            -> a shallow clone of every entry (never the input array
 *   reference, so callers can't mutate the source store through the result).
 * - `recent-messages` -> the last N user/ai entries plus any interleaved
 *   tool/thinking/system entries that fall inside that window.
 * - `recent-turns`    -> the last N user+assistant pairs, treated as 2*N
 *   conversational entries (turn ~= a user+assistant pair), same coherence rule.
 *
 * Generic over the entry type so a `LogEntry[]` in returns a `LogEntry[]` out.
 */
export function selectContextWindow<T extends TranscriptEntryLike>(
	logs: T[],
	strategy: ContextWindowStrategy
): T[] {
	switch (strategy.kind) {
		case 'full':
			return logs.slice();
		case 'recent-messages':
			return tailByConversationalCount(logs, strategy.messages);
		case 'recent-turns':
			return tailByConversationalCount(logs, strategy.turns * 2);
	}
}
