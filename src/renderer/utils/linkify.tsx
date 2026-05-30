import React from 'react';
import type { Theme } from '../types';

// Matches http(s) URLs. Excludes whitespace and a few characters that almost
// never belong inside a URL but commonly bracket one in prose.
const URL_REGEX = /https?:\/\/[^\s<>"`]+/g;

// Punctuation that is almost always sentence/parenthetical terminators rather
// than part of the URL. Stripped from the tail of a match and pushed back into
// the surrounding text so e.g. "see https://x.com." links "https://x.com" only.
const TRAILING_PUNCT = /[.,;:!?)\]}'"`]+$/;

function ExternalLink({ url, theme }: { url: string; theme: Theme }) {
	return (
		<a
			href={url}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void window.maestro.shell.openExternal(url);
			}}
			className="underline hover:opacity-80 cursor-pointer"
			style={{ color: theme.colors.accent }}
		>
			{url}
		</a>
	);
}

function linkifyString(text: string, theme: Theme): React.ReactNode {
	if (!text) return text;
	URL_REGEX.lastIndex = 0;
	const matches = [...text.matchAll(URL_REGEX)];
	if (matches.length === 0) return text;

	const parts: React.ReactNode[] = [];
	let lastIndex = 0;
	matches.forEach((match, i) => {
		const matchText = match[0];
		const matchStart = match.index ?? 0;
		const trailingMatch = matchText.match(TRAILING_PUNCT);
		const trailing = trailingMatch ? trailingMatch[0] : '';
		const url = trailing ? matchText.slice(0, -trailing.length) : matchText;

		if (matchStart > lastIndex) {
			parts.push(text.substring(lastIndex, matchStart));
		}
		parts.push(<ExternalLink key={`url-${matchStart}-${i}`} url={url} theme={theme} />);
		if (trailing) parts.push(trailing);
		lastIndex = matchStart + matchText.length;
	});
	if (lastIndex < text.length) {
		parts.push(text.substring(lastIndex));
	}
	return parts;
}

/**
 * Convert plain-text URLs inside a React node into clickable links opened via
 * the desktop shell. Composes with helpers like `highlightMatches` that return
 * ReactNode[] mixing strings and elements: only string segments are linkified,
 * existing elements (e.g. search-highlight spans) pass through untouched.
 */
export function linkifyNode(node: React.ReactNode, theme: Theme): React.ReactNode {
	if (typeof node === 'string') return linkifyString(node, theme);
	if (Array.isArray(node)) {
		return node.map((child, i) => {
			const linkified = linkifyNode(child, theme);
			if (Array.isArray(linkified)) {
				return <React.Fragment key={`lk-${i}`}>{linkified}</React.Fragment>;
			}
			return linkified;
		});
	}
	return node;
}
