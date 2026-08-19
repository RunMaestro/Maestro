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
 * input.
 *
 * Requiring whitespace after the period is what keeps the three things agents
 * write constantly out of the splitter's way without a single special case:
 * `1.5`, `v1.2.3`, and `src/main/index.ts` all have a non-space character after
 * every internal period, so none of them is ever a candidate. Only the period
 * that genuinely ends the clause reaches {@link endsWithAbbreviation}.
 */
const SENTENCE_BOUNDARY = /[.!?]+(?=\s|$)/g;

/**
 * A dotted initialism: "U.S.", "e.g.", "a.k.a". At least one internal period,
 * every segment a single letter.
 *
 * This replaces an earlier `(?<![A-Z])` lookbehind on the boundary regex, which
 * bought "U.S." at the cost of every acronym an agent actually writes: "Fixed
 * the API. Then I ran the tests." was one unbroken sentence because the period
 * followed a capital letter, and TTS read it as one breathless run.
 */
const DOTTED_INITIALISM = /^(?:[A-Za-z]\.){1,}[A-Za-z]?$/;

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
	if (DOTTED_INITIALISM.test(token)) return true;

	const bare = token.replace(/\./g, '').toLowerCase();
	if (!bare) return false;
	// A lone letter is an initial ("J. Random"), never a whole word.
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

/**
 * Split a growing buffer into the sentences that are definitely finished and the
 * tail that is not.
 *
 * The streaming half of {@link splitIntoSpokenSentences}, for the translator and
 * the speech scheduler: both are handed text a few tokens at a time and have to
 * decide, without ever seeing the end, which prefix is safe to hand to TTS. The
 * last fragment is always held back even when it looks terminated, because the
 * character after a period is exactly what decides whether it was one - a buffer
 * ending in "index." becomes "index.ts" on the next token, and a sentence that
 * was already synthesized cannot be taken back.
 *
 * @returns `sentences` in order, and `rest` to keep buffering.
 */
export function splitCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
	// Whether the buffer ended mid-word survives into `rest`, because the caller
	// concatenates the next delta straight onto it: swallowing the separator here
	// is how "Done, " plus "the auth bug" becomes "Done,the auth bug".
	const trailingSpace = /\s$/.test(buffer);
	const normalized = buffer.replace(/\s+/g, ' ').trimStart();
	if (!normalized) return { sentences: [], rest: trailingSpace ? ' ' : '' };

	// A trailing space proves the writer moved past the punctuation, so the whole
	// buffer is decidable and nothing has to be held back.
	const settled = trailingSpace ? normalized : normalized.replace(/\S+$/, '');
	const tail = normalized.slice(settled.length);

	const sentences = splitIntoSpokenSentences(settled);
	// An unterminated remainder is not a sentence yet, however long it is: it is
	// the front half of the one still being written.
	const last = sentences[sentences.length - 1];
	let carry = '';
	if (last && !/[.!?]$/.test(last)) {
		sentences.pop();
		carry = last;
	}

	let rest = [carry, tail].filter(Boolean).join(' ');
	if (rest && !tail && trailingSpace) rest += ' ';
	return { sentences, rest };
}

/** How many `speak-sentence` events a given text will produce. */
export function countSpokenSentences(text: string): number {
	return splitIntoSpokenSentences(text).length;
}

/** Conversational pace. Fast enough that a typed utterance is not reported as a speech. */
const WORDS_PER_MINUTE = 150;

/**
 * How long `text` would have taken to say.
 *
 * Every text-in seam (the dev harness, a client that typed instead of spoke)
 * has to put SOMETHING in `FinalTranscriptEvent.durationMs`, because a
 * transcript timeline with a hole in it is worse than one with an estimate. One
 * estimator so two providers cannot report different durations for the same
 * sentence.
 */
export function estimateSpokenDurationMs(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	return Math.round((words / WORDS_PER_MINUTE) * 60_000);
}
