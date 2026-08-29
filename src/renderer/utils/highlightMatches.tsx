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
 */
export function splitOnMatches(text: string, query: string): MatchSegment[] {
	if (!query) return [{ text, isMatch: false, start: 0 }];
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export function highlightMatches(text: string, query: string, accentColor: string): ReactNode {
	if (!query) return text;
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
