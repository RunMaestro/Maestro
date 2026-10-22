/**
 * Kokoro's phoneme vocabulary: phoneme string in, model token ids out.
 *
 * The vocabulary is not written down here. It ships with the model as
 * `tokenizer.json` (pinned and hashed in the catalog like the weights), and
 * its pipeline is small enough to state exactly: drop every character that is
 * not in the vocabulary, map each remaining character to its id, and wrap the
 * sequence in the pad token (id 0) at both ends. Every key is a single UTF-16
 * unit, so "character" here is one code unit.
 *
 * The model accepts at most {@link KOKORO_MAX_TOKENS} ids between the pads; one
 * more and ONNX Runtime fails the run. A sentence is not a safe unit: 240
 * characters of digits or acronyms phonemize to well over a thousand ids. So a
 * long sequence is cut into runs, at punctuation where there is any, then at a
 * space, and only then mid-word.
 */

import * as fs from 'fs/promises';

/** Ids the model takes between its two pad tokens. 511 fails in ONNX Runtime. */
export const KOKORO_MAX_TOKENS = 510;

export interface KokoroVocab {
	/** Phoneme character to id. */
	readonly ids: ReadonlyMap<string, number>;
	/** Ids of clause punctuation: the best place to cut a long sequence. */
	readonly punctuation: ReadonlySet<number>;
	/** The id of a space: the second-best place. */
	readonly space: number | undefined;
}

const CLAUSE_PUNCTUATION = [';', ':', ',', '.', '!', '?', '\u2014', '\u2026'];

/** Build a vocabulary from the `model.vocab` table of a Kokoro `tokenizer.json`. */
export function kokoroVocabFrom(table: Record<string, unknown>): KokoroVocab {
	const ids = new Map<string, number>();
	for (const [key, value] of Object.entries(table)) {
		if (typeof value === 'number' && Number.isInteger(value) && value >= 0) ids.set(key, value);
	}
	if (ids.size === 0) throw new Error('The Kokoro vocabulary is empty.');
	const punctuation = new Set<number>();
	for (const mark of CLAUSE_PUNCTUATION) {
		const id = ids.get(mark);
		if (id !== undefined) punctuation.add(id);
	}
	return { ids, punctuation, space: ids.get(' ') };
}

/** Read the vocabulary out of the model's installed `tokenizer.json`. */
export async function loadKokoroVocab(tokenizerPath: string): Promise<KokoroVocab> {
	const parsed = JSON.parse(await fs.readFile(tokenizerPath, 'utf8')) as {
		model?: { vocab?: Record<string, unknown> };
	};
	const table = parsed.model?.vocab;
	if (!table || typeof table !== 'object') {
		throw new Error('The Kokoro tokenizer file has no vocabulary.');
	}
	return kokoroVocabFrom(table);
}

/**
 * The ids for a phoneme string, WITHOUT the pads. A character the vocabulary
 * does not have is dropped, which is what the model's own tokenizer does.
 */
export function phonemesToIds(phonemes: string, vocab: KokoroVocab): number[] {
	const out: number[] = [];
	for (let index = 0; index < phonemes.length; index++) {
		const id = vocab.ids.get(phonemes[index]);
		if (id !== undefined) out.push(id);
	}
	return out;
}

/**
 * Cut a sequence into runs of at most `max` ids.
 *
 * Each run ends at the LAST clause punctuation that fits, or failing that the
 * last space, so the model never has to end mid-word unless one word alone is
 * longer than the limit. The punctuation stays with the run it ends (the model
 * reads it as the fall of the voice); a space a run was cut at is dropped, and
 * so is any space a run would begin with.
 */
export function splitTokenRuns(
	ids: readonly number[],
	vocab: Pick<KokoroVocab, 'punctuation' | 'space'>,
	max = KOKORO_MAX_TOKENS
): number[][] {
	const runs: number[][] = [];
	let start = 0;
	while (start < ids.length) {
		// Never open a run on a space.
		while (start < ids.length && ids[start] === vocab.space) start++;
		if (start >= ids.length) break;
		if (ids.length - start <= max) {
			runs.push(ids.slice(start));
			break;
		}
		const limit = start + max;
		let cut = -1;
		for (let index = limit - 1; index > start; index--) {
			if (vocab.punctuation.has(ids[index])) {
				cut = index + 1;
				break;
			}
		}
		let next = cut;
		if (cut === -1) {
			for (let index = limit - 1; index > start; index--) {
				if (ids[index] === vocab.space) {
					cut = index;
					next = index + 1;
					break;
				}
			}
		}
		if (cut === -1) {
			cut = limit;
			next = limit;
		}
		runs.push(ids.slice(start, cut));
		start = next;
	}
	return runs;
}
