/**
 * Model hints in Auto Run documents.
 *
 * A playbook rarely wants one setting end to end. Surveying a codebase is cheap
 * mechanical work; designing the migration that follows is not. A hint lets the
 * document say so, at whichever scope fits:
 *
 * ```markdown
 * <!-- MAESTRO:MODEL tier="low" effort="low" -->
 *
 * - [ ] Catalogue every call site of the auth middleware
 * - [ ] Summarize the current request flow
 * - [ ] Design the migration <!-- MAESTRO:MODEL tier="high" effort="high" -->
 * - [ ] Apply the mechanical renames
 * ```
 *
 * Two syntactic forms, three useful scopes:
 *
 * - **Standalone marker** (own line): applies from there down, until the next
 *   standalone marker. Placed above the first task it covers the whole document
 *   ("per document"); placed at a section heading it covers that phase.
 * - **Inline marker** (on a task line): applies to THAT TASK ONLY. When the task
 *   finishes, the prevailing standalone hint takes over again - or the agent's
 *   own configuration if there is none. In the example above, "Apply the
 *   mechanical renames" runs back at `low`/`low`, not at `high`/`high`.
 *
 * The two compose per axis: an inline marker that sets only `tier` inherits the
 * prevailing `effort` rather than resetting it. `tier="default"` (or
 * `effort="default"`) is the explicit way to push one axis back to the agent's
 * own configuration, which is how a single task opts out of a document-wide
 * hint.
 *
 * Resolution is recomputed before every dispatch rather than tracked as run
 * state. The engine holds nothing that can get out of sync, and editing the
 * document mid-run takes effect on the next task. It mirrors how
 * `findPendingHitlGate` already reads gates, so authors learn one rule.
 *
 * A marker may also carry a `reason`, which changes nothing about how the task
 * runs and exists purely so the choice can be audited later:
 *
 * ```markdown
 * <!-- MAESTRO:MODEL tier="high" effort="high" reason="Lock ordering across three services; getting it wrong corrupts data." -->
 * ```
 *
 * Markers inside fenced code blocks are ignored, so a playbook can document
 * this syntax without changing its own behavior. This file's own examples above
 * are in fences for exactly that reason.
 */

import {
	forEachMarkdownLine,
	CHECKED_TASK_COUNT_REGEX,
	UNCHECKED_TASK_REGEX,
} from './markdownTaskScan';
import { asTierLevel, resolveTierModel, resolveEffortLevel, type ModelTier } from './modelTiers';
import type { ToolType } from './types';

/**
 * `<!-- MAESTRO:MODEL tier="high" effort="high" -->`
 *
 * Matched case-insensitively on the attributes but requiring the literal
 * `MAESTRO:MODEL` token, which keeps false positives at effectively zero in
 * prose that happens to mention models.
 */
const MODEL_MARKER_REGEX = /<!--\s*MAESTRO:MODEL\b([^]*?)-->/i;

/** The word that pushes one axis back to the agent's own configuration. */
const INHERIT_KEYWORD = 'default';

/**
 * What a marker asks for on one axis.
 *
 * `'default'` is retained rather than collapsed to `undefined` because the two
 * differ when scopes merge: a task that says `tier="default"` must override the
 * document's `tier="high"`, whereas a task that says nothing about `tier` must
 * inherit it. Resolution treats both as "use the agent's value".
 */
export type HintDirective = ModelTier | typeof INHERIT_KEYWORD;

/** Which scope supplied a value, for reporting where a setting came from. */
export type HintScope = 'document' | 'task';

export interface ModelHint {
	tier?: HintDirective;
	effort?: HintDirective;
	/** 0-indexed line of the marker that supplied the most recent value. */
	line: number;
	/** Which scope each axis came from. Present on a resolved hint. */
	scopes?: { tier?: HintScope; effort?: HintScope };
	/**
	 * Why the author picked this tier and effort, in the author's own words.
	 *
	 * Read by the pill and nothing else: it never reaches {@link settingsKey},
	 * so two markers whose reasons differ but whose levels match still run as one
	 * uninterrupted segment. A hint that could be split by its prose would turn a
	 * documentation change into an extra dispatch.
	 */
	reason?: string;
	/**
	 * Attribute values that were present but not one of `low|medium|high|default`.
	 * Carried so the caller can warn about a typo (`tier="hgih"`) instead of
	 * silently ignoring it, which would run the task on the wrong model with no
	 * signal at all.
	 */
	invalid?: { attribute: 'tier' | 'effort'; value: string }[];
}

function readAttribute(inner: string, name: 'tier' | 'effort'): string | undefined {
	const match = inner.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
	const value = match?.[1]?.trim();
	return value ? value.toLowerCase() : undefined;
}

/**
 * Longest reason kept. The pill is a peek, not a document: past a couple of
 * sentences the hover overlay stops being readable at a glance, which is the
 * only thing it is for. Truncating beats letting one verbose marker paint a
 * wall of text over the task list.
 */
const REASON_MAX_LENGTH = 400;

/**
 * Read the free-text `reason` attribute.
 *
 * Separate from {@link readAttribute} because that one lowercases its value for
 * the level ladder, and a sentence is not a keyword. The `[^"]*` body means an
 * author who writes a double quote INSIDE the reason gets a truncated sentence
 * rather than a broken marker: `tier` and `effort` are matched independently,
 * so the levels still resolve and the task still runs on the model it asked
 * for. That is the right way to degrade for an attribute that is documentation.
 */
function readReason(inner: string): string | undefined {
	const match = inner.match(/reason\s*=\s*"([^"]*)"/i);
	const value = match?.[1]?.replace(/\s+/g, ' ').trim();
	if (!value) return undefined;
	return value.length > REASON_MAX_LENGTH ? `${value.slice(0, REASON_MAX_LENGTH - 1)}…` : value;
}

/** Parse one marker's attributes. Exported for authoring-time validation and tests. */
export function parseModelMarker(
	markerInner: string,
	line: number,
	scope: HintScope = 'document'
): ModelHint {
	const hint: ModelHint = { line, scopes: {} };
	const invalid: { attribute: 'tier' | 'effort'; value: string }[] = [];

	for (const attribute of ['tier', 'effort'] as const) {
		const raw = readAttribute(markerInner, attribute);
		if (raw === undefined) continue;
		if (raw === INHERIT_KEYWORD) {
			hint[attribute] = INHERIT_KEYWORD;
			hint.scopes![attribute] = scope;
			continue;
		}
		const level = asTierLevel(raw);
		if (level === undefined) {
			invalid.push({ attribute, value: raw });
			continue;
		}
		hint[attribute] = level;
		hint.scopes![attribute] = scope;
	}

	const reason = readReason(markerInner);
	if (reason) hint.reason = reason;

	if (invalid.length > 0) hint.invalid = invalid;
	return hint;
}

/**
 * Layer a task-scoped hint over the prevailing document-scoped one, per axis.
 *
 * Per axis rather than wholesale: a task that raises only the tier should keep
 * the document's effort rather than silently dropping it back to the agent
 * default, which would make `tier="high"` quietly LOWER the effort of a task
 * inside a high-effort section.
 */
function mergeHints(document: ModelHint | null, task: ModelHint | null): ModelHint | null {
	if (!document && !task) return null;
	if (!task) return document;
	if (!document) return task;

	const merged: ModelHint = {
		line: task.line,
		tier: task.tier ?? document.tier,
		effort: task.effort ?? document.effort,
		scopes: {
			tier: task.tier !== undefined ? task.scopes?.tier : document.scopes?.tier,
			effort: task.effort !== undefined ? task.scopes?.effort : document.scopes?.effort,
		},
		// The narrower scope's explanation wins, matching how its levels do. Pills
		// never read a merged hint - each one shows its own marker's reason - so
		// this only matters to a caller inspecting what governs the next dispatch.
		reason: task.reason ?? document.reason,
	};

	const invalid = [...(document.invalid ?? []), ...(task.invalid ?? [])];
	if (invalid.length > 0) merged.invalid = invalid;
	return merged;
}

/**
 * The hint governing the next task the engine will dispatch, or `null` when
 * nothing applies to it.
 *
 * Walks to the first unchecked task, carrying the most recent standalone marker
 * as the prevailing scope, then layers that task's own inline marker (if any)
 * over it. Standalone markers use last-one-wins rather than the first-one-wins
 * rule HITL gates follow: a gate is a thing to stop at, so the earliest
 * unacknowledged one matters, whereas a hint is a setting, so the most recent
 * assignment matters.
 *
 * A checked task is stepped over entirely. That does two jobs: a half-finished
 * section keeps the setting the rest of it still needs, and a completed task's
 * INLINE marker dies with it rather than leaking onto the tasks below.
 */
export function findActiveModelHint(content: string): ModelHint | null {
	let documentHint: ModelHint | null = null;
	let resolved: ModelHint | null = null;
	let reachedTask = false;

	forEachMarkdownLine(content, (line, index) => {
		const markerMatch = line.match(MODEL_MARKER_REGEX);

		if (UNCHECKED_TASK_REGEX.test(line)) {
			const taskHint = markerMatch ? parseModelMarker(markerMatch[1] || '', index, 'task') : null;
			resolved = mergeHints(documentHint, taskHint);
			reachedTask = true;
			return false;
		}

		// Stepped over, marker and all: an inline hint belongs to its own task.
		if (CHECKED_TASK_COUNT_REGEX.test(line)) return;

		if (markerMatch) {
			documentHint = parseModelMarker(markerMatch[1] || '', index, 'document');
		}
	});

	// A marker below the last task governs nothing - there is no task left for it
	// to apply to, so report no hint rather than the trailing marker.
	return reachedTask ? resolved : null;
}

/**
 * Every marker in a document, in order, tagged with the scope it would apply at.
 *
 * For authoring-time validation (surfacing a typo when the playbook is opened,
 * not thirty minutes into the run) rather than for dispatch.
 */
export function findAllModelHints(content: string): ModelHint[] {
	const hints: ModelHint[] = [];
	forEachMarkdownLine(content, (line, index) => {
		const markerMatch = line.match(MODEL_MARKER_REGEX);
		if (!markerMatch) return;
		const isTaskLine = UNCHECKED_TASK_REGEX.test(line) || CHECKED_TASK_COUNT_REGEX.test(line);
		hints.push(parseModelMarker(markerMatch[1] || '', index, isTaskLine ? 'task' : 'document'));
	});
	return hints;
}

/**
 * The resolved `{model, effort}` pair for a hint, flattened to a comparable
 * string.
 *
 * Deliberately re-derives from `modelTiers` rather than calling
 * `resolveTurnSettings`: that lives in `autorunTurnSettings`, which imports
 * `ModelHint` from this file. Type-only today, so erased - but a value import
 * back the other way would make it a real cycle. This needs two lookups, not
 * the notes and warnings machinery.
 */
function settingsKey(
	toolType: ToolType,
	hint: ModelHint | null,
	baselineModel?: string,
	baselineEffort?: string
): string {
	let model = baselineModel;
	let effort = baselineEffort;
	if (hint?.tier && hint.tier !== INHERIT_KEYWORD) {
		model = resolveTierModel(toolType, hint.tier) ?? baselineModel;
	}
	if (hint?.effort && hint.effort !== INHERIT_KEYWORD) {
		effort = resolveEffortLevel(toolType, hint.effort) ?? baselineEffort;
	}
	return `${model ?? ''}\u0000${effort ?? ''}`;
}

/**
 * How many of the remaining unchecked tasks share the settings the NEXT task
 * will run under, and how many remain in total.
 *
 * Document mode tells the agent to work the whole file in one dispatch, which
 * is right until the document asks for different settings partway down: the
 * agent is already running under the first task's model when it reaches a task
 * that wanted another one. Counting the boundary lets the prompt say "do the
 * next N, then stop", so the existing `while (remainingTasks > 0)` loop comes
 * back around and re-resolves for the rest.
 *
 * Compares the RESOLVED `{model, effort}` pair, not the tier words, and that
 * distinction is the whole reason this takes a toolType. `resolveTierModel`
 * returns undefined for providers with no tier table (codex, copilot-cli,
 * opencode), so on those `tier="low"` and `tier="high"` both resolve to the
 * agent's own model - identical settings. Splitting on the words there would
 * end one dispatch and start another to run at exactly the same configuration.
 * `tier="default"` versus no marker is the same trap.
 *
 * @param content - the document, read fresh; this is recomputed per dispatch
 * @param toolType - provider, because tier to model mapping is per provider
 * @param baselineModel - the agent's configured model, the fallback a hint overrides
 * @param baselineEffort - the agent's configured effort
 */
export function countTasksUnderActiveHint(
	content: string,
	toolType: ToolType,
	baselineModel?: string,
	baselineEffort?: string
): { count: number; total: number } {
	let documentHint: ModelHint | null = null;
	let firstKey: string | null = null;
	let count = 0;
	let total = 0;

	forEachMarkdownLine(content, (line, index) => {
		const markerMatch = line.match(MODEL_MARKER_REGEX);

		if (UNCHECKED_TASK_REGEX.test(line)) {
			total++;
			const taskHint = markerMatch ? parseModelMarker(markerMatch[1] || '', index, 'task') : null;
			const merged = mergeHints(documentHint, taskHint);
			const key = settingsKey(toolType, merged, baselineModel, baselineEffort);
			if (firstKey === null) {
				firstKey = key;
				count = 1;
			} else if (key === firstKey && count === total - 1) {
				// Only extend while the run is UNBROKEN from the first task. Once a
				// differing task appears, a later task that happens to match again
				// belongs to a separate segment, not this one.
				count++;
			}
			return;
		}

		if (CHECKED_TASK_COUNT_REGEX.test(line)) return;

		if (markerMatch) {
			documentHint = parseModelMarker(markerMatch[1] || '', index, 'document');
		}
	});

	return { count, total };
}

/**
 * The sentence appended to a document-mode selection block when the document
 * changes settings partway down, or `''` when the whole remaining document runs
 * under one configuration.
 *
 * Lives here rather than in the renderer's `batchUtils` because the CLI engine
 * needs the identical sentence and cannot import from `src/renderer`. Two
 * copies would drift, and the drift would be invisible: both engines would keep
 * working, just instructing the agent differently for the same document.
 *
 * Returning `''` for the common case is what keeps the block BYTE-IDENTICAL for
 * every playbook written before model hints existed.
 */
export function describeSegmentLimit(segment?: { count: number; total: number }): string {
	if (!segment || segment.count >= segment.total || segment.count < 1) return '';
	const noun = segment.count === 1 ? 'task' : 'tasks';
	return `\n\nIMPORTANT: Complete ONLY the next ${segment.count} unchecked ${noun}, then stop and report. The remaining tasks in this document are configured to run with different model or effort settings and will be handled in a separate pass.`;
}
