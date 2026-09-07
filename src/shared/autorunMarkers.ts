/**
 * Maestro's Auto Run document markers, and what state each one is in.
 *
 * A playbook carries three kinds of HTML-comment marker, and they share a
 * problem: an HTML comment renders as nothing, so a marker that is actively
 * changing how the next run behaves is invisible in every surface that shows
 * the document. Two of them do not merely change behavior, they BLOCK it - a
 * leftover HITL gate pauses every re-run, and a leftover halt marker makes Auto
 * Run refuse to start at all. The user sees a playbook that will not go, with
 * the cause sitting in text they cannot see.
 *
 * | Marker              | Effect when live                                  |
 * | ------------------- | ------------------------------------------------- |
 * | `MAESTRO:HITL`      | Pauses the run until a human ticks the box         |
 * | `maestro:halt`      | Refuses to start; must be removed by hand          |
 * | `MAESTRO:MODEL`     | Changes the model/effort the next task runs at     |
 *
 * This module owns the regexes and the state resolution for all three, so the
 * engines and the renderer agree on what is live. It lives in `shared/` because
 * the CLI engine cannot import from `src/renderer`, and a marker that meant one
 * thing to the engine and another to the pill would be worse than no pill.
 *
 * {@link scanMaestroMarkers} is the rendering side: every marker, with status.
 * {@link findPendingHitlGate} and {@link detectHaltMarker} are the engine side,
 * moved here unchanged from the desktop and CLI engines respectively.
 */

import {
	forEachMarkdownLine,
	CHECKED_TASK_COUNT_REGEX,
	UNCHECKED_TASK_REGEX,
} from './markdownTaskScan';
import { parseModelMarker, type ModelHint } from './autorunModelHints';

/**
 * `<!-- MAESTRO:HITL reason="..." artifact="..." -->`
 *
 * The marker may span multiple lines in source, but a single line is the unit
 * because playbook authors place it on its own line per the documented
 * convention.
 */
export const HITL_MARKER_REGEX = /<!--\s*MAESTRO:HITL\b([^]*?)-->/;

/**
 * `<!-- maestro:halt -->` or `<!-- maestro:halt: reason -->`
 *
 * Case-insensitive on the keyword to tolerate agent variations, but the literal
 * token `maestro:halt` is required to keep false positives effectively zero.
 */
export const HALT_MARKER_REGEX = /<!--\s*maestro:halt\s*(?::\s*([^>]*?))?\s*-->/i;

/** `<!-- MAESTRO:MODEL tier="high" effort="high" -->` */
export const MODEL_MARKER_REGEX = /<!--\s*MAESTRO:MODEL\b([^]*?)-->/i;

/**
 * Inline code spans, so a marker someone QUOTED in prose is not obeyed.
 *
 * `` `<!-- maestro:halt: reason -->` `` in a sentence is an author showing the
 * syntax; the same bytes without backticks are an agent using it. Markers carry
 * no backticks of their own, so the naive lazy match is exact here.
 */
const INLINE_CODE_SPAN_REGEX = /(`+)[^`]*?\1/g;

/** Blank out inline code spans, preserving nothing that could match a marker. */
function stripInlineCode(line: string): string {
	return line.replace(INLINE_CODE_SPAN_REGEX, ' ');
}

/** Any of the three, for the cheap "is this comment ours at all" test. */
const ANY_MARKER_REGEX = /<!--\s*(?:MAESTRO:HITL|maestro:halt|MAESTRO:MODEL)\b/i;

export interface HitlGate {
	reason: string;
	artifact?: string;
	/** 0-indexed line number of the marker within the document */
	line: number;
}

function parseHitlAttributes(inner: string, line: number): HitlGate {
	const reasonMatch = inner.match(/reason\s*=\s*"([^"]*)"/);
	const artifactMatch = inner.match(/artifact\s*=\s*"([^"]*)"/);
	return {
		reason: reasonMatch?.[1]?.trim() || 'Human review requested',
		artifact: artifactMatch?.[1]?.trim() || undefined,
		line,
	};
}

/**
 * Detect a pending HITL (human-in-the-loop) gate in playbook content.
 *
 * A gate is "pending" when an unchecked task appears below a HITL marker
 * with no checked task between them - the human hasn't acknowledged the
 * gate yet by ticking the approval checkbox. Once the user checks the box
 * (or any task between the marker and the next unchecked task), the marker
 * is considered "consumed" and the next call returns null.
 *
 * Markers inside fenced code blocks are ignored so playbook authors can
 * document the syntax without triggering pauses.
 *
 * Returns the first marker in a pending chain (when multiple markers
 * appear before a single unchecked task), and null otherwise.
 */
export function findPendingHitlGate(content: string): HitlGate | null {
	let firstMarkerInPendingChain: HitlGate | null = null;
	let pendingGate: HitlGate | null = null;

	forEachMarkdownLine(content, (line, i) => {
		// Checked tasks consume any pending marker - the user already approved
		// (or someone other than the user; either way the gate has been passed).
		if (CHECKED_TASK_COUNT_REGEX.test(line)) {
			firstMarkerInPendingChain = null;
			return;
		}

		// Unchecked task closes the pending chain: if we have a marker, it's
		// the gate the run should pause at. Otherwise there's no gate above
		// this task.
		if (UNCHECKED_TASK_REGEX.test(line)) {
			pendingGate = firstMarkerInPendingChain;
			return false;
		}

		// Quoted markers are shown, not used - same rule the halt scanner and the
		// pill renderer apply, so all three agree on what is live.
		const markerMatch = stripInlineCode(line).match(HITL_MARKER_REGEX);
		if (markerMatch && firstMarkerInPendingChain === null) {
			firstMarkerInPendingChain = parseHitlAttributes(markerMatch[1] || '', i);
		}
	});

	return pendingGate;
}

/**
 * A halt marker that is actually asking the engine to stop.
 *
 * `line` is the 0-indexed line it sits on, so the error a user sees can point
 * at the thing they have to delete instead of asking them to hunt for an
 * invisible HTML comment.
 */
export interface HaltMarker {
	reason?: string;
	line: number;
}

/**
 * Find the `<!-- maestro:halt -->` early-exit marker a run must obey.
 *
 * An EXECUTING agent writes this marker into the current Auto Run document to
 * abort the whole playbook: no further tasks in this document, no further
 * documents. The optional reason after the colon is surfaced in the History
 * panel and the JSONL `halt` event.
 *
 * The hard part is that an AUTHORING agent writes the same bytes for the
 * opposite purpose. Playbook authors are told they may call out halt-worthy
 * conditions, so they produce lines like "if the build is broken, write
 * `<!-- maestro:halt: build broken -->`" - a DESCRIPTION of a halt, not a
 * halt. Matched naively that description blocks the playbook before its first
 * task ever runs, and because an HTML comment renders as nothing, the user sees
 * a playbook that refuses to start with no visible cause. That is the failure
 * this scanner exists to avoid, so three positions are treated as quotation
 * rather than instruction:
 *
 * - Inside a fenced code block. Every other scanner here already skips fences;
 *   a halt that disagreed with its own pill was the worst of both worlds.
 * - Inside an inline code span. Backticks around a marker are the single most
 *   common way an author writes "emit this", and prose is where they write it.
 * - On a checkbox line. The executing agent is told to leave the unfinishable
 *   task UNCHECKED and put the marker below it, so a marker riding a `- [ ]`
 *   line is describing what a future run should do, not reporting a stop.
 *
 * Anything else - a marker standing on its own line in ordinary document body,
 * which is exactly what step 7 of the Auto Run prompt asks for - halts.
 */
export function findHaltMarker(content: string): HaltMarker | null {
	let found: HaltMarker | null = null;

	forEachMarkdownLine(content, (line, index) => {
		if (CHECKED_TASK_COUNT_REGEX.test(line) || UNCHECKED_TASK_REGEX.test(line)) return;

		const match = stripInlineCode(line).match(HALT_MARKER_REGEX);
		if (!match) return;

		found = { reason: match[1]?.trim() || undefined, line: index };
		return false;
	});

	return found;
}

/**
 * Boolean-and-reason form of {@link findHaltMarker}, kept as the engine's API.
 */
export function detectHaltMarker(content: string): { halted: boolean; reason?: string } {
	const halt = findHaltMarker(content);
	if (!halt) return { halted: false };
	return { halted: true, reason: halt.reason };
}

/**
 * Whether a marker is currently doing something.
 *
 * - `live` - it is changing the next run: a gate that will pause, a halt that
 *   will refuse to start, a model hint that governs the next task.
 * - `spent` - it has already been passed and is now inert. A HITL gate whose
 *   box has been ticked; a model hint whose section is finished.
 * - `invalid` - it names a value Maestro does not understand, so it will be
 *   ignored. Worth showing loudly: the author thinks it is doing something.
 */
export type MarkerStatus = 'live' | 'spent' | 'invalid';

export interface ScannedMarker {
	kind: 'hitl' | 'halt' | 'model';
	status: MarkerStatus;
	/** 0-indexed line of the marker within the document. */
	line: number;
	/** On its own line, or trailing a task line. */
	scope: 'document' | 'task';
	/** HITL: why a human is needed. Halt: why the run stopped. */
	reason?: string;
	/** HITL only: what the human should look at. */
	artifact?: string;
	/** Model only: the parsed hint, including any invalid attribute values. */
	hint?: ModelHint;
}

/**
 * Every Maestro marker in a document, in source order, each with its status.
 *
 * This is what the renderer draws pills from. It answers the question a reader
 * actually has - "is this thing going to stop my run?" - rather than merely
 * "is a marker present here", which is all the raw text can say.
 *
 * HITL status is resolved by looking DOWN from each marker to the first task
 * below it: unchecked means the gate still stands, checked means a human (or
 * something) already passed it, and no task at all means it gates nothing. That
 * matches {@link findPendingHitlGate}, which is what the engine actually obeys.
 *
 * Model status is resolved by position relative to the first unfinished task: a
 * hint above it governs the next dispatch, a hint below it does not yet.
 *
 * Fence-aware throughout, so a playbook documenting this syntax draws no pills,
 * and quotation-aware in the same three positions {@link findHaltMarker} uses,
 * so the pill and the engine cannot disagree about whether a run will stop.
 */
export function scanMaestroMarkers(content: string): ScannedMarker[] {
	const markers: ScannedMarker[] = [];
	// HITL markers whose status is still unknown because no task has appeared
	// below them yet. Resolved in bulk when the next task line decides for all.
	let awaitingTask: ScannedMarker[] = [];
	// Model markers only govern the run while no unfinished task has been passed.
	let seenUncheckedTask = false;

	forEachMarkdownLine(content, (line, index) => {
		const isChecked = CHECKED_TASK_COUNT_REGEX.test(line);
		const isUnchecked = UNCHECKED_TASK_REGEX.test(line);
		const isTaskLine = isChecked || isUnchecked;

		// A marker trailing a task line belongs to that task, so it is parsed
		// before the task resolves the gates above it. Inline code spans are
		// blanked first: a marker in backticks is being SHOWN, and drawing a pill
		// on an author's example would misreport the document's state.
		const scanned = stripInlineCode(line);
		if (ANY_MARKER_REGEX.test(scanned)) {
			const scope = isTaskLine ? 'task' : 'document';

			const modelMatch = scanned.match(MODEL_MARKER_REGEX);
			if (modelMatch) {
				const hint = parseModelMarker(modelMatch[1] || '', index, scope);
				const hasInvalid = (hint.invalid?.length ?? 0) > 0;
				const setsNothing = hint.tier === undefined && hint.effort === undefined;
				markers.push({
					kind: 'model',
					// An inline hint on a CHECKED task is spent with that task, and any
					// hint below the first unfinished task has not been reached yet.
					status: hasInvalid
						? 'invalid'
						: (scope === 'task' && isChecked) || seenUncheckedTask || setsNothing
							? 'spent'
							: 'live',
					line: index,
					scope,
					hint,
				});
			}

			const haltMatch = scanned.match(HALT_MARKER_REGEX);
			if (haltMatch) {
				markers.push({
					kind: 'halt',
					// A halt standing in the document body is never spent: it blocks the
					// next run wherever it sits, which is exactly why it needs a pill. One
					// riding a checkbox line is an author describing when a FUTURE run
					// should stop, so the engine ignores it and so does the pill.
					status: scope === 'task' ? 'spent' : 'live',
					line: index,
					scope,
					reason: haltMatch[1]?.trim() || undefined,
				});
			}

			const hitlMatch = scanned.match(HITL_MARKER_REGEX);
			if (hitlMatch) {
				const gate = parseHitlAttributes(hitlMatch[1] || '', index);
				const marker: ScannedMarker = {
					kind: 'hitl',
					status: 'spent',
					line: index,
					scope,
					reason: gate.reason,
					artifact: gate.artifact,
				};
				markers.push(marker);
				// A gate on a task line gates nothing below it, so it never awaits.
				if (!isTaskLine) awaitingTask.push(marker);
			}
		}

		if (!isTaskLine) return;
		if (isUnchecked) {
			// The gate still stands: a human has not ticked the box below it.
			for (const marker of awaitingTask) marker.status = 'live';
			seenUncheckedTask = true;
		}
		// Either way the question is now answered for everything above.
		awaitingTask = [];
	});

	// Markers left awaiting have no task below them, so they gate nothing and
	// keep the 'spent' status they were created with.
	return markers;
}

/** True when a line carries any Maestro marker. Cheap pre-filter for renderers. */
export function hasMaestroMarker(text: string): boolean {
	return ANY_MARKER_REGEX.test(text);
}
