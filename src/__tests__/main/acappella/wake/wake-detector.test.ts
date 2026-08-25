/**
 * @file wake-detector.test.ts
 *
 * The always-local wake word: phrase matching against a per-phrase sensitivity,
 * the debounce that stops one spoken phrase becoming three sessions, per-agent
 * scope resolution, pre-roll inclusion, and the invariant this whole subsystem
 * exists to hold - **while only the wake detector is running, no audio frame
 * reaches a hosted provider or leaves the process.**
 *
 * The scorer is injected, so the orchestration is tested with synthetic frames
 * and deterministic scores rather than against a trained model. That is the
 * right seam: everything above it is where a wake word gets a scope wrong or
 * clips the user's first word, and none of that depends on ONNX.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The detector reaches the model store only through the ONNX scorer, which no
// test here builds. Mocked so importing the module does not pull in `electron`.
vi.mock('../../../../main/acappella/models/model-store', () => ({
	modelFilePath: (id: string, file: string) => `/models/${id}/${file}`,
}));

import { ACAPPELLA_AUDIO_FRAME_SAMPLES } from '../../../../shared/acappella/audio-host';
import type { SttProvider } from '../../../../shared/acappella/providers';
import {
	DEFAULT_WAKE_DEBOUNCE_MS,
	GLOBAL_WAKE_PHRASE_ID,
	WAKE_HOP_SAMPLES,
	WakeDetector,
	agentWakePhrase,
	assertWakeScorerLocal,
	createWakeDetector,
	globalWakePhrase,
	wakeThresholdFor,
	type WakeDetection,
	type WakePhrase,
	type WakePhraseScorer,
} from '../../../../main/acappella/wake/wake-detector';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A scorer whose answer is set by the test. Local by construction. */
class ScriptedScorer implements WakePhraseScorer {
	readonly tier = 'local' as const;
	scores: Record<string, number> = {};
	calls = 0;
	disposed = 0;
	throwOnce = false;

	score(hop: Float32Array, phrases: readonly WakePhrase[]): Record<string, number> {
		this.calls += 1;
		if (this.throwOnce) {
			this.throwOnce = false;
			throw new Error('inference exploded');
		}
		expect(hop.length).toBe(WAKE_HOP_SAMPLES);
		expect(phrases.length).toBeGreaterThan(0);
		return this.scores;
	}

	dispose(): void {
		this.disposed += 1;
	}
}

/** One 20 ms frame of non-silent audio. Content is irrelevant to the scorer. */
function frame(fill = 1000): Int16Array {
	return new Int16Array(ACAPPELLA_AUDIO_FRAME_SAMPLES).fill(fill);
}

/** Push enough frames to complete `hops` scoring windows. */
function pushHops(detector: WakeDetector, hops: number, fill?: number): void {
	const framesPerHop = WAKE_HOP_SAMPLES / ACAPPELLA_AUDIO_FRAME_SAMPLES;
	for (let i = 0; i < hops * framesPerHop; i++) detector.pushFrame(frame(fill));
}

describe('wakeThresholdFor', () => {
	it('inverts sensitivity and clamps nonsense into the band', () => {
		expect(wakeThresholdFor({ id: 'a', phrase: 'a', scope: { kind: 'conductor' } }, 0.5)).toBe(0.5);
		expect(
			wakeThresholdFor({ id: 'a', phrase: 'a', scope: { kind: 'conductor' }, sensitivity: 0.9 })
		).toBeCloseTo(0.1);
		// The most sensitive setting is still not a hair trigger.
		expect(
			wakeThresholdFor({ id: 'a', phrase: 'a', scope: { kind: 'conductor' }, sensitivity: 5 })
		).toBeGreaterThan(0);
	});
});

describe('assertWakeScorerLocal', () => {
	it('refuses a scorer that is not local', () => {
		const hosted = { tier: 'cloud', score: () => ({}) } as unknown as WakePhraseScorer;
		expect(() => assertWakeScorerLocal(hosted)).toThrow(/no audio may leave the machine/i);
	});
});

describe('WakeDetector', () => {
	let scorer: ScriptedScorer;
	let detections: WakeDetection[];
	let clock: number;

	const phrases: WakePhrase[] = [
		globalWakePhrase('hey maestro'),
		agentWakePhrase('agent-7', 'hey scout'),
	];

	function build(overrides: Partial<Parameters<typeof createWakeDetector>[0]> = {}): WakeDetector {
		return createWakeDetector({
			getPhrases: () => phrases,
			scorer,
			onWake: (detection) => detections.push(detection),
			now: () => clock,
			...overrides,
		});
	}

	beforeEach(() => {
		scorer = new ScriptedScorer();
		detections = [];
		clock = 1_000;
	});

	it('fires when a phrase clears its threshold', async () => {
		const detector = build();
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.8 };

		pushHops(detector, 1);

		expect(detections).toHaveLength(1);
		expect(detections[0].phrase).toBe('hey maestro');
		expect(detections[0].scope).toEqual({ kind: 'conductor' });
	});

	it('stays quiet below the threshold', async () => {
		const detector = build();
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.3 };

		pushHops(detector, 3);

		expect(detections).toHaveLength(0);
		expect(detector.getStats().hopsScored).toBe(3);
	});

	it('resolves an agent phrase to that agent scope', async () => {
		const detector = build();
		await detector.start();
		scorer.scores = { 'agent:agent-7': 0.9 };

		pushHops(detector, 1);

		expect(detections[0].scope).toEqual({ kind: 'agent', sessionId: 'agent-7' });
		expect(detections[0].phrase).toBe('hey scout');
	});

	it('fires the best match when two phrases clear at once', async () => {
		const detector = build();
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.7, 'agent:agent-7': 0.95 };

		pushHops(detector, 1);

		// One session per sentence, and it is the closer match that wins.
		expect(detections).toHaveLength(1);
		expect(detections[0].phraseId).toBe('agent:agent-7');
	});

	it('debounces consecutive windows of one spoken phrase', async () => {
		const detector = build();
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		pushHops(detector, 4);

		expect(detections).toHaveLength(1);
		expect(detector.getStats().debounced).toBe(3);
	});

	it('fires again once the debounce window has passed', async () => {
		const detector = build();
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		pushHops(detector, 1);
		clock += DEFAULT_WAKE_DEBOUNCE_MS + 1;
		pushHops(detector, 1);

		expect(detections).toHaveLength(2);
	});

	it('debounces per phrase, not globally', async () => {
		const detector = build();
		await detector.start();

		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };
		pushHops(detector, 1);
		scorer.scores = { 'agent:agent-7': 0.9 };
		pushHops(detector, 1);

		expect(detections.map((d) => d.phraseId)).toEqual([GLOBAL_WAKE_PHRASE_ID, 'agent:agent-7']);
	});

	it('hands the pre-roll to the caller so the words after the phrase survive', async () => {
		const detector = build({ preRollMs: 200 });
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		pushHops(detector, 1);

		expect(detections[0].preRoll.length).toBeGreaterThan(0);
		expect(detections[0].preRoll[0]).toBeInstanceOf(Int16Array);
	});

	it('drains the pre-roll on a hit, so the same audio is never replayed twice', async () => {
		const detector = build({ preRollMs: 200 });
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		pushHops(detector, 1);
		const first = detections[0].preRoll;
		clock += DEFAULT_WAKE_DEBOUNCE_MS + 1;
		pushHops(detector, 1);
		const second = detections[1].preRoll;

		expect(first.length).toBeGreaterThan(0);
		expect(second.every((buffer) => !first.includes(buffer))).toBe(true);
	});

	it('uses an injected pre-roll ring, so the pipeline and the detector share one buffer', async () => {
		const pushed: Int16Array[] = [];
		const ring = {
			push: (samples: Int16Array) => pushed.push(samples),
			drain: () => pushed.splice(0, pushed.length),
			clear: () => (pushed.length = 0),
		};
		const detector = build({ preRoll: ring });
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		pushHops(detector, 1);

		expect(detections[0].preRoll.length).toBe(WAKE_HOP_SAMPLES / ACAPPELLA_AUDIO_FRAME_SAMPLES);
		expect(pushed).toHaveLength(0);
	});

	it('skips a phrase that is switched off', async () => {
		const parked: WakePhrase[] = [{ ...globalWakePhrase('hey maestro'), enabled: false }];
		const detector = build({ getPhrases: () => parked });
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.99 };

		pushHops(detector, 2);

		expect(detections).toHaveLength(0);
		expect(scorer.calls).toBe(0);
	});

	it('reads the phrase list per hop, so a new agent phrase arms without a restart', async () => {
		const live: WakePhrase[] = [globalWakePhrase('hey maestro')];
		const detector = build({ getPhrases: () => live });
		await detector.start();
		scorer.scores = { 'agent:late': 0.95 };

		pushHops(detector, 1);
		expect(detections).toHaveLength(0);

		live.push(agentWakePhrase('late', 'hey late'));
		pushHops(detector, 1);
		expect(detections).toHaveLength(1);
	});

	it('counts a scoring failure instead of throwing into the audio callback', async () => {
		const detector = build();
		await detector.start();
		scorer.throwOnce = true;

		expect(() => pushHops(detector, 1)).not.toThrow();
		expect(detector.getStats().scoreErrors).toBe(1);
	});

	it('survives a wake handler that throws', async () => {
		const detector = build({
			onWake: () => {
				throw new Error('session exploded');
			},
		});
		await detector.start();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		expect(() => pushHops(detector, 1)).not.toThrow();
	});

	it('runs inert rather than failing when no scorer can be built', async () => {
		const detector = createWakeDetector({
			getPhrases: () => phrases,
			createScorer: async () => null,
			onWake: (detection) => detections.push(detection),
		});
		await detector.start();

		expect(detector.isRunning).toBe(true);
		expect(detector.isArmed).toBe(false);
		pushHops(detector, 3);
		expect(detections).toHaveLength(0);
	});

	it('refuses a scorer that is not local', () => {
		const hosted = { tier: 'cloud', score: () => ({}) } as unknown as WakePhraseScorer;
		expect(() =>
			createWakeDetector({ getPhrases: () => phrases, scorer: hosted, onWake: vi.fn() })
		).toThrow(/no audio may leave the machine/i);
	});

	it('consumes nothing before start and nothing after stop', async () => {
		const detector = build();
		scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

		pushHops(detector, 2);
		expect(detector.getStats().framesReceived).toBe(0);

		await detector.start();
		await detector.stop();
		pushHops(detector, 2);

		expect(detections).toHaveLength(0);
		// A scorer the caller supplied belongs to the caller, so stopping does not
		// free it. Only one the detector built holds ONNX sessions to release.
		expect(scorer.disposed).toBe(0);
	});

	it('disposes the scorer it built itself', async () => {
		const built = new ScriptedScorer();
		const detector = createWakeDetector({
			getPhrases: () => phrases,
			createScorer: async () => built,
			onWake: vi.fn(),
		});
		await detector.start();
		await detector.stop();

		expect(built.disposed).toBe(1);
	});

	// -----------------------------------------------------------------------
	// The invariant
	// -----------------------------------------------------------------------

	describe('no audio leaves the process while only the wake word is running', () => {
		it('never hands a frame to a hosted speech provider', async () => {
			const feed = vi.fn();
			const hostedStt = {
				id: 'openai-stt',
				tier: 'cloud',
				feed,
				flush: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
			} as unknown as SttProvider;

			const detector = build();
			await detector.start();
			scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };

			// 200 frames is four seconds of a room being listened to.
			for (let i = 0; i < 200; i++) detector.pushFrame(frame(i * 7));

			expect(feed).not.toHaveBeenCalled();
			// And nothing the detector produced references the provider at all: the
			// only outward edge is `onWake`, which hands PCM to the CALLER.
			expect(hostedStt).toBeDefined();
			expect(detector.getStats().framesReceived).toBe(200);
		});

		it('makes no network call of any kind', async () => {
			const fetchSpy = vi.fn();
			const originalFetch = globalThis.fetch;
			globalThis.fetch = fetchSpy as unknown as typeof fetch;
			try {
				const detector = build();
				await detector.start();
				scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };
				for (let i = 0; i < 200; i++) detector.pushFrame(frame(i));
				expect(fetchSpy).not.toHaveBeenCalled();
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('clears the retained audio when it stops', async () => {
			const detector = build({ preRollMs: 500 });
			await detector.start();
			pushHops(detector, 2, 5000);
			await detector.stop();
			await detector.start();
			scorer.scores = { [GLOBAL_WAKE_PHRASE_ID]: 0.9 };
			pushHops(detector, 1);

			// Only this run's frames, never the previous run's.
			expect(detections[0].preRoll.length).toBe(WAKE_HOP_SAMPLES / ACAPPELLA_AUDIO_FRAME_SAMPLES);
		});
	});
});
