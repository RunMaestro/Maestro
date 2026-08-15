/**
 * @file press-hold.test.ts
 *
 * Tap versus hold on a global hotkey, including the boundary itself and the
 * tap-only fallback that every platform gets today.
 *
 * Time and key state are both injected, so nothing here depends on a real
 * keyboard or on how fast the machine running the suite happens to be. The
 * boundary cases are the point: a threshold that classified a 299 ms press and a
 * 301 ms press the same way would make push-to-talk feel random.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	DEFAULT_HOLD_THRESHOLD_MS,
	MAX_HOLD_MS,
	MAX_HOLD_THRESHOLD_MS,
	MIN_HOLD_THRESHOLD_MS,
	PressHoldDetector,
	createPressHoldDetector,
	describePressHoldCapability,
	resolveHoldThresholdMs,
	resolvePlatformKeyStateProbe,
	resolvePressHoldCapability,
	setKeyStateProbe,
	type KeyStateProbe,
} from '../../../../main/acappella/hotkeys/press-hold';

const ACCELERATOR = 'Command+Alt+V';
const POLL_MS = 10;

interface Harness {
	detector: PressHoldDetector;
	taps: number[];
	holdStarts: number[];
	holdEnds: number[];
	/** Let the key back up. */
	release: () => void;
	/** Advance the fake clock and run the polls that fall inside the step. */
	advance: (ms: number) => void;
}

function makeHarness(options: { threshold?: number; probe?: KeyStateProbe | null } = {}): Harness {
	let now = 0;
	let down = true;
	const taps: number[] = [];
	const holdStarts: number[] = [];
	const holdEnds: number[] = [];

	const probe =
		options.probe === undefined ? (((): boolean => down) as KeyStateProbe) : options.probe;

	const detector = createPressHoldDetector({
		accelerator: ACCELERATOR,
		holdThresholdMs: options.threshold,
		pollIntervalMs: POLL_MS,
		probe,
		now: () => now,
		onTap: () => taps.push(now),
		onHoldStart: () => holdStarts.push(now),
		onHoldEnd: () => holdEnds.push(now),
	});

	return {
		detector,
		taps,
		holdStarts,
		holdEnds,
		release: () => {
			down = false;
		},
		// Stepped at the poll interval rather than jumped, so the detector sees the
		// same sequence of elapsed times it would see on a real clock. Jumping
		// would hand the first poll the whole span and skip the threshold entirely.
		advance: (ms) => {
			let remaining = ms;
			while (remaining > 0) {
				const step = Math.min(POLL_MS, remaining);
				now += step;
				vi.advanceTimersByTime(step);
				remaining -= step;
			}
		},
	};
}

describe('resolveHoldThresholdMs', () => {
	it('clamps into the usable band and falls back on nonsense', () => {
		expect(resolveHoldThresholdMs(400)).toBe(400);
		expect(resolveHoldThresholdMs(1)).toBe(MIN_HOLD_THRESHOLD_MS);
		expect(resolveHoldThresholdMs(999_999)).toBe(MAX_HOLD_THRESHOLD_MS);
		expect(resolveHoldThresholdMs('later')).toBe(DEFAULT_HOLD_THRESHOLD_MS);
		expect(resolveHoldThresholdMs(Number.NaN)).toBe(DEFAULT_HOLD_THRESHOLD_MS);
	});
});

describe('capability reporting', () => {
	afterEach(() => setKeyStateProbe(null));

	it('is tap-only with no probe and hold-and-tap with one', () => {
		expect(resolvePressHoldCapability(null)).toBe('tap-only');
		expect(resolvePressHoldCapability(() => true)).toBe('hold-and-tap');
	});

	it('never silently degrades: the tap-only sentence says holding will not work', () => {
		const note = describePressHoldCapability('tap-only');
		expect(note.toLowerCase()).toContain('hold');
		expect(note).not.toBe(describePressHoldCapability('hold-and-tap'));
	});

	it('picks up a probe installed at runtime', () => {
		expect(resolvePlatformKeyStateProbe()).toBeNull();
		const probe: KeyStateProbe = () => true;
		setKeyStateProbe(probe);
		expect(resolvePlatformKeyStateProbe()).toBe(probe);
	});
});

describe('PressHoldDetector', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	describe('tap-only fallback', () => {
		it('taps immediately on every trigger, with no timer at all', () => {
			const harness = makeHarness({ probe: null });
			expect(harness.detector.capability).toBe('tap-only');

			harness.detector.trigger();
			harness.detector.trigger();

			expect(harness.taps).toHaveLength(2);
			expect(harness.holdStarts).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('threshold boundary', () => {
		it('classifies a press released just under the threshold as a tap', () => {
			const harness = makeHarness({ threshold: 300 });
			harness.detector.trigger();
			harness.advance(290);
			harness.release();
			harness.advance(POLL_MS);

			expect(harness.taps).toHaveLength(1);
			expect(harness.holdStarts).toHaveLength(0);
			expect(harness.holdEnds).toHaveLength(0);
		});

		it('opens the floor once the key is still down at the threshold', () => {
			const harness = makeHarness({ threshold: 300 });
			harness.detector.trigger();
			harness.advance(300);

			expect(harness.holdStarts).toEqual([300]);
			expect(harness.taps).toHaveLength(0);
			expect(harness.detector.isHolding).toBe(true);
		});

		it('ends the utterance on release after a hold, and never taps', () => {
			const harness = makeHarness({ threshold: 300 });
			harness.detector.trigger();
			harness.advance(500);
			harness.release();
			harness.advance(POLL_MS);

			expect(harness.holdStarts).toHaveLength(1);
			expect(harness.holdEnds).toHaveLength(1);
			expect(harness.taps).toHaveLength(0);
			expect(harness.detector.isHolding).toBe(false);
		});

		it('fires hold-start exactly once across a long hold', () => {
			const harness = makeHarness({ threshold: 300 });
			harness.detector.trigger();
			harness.advance(2000);
			expect(harness.holdStarts).toHaveLength(1);
		});
	});

	it('ignores auto-repeat while a press is being classified', () => {
		const harness = makeHarness({ threshold: 300 });
		harness.detector.trigger();
		harness.advance(50);
		harness.detector.trigger();
		harness.detector.trigger();
		harness.advance(300);
		harness.release();
		harness.advance(POLL_MS);

		expect(harness.holdStarts).toHaveLength(1);
		expect(harness.holdEnds).toHaveLength(1);
	});

	it('starts a fresh gesture after the previous one resolved', () => {
		const harness = makeHarness({ threshold: 300 });
		harness.detector.trigger();
		harness.advance(50);
		harness.release();
		harness.advance(POLL_MS);
		expect(harness.taps).toHaveLength(1);

		harness.detector.trigger();
		harness.advance(POLL_MS);
		expect(harness.taps).toHaveLength(2);
	});

	it('stops polling once a gesture resolves', () => {
		const harness = makeHarness({ threshold: 300 });
		harness.detector.trigger();
		harness.release();
		harness.advance(POLL_MS);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('releases the floor when a probe lies about the key staying down', () => {
		const harness = makeHarness({ threshold: 300 });
		harness.detector.trigger();
		harness.advance(MAX_HOLD_MS);

		expect(harness.holdStarts).toHaveLength(1);
		expect(harness.holdEnds).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('treats a probe that throws as a release rather than holding forever', () => {
		let now = 0;
		const taps: number[] = [];
		const detector = createPressHoldDetector({
			accelerator: ACCELERATOR,
			pollIntervalMs: POLL_MS,
			probe: () => {
				throw new Error('probe exploded');
			},
			now: () => now,
			onTap: () => taps.push(now),
			onHoldStart: vi.fn(),
			onHoldEnd: vi.fn(),
		});

		detector.trigger();
		now += POLL_MS;
		vi.advanceTimersByTime(POLL_MS);

		expect(taps).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('dispose ends a hold in flight rather than abandoning an open floor', () => {
		const harness = makeHarness({ threshold: 300 });
		harness.detector.trigger();
		harness.advance(400);
		expect(harness.holdStarts).toHaveLength(1);

		harness.detector.dispose();
		expect(harness.holdEnds).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('dispose before the threshold neither taps nor holds', () => {
		const harness = makeHarness({ threshold: 300 });
		harness.detector.trigger();
		harness.advance(100);
		harness.detector.dispose();

		expect(harness.taps).toHaveLength(0);
		expect(harness.holdEnds).toHaveLength(0);
	});

	it('ignores triggers after dispose', () => {
		const harness = makeHarness({ probe: null });
		harness.detector.dispose();
		harness.detector.trigger();
		expect(harness.taps).toHaveLength(0);
	});

	it('does not let a throwing callback leave the poll timer running', () => {
		let now = 0;
		let down = true;
		const detector = new PressHoldDetector({
			accelerator: ACCELERATOR,
			pollIntervalMs: POLL_MS,
			probe: () => down,
			now: () => now,
			onTap: () => {
				throw new Error('floor exploded');
			},
			onHoldStart: vi.fn(),
			onHoldEnd: vi.fn(),
		});

		detector.trigger();
		down = false;
		now += POLL_MS;
		expect(() => vi.advanceTimersByTime(POLL_MS)).not.toThrow();
		expect(vi.getTimerCount()).toBe(0);
	});
});
