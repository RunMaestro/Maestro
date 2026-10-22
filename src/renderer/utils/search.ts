import React from 'react';

import {
	fuzzyMatch,
	fuzzyMatchWithIndices,
	fuzzyMatchWithScore,
	isSubsequence,
	type FuzzyMatchResult,
} from '../../shared/fuzzyMatch';

// The pure matcher lives in shared/ so the TUI uses the same one; re-exported for existing callers.
export { fuzzyMatch, fuzzyMatchWithIndices, fuzzyMatchWithScore, isSubsequence };
export type { FuzzyMatchResult };

/**
 * Slash command definition shape accepted by shared helpers.
 */
interface SlashCommandLike {
	command: string;
	terminalOnly?: boolean;
	aiOnly?: boolean;
}

/**
 * Filter and sort slash commands by fuzzy match against query.
 * Single-pass scoring: each command is scored at most once.
 */
export const filterSlashCommands = <T extends SlashCommandLike>(
	commands: T[],
	query: string,
	isTerminalMode: boolean
): T[] => {
	return commands
		.filter((cmd) => {
			if (cmd.terminalOnly && !isTerminalMode) return false;
			if (cmd.aiOnly && isTerminalMode) return false;
			return true;
		})
		.map((cmd) => {
			const { matches, score } = query
				? fuzzyMatchWithScore(cmd.command.slice(1), query, '.')
				: { matches: true, score: 0 };
			return { cmd, matches, score };
		})
		.filter(({ matches }) => matches)
		.sort((a, b) => b.score - a.score)
		.map(({ cmd }) => cmd);
};

/** Per-character styling for {@link renderFuzzyHighlight}. */
export interface FuzzyHighlightStyles {
	/** Applied to characters the query matched. Defaults to bold. */
	match?: React.CSSProperties;
	/** Applied to every other character. Defaults to slightly dimmed. */
	rest?: React.CSSProperties;
}

const DEFAULT_FUZZY_MATCH_STYLE: React.CSSProperties = { fontWeight: 700 };
const DEFAULT_FUZZY_REST_STYLE: React.CSSProperties = { opacity: 0.8 };

/**
 * Render `text` one character per span, emphasizing the positions in `indices`.
 *
 * This is the counterpart to {@link fuzzyMatchWithIndices}: a fuzzy hit is a
 * scattered subsequence, not a contiguous run, so `highlightMatches` (which
 * marks whole substrings) cannot draw it. Callers pass the index set they got
 * back from the matcher, which keeps the highlighting honest - it shows the
 * exact characters that earned the match.
 *
 * Returns the plain string when there is nothing to emphasize, so the common
 * "no query" case costs no extra DOM.
 */
export const renderFuzzyHighlight = (
	text: string,
	indices: Set<number>,
	styles?: FuzzyHighlightStyles
): React.ReactNode => {
	if (indices.size === 0) return text;
	const matchStyle = styles?.match ?? DEFAULT_FUZZY_MATCH_STYLE;
	const restStyle = styles?.rest ?? DEFAULT_FUZZY_REST_STYLE;
	return Array.from(text).map((ch, i) =>
		React.createElement('span', { key: i, style: indices.has(i) ? matchStyle : restStyle }, ch)
	);
};

/**
 * Render a slash command with fuzzy-matched characters highlighted.
 * Returns a React node: plain string when no query, spans with bold/dim otherwise.
 */
export const highlightSlashCommand = (command: string, query: string): React.ReactNode => {
	if (!query) return command;
	// Matching skips the leading '/', so shift the indices back by one to line
	// them up with the full command string we render.
	const indices = new Set(
		fuzzyMatchWithIndices(command.slice(1).toLowerCase(), query, '.').map((i) => i + 1)
	);
	return renderFuzzyHighlight(command, indices);
};
