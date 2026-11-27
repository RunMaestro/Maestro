/**
 * @file transcription-wake.test.ts
 *
 * The transcription wake engine's phrase matching. The recogniser is not under
 * test here (Parakeet has its own engine tests); what is, is the rule that turns
 * a transcript into a wake score - generous enough to survive a recogniser's
 * near miss, strict enough that ordinary speech never opens the microphone.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	scoreWakePhraseInTranscript,
	wakeScorerFactory,
	createTranscriptionWakeScorer,
} from '../../../../main/acappella/wake/transcription-wake';
import {
	__setSpeechToTextPool,
	SpeechToTextPool,
} from '../../../../main/local-models/speech-to-text';
import { LocalModelError } from '../../../../main/local-models/errors';
import type { InstalledSpeechToTextModel } from '../../../../main/local-models/stt/engines';
import { PARAKEET_TDT_V2_ID } from '../../../../shared/local-models/model-catalog';

describe('scoreWakePhraseInTranscript', () => {
	it('scores an exact phrase at the start of a request as a full match', () => {
		expect(scoreWakePhraseInTranscript('hey jarvis', 'Hey, Jarvis! What time is it?')).toBe(1);
	});

	it('finds the phrase anywhere in the transcript', () => {
		expect(scoreWakePhraseInTranscript('hey scout', 'okay so hey scout run the tests')).toBe(1);
	});

	it('survives a recogniser near miss above the default threshold', () => {
		// One dropped letter in a ten-character phrase.
		expect(scoreWakePhraseInTranscript('hey jarvis', 'hey jarvi')).toBeGreaterThan(0.5);
	});

	it('does not fire on ordinary speech', () => {
		expect(scoreWakePhraseInTranscript('hey jarvis', 'please summarize the build')).toBe(0);
		// The near-collision a raw edit similarity would wave through.
		expect(scoreWakePhraseInTranscript('hey jarvis', 'hey there')).toBeLessThan(0.5);
	});

	it('scores nothing for an empty transcript or phrase', () => {
		expect(scoreWakePhraseInTranscript('hey jarvis', '')).toBe(0);
		expect(scoreWakePhraseInTranscript('', 'hey jarvis')).toBe(0);
	});
});

describe('wakeScorerFactory', () => {
	it('leaves the classifier engine on the detector default', () => {
		expect(wakeScorerFactory('classifier')).toBeUndefined();
	});

	it('builds the transcription scorer for the transcription engine', () => {
		expect(wakeScorerFactory('transcription')).toBe(createTranscriptionWakeScorer);
	});
});

describe('createTranscriptionWakeScorer', () => {
	afterEach(() => __setSpeechToTextPool(null));

	function poolOver(resolveModel: () => Promise<InstalledSpeechToTextModel>) {
		const pool = new SpeechToTextPool({
			idleUnloadMs: 0,
			loadRuntime: (async () => ({})) as never,
			resolveModel,
		});
		__setSpeechToTextPool(pool);
		return pool;
	}

	it('leases Parakeet from the shared pool and gives it back when disposed', async () => {
		const engine = {
			load: vi.fn(async () => {}),
			unload: vi.fn(async () => {}),
			transcribe: vi.fn(async () => 'hey jarvis'),
		};
		const pool = poolOver(
			async () =>
				({
					entry: { displayName: 'Parakeet', runtime: 'onnx' },
					maxSamples: 16000 * 60,
					createEngine: async () => engine,
				}) as unknown as InstalledSpeechToTextModel
		);

		const scorer = await createTranscriptionWakeScorer();

		expect(scorer?.tier).toBe('local');
		// Held for as long as the wake word is armed, so a session or a dictation
		// on the same model shares this copy.
		expect(pool.leaseCount(PARAKEET_TDT_V2_ID)).toBe(1);

		await scorer?.dispose();
		expect(pool.leaseCount(PARAKEET_TDT_V2_ID)).toBe(0);
		expect(engine.unload).toHaveBeenCalledTimes(1);
	});

	it('answers null when the model cannot be leased, so the detector runs inert', async () => {
		poolOver(async () => {
			throw new LocalModelError('Parakeet is not downloaded.', {
				code: 'model-not-installed',
				recovery: 'Download it in Settings.',
				consumerId: 'transcription-wake',
			});
		});
		await expect(createTranscriptionWakeScorer()).resolves.toBeNull();
	});
});
