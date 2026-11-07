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
 *   - Review:    `<!-- maestro:card-review: reason here -->`
 *                `<!-- maestro:card-review -->`  (reason optional)
 *   - Block:     `<!-- maestro:card-block: reason here -->`
 *                `<!-- maestro:card-block -->`  (reason optional)
 *
 * Parsing is deliberately regex-based and dependency-free - no markdown/HTML
 * parser is pulled in - and follows the exact same approach as `goalMarkers.ts`
 * (whitespace-tolerant, well-anchored to the `<!-- maestro:... -->` shape, and
 * accepts only the final standalone marker so the agent's final word wins).
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
	'Fix whatever you can safely fix yourself and card-complete it.',
	'If finished work needs further verification, emit `<!-- maestro:card-review: <reason> -->`. Work completion waits for its explicitly assigned artifact review and then a separate final human decision.',
	'Use `<!-- maestro:card-block: <reason> -->` only when you are genuinely stuck and cannot finish.',
	'For an assigned artifact review, report confirmed defects with `<!-- maestro:card-findings: <findings and checks> -->`. Emit card-complete with your checks only when the bound diff has no open findings. A completion never grants final human approval.',
].join('\n');

/** The parsed result of scanning one card run's output for completion markers. */
export interface CardMarkers {
	findings?: string;
	/** True when a `card-complete` marker is present. */
	complete: boolean;
	/** Optional human-facing summary captured after `card-complete |`. */
	summary?: string;
	/** True when a `card-review` marker is present (finished, needs human approval). */
	review: boolean;
	/** Optional reason captured after `card-review:`. */
	reviewReason?: string;
	/** True when a `card-block` marker is present. */
	blocked: boolean;
	/** Optional reason captured after `card-block:`. */
	blockReason?: string;
}

/** Only a final standalone marker carries worker authority. Inline/quoted
 * examples and unterminated markers cannot consume a later marker's terminator. */
const FINAL_CARD_MARKER_RE =
	/(?:^|\n)[ \t]*<!--[ \t]*maestro:card-(complete|review|block|findings)[ \t]*(?:([|:])[ \t]*((?:(?!<!--|-->)[^\r\n])*?))?[ \t]*-->[ \t\r\n]*$/;

const CARD_FINDINGS_RE =
	/(?:^|\n)[ \t]*<!--[ \t]*maestro:card-findings[ \t]*:[ \t]*((?:(?!<!--|-->)[\s\S])*?)-->[ \t]*(?=\r?\n|$)/g;

/** Parse the worker's final handoff; absent authority preserves exit-status fallback. */
export function parseCardMarkers(output: string): CardMarkers {
	let findings: string | undefined;
	for (const report of output.matchAll(CARD_FINDINGS_RE)) findings = report[1].trim() || undefined;
	const match = output.match(FINAL_CARD_MARKER_RE);
	const kind = match?.[1];
	const separator = match?.[2];
	const value = match?.[3]?.trim() || undefined;
	const valid =
		kind === 'complete' ? !separator || separator === '|' : !separator || separator === ':';
	return {
		findings,
		complete: valid && kind === 'complete',
		summary: valid && kind === 'complete' ? value : undefined,
		review: valid && kind === 'review',
		reviewReason: valid && kind === 'review' ? value : undefined,
		blocked: valid && kind === 'block',
		blockReason: valid && kind === 'block' ? value : undefined,
	};
}
