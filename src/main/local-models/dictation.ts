/**
 * Dictation: speech into a text box, with no voice session behind it.
 *
 * Two layers, both small.
 *
 * **{@link transcribeClip}** is the one-shot transcription every dictation ends
 * in: a whole clip of audio through the `dictation` task's assignment, by way
 * of the task router. Any caller that already holds audio (a recording made
 * here, a clip a client captured itself) uses it.
 *
 * **{@link startDictation} / {@link stopDictation} / {@link cancelDictation}**
 * record that clip. The app window has no microphone (the default session
 * denies every media request), so the recording is made in the main process
 * through a {@link DictationMicrophone} that whoever owns a capture device
 * registers. Today that is A Cappella's audio host, in a mode that starts no
 * voice session and never opens the voice floor
 * (`src/main/acappella/audio/clip-capture.ts`). The core does not import it:
 * with no microphone registered (the standalone runner, a test) a dictation is
 * refused by name, exactly like any other missing capability.
 *
 * Rules this module holds:
 *
 *   - **One recording at a time, owned by the client that started it.** There is
 *     one microphone. A second start is refused as `busy`, and a stop or cancel
 *     from any other client changes nothing.
 *   - **The task is checked before the microphone is opened.** A dictation whose
 *     model is not downloaded is refused before the user says a word, not after
 *     they have finished speaking.
 *   - **The microphone is released before the transcript is awaited.** A clip
 *     being transcribed does not hold the slot, so the next recording can start
 *     while the last one decodes.
 *   - **No fallback.** An unavailable source is reported as itself. Nothing here
 *     reaches for a hosted recogniser.
 */

import { int16ToFloat32 } from '../../shared/audio/pcm';
import { readPcmWavFile } from '../utils/wav-file';
import type {
	DictationInterruption,
	DictationRefusalCode,
	DictationResult,
	DictationStartResult,
} from '../../shared/local-models/dictation';
import { resolveTaskReadiness } from './task-readiness';
import { getLocalModel } from '../../shared/local-models/model-catalog';
import { resolveLocalModelAssignment } from '../../shared/local-models/tasks';
import { readLocalModelAssignments } from './sources';
import { transcribeSpeech, type SpeechTranscription } from './speech-to-text';
import { LocalModelError } from './errors';
import { runSpeechToTextTask, type SpeechToTextTaskResult } from './task-router';
import { normalizeSpeechVocabulary } from '../../shared/acappella/speech-vocabulary';
import { correctSpeechVocabulary } from './speech-vocabulary';

/** The task every dictation runs on. */
const DICTATION_TASK_ID = 'dictation';

export interface TranscribeClipOptions {
	vocabulary?: readonly string[];
	/** In-process callers only: an abort signal cannot cross IPC. */
	signal?: AbortSignal;
}

/**
 * Transcribe one clip with the speech-to-text source assigned to Dictation.
 *
 * `audio` is mono, normalised to -1..1, at `sampleRate` (resampled to 16 kHz by
 * the service). Answers `off` when the task has no source and `unavailable`
 * when the source cannot run; it never falls back to another one.
 */
export async function transcribeClip(
	audio: Float32Array,
	sampleRate: number,
	options: TranscribeClipOptions = {}
): Promise<SpeechToTextTaskResult> {
	const vocabulary = normalizeSpeechVocabulary(options.vocabulary ?? (await getVocabulary?.()));
	const result = await runSpeechToTextTask(DICTATION_TASK_ID, {
		audio,
		sampleRate,
		...(options.signal ? { signal: options.signal } : {}),
		...(vocabulary.length ? { vocabulary } : {}),
	});
	if (result.status !== 'ok' || !vocabulary.length) return result;
	return {
		...result,
		text: await correctSpeechVocabulary(result.text, vocabulary, options.signal),
	};
}

/**
 * The largest audio file {@link transcribeAudioFileRequest} reads. An hour of
 * 16 kHz mono speech is about 115 MB, so this refuses a wrong file (a video, a
 * disk image) without getting in the way of a long recording.
 */
const MAX_AUDIO_FILE_BYTES = 512 * 1024 * 1024;

/**
 * Transcribe a WAV file on disk with the Dictation assignment: the CLI's route
 * to {@link transcribeClip} (`maestro-cli models run dictation --audio <file>`).
 *
 * A dictation in the app records its clip from the microphone; an agent has no
 * microphone, so it brings the audio as a file and gets the same transcript
 * from the same model. `filePath` arrives untrusted from the bridge, so it is
 * validated here. Only 16-bit PCM WAV is read: decoding compressed audio would
 * need a codec this process does not ship.
 *
 * @throws When the request is malformed or the file is not a readable WAV. A
 *         task that is off or unavailable is an answer, not a throw.
 */
export async function transcribeAudioFileRequest(
	filePath: unknown
): Promise<SpeechToTextTaskResult> {
	const clip = await readPcmWavFile(filePath, {
		maxBytes: MAX_AUDIO_FILE_BYTES,
		purpose: 'a transcription',
		reader: 'Dictation',
	});
	return transcribeClip(int16ToFloat32(clip.pcm), clip.sampleRate);
}

// ---------------------------------------------------------------------------
// The microphone seam
// ---------------------------------------------------------------------------

/** What a microphone hands back when a recording stops. */
export interface DictationClip {
	/** Mono audio, normalised to -1..1. Empty when nothing was recorded. */
	audio: Float32Array;
	sampleRate: number;
	/** Present when the recording ended on its own before it was stopped. */
	interruption?: DictationInterruption;
}

/**
 * A capture device a dictation can record through. Implemented by whoever owns
 * one; the core only sequences the calls.
 */
export interface DictationMicrophone {
	/**
	 * Open the microphone. Resolves once audio is flowing, or with the classified
	 * reason it is not. Must not start a voice session.
	 */
	start(): Promise<DictationStartResult>;
	/** Close the microphone and hand back everything recorded. */
	stop(): Promise<DictationClip>;
	/** Close the microphone and discard the audio. Also aborts a pending start. */
	cancel(): Promise<void>;
	/**
	 * Subscribe to a recording ending on its own (device lost, the length cap).
	 * @returns The unsubscribe.
	 */
	onInterrupted(listener: (interruption: DictationInterruption) => void): () => void;
}

type InterruptionListener = (ownerId: string, interruption: DictationInterruption) => void;

interface ActiveDictation {
	readonly ownerId: string;
	readonly microphone: DictationMicrophone;
	phase: 'starting' | 'recording';
	/** Stopped or cancelled before the microphone opened. */
	abandoned: boolean;
}

let microphone: DictationMicrophone | null = null;
let getVocabulary: (() => readonly string[] | Promise<readonly string[]>) | undefined;
let releaseMicrophoneListener: (() => void) | null = null;
let active: ActiveDictation | null = null;
/** Transcriptions still running, by owner, so a cancel can reach them. */
const transcribing = new Map<string, Set<AbortController>>();
const interruptionListeners = new Set<InterruptionListener>();

/**
 * Supply the microphone dictation records through. One at a time: a second
 * registration replaces the first.
 *
 * @returns Unregister, which also ends a recording made through it.
 */
export function registerDictationMicrophone(
	device: DictationMicrophone,
	vocabulary?: () => readonly string[] | Promise<readonly string[]>
): () => void {
	releaseMicrophoneListener?.();
	microphone = device;
	getVocabulary = vocabulary;
	releaseMicrophoneListener = device.onInterrupted((interruption) => {
		const dictation = active;
		if (!dictation || dictation.microphone !== device) return;
		for (const listener of interruptionListeners) listener(dictation.ownerId, interruption);
	});
	return () => {
		if (microphone !== device) return;
		releaseMicrophoneListener?.();
		releaseMicrophoneListener = null;
		microphone = null;
		getVocabulary = undefined;
		if (active?.microphone === device) {
			active = null;
			void device.cancel();
		}
	};
}

/**
 * Hear about a recording that ended on its own. The owner still calls
 * {@link stopDictation} to get the transcript of what was captured.
 *
 * @returns The unsubscribe.
 */
export function onDictationInterrupted(listener: InterruptionListener): () => void {
	interruptionListeners.add(listener);
	return () => interruptionListeners.delete(listener);
}

/** Whether a dictation is recording (or opening its microphone) right now. */
export function isDictationRecording(): boolean {
	return active !== null;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function refuse(code: DictationRefusalCode, message: string): DictationStartResult {
	return { started: false, code, message };
}

/**
 * Start recording a dictation for `ownerId` (the client asking).
 *
 * Resolves `{ started: true }` once the microphone is open, so a surface can
 * show "recording" only when audio is really being captured. Every other
 * outcome is a classified refusal.
 */
export async function startDictation(ownerId: string): Promise<DictationStartResult> {
	const device = microphone;
	if (!device) {
		return refuse('no-microphone', 'No microphone is available to record a dictation through.');
	}
	if (active) return refuse('busy', 'A dictation is already recording.');

	const dictation: ActiveDictation = {
		ownerId,
		microphone: device,
		phase: 'starting',
		abandoned: false,
	};
	active = dictation;

	let started = false;
	try {
		const readiness = await resolveTaskReadiness(DICTATION_TASK_ID);
		if (readiness.state !== 'ready') {
			return refuse(
				readiness.state === 'off' ? 'task-off' : 'task-unavailable',
				[readiness.detail, readiness.suggestedAction].filter(Boolean).join(' ')
			);
		}
		if (dictation.abandoned) return refuse('cancelled', 'Dictation was cancelled.');

		const result = await device.start();
		if (!result.started) return result;
		if (dictation.abandoned || active !== dictation) {
			await device.cancel();
			return refuse('cancelled', 'Dictation was cancelled.');
		}
		dictation.phase = 'recording';
		started = true;
		return result;
	} finally {
		if (!started && active === dictation) active = null;
	}
}

/**
 * Stop `ownerId`'s recording and transcribe it.
 *
 * The microphone is closed first and the slot freed, then the clip goes through
 * {@link transcribeClip}. A stop that arrives before the microphone opened
 * cancels the start instead: nothing was recorded.
 */
export async function stopDictation(ownerId: string): Promise<DictationResult> {
	const dictation = active;
	if (!dictation || dictation.ownerId !== ownerId) return { status: 'idle' };

	if (dictation.phase === 'starting') {
		dictation.abandoned = true;
		await dictation.microphone.cancel();
		return { status: 'cancelled' };
	}

	active = null;
	const clip = await dictation.microphone.stop();

	const abort = new AbortController();
	const inFlight = transcribing.get(ownerId) ?? new Set<AbortController>();
	inFlight.add(abort);
	transcribing.set(ownerId, inFlight);
	try {
		const result = await transcribeClip(clip.audio, clip.sampleRate, { signal: abort.signal });
		return toDictationResult(result, clip);
	} finally {
		inFlight.delete(abort);
		if (inFlight.size === 0) transcribing.delete(ownerId);
	}
}

/**
 * Discard `ownerId`'s dictation: a recording in progress, a start still
 * opening the microphone, and any transcript still being produced.
 */
export async function cancelDictation(ownerId: string): Promise<void> {
	for (const abort of transcribing.get(ownerId) ?? []) abort.abort();

	const dictation = active;
	if (!dictation || dictation.ownerId !== ownerId) return;
	if (dictation.phase === 'starting') {
		dictation.abandoned = true;
	} else {
		active = null;
	}
	await dictation.microphone.cancel();
}

function toDictationResult(result: SpeechToTextTaskResult, clip: DictationClip): DictationResult {
	switch (result.status) {
		case 'ok':
			return {
				status: 'ok',
				text: result.text,
				audioMs: result.audioMs,
				...(clip.interruption ? { interruption: clip.interruption } : {}),
			};
		case 'off':
			return { status: 'off' };
		case 'unavailable':
			return { status: 'unavailable', reason: result.reason, code: result.code };
		case 'cancelled':
			return { status: 'cancelled' };
	}
}

/** Tests only: forget the microphone, any recording, and every listener. */
export function __resetDictation(): void {
	releaseMicrophoneListener?.();
	releaseMicrophoneListener = null;
	microphone = null;
	getVocabulary = undefined;
	active = null;
	transcribing.clear();
	interruptionListeners.clear();
}

/** A local-only, immutable Dictation snapshot for an already recorded clip. */
export interface LocalClipTranscriber {
	readonly modelId: string | null;
	readonly languages: readonly string[];
	readonly language: string;
	readonly reason: string | null;
	transcribe(
		audio: Float32Array,
		sampleRate: number,
		options: { language: string; signal?: AbortSignal }
	): Promise<SpeechTranscription>;
}

/**
 * Capture model/settings before asynchronous work. Never probes an endpoint,
 * opens a microphone, creates a voice session, or substitutes another model.
 * Both file consumers and the live Dictation recogniser use this core assignment.
 */
export async function resolveLocalClipTranscriber(): Promise<LocalClipTranscriber> {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), 'dictation');
	const source = assignment.type === 'local' ? Object.freeze({ ...assignment }) : null;
	const entry = source ? getLocalModel(source.modelId) : undefined;
	const languages = Object.freeze([...(entry?.speechToText?.languages ?? [])]);
	const reason = !source
		? assignment.type === 'off'
			? 'off'
			: 'local-required'
		: ((await resolveTaskReadiness('dictation', { assignments: { dictation: source } })).reason ??
			null);
	return Object.freeze({
		modelId: source?.modelId ?? null,
		language: source?.language ?? 'en',
		languages,
		reason,
		async transcribe(
			audio: Float32Array,
			sampleRate: number,
			options: { language: string; signal?: AbortSignal }
		) {
			if (
				!source ||
				reason ||
				options.language !== (source.language ?? 'en') ||
				!languages.includes(options.language)
			) {
				throw new LocalModelError('The local Dictation source cannot transcribe this language.', {
					code: 'model-unsupported',
					recovery: 'Choose a ready, compatible local Dictation assignment.',
					consumerId: 'local-models:dictation-clip',
				});
			}
			return transcribeSpeech(source, audio, sampleRate, options);
		},
	});
}
