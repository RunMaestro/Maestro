/**
 * @file playback.test.ts
 *
 * TTS playback for the A Cappella audio host.
 *
 * Most of these tests are really barge-in tests. Interrupting the assistant has
 * to be felt as instant, and there are exactly two ways to get that wrong:
 * leaving already-scheduled buffers running (the assistant keeps talking for the
 * length of the last chunk), and letting a decode that was in flight during the
 * flush schedule itself afterwards (the assistant starts again from nowhere).
 * Both have their own test below.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeAudioContext, type FakeAudioContext } from '../../helpers/mockWebAudio';
import type { AudioHostStatus } from '../../../shared/acappella/audio-host';
import { pcm16ToFloat32, TtsPlayback } from '../../../renderer/acappella-audio/playback';

/** 16 kHz mono PCM16 of `samples` length, so duration is samples/16000 seconds. */
function pcmChunk(samples: number): ArrayBuffer {
	return new Int16Array(samples).buffer;
}

describe('pcm16ToFloat32', () => {
	it('round-trips the worklet quantisation exactly at both extremes', () => {
		const out = pcm16ToFloat32(new Int16Array([0, 0x7fff, -0x8000, 0x4000]).buffer);

		expect(out[0]).toBe(0);
		expect(out[1]).toBeCloseTo(1, 6);
		expect(out[2]).toBeCloseTo(-1, 6);
		expect(out[3]).toBeCloseTo(0.5, 4);
	});
});

describe('TtsPlayback', () => {
	let context: FakeAudioContext;
	let statuses: AudioHostStatus[];

	const build = () =>
		new TtsPlayback({
			context: context as unknown as AudioContext,
			onStatus: (status) => statuses.push(status),
		});

	beforeEach(() => {
		context = createFakeAudioContext();
		statuses = [];
	});

	const playbackStates = () =>
		statuses.filter(
			(status): status is Extract<AudioHostStatus, { kind: 'playback-state' }> =>
				status.kind === 'playback-state'
		);

	it('plays a PCM16 chunk through its own gain node into the destination', async () => {
		const playback = build();

		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(16000),
		});

		const gain = context.gains[0];
		expect(gain.connectedTo).toContain(context.destination);
		expect(context.sources).toHaveLength(1);
		expect(context.sources[0].connectedTo).toContain(gain);
		expect(context.sources[0].startedAt).toBe(0);
	});

	it('schedules consecutive chunks gaplessly rather than all at once', async () => {
		const playback = build();

		// Two half-second chunks: the second must start where the first ends, or a
		// streamed sentence comes out as overlapping speech.
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(8000),
		});
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(8000),
		});

		expect(context.sources[0].startedAt).toBe(0);
		expect(context.sources[1].startedAt).toBeCloseTo(0.5, 6);
		expect(playback.queuedMs).toBeCloseTo(1000, 3);
	});

	it('never schedules in the past when the queue has already drained', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		context.advance(5);

		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});

		expect(context.sources[1].startedAt).toBe(5);
	});

	it('decodes encoded chunks through the Web Audio decoder', async () => {
		const playback = build();

		await playback.enqueue({ utteranceId: 'u1', format: 'encoded', data: new ArrayBuffer(2048) });

		expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
		expect(context.sources).toHaveLength(1);
	});

	it('stops every scheduled source on flush, not just future ones', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(80000),
		});

		playback.flush();

		// A five-second chunk left running is five seconds of the assistant talking
		// over a user who already interrupted.
		expect(context.sources[0].stopped).toBe(true);
		expect(context.sources[0].disconnectCount).toBe(1);
		expect(playback.playing).toBe(false);
		expect(playback.queuedMs).toBe(0);
	});

	it('drops a chunk whose decode finishes after a flush', async () => {
		const playback = build();
		let release!: (buffer: unknown) => void;
		context.decodeAudioData.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve))
		);

		const pending = playback.enqueue({
			utteranceId: 'u1',
			format: 'encoded',
			data: new ArrayBuffer(64),
		});
		playback.flush();
		release({ duration: 1, length: 24000, sampleRate: 24000, numberOfChannels: 1 });
		await pending;

		// Scheduling this would restart speech the user already talked over.
		expect(context.sources).toHaveLength(0);
		expect(playback.playing).toBe(false);
	});

	it('restores gain on flush so the next utterance is not silently ducked', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		playback.duck(0, 30);

		playback.flush();

		expect(context.gains[0].gain.value).toBe(1);
	});

	it('ramps gain from its current value, so a duck during a duck does not jump', () => {
		const playback = build();
		context.advance(2);

		playback.duck(0.2, 120);

		const gain = context.gains[0];
		expect(gain.automations).toEqual([
			{ kind: 'cancel', value: 1, time: 2 },
			{ kind: 'set', value: 1, time: 2 },
			{ kind: 'ramp', value: 0.2, time: 2.12 },
		]);
	});

	it('clamps duck gain into range', () => {
		const playback = build();

		playback.duck(5, -10);

		expect(context.gains[0].gain.value).toBe(1);
		playback.duck(-3, 0);
		expect(context.gains[0].gain.value).toBe(0);
	});

	it('applies the user volume as the base gain', () => {
		const playback = build();

		playback.setVolume(0.4);

		expect(context.gains[0].gain.value).toBeCloseTo(0.4, 6);
	});

	it('ducks RELATIVE to the user volume, so a quiet session does not get louder', () => {
		const playback = build();
		playback.setVolume(0.5);

		playback.duck(0.2, 0);

		expect(context.gains[0].gain.value).toBeCloseTo(0.1, 6);
	});

	it('flush restores the user volume, not full output', async () => {
		// The other order of this bug is the one that matters: a flush that
		// restored gain to 1 would silently un-mute a muted session on the first
		// barge-in, and there is nothing on screen to explain the noise.
		const playback = build();
		playback.setVolume(0.3);
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		playback.duck(0, 30);

		playback.flush();

		expect(context.gains[0].gain.value).toBeCloseTo(0.3, 6);
	});

	it('clamps a nonsensical volume rather than passing it to the gain node', () => {
		const playback = build();

		playback.setVolume(Number.NaN);
		expect(context.gains[0].gain.value).toBe(1);

		playback.setVolume(9);
		expect(context.gains[0].gain.value).toBe(1);

		playback.setVolume(-1);
		expect(context.gains[0].gain.value).toBe(0);
	});

	it('keeps reporting the utterance while chunks may still be coming', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		statuses.length = 0;

		context.sources[0].finish();

		// Drained between sentences of a streaming run. Reporting idle here would
		// let the pipeline close a speech run that is still mid-utterance.
		expect(playbackStates().at(-1)).toEqual({
			kind: 'playback-state',
			playing: false,
			utteranceId: 'u1',
			queuedMs: 0,
		});
	});

	it('reports idle once the utterance is ended and drained', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		playback.endUtterance('u1');
		statuses.length = 0;

		context.sources[0].finish();

		expect(playbackStates().at(-1)).toEqual({
			kind: 'playback-state',
			playing: false,
			utteranceId: null,
			queuedMs: 0,
		});
	});

	it('closes out an utterance whose end marker arrives after it drained', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		context.sources[0].finish();
		statuses.length = 0;

		playback.endUtterance('u1');

		expect(playbackStates().at(-1)).toMatchObject({ playing: false, utteranceId: null });
	});

	it('ignores work queued after dispose', async () => {
		const playback = build();
		playback.dispose();

		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});

		expect(context.sources).toHaveLength(0);
		expect(context.gains[0].disconnectCount).toBe(1);
	});

	it('does not warn when stop() throws on a source that never started', async () => {
		const playback = build();
		await playback.enqueue({
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: pcmChunk(1600),
		});
		context.sources[0].stop = vi.fn(() => {
			throw new Error('InvalidStateError');
		});

		expect(() => playback.flush()).not.toThrow();
	});
});
