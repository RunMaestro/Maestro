/**
 * Marker parser for Goal-Driven Auto Run mode.
 *
 * At the end of each iteration the agent embeds structured HTML-comment markers
 * in its output. These mirror the existing halt marker style
 * (`<!-- maestro:halt: reason -->` in `src/prompts/autorun-default.md`) so the
 * conventions stay visually consistent:
 *
 *   - Progress:   `<!-- maestro:progress 45 | short rationale here -->`
 *                 (the `| rationale` portion is optional)
 *   - Complete:   `<!-- maestro:goal-complete -->`
 *   - Deadlock:   `<!-- maestro:deadlock: reason here -->`  (reason optional)
 *   - Plan:       `<!-- maestro:plan -->` ... `<!-- /maestro:plan -->`, a block
 *                 whose body is the agent's full Plan list (read by
 *                 `parsePlanMarker` in `goalPlan.ts`)
 *
 * Parsing is deliberately regex-based and dependency-free - no markdown/HTML
 * parser is pulled in. Regexes are whitespace-tolerant and well-anchored to the
 * `<!-- maestro:... -->` comment shape.
 */

import type { GoalMarkers } from './types';

/**
 * Matches a progress marker: `<!-- maestro:progress <number>[%] [| rationale] -->`.
 *
 * - `[\s\S]*?` inside the rationale group is non-greedy so it stops at the first
 *   `-->`. The `g` flag lets us collect every match and keep the LAST one.
 * - The number may be a float or negative; clamping/rounding happens afterward.
 * - A trailing `%` (`progress 45%` or `progress 45 %`) is tolerated and ignored -
 *   agents routinely write the percent sign even though the value is already a
 *   percentage.
 * - Because the pattern is matched anywhere in the text, a marker wrapped in
 *   backticks or sitting inside a fenced code block is found unchanged, and any
 *   curly/smart punctuation in the rationale is captured verbatim.
 */
const PROGRESS_RE =
	/<!--\s*maestro:progress\s+(-?\d+(?:\.\d+)?)\s*%?\s*(?:\|\s*([\s\S]*?))?\s*-->/g;

/** Matches the bare completion marker: `<!-- maestro:goal-complete -->`. */
const COMPLETE_RE = /<!--\s*maestro:goal-complete\s*-->/g;

/**
 * Matches a deadlock marker, with or without a reason:
 *   `<!-- maestro:deadlock -->` or `<!-- maestro:deadlock: reason here -->`.
 *
 * The optional `:` + reason group is captured into `deadlockReason`.
 */
const DEADLOCK_RE = /<!--\s*maestro:deadlock\s*(?::\s*([\s\S]*?))?\s*-->/g;

/**
 * Matches ANY Maestro control marker comment: `<!-- maestro:<anything> -->`.
 *
 * Covers every marker shape the agent embeds (`progress`, `goal-complete`,
 * `deadlock`, `halt`, ...). Non-greedy body so adjacent markers on one line are
 * each removed individually rather than collapsed into one span.
 */
const ANY_MARKER_RE = /<!--\s*maestro:[\s\S]*?-->/g;

/**
 * Matches a whole plan block, open tag, body and close tag:
 * `<!-- maestro:plan -->\n- [ ] step <!-- id:new -->\n<!-- /maestro:plan -->`.
 *
 * The body is non-greedy so two blocks in one response stay two matches (the
 * last one wins, like every other marker). An open tag with no close tag is
 * not a block: `parsePlanMarker` reads nothing from it, and display stripping
 * removes only the tag through `ANY_MARKER_RE`, leaving the half-written list
 * visible rather than guessing where it ends.
 */
const PLAN_BLOCK_RE = /<!--\s*maestro:plan\s*-->([\s\S]*?)<!--\s*\/\s*maestro:plan\s*-->/g;

/**
 * Strip every Maestro control marker comment from `text` for display.
 *
 * These `<!-- maestro:... -->` comments are an internal control channel between
 * the agent and the Auto Run engine - users should never see them in history
 * details or any rendered surface. A plan block goes with its body: the list
 * inside is engine input, and the human reads the merged result in the Plan Doc.
 * Collapses the blank lines a removed marker leaves behind so a trailing marker
 * doesn't produce a dangling gap.
 */
export function stripMaestroMarkers(text: string): string {
	if (!text.includes('<!--')) {
		return text;
	}
	return (
		text
			.replace(PLAN_BLOCK_RE, '')
			.replace(ANY_MARKER_RE, '')
			// Collapse 3+ newlines (left by a marker on its own line) to a clean break.
			.replace(/\n{3,}/g, '\n\n')
			.replace(/[ \t]+\n/g, '\n')
			.trim()
	);
}

/** Clamp `value` into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Return the last regex match in `text`, or `null` if there are none.
 *
 * When a marker type appears multiple times in one iteration's output we take
 * the agent's final word for that type. The pattern must carry the `g` flag.
 */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
	let last: RegExpMatchArray | null = null;
	for (const match of text.matchAll(re)) {
		last = match;
	}
	return last;
}

/**
 * The body of the LAST closed plan block in `agentText`, or `null` when there
 * is none. The body is returned raw (indentation intact); turning it into
 * items is `parsePlanMarker`'s job in `goalPlan.ts`.
 */
export function lastPlanBlockBody(agentText: string): string | null {
	return lastMatch(PLAN_BLOCK_RE, agentText)?.[1] ?? null;
}

/** Trim a captured group; return `null` when absent or empty after trimming. */
function trimToNull(value: string | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the goal-driven markers from one iteration's agent output.
 *
 * Missing markers yield `null`/`false` - the exit evaluator decides how to
 * treat a missing progress report. A progress of exactly `100` implies
 * completion even without the bare `goal-complete` marker.
 */
export function parseGoalMarkers(agentText: string): GoalMarkers {
	const progressMatch = lastMatch(PROGRESS_RE, agentText);

	let progress: number | null = null;
	let rationale: string | null = null;
	if (progressMatch) {
		const parsed = Number.parseFloat(progressMatch[1]);
		if (Number.isFinite(parsed)) {
			progress = clamp(Math.round(parsed), 0, 100);
		}
		rationale = trimToNull(progressMatch[2]);
	}

	const hasCompleteMarker = lastMatch(COMPLETE_RE, agentText) !== null;
	const complete = hasCompleteMarker || progress === 100;

	const deadlockMatch = lastMatch(DEADLOCK_RE, agentText);
	const deadlock = deadlockMatch !== null;
	const deadlockReason = deadlockMatch ? trimToNull(deadlockMatch[1]) : null;

	return { progress, rationale, complete, deadlock, deadlockReason };
}
