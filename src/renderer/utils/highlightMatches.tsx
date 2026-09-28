/**
 * highlightMatches - wrap every case-insensitive occurrence of `query` inside
 * `text` in an accent-colored <mark>.
 *
 * Shared by the CSV table renderer and its row detail modal so both surfaces
 * highlight search hits identically. Use this instead of hand-rolling another
 * split-on-regex highlighter.
 *
 * `splitOnMatches` is the same logic without the markup, for callers that need
 * to paint the segments themselves (see `TextareaHighlightOverlay`, which draws
 * transparent text so only the mark backgrounds show through).
 */

import type { ReactNode } from 'react';

/** One run of text, flagged as a query hit or not. */
export interface MatchSegment {
	text: string;
	isMatch: boolean;
	/** Character offset into the original string - a stable React key. */
	start: number;
}

/**
 * Split `text` into alternating non-match / match runs.
 *
 * Returns a single non-match segment when the query is empty or absent, so
 * callers never have to special-case "no filter".
 *
 * An ARRAY of terms highlights every one of them, for filters whose query is
 * several words the caller ANDs together (see the Git Log search): a single
 * literal "fix usage" never occurs in "fix(usage):", so a filter that matched
 * term by term would highlight nothing it had just matched on. Longer terms are
 * tried first, because regex alternation takes the first branch that matches at
 * a position and a shorter term would otherwise mask a longer one containing it.
 */
export function splitOnMatches(text: string, query: string | string[]): MatchSegment[] {
	const terms = (Array.isArray(query) ? query : [query]).filter(Boolean);
	if (terms.length === 0) return [{ text, isMatch: false, start: 0 }];
	const escaped = [...terms]
		.sort((a, b) => b.length - a.length)
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|');
	const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
	// String.split with a capturing group interleaves the captured separators at
	// odd indices, so parity identifies the matches. Re-testing each part with a
	// /g/ regex would be wrong: lastIndex carries between calls.
	let offset = 0;
	return parts.map((part, i) => {
		const segment: MatchSegment = { text: part, isMatch: i % 2 === 1, start: offset };
		offset += part.length;
		return segment;
	});
}

/** A `[from, to)` byte range, the shape CodeMirror's decorations want. */
export interface MatchRange {
	from: number;
	to: number;
}

/**
 * Byte offsets of every query hit in `text`, for an editor's painted search
 * decorations (see `MarkdownEditorHandle.setSearchMatches`).
 *
 * Built from the SAME `splitOnMatches` the rendered preview highlights with, so
 * a surface that offers both a preview and a source editor cannot disagree with
 * itself about what counts as a hit.
 */
export function searchMatchRanges(text: string, query: string | string[]): MatchRange[] {
	if (!query || (Array.isArray(query) && query.length === 0)) return [];
	return splitOnMatches(text, query)
		.filter((segment) => segment.isMatch)
		.map((segment) => ({ from: segment.start, to: segment.start + segment.text.length }));
}

export function highlightMatches(
	text: string,
	query: string | string[],
	accentColor: string
): ReactNode {
	if (!query || (Array.isArray(query) && query.length === 0)) return text;
	const segments = splitOnMatches(text, query);
	if (segments.length === 1) return text;
	// The offset doubles as the key so identical substrings at different
	// positions stay unique.
	return segments.map((segment) =>
		segment.isMatch ? (
			<mark
				key={segment.start}
				style={{
					backgroundColor: accentColor,
					color: '#fff',
					padding: '0 1px',
					borderRadius: '2px',
				}}
			>
				{segment.text}
			</mark>
		) : (
			<span key={segment.start}>{segment.text}</span>
		)
	);
}
