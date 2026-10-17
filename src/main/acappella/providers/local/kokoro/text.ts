/**
 * Kokoro's English text front end: text in, the phoneme string Kokoro was
 * trained on out.
 *
 * Kokoro takes PHONEME ids, not characters, so every sentence goes through
 * three steps before the model sees it:
 *
 *   1. Normalize: spell out what a reader would say for years, clock times,
 *      money and decimals, and fold typographic quotes.
 *   2. Phonemize each run of words with espeak-ng, leaving the punctuation
 *      between runs where it was (the model reads punctuation as prosody, and
 *      espeak drops it).
 *   3. Post-process: a handful of substitutions that turn espeak's phoneme set
 *      into the one in Kokoro's vocabulary.
 *
 * This is a port of `phonemize.js` from kokoro-js (github.com/hexgrad/kokoro,
 * `kokoro.js/src/phonemize.js` at 664c76a, Apache-2.0), kept rule for rule. It
 * is NOT tidied: the model learned from text prepared by exactly these rules,
 * so a "fix" here (the whitespace collapse that only replaces its first match,
 * parentheses becoming guillemets that the vocabulary then drops) changes the
 * input away from what the voice was trained on. A golden test pins the ids
 * for one sentence against the reference implementation.
 *
 * espeak-ng itself is injected (`EspeakPhonemize`), so this module is pure and
 * testable without it. See `espeak.ts` for the real one.
 */

/** espeak-ng for one run of words. Returns one phoneme string per clause. */
export type EspeakPhonemize = (text: string, language: 'en-us' | 'en') => Promise<string[]>;

/**
 * Which English a voice speaks, by the first letter of its id: `a` is American
 * (`af_heart`), `b` is British.
 */
export type KokoroLanguage = 'a' | 'b';

interface Section {
	/** True when the text is punctuation kept as it is; false for words. */
	match: boolean;
	text: string;
}

/** Cut `text` into alternating runs: what `regex` matched, and what lies between. */
function splitOnPattern(text: string, regex: RegExp): Section[] {
	const result: Section[] = [];
	let prev = 0;
	for (const match of text.matchAll(regex)) {
		const fullMatch = match[0];
		const index = match.index ?? 0;
		if (prev < index) result.push({ match: false, text: text.slice(prev, index) });
		if (fullMatch.length > 0) result.push({ match: true, text: fullMatch });
		prev = index + fullMatch.length;
	}
	if (prev < text.length) result.push({ match: false, text: text.slice(prev) });
	return result;
}

/** A year ("1999" as "19 99"), a clock time ("3:05" as "3 oh 5"), or a decimal left for later. */
function splitNum(match: string): string {
	if (match.includes('.')) return match;
	if (match.includes(':')) {
		const [h, m] = match.split(':').map(Number);
		if (m === 0) return `${h} o'clock`;
		if (m < 10) return `${h} oh ${m}`;
		return `${h} ${m}`;
	}
	const year = parseInt(match.slice(0, 4), 10);
	if (year < 1100 || year % 1000 < 10) return match;
	const left = match.slice(0, 2);
	const right = parseInt(match.slice(2, 4), 10);
	const suffix = match.endsWith('s') ? 's' : '';
	if (year % 1000 >= 100 && year % 1000 <= 999) {
		if (right === 0) return `${left} hundred${suffix}`;
		if (right < 10) return `${left} oh ${right}${suffix}`;
	}
	return `${left} ${right}${suffix}`;
}

/** "$9.99" as "9 dollars and 99 cents". */
function flipMoney(match: string): string {
	const bill = match[0] === '$' ? 'dollar' : 'pound';
	if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
	if (!match.includes('.')) {
		const suffix = match.slice(1) === '1' ? '' : 's';
		return `${match.slice(1)} ${bill}${suffix}`;
	}
	const [b, c] = match.slice(1).split('.');
	const d = parseInt(c.padEnd(2, '0'), 10);
	const coins = match[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence';
	return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}

/** "3.14" as "3 point 1 4". */
function pointNum(match: string): string {
	const [a, b] = match.split('.');
	return `${a} point ${b.split('').join(' ')}`;
}

/** Step 1. What a reader would say, in characters espeak reads correctly. */
export function normalizeKokoroText(text: string): string {
	return (
		text
			// Quotes and brackets
			.replace(/[\u2018\u2019]/g, "'")
			.replace(/\u00ab/g, '\u201c')
			.replace(/\u00bb/g, '\u201d')
			.replace(/[\u201c\u201d]/g, '"')
			.replace(/\(/g, '\u00ab')
			.replace(/\)/g, '\u00bb')

			// Full-width punctuation
			.replace(/\u3001/g, ', ')
			.replace(/\u3002/g, '. ')
			.replace(/\uff01/g, '! ')
			.replace(/\uff0c/g, ', ')
			.replace(/\uff1a/g, ': ')
			.replace(/\uff1b/g, '; ')
			.replace(/\uff1f/g, '? ')

			// Whitespace. The middle rule has no `g` flag in the reference, so it
			// collapses only the first run of spaces. Kept for parity.
			.replace(/[^\S \n]/g, ' ')
			.replace(/  +/, ' ')
			.replace(/(?<=\n) +(?=\n)/g, '')

			// Abbreviations
			.replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
			.replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
			.replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
			.replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
			.replace(/\betc\.(?! [A-Z])/gi, 'etc')

			// Casual words
			.replace(/\b(y)eah?\b/gi, "$1e'a")

			// Numbers and currencies
			.replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
			.replace(/(?<=\d),(?=\d)/g, '')
			.replace(
				/[$\u00a3]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$\u00a3]\d+\.\d\d?\b/gi,
				flipMoney
			)
			.replace(/\d*\.\d+/g, pointNum)
			.replace(/(?<=\d)-(?=\d)/g, ' to ')
			.replace(/(?<=\d)S/g, ' S')

			// Possessives
			.replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
			.replace(/(?<=X')S\b/g, 's')

			// Dotted initials
			.replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
			.replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')

			.trim()
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Punctuation the model reads as prosody. Everything here survives phonemizing as itself. */
const PUNCTUATION = ';:,.!?\u00a1\u00bf\u2014\u2026"\u00ab\u00bb\u201c\u201d(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${escapeRegExp(PUNCTUATION)}]+\\s*)+`, 'g');

/**
 * Text to Kokoro's phoneme string: normalize, phonemize the words between
 * punctuation, then map espeak's phonemes onto Kokoro's.
 */
export async function kokoroPhonemes(
	text: string,
	espeak: EspeakPhonemize,
	language: KokoroLanguage = 'a'
): Promise<string> {
	const normalized = normalizeKokoroText(text);
	const sections = splitOnPattern(normalized, PUNCTUATION_PATTERN);
	const lang = language === 'a' ? 'en-us' : 'en';
	const parts = await Promise.all(
		sections.map(async (section) =>
			section.match ? section.text : (await espeak(section.text, lang)).join(' ')
		)
	);

	let processed = parts
		.join('')
		// The word "kokoro" itself, which espeak stresses on the wrong syllable.
		.replace(/k\u0259k\u02c8o\u02d0\u0279o\u028a/g, 'k\u02c8o\u028ak\u0259\u0279o\u028a')
		.replace(
			/k\u0259k\u02c8\u0254\u02d0\u0279\u0259\u028a/g,
			'k\u02c8\u0259\u028ak\u0259\u0279\u0259\u028a'
		)
		.replace(/\u02b2/g, 'j')
		.replace(/r/g, '\u0279')
		.replace(/x/g, 'k')
		.replace(/\u026c/g, 'l')
		.replace(/(?<=[a-z\u0279\u02d0])(?=h\u02c8\u028cnd\u0279\u026ad)/g, ' ')
		.replace(/ z(?=[;:,.!?\u00a1\u00bf\u2014\u2026"\u00ab\u00bb\u201c\u201d ]|$)/g, 'z');

	if (language === 'a') {
		processed = processed.replace(/(?<=n\u02c8a\u026an)ti(?!\u02d0)/g, 'di');
	}
	return processed.trim();
}
