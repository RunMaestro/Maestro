/**
 * Iteration-to-iteration handoff for Goal-Driven Auto Run.
 *
 * Each goal iteration runs in a FRESH context window (see goal-runner.ts), so a
 * successor knows nothing about what its predecessor did beyond what is on disk.
 * To carry forward intent without resuming the whole transcript, the runner asks
 * each finished iteration for a short handoff note and injects it into the next
 * iteration's prompt via the {{PREDECESSOR_HANDOFF}} template variable.
 *
 * This module is pure data/text - no Electron, React, or IPC - so the CLI and
 * desktop runners can share the exact same wording and formatting.
 */

import { stripMaestroMarkers } from './goalMarkers';

/**
 * The prompt sent (as a session resume) to a just-finished iteration to produce
 * the handoff note its successor will see. Kept deliberately short and
 * forward-looking: the next iteration cares about where things stand and what to
 * do next, not a recap of everything that happened.
 */
export const GOAL_SYNOPSIS_REQUEST_PROMPT = [
	"You've just finished one iteration of a Goal-Driven Auto Run. The next iteration",
	'starts with a COMPLETELY FRESH context window and will see nothing from this',
	'session except a short handoff note you write right now.',
	'',
	'Write that handoff for your successor. Be concise (a few sentences, ~150 words',
	'max) and forward-looking. Cover what matters to keep moving efficiently:',
	'',
	'- The current state of the work toward the goal',
	'- What you changed or discovered this iteration',
	'- The most useful next step(s) to take',
	'- Any gotchas, blockers, or dead ends to avoid repeating',
	'',
	'Respond with ONLY the handoff text. No preamble, no markdown headings, no',
	'progress markers, no closing remarks.',
].join('\n');

/** Hard cap on a handoff blurb so a runaway response can't bloat the next prompt. */
export const MAX_HANDOFF_BLURB_LENGTH = 1500;

/**
 * Normalize a raw agent response into a clean handoff blurb: strip any Maestro
 * control markers, trim, and cap the length. Returns an empty string when there
 * is nothing usable to carry forward.
 */
export function sanitizeHandoffBlurb(response: string | undefined | null): string {
	const cleaned = stripMaestroMarkers(response ?? '').trim();
	if (!cleaned) return '';
	if (cleaned.length <= MAX_HANDOFF_BLURB_LENGTH) return cleaned;
	return `${cleaned.slice(0, MAX_HANDOFF_BLURB_LENGTH).trimEnd()}…`;
}

/**
 * Build the markdown block injected via {{PREDECESSOR_HANDOFF}}. Returns an empty
 * string for the first iteration (no predecessor) so the prompt has no dangling
 * empty section; otherwise renders a clearly-labeled, self-contained block.
 */
export function formatPredecessorHandoff(blurb: string | undefined | null): string {
	const trimmed = (blurb ?? '').trim();
	if (!trimmed) return '';
	return [
		'---',
		'',
		'## Handoff From Your Predecessor',
		'',
		'The previous iteration left you this note. Use it to orient quickly, but',
		'verify it against the actual repo state - it may be incomplete or out of date.',
		'',
		trimmed,
	].join('\n');
}
