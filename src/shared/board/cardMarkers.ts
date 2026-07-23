/**
 * Marker parser for Board card completion.
 *
 * A card's assignee agent embeds a structured HTML-comment marker in its output
 * when it finishes a card. These mirror the Goal-Driven Auto Run markers
 * (`src/shared/goalDriven/goalMarkers.ts`) and the halt marker style
 * (`<!-- maestro:halt: reason -->`) so the conventions stay visually consistent:
 *
 *   - Complete:  `<!-- maestro:card-complete -->`
 *                `<!-- maestro:card-complete | short summary here -->`
 *                (the `| summary` portion is optional)
 *   - Block:     `<!-- maestro:card-block: reason here -->`
 *                `<!-- maestro:card-block -->`  (reason optional)
 *
 * Parsing is deliberately regex-based and dependency-free - no markdown/HTML
 * parser is pulled in - and follows the exact same approach as `goalMarkers.ts`
 * (whitespace-tolerant, well-anchored to the `<!-- maestro:... -->` shape, and
 * takes the LAST match of each marker type so the agent's final word wins).
 */

/**
 * The four-question handoff reminder appended to every card's prompt so a
 * worker's completion marker carries structured context to the cards it
 * unblocks. Optional metadata: the run still completes without it (the
 * dispatcher falls back to the process exit status), and any summary is captured
 * into `CardRun.summary` from the `<!-- maestro:card-complete | summary -->`
 * marker below. Shared by the desktop board-spawn path and the CLI `board tick`
 * so the two never drift.
 */
export const CARD_HANDOFF_REMINDER = [
	'When you finish this card, end your reply with a completion marker so the Board can capture your handoff:',
	'`<!-- maestro:card-complete | <one-line summary> -->`',
	'In your summary, briefly cover the four handoff questions: what changed, how you verified it, what this unblocks, and any residual risk.',
	'If you cannot finish, emit `<!-- maestro:card-block: <reason> -->` instead.',
].join('\n');

/** The parsed result of scanning one card run's output for completion markers. */
export interface CardMarkers {
	/** True when a `card-complete` marker is present. */
	complete: boolean;
	/** Optional human-facing summary captured after `card-complete |`. */
	summary?: string;
	/** True when a `card-block` marker is present. */
	blocked: boolean;
	/** Optional reason captured after `card-block:`. */
	blockReason?: string;
}

/**
 * Matches the completion marker, with or without a summary:
 *   `<!-- maestro:card-complete -->` or
 *   `<!-- maestro:card-complete | summary here -->`.
 *
 * The optional `| summary` group is non-greedy so it stops at the first `-->`.
 * The `g` flag lets us keep the LAST match when the agent emits several.
 */
const CARD_COMPLETE_RE = /<!--\s*maestro:card-complete\s*(?:\|\s*([\s\S]*?))?\s*-->/g;

/**
 * Matches the block marker, with or without a reason:
 *   `<!-- maestro:card-block -->` or `<!-- maestro:card-block: reason here -->`.
 *
 * The optional `:` + reason group is captured into `blockReason`.
 */
const CARD_BLOCK_RE = /<!--\s*maestro:card-block\s*(?::\s*([\s\S]*?))?\s*-->/g;

/**
 * Return the last regex match in `text`, or `null` if there are none.
 *
 * When a marker type appears multiple times in one run's output we take the
 * agent's final word for that type. The pattern must carry the `g` flag.
 */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
	let last: RegExpMatchArray | null = null;
	for (const match of text.matchAll(re)) {
		last = match;
	}
	return last;
}

/** Trim a captured group; return `undefined` when absent or empty after trimming. */
function trimToUndefined(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the card completion markers from one run's agent output.
 *
 * A block marker and a complete marker can both technically appear; the caller
 * (the dispatcher) resolves precedence - block wins - so this parser reports
 * both flags faithfully rather than deciding for it. Missing markers yield
 * `false`/`undefined`, letting the caller fall back to the process exit status.
 */
export function parseCardMarkers(output: string): CardMarkers {
	const completeMatch = lastMatch(CARD_COMPLETE_RE, output);
	const blockMatch = lastMatch(CARD_BLOCK_RE, output);

	return {
		complete: completeMatch !== null,
		summary: completeMatch ? trimToUndefined(completeMatch[1]) : undefined,
		blocked: blockMatch !== null,
		blockReason: blockMatch ? trimToUndefined(blockMatch[1]) : undefined,
	};
}
