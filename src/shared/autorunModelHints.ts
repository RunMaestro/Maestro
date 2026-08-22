/**
 * Per-phase model hints in Auto Run documents.
 *
 * A playbook rarely wants one setting for its whole length. Surveying an
 * existing codebase is cheap, mechanical work; designing the migration that
 * follows is not. A model hint lets the document say so:
 *
 * ```markdown
 * ## Research
 * <!-- MAESTRO:MODEL tier="low" effort="low" -->
 *
 * - [ ] Catalogue every call site of the auth middleware
 *
 * ## Design
 * <!-- MAESTRO:MODEL tier="high" effort="high" -->
 *
 * - [ ] Write the migration plan
 * ```
 *
 * Resolution is "nearest marker above the next unfinished task", recomputed
 * before every dispatch rather than tracked as run state. That has two
 * properties worth keeping: the engine holds nothing to get out of sync, and
 * editing the document mid-run takes effect on the next task. It mirrors how
 * {@link findPendingHitlGate} already reads gates, so authors learn one rule.
 *
 * Both attributes are optional and independent - a marker may set the tier, the
 * effort, or both. `tier="default"` (or `effort="default"`) explicitly returns
 * that axis to the agent's own configuration, which is how a document steps
 * back down after a section that needed the expensive setting.
 *
 * Markers inside fenced code blocks are ignored, so a playbook can document
 * this syntax without changing its own behavior. This file's own example above
 * is in a fence for exactly that reason.
 */

import {
	forEachMarkdownLine,
	CHECKED_TASK_COUNT_REGEX,
	UNCHECKED_TASK_REGEX,
} from './markdownTaskScan';
import { asTierLevel, type EffortLevel, type ModelTier } from './modelTiers';

/**
 * `<!-- MAESTRO:MODEL tier="high" effort="high" -->`
 *
 * Matched case-insensitively on the attributes but requiring the literal
 * `MAESTRO:MODEL` token, which keeps false positives at effectively zero in
 * prose that happens to mention models.
 */
const MODEL_MARKER_REGEX = /<!--\s*MAESTRO:MODEL\b([^]*?)-->/i;

/** The word that clears a hint on one axis and returns it to the agent's config. */
const DEFAULT_KEYWORD = 'default';

/**
 * What a document asks for at the current point in the run.
 *
 * `undefined` on an axis means the document said nothing about it, so the
 * agent's own configured value stands. That is distinct from an explicit
 * `default`, which the parser also reports as `undefined` - both mean inherit,
 * and nothing downstream needs to tell them apart.
 */
export interface ModelHint {
	tier?: ModelTier;
	effort?: EffortLevel;
	/** 0-indexed line of the marker, for reporting where a hint came from. */
	line: number;
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

/** Parse one marker's attributes. Exported for the doc-authoring linter and tests. */
export function parseModelMarker(markerInner: string, line: number): ModelHint {
	const hint: ModelHint = { line };
	const invalid: { attribute: 'tier' | 'effort'; value: string }[] = [];

	for (const attribute of ['tier', 'effort'] as const) {
		const raw = readAttribute(markerInner, attribute);
		if (raw === undefined || raw === DEFAULT_KEYWORD) continue;
		const level = asTierLevel(raw);
		if (level === undefined) {
			invalid.push({ attribute, value: raw });
			continue;
		}
		hint[attribute] = level;
	}

	if (invalid.length > 0) hint.invalid = invalid;
	return hint;
}

/**
 * The hint governing the next task the engine will dispatch, or `null` when the
 * document sets none above it.
 *
 * Walks to the first unchecked task and returns the LAST marker seen above it.
 * Last rather than first, unlike HITL gates: a gate is a thing to stop at, so
 * the earliest unacknowledged one wins, whereas a model hint is a setting, so
 * the most recent assignment wins. A checked task does not clear a hint - a
 * setting applies to everything below it until the document says otherwise,
 * which is what makes one marker per section work.
 */
export function findActiveModelHint(content: string): ModelHint | null {
	let current: ModelHint | null = null;
	let atNextTask: ModelHint | null = null;
	let reachedTask = false;

	forEachMarkdownLine(content, (line, index) => {
		if (UNCHECKED_TASK_REGEX.test(line)) {
			atNextTask = current;
			reachedTask = true;
			return false;
		}

		// Checked tasks are stepped over rather than treated as boundaries: the
		// completed half of a section must not drop the setting the rest of it
		// still needs.
		if (CHECKED_TASK_COUNT_REGEX.test(line)) return;

		const markerMatch = line.match(MODEL_MARKER_REGEX);
		if (markerMatch) {
			current = parseModelMarker(markerMatch[1] || '', index);
		}
	});

	// A marker below the last task governs nothing - there is no task left for it
	// to apply to, so report no hint rather than the trailing marker.
	return reachedTask ? atNextTask : null;
}

/**
 * Every marker in a document, in order.
 *
 * For authoring-time validation (surfacing a typo when the playbook is opened,
 * not thirty minutes into the run) rather than for dispatch.
 */
export function findAllModelHints(content: string): ModelHint[] {
	const hints: ModelHint[] = [];
	forEachMarkdownLine(content, (line, index) => {
		const markerMatch = line.match(MODEL_MARKER_REGEX);
		if (markerMatch) hints.push(parseModelMarker(markerMatch[1] || '', index));
	});
	return hints;
}
