/**
 * Sentence segmentation for spoken output.
 *
 * The session service and every `TtsProvider` have to agree on where one spoken
 * sentence ends: the service announces `sentenceCount` in `speak-start` before
 * the provider has emitted anything, and the provider emits one `speak-sentence`
 * per sentence. Two independent splitters would drift and a client's "3 of 5"
 * progress would never reach its total, so there is exactly one splitter and
 * both sides call it.
 */

/**
 * Longest run emitted as a single sentence. Text without punctuation (a pasted
 * log line, a model that forgot to end its sentences) is hard-wrapped at a word
 * boundary rather than handed to TTS as one unbreakable minute of speech, which
 * would make barge-in feel broken.
 */
export const MAX_SPOKEN_SENTENCE_LENGTH = 240;

/**
 * Sentence boundary: terminal punctuation followed by whitespace or end of
 * input. The lookbehind keeps "U.S." and other single-capital runs intact.
 */
const SENTENCE_BOUNDARY = /(?<![A-Z])[.!?]+(?=\s|$)/g;

/**
 * Words that take a trailing period without ending a sentence. Deliberately
 * short: a missed abbreviation splits one spoken sentence into two, which is
 * survivable, while an over-broad list swallows real boundaries and makes TTS
 * read two sentences as one breathless run.
 */
const ABBREVIATIONS = new Set([
	'mr',
	'mrs',
	'ms',
	'dr',
	'prof',
	'sr',
	'jr',
	'st',
	'vs',
	'eg',
	'ie',
	'am',
	'pm',
	'fig',
	'approx',
	'inc',
	'ltd',
]);

/** True when the text ends in an abbreviation or an initial ("Dr", "e.g", "J"). */
function endsWithAbbreviation(text: string): boolean {
	const token = text.trimEnd().split(/\s+/).pop() ?? '';
	const bare = token.replace(/\./g, '').toLowerCase();
	if (!bare) return false;
	if (bare.length === 1 && /[a-z]/.test(bare)) return true;
	return ABBREVIATIONS.has(bare);
}

/** Trim, hard-wrap if needed, and append. Empty fragments are dropped. */
function pushSentence(out: string[], fragment: string): void {
	let rest = fragment.trim();
	if (!rest) return;

	while (rest.length > MAX_SPOKEN_SENTENCE_LENGTH) {
		const window = rest.slice(0, MAX_SPOKEN_SENTENCE_LENGTH);
		const cut = window.lastIndexOf(' ');
		const head = cut > 0 ? window.slice(0, cut) : window;
		out.push(head.trim());
		rest = rest.slice(head.length).trim();
	}

	out.push(rest);
}

/**
 * Split text into the sentences a TTS provider should speak, one per chunk.
 * Whitespace is normalized first so a wrapped agent reply does not produce
 * sentences with embedded newlines.
 */
export function splitIntoSpokenSentences(text: string): string[] {
	const normalized = text.trim().replace(/\s+/g, ' ');
	if (!normalized) return [];

	const sentences: string[] = [];
	let start = 0;
	let match: RegExpExecArray | null;

	SENTENCE_BOUNDARY.lastIndex = 0;
	while ((match = SENTENCE_BOUNDARY.exec(normalized)) !== null) {
		if (match[0] === '.' && endsWithAbbreviation(normalized.slice(start, match.index))) continue;

		const end = match.index + match[0].length;
		pushSentence(sentences, normalized.slice(start, end));
		start = end;
	}
	pushSentence(sentences, normalized.slice(start));

	return sentences;
}

/** How many `speak-sentence` events a given text will produce. */
export function countSpokenSentences(text: string): number {
	return splitIntoSpokenSentences(text).length;
}
