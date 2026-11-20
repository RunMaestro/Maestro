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

	it('reports how long a held thought waits and what sends it now', () => {
		// The HUD reads this to say "say 'go maestro' to send, or it sends in 30s",
		// so a held request never looks like a session that ignored you.
		const holds: Array<{ settlesInMs: number; sendPhrases: string[] }> = [];
		const composer = new UtteranceComposer({
			settleMs: 30_000,
			sendPhrases: ['go maestro'],
			onSettled: () => undefined,
			onComposing: (_text, hold) => holds.push(hold),
		});

		composer.add('what color is snow', 0.9);

		expect(holds).toEqual([{ settlesInMs: 30_000, sendPhrases: ['go maestro'] }]);
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

			composer.add('fix the auth bug, go maestro', 1);

			// No timer advanced: the whole point is not waiting.
			expect(settled).toHaveLength(1);
			expect(settled[0].sentBy).toBe('go maestro');
		});

		it('strips the phrase, so the agent gets the request and not the signal', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.add('fix the auth bug, go maestro', 1);

			expect(settled[0].text).toBe('fix the auth bug');
		});

		it('sends everything buffered when the phrase is a turn of its own', () => {
			// The way it is actually said: you talk, you pause, then you say it.
			const { composer, settled } = makeComposer({
				settleMs: 30_000,
				sendPhrases: ["that's it"],
			});

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

			composer.add('go maestro', 1);

			expect(settled).toEqual([]);
			expect(composer.composing).toBe(false);
		});

		it('does not fire on a phrase said mid-sentence', () => {
			const { composer, settled } = makeComposer({
				settleMs: 30_000,
				sendPhrases: ["that's it"],
			});

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

			composer.add('fix the auth bug, go maestro', 1);

			expect(settled).toEqual([]);
		});
	});

	/**
	 * Letting go of a push-to-talk key. The recogniser is flushed at the same
	 * moment, and its final can land either side of the release, which is the
	 * entire reason this is not just "settle now".
	 */
	describe('a release gesture', () => {
		it('sends what is buffered without waiting for the timer', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });
			composer.add('fix the auth bug', 1);

			composer.armImmediateSettle();

			expect(settled).toHaveLength(1);
			expect(settled[0].text).toBe('fix the auth bug');
			expect(settled[0].sentBy).toBe('release');
		});

		it('waits for a flushed tail that has not arrived yet', () => {
			// The failure this exists to prevent: settling only the current buffer
			// sends the sentence minus its last few words.
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.armImmediateSettle();
			expect(settled).toEqual([]);

			composer.add('the last few words', 1);

			expect(settled).toHaveLength(1);
			expect(settled[0].text).toBe('the last few words');
		});

		it('includes the tail with what came before it', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });
			composer.add('look at the auth module', 1);

			// Buffer settles on the release, then the flushed tail arrives as its own
			// thought - the honest reading of words spoken after "I am done".
			composer.armImmediateSettle();
			composer.add('and the refresh path', 1);

			expect(settled.map((entry) => entry.text)).toEqual([
				'look at the auth module',
				'and the refresh path',
			]);
		});

		it('does nothing when nothing was ever said', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.armImmediateSettle();
			vi.advanceTimersByTime(60_000);

			expect(settled).toEqual([]);
		});

		it('is cleared by a cancel, so a closed floor cannot settle later', () => {
			const { composer, settled } = makeComposer({ settleMs: 30_000 });

			composer.armImmediateSettle();
			composer.cancel();
			composer.add('spoken into a dead session', 1);

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
	describe('a live configuration', () => {
		it('applies a changed wait to the next fragment, not the next composer', () => {
			// The composer outlives every session of the service that owns it, so a
			// wait copied at construction is the wait the app launched with forever.
			// The HUD's wait picker only works because this is read per fragment.
			let settleMs = 900;
			const settled: ComposedUtterance[] = [];
			const composer = new UtteranceComposer({
				getConfig: () => ({ settleMs }),
				onSettled: (utterance) => settled.push(utterance),
			});

			composer.add('first request', 0.9);
			vi.advanceTimersByTime(900);
			expect(settled).toHaveLength(1);

			settleMs = 5000;
			composer.add('second request', 0.9);
			vi.advanceTimersByTime(4900);
			expect(settled).toHaveLength(1);
			vi.advanceTimersByTime(100);
			expect(settled).toHaveLength(2);
		});

		it('reports the live wait to the HUD', () => {
			const holds: number[] = [];
			const composer = new UtteranceComposer({
				getConfig: () => ({ settleMs: 10_000 }),
				onSettled: () => undefined,
				onComposing: (_text, hold) => {
					if (hold) holds.push(hold.settlesInMs);
				},
			});

			composer.add('hold this', 0.9);

			expect(holds).toEqual([10_000]);
		});

		it('lets the getter win over the static value it was built with', () => {
			const { settled } = (() => {
				const settled: ComposedUtterance[] = [];
				const composer = new UtteranceComposer({
					settleMs: 30_000,
					getConfig: () => ({ settleMs: 0 }),
					onSettled: (utterance) => settled.push(utterance),
				});
				composer.add('send on arrival', 0.9);
				return { settled };
			})();

			expect(settled.map((u) => u.text)).toEqual(['send on arrival']);
		});
	});

	describe('a push-to-talk hold', () => {
		it('sends nothing on a pause while the control is still down', () => {
			// The failure this prevents: a breath mid-sentence endpoints the
			// recogniser, the settle timer fires, and half a request is dispatched
			// while the user is still holding the button to finish it.
			const { composer, settled } = makeComposer({ settleMs: 900 });

			composer.holdOpen();
			composer.add('look at the auth module', 0.9);
			vi.advanceTimersByTime(60_000);

			expect(settled).toEqual([]);
			expect(composer.pending).toBe('look at the auth module');
		});

		it('sends the whole thought on release', () => {
			const { composer, settled } = makeComposer({ settleMs: 900 });

			composer.holdOpen();
			composer.add('look at the auth module', 0.9);
			vi.advanceTimersByTime(5000);
			composer.add('and tell me why the refresh fails', 0.8);
			composer.armImmediateSettle();

			expect(settled).toHaveLength(1);
			expect(settled[0].text).toBe('look at the auth module and tell me why the refresh fails');
			expect(settled[0].sentBy).toBe('release');
		});

		it('reports the growing text with no countdown, because nothing is counting down', () => {
			const holds: unknown[] = [];
			const composer = new UtteranceComposer({
				settleMs: 900,
				onSettled: () => undefined,
				onComposing: (_text, hold) => holds.push(hold),
			});

			composer.holdOpen();
			composer.add('still talking', 0.9);

			expect(holds).toEqual([null]);
		});

		it('still honours a send phrase said while holding', () => {
			const { composer, settled } = makeComposer({ settleMs: 900, sendPhrases: ['send it'] });

			composer.holdOpen();
			composer.add('fix the auth bug, send it', 0.9);

			expect(settled.map((u) => u.text)).toEqual(['fix the auth bug']);
		});

		it('disarms a release left over from the last hold', () => {
			// A release that found nothing in flight leaves the next fragment armed to
			// settle on arrival. Carried into the next hold, it would end the new
			// sentence at its first pause.
			const { composer, settled } = makeComposer({ settleMs: 900 });

			composer.holdOpen();
			composer.armImmediateSettle();

			composer.holdOpen();
			composer.add('first half', 0.9);
			expect(settled).toEqual([]);

			composer.add('second half', 0.9);
			composer.armImmediateSettle();
			expect(settled.map((u) => u.text)).toEqual(['first half second half']);
		});

		it('goes back to the settle timer once the hold is over', () => {
			const { composer, settled } = makeComposer({ settleMs: 900 });

			composer.holdOpen();
			composer.add('held', 0.9);
			composer.armImmediateSettle();
			expect(settled).toHaveLength(1);

			// The tail flag from that release settles the next fragment on arrival,
			// as it always has; the one after it is back on the clock.
			composer.add('tail', 0.9);
			expect(settled).toHaveLength(2);
			composer.add('hands-free again', 0.9);
			expect(settled).toHaveLength(2);
			vi.advanceTimersByTime(900);
			expect(settled).toHaveLength(3);
		});

		it('is ended by a cancel', () => {
			const { composer, settled } = makeComposer({ settleMs: 900 });

			composer.holdOpen();
			composer.cancel();
			composer.add('after the cancel', 0.9);
			vi.advanceTimersByTime(900);

			expect(settled.map((u) => u.text)).toEqual(['after the cancel']);
		});
	});
});
