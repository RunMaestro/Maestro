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
export const fuzzyMatchWithScore = (text: string, query: string): FuzzyMatchResult => {
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
				text[i - 1] === '/'
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
