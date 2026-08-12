/**
 * Synopsis parsing utilities for batch processing output.
 * Used by both renderer (useBatchProcessor hook) and CLI (batch-processor service).
 *
 * Functions:
 * - parseSynopsis: Parse AI-generated synopsis responses into structured format
 */

import { stripAnsiCodes } from './stringUtils';

/**
 * Sentinel token that AI agents should return when there's nothing meaningful to report.
 * When detected, callers should skip creating a history entry.
 */
export const NOTHING_TO_REPORT = 'NOTHING_TO_REPORT';

interface ParsedSynopsis {
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
 * Check if text is a conversational filler that should be stripped.
 * These are words/phrases that add no information value to a scientific log.
 */
function isConversationalFiller(text: string): boolean {
	const fillerPatterns = [
		/^(excellent|perfect|great|awesome|wonderful|fantastic|good|nice|cool|done|ok|okay|alright|sure|yes|yeah|yep|absolutely|certainly|definitely|indeed|affirmative)[\s!.]*$/i,
		/^(that's|that is|this is|it's|it is)\s+(great|good|perfect|excellent|done|complete|finished)[\s!.]*$/i,
		/^(all\s+)?(set|done|ready|complete|finished|good\s+to\s+go)[\s!.]*$/i,
		/^(looks?\s+)?(good|great|perfect)[\s!.]*$/i,
		/^(here\s+you\s+go|there\s+you\s+go|there\s+we\s+go|here\s+it\s+is)[\s!.]*$/i,
		/^(got\s+it|understood|will\s+do|on\s+it|right\s+away)[\s!.]*$/i,
		/^(no\s+problem|no\s+worries|happy\s+to\s+help)[\s!.]*$/i,
	];
	return fillerPatterns.some((pattern) => pattern.test(text.trim()));
}

/**
 * Check if text is a wrap-up / housekeeping status that should not stand alone
 * as a History list-view headline. Distinct from conversational filler - these
 * are statements about completion / process state rather than reactions.
 *
 * The prompt forbids these in Summary, but models still emit them. When the
 * Summary reduces to one of these, parseSynopsis tries to recover by promoting
 * the Details headline.
 */
function isWrapUpStatus(text: string): boolean {
	const trimmed = text.trim();
	const wholeLinePatterns = [
		/^task\s+(complete|completed|done|finished)[\s!.]*$/i,
		/^pushed(\s+(cleanly|to\s+remote|successfully|the\s+changes?))?[\s!.]*$/i,
		/^all\s+set[\s!.]*$/i,
		/^ready\s+to\s+ship[\s!.]*$/i,
		/^checkbox\s+flipped\s+to\s+\[x?\][\s!.,].*$/i,
		/^no\s+commit\s+needed[\s!.,]*.*$/i,
		/^nothing\s+to\s+commit[\s!.,]*.*$/i,
	];
	if (wholeLinePatterns.some((pattern) => pattern.test(trimmed))) return true;

	// Trailing wrap-up sentence: catches Summary lines that bury a banal
	// housekeeping note as the closer, e.g. "The playbook file is gitignored -
	// no commit needed for that. Task complete."
	const trailingPatterns = [
		/[.!?\s]task\s+(complete|completed|done|finished)[\s!.]*$/i,
		/\bper\s+playbook\s+instructions\b/i,
		/[.!?\s]no\s+commit\s+needed[\s!.]*$/i,
		/[.!?\s]nothing\s+to\s+commit[\s!.]*$/i,
	];
	return trailingPatterns.some((pattern) => pattern.test(trimmed));
}

/**
 * If Details leads with a markdown heading (`#`/`##`/`###`) or a bolded span
 * at the start of the first line (`**Title** ...` or `**Title**`), return the
 * unwrapped title text.
 *
 * The prompt now forbids leading Details with a heading, but models still do
 * it - they put the real lede here while leaving Summary as a status note.
 * When that happens we promote the headline to Summary so the History list
 * view reads correctly. Details is left as-is; the body view continues to
 * show the heading as the model wrote it.
 *
 * Short bold spans like `**Note:**` or `**Warning:**` are filtered out - they
 * are labels, not headlines.
 */
function extractDetailsHeadline(details: string): string | null {
	const firstLine = details
		.split('\n')
		.find((line) => line.trim())
		?.trim();
	if (!firstLine) return null;

	const headingMatch = firstLine.match(/^#{1,6}\s+(.+?)\s*$/);
	if (headingMatch) return headingMatch[1].trim();

	const boldLeadingMatch = firstLine.match(/^\*\*([^*\n]+?)\*\*/);
	if (boldLeadingMatch) {
		const candidate = boldLeadingMatch[1].trim();
		// Skip short labels like "Note:" / "Warning:" - not real headlines.
		if (candidate.length >= 15 && !candidate.endsWith(':')) {
			return candidate;
		}
	}

	return null;
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

	// Rescue case: model put a status/wrap-up note in Summary but the real
	// headline as a markdown heading or bold title at the top of Details.
	// Promote the headline and strip it from Details so the body view doesn't
	// restate the lede.
	const summaryIsWeak =
		!shortSummary ||
		isTemplatePlaceholder(shortSummary) ||
		isConversationalFiller(shortSummary) ||
		isWrapUpStatus(shortSummary);
	if (summaryIsWeak) {
		const headline = extractDetailsHeadline(details);
		if (headline) {
			shortSummary = headline;
			// Intentionally leave `details` untouched - the body view continues
			// to show the model's original content. Only the list-view lede
			// (shortSummary) changes.
		}
	}

	// Check if summary is a template placeholder or conversational filler
	// (NOTE: deliberately excludes isWrapUpStatus here - when there's no
	// rescue headline available, a weak wrap-up Summary is still more useful
	// than the generic "Task completed" default. The rescue block above is
	// where wrap-up status triggers replacement; this block handles the
	// stricter case of *no usable content at all*.)
	if (
		!shortSummary ||
		isTemplatePlaceholder(shortSummary) ||
		isConversationalFiller(shortSummary)
	) {
		// Try to find actual content by looking for non-placeholder, non-filler lines
		const lines = clean.split('\n').filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed &&
				!trimmed.startsWith('**') &&
				!isTemplatePlaceholder(trimmed) &&
				!isConversationalFiller(trimmed) &&
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
