/**
 * Wizard Intent Parser Service
 *
 * Parses natural language input to determine the user's intent when invoking
 * the `/wizard` command. Detects whether the user wants to create new Auto Run
 * documents or iterate on existing ones.
 *
 * @example
 * ```ts
 * // User types: /wizard add authentication feature
 * const result = parseWizardIntent("add authentication feature", true);
 * // result: { mode: 'iterate', goal: 'add authentication feature' }
 *
 * // User types: /wizard start fresh
 * const result = parseWizardIntent("start fresh", true);
 * // result: { mode: 'new' }
 *
 * // User types: /wizard (no additional text)
 * const result = parseWizardIntent("", true);
 * // result: { mode: 'ask' }
 * ```
 */

/**
 * Result from parsing wizard intent.
 */
export interface WizardIntentResult {
	/**
	 * The detected mode:
	 * - 'new': Create new documents from scratch
	 * - 'iterate': Modify/extend existing documents
	 * - 'ask': Ambiguous intent, prompt user for clarification
	 */
	mode: 'new' | 'iterate' | 'ask';
	/**
	 * The extracted goal for iterate mode (the part of input after intent keywords).
	 * Only present when mode is 'iterate'.
	 */
	goal?: string;
}

/**
 * Keywords that indicate the user wants to start fresh with new documents.
 * These trigger 'new' mode.
 */
const NEW_MODE_KEYWORDS = [
	'new',
	'fresh',
	'start',
	'create',
	'begin',
	'scratch',
	'from scratch',
	'start over',
	'start fresh',
	'start new',
	'create new',
	'new project',
	'fresh start',
	'reset',
	'clear',
	'blank',
] as const;

/**
 * Keywords that indicate the user wants to iterate on existing documents.
 * These trigger 'iterate' mode.
 */
const ITERATE_MODE_KEYWORDS = [
	'continue',
	'iterate',
	'add',
	'update',
	'modify',
	'extend',
	'expand',
	'change',
	'edit',
	'append',
	'include',
	'enhance',
	'improve',
	'refine',
	'augment',
	'adjust',
	'revise',
	'next',
	'next phase',
	'more',
	'additional',
	'another',
] as const;

/**
 * Normalizes input text for keyword matching.
 * Converts to lowercase and trims whitespace.
 */
function normalizeInput(input: string): string {
	return input.toLowerCase().trim();
}

/**
 * Checks if the normalized input starts with any of the given keywords.
 * Returns the matched keyword if found.
 */
function matchesKeywordPrefix(normalizedInput: string, keywords: readonly string[]): string | null {
	for (const keyword of keywords) {
		if (normalizedInput.startsWith(keyword)) {
			return keyword;
		}
	}
	return null;
}

/**
 * Checks if the normalized input contains any of the given keywords.
 * Uses word boundary awareness to avoid partial matches.
 * Returns the matched keyword if found.
 */
function matchesKeywordAnywhere(
	normalizedInput: string,
	keywords: readonly string[]
): string | null {
	const words = normalizedInput.split(/\s+/);

	for (const keyword of keywords) {
		// For multi-word keywords, check if the phrase exists
		if (keyword.includes(' ')) {
			if (normalizedInput.includes(keyword)) {
				return keyword;
			}
		} else {
			// For single-word keywords, check word boundaries
			if (words.includes(keyword)) {
				return keyword;
			}
		}
	}
	return null;
}

/**
 * Extracts the goal from the input by removing the matched keyword prefix.
 * Returns the remaining text as the goal.
 */
function extractGoal(input: string, matchedKeyword: string): string {
	const normalized = input.toLowerCase().trim();
	const keywordIndex = normalized.indexOf(matchedKeyword.toLowerCase());

	if (keywordIndex === -1) {
		return input.trim();
	}

	// Get the text after the keyword
	const afterKeyword = input.slice(keywordIndex + matchedKeyword.length).trim();

	// If the text after keyword is empty, return the original input as the goal
	if (!afterKeyword) {
		return input.trim();
	}

	return afterKeyword;
}

/**
 * Parses natural language input to determine the wizard mode.
 *
 * Intent detection logic:
 * 1. If input is empty and docs exist → 'ask' (need clarification)
 * 2. If input is empty and no docs exist → 'new' (obvious intent)
 * 3. If input matches 'new' keywords → 'new' mode
 * 4. If input matches 'iterate' keywords → 'iterate' mode with extracted goal
 * 5. If has existing docs and ambiguous → 'ask' (need clarification)
 * 6. If no existing docs and ambiguous → 'new' (default for new projects)
 *
 * @param input - The text after `/wizard ` command
 * @param hasExistingDocs - Whether the project has existing Auto Run documents
 * @returns The parsed intent result with mode and optional goal
 */
export function parseWizardIntent(input: string, hasExistingDocs: boolean): WizardIntentResult {
	const normalizedInput = normalizeInput(input);

	// Case 1: No input provided
	if (!normalizedInput) {
		// If docs exist, we need to ask the user what they want
		if (hasExistingDocs) {
			return { mode: 'ask' };
		}
		// No docs exist, default to new mode
		return { mode: 'new' };
	}

	// Case 2: Check for 'new' mode keywords (prioritize prefix match)
	const newKeywordPrefix = matchesKeywordPrefix(normalizedInput, NEW_MODE_KEYWORDS);
	if (newKeywordPrefix) {
		return { mode: 'new' };
	}

	// Case 3: Check for 'iterate' mode keywords (prioritize prefix match)
	const iterateKeywordPrefix = matchesKeywordPrefix(normalizedInput, ITERATE_MODE_KEYWORDS);
	if (iterateKeywordPrefix) {
		const goal = extractGoal(input, iterateKeywordPrefix);
		return { mode: 'iterate', goal };
	}

	// Case 4: Check for keywords anywhere in input (less strict matching)
	const newKeywordAnywhere = matchesKeywordAnywhere(normalizedInput, NEW_MODE_KEYWORDS);
	if (newKeywordAnywhere) {
		return { mode: 'new' };
	}

	const iterateKeywordAnywhere = matchesKeywordAnywhere(normalizedInput, ITERATE_MODE_KEYWORDS);
	if (iterateKeywordAnywhere) {
		const goal = extractGoal(input, iterateKeywordAnywhere);
		return { mode: 'iterate', goal };
	}

	// Case 5: Ambiguous input
	// If the user provided text but we can't determine intent:
	// - With existing docs: ask for clarification
	// - Without existing docs: treat the input as the goal for a new project
	if (hasExistingDocs) {
		// Ambiguous with existing docs - could be describing new work or iterating
		// Ask for clarification
		return { mode: 'ask' };
	}

	// No existing docs - treat input as a new project description
	// The input becomes the initial context for the new wizard session
	return { mode: 'new' };
}

/**
 * Check if a string indicates iterate intent based on common patterns.
 * Useful for more nuanced detection beyond simple keyword matching.
 *
 * @param input - The input to check
 * @returns True if the input suggests iterate intent
 */
export function suggestsIterateIntent(input: string): boolean {
	const normalized = normalizeInput(input);

	// Check for verb patterns that suggest modification
	const modificationPatterns = [
		/^i want to (add|update|modify|change|extend)/,
		/^(add|update|modify|change|extend|include) (a|an|the|some|more)/,
		/^(can you|could you|please) (add|update|modify|change|extend)/,
		/^let'?s (add|update|modify|change|extend)/,
		/^we need to (add|update|modify|change|extend)/,
		/^(also|additionally|furthermore)/,
		/^(next|now|then) (add|let'?s|we|i)/,
	];

	return modificationPatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Check if a string indicates new intent based on common patterns.
 *
 * @param input - The input to check
 * @returns True if the input suggests new intent
 */
export function suggestsNewIntent(input: string): boolean {
	const normalized = normalizeInput(input);

	// Check for patterns that suggest starting fresh
	const newPatterns = [
		/^(i want to|let'?s|we should) (start|create|begin) (fresh|new|over)/,
		/^start(ing)? (from scratch|over|fresh)/,
		/^(forget|ignore|discard) (the|all) (existing|previous|old)/,
		/^(new|fresh) (project|plan|document)/,
		/^(create|build|design) (a new|something new)/,
	];

	return newPatterns.some((pattern) => pattern.test(normalized));
}
