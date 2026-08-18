/**
 * @file utterance-composer.test.ts
 *
 * The thing this component exists to stop: a pause mid-sentence becoming two
 * separate requests to an agent. Every test here is about where the boundary of
 * one thought is drawn, so they all run on fake timers - the boundary is a
 * duration, and asserting it against the wall clock would be a flaky way to
 * describe a deterministic rule.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	UtteranceComposer,
	type ComposedUtterance,
} from '../../../../main/acappella/speech/utterance-composer';

const SETTLE = 900;

function makeComposer(
	overrides: { settleMs?: number; maxHoldMs?: number; sendPhrases?: readonly string[] } = {}
) {
	const settled: ComposedUtterance[] = [];
	const composing: string[] = [];
	const composer = new UtteranceComposer({
		settleMs: overrides.settleMs ?? SETTLE,
		maxHoldMs: overrides.maxHoldMs ?? 30_000,
		sendPhrases: overrides.sendPhrases,
		onSettled: (utterance) => settled.push(utterance),
		onComposing: (text) => composing.push(text),
	});
	return { composer, settled, composing };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('UtteranceComposer', () => {
	it('joins fragments separated by a pause into one request', () => {
		// The bug, in one test: a person pausing to think used to produce two
		// dispatches, and the agent answered half a sentence.
		const { composer, settled } = makeComposer();

		composer.add('look at the auth module', 0.9);
		vi.advanceTimersByTime(SETTLE - 100);
		composer.add('and tell me why the refresh is failing', 0.8);
		vi.advanceTimersByTime(SETTLE);

		expect(settled).toHaveLength(1);
		expect(settled[0].text).toBe('look at the auth module and tell me why the refresh is failing');
		expect(settled[0].fragments).toBe(2);
	});

	it('dispatches nothing while the user is still talking', () => {
		const { composer, settled } = makeComposer();

		composer.add('first', 1);
		vi.advanceTimersByTime(SETTLE - 1);

		expect(settled).toEqual([]);
	});

	it('settles a complete thought once the pause is long enough', () => {
		const { composer, settled } = makeComposer();

		composer.add('open the auth tab', 1);
		vi.advanceTimersByTime(SETTLE);

		expect(settled).toHaveLength(1);
		expect(settled[0].fragments).toBe(1);
	});

	it('reports the worst confidence of the parts, not the average', () => {
		// The whole thing is dispatched as one request, so it is only as reliable
		// as its most doubtful fragment; averaging lets a clear part vouch for a
		// mumbled one.
		const { composer, settled } = makeComposer();

		composer.add('clear part', 0.95);
		composer.add('mumbled part', 0.4);
		vi.advanceTimersByTime(SETTLE);

		expect(settled[0].confidence).toBe(0.4);
	});

	it('sums the spoken duration across fragments', () => {
		const { composer, settled } = makeComposer();

		composer.add('one', 1, 1_000);
		composer.add('two', 1, 500);
		vi.advanceTimersByTime(SETTLE);

		expect(settled[0].durationMs).toBe(1_500);
	});

	it('emits the growing text so the transcript does not blank mid-thought', () => {
		const { composer, composing } = makeComposer();

		composer.add('look at', 1);
		composer.add('the auth module', 1);

		expect(composing).toEqual(['look at', 'look at the auth module']);
	});

	it('ignores an empty final rather than restarting the clock for silence', () => {
		const { composer, settled, composing } = makeComposer();

		composer.add('   ', 1);
		vi.advanceTimersByTime(SETTLE);

		expect(settled).toEqual([]);
		expect(composing).toEqual([]);
	});

	it('dispatches on arrival when composing is switched off', () => {
		// settleMs 0 is the pre-composer behaviour, kept reachable for anyone who
		// wants the old snappiness back.
		const { composer, settled } = makeComposer({ settleMs: 0 });

		composer.add('go', 1);

		expect(settled).toHaveLength(1);
	});

	/**
	 * The spoken Enter key. A settle timer is a guess at when someone stopped
	 * talking; a phrase is them saying so, which is why the timer becomes a
	 * backstop rather than the mechanism once these exist.
	 */
	describe('a send phrase ends dictation immediately', () => {
		it('sends without waiting for the settle timer', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add('fix the auth bug, good to go', 1);

			// No timer advanced: the whole point is not waiting.
			expect(settled).toHaveLength(1);
			expect(settled[0].sentBy).toBe('good to go');
		});

		it('strips the phrase, so the agent gets the request and not the signal', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add('fix the auth bug, good to go', 1);

			expect(settled[0].text).toBe('fix the auth bug');
		});

		it('sends everything buffered when the phrase is a turn of its own', () => {
			// The way it is actually said: you talk, you pause, then you say it.
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add('look at the auth module', 1);
			composer.add('and say why the refresh fails', 1);
			composer.add("that's it", 1);

			expect(settled).toHaveLength(1);
			expect(settled[0].text).toBe('look at the auth module and say why the refresh fails');
			expect(settled[0].fragments).toBe(2);
		});

		it('ignores the signal when there is no request to send', () => {
			// A send phrase with an empty buffer would otherwise dispatch an empty
			// prompt, which is worse than doing nothing.
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add('good to go', 1);

			expect(settled).toEqual([]);
			expect(composer.composing).toBe(false);
		});

		it('does not fire on a phrase said mid-sentence', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add("that's it exactly, the auth module is the problem", 1);

			expect(settled).toEqual([]);
			expect(composer.composing).toBe(true);
		});

		it('leaves the timer as the backstop when nothing is said', () => {
			// Forgetting the phrase must not mean the request never goes.
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add('fix the auth bug', 1);
			vi.advanceTimersByTime(30_000);

			expect(settled).toHaveLength(1);
			expect(settled[0].sentBy).toBeUndefined();
		});

		it('can be switched off entirely', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000, sendPhrases: [] });

			composer.add('fix the auth bug, good to go', 1);

			expect(settled).toEqual([]);
		});
	});

	describe('ending a thought by decree', () => {
		it('flush settles immediately', () => {
			const { composer, settled } = makeComposer();

			composer.add('half a sentence', 1);
			composer.flush();

			expect(settled).toHaveLength(1);
			expect(settled[0].text).toBe('half a sentence');
		});

		it('flush on an empty buffer dispatches nothing', () => {
			const { composer, settled } = makeComposer();

			composer.flush();

			expect(settled).toEqual([]);
		});

		it('cancel drops the thought and the timer with it', () => {
			// The floor closing must not leave a fragment to be dispatched into a
			// session nobody is in.
			const { composer, settled } = makeComposer();

			composer.add('abandoned', 1);
			composer.cancel();
			vi.advanceTimersByTime(SETTLE * 5);

			expect(settled).toEqual([]);
			expect(composer.composing).toBe(false);
		});
	});

	it('stops holding at the cap, so a noisy room cannot wait forever', () => {
		// The backstop, not a normal path: fragments arriving faster than the settle
		// window would otherwise never let the thought finish.
		const { composer, settled } = makeComposer({ maxHoldMs: 3_000 });

		for (let elapsed = 0; elapsed < 5_000; elapsed += 300) {
			composer.add('noise', 1);
			vi.advanceTimersByTime(300);
		}

		expect(settled.length).toBeGreaterThan(0);
	});

	it('never lets the cap undercut the wait it is backstopping', () => {
		// A 30 s hold under a 30 s cap fires the cap first and splits the thought,
		// because the cap starts on the first fragment while the settle restarts on
		// every one.
		const { composer, settled } = makeComposer({ settleMs: 30_000, maxHoldMs: 30_000 });

		composer.add('still talking', 1);
		vi.advanceTimersByTime(29_000);
		composer.add('and still going', 1);
		vi.advanceTimersByTime(29_000);

		expect(settled).toEqual([]);
		expect(composer.composing).toBe(true);
	});

	it('does not restart the cap on every fragment', () => {
		// Restarting it would make the backstop unreachable in exactly the case it
		// exists for - continuous fragments. Gaps are shorter than the settle, so
		// the settle keeps restarting and only the cap can end this.
		const { composer, settled } = makeComposer({ settleMs: 200, maxHoldMs: 800 });

		for (let i = 0; i < 6; i += 1) {
			composer.add('still going', 1);
			vi.advanceTimersByTime(150);
		}

		expect(settled).toHaveLength(1);
		expect(settled[0].fragments).toBeGreaterThan(1);
	});

	it('starts a fresh thought after one settles', () => {
		const { composer, settled } = makeComposer();

		composer.add('first thought', 1);
		vi.advanceTimersByTime(SETTLE);
		composer.add('second thought', 1);
		vi.advanceTimersByTime(SETTLE);

		expect(settled.map((entry) => entry.text)).toEqual(['first thought', 'second thought']);
	});

	it('dispose stops it settling anything afterwards', () => {
		const { composer, settled } = makeComposer();

		composer.add('pending', 1);
		composer.dispose();
		composer.add('more', 1);
		vi.advanceTimersByTime(SETTLE * 5);

		expect(settled).toEqual([]);
	});
});
