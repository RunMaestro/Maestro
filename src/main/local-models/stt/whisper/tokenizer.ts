/**
 * Whisper's byte-level BPE: native decoding plus vocabulary context encoding.
 *
 * Generated ids decode by vocabulary lookup and byte-level unmapping. Optional
 * vocabulary context uses the shared Hugging Face tokenizer to encode exactly
 * the checkpoint's BPE, rather than implementing a second encoder here.
 *
 * **The byte-level part is not decoration.** GPT-2 style BPE, which Whisper
 * inherits, cannot put a raw control byte in a vocabulary key, so it maps the
 * 256 byte values onto printable Unicode code points first. Concatenating the
 * token strings therefore gives a string of PLACEHOLDER characters, not text -
 * every non-ASCII character in it is wrong until each code point is mapped back
 * to its byte and the whole run is decoded as UTF-8. Skipping that step is
 * invisible in English and mangles every accented character, quote, and emoji.
 */

import { createLocalTokenizer, type LocalTokenizer } from '../../tokenizer';

/** Ids the model emits as control, never as text. */
export interface WhisperSpecialTokens {
	/** `<|startoftranscript|>` - primes the decoder. */
	readonly startOfTranscript: number;
	/** `<|endoftext|>` - ends generation. */
	readonly endOfText: number;
	/** `<|notimestamps|>` - asks for plain text rather than timestamped segments. */
	readonly noTimestamps: number;
	/** `<|startofprev|>` introduces vocabulary context before the transcript. */
	readonly startOfPrevious?: number;
	/** Multilingual checkpoints need an explicit language and transcription task. */
	readonly transcribe?: number;
	readonly languages?: Readonly<Record<string, number>>;
	/** Pinned generation rules: global exclusions and first generated token only. */
	readonly suppressTokens?: readonly number[];
	readonly beginSuppressTokens?: readonly number[];
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
	startOfPrevious: 50360,
});

/** Pinned multilingual Base checkpoint's generation_config.json; transcription only. */
export const WHISPER_MULTILINGUAL_SPECIAL_TOKENS: WhisperSpecialTokens = Object.freeze({
	startOfTranscript: 50258,
	endOfText: 50257,
	noTimestamps: 50363,
	transcribe: 50359,
	languages: Object.freeze({ de: 50261, en: 50259 }),
	// generation_config.json@1846881b6b3a3024392c1eea3ad983695bc23925.
	beginSuppressTokens: Object.freeze([220, 50257]),
	suppressTokens: Object.freeze([
		1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 359, 503,
		522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246, 3253, 3268, 3536,
		3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929, 11938, 12033, 12331, 12562,
		13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362, 18956, 20075, 21675, 22520, 26130,
		26161, 26435, 28279, 29464, 31650, 32302, 32470, 36865, 42863, 47425, 49870, 50254, 50258,
		50358, 50359, 50360, 50361, 50362,
	]),
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
	added_tokens?: { content: string; id: number }[];
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
	private encoder: LocalTokenizer | null = null;

	private constructor(
		tokens: string[],
		private readonly definition: TokenizerFile
	) {
		this.tokens = tokens;
	}

	/** Parse a `tokenizer.json` payload. Throws when it carries no vocabulary. */
	static fromJson(raw: string, special?: WhisperSpecialTokens): WhisperTokenizer {
		const parsed = JSON.parse(raw) as TokenizerFile;
		const vocab = parsed.model?.vocab;
		if (!vocab || typeof vocab !== 'object') {
			throw new Error('WhisperTokenizer: tokenizer.json has no model.vocab');
		}
		if (special?.languages) {
			const controls = new Map(Object.entries(vocab));
			for (const token of parsed.added_tokens ?? []) controls.set(token.content, token.id);
			const expected: Record<string, number | undefined> = {
				'<|startoftranscript|>': special.startOfTranscript,
				'<|endoftext|>': special.endOfText,
				'<|notimestamps|>': special.noTimestamps,
				'<|transcribe|>': special.transcribe,
				...Object.fromEntries(
					Object.entries(special.languages).map(([language, id]) => [`<|${language}|>`, id])
				),
			};
			for (const [token, id] of Object.entries(expected)) {
				if (id === undefined || controls.get(token) !== id)
					throw new Error('Whisper checkpoint control-token mismatch');
			}
		}
		const tokens: string[] = [];
		for (const [token, id] of Object.entries(vocab)) {
			if (typeof id === 'number' && id >= 0) tokens[id] = token;
		}
		if (tokens.length === 0) {
			throw new Error('WhisperTokenizer: tokenizer.json vocabulary is empty');
		}
		return new WhisperTokenizer(tokens, parsed);
	}

	/** Use the checkpoint's BPE implementation, never approximate word token ids. */
	encode(text: string, maxTokens = 223): number[] {
		this.encoder ??= createLocalTokenizer('.', this.definition, {});
		return Array.from(
			this.encoder.encode(text, { addSpecialTokens: false, truncation: false }).inputIds,
			Number
		).slice(0, maxTokens);
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
