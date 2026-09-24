/**
 * @file capture.test.ts
 *
 * Microphone capture for the A Cappella audio host.
 *
 * The behaviour worth defending is that no failure is silent. A user whose
 * microphone permission was denied, whose device vanished, or whose worklet
 * failed to load must get a classified `mic-error` - not a session that sits in
 * "listening" forever producing nothing. Every failure path here asserts on the
 * status that reaches the bridge, not just on the absence of a throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeAudioContext,
	installAudioWorkletNodeMock,
	installMediaDevicesMock,
	type FakeAudioContext,
	type FakeAudioWorkletNode,
	type MediaDevicesMock,
} from '../../helpers/mockWebAudio';
import {
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	ACAPPELLA_PCM_WORKLET_NAME,
	type AudioFrame,
	type AudioHostStatus,
} from '../../../shared/acappella/audio-host';
import { classifyCaptureError, MicCapture } from '../../../renderer/acappella-audio/capture';

const WORKLET_URL = '/assets/pcm-worklet.js';

describe('classifyCaptureError', () => {
	it.each([
		['NotAllowedError', 'permission-denied'],
		['SecurityError', 'permission-denied'],
		['NotFoundError', 'no-device'],
		['OverconstrainedError', 'no-device'],
		['NotReadableError', 'device-lost'],
		['AbortError', 'device-lost'],
		['TypeError', 'audio-init-failed'],
	])('maps %s to %s', (name, expected) => {
		const error = new Error('boom');
		error.name = name;
		expect(classifyCaptureError(error)).toBe(expected);
	});

	it('treats a non-Error rejection as an init failure rather than crashing', () => {
		expect(classifyCaptureError('something odd')).toBe('audio-init-failed');
	});
});

describe('MicCapture', () => {
	let context: FakeAudioContext;
	let media: MediaDevicesMock;
	let worklet: { nodes: FakeAudioWorkletNode[]; restore(): void };
	let frames: AudioFrame[];
	let statuses: AudioHostStatus[];

	const build = (ctx: FakeAudioContext = context) =>
		new MicCapture({
			context: ctx as unknown as AudioContext,
			workletUrl: WORKLET_URL,
			onFrame: (frame) => frames.push(frame),
			onStatus: (status) => statuses.push(status),
		});

	beforeEach(() => {
		context = createFakeAudioContext();
		media = installMediaDevicesMock();
		worklet = installAudioWorkletNodeMock();
		frames = [];
		statuses = [];
	});

	afterEach(() => {
		media.restore();
		worklet.restore();
		vi.restoreAllMocks();
	});

	it('opens the mic with echo cancellation, noise suppression, and auto gain', async () => {
		const capture = build();

		await expect(capture.start()).resolves.toBe(true);

		expect(media.getUserMedia).toHaveBeenCalledWith({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
			video: false,
		});
		expect(statuses).toContainEqual({
			kind: 'capture-start',
			device: { deviceId: 'default', label: 'MacBook Pro Microphone' },
			contextSampleRate: 48000,
		});
	});

	it('builds the graph into a muted sink so the mic is never routed to the speakers', async () => {
		const capture = build();
		await capture.start();

		const node = worklet.nodes[0];
		expect(node.name).toBe(ACAPPELLA_PCM_WORKLET_NAME);
		expect(context.addedModules).toEqual([WORKLET_URL]);

		// The terminating gain node exists only to keep the graph pulled; audible
		// gain here would be direct microphone feedback.
		const sink = context.gains[0];
		expect(sink.gain.value).toBe(0);
		expect(node.connectedTo).toContain(sink);
		expect(sink.connectedTo).toContain(context.destination);
	});

	it('resumes a suspended context, which a hidden window never gets a gesture for', async () => {
		const suspended = createFakeAudioContext({ state: 'suspended' });
		const capture = build(suspended);

		await capture.start();

		expect(suspended.resume).toHaveBeenCalled();
	});

	it('stamps frames from the audio clock rather than from wall time per frame', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
		context.currentTime = 4;
		const capture = build();
		await capture.start();

		const pcm = new Int16Array([1, 2, 3]).buffer;
		worklet.nodes[0].emit({ pcm, rms: 0.4, t: 4.5 });
		worklet.nodes[0].emit({ pcm, rms: 0.6, t: 4.52 });

		// Context time 0 was 4 seconds before "now", so t=4.5 is 500 ms after now.
		expect(frames).toEqual([
			{ seq: 1, capturedAt: 1_000_500, rms: 0.4, pcm },
			{ seq: 2, capturedAt: 1_000_520, rms: 0.6, pcm },
		]);
	});

	it('reports a denied permission instead of stalling', async () => {
		media.failWith('NotAllowedError', 'Permission dismissed');
		const capture = build();

		await expect(capture.start()).resolves.toBe(false);

		expect(statuses).toEqual([
			{ kind: 'mic-error', code: 'permission-denied', message: 'Permission dismissed' },
		]);
		expect(capture.active).toBe(false);
	});

	it('reports a missing device instead of stalling', async () => {
		media.failWith('NotFoundError', 'No audio input');
		const capture = build();

		await expect(capture.start()).resolves.toBe(false);

		expect(statuses).toEqual([{ kind: 'mic-error', code: 'no-device', message: 'No audio input' }]);
	});

	it('releases the stream and reports when the worklet module fails to load', async () => {
		const broken = createFakeAudioContext({ addModuleError: new Error('bad chunk') });
		const capture = build(broken);

		await expect(capture.start()).resolves.toBe(false);

		// The mic was already open when the worklet failed; leaving it open would
		// light the OS recording indicator with nothing listening.
		expect(media.stream.track.stop).toHaveBeenCalled();
		expect(statuses).toEqual([
			{ kind: 'mic-error', code: 'audio-init-failed', message: 'bad chunk' },
		]);
	});

	it('reports a device disappearing mid-capture as recoverable and stops cleanly', async () => {
		const capture = build();
		await capture.start();
		statuses.length = 0;

		media.stream.track.end();

		expect(statuses).toEqual([
			{ kind: 'mic-error', code: 'device-lost', message: 'The microphone was disconnected.' },
			{ kind: 'capture-stop', reason: 'device-lost' },
		]);
		expect(capture.active).toBe(false);
	});

	it('reports device changes so the UI can name the microphone in use', async () => {
		const capture = build();

		media.emitDeviceChange();

		expect(statuses).toEqual([{ kind: 'device-change' }]);
		capture.dispose();
	});

	it('is idempotent: a second start reuses the open device and adds the module once', async () => {
		const capture = build();

		const [first, second] = await Promise.all([capture.start(), capture.start()]);

		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(media.getUserMedia).toHaveBeenCalledTimes(1);
		expect(context.addedModules).toHaveLength(1);
	});

	it('releases the microphone and tears down the graph on stop', async () => {
		const capture = build();
		await capture.start();
		const node = worklet.nodes[0];

		capture.stop();

		expect(media.stream.track.stop).toHaveBeenCalled();
		expect(node.disconnectCount).toBe(1);
		expect(node.port.onmessage).toBeNull();
		expect(capture.active).toBe(false);
		expect(statuses).toContainEqual({ kind: 'capture-stop', reason: 'requested' });
	});

	it('does not emit a stop status when it was never capturing', () => {
		const capture = build();

		capture.stop();

		expect(statuses).toEqual([]);
	});

	it('drops a device that arrived after dispose rather than leaking it', async () => {
		const capture = build();
		const pending = capture.start();
		capture.dispose();

		await expect(pending).resolves.toBe(false);
		expect(media.stream.track.stop).toHaveBeenCalled();
		expect(media.listenerCount()).toBe(0);
	});

	it('restarts after a stop, and frame numbering restarts with it', async () => {
		const capture = build();
		await capture.start();
		worklet.nodes[0].emit({ pcm: new ArrayBuffer(2), rms: 0.1, t: 0 });
		capture.stop();

		await capture.start();
		worklet.nodes[1].emit({ pcm: new ArrayBuffer(2), rms: 0.1, t: 0 });

		// Sequence numbers are per capture run: main counts gaps to detect drops,
		// so continuing the old numbering across a restart would read as a gap.
		expect(frames.map((frame) => frame.seq)).toEqual([1, 1]);
	});

	it('reports unsupported when the build has no getUserMedia at all', async () => {
		media.restore();
		Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
		const capture = build();

		await expect(capture.start()).resolves.toBe(false);

		expect(statuses[0]).toMatchObject({ kind: 'mic-error', code: 'unsupported' });
	});

	it('asks the worklet for 20 ms frames at the STT sample rate', async () => {
		const capture = build();
		await capture.start();

		expect(worklet.nodes[0].options).toMatchObject({
			numberOfInputs: 1,
			outputChannelCount: [1],
			processorOptions: { targetSampleRate: ACAPPELLA_AUDIO_SAMPLE_RATE, frameSamples: 320 },
		});
	});
});
