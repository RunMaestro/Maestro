/**
 * Synopsis parsing utilities for batch processing output.
 * Used by both renderer (useBatchProcessor hook) and CLI (batch-processor service).
 *
 * Functions:
 * - parseSynopsis: Parse AI-generated synopsis responses into structured format
 * - isNothingToReport: Check if response indicates no meaningful work was done
 */

import { stripAnsiCodes } from './stringUtils';

/**
 * Sentinel token that AI agents should return when there's nothing meaningful to report.
 * When detected, callers should skip creating a history entry.
 */
export const NOTHING_TO_REPORT = 'NOTHING_TO_REPORT';

export interface ParsedSynopsis {
	shortSummary: string;
	fullSynopsis: string;
	/** True if the AI indicated there was nothing meaningful to report */
	nothingToReport: boolean;
}

/**
 * Check if text is a template placeholder that wasn't filled in.
 * These appear when the model outputs the format instructions literally.
 */
function isTemplatePlaceholder(text: string): boolean {
	const placeholderPatterns = [
		/^\[.*sentences.*\]$/i, // [1-2 sentences describing...]
		/^\[.*paragraph.*\]$/i, // [A paragraph with...]
		/^\.\.\.\s*\(/, // ... (1-2 sentences)
		/^\.\.\.\s*then\s+blank/i, // ... then blank line
		/^then\s+blank/i, // then blank line
		/^\(1-2\s+sentences\)/i, // (1-2 sentences)
	];
	return placeholderPatterns.some((pattern) => pattern.test(text.trim()));
}

/**
 * Check if a response indicates nothing meaningful to report.
 * Looks for the NOTHING_TO_REPORT sentinel token anywhere in the response.
 *
 * @param response - Raw AI response string
 * @returns True if the response contains NOTHING_TO_REPORT
 */
export function isNothingToReport(response: string): boolean {
	const clean = stripAnsiCodes(response)
		.replace(/─+/g, '')
		.replace(/[│┌┐└┘├┤┬┴┼]/g, '')
		.trim();

	return clean.includes(NOTHING_TO_REPORT);
}

/**
 * Parse a synopsis response into short summary and full synopsis.
 *
 * Expected AI response format:
 *   **Summary:** Short 1-2 sentence summary
 *   **Details:** Detailed paragraph...
 *
 * Falls back to using the first line as summary if format not detected.
 * Filters out template placeholders that models sometimes output literally
 * (especially common with thinking/reasoning models).
 *
 * If the response contains NOTHING_TO_REPORT, returns nothingToReport: true
 * and callers should skip creating a history entry.
 *
 * @param response - Raw AI response string (may contain ANSI codes, box drawing chars)
 * @returns Parsed synopsis with shortSummary, fullSynopsis, and nothingToReport flag
 */
export function parseSynopsis(response: string): ParsedSynopsis {
	// Clean up ANSI codes and box drawing characters
	const clean = stripAnsiCodes(response)
		.replace(/─+/g, '')
		.replace(/[│┌┐└┘├┤┬┴┼]/g, '')
		.trim();

	// Check for the sentinel token first
	if (clean.includes(NOTHING_TO_REPORT)) {
		return {
			shortSummary: '',
			fullSynopsis: '',
			nothingToReport: true,
		};
	}

	// Try to extract Summary and Details sections
	const summaryMatch = clean.match(/\*\*Summary:\*\*\s*(.+?)(?=\*\*Details:\*\*|$)/is);
	const detailsMatch = clean.match(/\*\*Details:\*\*\s*(.+?)$/is);

	let shortSummary = summaryMatch?.[1]?.trim() || '';
	let details = detailsMatch?.[1]?.trim() || '';

	// Check if summary is a template placeholder (model output format instructions literally)
	if (!shortSummary || isTemplatePlaceholder(shortSummary)) {
		// Try to find actual content by looking for non-placeholder lines
		const lines = clean.split('\n').filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed &&
				!trimmed.startsWith('**') &&
				!isTemplatePlaceholder(trimmed) &&
				!trimmed.match(/^Rules:/i) &&
				!trimmed.match(/^-\s+Be specific/i) &&
				!trimmed.match(/^-\s+Focus only/i) &&
				!trimmed.match(/^-\s+If nothing/i) &&
				!trimmed.match(/^Provide a brief synopsis/i)
			);
		});
		shortSummary = lines[0]?.trim() || 'Task completed';
	}

	// Check if details is a template placeholder
	if (isTemplatePlaceholder(details)) {
		details = '';
	}

	// Full synopsis includes both parts
	const fullSynopsis = details ? `${shortSummary}\n\n${details}` : shortSummary;

	return { shortSummary, fullSynopsis, nothingToReport: false };
}
