/**
 * @file audio-pipeline.test.ts
 *
 * The duplex audio pipeline: what reaches the recogniser, what is dropped, what
 * is held in the pre-roll, and what happens when the user talks over the
 * assistant.
 *
 * Everything here is generated PCM against a fake session and a fake recogniser.
 * No `AudioContext`, no audio host window, no timers - the pipeline is injected
 * with its three seams (session, provider, command sink) precisely so a test can
 * drive a full barge-in in a few microseconds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { captureException } from '../../../../main/utils/sentry';
import {
	AudioFrameRing,
	AudioPipeline,
	DEFAULT_PRE_ROLL_MS,
	MAX_PRE_ROLL_MS,
	createAudioPipeline,
	type AudioPipelineOptions,
	type AudioPipelineSession,
} from '../../../../main/acappella/audio/audio-pipeline';
import {
	ACAPPELLA_AUDIO_FRAME_MS,
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	type AudioFrame,
	type AudioHostCommand,
} from '../../../../shared/acappella/audio-host';
import type { SttCallbacks, SttProvider } from '../../../../shared/acappella/providers';
import type { VoiceSessionState } from '../../../../shared/acappella/session-state';

// ---------------------------------------------------------------------------
// Signal generators
// ---------------------------------------------------------------------------

function build(fill: (index: number) => number): Int16Array {
	const samples = new Int16Array(ACAPPELLA_AUDIO_FRAME_SAMPLES);
	for (let i = 0; i < ACAPPELLA_AUDIO_FRAME_SAMPLES; i++) {
		const value = Math.max(-1, Math.min(1, fill(i)));
		samples[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
	}
	return samples;
}

const silence = (): Int16Array => build(() => 0);

/** Voiced speech stand-in: 200 Hz sits squarely inside the VAD's zero-crossing band. */
const tone = (amplitude = 0.4): Int16Array =>
	build((i) => amplitude * Math.sin((2 * Math.PI * 200 * i) / ACAPPELLA_AUDIO_SAMPLE_RATE));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeStt implements SttProvider {
	readonly id = 'fake-stt';
	readonly label = 'Fake STT';
	readonly tier = 'mock' as const;
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;

	readonly fed: Int16Array[] = [];
	flushes = 0;
	feedError: Error | null = null;
	flushError: Error | null = null;

	async start(_callbacks: SttCallbacks): Promise<void> {}

	feed(pcm: Int16Array): void {
		if (this.feedError) throw this.feedError;
		this.fed.push(pcm);
	}

	async flush(): Promise<void> {
		this.flushes += 1;
		if (this.flushError) throw this.flushError;
	}

	async stop(): Promise<void> {}
}

class FakeSession implements AudioPipelineSession {
	state: VoiceSessionState = 'idle';
	interrupts = 0;

	getState(): VoiceSessionState {
		return this.state;
	}

	/** Mirrors the real service: barge-in only means something while speaking. */
	interrupt(): boolean {
		if (this.state !== 'speaking') return false;
		this.interrupts += 1;
		this.state = 'listening';
		return true;
	}
}

interface Harness {
	pipeline: AudioPipeline;
	session: FakeSession;
	stt: FakeStt;
	commands: AudioHostCommand[];
	bargeIns: number;
	/** Push `count` copies of one frame through the pipeline. */
	push(samples: Int16Array, count?: number): void;
}

function harness(overrides: Partial<AudioPipelineOptions> = {}): Harness {
	const session = new FakeSession();
	const stt = new FakeStt();
	const commands: AudioHostCommand[] = [];
	let seq = 0;

	const state = { bargeIns: 0 };
	const pipeline = createAudioPipeline({
		session,
		getStt: () => stt,
		sendCommand: (command) => commands.push(command),
		onBargeIn: () => {
			state.bargeIns += 1;
		},
		...overrides,
	});

	return {
		pipeline,
		session,
		stt,
		commands,
		get bargeIns() {
			return state.bargeIns;
		},
		push(samples, count = 1) {
			for (let i = 0; i < count; i++) {
				seq += 1;
				pipeline.handleFrame(frameOf(samples, seq));
			}
		},
	};
}

function frameOf(samples: Int16Array, seq: number): AudioFrame {
	// A copy per frame, because the pipeline keeps references in the pre-roll and a
	// shared buffer would make every buffered frame the last one pushed.
	const copy = new Int16Array(samples);
	return {
		seq,
		capturedAt: 1_700_000_000_000 + seq * ACAPPELLA_AUDIO_FRAME_MS,
		rms: 0,
		pcm: copy.buffer,
	};
}

function commandsOfKind<K extends AudioHostCommand['kind']>(
	commands: AudioHostCommand[],
	kind: K
): Extract<AudioHostCommand, { kind: K }>[] {
	return commands.filter((c): c is Extract<AudioHostCommand, { kind: K }> => c.kind === kind);
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('AudioFrameRing', () => {
	it('evicts the oldest frame once it is full', () => {
		const ring = new AudioFrameRing(2);
		const first = new Int16Array([1]);
		const second = new Int16Array([2]);
		const third = new Int16Array([3]);
		ring.push(first);
		ring.push(second);
		ring.push(third);

		expect(ring.size).toBe(2);
		expect(ring.drain()).toEqual([second, third]);
		expect(ring.size).toBe(0);
	});

	it('holds nothing at zero capacity', () => {
		const ring = new AudioFrameRing(0);
		ring.push(new Int16Array([1]));
		expect(ring.size).toBe(0);
	});
});

describe('capture lifecycle', () => {
	it('opens the microphone on start and closes it on stop', () => {
		const h = harness();
		h.pipeline.start();
		expect(h.commands).toEqual([{ kind: 'start-capture' }]);

		h.pipeline.stop();
		// The flush is not optional: a session that ends mid-sentence must not keep
		// talking into a room whose microphone it just released.
		expect(h.commands).toEqual([
			{ kind: 'start-capture' },
			{ kind: 'stop-capture' },
			{ kind: 'flush' },
		]);
	});

	it('is idempotent in both directions', () => {
		const h = harness();
		h.pipeline.start();
		h.pipeline.start();
		h.pipeline.stop();
		h.pipeline.stop();
		expect(commandsOfKind(h.commands, 'start-capture')).toHaveLength(1);
		expect(commandsOfKind(h.commands, 'stop-capture')).toHaveLength(1);
	});

	it('ignores frames that arrive before start or after stop', () => {
		const h = harness();
		h.session.state = 'listening';

		h.push(tone(), 3);
		expect(h.stt.fed).toHaveLength(0);

		h.pipeline.start();
		h.push(tone(), 3);
		expect(h.stt.fed).toHaveLength(3);

		h.pipeline.stop();
		h.push(tone(), 3);
		expect(h.stt.fed).toHaveLength(3);
	});

	it('clears the counters between runs', () => {
		const h = harness();
		h.pipeline.start();
		h.push(tone(), 5);
		expect(h.pipeline.getStats().framesReceived).toBe(5);

		h.pipeline.stop();
		h.pipeline.start();
		expect(h.pipeline.getStats().framesReceived).toBe(0);
	});
});

describe('routing frames to the recogniser', () => {
	it('feeds every frame while the session is listening', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();

		h.push(tone(), 10);

		expect(h.stt.fed).toHaveLength(10);
		expect(h.pipeline.getStats()).toMatchObject({
			framesReceived: 10,
			framesDelivered: 10,
			framesDropped: 0,
		});
	});

	it('drops frames rather than queueing them when the session is not listening', () => {
		const h = harness();
		h.session.state = 'dispatching';
		h.pipeline.start();

		h.push(tone(), 200);

		expect(h.stt.fed).toHaveLength(0);
		expect(h.pipeline.getStats().framesDropped).toBe(200);
	});

	it('drops frames when no recogniser is running', () => {
		const h = harness({ getStt: () => null });
		h.session.state = 'listening';
		h.pipeline.start();

		h.push(tone(), 4);

		expect(h.pipeline.getStats()).toMatchObject({ framesDelivered: 0, framesDropped: 4 });
	});

	it('forwards the VAD endpoint to the recogniser as a flush', () => {
		const h = harness({ vad: { adaptiveNoiseFloor: false, endpointSilenceMs: 100 } });
		h.session.state = 'listening';
		h.pipeline.start();

		h.push(tone(), 6);
		expect(h.stt.flushes).toBe(0);

		// 100 ms of silence is five frames; the fifth endpoints.
		h.push(silence(), 5);
		expect(h.stt.flushes).toBe(1);
	});

	it('counts frames the transport lost instead of hiding the gap', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();

		h.pipeline.handleFrame(frameOf(tone(), 1));
		h.pipeline.handleFrame(frameOf(tone(), 5));

		expect(h.pipeline.getStats().sequenceGaps).toBe(3);
	});
});

describe('pre-roll', () => {
	const preRollFrames = DEFAULT_PRE_ROLL_MS / ACAPPELLA_AUDIO_FRAME_MS;

	it('sizes itself from the configured window', () => {
		expect(harness().pipeline.preRollCapacity).toBe(preRollFrames);
		expect(harness({ preRollMs: 200 }).pipeline.preRollCapacity).toBe(10);
		expect(harness({ preRollMs: 0 }).pipeline.preRollCapacity).toBe(0);
	});

	it('clamps an absurd window rather than trusting the setting', () => {
		expect(harness({ preRollMs: 60_000 }).pipeline.preRollCapacity).toBe(
			MAX_PRE_ROLL_MS / ACAPPELLA_AUDIO_FRAME_MS
		);
		expect(harness({ preRollMs: Number.NaN }).pipeline.preRollCapacity).toBe(preRollFrames);
	});

	it('replays the audio spoken just before the floor opened', () => {
		const h = harness();
		h.pipeline.start();

		// The user starts talking before the wake word has opened the session.
		h.push(tone(), 3);
		expect(h.stt.fed).toHaveLength(0);

		h.session.state = 'listening';
		h.push(tone(), 1);

		// Three pre-roll frames plus the live one: the first syllable survives.
		expect(h.stt.fed).toHaveLength(4);
		expect(h.pipeline.getStats().preRollFramesDelivered).toBe(3);
	});

	it('is bounded: a long idle stretch replays only the last window', () => {
		const h = harness();
		h.pipeline.start();

		h.push(tone(), 1000);
		h.session.state = 'listening';
		h.push(tone(), 1);

		expect(h.pipeline.getStats().preRollFramesDelivered).toBe(preRollFrames);
		expect(h.stt.fed).toHaveLength(preRollFrames + 1);
		expect(h.pipeline.getStats().framesDropped).toBe(1000);
	});

	it('does not re-deliver audio the recogniser already has', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();

		h.push(tone(), 5);
		h.session.state = 'dispatching';
		h.push(silence(), 2);
		h.session.state = 'listening';
		h.push(tone(), 1);

		// Five live frames, the two dropped ones from the pre-roll, one more live.
		expect(h.stt.fed).toHaveLength(8);
		expect(h.pipeline.getStats().preRollFramesDelivered).toBe(2);
	});

	it('drops the pre-roll when the capture device goes away', () => {
		const h = harness();
		h.pipeline.start();
		h.push(tone(), 5);

		h.pipeline.handleStatus({ kind: 'mic-error', code: 'device-lost', message: 'gone' });
		h.session.state = 'listening';
		h.push(tone(), 1);

		// Audio from a device that no longer exists is not context, it is confusion.
		expect(h.pipeline.getStats().preRollFramesDelivered).toBe(0);
		expect(h.stt.fed).toHaveLength(1);
	});
});

describe('barge-in', () => {
	it('flushes playback, cancels the speech run, and takes the floor back', () => {
		const h = harness();
		h.session.state = 'speaking';
		h.pipeline.start();

		h.push(tone(), 6);

		expect(commandsOfKind(h.commands, 'flush')).toHaveLength(1);
		expect(h.session.interrupts).toBe(1);
		expect(h.session.state).toBe('listening');
		expect(h.bargeIns).toBe(1);
		expect(h.pipeline.getStats().bargeIns).toBe(1);
	});

	it('delivers the audio the user interrupted with', () => {
		const h = harness();
		h.session.state = 'speaking';
		h.pipeline.start();

		h.push(tone(), 6);

		// The interrupting syllables were in the pre-roll when the floor opened, so
		// the recogniser hears the whole word rather than its tail.
		expect(h.stt.fed.length).toBeGreaterThanOrEqual(6);
		expect(h.pipeline.getStats().preRollFramesDelivered).toBeGreaterThan(0);
	});

	it('ducks output on suspicion, before the interrupt is confirmed', () => {
		const h = harness();
		h.session.state = 'speaking';
		h.pipeline.start();

		h.push(tone(), 1);

		// One frame in: too little evidence to cancel a speech run, enough to get out
		// of the user's way.
		expect(commandsOfKind(h.commands, 'duck')).toEqual([{ kind: 'duck', gain: 0.2, ms: 60 }]);
		expect(commandsOfKind(h.commands, 'flush')).toHaveLength(0);
		expect(h.session.interrupts).toBe(0);
	});

	it('restores the gain when the suspicion does not become speech', () => {
		const h = harness();
		h.session.state = 'speaking';
		h.pipeline.start();

		h.push(tone(), 2);
		h.push(silence(), 2);

		const ducks = commandsOfKind(h.commands, 'duck');
		expect(ducks).toHaveLength(2);
		expect(ducks[1]).toEqual({ kind: 'duck', gain: 1, ms: 60 });
		expect(h.session.interrupts).toBe(0);
	});

	it('restores the gain when playback ends on its own', () => {
		const h = harness();
		h.session.state = 'speaking';
		h.pipeline.start();

		h.push(tone(), 1);
		h.session.state = 'listening';
		h.push(silence(), 1);

		const ducks = commandsOfKind(h.commands, 'duck');
		expect(ducks[ducks.length - 1]).toEqual({ kind: 'duck', gain: 1, ms: 60 });
	});

	it('does not interrupt while the session is listening', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();

		h.push(tone(), 20);

		expect(commandsOfKind(h.commands, 'flush')).toHaveLength(0);
		expect(commandsOfKind(h.commands, 'duck')).toHaveLength(0);
		expect(h.session.interrupts).toBe(0);
	});

	it('needs sustained speech, not one loud frame', () => {
		const h = harness({ vad: { adaptiveNoiseFloor: false, enterFrames: 4 } });
		h.session.state = 'speaking';
		h.pipeline.start();

		h.push(tone(), 3);
		expect(h.session.interrupts).toBe(0);

		h.push(tone(), 1);
		expect(h.session.interrupts).toBe(1);
	});

	it('starts barge-in detection from a closed floor when playback begins', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();

		// The user is mid-utterance, so the detector is open when the reply starts.
		h.push(tone(), 10);
		h.session.state = 'speaking';

		// A single frame of leftover speech must not read as an interruption; the
		// evidence has to be gathered again against the assistant's own voice.
		h.push(tone(), 1);
		expect(h.session.interrupts).toBe(0);
		h.push(tone(), 3);
		expect(h.session.interrupts).toBe(1);
	});

	it('still flushes when the speech run ended between the frame and the interrupt', () => {
		const session = new FakeSession();
		const h = harness({ session });
		session.state = 'speaking';
		h.pipeline.start();

		// The service moved on by itself: `interrupt()` reports nothing to cancel.
		session.interrupt = () => false;
		h.push(tone(), 6);

		expect(commandsOfKind(h.commands, 'flush')).toHaveLength(1);
		expect(h.pipeline.getStats().bargeIns).toBe(0);
		expect(h.bargeIns).toBe(0);
	});
});

describe('failure handling', () => {
	it('counts a throwing feed once and keeps the run alive', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();
		h.stt.feedError = new Error('provider died');

		expect(() => h.push(tone(), 50)).not.toThrow();

		expect(h.pipeline.getStats().feedErrors).toBe(50);
		expect(h.pipeline.getStats().framesDelivered).toBe(0);
		// 50 identical reports a second is how a Sentry project becomes unreadable.
		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it('reports a rejected endpoint without failing the frame', async () => {
		const h = harness({ vad: { adaptiveNoiseFloor: false, endpointSilenceMs: 100 } });
		h.session.state = 'listening';
		h.pipeline.start();
		h.stt.flushError = new Error('no endpoint');

		h.push(tone(), 6);
		h.push(silence(), 5);
		await Promise.resolve();

		expect(captureException).toHaveBeenCalledTimes(1);
		expect(h.pipeline.getStats().framesDelivered).toBe(11);
	});
});

describe('observability', () => {
	it('reports every frame with its verdict and whether it was delivered', () => {
		const seen: { delivered: boolean; rms: number }[] = [];
		const h = harness({
			onFrame: ({ result, delivered }) => seen.push({ delivered, rms: result.rms }),
		});
		h.session.state = 'idle';
		h.pipeline.start();

		h.push(tone(), 2);
		h.session.state = 'listening';
		h.push(tone(), 2);

		expect(seen).toHaveLength(4);
		expect(seen.map((s) => s.delivered)).toEqual([false, false, true, true]);
		// The level meter in Phase 02's HUD task reads exactly this.
		expect(seen[0].rms).toBeGreaterThan(0);
	});

	it('resets its counters when capture restarts', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();
		h.push(tone(), 4);

		h.pipeline.handleStatus({
			kind: 'capture-start',
			device: { deviceId: 'default', label: 'Mic' },
			contextSampleRate: 48_000,
		});

		expect(h.pipeline.getStats().framesReceived).toBe(0);
	});

	it('stops and releases everything on dispose', () => {
		const h = harness();
		h.session.state = 'listening';
		h.pipeline.start();
		h.push(tone(), 4);

		h.pipeline.dispose();

		expect(h.pipeline.isRunning).toBe(false);
		expect(commandsOfKind(h.commands, 'stop-capture')).toHaveLength(1);
	});
});

describe('AudioPipeline construction', () => {
	it('accepts a partial VAD config and exposes what it resolved', () => {
		const pipeline = new AudioPipeline({
			session: new FakeSession(),
			getStt: () => null,
			sendCommand: () => {},
			vad: { endpointSilenceMs: 400 },
		});
		expect(pipeline.isRunning).toBe(false);
		expect(pipeline.preRollCapacity).toBe(DEFAULT_PRE_ROLL_MS / ACAPPELLA_AUDIO_FRAME_MS);
	});
});
