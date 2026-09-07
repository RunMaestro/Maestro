/**
 * @file speech-scheduler.test.ts
 *
 * The queue between the translator and the speaker. Four things are pinned here
 * because each of them is silently wrong in a way a listener notices and a log
 * does not:
 *
 *   - Segmentation against the strings agents actually write (`v1.2.3`,
 *     `src/main/index.ts`, `99.5`, `e.g.`). A splitter that gets one wrong reads
 *     half a sentence and then stops.
 *   - No gap between sentences: the next one is synthesized while the current one
 *     is still being delivered.
 *   - The length cap wraps up out loud instead of cutting off, because a stop
 *     with no explanation reads as a crash to someone with no screen.
 *   - `interrupted` is not `completed`. The conversation memory is built on that
 *     difference.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	SpeechScheduler,
	type SpeechRunResult,
} from '../../../../main/acappella/speech/speech-scheduler';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import type { TtsChunk, TtsProvider } from '../../../../shared/acappella/providers';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTts extends TtsProvider {
	/** Sentences the provider was asked to synthesize, in order. */
	requested: string[];
	/** Sentences whose synthesis has been started but not resolved. */
	release: (sentence: string) => void;
	cancel: ReturnType<typeof vi.fn<() => void>>;
}

/**
 * A provider whose synthesis can be held open, which is the only way to observe
 * lookahead: with instant synthesis every schedule looks gapless.
 */
function fakeTts(options: { manual?: boolean } = {}): FakeTts {
	const requested: string[] = [];
	const gates = new Map<string, () => void>();
	let cancelled = false;

	const provider: FakeTts = {
		id: 'fake-tts',
		label: 'Fake',
		tier: 'mock',
		requested,
		cancel: vi.fn(() => {
			cancelled = true;
			for (const open of gates.values()) open();
			gates.clear();
		}),
		release: (sentence: string) => {
			gates.get(sentence)?.();
			gates.delete(sentence);
		},
		speak: async function* (text: string, speakOptions): AsyncIterable<TtsChunk> {
			requested.push(text);
			if (options.manual) {
				await new Promise<void>((resolve) => gates.set(text, resolve));
			}
			if (cancelled) return;
			yield {
				utteranceId: speakOptions.utteranceId,
				index: requested.length - 1,
				text,
				format: 'none',
				audio: null,
			};
		},
	};

	return provider;
}

interface Harness {
	scheduler: SpeechScheduler;
	tts: FakeTts;
	starts: { utteranceId: string; sentenceCount: number; streaming: boolean }[];
	sentences: { index: number; text: string }[];
	ends: SpeechRunResult[];
	chunks: TtsChunk[];
}

function harness(
	overrides: Partial<ConstructorParameters<typeof SpeechScheduler>[0]> = {}
): Harness {
	const tts = (overrides.tts as FakeTts) ?? fakeTts();
	const starts: Harness['starts'] = [];
	const sentences: Harness['sentences'] = [];
	const ends: SpeechRunResult[] = [];
	const chunks: TtsChunk[] = [];

	const scheduler = new SpeechScheduler({
		tts,
		onStart: (event) => starts.push(event),
		onSentence: (event) => sentences.push({ index: event.index, text: event.text }),
		onEnd: (result) => ends.push(result),
		onChunk: (chunk) => chunks.push(chunk),
		...overrides,
	});

	return { scheduler, tts, starts, sentences, ends, chunks };
}

/** Let the scheduler's worker run to its next await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------

describe('sentence segmentation', () => {
	it('does not split on abbreviations, decimals, version numbers, or file extensions', () => {
		expect(splitIntoSpokenSentences('Coverage is 99.5 percent now.')).toEqual([
			'Coverage is 99.5 percent now.',
		]);
		expect(splitIntoSpokenSentences('Bumped it to v1.2.3 this morning.')).toEqual([
			'Bumped it to v1.2.3 this morning.',
		]);
		expect(splitIntoSpokenSentences('The fix is in src/main/index.ts near the top.')).toEqual([
			'The fix is in src/main/index.ts near the top.',
		]);
		expect(splitIntoSpokenSentences('Check the store, e.g. the session one.')).toEqual([
			'Check the store, e.g. the session one.',
		]);
		expect(splitIntoSpokenSentences('It ships in the U.S. only.')).toEqual([
			'It ships in the U.S. only.',
		]);
	});

	it('still splits after an acronym, which is what agents write constantly', () => {
		expect(splitIntoSpokenSentences('Fixed the API. Then I ran the tests.')).toEqual([
			'Fixed the API.',
			'Then I ran the tests.',
		]);
	});

	it('splits at the end of a sentence that finishes on a file name', () => {
		expect(splitIntoSpokenSentences('It is in src/main/index.ts. Two lines changed.')).toEqual([
			'It is in src/main/index.ts.',
			'Two lines changed.',
		]);
	});
});

describe('SpeechScheduler', () => {
	it('announces a streaming run with the count it has, not a count it invented', async () => {
		const h = harness();
		h.scheduler.begin('u1');
		await settle();

		expect(h.starts).toEqual([
			{ utteranceId: 'u1', sentenceCount: 0, streaming: true, ttsProviderId: 'fake-tts' },
		]);
	});

	it('speaks pushed text sentence by sentence and reports each one before its audio', async () => {
		const h = harness();
		h.scheduler.begin('u1');
		h.scheduler.push('Done, it was a stale token check. ');
		h.scheduler.push('Two files changed.');
		h.scheduler.close();

		const result = await h.scheduler.drained();

		expect(h.sentences.map((s) => s.text)).toEqual([
			'Done, it was a stale token check.',
			'Two files changed.',
		]);
		expect(h.chunks.map((c) => c.text)).toEqual(h.sentences.map((s) => s.text));
		expect(result?.reason).toBe('completed');
		expect(result?.spoken).toHaveLength(2);
		expect(result?.unspoken).toEqual([]);
	});

	it('holds an unterminated tail rather than speaking half a sentence', async () => {
		const h = harness();
		h.scheduler.begin('u1');
		h.scheduler.push('The file is index');
		await settle();

		expect(h.tts.requested).toEqual([]);

		// The rest of the token arrives and proves it was never a boundary.
		h.scheduler.push('.ts and it is fine.');
		h.scheduler.close();
		await h.scheduler.drained();

		expect(h.tts.requested).toEqual(['The file is index .ts and it is fine.']);
	});

	it('synthesizes the next sentence while the current one is still playing', async () => {
		const tts = fakeTts({ manual: true });
		const h = harness({ tts, lookahead: 1 });

		h.scheduler.begin('u1');
		h.scheduler.push('One. Two. Three. ');
		await settle();

		// Sentence two is already being synthesized while sentence one is still open
		// and has not been delivered. That overlap is what removes the gap.
		expect(h.tts.requested).toEqual(['One.', 'Two.']);
		expect(h.sentences).toEqual([]);
		// Not the whole reply, though: a barge-in during sentence one must not throw
		// away three sentences of paid-for audio.
		expect(h.tts.requested).not.toContain('Three.');

		tts.release('One.');
		await settle();
		expect(h.sentences.map((s) => s.text)).toEqual(['One.']);
		expect(h.tts.requested).toEqual(['One.', 'Two.', 'Three.']);

		tts.release('Two.');
		tts.release('Three.');
		h.scheduler.close();
		await h.scheduler.drained();
		expect(h.sentences.map((s) => s.text)).toEqual(['One.', 'Two.', 'Three.']);
	});

	it('wraps up out loud when the per-turn cap is reached', async () => {
		const h = harness({ maxSentencesPerTurn: 2 });
		h.scheduler.begin('u1');
		h.scheduler.push('One. Two. Three. Four. ');
		h.scheduler.close();

		const result = await h.scheduler.drained();

		expect(h.sentences.map((s) => s.text)).toEqual([
			'One.',
			'Two.',
			"There's more, ask me for the details.",
		]);
		expect(result?.capped).toBe(true);
		expect(result?.reason).toBe('completed');
		// The sentences it never got to are recorded as unheard, so nothing claims
		// the user was told about them.
		expect(result?.unspoken).toEqual(['Three.', 'Four.']);
	});

	it('does not promise details that do not exist when the run ends exactly on the cap', async () => {
		const h = harness({ maxSentencesPerTurn: 2 });
		h.scheduler.begin('u1');
		h.scheduler.push('One. Two. ');
		h.scheduler.close();

		const result = await h.scheduler.drained();

		expect(h.sentences.map((s) => s.text)).toEqual(['One.', 'Two.']);
		expect(result?.capped).toBe(false);
	});

	it('reports interrupted, not completed, and separates what was heard from what was not', async () => {
		const tts = fakeTts({ manual: true });
		const h = harness({ tts });

		h.scheduler.begin('u1');
		h.scheduler.push('First. Second. Third. ');
		await settle();
		tts.release('First.');
		await settle();

		// Mid-synthesis of the second sentence, with the third still queued.
		const result = h.scheduler.cancel('interrupted');

		expect(result?.reason).toBe('interrupted');
		expect(result?.spoken).toEqual(['First.']);
		expect(result?.unspoken).toEqual(['Second.', 'Third.']);
		expect(h.tts.cancel).toHaveBeenCalledOnce();
	});

	it('emits exactly one speak-end however the run ends', async () => {
		const h = harness();
		h.scheduler.begin('u1');
		h.scheduler.push('Only one. ');
		h.scheduler.close();
		await h.scheduler.drained();

		expect(h.scheduler.cancel('interrupted')).toBeNull();
		expect(h.ends).toHaveLength(1);
	});

	it('drops sentences that arrive after the run ended', async () => {
		const h = harness();
		h.scheduler.begin('u1');
		h.scheduler.push('Done. ');
		h.scheduler.close();
		await h.scheduler.drained();

		h.scheduler.push('Too late.');
		await settle();

		expect(h.tts.requested).toEqual(['Done.']);
	});

	it('reports an error end reason when the provider fails mid-run', async () => {
		const failing: TtsProvider = {
			id: 'broken-tts',
			label: 'Broken',
			tier: 'mock',
			cancel: vi.fn(),
			// eslint-disable-next-line require-yield
			speak: async function* (): AsyncIterable<TtsChunk> {
				throw new Error('synthesis failed');
			},
		};
		const errors: Error[] = [];
		const h = harness({ tts: failing as FakeTts, onError: (error) => errors.push(error) });

		h.scheduler.begin('u1');
		h.scheduler.push('Anything. ');
		const result = await h.scheduler.drained();

		expect(result?.reason).toBe('error');
		expect(errors.map((error) => error.message)).toEqual(['synthesis failed']);
	});
});

describe('live voice and rate', () => {
	/** A provider that records the options each sentence was synthesized with. */
	function recordingTts(): TtsProvider & { options: Array<{ voiceId?: string; rate?: number }> } {
		const options: Array<{ voiceId?: string; rate?: number }> = [];
		return {
			id: 'recording-tts',
			label: 'Recording',
			tier: 'mock',
			options,
			cancel: vi.fn(),
			speak: async function* (text: string, speakOptions): AsyncIterable<TtsChunk> {
				options.push({ voiceId: speakOptions.voiceId, rate: speakOptions.rate });
				yield {
					utteranceId: speakOptions.utteranceId,
					index: options.length - 1,
					text,
					format: 'none',
					audio: null,
				};
			},
		};
	}

	it('reads the voice and rate fresh for every sentence', async () => {
		// This is what makes the Settings sliders apply to the NEXT SENTENCE
		// rather than the next session. Reading them once at construction would
		// pin a whole conversation to whatever was configured when it started.
		const tts = recordingTts();
		let current = { voiceId: 'alloy', rate: 1 };
		const h = harness({ tts: tts as never, speechOptions: () => current });

		h.scheduler.begin('u1');
		h.scheduler.push('One sentence. ');
		await settle();
		current = { voiceId: 'nova', rate: 1.25 };
		h.scheduler.push('Two sentence. ');
		h.scheduler.close();
		await h.scheduler.drained();

		expect(tts.options[0]).toEqual({ voiceId: 'alloy', rate: 1 });
		expect(tts.options[1]).toEqual({ voiceId: 'nova', rate: 1.25 });
	});

	it('passes nothing when no getter was supplied, leaving the provider its default', async () => {
		const tts = recordingTts();
		const h = harness({ tts: tts as never });

		h.scheduler.begin('u1');
		h.scheduler.push('One sentence. ');
		h.scheduler.close();
		await h.scheduler.drained();

		expect(tts.options[0]).toEqual({ voiceId: undefined, rate: undefined });
	});
});
