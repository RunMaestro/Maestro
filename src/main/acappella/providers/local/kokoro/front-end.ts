/**
 * Kokoro's front end, assembled: text in, model token ids out.
 *
 * `text.ts` turns text into Kokoro's phoneme string (with espeak-ng doing the
 * grapheme-to-phoneme step), and `tokens.ts` maps that string onto the ids in
 * the model's own `tokenizer.json`. This is the one place the two are joined,
 * so the provider holds a single function and a test can swap either half.
 */

import { loadEspeak } from './espeak';
import { kokoroPhonemes, type EspeakPhonemize, type KokoroLanguage } from './text';
import { loadKokoroVocab, phonemesToIds, type KokoroVocab } from './tokens';

export interface KokoroFrontEnd {
	readonly vocab: KokoroVocab;
	/** Text to token ids, without the model's pad tokens. Empty when nothing is speakable. */
	phonemize(text: string): Promise<number[]>;
}

export interface KokoroFrontEndOptions {
	/** The model's installed `tokenizer.json`. */
	tokenizerPath: string;
	/** Defaults to American English, which is what the bundled voice speaks. */
	language?: KokoroLanguage;
	/** Injected in tests. Production loads the `phonemizer` package. */
	espeak?: EspeakPhonemize;
}

export async function createKokoroFrontEnd(
	options: KokoroFrontEndOptions
): Promise<KokoroFrontEnd> {
	const vocab = await loadKokoroVocab(options.tokenizerPath);
	const espeak = options.espeak ?? loadEspeak();
	const language = options.language ?? 'a';
	return {
		vocab,
		phonemize: async (text) => phonemesToIds(await kokoroPhonemes(text, espeak, language), vocab),
	};
}
