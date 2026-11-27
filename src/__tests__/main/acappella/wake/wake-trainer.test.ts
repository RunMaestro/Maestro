/**
 * @file wake-trainer.test.ts
 *
 * Training a wake phrase from the user's own recordings, and the matcher that
 * comes out. The front end is faked (see `wakeTrainingFixtures`): what is under
 * test is everything the trainer decides - where the phrase ends, which
 * recordings to keep, where the threshold sits, and what it tells the user.
 */

import { describe, it, expect } from 'vitest';

import {
	ENROLLED_WAKE_MODEL_VERSION,
	isUsableEnrolledWakeModel,
	nearestWakeSimilarity,
	prepareWakeWindow,
	scoreEnrolledWakeWindow,
	wakeScoreFromSimilarity,
	weightWakeTemplate,
	type EnrolledWakeModel,
} from '../../../../main/acappella/wake/enrolled-wake-model';
import {
	WAKE_CLASSIFIER_WINDOW,
	WAKE_HOP_SAMPLES,
} from '../../../../main/acappella/wake/wake-features';
import {
	WakeTrainingError,
	findSpeechBounds,
	trainEnrolledWakeModel,
	wakeFrameWeights,
} from '../../../../main/acappella/wake/wake-trainer';
import { wakePhraseKey } from '../../../../shared/acappella/wake-enrollment';
import {
	TONES,
	fakeWakeFeaturizer,
	melody,
	otherSpeech,
	phraseClip,
	withLead,
} from '../../../helpers/wakeTrainingFixtures';

/** Ten takes of the phrase, each a little louder, quieter, quicker or slower. */
function takes(count = 10): Float32Array[] {
	return Array.from({ length: count }, (_, index) =>
		phraseClip({ amplitude: 0.22 + (index % 4) * 0.04, stretch: 0.94 + (index % 3) * 0.06 })
	);
}

async function train(overrides: Partial<Parameters<typeof trainEnrolledWakeModel>[0]> = {}) {
	return trainEnrolledWakeModel({
		phrase: 'Hey Scout',
		clips: takes(),
		background: otherSpeech(14),
		featurizer: fakeWakeFeaturizer(),
		now: () => 1_700_000_000_000,
		...overrides,
	});
}

/** The best score a model gives anywhere in a piece of audio. */
async function peakScore(model: EnrolledWakeModel, audio: Float32Array): Promise<number> {
	const windows = await fakeWakeFeaturizer().featurize(audio);
	return Math.max(0, ...windows.map(({ window }) => scoreEnrolledWakeWindow(model, window)));
}

describe('trainEnrolledWakeModel', () => {
	it('builds a model that hears the phrase and not other speech', async () => {
		const model = await train();

		expect(model.version).toBe(ENROLLED_WAKE_MODEL_VERSION);
		expect(model.phrase).toBe('Hey Scout');
		expect(model.key).toBe(wakePhraseKey('hey scout'));
		expect(model.trainedAt).toBe(1_700_000_000_000);
		expect(isUsableEnrolledWakeModel(model)).toBe(true);

		// A take it has never seen, at a level and pace between the ones it has.
		const fresh = phraseClip({ amplitude: 0.27, stretch: 1.02 });
		expect(await peakScore(model, withLead(fresh))).toBeGreaterThan(0.5);
		// Other speech it has never seen.
		expect(await peakScore(model, otherSpeech(9).slice(16000))).toBeLessThan(0.5);
		// The first half of the phrase is not the phrase.
		const half = melody([
			{ hz: 0, ms: 300 },
			{ hz: TONES.mid, ms: 320 },
			{ hz: 0, ms: 600 },
		]);
		expect(await peakScore(model, withLead(half))).toBeLessThan(0.5);
	});

	it('reports what it measured on the recordings themselves', async () => {
		const { report } = await train();

		expect(report.clipsTotal).toBe(10);
		expect(report.clipsUsed).toBe(10);
		expect(report.recognized).toBe(10);
		expect(report.falseAlarms).toBe(0);
		expect(report.backgroundMs).toBe(14_000);
		expect(report.quality).toBe('strong');
		// Fewer recordings than the flow asks for: say so, even on a good result.
		expect(report.advice).toMatch(/more recordings/i);
	});

	it('leaves out a recording that is not like the rest', async () => {
		const cough = melody([
			{ hz: 0, ms: 300 },
			{ hz: TONES.low, ms: 500 },
			{ hz: 0, ms: 400 },
		]);
		const model = await train({ clips: [...takes(9), cough] });

		expect(model.report.clipsTotal).toBe(10);
		expect(model.report.clipsUsed).toBe(9);
		// And the cough is not an example of the phrase.
		expect(await peakScore(model, withLead(cough))).toBeLessThan(0.5);
	});

	it('calls the phrase weak when the other speech contains it', async () => {
		const background = otherSpeech(14);
		background.set(phraseClip(), 5 * 16000);
		const { report } = await train({ background });

		expect(report.quality).toBe('weak');
		expect(report.advice).toMatch(/other-speech recording sounds like the phrase/i);
	});

	it('gives the same model for the same recordings', async () => {
		const first = await train();
		const second = await train();

		expect(second.midpoint).toBe(first.midpoint);
		expect(second.steepness).toBe(first.steepness);
		expect(Array.from(second.templates)).toEqual(Array.from(first.templates));
	});

	it('reports progress that only moves forward and ends near done', async () => {
		const seen: number[] = [];
		await train({ onProgress: (_phase, progress) => seen.push(progress) });

		expect(seen.length).toBeGreaterThan(10);
		expect(seen.every((value, index) => index === 0 || value >= seen[index - 1])).toBe(true);
		expect(seen[seen.length - 1]).toBeGreaterThan(0.95);
	});

	it('refuses recordings it cannot learn from, by name', async () => {
		const silence = new Float32Array(16000);
		await expect(train({ clips: [silence, silence, phraseClip()] })).rejects.toBeInstanceOf(
			WakeTrainingError
		);
		await expect(train({ background: new Float32Array(1000) })).rejects.toThrow(
			/other-speech recording is too short/i
		);
	});
});

describe('findSpeechBounds', () => {
	it('finds the phrase inside the quiet around it', () => {
		const clip = phraseClip();
		const bounds = findSpeechBounds(clip);

		expect(bounds).not.toBeNull();
		// 300 ms of quiet, then 640 ms of phrase.
		expect(bounds!.start).toBe(0.3 * 16000);
		expect(bounds!.end).toBe(0.94 * 16000);
		expect(bounds!.noiseFloor).toBe(0);
	});

	it('has no answer for silence', () => {
		expect(findSpeechBounds(new Float32Array(16000))).toBeNull();
		expect(findSpeechBounds(new Float32Array(10))).toBeNull();
	});
});

describe('wakeFrameWeights', () => {
	it('weights the newest frames most, in window order, summing to one', () => {
		const weights = wakeFrameWeights(0.8 * 16000, 0);

		expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 5);
		// Newest LAST: the frame that ends with the phrase counts most.
		expect(weights[weights.length - 1]).toBeGreaterThan(weights[0]);
		for (let i = 1; i < weights.length; i++)
			expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
	});

	it('compares fewer frames for a shorter phrase, and never more than a window holds', () => {
		const short = wakeFrameWeights(0.3 * 16000, 0);
		const long = wakeFrameWeights(0.9 * 16000, 0);
		const endless = wakeFrameWeights(10 * 16000, 0);

		expect(short.length).toBeLessThan(long.length);
		expect(short.length).toBeGreaterThanOrEqual(4);
		expect(endless.length).toBe(WAKE_CLASSIFIER_WINDOW);
	});
});

describe('the matcher', () => {
	const width = 3;
	const mean = Float32Array.from([1, 1, 1]);

	it('compares only the trailing frames, centred and at unit length', () => {
		// Two frames; only the last is asked for.
		const window = Float32Array.from([9, 9, 9, 4, 1, 1]);
		const prepared = prepareWakeWindow(window, 1, width, mean);

		expect(Array.from(prepared)).toEqual([1, 0, 0].map((value) => expect.closeTo(value, 5)));
	});

	it('scores a window by its nearest example and can leave examples out', () => {
		const weights = Float32Array.from([1]);
		const alike = weightWakeTemplate(Float32Array.from([1, 0, 0]), weights, width);
		const unlike = weightWakeTemplate(Float32Array.from([0, 1, 0]), weights, width);
		const templates = new Float32Array(6);
		templates.set(unlike, 0);
		templates.set(alike, 3);
		const query = Float32Array.from([1, 0, 0]);

		expect(nearestWakeSimilarity(templates, 2, query)).toBeCloseTo(1, 5);
		expect(nearestWakeSimilarity(templates, 2, query, (index) => index === 1)).toBeCloseTo(0, 5);
	});

	it('crosses one half at the midpoint and rises with similarity', () => {
		expect(wakeScoreFromSimilarity(0.7, 0.7, 20)).toBeCloseTo(0.5, 5);
		expect(wakeScoreFromSimilarity(0.9, 0.7, 20)).toBeGreaterThan(0.9);
		expect(wakeScoreFromSimilarity(0.5, 0.7, 20)).toBeLessThan(0.1);
	});

	it('scores nothing, rather than throwing, for a window it cannot read', async () => {
		const model = await train();

		expect(scoreEnrolledWakeWindow(model, new Float32Array(model.width))).toBe(0);
		expect(scoreEnrolledWakeWindow(model, new Float32Array(model.frames * model.width + 1))).toBe(
			0
		);
		expect(scoreEnrolledWakeWindow({ ...model, count: 0 }, new Float32Array(999))).toBe(0);
	});

	it('rejects a stored model whose numbers do not add up', async () => {
		const model = await train();

		expect(isUsableEnrolledWakeModel({ ...model, count: model.count + 1 })).toBe(false);
		expect(isUsableEnrolledWakeModel({ ...model, frames: WAKE_CLASSIFIER_WINDOW + 1 })).toBe(false);
		expect(isUsableEnrolledWakeModel({ ...model, midpoint: Number.NaN })).toBe(false);
		expect(isUsableEnrolledWakeModel({ ...model, version: 99 as never })).toBe(false);
	});

	it('is fed in whole hops', () => {
		// The fixtures and the trainer agree on the hop, or nothing above is real.
		expect(WAKE_HOP_SAMPLES).toBe(1280);
	});
});
