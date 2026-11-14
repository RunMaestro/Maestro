/**
 * Wake phrase enrollment: the flow that records a phrase and trains it.
 *
 * Three verbs and the state between them:
 *
 *   - **Record the phrase.** The microphone opens and every burst of speech is
 *     kept as one recording, so the user just says the phrase again and again
 *     with a breath between. No button per take.
 *   - **Record other speech.** Half a minute of ordinary talking, kept whole. It
 *     is what tells the trainer where "sounds like the phrase" has to start.
 *   - **Train.** Recordings in, matcher out (`wake-trainer.ts`), saved beside
 *     them.
 *
 * It owns no microphone. The audio host has one, and the always-on wake word, a
 * voice session, the Test button and dictation all want it; who may borrow it is
 * the IPC layer's call, handed in as `microphoneBusyReason` / `openMicrophone` /
 * `closeMicrophone`. A capture run that goes quiet closes it again on its own,
 * because a Settings dialog left open must not be an open microphone.
 *
 * Everything it learns goes out as a whole {@link WakeEnrollmentStatus}, never a
 * patch: a client that missed an event is corrected by the next one.
 */

import { int16ToFloat32, resampleLinear, SPEECH_SAMPLE_RATE } from '../../../shared/audio/pcm';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import {
	WAKE_ENROLLMENT_BACKGROUND_MAX_MS,
	WAKE_ENROLLMENT_BACKGROUND_MIN_MS,
	WAKE_ENROLLMENT_BACKGROUND_TARGET_MS,
	WAKE_ENROLLMENT_MAX_CLIP_MS,
	WAKE_ENROLLMENT_MAX_CLIPS,
	WAKE_ENROLLMENT_MIN_CLIP_MS,
	WAKE_ENROLLMENT_MIN_CLIPS,
	canTrainWakePhrase,
	describeWakeClipRejection,
	parseWakeEnrollmentRequest,
	wakeEnrollmentActionNeedsVoice,
	wakePhraseKey,
	type WakeClipRejection,
	type WakeEnrollmentEvent,
	type WakeEnrollmentRecordingKind,
	type WakeEnrollmentReply,
	type WakeEnrollmentResult,
	type WakeEnrollmentStatus,
	type WakeTrainingPhase,
} from '../../../shared/acappella/wake-enrollment';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { readPcmWavFile } from '../../utils/wav-file';
import { SpeechBurstSegmenter, type SpeechBurst } from '../audio/speech-burst';
import { measure } from '../audio/vad';
import {
	addWakeBackground,
	addWakeClip,
	clearWakeBackground,
	deleteWakeEnrollment,
	listWakeEnrollments,
	readWakeBackground,
	readWakeClips,
	readWakeEnrollmentSummary,
	removeLastWakeClip,
	saveEnrolledWakeModel,
} from './wake-enrollment-store';
import { createWakeFeaturizer } from './wake-front-end';
import type { WakeFeaturizer } from './wake-features';
import { WakeTrainingError, trainEnrolledWakeModel } from './wake-trainer';

const LOG_CONTEXT = 'ACappella';

/** Audio kept ahead of a recording's onset. */
const CLIP_PRE_SPEECH_MS = 300;

/**
 * Silence that ends one recording of the phrase. Shorter than a turn's
 * endpoint: someone repeating a phrase leaves half a second between takes, not
 * the pause they leave mid-sentence.
 */
const CLIP_ENDPOINT_SILENCE_MS = 450;

/** A phrase run with nothing said for this long closes the microphone. */
const IDLE_TIMEOUT_MS = 45_000;

/** Gap between level events: enough for a meter, not a frame-rate stream over IPC. */
const LEVEL_INTERVAL_MS = 100;

/** Gap between status events while ordinary speech is being recorded. */
const BACKGROUND_STATUS_INTERVAL_MS = 500;

/** A background run shorter than this is a mis-click, not a recording. */
const MIN_BACKGROUND_RUN_MS = 1000;

/** Gap between training progress events. */
const TRAINING_PROGRESS_INTERVAL_MS = 150;

/** Largest WAV file taken as a recording. Two minutes of 48 kHz stereo, with room. */
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/** Silence a file may carry around the phrase beyond the longest spoken take. */
const IMPORT_SILENCE_ALLOWANCE_MS = 2500;

export interface WakeEnrollmentDeps {
	/** Push an event to every client. */
	emit(event: WakeEnrollmentEvent): void;
	/** Why the microphone cannot be borrowed right now, as a sentence, or null when it can. */
	microphoneBusyReason(): string | null;
	/** Take the microphone: stand the always-on wake word down and open the device. */
	openMicrophone(): Promise<void>;
	/** Give it back. */
	closeMicrophone(): Promise<void>;
	/** A phrase's model appeared, changed, or went away. */
	onModelChanged?(phrase: string): void;
	/** Injected in tests. Defaults to the installed front end. */
	createFeaturizer?: () => Promise<WakeFeaturizer | null>;
	/** Injected in tests. */
	now?: () => number;
}

interface RecordingRun {
	phrase: string;
	key: string;
	kind: WakeEnrollmentRecordingKind;
	/** Cuts the stream into takes. Phrase runs only. */
	segmenter: SpeechBurstSegmenter | null;
	/** The ordinary speech so far. Background runs only. */
	frames: Int16Array[];
	samples: number;
	/** How long this background run may get, in samples. */
	limitSamples: number;
	lastActivityAt: number;
	lastLevelAt: number;
	lastStatusAt: number;
	idleTimer: ReturnType<typeof setInterval>;
}

export class WakeEnrollmentService {
	private recording: RecordingRun | null = null;
	/** The phrase key being trained, or null. */
	private training: string | null = null;
	/** Saves in flight, so a stop waits for the take that was just heard. */
	private saves: Promise<void> = Promise.resolve();
	private readonly now: () => number;

	constructor(private readonly deps: WakeEnrollmentDeps) {
		this.now = deps.now ?? Date.now;
	}

	/** True while a capture run holds the microphone. */
	get isRecording(): boolean {
		return this.recording !== null;
	}

	async status(phrase: string): Promise<WakeEnrollmentStatus> {
		const key = wakePhraseKey(phrase);
		const summary = await readWakeEnrollmentSummary(phrase);
		const run = this.recording?.key === key ? this.recording : null;
		const liveMs =
			run?.kind === 'background' ? Math.round((run.samples / SPEECH_SAMPLE_RATE) * 1000) : 0;
		return {
			phrase,
			key,
			clips: summary.clips,
			backgroundMs: summary.backgroundMs + liveMs,
			model: summary.model,
			recording: run?.kind ?? null,
			training: key !== '' && this.training === key,
		};
	}

	// -- Recording -----------------------------------------------------------

	async startRecording(
		phrase: string,
		kind: WakeEnrollmentRecordingKind
	): Promise<WakeEnrollmentResult> {
		const key = wakePhraseKey(phrase);
		if (!key) return { ok: false, reason: 'Type the phrase first.' };
		if (this.training) return { ok: false, reason: 'Wait for training to finish.' };
		if (this.recording) await this.stopRecording();

		const busy = this.deps.microphoneBusyReason();
		if (busy) return { ok: false, reason: busy };

		const summary = await readWakeEnrollmentSummary(phrase);
		if (kind === 'phrase' && summary.clips >= WAKE_ENROLLMENT_MAX_CLIPS) {
			return {
				ok: false,
				reason: `A phrase keeps at most ${WAKE_ENROLLMENT_MAX_CLIPS} recordings. Remove some first.`,
			};
		}
		// A first run fills up to the target; a later one adds as much again.
		const room =
			summary.backgroundMs < WAKE_ENROLLMENT_BACKGROUND_TARGET_MS
				? WAKE_ENROLLMENT_BACKGROUND_TARGET_MS - summary.backgroundMs
				: Math.min(
						WAKE_ENROLLMENT_BACKGROUND_TARGET_MS,
						WAKE_ENROLLMENT_BACKGROUND_MAX_MS - summary.backgroundMs
					);
		if (kind === 'background' && room <= 0) {
			return { ok: false, reason: 'There is already plenty of other speech recorded.' };
		}

		await this.deps.openMicrophone();

		const startedAt = this.now();
		const run: RecordingRun = {
			phrase,
			key,
			kind,
			segmenter: null,
			frames: [],
			samples: 0,
			limitSamples: Math.round((room / 1000) * SPEECH_SAMPLE_RATE),
			lastActivityAt: startedAt,
			lastLevelAt: 0,
			lastStatusAt: 0,
			idleTimer: setInterval(() => this.checkIdle(), 1000),
		};
		if (kind === 'phrase') {
			run.segmenter = new SpeechBurstSegmenter({
				preSpeechMs: CLIP_PRE_SPEECH_MS,
				// Past the longest phrase by enough that "too long" is decided by the
				// speech itself and not by where the cap happened to fall.
				maxBurstMs: WAKE_ENROLLMENT_MAX_CLIP_MS + 1000,
				vad: { endpointSilenceMs: CLIP_ENDPOINT_SILENCE_MS },
				onBurst: (burst) => this.onBurst(run, burst),
			});
		}
		this.recording = run;
		logger.info(`Wake phrase recording started (${kind}) for "${phrase}"`, LOG_CONTEXT);
		const status = await this.status(phrase);
		this.deps.emit({ type: 'status', status });
		return { ok: true, status };
	}

	/** End the capture run, keep what it heard, and close the microphone. Safe when none is running. */
	async stopRecording(): Promise<WakeEnrollmentStatus | null> {
		const run = this.recording;
		if (!run) return null;
		this.recording = null;
		clearInterval(run.idleTimer);

		if (run.kind === 'background') {
			const ms = (run.samples / SPEECH_SAMPLE_RATE) * 1000;
			if (ms >= MIN_BACKGROUND_RUN_MS) {
				const pcm = new Int16Array(run.samples);
				let offset = 0;
				for (const frame of run.frames) {
					pcm.set(frame, offset);
					offset += frame.length;
				}
				this.queueSave(run, () => addWakeBackground(run.phrase, pcm));
			}
		}
		await this.saves;
		await this.deps.closeMicrophone();
		logger.info(`Wake phrase recording stopped (${run.kind}) for "${run.phrase}"`, LOG_CONTEXT);
		const status = await this.status(run.phrase);
		this.deps.emit({ type: 'status', status });
		return status;
	}

	/** One 20 ms frame from the audio host. Ignored unless a capture run is live. */
	pushFrame(samples: Int16Array): void {
		const run = this.recording;
		if (!run) return;
		const at = this.now();

		let level: number;
		if (run.segmenter) {
			const result = run.segmenter.pushFrame(samples);
			level = result.rms;
			// Talking keeps the run alive even when the take is then rejected.
			if (result.state === 'speech') run.lastActivityAt = at;
		} else {
			level = measure(samples).rms;
			run.frames.push(Int16Array.from(samples));
			run.samples += samples.length;
			run.lastActivityAt = at;
			if (at - run.lastStatusAt >= BACKGROUND_STATUS_INTERVAL_MS) {
				run.lastStatusAt = at;
				void this.emitStatus(run.phrase);
			}
			if (run.samples >= run.limitSamples) void this.stopRecording();
		}

		if (at - run.lastLevelAt >= LEVEL_INTERVAL_MS) {
			run.lastLevelAt = at;
			this.deps.emit({ type: 'level', key: run.key, level });
		}
	}

	/**
	 * Add a recording from a WAV file rather than the microphone.
	 *
	 * The CLI's route, for a caller with no microphone to speak into. The file
	 * is held to the same limits a spoken take is, give or take the silence a
	 * file usually has around the speech; the trainer finds the phrase inside it.
	 */
	async importRecording(
		phrase: string,
		kind: WakeEnrollmentRecordingKind,
		filePath: string
	): Promise<WakeEnrollmentResult> {
		const key = wakePhraseKey(phrase);
		if (!key) return { ok: false, reason: 'Type the phrase first.' };
		if (this.training) return { ok: false, reason: 'Wait for training to finish.' };

		let pcm: Int16Array;
		try {
			const wav = await readPcmWavFile(filePath, {
				maxBytes: MAX_IMPORT_BYTES,
				purpose: 'a wake phrase recording',
				reader: 'Wake phrase training',
			});
			pcm = resampleLinear(wav.pcm, wav.sampleRate, SPEECH_SAMPLE_RATE);
		} catch (err) {
			return { ok: false, reason: (err as Error).message };
		}
		const ms = (pcm.length / SPEECH_SAMPLE_RATE) * 1000;
		const summary = await readWakeEnrollmentSummary(phrase);

		if (kind === 'phrase') {
			if (ms < WAKE_ENROLLMENT_MIN_CLIP_MS) {
				return { ok: false, reason: describeWakeClipRejection('too-short') };
			}
			if (ms > WAKE_ENROLLMENT_MAX_CLIP_MS + IMPORT_SILENCE_ALLOWANCE_MS) {
				return { ok: false, reason: describeWakeClipRejection('too-long') };
			}
			if (summary.clips >= WAKE_ENROLLMENT_MAX_CLIPS) {
				return { ok: false, reason: describeWakeClipRejection('full') };
			}
			await addWakeClip(phrase, pcm);
		} else {
			const room = WAKE_ENROLLMENT_BACKGROUND_MAX_MS - summary.backgroundMs;
			if (ms < MIN_BACKGROUND_RUN_MS) {
				return { ok: false, reason: 'That file is too short to be useful as other speech.' };
			}
			if (room <= 0) {
				return { ok: false, reason: 'There is already plenty of other speech recorded.' };
			}
			const keep = Math.min(pcm.length, Math.round((room / 1000) * SPEECH_SAMPLE_RATE));
			await addWakeBackground(phrase, pcm.subarray(0, keep));
		}
		return { ok: true, status: await this.emitStatus(phrase) };
	}

	/** Drop the newest recording of the phrase: the take that was a cough. */
	async removeLastClip(phrase: string): Promise<WakeEnrollmentStatus> {
		await this.saves;
		await removeLastWakeClip(phrase);
		return this.emitStatus(phrase);
	}

	/** Drop the ordinary speech so it can be recorded again. */
	async clearBackground(phrase: string): Promise<WakeEnrollmentStatus> {
		if (this.recording?.key === wakePhraseKey(phrase) && this.recording.kind === 'background') {
			// Discard the run in progress too, rather than saving it on the way out.
			this.recording.samples = 0;
			this.recording.frames = [];
			await this.stopRecording();
		}
		await clearWakeBackground(phrase);
		return this.emitStatus(phrase);
	}

	// -- Training ------------------------------------------------------------

	async train(phrase: string): Promise<WakeEnrollmentResult> {
		const key = wakePhraseKey(phrase);
		if (!key) return { ok: false, reason: 'Type the phrase first.' };
		if (this.training) return { ok: false, reason: 'Training is already running.' };
		if (this.recording) await this.stopRecording();

		const summary = await readWakeEnrollmentSummary(phrase);
		if (!canTrainWakePhrase(summary)) {
			return {
				ok: false,
				reason: `Training needs at least ${WAKE_ENROLLMENT_MIN_CLIPS} recordings of the phrase and ${Math.round(
					WAKE_ENROLLMENT_BACKGROUND_MIN_MS / 1000
				)} seconds of other speech.`,
			};
		}

		const featurizer = await (this.deps.createFeaturizer ?? createWakeFeaturizer)();
		if (!featurizer) {
			return {
				ok: false,
				reason: `The wake word model is not installed. Download it in ${modelsSettingsLocation('library', 'speech')}.`,
			};
		}

		this.training = key;
		await this.emitStatus(phrase);
		let lastProgressAt = 0;
		let lastPhase: WakeTrainingPhase | null = null;
		try {
			const [clips, background] = await Promise.all([
				readWakeClips(phrase),
				readWakeBackground(phrase),
			]);
			const model = await trainEnrolledWakeModel({
				phrase,
				clips: clips.map(int16ToFloat32),
				background: int16ToFloat32(background),
				featurizer,
				now: this.now,
				onProgress: (phase, progress) => {
					const at = this.now();
					// A new step is always announced: its label is the only sign the
					// bar has not stalled. Within a step, progress is throttled.
					const sameStep = phase === lastPhase;
					if (sameStep && at - lastProgressAt < TRAINING_PROGRESS_INTERVAL_MS && progress < 1) {
						return;
					}
					lastProgressAt = at;
					lastPhase = phase;
					this.deps.emit({ type: 'training', key, phase, progress });
				},
			});
			this.deps.emit({ type: 'training', key, phase: 'saving', progress: 1 });
			await saveEnrolledWakeModel(model);
			logger.info(
				`Wake phrase "${phrase}" trained from ${model.report.clipsUsed} recordings (${model.report.quality})`,
				LOG_CONTEXT
			);
		} catch (err) {
			const message = (err as Error).message;
			if (!(err instanceof WakeTrainingError)) {
				logger.error(`Wake phrase training failed: ${message}`, LOG_CONTEXT);
				void captureException(err as Error, { context: 'acappella.wakeEnrollment.train' });
			}
			this.training = null;
			this.deps.emit({ type: 'error', key, message });
			await this.emitStatus(phrase);
			return { ok: false, reason: message };
		} finally {
			await featurizer.release().catch(() => undefined);
		}

		this.training = null;
		this.deps.onModelChanged?.(phrase);
		return { ok: true, status: await this.emitStatus(phrase) };
	}

	/** Forget a phrase: its model and every recording. */
	async remove(phrase: string): Promise<WakeEnrollmentStatus> {
		const key = wakePhraseKey(phrase);
		if (this.recording?.key === key) {
			this.recording.samples = 0;
			this.recording.frames = [];
			await this.stopRecording();
		}
		await this.saves;
		await deleteWakeEnrollment(phrase);
		this.deps.onModelChanged?.(phrase);
		return this.emitStatus(phrase);
	}

	async dispose(): Promise<void> {
		await this.stopRecording();
	}

	// -- Internals -----------------------------------------------------------

	private onBurst(run: RecordingRun, burst: SpeechBurst): void {
		const reject = (reason: WakeClipRejection) =>
			this.deps.emit({ type: 'clip-rejected', key: run.key, reason });

		if (burst.truncated || (burst.speechMs ?? 0) > WAKE_ENROLLMENT_MAX_CLIP_MS) {
			reject('too-long');
			return;
		}
		if ((burst.speechMs ?? 0) < WAKE_ENROLLMENT_MIN_CLIP_MS) {
			reject('too-short');
			return;
		}
		this.queueSave(run, async () => {
			const { clips } = await readWakeEnrollmentSummary(run.phrase);
			if (clips >= WAKE_ENROLLMENT_MAX_CLIPS) {
				reject('full');
				return;
			}
			await addWakeClip(run.phrase, burst.pcm);
			if (clips + 1 >= WAKE_ENROLLMENT_MAX_CLIPS && this.recording === run) {
				void this.stopRecording();
			}
		});
	}

	/** Write to disk in the order things were heard, then tell the clients. */
	private queueSave(run: RecordingRun, save: () => Promise<void>): void {
		this.saves = this.saves
			.then(save)
			.then(() => this.emitStatus(run.phrase))
			.then(() => undefined)
			.catch((err: Error) => {
				logger.error(`Wake phrase recording could not be saved: ${err.message}`, LOG_CONTEXT);
				this.deps.emit({ type: 'error', key: run.key, message: err.message });
			});
	}

	private checkIdle(): void {
		const run = this.recording;
		if (!run || run.kind !== 'phrase') return;
		if (this.now() - run.lastActivityAt < IDLE_TIMEOUT_MS) return;
		logger.info('Wake phrase recording closed after a long silence', LOG_CONTEXT);
		void this.stopRecording();
	}

	private async emitStatus(phrase: string): Promise<WakeEnrollmentStatus> {
		const status = await this.status(phrase);
		this.deps.emit({ type: 'status', status });
		return status;
	}
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/** The live service and whether voice is switched on, set by whoever owns the microphone. */
let registered: { service: WakeEnrollmentService; isVoiceEnabled: () => boolean } | null = null;

/**
 * Make a service the one {@link runWakeEnrollmentRequest} answers with.
 *
 * The service needs a microphone it does not own, so it is built where the
 * microphone lives (the A Cappella IPC layer) and registered here, the same
 * arrangement dictation has with its microphone.
 *
 * @returns Unregister, for teardown.
 */
export function registerWakeEnrollmentService(
	service: WakeEnrollmentService,
	isVoiceEnabled: () => boolean
): () => void {
	const entry = { service, isVoiceEnabled };
	registered = entry;
	return () => {
		if (registered === entry) registered = null;
	};
}

/**
 * Run one enrollment request, whoever sent it.
 *
 * The whole feature as far as any transport is concerned: the desktop's IPC
 * channel and `maestro-cli voice wake` both end here, so a recording started
 * from a terminal and one started from Settings are the same recording.
 *
 * Never throws for something the caller can act on: a refusal is `ok: false`
 * with the sentence to show. Recording, importing and training need voice
 * switched on; reading, stopping and deleting do not, because switching voice
 * off must still be able to close a microphone and remove a recording of the
 * user's voice.
 */
export async function runWakeEnrollmentRequest(raw: unknown): Promise<WakeEnrollmentReply> {
	const request = parseWakeEnrollmentRequest(raw);
	if (!request) return { ok: false, reason: 'Unknown wake phrase request.' };
	if (!registered) return { ok: false, reason: 'Voice is not available in this build.' };
	const { service, isVoiceEnabled } = registered;
	if (wakeEnrollmentActionNeedsVoice(request.action) && !isVoiceEnabled()) {
		return {
			ok: false,
			reason: 'A Cappella is switched off. Turn it on in Settings > Plugins first.',
		};
	}

	switch (request.action) {
		case 'list': {
			const phrases = await listWakeEnrollments();
			// The statuses ride along so a client lists the phrases in one round trip.
			const statuses = await Promise.all(phrases.map((phrase) => service.status(phrase)));
			return { ok: true, status: null, phrases, statuses };
		}
		case 'status':
			return { ok: true, status: await service.status(request.phrase) };
		case 'record':
			return service.startRecording(request.phrase, request.kind);
		case 'import':
			return service.importRecording(request.phrase, request.kind, request.path);
		case 'stop':
			return { ok: true, status: await service.stopRecording() };
		case 'remove-last-clip':
			return { ok: true, status: await service.removeLastClip(request.phrase) };
		case 'clear-background':
			return { ok: true, status: await service.clearBackground(request.phrase) };
		case 'train':
			return service.train(request.phrase);
		case 'remove':
			return { ok: true, status: await service.remove(request.phrase) };
	}
}
