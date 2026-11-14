/**
 * @file browserDictation.test.ts
 *
 * Dictation on a browser's own microphone, with the capture graph faked and the
 * host mocked. Properties worth protecting:
 *
 *   - **Plain HTTP is named before a press**, because a browser has no
 *     microphone API outside a secure context.
 *   - **The task is checked before the microphone opens**, as on the host.
 *   - **The clip goes to the host as a WAV and comes back as its answer**, so
 *     the renderer state machine cannot tell the two transports apart.
 *   - **A cancel while the clip is with the host aborts it there.**
 *   - **A lost device keeps what was said** and still reaches `stop()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeWavPcm16, float32ToInt16, int16ToFloat32 } from '../../../shared/audio/pcm';
import type { AudioHostStatus } from '../../../shared/acappella/audio-host';
import {
	browserDictationBlocker,
	createBrowserDictation,
} from '../../../renderer/services/browserDictation';

/** The fake capture graph: records what the transport asked of it. */
class FakeMicCapture {
	static last: FakeMicCapture | null = null;
	readonly options: {
		onFrame: (frame: { pcm: ArrayBuffer }) => void;
		onStatus: (status: AudioHostStatus) => void;
	};
	start = vi.fn(async () => {
		this.options.onStatus({
			kind: 'capture-start',
			device: { deviceId: 'default', label: 'Phone microphone' },
			contextSampleRate: 48000,
		});
		return true;
	});
	stop = vi.fn();
	constructor(options: FakeMicCapture['options']) {
		this.options = options;
		FakeMicCapture.last = this;
	}
	frame(samples: number[]) {
		this.options.onFrame({ pcm: new Int16Array(samples).buffer });
	}
}

const loadCapture = async () => ({
	capture: {
		MicCapture: FakeMicCapture,
	} as unknown as typeof import('../../../renderer/acappella-audio/capture'),
	workletUrl: '/pcm-worklet.js',
});

const readiness = vi.mocked(window.maestro.localModels.taskReadiness);
const transcribe = vi.mocked(window.maestro.localModels.dictation.transcribe);
const hostCancel = vi.mocked(window.maestro.localModels.dictation.cancel);

const READY = {
	taskId: 'dictation',
	label: 'Dictation',
	needs: 'speech-to-text',
	assignment: { type: 'local', modelId: 'parakeet-tdt-0.6b-v2' },
	state: 'ready',
	detail: 'Runs Parakeet on this machine.',
} as never;

function secure(isSecure: boolean) {
	Object.defineProperty(window, 'isSecureContext', { configurable: true, value: isSecure });
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: isSecure ? { getUserMedia: vi.fn() } : undefined,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	FakeMicCapture.last = null;
	secure(true);
	vi.stubGlobal(
		'AudioContext',
		class {
			resume = vi.fn(async () => undefined);
		}
	);
	readiness.mockResolvedValue([READY]);
	transcribe.mockResolvedValue({ status: 'ok', text: 'Ship it.', audioMs: 700 });
	hostCancel.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('browserDictationBlocker', () => {
	it('names plain HTTP, where the browser has no microphone API', () => {
		secure(false);
		expect(browserDictationBlocker()).toMatch(/only over HTTPS/);
	});

	it('is null in a secure context', () => {
		expect(browserDictationBlocker()).toBeNull();
	});
});

describe('createBrowserDictation', () => {
	it('refuses over plain HTTP before asking the host anything', async () => {
		secure(false);
		const dictation = createBrowserDictation(loadCapture);
		await expect(dictation.start()).resolves.toMatchObject({
			started: false,
			code: 'unsupported',
		});
		expect(readiness).not.toHaveBeenCalled();
	});

	it('refuses a task that is off before the microphone opens', async () => {
		readiness.mockResolvedValue([
			{ ...(READY as object), state: 'off', detail: 'Dictation is off.' } as never,
		]);
		const dictation = createBrowserDictation(loadCapture);
		await expect(dictation.start()).resolves.toEqual({
			started: false,
			code: 'task-off',
			message: 'Dictation is off.',
		});
		expect(FakeMicCapture.last).toBeNull();
	});

	it('records, then sends the clip to the host as a WAV and returns its answer', async () => {
		const dictation = createBrowserDictation(loadCapture);
		await expect(dictation.start()).resolves.toEqual({ started: true });
		FakeMicCapture.last!.frame([0, 16384, -16384]);

		await expect(dictation.stop()).resolves.toEqual({
			status: 'ok',
			text: 'Ship it.',
			audioMs: 700,
		});
		expect(FakeMicCapture.last!.stop).toHaveBeenCalled();

		const request = transcribe.mock.calls[0][0];
		expect(request.audio).toMatch(/^data:audio\/wav;base64,/);
		const wav = decodeWavPcm16(
			Uint8Array.from(atob(request.audio.split(',')[1]), (c) => c.charCodeAt(0))
		);
		expect(wav.sampleRate).toBe(16000);
		// The clip is kept as float samples, so the WAV carries the int16 to float
		// to int16 round trip, which moves -16384 by its half LSB.
		expect(Array.from(wav.pcm)).toEqual(
			Array.from(float32ToInt16(int16ToFloat32(Int16Array.from([0, 16384, -16384]))))
		);
	});

	it('answers an empty clip itself, without a trip to the host', async () => {
		const dictation = createBrowserDictation(loadCapture);
		await dictation.start();
		await expect(dictation.stop()).resolves.toEqual({ status: 'ok', text: '', audioMs: 0 });
		expect(transcribe).not.toHaveBeenCalled();
	});

	it('answers idle for a stop with nothing recording', async () => {
		await expect(createBrowserDictation(loadCapture).stop()).resolves.toEqual({ status: 'idle' });
	});

	it('refuses a second start while one is recording', async () => {
		const dictation = createBrowserDictation(loadCapture);
		await dictation.start();
		await expect(dictation.start()).resolves.toMatchObject({ started: false, code: 'busy' });
	});

	it('keeps what was said when the device is lost, and says why', async () => {
		const dictation = createBrowserDictation(loadCapture);
		const interrupted = vi.fn();
		dictation.onInterrupted(interrupted);
		await dictation.start();
		FakeMicCapture.last!.frame([1, 2, 3]);
		FakeMicCapture.last!.options.onStatus({
			kind: 'mic-error',
			code: 'device-lost',
			message: 'The microphone was disconnected.',
		});
		expect(interrupted).toHaveBeenCalledWith({
			code: 'device-lost',
			message: 'The microphone was disconnected.',
		});

		await dictation.stop();
		expect(transcribe).toHaveBeenCalledWith(
			expect.objectContaining({
				interruption: { code: 'device-lost', message: 'The microphone was disconnected.' },
			})
		);
	});

	it('reaches the host to abort a clip it is already transcribing', async () => {
		let answer!: (value: never) => void;
		transcribe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const dictation = createBrowserDictation(loadCapture);
		await dictation.start();
		FakeMicCapture.last!.frame([5, 6]);
		const stopping = dictation.stop();
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());

		await dictation.cancel();
		expect(hostCancel).toHaveBeenCalledTimes(1);

		answer({ status: 'cancelled' } as never);
		await expect(stopping).resolves.toEqual({ status: 'cancelled' });
	});

	it('does not bother the host for a cancel with nothing sent', async () => {
		const dictation = createBrowserDictation(loadCapture);
		await dictation.start();
		await dictation.cancel();
		expect(hostCancel).not.toHaveBeenCalled();
		expect(FakeMicCapture.last!.stop).toHaveBeenCalled();
	});

	it('stands down a start cancelled while it checked readiness', async () => {
		let ready!: (value: never) => void;
		readiness.mockReturnValue(new Promise((resolve) => (ready = resolve)));
		const dictation = createBrowserDictation(loadCapture);
		const starting = dictation.start();
		await dictation.cancel();
		ready([READY] as never);
		await expect(starting).resolves.toMatchObject({ started: false, code: 'cancelled' });
		expect(FakeMicCapture.last).toBeNull();
	});
});
