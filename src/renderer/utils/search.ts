import React from 'react';

/**
 * Fuzzy search result with scoring information
 */
export interface FuzzyMatchResult {
	matches: boolean;
	score: number;
}

/**
 * Fuzzy search matching - returns true if all characters in query appear in text in order
 * @param text - The text to search in
 * @param query - The search query
 * @returns true if all query characters appear in text in order
 */
export const fuzzyMatch = (text: string, query: string): boolean => {
	if (!query) return true;
	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();
	let queryIndex = 0;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			queryIndex++;
		}
	}

	return queryIndex === lowerQuery.length;
};

/**
 * Advanced fuzzy search with scoring for ranking results
 *
 * Scoring factors:
 * - Consecutive character matches get bonus points
 * - Matches at the start of the text get bonus points
 * - Shorter text with same matches scores higher (better specificity)
 * - Case-sensitive matches get bonus points
 *
 * @param text - The text to search in
 * @param query - The search query
 * @returns FuzzyMatchResult with matches boolean and score for ranking
 */
export const fuzzyMatchWithScore = (
	text: string,
	query: string,
	extraBoundaryChars?: string
): FuzzyMatchResult => {
	if (!query) {
		return { matches: true, score: 0 };
	}

	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();

	let score = 0;
	let queryIndex = 0;
	let consecutiveMatches = 0;
	let firstMatchIndex = -1;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			// Record first match position
			if (firstMatchIndex === -1) {
				firstMatchIndex = i;
			}

			// Base points for match
			score += 10;

			// Bonus for consecutive matches
			if (consecutiveMatches > 0) {
				score += consecutiveMatches * 5; // Exponential bonus for consecutive chars
			}
			consecutiveMatches++;

			// Bonus for case-sensitive match
			if (text[i] === query[queryIndex]) {
				score += 5;
			}

			// Bonus for match at word boundary (after space, dash, underscore, or start)
			if (
				i === 0 ||
				text[i - 1] === ' ' ||
				text[i - 1] === '-' ||
				text[i - 1] === '_' ||
				text[i - 1] === '/' ||
				(extraBoundaryChars && extraBoundaryChars.includes(text[i - 1]))
			) {
				score += 8;
			}

			queryIndex++;
		} else {
			consecutiveMatches = 0;
		}
	}

	const matches = queryIndex === lowerQuery.length;

	if (matches) {
		// Bonus for early match position (higher score for matches near the start)
		const positionBonus = Math.max(0, 50 - firstMatchIndex);
		score += positionBonus;

		// Bonus for shorter text (better specificity)
		const lengthRatio = query.length / text.length;
		score += Math.floor(lengthRatio * 30);

		// Bonus for exact substring match
		if (lowerText.includes(lowerQuery)) {
			score += 50;
		}

		// Bonus for exact match
		if (lowerText === lowerQuery) {
			score += 100;
		}
	} else {
		score = 0;
	}

	return { matches, score };
};

/**
 * Returns the indices in `text` that match `query` as a fuzzy subsequence,
 * preferring boundary-anchored positions (after separator chars).
 * Returns empty array if no match.
 */
export const fuzzyMatchWithIndices = (
	text: string,
	query: string,
	extraBoundaryChars?: string
): number[] => {
	if (!query || query.length > text.length) return [];

	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();
	const defaultBoundary = ' -_/';
	const boundaryChars = extraBoundaryChars ? defaultBoundary + extraBoundaryChars : defaultBoundary;

	const isBoundary = (i: number) => i === 0 || boundaryChars.includes(text[i - 1]);

	// Check if lowerQuery[from..] is a subsequence of lowerText[after..]
	const canMatchRest = (after: number, from: number): boolean => {
		let q = from;
		for (let j = after; j < lowerText.length && q < lowerQuery.length; j++) {
			if (lowerText[j] === lowerQuery[q]) q++;
		}
		return q === lowerQuery.length;
	};

	// For each query char, prefer a boundary-anchored position, but only if
	// the remaining query can still be matched after that position.
	const indices: number[] = [];
	let qi = 0;
	let ti = 0;

	while (qi < lowerQuery.length && ti < lowerText.length) {
		let firstMatch = -1;
		let boundaryMatch = -1;

		for (let j = ti; j < lowerText.length; j++) {
			if (lowerText[j] === lowerQuery[qi]) {
				if (firstMatch === -1) firstMatch = j;
				if (isBoundary(j) && canMatchRest(j + 1, qi + 1)) {
					boundaryMatch = j;
					break;
				}
			}
		}

		if (firstMatch === -1) return []; // no match possible

		const chosen = boundaryMatch !== -1 ? boundaryMatch : firstMatch;
		indices.push(chosen);
		ti = chosen + 1;
		qi++;
	}

	return qi === lowerQuery.length ? indices : [];
};

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

/**
 * Render a slash command with fuzzy-matched characters highlighted.
 * Matched characters use accent color + semibold (matching Settings search style).
 * When selected, unmatched characters are dimmed so matches stand out on the
 * accent background.
 * Returns a React node: plain string when no query, spans otherwise.
 */
export const highlightSlashCommand = (
	command: string,
	query: string,
	accentColor?: string,
	isSelected?: boolean
): React.ReactNode => {
	if (!query) return command;
	const indices = new Set(
		fuzzyMatchWithIndices(command.slice(1).toLowerCase(), query, '.').map((i) => i + 1)
	);
	if (indices.size === 0) return command;
	return Array.from(command).map((ch, i) =>
		React.createElement(
			'span',
			{
				key: i,
				style: indices.has(i)
					? { color: isSelected ? undefined : accentColor, fontWeight: isSelected ? 800 : 600 }
					: isSelected
						? { opacity: 0.6 }
						: undefined,
			},
			ch
		)
	);
};
