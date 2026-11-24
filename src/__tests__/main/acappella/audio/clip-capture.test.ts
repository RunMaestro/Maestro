/**
 * @file clip-capture.test.ts
 *
 * The audio host's microphone in its session-less mode. The class takes no
 * session service at all, so "starts no voice session and never opens the
 * floor" is true by construction; what these pin is everything it does with
 * the capture path it borrows:
 *
 *   - **Recording is only announced once audio is really flowing.**
 *   - **Every way the microphone can fail to open is a classified refusal.**
 *   - **The wake word is told before the microphone opens and after it is
 *     given back**, and reads `isActive` correctly at both moments.
 *   - **Only a microphone this clip opened is closed.**
 *   - **A recording that ends on its own keeps its audio** and says why.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ClipCapture, type ClipCaptureDeps } from '../../../../main/acappella/audio/clip-capture';
import type { DictationInterruption } from '../../../../shared/local-models/dictation';

const DEVICE = { deviceId: 'mic-1', label: 'Built-in Microphone' };
const CAPTURE_START = {
	kind: 'capture-start',
	device: DEVICE,
	contextSampleRate: 48000,
} as const;

/**
 * A capture over mocked dependencies. Every dependency is a spy, wrapping the
 * override when a test supplies one.
 */
function harness(overrides: Partial<ClipCaptureDeps> = {}) {
	/** `isActive` as the wake word saw it at each notification. */
	const activeAtChange: boolean[] = [];
	const deps = {
		refusal: vi.fn(overrides.refusal ?? (() => null)),
		onActiveChange: vi.fn(
			overrides.onActiveChange ??
				(async () => {
					activeAtChange.push(capture.isActive);
				})
		),
		requestMicPermission: vi.fn(
			overrides.requestMicPermission ??
				(async () => ({ state: 'granted' as const, settingsLabel: 'System Settings' }))
		),
		ensureAudioHost: vi.fn(overrides.ensureAudioHost ?? (() => true)),
		startCapture: vi.fn(overrides.startCapture ?? (() => {})),
		stopCapture: vi.fn(overrides.stopCapture ?? (() => {})),
	};
	const capture: ClipCapture = new ClipCapture({
		...deps,
		maxClipMs: overrides.maxClipMs,
		startTimeoutMs: overrides.startTimeoutMs,
	});
	return { capture, deps, activeAtChange };
}

/** Start a clip and answer the host's capture announcement. */
async function record(h: ReturnType<typeof harness>) {
	// Counted from here: an announcement that arrives before THIS clip asked for
	// the microphone is not its answer, and the capture rightly ignores it.
	const asked = h.deps.startCapture.mock.calls.length;
	const starting = h.capture.start();
	await vi.waitFor(() => expect(h.deps.startCapture.mock.calls.length).toBeGreaterThan(asked));
	h.capture.handleStatus(CAPTURE_START);
	await expect(starting).resolves.toEqual({ started: true });
}

/** `count` 20 ms frames of a constant sample value. */
function frames(count: number, value = 8192): Int16Array[] {
	return Array.from({ length: count }, () => new Int16Array(320).fill(value));
}

afterEach(() => {
	vi.useRealTimers();
});

describe('ClipCapture', () => {
	it('announces recording only after the host says capture started', async () => {
		const h = harness();
		let settled = false;
		const starting = h.capture.start().then((result) => {
			settled = true;
			return result;
		});

		await vi.waitFor(() => expect(h.deps.startCapture).toHaveBeenCalledTimes(1));
		expect(settled).toBe(false);
		expect(h.capture.isActive).toBe(true);

		h.capture.handleStatus(CAPTURE_START);
		await expect(starting).resolves.toEqual({ started: true });
	});

	it('tells the wake word before the microphone opens, while it reads as active', async () => {
		const h = harness();
		const order: string[] = [];
		h.deps.onActiveChange.mockImplementation(async () => {
			order.push(`wake:${h.capture.isActive}`);
		});
		h.deps.startCapture.mockImplementation(() => {
			order.push('open');
		});

		await record(h);
		expect(order).toEqual(['wake:true', 'open']);
	});

	it('returns what was said as one normalised 16 kHz clip', async () => {
		const h = harness();
		await record(h);
		for (const frame of frames(50)) h.capture.pushFrame(frame);

		const clip = await h.capture.stop();

		expect(clip.sampleRate).toBe(16000);
		expect(clip.audio).toHaveLength(50 * 320);
		expect(clip.audio[0]).toBeCloseTo(0.25);
		expect(clip.interruption).toBeUndefined();
	});

	it('copies each frame, so a reused IPC buffer cannot rewrite the clip', async () => {
		const h = harness();
		await record(h);
		const frame = new Int16Array(320).fill(16384);
		h.capture.pushFrame(frame);
		frame.fill(0);

		const clip = await h.capture.stop();
		expect(clip.audio[0]).toBeCloseTo(0.5);
	});

	it('gives the microphone back and tells the wake word it is free', async () => {
		const h = harness();
		await record(h);
		await h.capture.stop();

		expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);
		expect(h.capture.isActive).toBe(false);
		// Told on the way in (active) and on the way out (free).
		expect(h.activeAtChange).toEqual([true, false]);
	});

	it('ignores frames when no clip is recording', async () => {
		const h = harness();
		for (const frame of frames(5)) h.capture.pushFrame(frame);
		await record(h);
		const clip = await h.capture.stop();
		expect(clip.audio).toHaveLength(0);
	});

	it('refuses while the microphone is spoken for, and borrows nothing', async () => {
		const h = harness({
			refusal: () => ({
				code: 'voice-session-active',
				message: 'A voice session is using the microphone.',
			}),
		});

		await expect(h.capture.start()).resolves.toEqual({
			started: false,
			code: 'voice-session-active',
			message: 'A voice session is using the microphone.',
		});
		expect(h.deps.onActiveChange).not.toHaveBeenCalled();
		expect(h.deps.requestMicPermission).not.toHaveBeenCalled();
		expect(h.deps.startCapture).not.toHaveBeenCalled();
		expect(h.capture.isActive).toBe(false);
	});

	it('refuses a second clip while one is recording', async () => {
		const h = harness();
		await record(h);
		await expect(h.capture.start()).resolves.toMatchObject({ started: false, code: 'busy' });
	});

	it('refuses a denied microphone by name, without opening or closing a device', async () => {
		const h = harness({
			requestMicPermission: async () => ({
				state: 'denied',
				settingsLabel: 'System Settings > Privacy & Security > Microphone',
			}),
		});

		await expect(h.capture.start()).resolves.toEqual({
			started: false,
			code: 'permission-denied',
			message:
				'Maestro does not have access to the microphone. Allow it in System Settings > Privacy & Security > Microphone.',
		});
		expect(h.deps.ensureAudioHost).not.toHaveBeenCalled();
		expect(h.deps.startCapture).not.toHaveBeenCalled();
		// Nothing of this clip's was opened, so nothing is closed.
		expect(h.deps.stopCapture).not.toHaveBeenCalled();
		expect(h.activeAtChange).toEqual([true, false]);
	});

	it('refuses when there is no audio host to capture through', async () => {
		const h = harness({ ensureAudioHost: () => false });
		await expect(h.capture.start()).resolves.toMatchObject({
			started: false,
			code: 'no-microphone',
		});
		expect(h.deps.startCapture).not.toHaveBeenCalled();
	});

	it('reports the host’s own classification when the microphone will not open', async () => {
		const h = harness();
		const starting = h.capture.start();
		await vi.waitFor(() => expect(h.deps.startCapture).toHaveBeenCalled());

		h.capture.handleStatus({
			kind: 'mic-error',
			code: 'no-device',
			message: 'No microphone found.',
		});

		await expect(starting).resolves.toEqual({
			started: false,
			code: 'no-device',
			message: 'No microphone found.',
		});
		expect(h.capture.isActive).toBe(false);
	});

	it('gives up on a microphone that never opens', async () => {
		vi.useFakeTimers();
		const h = harness({ startTimeoutMs: 1000 });
		const starting = h.capture.start();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(starting).resolves.toMatchObject({ started: false, code: 'timeout' });
		expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);
		expect(h.capture.isActive).toBe(false);
	});

	it('asks again when the host finishes booting after the first request', async () => {
		const h = harness();
		const starting = h.capture.start();
		await vi.waitFor(() => expect(h.deps.startCapture).toHaveBeenCalledTimes(1));

		// The first command reached a window that was still loading and vanished.
		h.capture.handleStatus({ kind: 'ready' });
		expect(h.deps.startCapture).toHaveBeenCalledTimes(2);

		h.capture.handleStatus(CAPTURE_START);
		await expect(starting).resolves.toEqual({ started: true });
	});

	it('a stop before the microphone opened cancels the start and records nothing', async () => {
		const h = harness();
		const starting = h.capture.start();
		await vi.waitFor(() => expect(h.deps.startCapture).toHaveBeenCalled());

		const clip = await h.capture.stop();

		expect(clip.audio).toHaveLength(0);
		await expect(starting).resolves.toMatchObject({ started: false, code: 'cancelled' });
		expect(h.capture.isActive).toBe(false);
	});

	it('a cancel during the permission ask never opens the microphone', async () => {
		let answer!: (value: { state: 'granted'; settingsLabel: string }) => void;
		const h = harness({
			requestMicPermission: () =>
				new Promise<{ state: 'granted'; settingsLabel: string }>((resolve) => {
					answer = resolve;
				}),
		});
		const starting = h.capture.start();
		await vi.waitFor(() => expect(h.deps.requestMicPermission).toHaveBeenCalled());

		await h.capture.cancel();
		answer({ state: 'granted', settingsLabel: 'System Settings' });

		await expect(starting).resolves.toMatchObject({ started: false, code: 'cancelled' });
		expect(h.deps.startCapture).not.toHaveBeenCalled();
		expect(h.capture.isActive).toBe(false);
	});

	it('cancel discards the audio and gives the microphone back', async () => {
		const h = harness();
		await record(h);
		for (const frame of frames(10)) h.capture.pushFrame(frame);

		await h.capture.cancel();
		expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);

		// The next clip starts empty.
		await record(h);
		expect((await h.capture.stop()).audio).toHaveLength(0);
	});

	it('reopens the microphone when something else closed it mid-clip', async () => {
		const h = harness();
		await record(h);
		expect(h.deps.startCapture).toHaveBeenCalledTimes(1);

		// A voice session that started during the clip ended and closed the device.
		h.capture.handleStatus({ kind: 'capture-stop', reason: 'requested' });

		expect(h.deps.startCapture).toHaveBeenCalledTimes(2);
		expect(h.capture.isActive).toBe(true);
	});

	it('ends itself at the length cap, keeps the audio, and says why', async () => {
		// Half a second: 25 frames.
		const h = harness({ maxClipMs: 500 });
		const interruptions: DictationInterruption[] = [];
		h.capture.onInterrupted((interruption) => interruptions.push(interruption));
		await record(h);

		for (const frame of frames(40)) h.capture.pushFrame(frame);

		expect(interruptions).toHaveLength(1);
		expect(interruptions[0].code).toBe('max-duration');
		// The microphone goes back at once, not when the owner stops.
		expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);

		const clip = await h.capture.stop();
		expect(clip.audio).toHaveLength(25 * 320);
		expect(clip.interruption?.code).toBe('max-duration');
		// Already closed when it ended: stopping must not close it a second time.
		expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);
	});

	it('a microphone lost mid-clip keeps what was said and reports the loss', async () => {
		const h = harness();
		const interruptions: DictationInterruption[] = [];
		h.capture.onInterrupted((interruption) => interruptions.push(interruption));
		await record(h);
		for (const frame of frames(10)) h.capture.pushFrame(frame);

		h.capture.handleStatus({
			kind: 'mic-error',
			code: 'device-lost',
			message: 'The microphone was unplugged.',
		});
		// The host reports the stop as well; one loss is one interruption.
		h.capture.handleStatus({ kind: 'capture-stop', reason: 'device-lost' });

		expect(interruptions).toEqual([
			{ code: 'device-lost', message: 'The microphone was unplugged.' },
		]);
		const clip = await h.capture.stop();
		expect(clip.audio).toHaveLength(10 * 320);
		expect(clip.interruption?.code).toBe('device-lost');
	});

	it('ignores host statuses when no clip is recording', () => {
		const h = harness();
		h.capture.handleStatus({ kind: 'ready' });
		h.capture.handleStatus(CAPTURE_START);
		expect(h.deps.startCapture).not.toHaveBeenCalled();
		expect(h.capture.isActive).toBe(false);
	});
});
