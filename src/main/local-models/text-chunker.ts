/**
 * Cutting a text into the windows the semantic index embeds.
 *
 * An embedding model reads a fixed window (512 tokens for the small models) and
 * silently drops whatever is past it, so a long History entry embedded whole is
 * an embedding of its first page. {@link chunkText} cuts it into windows of
 * about {@link CHUNK_TARGET_TOKENS} tokens that each fit, with a small overlap
 * so a sentence at a window's edge is read whole by one of them.
 *
 * Three rules:
 *
 *   - **Tokens are counted, not guessed, when a tokenizer is at hand.** The
 *     caller passes the count function: the assigned model's own tokenizer for
 *     a local model, a character estimate for an endpoint (whose tokenizer this
 *     process cannot see).
 *   - **Windows end at sentence and line ends.** A unit is only split mid-way
 *     when it is longer than a whole window by itself (a minified line, a
 *     pasted blob), and then at whitespace when there is any.
 *   - **Work is bounded per text.** Counting runs on the main thread, so a text
 *     is cut to what {@link MAX_CHUNKS_PER_SOURCE} windows could hold before
 *     anything is tokenized. The tail of a 2 MB response is not searchable; a
 *     frozen app while it was tokenized would be worse.
 *
 * Pure: no model, no disk. The same text and counter always produce the same
 * chunks, which is what lets the indexer tell "unchanged" from a hash.
 */

/** Tokens per window. Inside the 200 to 400 the index is designed around. */
export const CHUNK_TARGET_TOKENS = 320;

/** Tokens a window repeats from the one before it. */
export const CHUNK_OVERLAP_TOKENS = 40;

/** Windows kept per text. Past this the text is cut, not indexed further. */
export const MAX_CHUNKS_PER_SOURCE = 24;

/**
 * Characters assumed per token when bounding a text before it is tokenized.
 * Generous on purpose (English prose is about 4), so for ordinary text the
 * chunk cap is what ends a long source, not this bound.
 */
const BOUND_CHARS_PER_TOKEN = 6;

export interface ChunkTextOptions {
	/** Content tokens in a text (see `LocalTokenizer.countTokens`). */
	countTokens: (text: string) => number;
	/** Longest window. Defaults to {@link CHUNK_TARGET_TOKENS}. */
	maxTokens?: number;
	/** Defaults to {@link CHUNK_OVERLAP_TOKENS}; clamped to under half a window. */
	overlapTokens?: number;
	/** Defaults to {@link MAX_CHUNKS_PER_SOURCE}. */
	maxChunks?: number;
}

interface Unit {
	text: string;
	tokens: number;
}

/**
 * A run of text ending at a sentence terminator or a newline (trailing
 * whitespace included), or the unterminated tail. The alternatives cover every
 * character, so the units concatenate back to the text.
 */
const UNIT_PATTERN = /[^\n.!?]*[\n.!?]+\s*|[^\n.!?]+$/g;

/** Cut `text` into windows, in reading order. An empty text has none. */
export function chunkText(text: string, options: ChunkTextOptions): string[] {
	const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? CHUNK_TARGET_TOKENS));
	const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? MAX_CHUNKS_PER_SOURCE));
	const overlap = Math.max(
		0,
		Math.min(
			Math.floor(options.overlapTokens ?? CHUNK_OVERLAP_TOKENS),
			Math.ceil(maxTokens / 2) - 1
		)
	);

	const normalized = text.replace(/\r\n?/g, '\n').trim();
	if (normalized === '') return [];
	const bounded = normalized.slice(0, maxChunks * maxTokens * BOUND_CHARS_PER_TOKEN);

	// Most History entries are a paragraph: one count, one window.
	if (options.countTokens(bounded) <= maxTokens) return [bounded];

	const units: Unit[] = [];
	for (const piece of bounded.match(UNIT_PATTERN) ?? [bounded]) {
		units.push(...splitToFit(piece, options.countTokens(piece), maxTokens, options.countTokens));
	}

	const chunks: string[] = [];
	let current: Unit[] = [];
	let currentTokens = 0;
	const flush = () => {
		const joined = current
			.map((unit) => unit.text)
			.join('')
			.trim();
		if (joined !== '') chunks.push(joined);
	};

	for (const unit of units) {
		if (current.length > 0 && currentTokens + unit.tokens > maxTokens) {
			flush();
			if (chunks.length >= maxChunks) return chunks;

			// Carry the tail of the window just closed, as whole units. Dropped
			// when the next unit would not fit beside it: a window must never be
			// over-long for the sake of repeating some of the last one.
			let carried: Unit[] = [];
			let carriedTokens = 0;
			for (let i = current.length - 1; i >= 0; i--) {
				if (carriedTokens + current[i].tokens > overlap) break;
				carried.unshift(current[i]);
				carriedTokens += current[i].tokens;
			}
			if (carriedTokens + unit.tokens > maxTokens) {
				carried = [];
				carriedTokens = 0;
			}
			current = carried;
			currentTokens = carriedTokens;
		}
		current.push(unit);
		currentTokens += unit.tokens;
	}
	flush();
	return chunks.slice(0, maxChunks);
}

/**
 * A unit as pieces that each fit a window. Halved (at whitespace nearest the
 * middle, when there is any) until every piece fits, so a unit of n tokens
 * costs about `log2(n / maxTokens)` extra counts of its own text.
 */
function splitToFit(
	text: string,
	tokens: number,
	maxTokens: number,
	countTokens: (text: string) => number
): Unit[] {
	if (tokens <= maxTokens || text.length < 2) return [{ text, tokens }];
	const at = splitPoint(text);
	const left = text.slice(0, at);
	const right = text.slice(at);
	return [
		...splitToFit(left, countTokens(left), maxTokens, countTokens),
		...splitToFit(right, countTokens(right), maxTokens, countTokens),
	];
}

/** Where to halve a text: after the whitespace nearest its middle, else the middle. */
function splitPoint(text: string): number {
	const middle = Math.floor(text.length / 2);
	for (let offset = 0; offset < middle; offset++) {
		for (const index of [middle + offset, middle - offset]) {
			// `index` is where the right half starts, so both halves stay non-empty.
			if (index > 0 && index < text.length && /\s/.test(text[index - 1])) return index;
		}
	}
	// No whitespace at all. Never between the halves of a surrogate pair.
	const code = text.charCodeAt(middle);
	return code >= 0xdc00 && code <= 0xdfff && middle + 1 < text.length ? middle + 1 : middle;
}
