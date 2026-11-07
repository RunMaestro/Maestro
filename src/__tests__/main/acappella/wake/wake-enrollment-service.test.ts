/**
 * @file wake-enrollment-service.test.ts
 *
 * The flow that records a wake phrase and trains it: who may have the
 * microphone, what counts as a take, when a capture run ends, and what every
 * client is told. The front end is faked; the store is real, on a temp
 * directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import {
	WakeEnrollmentService,
	registerWakeEnrollmentService,
	runWakeEnrollmentRequest,
	type WakeEnrollmentDeps,
} from '../../../../main/acappella/wake/wake-enrollment-service';
import {
	addWakeBackground,
	addWakeClip,
	hasEnrolledWakeModel,
	loadEnrolledWakeModel,
	readWakeClips,
	setWakeEnrollmentRoot,
} from '../../../../main/acappella/wake/wake-enrollment-store';
import {
	WAKE_ENROLLMENT_BACKGROUND_TARGET_MS,
	WAKE_ENROLLMENT_MAX_CLIPS,
	WAKE_ENROLLMENT_MIN_CLIPS,
	type WakeEnrollmentEvent,
	type WakeEnrollmentStatus,
} from '../../../../shared/acappella/wake-enrollment';
import { encodeWav, float32ToInt16 } from '../../../../shared/audio/pcm';
import {
	TONES,
	fakeWakeFeaturizer,
	melody,
	otherSpeech,
	phraseClip,
	toFrames,
} from '../../../helpers/wakeTrainingFixtures';

const PHRASE = 'hey scout';

function harness(overrides: Partial<WakeEnrollmentDeps> = {}) {
	const events: WakeEnrollmentEvent[] = [];
	let clock = 1_000_000;
	const featurizer = fakeWakeFeaturizer();
	const spies = {
		openMicrophone: vi.fn(async () => undefined),
		closeMicrophone: vi.fn(async () => undefined),
		onModelChanged: vi.fn(),
		createFeaturizer: vi.fn(async () => featurizer),
	};
	const deps = {
		emit: (event: WakeEnrollmentEvent) => events.push(event),
		microphoneBusyReason: (): string | null => null,
		...spies,
		now: () => clock,
	};
	const service = new WakeEnrollmentService({ ...deps, ...overrides });
	/** Feed audio as the audio host would: 20 ms frames, 20 ms apart. */
	const hear = (audio: Float32Array) => {
		for (const frame of toFrames(audio)) {
			clock += 20;
			service.pushFrame(frame);
		}
	};
	/**
	 * The same, pausing every half second of audio so disk reads can land, the
	 * way they do between real frames. For tests about what is reported DURING a run.
	 */
	const hearLive = async (audio: Float32Array) => {
		const frames = toFrames(audio);
		for (let i = 0; i < frames.length; i++) {
			clock += 20;
			service.pushFrame(frames[i]);
			if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 4));
		}
	};
	const statuses = () => events.flatMap((event) => (event.type === 'status' ? [event.status] : []));
	const lastStatus = (): WakeEnrollmentStatus | undefined => statuses().at(-1);
	return { service, deps, events, featurizer, hear, hearLive, statuses, lastStatus };
}

/** One take, with enough quiet after it for the endpoint to land. */
const take = () =>
	melody([
		{ hz: 0, ms: 400 },
		{ hz: TONES.mid, ms: 320 },
		{ hz: TONES.top, ms: 320 },
		{ hz: 0, ms: 900 },
	]);

async function seed(clips: number, backgroundSeconds: number): Promise<void> {
	for (let i = 0; i < clips; i++) {
		await addWakeClip(
			PHRASE,
			float32ToInt16(
				phraseClip({ amplitude: 0.22 + (i % 4) * 0.04, stretch: 0.94 + (i % 3) * 0.06 })
			)
		);
	}
	if (backgroundSeconds > 0) {
		await addWakeBackground(PHRASE, float32ToInt16(otherSpeech(backgroundSeconds)));
	}
}

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-enrollment-service-'));
	setWakeEnrollmentRoot(root);
});

afterEach(async () => {
	setWakeEnrollmentRoot(null);
	await fs.rm(root, { recursive: true, force: true });
});

describe('recording the phrase', () => {
	it('opens the microphone and keeps every burst of speech as a take', async () => {
		const { service, deps, hear, lastStatus } = harness();

		const started = await service.startRecording(PHRASE, 'phrase');
		expect(started).toMatchObject({ ok: true, status: { recording: 'phrase', clips: 0 } });
		expect(deps.openMicrophone).toHaveBeenCalledTimes(1);
		expect(service.isRecording).toBe(true);

		hear(take());
		hear(take());
		const stopped = await service.stopRecording();

		expect(stopped).toMatchObject({ clips: 2, recording: null });
		expect(await readWakeClips(PHRASE)).toHaveLength(2);
		expect(deps.closeMicrophone).toHaveBeenCalledTimes(1);
		expect(service.isRecording).toBe(false);
		expect(lastStatus()).toMatchObject({ clips: 2, recording: null });
	});

	it('does not keep a click, or a sentence, and says why', async () => {
		const { service, events, hear } = harness();
		await service.startRecording(PHRASE, 'phrase');

		// 120 ms: a click.
		hear(
			melody([
				{ hz: 0, ms: 400 },
				{ hz: TONES.mid, ms: 120 },
				{ hz: 0, ms: 900 },
			])
		);
		// Five seconds without a pause: a sentence.
		hear(
			melody([
				{ hz: 0, ms: 400 },
				{ hz: TONES.mid, ms: 5000 },
				{ hz: 0, ms: 900 },
			])
		);
		await service.stopRecording();

		const rejections = events.flatMap((event) =>
			event.type === 'clip-rejected' ? [event.reason] : []
		);
		expect(rejections).toEqual(['too-short', 'too-long']);
		expect(await readWakeClips(PHRASE)).toHaveLength(0);
	});

	it('reports the microphone level, throttled', async () => {
		const { service, events, hear } = harness();
		await service.startRecording(PHRASE, 'phrase');

		hear(take());
		await service.stopRecording();

		const levels = events.flatMap((event) => (event.type === 'level' ? [event.level] : []));
		// 1.94 s of audio at one reading per 100 ms.
		expect(levels.length).toBeGreaterThan(10);
		expect(levels.length).toBeLessThan(25);
		expect(Math.max(...levels)).toBeGreaterThan(0.1);
	});

	it('refuses, without touching the microphone, when something else has it', async () => {
		const { service, deps } = harness({
			microphoneBusyReason: () => 'End the voice session first, then record the phrase.',
		});

		expect(await service.startRecording(PHRASE, 'phrase')).toEqual({
			ok: false,
			reason: 'End the voice session first, then record the phrase.',
		});
		expect(deps.openMicrophone).not.toHaveBeenCalled();
		expect(service.isRecording).toBe(false);
	});

	it('refuses a phrase with nothing sayable in it', async () => {
		const { service, deps } = harness();

		expect(await service.startRecording(' ... ', 'phrase')).toMatchObject({ ok: false });
		expect(deps.openMicrophone).not.toHaveBeenCalled();
	});

	it('refuses more takes than a phrase keeps', async () => {
		const { service } = harness();
		await seed(WAKE_ENROLLMENT_MAX_CLIPS, 0);

		const result = await service.startRecording(PHRASE, 'phrase');
		expect(result).toMatchObject({ ok: false });
		expect((result as { reason: string }).reason).toMatch(/at most/);
	});

	it('closes the microphone on its own after a long silence', async () => {
		vi.useFakeTimers();
		try {
			let clock = 0;
			const { service, deps } = harness({ now: () => clock });
			await service.startRecording(PHRASE, 'phrase');

			clock += 46_000;
			await vi.advanceTimersByTimeAsync(1100);

			expect(service.isRecording).toBe(false);
			expect(deps.closeMicrophone).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('removes the newest take', async () => {
		const { service } = harness();
		await seed(3, 0);

		expect(await service.removeLastClip(PHRASE)).toMatchObject({ clips: 2 });
	});
});

describe('recording other speech', () => {
	it('keeps the run whole and stops itself at the target', async () => {
		const { service, deps, hearLive, statuses, lastStatus } = harness();
		await service.startRecording(PHRASE, 'background');

		await hearLive(otherSpeech(WAKE_ENROLLMENT_BACKGROUND_TARGET_MS / 1000 + 2));
		// The run ends itself; the recording lands on disk a moment later.
		await vi.waitFor(() => expect(lastStatus()).toMatchObject({ recording: null }));
		expect(service.isRecording).toBe(false);

		const status = await service.status(PHRASE);
		expect(status.backgroundMs).toBe(WAKE_ENROLLMENT_BACKGROUND_TARGET_MS);
		expect(status.recording).toBeNull();
		expect(deps.closeMicrophone).toHaveBeenCalledTimes(1);
		// Progress was visible on the way, not only at the end.
		const during = statuses().filter((entry) => entry.recording === 'background');
		expect(during.length).toBeGreaterThan(10);
		expect(during.at(-1)!.backgroundMs).toBeGreaterThan(during[1].backgroundMs);
	});

	it('keeps a run stopped early and discards a mis-click', async () => {
		const { service, hear } = harness();

		await service.startRecording(PHRASE, 'background');
		hear(otherSpeech(4));
		expect(await service.stopRecording()).toMatchObject({ backgroundMs: 4000 });

		await service.startRecording(PHRASE, 'background');
		hear(otherSpeech(0.5));
		expect(await service.stopRecording()).toMatchObject({ backgroundMs: 4000 });
	});

	it('can start over, including a run still in progress', async () => {
		const { service, hear } = harness();
		await seed(0, 5);
		await service.startRecording(PHRASE, 'background');
		hear(otherSpeech(3));

		expect(await service.clearBackground(PHRASE)).toMatchObject({
			backgroundMs: 0,
			recording: null,
		});
	});

	it('switches runs rather than recording two at once', async () => {
		const { service, deps, hear } = harness();
		await service.startRecording(PHRASE, 'phrase');
		hear(take());

		expect(await service.startRecording(PHRASE, 'background')).toMatchObject({
			ok: true,
			status: { recording: 'background', clips: 1 },
		});
		expect(deps.closeMicrophone).toHaveBeenCalledTimes(1);
		expect(deps.openMicrophone).toHaveBeenCalledTimes(2);
		await service.stopRecording();
	});
});

describe('training', () => {
	it('builds and saves a model, reports progress, and says the model changed', async () => {
		const { service, deps, events, featurizer } = harness();
		await seed(WAKE_ENROLLMENT_MIN_CLIPS + 2, 14);

		const result = await service.train(PHRASE);

		expect(result).toMatchObject({
			ok: true,
			status: { training: false, model: { report: { clipsTotal: 10, quality: 'strong' } } },
		});
		expect(hasEnrolledWakeModel(PHRASE)).toBe(true);
		expect((await loadEnrolledWakeModel(PHRASE))?.report.clipsUsed).toBe(10);
		expect(deps.onModelChanged).toHaveBeenCalledWith(PHRASE);
		expect(featurizer.released).toBe(true);

		const phases = events.flatMap((event) => (event.type === 'training' ? [event.phase] : []));
		expect(phases[0]).toBe('listening');
		expect(phases).toContain('comparing');
		expect(phases.at(-1)).toBe('saving');
		// Clients saw it start and saw it finish.
		const training = events.flatMap((event) =>
			event.type === 'status' ? [event.status.training] : []
		);
		expect(training[0]).toBe(true);
		expect(training.at(-1)).toBe(false);
	});

	it('refuses until there is enough to train from, and loads nothing to say so', async () => {
		const { service, deps } = harness();
		await seed(WAKE_ENROLLMENT_MIN_CLIPS - 1, 14);

		const result = await service.train(PHRASE);
		expect(result).toMatchObject({ ok: false });
		expect((result as { reason: string }).reason).toMatch(/at least 8 recordings/);
		expect(deps.createFeaturizer).not.toHaveBeenCalled();
	});

	it('says where to get the wake word model when it is not installed', async () => {
		const { service } = harness({ createFeaturizer: async () => null });
		await seed(WAKE_ENROLLMENT_MIN_CLIPS, 14);

		const result = await service.train(PHRASE);
		expect(result).toMatchObject({ ok: false });
		expect((result as { reason: string }).reason).toBe(
			'The wake word model is not installed. Download it in Settings > Models > Library > Speech.'
		);
	});

	it('reports recordings it cannot learn from and leaves nothing half trained', async () => {
		const { service, deps, events, featurizer } = harness();
		for (let i = 0; i < WAKE_ENROLLMENT_MIN_CLIPS; i++) {
			await addWakeClip(PHRASE, new Int16Array(16000));
		}
		await addWakeBackground(PHRASE, float32ToInt16(otherSpeech(14)));

		const result = await service.train(PHRASE);

		expect(result).toMatchObject({ ok: false });
		expect(events.some((event) => event.type === 'error')).toBe(true);
		expect(hasEnrolledWakeModel(PHRASE)).toBe(false);
		expect(deps.onModelChanged).not.toHaveBeenCalled();
		expect(featurizer.released).toBe(true);
		expect((await service.status(PHRASE)).training).toBe(false);
	});

	it('will not record while it trains', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const featurizer = fakeWakeFeaturizer();
		const { service } = harness({
			createFeaturizer: async () => ({
				...featurizer,
				featurize: async (audio) => {
					await gate;
					return featurizer.featurize(audio);
				},
			}),
		});
		await seed(WAKE_ENROLLMENT_MIN_CLIPS, 14);

		const training = service.train(PHRASE);
		await vi.waitFor(async () => expect((await service.status(PHRASE)).training).toBe(true));
		expect(await service.startRecording(PHRASE, 'phrase')).toEqual({
			ok: false,
			reason: 'Wait for training to finish.',
		});
		expect(await service.train(PHRASE)).toMatchObject({ ok: false });

		release();
		expect(await training).toMatchObject({ ok: true });
	});
});

describe('forgetting a phrase', () => {
	it('deletes the recordings and the model, and says the model changed', async () => {
		const { service, deps } = harness();
		await seed(WAKE_ENROLLMENT_MIN_CLIPS, 14);
		await service.train(PHRASE);
		deps.onModelChanged.mockClear();

		expect(await service.remove(PHRASE)).toMatchObject({ clips: 0, backgroundMs: 0, model: null });
		expect(hasEnrolledWakeModel(PHRASE)).toBe(false);
		expect(deps.onModelChanged).toHaveBeenCalledWith(PHRASE);
	});

	it('ends a run on the phrase first, and closes the microphone', async () => {
		const { service, deps, hear } = harness();
		await service.startRecording(PHRASE, 'phrase');
		hear(take());

		await service.remove(PHRASE);

		expect(service.isRecording).toBe(false);
		expect(deps.closeMicrophone).toHaveBeenCalledTimes(1);
		expect(await readWakeClips(PHRASE)).toHaveLength(0);
	});
});

describe('recordings from files', () => {
	async function wav(name: string, audio: Float32Array, sampleRate = 16000): Promise<string> {
		const file = path.join(root, name);
		await fs.writeFile(file, encodeWav(float32ToInt16(audio), sampleRate));
		return file;
	}

	it('keeps a WAV file as a take, for a caller with no microphone', async () => {
		const { service, deps, lastStatus } = harness();

		const result = await service.importRecording(
			PHRASE,
			'phrase',
			await wav('take.wav', phraseClip())
		);

		expect(result).toMatchObject({ ok: true, status: { clips: 1 } });
		expect(await readWakeClips(PHRASE)).toHaveLength(1);
		expect(lastStatus()).toMatchObject({ clips: 1 });
		// No microphone was involved.
		expect(deps.openMicrophone).not.toHaveBeenCalled();
	});

	it('brings a file at another sample rate to 16 kHz', async () => {
		const { service } = harness();
		// One second at 48 kHz.
		const file = await wav('wide.wav', new Float32Array(48_000).fill(0.1), 48_000);

		await service.importRecording(PHRASE, 'phrase', file);

		expect((await readWakeClips(PHRASE))[0].length).toBe(16_000);
	});

	it('holds a file to the limits a spoken take has', async () => {
		const { service } = harness();

		expect(
			await service.importRecording(
				PHRASE,
				'phrase',
				await wav('click.wav', new Float32Array(1600))
			)
		).toMatchObject({ ok: false, reason: expect.stringMatching(/short/i) });
		expect(
			await service.importRecording(PHRASE, 'phrase', await wav('speech.wav', otherSpeech(9)))
		).toMatchObject({ ok: false, reason: expect.stringMatching(/longer than a wake phrase/i) });
		expect(await readWakeClips(PHRASE)).toHaveLength(0);
	});

	it('keeps other speech from a file, up to what a phrase holds', async () => {
		const { service } = harness();

		expect(
			await service.importRecording(PHRASE, 'background', await wav('talk.wav', otherSpeech(20)))
		).toMatchObject({ ok: true, status: { backgroundMs: 20_000 } });
		// 120 s is the most a phrase keeps; a 110 s file on top of 20 s is trimmed.
		const result = await service.importRecording(
			PHRASE,
			'background',
			await wav('long.wav', new Float32Array(110 * 16_000))
		);
		expect(result).toMatchObject({ ok: true, status: { backgroundMs: 120_000 } });
	});

	it('names what is wrong with a file it cannot read', async () => {
		const { service } = harness();
		const notWav = path.join(root, 'notes.txt');
		await fs.writeFile(notWav, 'not audio');

		expect(await service.importRecording(PHRASE, 'phrase', path.join(root, 'missing.wav'))).toEqual(
			{
				ok: false,
				reason: `No such file: ${path.join(root, 'missing.wav')}`,
			}
		);
		expect(await service.importRecording(PHRASE, 'phrase', 'relative.wav')).toMatchObject({
			ok: false,
			reason: 'An absolute path to a WAV file is required.',
		});
		expect(await service.importRecording(PHRASE, 'phrase', notWav)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/Wake phrase training reads 16-bit PCM WAV files/),
		});
	});
});

describe('the one entry point', () => {
	it('answers nothing until a service is registered', async () => {
		expect(await runWakeEnrollmentRequest({ action: 'list' })).toEqual({
			ok: false,
			reason: 'Voice is not available in this build.',
		});
	});

	it('routes each verb to the service, and refuses what it does not know', async () => {
		const { service } = harness();
		const release = registerWakeEnrollmentService(service, () => true);
		try {
			await seed(2, 0);

			expect(await runWakeEnrollmentRequest({ action: 'status', phrase: PHRASE })).toMatchObject({
				ok: true,
				status: { clips: 2 },
			});
			// A list carries each phrase's status, so a client needs one round trip.
			expect(await runWakeEnrollmentRequest({ action: 'list' })).toEqual({
				ok: true,
				status: null,
				phrases: [PHRASE],
				statuses: [expect.objectContaining({ phrase: PHRASE, clips: 2 })],
			});
			expect(
				await runWakeEnrollmentRequest({ action: 'remove-last-clip', phrase: PHRASE })
			).toMatchObject({ ok: true, status: { clips: 1 } });
			expect(
				await runWakeEnrollmentRequest({ action: 'record', phrase: PHRASE, kind: 'phrase' })
			).toMatchObject({ ok: true, status: { recording: 'phrase' } });
			expect(await runWakeEnrollmentRequest({ action: 'stop' })).toMatchObject({
				ok: true,
				status: { recording: null },
			});
			expect(await runWakeEnrollmentRequest({ action: 'remove', phrase: PHRASE })).toMatchObject({
				ok: true,
				status: { clips: 0 },
			});
			expect(await runWakeEnrollmentRequest({ action: 'upload', phrase: PHRASE })).toEqual({
				ok: false,
				reason: 'Unknown wake phrase request.',
			});
		} finally {
			release();
		}
	});

	it('will not record, import or train with voice switched off, but still reads, stops and deletes', async () => {
		// Switching voice off must still be able to close a microphone and remove
		// a recording of the user's voice.
		const { service, deps } = harness();
		const release = registerWakeEnrollmentService(service, () => false);
		try {
			await seed(1, 0);
			const off = { ok: false, reason: expect.stringMatching(/switched off/) };

			expect(
				await runWakeEnrollmentRequest({ action: 'record', phrase: PHRASE, kind: 'phrase' })
			).toEqual(off);
			expect(await runWakeEnrollmentRequest({ action: 'train', phrase: PHRASE })).toEqual(off);
			expect(
				await runWakeEnrollmentRequest({
					action: 'import',
					phrase: PHRASE,
					kind: 'phrase',
					path: '/tmp/take.wav',
				})
			).toEqual(off);
			expect(deps.openMicrophone).not.toHaveBeenCalled();

			expect(await runWakeEnrollmentRequest({ action: 'status', phrase: PHRASE })).toMatchObject({
				ok: true,
			});
			expect(await runWakeEnrollmentRequest({ action: 'stop' })).toMatchObject({ ok: true });
			expect(await runWakeEnrollmentRequest({ action: 'remove', phrase: PHRASE })).toMatchObject({
				ok: true,
				status: { clips: 0 },
			});
		} finally {
			release();
		}
	});

	it('answers with the newest registration, and an old release does not clear it', async () => {
		const first = harness();
		const second = harness();
		const releaseFirst = registerWakeEnrollmentService(first.service, () => true);
		const releaseSecond = registerWakeEnrollmentService(second.service, () => true);

		releaseFirst();
		expect(await runWakeEnrollmentRequest({ action: 'list' })).toMatchObject({ ok: true });

		releaseSecond();
		expect(await runWakeEnrollmentRequest({ action: 'list' })).toMatchObject({ ok: false });
	});
});
