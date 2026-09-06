/**
 * Whisper's byte-level BPE, decode side only.
 *
 * The provider never needs to ENCODE: the decoder is primed with three known
 * special-token ids and everything after that comes back as ids to be turned
 * into text. Decoding is a vocabulary lookup plus a byte-level unmapping, which
 * is why this is ~60 lines and not a tokenizer library.
 *
 * **The byte-level part is not decoration.** GPT-2 style BPE, which Whisper
 * inherits, cannot put a raw control byte in a vocabulary key, so it maps the
 * 256 byte values onto printable Unicode code points first. Concatenating the
 * token strings therefore gives a string of PLACEHOLDER characters, not text -
 * every non-ASCII character in it is wrong until each code point is mapped back
 * to its byte and the whole run is decoded as UTF-8. Skipping that step is
 * invisible in English and mangles every accented character, quote, and emoji.
 */

/** Ids the model emits as control, never as text. */
export interface WhisperSpecialTokens {
	/** `<|startoftranscript|>` - primes the decoder. */
	readonly startOfTranscript: number;
	/** `<|endoftext|>` - ends generation. */
	readonly endOfText: number;
	/** `<|notimestamps|>` - asks for plain text rather than timestamped segments. */
	readonly noTimestamps: number;
}

/**
 * Defaults for the English-only checkpoints (`*.en`).
 *
 * Read from the checkpoint's `generation_config.json` rather than invented, and
 * overridable because the multilingual checkpoints number these differently -
 * a hard-coded id would silently prime the decoder with a language token.
 */
export const WHISPER_EN_SPECIAL_TOKENS: WhisperSpecialTokens = Object.freeze({
	startOfTranscript: 50257,
	endOfText: 50256,
	noTimestamps: 50362,
});

/**
 * The GPT-2 byte-to-unicode mapping, inverted.
 *
 * Printable ASCII and two Latin-1 runs map to themselves; the remaining 68 byte
 * values are pushed into the private-use range starting at U+0100. The order the
 * leftovers are assigned in is part of the format, so this builds the forward
 * map exactly as GPT-2 does and then inverts it.
 */
function buildByteDecoder(): Map<string, number> {
	const bytes: number[] = [];
	for (let b = 0x21; b <= 0x7e; b++) bytes.push(b);
	for (let b = 0xa1; b <= 0xac; b++) bytes.push(b);
	for (let b = 0xae; b <= 0xff; b++) bytes.push(b);

	const assigned = new Set(bytes);
	const points = [...bytes];
	let overflow = 0;
	for (let b = 0; b < 256; b++) {
		if (assigned.has(b)) continue;
		bytes.push(b);
		points.push(256 + overflow);
		overflow += 1;
	}

	const decoder = new Map<string, number>();
	for (let i = 0; i < bytes.length; i++) decoder.set(String.fromCodePoint(points[i]), bytes[i]);
	return decoder;
}

const BYTE_DECODER = buildByteDecoder();

/** The slice of a HuggingFace `tokenizer.json` this needs. */
interface TokenizerFile {
	model?: { vocab?: Record<string, number> };
}

/**
 * Turns Whisper token ids back into text.
 *
 * Built from the checkpoint's own `tokenizer.json`, so a model swap cannot leave
 * a stale vocabulary behind.
 */
export class WhisperTokenizer {
	/** Dense id -> token string. An array because ids are contiguous from zero. */
	private readonly tokens: string[];

	private constructor(tokens: string[]) {
		this.tokens = tokens;
	}

	/** Parse a `tokenizer.json` payload. Throws when it carries no vocabulary. */
	static fromJson(raw: string): WhisperTokenizer {
		const parsed = JSON.parse(raw) as TokenizerFile;
		const vocab = parsed.model?.vocab;
		if (!vocab || typeof vocab !== 'object') {
			throw new Error('WhisperTokenizer: tokenizer.json has no model.vocab');
		}
		const tokens: string[] = [];
		for (const [token, id] of Object.entries(vocab)) {
			if (typeof id === 'number' && id >= 0) tokens[id] = token;
		}
		if (tokens.length === 0) {
			throw new Error('WhisperTokenizer: tokenizer.json vocabulary is empty');
		}
		return new WhisperTokenizer(tokens);
	}

	/** How many ids the vocabulary covers. */
	get size(): number {
		return this.tokens.length;
	}

	/**
	 * Decode ids to text.
	 *
	 * Ids outside the vocabulary are SKIPPED rather than throwing: a stray id is a
	 * dropped character, while a throw from inside a decode loop would lose the
	 * whole utterance the user just spoke.
	 */
	decode(ids: readonly number[]): string {
		let mapped = '';
		for (const id of ids) {
			const token = this.tokens[id];
			if (token !== undefined) mapped += token;
		}

		// Iterate by code point, not by UTF-16 unit: the mapping's escape range is
		// all BMP today, but indexing by unit would split any future astral code
		// point into two unmappable halves.
		const bytes: number[] = [];
		for (const char of mapped) {
			const byte = BYTE_DECODER.get(char);
			if (byte !== undefined) bytes.push(byte);
		}
		return Buffer.from(bytes).toString('utf8');
	}
}
