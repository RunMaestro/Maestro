/**
 * @file barge-in.test.ts
 *
 * Talking over the assistant. Four things are pinned, and all four are failures
 * you only notice by using it:
 *
 *   - The teardown ORDER. Ducking is the only step the user hears, so it goes
 *     first; the translator stream is the step everyone forgets, so it is
 *     asserted explicitly.
 *   - The pre-roll comes with the floor, or the first word of the interruption is
 *     lost and the utterance starts mid-word.
 *   - The self-interrupt guard. Without it the assistant's own first syllable
 *     leaks past the echo canceller and it interrupts itself, which looks exactly
 *     like a crash.
 *   - Heard is not queued. The conversation memory records only what reached the
 *     speaker.
 */

import { describe, it, expect, vi } from 'vitest';

import { BargeInController } from '../../../../main/acappella/speech/barge-in';
import type { BargeInOutcome } from '../../../../main/acappella/speech/barge-in';
import type { SpeechRunResult } from '../../../../main/acappella/speech/speech-scheduler';

const NOW = 1_000_000;

function runResult(overrides: Partial<SpeechRunResult> = {}): SpeechRunResult {
	return {
		utteranceId: 'u1',
		reason: 'interrupted',
		spoken: ['Done, it was a stale token check.'],
		unspoken: ['Two files changed.', 'Want the details?'],
		capped: false,
		...overrides,
	};
}

function harness(
	options: { result?: SpeechRunResult | null; guardMs?: number; preRoll?: boolean } = {}
) {
	const order: string[] = [];
	let clock = NOW;
	const outcomes: BargeInOutcome[] = [];
	const remembered: string[][] = [];

	const controller = new BargeInController({
		guardMs: options.guardMs ?? 250,
		now: () => clock,
		duck: (gain, ramp) => order.push(`duck:${gain}:${ramp}`),
		flushPlayback: () => order.push('flush'),
		cancelSpeech: vi.fn(() => {
			order.push('cancel-speech');
			return options.result === undefined ? runResult() : options.result;
		}),
		cancelTranslation: () => order.push('cancel-translation'),
		toListening: (outcome) => {
			order.push('listening');
			outcomes.push(outcome);
		},
		rememberSpoken: (spoken) => remembered.push(spoken),
	});

	return {
		controller,
		order,
		outcomes,
		remembered,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe('BargeInController', () => {
	it('tears down in order: duck, flush, cancel synthesis, cancel translation, listen', () => {
		const h = harness();
		h.controller.noteSpeechStarted();
		h.advance(500);

		const outcome = h.controller.trigger('voice');

		expect(h.order).toEqual([
			'duck:0.15:20',
			'flush',
			'cancel-speech',
			'cancel-translation',
			'listening',
		]);
		expect(outcome?.steps).toEqual([
			'duck',
			'flush',
			'cancel-speech',
			'cancel-translation',
			'listening',
		]);
	});

	it('ducks within about 20 ms, which is the only step the user can hear', () => {
		const h = harness();
		h.controller.noteSpeechStarted();
		h.advance(500);
		h.controller.trigger();

		const duck = h.order[0];
		expect(duck.startsWith('duck:')).toBe(true);
		const rampMs = Number(duck.split(':')[2]);
		expect(rampMs).toBeLessThanOrEqual(20);
	});

	it('hands the floor back so the pre-roll can carry the first word of the interruption', () => {
		const h = harness();
		h.controller.noteSpeechStarted();
		h.advance(500);

		h.controller.trigger('voice');

		// `toListening` is the seam the audio pipeline drains its pre-roll into. It
		// runs after the teardown, so the buffer it drains is the one that was
		// filling while the assistant was still talking.
		expect(h.outcomes).toHaveLength(1);
		expect(h.order.indexOf('listening')).toBe(h.order.length - 1);
	});

	it('refuses to self-interrupt inside the guard window', () => {
		const h = harness({ guardMs: 250 });
		h.controller.noteSpeechStarted();

		h.advance(100);
		expect(h.controller.canInterrupt()).toBe(false);
		expect(h.controller.trigger('voice')).toBeNull();
		expect(h.order).toEqual([]);

		h.advance(200);
		expect(h.controller.canInterrupt()).toBe(true);
		expect(h.controller.trigger('voice')).not.toBeNull();
	});

	it('is a no-op when nothing is speaking', () => {
		const h = harness();
		expect(h.controller.canInterrupt()).toBe(false);
		expect(h.controller.trigger('client-button')).toBeNull();
		expect(h.order).toEqual([]);
	});

	it('cannot fire twice for one speech run', () => {
		const h = harness();
		h.controller.noteSpeechStarted();
		h.advance(500);

		expect(h.controller.trigger('voice')).not.toBeNull();
		expect(h.controller.trigger('voice')).toBeNull();
	});

	it('records what was HEARD and keeps what was queued out of the memory', () => {
		const h = harness();
		h.controller.noteSpeechStarted();
		h.advance(500);

		const outcome = h.controller.trigger('voice');

		expect(outcome?.spoken).toEqual(['Done, it was a stale token check.']);
		expect(outcome?.unspoken).toEqual(['Two files changed.', 'Want the details?']);
		expect(h.remembered).toEqual([['Done, it was a stale token check.']]);
	});

	it('remembers nothing when the user cut in before a single sentence landed', () => {
		const h = harness({ result: runResult({ spoken: [], unspoken: ['Done.'] }) });
		h.controller.noteSpeechStarted();
		h.advance(500);

		const outcome = h.controller.trigger('voice');

		expect(outcome?.spoken).toEqual([]);
		expect(h.remembered).toEqual([]);
	});

	it('still tears down when the speech run had already finished on its own', () => {
		const h = harness({ result: null });
		h.controller.noteSpeechStarted();
		h.advance(500);

		const outcome = h.controller.trigger('voice');

		expect(outcome?.utteranceId).toBeNull();
		expect(h.order).toContain('cancel-translation');
	});

	it('closes the window when speech ends on its own', () => {
		const h = harness();
		h.controller.noteSpeechStarted();
		h.advance(500);
		h.controller.noteSpeechEnded();

		expect(h.controller.canInterrupt()).toBe(false);
		expect(h.controller.trigger('voice')).toBeNull();
	});
});
