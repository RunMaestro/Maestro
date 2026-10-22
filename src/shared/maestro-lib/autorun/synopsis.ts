/**
 * The synopsis of an Auto Run turn, taken from the agent's own answer.
 *
 * The Auto Run prompts tell the agent to open its reply with a synopsis, so a surface that wants
 * one reads the first paragraph instead of spending a second turn on a summary. These two
 * functions are the desktop's rules (`useDocumentProcessor`, `useGoalRunner`), moved here so the
 * desktop and the runtime cannot word the same answer two ways. The desktop imports them back.
 */

/** A first paragraph of this many characters or fewer is not a synopsis. */
const MIN_SYNOPSIS_CHARS = 10;
/** A first paragraph with no sentence end is cut here. */
const MAX_SYNOPSIS_CHARS = 150;

/** Ends at sentence punctuation followed by a capital, a newline, or the end, so `file.tsx` survives. */
const FIRST_SENTENCE = /^.+?[.!?](?=\s+[A-Z]|\s*\n|\s*$)/;

function cleanFirstParagraph(text: string): string {
	const firstParagraph = text.split(/\n\n+/)[0]?.trim() ?? '';
	return firstParagraph
		.replace(/^\*\*Summary:\*\*\s*/i, '')
		.replace(/^#+\s*/, '')
		.replace(/\*\*/g, '')
		.trim();
}

function firstSentenceOrPrefix(cleaned: string): string {
	const sentence = cleaned.match(FIRST_SENTENCE);
	if (sentence) return sentence[0].trim();
	return cleaned.length > MAX_SYNOPSIS_CHARS
		? `${cleaned.slice(0, MAX_SYNOPSIS_CHARS)}...`
		: cleaned;
}

export interface TaskSynopsis {
	shortSummary: string;
	fullSynopsis: string;
}

/**
 * The synopsis of a task turn that succeeded: the first sentence of the response's first
 * paragraph, and the whole response as the full text. A response with nothing usable in it keeps
 * the plain `Task completed` line.
 */
export function extractTaskSynopsis(response: string | undefined, filename: string): TaskSynopsis {
	const fallback = `[${filename}] Task completed`;
	const responseText = response?.trim();
	if (!responseText) return { shortSummary: fallback, fullSynopsis: fallback };
	const cleaned = cleanFirstParagraph(responseText);
	if (cleaned.length <= MIN_SYNOPSIS_CHARS)
		return { shortSummary: fallback, fullSynopsis: fallback };
	return { shortSummary: firstSentenceOrPrefix(cleaned), fullSynopsis: responseText };
}

/**
 * A short, marker-free line for a goal iteration: the first sentence of the response's first
 * paragraph with the `maestro:` control markers dropped.
 */
export function extractGoalSynopsis(response: string | undefined, iteration: number): string {
	const fallback = `Iteration ${iteration} completed`;
	if (!response) return fallback;
	const withoutMarkers = response.replace(/<!--\s*maestro:[\s\S]*?-->/g, '').trim();
	if (!withoutMarkers) return fallback;
	const cleaned = cleanFirstParagraph(withoutMarkers);
	if (cleaned.length <= MIN_SYNOPSIS_CHARS) return fallback;
	return firstSentenceOrPrefix(cleaned);
}
