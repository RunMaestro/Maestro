/**
 * @file crossAgentContext.ts
 * @description Pure heuristics for cross-agent @mentions (Phase 02).
 *
 * Decides *how much* of a source agent's transcript to forward to a target
 * agent. The default is the entire transcript; natural-language hints in the
 * user's message ("the last 5 messages", "this thread", "pull them in on this")
 * narrow the slice.
 *
 * Every export here is a pure function - no IO, no logger, no globals - so it
 * can be unit-tested in isolation and reused from any process.
 */

import { scanMentionSpans } from './mentionPatterns';

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
 * One `@name` occurrence inside a raw message.
 *
 * `startIndex`/`endIndex` are slice bounds against the original input:
 * `input.slice(startIndex, endIndex) === token` (endIndex is exclusive).
 */
export interface CrossAgentMention {
	/** The full matched text, including the leading `@` (e.g. `@review-bot`). */
	token: string;
	/** The name portion without the `@` prefix (e.g. `review-bot`). */
	mentionName: string;
	/** Index of the `@` in the input. */
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

// ============================================================================
// MENTION PARSING
// ============================================================================

/**
 * Scan a raw message for `@name` agent/group mentions.
 *
 * Delegates the actual scanning + classification to {@link scanMentionSpans}
 * (shared/mentionPatterns), so the dispatch scanner, the `@` picker, and the
 * chip overlay all key off one definition.
 *
 * Rules (all enforced by the shared scanner):
 * - A bare-word body (`@review-bot`, `@Codex`) is an agent candidate, returned
 *   in input order with slice bounds. Case is preserved to match
 *   `normalizeMentionName` output; downstream matching folds to lowercase.
 * - Path-like bodies (`@src/x`, `@notes.md`) are files, not agents, and skipped -
 *   UNLESS the body names a known agent/group (see `knownMentionNames`), so an
 *   agent named with a dot or slash (`@RunMaestro.ai`) is still an agent mention.
 * - Mid-word (`foo@bar`) and `@`-run (`@@x`) candidates are skipped.
 *
 * @param knownMentionNames - lowercased set of mentionable agent/group names.
 *   Pass it so a file-shaped agent name resolves; omit it for pure-shape parsing.
 *   Whether a candidate resolves to a real agent is still decided by the send-path
 *   resolver, so an unknown `@word` here simply resolves to no target.
 */
export function parseAgentMentions(
	input: string,
	knownMentionNames?: ReadonlySet<string>
): CrossAgentMention[] {
	if (!input) return [];

	const mentions: CrossAgentMention[] = [];
	for (const span of scanMentionSpans(input, knownMentionNames)) {
		// Files and non-bare-word bodies are not agent mentions.
		if (span.isFile || !span.isName) continue;
		mentions.push({
			token: span.value,
			mentionName: span.body,
			startIndex: span.start,
			endIndex: span.end,
		});
	}

	return mentions;
}

/**
 * True when the message LEADS with an agent/group mention - i.e. the first
 * non-whitespace token is a bare `@name` (not an `@path/file` mention).
 *
 * This is the gate for "route to remote agents only": a message that starts
 * with `@Backend ...` is addressed at the mentioned agent(s), so the source
 * agent should NOT also answer it. A message where the `@mention` appears later
 * (`hey @Backend, thoughts?`) still goes to the source agent too, and a leading
 * FILE mention (`@src/app.ts explain this`) is a question for the source agent
 * about that file, so it does not suppress the local send.
 *
 * Shape-only: whether the leading name resolves to a real agent is decided by
 * the caller (it pairs this with a non-empty resolved-target list). Pass
 * `knownMentionNames` so a leading file-shaped agent name (`@RunMaestro.ai fix
 * this`) is recognized as a leading agent mention and suppresses the local send.
 */
export function messageStartsWithAgentMention(
	message: string,
	knownMentionNames?: ReadonlySet<string>
): boolean {
	if (!message) return false;
	// Offset of the first non-whitespace character.
	const leadingOffset = message.length - message.trimStart().length;
	const [first] = scanMentionSpans(message, knownMentionNames);
	return !!first && first.start === leadingOffset && first.isName && !first.isFile;
}

/**
 * Remove every `@mention` token from a message, leaving the surrounding text
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

/**
 * Derive a short, human-readable subject line from the user's consult message,
 * for the target's History entry + its consult attribution pill. Strips the
 * `@mention` tokens (so "@rc which branch?" becomes "which branch?"), collapses
 * whitespace, and truncates to `maxLen` with an ellipsis. Returns '' when the
 * message carries no prose beyond the mention - callers fall back to the source
 * agent's name so the entry is never left blank.
 */
export function deriveConsultSubject(userPrompt: string, maxLen = 60): string {
	let subject = stripMentions(userPrompt).replace(/\s+/g, ' ').trim();
	if (!subject) return '';
	if (subject.length > maxLen) {
		subject = `${subject.slice(0, maxLen - 1).trimEnd()}…`;
	}
	return subject;
}

// ============================================================================
// MENTION TIMING INFERENCE
// ============================================================================

/**
 * WHEN a mid-message mention runs relative to the source agent's own turn.
 *
 * - `parallel`      - both start now; the source agent waits for the reply
 *                     before it finishes ("what does @Backend think too").
 * - `consult-first` - the mentioned agent answers first, and the source agent
 *                     only starts once the reply is in hand ("check with
 *                     @Backend first", "based on what @Backend says").
 * - `handoff`       - the source agent does the work, and its final answer is
 *                     forwarded to the mentioned agent, one way ("then send
 *                     what you find to @Backend", "let @Backend know").
 */
export type MentionTiming = 'parallel' | 'consult-first' | 'handoff';

/**
 * How a message with resolved mentions is routed: a LEADING mention (`only`)
 * is answered by the mentioned agents alone; anything else carries a timing.
 */
export type MentionRouting = 'only' | MentionTiming;

/** Where a clause ends, for scoping the words around one mention. */
const CLAUSE_BREAK = /[.!?\n;]/;

/** Words that say a step comes after another one. */
const SEQUENCE_CUE =
	/\b(?:then|afterwards?|after (?:that|this|you(?:'re| are)? (?:done|finished)|you finish)|once (?:you(?:'re| are)|that(?:'s| is)|it(?:'s| is)) (?:done|finished)|when (?:you(?:'re| are)) (?:done|finished)|finally|at the end)\b/;

/** Phrases naming the source agent's OUTPUT as the thing to pass on. */
const RESULTS_CUE =
	/\b(?:what(?:ever)? (?:you|we) (?:find|found|learn|learned|learnt|discover|discovered|come up with|figure out|figured out|conclude|get|got)|the results?|(?:your|our|the) (?:findings|results|answer|summary|conclusions?|outcome|output|report)|what comes? back)\b/;

/**
 * A relay verb right before the mention, with its destination preposition:
 * "feed whatever we learn over to @X", "hand it off to @X". These verbs mean
 * "pass the result on" by themselves, so no other cue is needed.
 */
const STRONG_RELAY_BEFORE =
	/\b(?:feed|forward|relay|pass|hand|report|funnel|pipe|route)\b[^.!?\n;]{0,80}?\b(?:to|over to|along to|on to|off to|back to)\s*$/;

/**
 * Weaker relay verbs ("send it to @X", "share this with @X") also describe
 * handing over WORK, so they mean a hand-off only beside a results or
 * sequence cue somewhere in the message.
 */
const WEAK_RELAY_BEFORE =
	/\b(?:send|give|share|post|ship|deliver|email|message|dm)\b[^.!?\n;]{0,80}?\b(?:to|with|over to|along to|on to)\s*$/;

/** "let @X know", "keep @X posted", "loop @X in on what you find". */
const NOTIFY_BEFORE = /\b(?:let|keep|tell|notify|brief|update|inform|loop|ping)\s*$/;
const NOTIFY_AFTER =
	/^\s*(?:know\b|posted\b|updated\b|in the loop\b|informed\b|in on\b|on (?:what|the results?|your findings)\b|what (?:you|we)\b|about (?:it|this|that|the results?|what)\b)/;

/** "check with @X first", "ask @X before you start". */
const FIRST_AFTER =
	/^\W{0,3}(?:first\b|before (?:you|we|answering|starting|doing|replying|responding|writing|touching)\b)/;
/** "first ask @X, then ...". */
const FIRST_BEFORE =
	/\bfirst,?\s+(?:ask|check with|consult|run (?:it|this) by|get|see what|find out what)\s*$/;
/** "based on what @X says". */
const DEPENDS_BEFORE = /\b(?:based on|according to|depending on|guided by)(?: what)?\s*$/;
/** "once @X replies", "wait for @X". */
const AWAIT_BEFORE = /\b(?:wait for|wait on|after|once|when)\s*$/;
const AWAIT_AFTER =
	/^\W{0,3}(?:replies|answers|responds|weighs in|gets back|has answered|has replied|says|is done|comes back)\b/;
/** "ask @X about the schema, then write the migration". */
const CONSULT_VERB_BEFORE =
	/\b(?:ask|check with|consult|run (?:it|this) by|get|see what|find out what|hear what|confirm with)\s*$/;

/** The timing one mention asks for, judged from its own clause. */
function mentionTimingAt(lower: string, mention: CrossAgentMention): MentionTiming {
	const clauseStart = lastIndexOfPattern(lower.slice(0, mention.startIndex), CLAUSE_BREAK) + 1;
	const afterSlice = lower.slice(mention.endIndex);
	const nextBreak = afterSlice.search(CLAUSE_BREAK);
	const before = lower.slice(clauseStart, mention.startIndex);
	const after = nextBreak < 0 ? afterSlice : afterSlice.slice(0, nextBreak);
	// The rest of the SENTENCE after the mention, so "ask @X about it, then
	// write the code" sees its `then` across the comma.
	const sentenceRest = afterSlice.split(/[.!?\n]/, 1)[0] ?? '';

	// Consult-first: the mentioned agent's answer is an INPUT to this turn.
	if (FIRST_AFTER.test(after) || FIRST_BEFORE.test(before) || DEPENDS_BEFORE.test(before)) {
		return 'consult-first';
	}
	if (AWAIT_BEFORE.test(before) && AWAIT_AFTER.test(after)) return 'consult-first';
	if (CONSULT_VERB_BEFORE.test(before) && SEQUENCE_CUE.test(sentenceRest)) {
		return 'consult-first';
	}

	// Hand-off: this turn's answer is the mentioned agent's input.
	if (STRONG_RELAY_BEFORE.test(before)) return 'handoff';
	if (NOTIFY_BEFORE.test(before) && NOTIFY_AFTER.test(after)) return 'handoff';
	if (WEAK_RELAY_BEFORE.test(before) && (RESULTS_CUE.test(lower) || SEQUENCE_CUE.test(before))) {
		return 'handoff';
	}
	return 'parallel';
}

/** Index of the LAST match of `pattern` in `text`, or -1. */
function lastIndexOfPattern(text: string, pattern: RegExp): number {
	for (let i = text.length - 1; i >= 0; i--) {
		if (pattern.test(text[i])) return i;
	}
	return -1;
}

/**
 * Infer WHEN a message's mid-message mentions should run, from the user's own
 * wording. Deterministic and pure: the same message always routes the same
 * way, so the composer can show the decision before the user hits send.
 *
 * Each mention is judged from the words around it (its clause). When mentions
 * disagree, `consult-first` wins over `handoff`, which wins over `parallel`:
 * waiting for an answer that turns out not to be needed costs a little time,
 * while running before a needed answer arrives produces the wrong work. A
 * message carries ONE timing - "ask @A first, then send it to @B" consults
 * both agents first.
 *
 * @param knownMentionNames - see {@link parseAgentMentions}; pass it so a
 *   file-shaped agent name is still found.
 */
export function inferMentionTiming(
	message: string,
	knownMentionNames?: ReadonlySet<string>
): MentionTiming {
	const mentions = parseAgentMentions(message, knownMentionNames);
	if (mentions.length === 0) return 'parallel';
	const lower = message.toLowerCase();
	const timings = mentions.map((mention) => mentionTimingAt(lower, mention));
	if (timings.includes('consult-first')) return 'consult-first';
	if (timings.includes('handoff')) return 'handoff';
	return 'parallel';
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
 * Matching is case-insensitive and runs against the message with its `@`
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
