/**
 * Custom regex patterns support for LLM Guard.
 * Allows users to define their own patterns for detecting specific content.
 */

import type { CustomPattern, LlmGuardFinding } from './types';

/**
 * Result from validating a regex pattern.
 */
export interface PatternValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Result from testing a pattern against sample text.
 */
export interface PatternTestResult {
	matches: Array<{
		value: string;
		start: number;
		end: number;
	}>;
	error?: string;
}

/**
 * Finding from custom pattern matching with additional context.
 */
export interface CustomPatternFinding extends LlmGuardFinding {
	/** ID of the pattern that matched */
	patternId: string;
	/** Name of the pattern that matched */
	patternName: string;
}

/**
 * Validate a regex pattern string.
 * Ensures the pattern can be compiled without errors.
 *
 * @param pattern - The regex pattern string to validate
 * @returns Validation result with valid flag and optional error message
 */
export function validatePattern(pattern: string): PatternValidationResult {
	if (!pattern || pattern.trim() === '') {
		return { valid: false, error: 'Pattern cannot be empty' };
	}

	try {
		// Attempt to compile the regex with the flags we'll use
		new RegExp(pattern, 'gi');
		return { valid: true };
	} catch (e) {
		const error = e instanceof Error ? e.message : 'Invalid regex pattern';
		return { valid: false, error };
	}
}

/**
 * Test a pattern against sample text.
 * Returns all matches found in the sample.
 *
 * @param pattern - The regex pattern string to test
 * @param sampleText - The sample text to test against
 * @returns Test result with matches array and optional error
 */
export function testPattern(pattern: string, sampleText: string): PatternTestResult {
	const validation = validatePattern(pattern);
	if (!validation.valid) {
		return { matches: [], error: validation.error };
	}

	try {
		const regex = new RegExp(pattern, 'gi');
		const matches: PatternTestResult['matches'] = [];
		let match: RegExpExecArray | null;

		while ((match = regex.exec(sampleText)) !== null) {
			// Prevent infinite loops on zero-length matches
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}

			matches.push({
				value: match[0],
				start: match.index,
				end: match.index + match[0].length,
			});
		}

		return { matches };
	} catch (e) {
		const error = e instanceof Error ? e.message : 'Error testing pattern';
		return { matches: [], error };
	}
}

/**
 * Apply custom patterns to text and return findings.
 * Only enabled patterns are applied.
 *
 * @param text - The text to scan
 * @param patterns - Array of custom patterns to apply
 * @returns Array of findings from custom pattern matches
 */
export function applyCustomPatterns(
	text: string,
	patterns: CustomPattern[] | undefined
): CustomPatternFinding[] {
	if (!patterns || patterns.length === 0) {
		return [];
	}

	const findings: CustomPatternFinding[] = [];

	for (const pattern of patterns) {
		// Skip disabled patterns
		if (!pattern.enabled) {
			continue;
		}

		// Validate pattern before use
		const validation = validatePattern(pattern.pattern);
		if (!validation.valid) {
			// Skip invalid patterns silently (they were validated on save)
			continue;
		}

		try {
			const regex = new RegExp(pattern.pattern, 'gi');
			let match: RegExpExecArray | null;

			while ((match = regex.exec(text)) !== null) {
				// Prevent infinite loops on zero-length matches
				if (match[0].length === 0) {
					regex.lastIndex++;
					continue;
				}

				const value = match[0];
				findings.push({
					type: `CUSTOM_${pattern.type.toUpperCase()}`,
					value,
					start: match.index,
					end: match.index + value.length,
					confidence: pattern.confidence,
					patternId: pattern.id,
					patternName: pattern.name,
				});
			}
		} catch {
			// Skip patterns that fail during execution
			continue;
		}
	}

	return findings;
}

/**
 * Sanitize text by replacing custom pattern matches with placeholders.
 *
 * @param text - The text to sanitize
 * @param findings - Findings from custom pattern matching
 * @returns Sanitized text with placeholders
 */
export function sanitizeCustomPatternMatches(
	text: string,
	findings: CustomPatternFinding[]
): string {
	if (findings.length === 0) {
		return text;
	}

	// Sort findings by start position descending (process from end to beginning)
	const sortedFindings = [...findings].sort((a, b) => b.start - a.start);

	// Filter out overlapping findings (keep rightmost)
	const nonOverlapping: CustomPatternFinding[] = [];
	let lastStart = Infinity;

	for (const finding of sortedFindings) {
		if (finding.end > lastStart) {
			continue;
		}
		nonOverlapping.push(finding);
		lastStart = finding.start;
	}

	// Apply replacements
	let result = text;
	for (let i = 0; i < nonOverlapping.length; i++) {
		const finding = nonOverlapping[i];
		const index = nonOverlapping.length - i;
		const placeholder = `[CUSTOM_${finding.type.replace('CUSTOM_', '')}_${index}]`;
		result = result.slice(0, finding.start) + placeholder + result.slice(finding.end);
	}

	return result;
}

/**
 * Generate a unique ID for a new custom pattern.
 */
export function generatePatternId(): string {
	return `pattern_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a new custom pattern with default values.
 */
export function createDefaultPattern(): CustomPattern {
	return {
		id: generatePatternId(),
		name: '',
		pattern: '',
		type: 'other',
		action: 'warn',
		confidence: 0.8,
		enabled: true,
		description: '',
	};
}

/**
 * Export custom patterns as JSON string.
 */
export function exportPatterns(patterns: CustomPattern[]): string {
	return JSON.stringify(patterns, null, 2);
}

/**
 * Import custom patterns from JSON string.
 * Validates each pattern and assigns new IDs.
 *
 * @param json - JSON string containing patterns array
 * @returns Array of imported patterns or null if invalid
 */
export function importPatterns(json: string): CustomPattern[] | null {
	try {
		const parsed = JSON.parse(json);

		if (!Array.isArray(parsed)) {
			return null;
		}

		const patterns: CustomPattern[] = [];

		for (const item of parsed) {
			// Validate required fields
			if (
				typeof item.name !== 'string' ||
				typeof item.pattern !== 'string' ||
				!['secret', 'pii', 'injection', 'other'].includes(item.type) ||
				!['warn', 'sanitize', 'block'].includes(item.action) ||
				typeof item.confidence !== 'number'
			) {
				continue;
			}

			// Validate the regex pattern itself
			const validation = validatePattern(item.pattern);
			if (!validation.valid) {
				continue;
			}

			// Create pattern with new ID (preserve other fields)
			patterns.push({
				id: generatePatternId(),
				name: item.name,
				pattern: item.pattern,
				type: item.type,
				action: item.action,
				confidence: Math.max(0, Math.min(1, item.confidence)),
				enabled: item.enabled !== false,
				description: item.description || '',
			});
		}

		return patterns;
	} catch {
		return null;
	}
}
