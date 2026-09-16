/**
 * Text utilities for Cue - specifically for slicing user-facing output before
 * it's passed to downstream subscriptions or persisted.
 *
 * Plain `.slice()` / `.substring()` on a JS string operates on UTF-16 code
 * units, which means an emoji or supplementary-plane character (encoded as a
 * surrogate pair) can be split down the middle. The result is an orphan
 * surrogate that downstream consumers see as a replacement character or a
 * mojibake artifact. Worse, if the output is later serialized to a shell
 * command or file, some tools reject invalid UTF-8 altogether.
 *
 * These helpers snap slice boundaries back to the nearest valid code-point
 * edge so Cue never forwards corrupted text.
 *
 * Also home to `buildCuePersistedOutput()` - the single derivation of the two
 * output fields every completed run persists, shared by the JSONL history
 * writer and the `cue_events` row finalizer.
 */

import { extractCueOutputExcerpt } from '../../shared/cue/cue-summary';
import type { CueRunResult } from './cue-types';

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function isHighSurrogate(code: number): boolean {
	return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(code: number): boolean {
	return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * Take the last `maxChars` code units of `s`, but if the slice starts in the
 * middle of a surrogate pair, shift the start forward by one so the result
 * contains only complete code points.
 */
export function sliceTailByChars(s: string, maxChars: number): string {
	if (maxChars <= 0 || s.length === 0) return '';
	if (s.length <= maxChars) return s;
	let start = s.length - maxChars;
	// If the slice starts on a low surrogate, the matching high surrogate is
	// one code unit earlier - drop the low surrogate to keep the result valid.
	if (start > 0 && isLowSurrogate(s.charCodeAt(start))) {
		start += 1;
	}
	return s.slice(start);
}

/**
 * Take the first `maxChars` code units of `s`, but if that position lands
 * between a high and low surrogate, step back by one so the trailing code
 * point is either included whole or excluded entirely.
 */
export function sliceHeadByChars(s: string, maxChars: number): string {
	if (maxChars <= 0 || s.length === 0) return '';
	if (s.length <= maxChars) return s;
	let end = maxChars;
	if (
		end < s.length &&
		isHighSurrogate(s.charCodeAt(end - 1)) &&
		isLowSurrogate(s.charCodeAt(end))
	) {
		end -= 1;
	}
	return s.slice(0, end);
}

/**
 * Cap on the stdout persisted with a completed run - both the History entry's
 * `fullResponse` and the `cue_events.full_output` column. Enough to carry a
 * useful run transcript without turning the journal DB (or the per-agent JSONL
 * history file) into an output archive.
 */
export const MAX_HISTORY_RESPONSE_LENGTH = 10000;

/** The two output fields persisted alongside a completed run. */
export interface CuePersistedOutput {
	/** Short, sentence-aligned row body. Null when the run printed nothing. */
	excerpt: string | null;
	/** Head-truncated stdout. Null when the run printed nothing. */
	fullOutput: string | null;
}

/**
 * Derive the persisted output fields from a finished run.
 *
 * Called from the `cue_events` row finalization in `cue-run-manager.ts`, which
 * is now the only writer: the JSONL history entry it used to share this
 * derivation with is gone, and History serves Cue runs straight from the DB
 * row (see `getCueHistoryEntries`).
 *
 * stdout leads and stderr is the fallback for the excerpt, so a run kept for
 * its error output isn't reduced to a bare trigger label. `fullOutput` is
 * stdout only: stderr already has its own column (`error_message`).
 *
 * Returns null - never an empty string - for a run that printed nothing, which
 * is what makes `WHERE output_excerpt IS NOT NULL` the noise filter on
 * `cue_events`.
 */
export function buildCuePersistedOutput(
	result: Pick<CueRunResult, 'stdout' | 'stderr'>
): CuePersistedOutput {
	const excerpt =
		extractCueOutputExcerpt(result.stdout) ?? extractCueOutputExcerpt(result.stderr) ?? null;
	const fullOutput = sliceHeadByChars(result.stdout ?? '', MAX_HISTORY_RESPONSE_LENGTH) || null;
	return { excerpt, fullOutput };
}
