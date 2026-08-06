/**
 * highlightMatches - wrap every case-insensitive occurrence of `query` inside
 * `text` in an accent-colored <mark>.
 *
 * Shared by the CSV table renderer and its row detail modal so both surfaces
 * highlight search hits identically. Use this instead of hand-rolling another
 * split-on-regex highlighter.
 */

import type { ReactNode } from 'react';

export function highlightMatches(text: string, query: string, accentColor: string): ReactNode {
	if (!query) return text;
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
	if (parts.length === 1) return text;
	// String.split with a capturing group interleaves the captured separators at
	// odd indices, so parity identifies the matches. Re-testing each part with a
	// /g/ regex would be wrong: lastIndex carries between calls.
	// Use a running character offset as the key so identical substrings at
	// different positions stay unique.
	let offset = 0;
	return parts.map((part, i) => {
		const key = offset;
		offset += part.length;
		return i % 2 === 1 ? (
			<mark
				key={key}
				style={{
					backgroundColor: accentColor,
					color: '#fff',
					padding: '0 1px',
					borderRadius: '2px',
				}}
			>
				{part}
			</mark>
		) : (
			<span key={key}>{part}</span>
		);
	});
}
