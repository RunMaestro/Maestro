/**
 * @file audio-bridge.test.ts
 *
 * The composition root where capture, the meter, the microphone projection, and
 * playback meet the session.
 *
 * The bridge is where "who opens the microphone, and when" is decided, so these
 * tests are mostly about edges the individual modules cannot see: a text-in
 * provider that must never cost the user a permission prompt, a host renderer
 * that boots after the session already asked for capture, and a speech run that
 * was cut off rather than finished.
 *
 * No Electron and no audio device: the session is a fake and the command sink is
 * an array.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	VoiceAudioBridge,
	createVoiceAudioBridge,
} from '../../../../main/acappella/audio/audio-bridge';
import type { AudioBridgeSession } from '../../../../main/acappella/audio/audio-bridge';
import {
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	type AudioFrame,
	type AudioHostCommand,
	type AudioHostErrorCode,
} from '../../../../shared/acappella/audio-host';
import type { MicState, VoiceEvent } from '../../../../shared/acappella/protocol';
import type { SttCallbacks, SttProvider, TtsChunk } from '../../../../shared/acappella/providers';
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
	flushError: Error | null = null;

	constructor(readonly acceptsAudio: boolean) {}

	async start(_callbacks: SttCallbacks): Promise<void> {}
	feed(pcm: Int16Array): void {
		this.fed.push(pcm);
	}
	async flush(): Promise<void> {
		this.flushes += 1;
		if (this.flushError) throw this.flushError;
	}
	async stop(): Promise<void> {}
}

class FakeSession implements AudioBridgeSession {
	state: VoiceSessionState = 'idle';
	stt: FakeStt | null = null;
	interrupts = 0;
	readonly levels: Array<{ level: number; speech: boolean }> = [];
	readonly micStates: MicState[] = [];
	readonly failures: Array<{ code: AudioHostErrorCode; message: string }> = [];

	private readonly listeners = new Set<(event: VoiceEvent) => void>();

	getState(): VoiceSessionState {
		return this.state;
	}
	interrupt(): boolean {
		if (this.state !== 'speaking') return false;
		this.interrupts += 1;
		this.state = 'listening';
		return true;
	}
	subscribe(listener: (event: VoiceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	getActiveStt(): SttProvider | null {
		return this.state === 'idle' ? null : this.stt;
	}
	publishAudioLevel(level: number, speech: boolean): void {
		this.levels.push({ level, speech });
	}
	publishMicState(state: MicState): void {
		this.micStates.push(state);
	}
	reportAudioCaptureFailure(code: AudioHostErrorCode, message: string): void {
		this.failures.push({ code, message });
	}

	/** Emit a protocol event the way the real service fans out to its subscribers. */
	emit(event: Partial<VoiceEvent> & { type: VoiceEvent['type'] }): void {
		const full = { sessionId: 'voice-1', seq: 1, ts: 0, ...event } as VoiceEvent;
		for (const listener of [...this.listeners]) listener(full);
	}

	/** Open the floor the way `startSession` does: state first, then the event. */
	listen(): void {
		this.state = 'listening';
		this.emit({ type: 'listen-start', scope: { kind: 'conductor' }, sttProviderId: 'fake-stt' });
	}
}

interface Harness {
	bridge: VoiceAudioBridge;
	session: FakeSession;
	stt: FakeStt;
	commands: AudioHostCommand[];
	kinds: () => string[];
	push(samples: Int16Array, count?: number): void;
}

let sequence = 0;

function frame(samples: Int16Array): AudioFrame {
	sequence += 1;
	return {
		seq: sequence,
		capturedAt: 1_000 + sequence * 20,
		rms: 0,
		pcm: samples.buffer.slice(0) as ArrayBuffer,
	};
}

function harness(options: { acceptsAudio?: boolean } = {}): Harness {
	sequence = 0;
	const session = new FakeSession();
	const stt = new FakeStt(options.acceptsAudio ?? true);
	session.stt = stt;
	const commands: AudioHostCommand[] = [];

	const bridge = createVoiceAudioBridge({
		session,
		sendCommand: (command) => commands.push(command),
	});

	return {
		bridge,
		session,
		stt,
		commands,
		kinds: () => commands.map((command) => command.kind),
		push: (samples, count = 1) => {
			for (let i = 0; i < count; i++) bridge.handleFrame(frame(samples));
		},
	};
}

/** Boot the host and open the floor, then forget the commands that took. */
function ready(h: Harness): void {
	h.bridge.handleStatus({ kind: 'ready' });
	h.session.listen();
	h.bridge.handleStatus({
		kind: 'capture-start',
		device: { deviceId: 'default', label: 'Built-in Microphone' },
		contextSampleRate: 48_000,
	});
	h.commands.length = 0;
	h.session.micStates.length = 0;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('VoiceAudioBridge capture lifecycle', () => {
	it('opens the microphone when the floor opens', () => {
		const h = harness();
		h.bridge.handleStatus({ kind: 'ready' });

		h.session.listen();

		expect(h.kinds()).toContain('start-capture');
	});

	it('never opens a device for a recogniser that cannot hear', () => {
		const h = harness({ acceptsAudio: false });
		h.bridge.handleStatus({ kind: 'ready' });

		h.session.listen();

		// The mock tier is text-in by construction. A permission prompt on its behalf
		// buys a level meter over a transcript that is never coming.
		expect(h.kinds()).not.toContain('start-capture');
	});

	it('closes the microphone when the session ends', () => {
		const h = harness();
		ready(h);

		h.session.state = 'idle';
		h.session.emit({ type: 'listen-stop', reason: 'stopped' });

		expect(h.kinds()).toEqual(['stop-capture', 'flush']);
	});

	it('re-requests capture when the host renderer boots after the session did', () => {
		const h = harness();

		// The window is created on the first session start, so the renderer is still
		// loading its bundle when the floor opens: the first request is lost.
		h.session.listen();
		h.commands.length = 0;

		h.bridge.handleStatus({ kind: 'ready' });

		expect(h.kinds()).toEqual(['start-capture']);
	});

	it('does not request capture on a ready that no session is waiting for', () => {
		const h = harness();

		h.bridge.handleStatus({ kind: 'ready' });

		expect(h.commands).toEqual([]);
	});
});

describe('VoiceAudioBridge frame routing', () => {
	it('feeds captured audio to the recogniser while listening', () => {
		const h = harness();
		ready(h);

		h.push(tone(), 5);

		expect(h.stt.fed.length).toBeGreaterThan(0);
		expect(h.bridge.getStats().framesReceived).toBe(5);
	});

	it('counts frames that arrive with nowhere to go rather than queueing them', () => {
		const h = harness();
		ready(h);
		h.session.state = 'dispatching';

		h.push(tone(), 30);

		expect(h.stt.fed).toEqual([]);
		expect(h.bridge.getStats().framesDropped).toBe(30);
	});

	it('ignores frames once disposed', () => {
		const h = harness();
		ready(h);

		h.bridge.dispose();
		h.push(tone(), 5);

		expect(h.stt.fed).toEqual([]);
	});
});

describe('VoiceAudioBridge level meter', () => {
	it('publishes a downsampled level rather than one update per frame', () => {
		const h = harness();
		ready(h);

		h.push(tone(), 30);

		// The meter's window is what decides the rate; the bridge only publishes what
		// comes back out of it.
		expect(h.session.levels.length).toBeGreaterThan(0);
		expect(h.session.levels.length).toBeLessThan(30);
		expect(h.session.levels.at(-1)!.level).toBeGreaterThan(0);
	});

	it('marks the windows the detector held the floor open for', () => {
		const h = harness();
		ready(h);

		h.push(tone(), 30);

		// A meter that shows a loud room and one that shows a person talking are
		// different things, and only this flag can tell them apart.
		expect(h.session.levels.some((update) => update.speech)).toBe(true);
	});

	it('stops republishing an unchanging silence', () => {
		const h = harness();
		ready(h);

		h.push(silence(), 60);

		// An open microphone in a quiet room is most of a voice session, not an edge
		// case: the meter falls to zero once and then says nothing.
		expect(h.session.levels).toHaveLength(1);
		expect(h.session.levels[0].level).toBe(0);
	});
});

describe('VoiceAudioBridge microphone state', () => {
	it('publishes the device once capture proves the permission', () => {
		const h = harness();
		h.bridge.handleStatus({ kind: 'ready' });
		h.session.listen();

		h.bridge.handleStatus({
			kind: 'capture-start',
			device: { deviceId: 'default', label: 'Built-in Microphone' },
			contextSampleRate: 48_000,
		});

		expect(h.session.micStates.at(-1)).toMatchObject({
			permission: 'granted',
			capturing: true,
			deviceLabel: 'Built-in Microphone',
		});
	});

	it('turns a capture failure into both a microphone state and a session error', () => {
		const h = harness();
		ready(h);

		h.bridge.handleStatus({
			kind: 'mic-error',
			code: 'permission-denied',
			message: 'Permission denied',
		});

		// A dead microphone must never present as a session that is merely quiet, so
		// it produces the state a HUD draws AND the error a client can act on.
		expect(h.session.micStates.at(-1)).toMatchObject({
			permission: 'denied',
			issue: 'permission-denied',
			capturing: false,
		});
		expect(h.session.failures).toEqual([
			{ code: 'permission-denied', message: 'Permission denied' },
		]);
	});

	it('leaves the meter at rest when the device goes away', () => {
		const h = harness();
		ready(h);
		h.push(tone(), 30);
		h.session.levels.length = 0;

		h.bridge.handleStatus({ kind: 'capture-stop', reason: 'device-lost' });
		h.session.state = 'listening';
		h.push(silence(), 10);

		// A bar left standing over a device nobody is reading is the same lie as a
		// listening indicator over a denied one, so the next run republishes from
		// scratch instead of inheriting the last level.
		expect(h.session.levels.length).toBeGreaterThan(0);
		expect(h.session.levels[0].level).toBe(0);
	});

	it('says nothing about statuses that say nothing about the microphone', () => {
		const h = harness();
		ready(h);

		h.bridge.handleStatus({
			kind: 'playback-state',
			playing: true,
			utteranceId: 'u1',
			queuedMs: 40,
		});

		expect(h.session.micStates).toEqual([]);
	});
});

describe('VoiceAudioBridge barge-in', () => {
	it('cuts the assistant off when the user talks over it', () => {
		const h = harness();
		ready(h);
		h.session.state = 'speaking';

		h.push(tone(), 12);

		expect(h.session.interrupts).toBe(1);
		expect(h.kinds()).toContain('flush');
	});

	it('ducks on suspicion before it is sure', () => {
		const h = harness();
		ready(h);
		h.session.state = 'speaking';

		h.push(tone(), 1);

		// 80 ms before a `speech-start` can be confirmed, the user hears themselves
		// win the room.
		expect(h.commands[0]).toMatchObject({ kind: 'duck' });
		expect(h.session.interrupts).toBe(0);
	});
});

describe('VoiceAudioBridge playback', () => {
	function chunk(overrides: Partial<TtsChunk> = {}): TtsChunk {
		return {
			utteranceId: 'u1',
			index: 0,
			text: 'All done.',
			format: 'pcm16',
			sampleRate: 24_000,
			audio: new Uint8Array([1, 2, 3, 4]),
			...overrides,
		};
	}

	it('plays a chunk through the same host that captures', () => {
		const h = harness();
		ready(h);

		h.bridge.handleSpeechChunk(chunk());

		expect(h.commands).toEqual([
			expect.objectContaining({
				kind: 'play',
				utteranceId: 'u1',
				format: 'pcm16',
				sampleRate: 24_000,
			}),
		]);
		const command = h.commands[0] as Extract<AudioHostCommand, { kind: 'play' }>;
		expect(new Uint8Array(command.data)).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it('sends a container format on to be decoded', () => {
		const h = harness();
		ready(h);

		h.bridge.handleSpeechChunk(chunk({ format: 'mp3', sampleRate: undefined }));

		expect(h.commands[0]).toMatchObject({ kind: 'play', format: 'encoded' });
	});

	it('drops a silent chunk instead of playing nothing', () => {
		const h = harness();
		ready(h);

		h.bridge.handleSpeechChunk(chunk({ format: 'none', audio: null }));

		expect(h.commands).toEqual([]);
	});

	it('refuses raw samples with no sample rate rather than guessing one', () => {
		const h = harness();
		ready(h);

		h.bridge.handleSpeechChunk(chunk({ sampleRate: undefined }));

		// Guessing is how a voice ends up an octave out.
		expect(h.commands).toEqual([]);
	});

	it('drains the queue when a speech run finishes on its own', () => {
		const h = harness();
		ready(h);

		h.session.emit({ type: 'speak-end', utteranceId: 'u1', reason: 'complete' });

		expect(h.commands).toEqual([{ kind: 'end-utterance', utteranceId: 'u1' }]);
	});

	it('throws the queue away when a run was cut off', () => {
		const h = harness();
		ready(h);

		h.session.emit({ type: 'speak-end', utteranceId: 'u1', reason: 'cancelled' });

		// What is queued is audio the user has already talked over.
		expect(h.commands).toEqual([{ kind: 'flush' }]);
	});

	it('drops playback aimed at a host that has not booted yet', () => {
		const h = harness();
		h.session.listen();
		h.commands.length = 0;

		h.bridge.handleSpeechChunk(chunk());

		expect(h.commands).toEqual([]);
	});
});

describe('VoiceAudioBridge endpointing', () => {
	it('forces the recogniser to endpoint on demand', () => {
		const h = harness();
		ready(h);

		h.bridge.endUtterance();

		expect(h.stt.flushes).toBe(1);
	});

	it('is a no-op when there is no session to endpoint', () => {
		const h = harness();

		expect(() => h.bridge.endUtterance()).not.toThrow();
		expect(h.stt.flushes).toBe(0);
	});

	it('survives a recogniser that cannot take the hint', async () => {
		const h = harness();
		ready(h);
		h.stt.flushError = new Error('no endpointing here');

		h.bridge.endUtterance();
		await Promise.resolve();

		// Endpointing is a hint; the recogniser still has the audio.
		expect(h.stt.flushes).toBe(1);
	});
});

describe('VoiceAudioBridge teardown', () => {
	it('closes the microphone on dispose rather than after it', () => {
		const h = harness();
		ready(h);

		h.bridge.dispose();

		// The stop command has to leave BEFORE the bridge marks itself dead, or the
		// device stays open with nothing left to close it.
		expect(h.kinds()).toContain('stop-capture');
	});

	it('is safe to dispose twice', () => {
		const h = harness();
		ready(h);

		h.bridge.dispose();
		h.commands.length = 0;
		h.bridge.dispose();

		expect(h.commands).toEqual([]);
	});

	it('stops following the session it was disposed for', () => {
		const h = harness();
		ready(h);
		h.bridge.dispose();
		h.commands.length = 0;

		h.session.listen();

		expect(h.commands).toEqual([]);
	});
});

describe('VoiceAudioBridge', () => {
	it('is constructible through its factory', () => {
		const h = harness();
		expect(h.bridge).toBeInstanceOf(VoiceAudioBridge);
	});
});
