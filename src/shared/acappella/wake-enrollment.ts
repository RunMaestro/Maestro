/**
 * Wake phrase enrollment: teaching the wake word a phrase by saying it.
 *
 * openWakeWord ships a classifier per phrase, each trained on thousands of
 * synthetic clips. Nobody can do that for "hey scout" on their laptop. What a
 * person CAN do is say the phrase a couple of dozen times, and that is enough
 * for a different kind of detector: keep the recordings as examples, and fire
 * when new audio sounds like one of them. The examples are compared in the
 * space openWakeWord's own front end produces, so everything before the last
 * step (microphone, mel spectrogram, speech embedding) is the code and the
 * models the pretrained phrases already use.
 *
 * This module is the vocabulary both processes share: how much has to be
 * recorded, what the recordings are called on disk, what a trained phrase
 * reports about itself, and the events the recording flow pushes. The matcher
 * and the trainer live in `src/main/acappella/wake/`.
 */

import { normalizeWakePhrase } from './voice-models';

// ---------------------------------------------------------------------------
// How much to record
// ---------------------------------------------------------------------------

/** Recordings of the phrase the flow asks for. Past this, more helps slowly. */
export const WAKE_ENROLLMENT_TARGET_CLIPS = 20;

/**
 * Fewest recordings a phrase can be trained from.
 *
 * Each recording is checked against all the OTHERS to decide where "sounds like
 * the phrase" starts, so a handful is not enough to tell a consistent phrase
 * from one lucky pair.
 */
export const WAKE_ENROLLMENT_MIN_CLIPS = 8;

/** Most recordings kept per phrase. Bounds the disk and the per-hop matching cost. */
export const WAKE_ENROLLMENT_MAX_CLIPS = 60;

/** Ordinary speech the flow asks for, so the detector learns what is NOT the phrase. */
export const WAKE_ENROLLMENT_BACKGROUND_TARGET_MS = 30_000;

/** Least ordinary speech a phrase can be trained with. */
export const WAKE_ENROLLMENT_BACKGROUND_MIN_MS = 12_000;

/** Most ordinary speech kept per phrase. */
export const WAKE_ENROLLMENT_BACKGROUND_MAX_MS = 120_000;

/** A burst shorter than this is a cough or a click, not the phrase. */
export const WAKE_ENROLLMENT_MIN_CLIP_MS = 250;

/**
 * A burst longer than this is a sentence, not a wake phrase. Also the most the
 * matcher can see at once: its window is sixteen 80 ms steps.
 */
export const WAKE_ENROLLMENT_MAX_CLIP_MS = 2500;

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * The directory name a phrase's recordings and model live under.
 *
 * Derived from the NORMALISED phrase, so "Hey, Scout!" and "hey scout" are one
 * enrollment, exactly as they are one phrase everywhere else. Anything outside
 * `a-z0-9` is dropped for the filesystem's sake, and a short hash of the
 * normalised text is appended so two phrases that differ only in dropped
 * characters (or are entirely non-Latin) never share a directory.
 *
 * Returns the empty string for a phrase with nothing sayable in it.
 */
export function wakePhraseKey(phrase: string): string {
	const normalized = normalizeWakePhrase(phrase);
	if (!normalized) return '';
	const slug = normalized
		.replace(/[^a-z0-9 ]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.slice(0, 40);
	return `${slug || 'phrase'}-${hashText(normalized)}`;
}

/** FNV-1a, 32 bit, as eight hex digits. A name, not a security boundary. */
function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// The background passage
// ---------------------------------------------------------------------------

const PASSAGE_BODY = [
	'I need to finish the report before lunch, then call the bank about the transfer.',
	'What time does the meeting start tomorrow?',
	'Please remind me to buy milk, eggs and bread on the way home.',
	'Open the settings and check the build status.',
	'The weather has been strange this week, rain in the morning and sun in the afternoon.',
	'Commit the changes, push the branch, and tell me when the tests are green.',
];

/**
 * What the user is asked to read for the background recording.
 *
 * Ordinary sentences, plus each WORD of a multi-word phrase used on its own.
 * The second part is the point: a detector that has only heard "hey" at the
 * start of the phrase cannot know that "hey, how is it going" is something
 * else, and saying the words apart is how it finds out. The whole phrase never
 * appears.
 */
export function wakeEnrollmentPassage(phrase: string): string {
	const words = [...new Set(normalizeWakePhrase(phrase).split(' ').filter(Boolean))];
	// A one-word phrase has no parts to say apart: its only word IS the phrase,
	// and reading it here would record the phrase as "not the phrase".
	const wordSentences = (words.length > 1 ? words : []).map((word, index) =>
		index % 2 === 0
			? `The word ${word} came up twice in that conversation.`
			: `Somebody said ${word}, and then nothing happened.`
	);
	const sentences: string[] = [];
	const longest = Math.max(PASSAGE_BODY.length, wordSentences.length);
	for (let i = 0; i < longest; i++) {
		if (i < PASSAGE_BODY.length) sentences.push(PASSAGE_BODY[i]);
		if (i < wordSentences.length) sentences.push(wordSentences[i]);
	}
	return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// What a trained phrase reports
// ---------------------------------------------------------------------------

/**
 * How far the phrase stands apart from ordinary speech.
 *
 *   - `strong`: every recording sounds more like the others than anything in
 *     the background does, with room to spare.
 *   - `fair`: they are separate, but not by much. Expect to tune sensitivity.
 *   - `weak`: something in the background sounds as much like the phrase as
 *     the phrase does. It will misfire or miss until more is recorded.
 */
export type WakeEnrollmentQuality = 'strong' | 'fair' | 'weak';

/** What training measured, on the recordings themselves. */
export interface WakeEnrollmentReport {
	/** Recordings the model was built from. */
	clipsUsed: number;
	/** Recordings on disk. The difference is outliers: a cough, a different word. */
	clipsTotal: number;
	/**
	 * Recordings the model recognises at the default sensitivity when it is NOT
	 * allowed to compare a recording with itself. The honest version of "it
	 * recognised my recordings", which is otherwise always all of them.
	 */
	recognized: number;
	/** Times the background recording would have fired the phrase at the default sensitivity. */
	falseAlarms: number;
	/** Ordinary speech the model was calibrated against, in ms. */
	backgroundMs: number;
	quality: WakeEnrollmentQuality;
	/** One sentence saying what to do next, when there is something to do. */
	advice?: string;
}

/** A phrase's trained model, as the UI needs to know it. */
export interface WakeEnrollmentModelInfo {
	/** Epoch ms. Also the revision the always-on listener re-arms on. */
	trainedAt: number;
	report: WakeEnrollmentReport;
}

/** Which of the two recordings a capture run is making. */
export type WakeEnrollmentRecordingKind = 'phrase' | 'background';

/** Everything about one phrase's enrollment. Sent whole, so a client never patches. */
export interface WakeEnrollmentStatus {
	/** The phrase as asked for. */
	phrase: string;
	/** {@link wakePhraseKey} of it. Empty when the phrase has nothing sayable. */
	key: string;
	/** Recordings of the phrase on disk. */
	clips: number;
	/** Ordinary speech on disk, in ms. */
	backgroundMs: number;
	/** The trained model, or null when the phrase has not been trained. */
	model: WakeEnrollmentModelInfo | null;
	/** The capture run in progress for THIS phrase, or null. */
	recording: WakeEnrollmentRecordingKind | null;
	/** True while this phrase is being trained. */
	training: boolean;
}

/** Verbs that make something. They need voice switched on; reading and deleting do not. */
export function wakeEnrollmentActionNeedsVoice(action: WakeEnrollmentRequest['action']): boolean {
	return action === 'record' || action === 'import' || action === 'train';
}

/** Whether a phrase has enough on disk to be trained. */
export function canTrainWakePhrase(
	status: Pick<WakeEnrollmentStatus, 'clips' | 'backgroundMs'>
): boolean {
	return (
		status.clips >= WAKE_ENROLLMENT_MIN_CLIPS &&
		status.backgroundMs >= WAKE_ENROLLMENT_BACKGROUND_MIN_MS
	);
}

/** Why a burst of speech was not kept as a recording. */
export type WakeClipRejection = 'too-short' | 'too-long' | 'full';

/** The sentence shown when a burst is not kept. */
export function describeWakeClipRejection(reason: WakeClipRejection): string {
	if (reason === 'too-short') return 'Too short to be the phrase. Say it again.';
	if (reason === 'too-long') return 'That was longer than a wake phrase. Say only the phrase.';
	return 'That is as many recordings as a phrase keeps.';
}

/** Training steps, in the order they happen. */
export type WakeTrainingPhase = 'listening' | 'comparing' | 'saving';

/** What the enrollment flow pushes while it works. */
export type WakeEnrollmentEvent =
	/** Something changed on disk or in the flow's state. Replaces the client's copy. */
	| { type: 'status'; status: WakeEnrollmentStatus }
	/** The microphone level during a capture run, 0 to 1. */
	| { type: 'level'; key: string; level: number }
	/** A burst was heard and not kept. */
	| { type: 'clip-rejected'; key: string; reason: WakeClipRejection }
	/** Training progress, 0 to 1 within the whole run. */
	| { type: 'training'; key: string; phase: WakeTrainingPhase; progress: number }
	/** A capture run or a training run failed. */
	| { type: 'error'; key: string; message: string };

/** What starting a capture run or a training run returns. */
export type WakeEnrollmentResult =
	| { ok: true; status: WakeEnrollmentStatus }
	| { ok: false; reason: string };

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** What a client can ask of wake phrase enrollment. One request shape, one channel. */
export type WakeEnrollmentRequest =
	| { action: 'list' }
	| { action: 'status'; phrase: string }
	| { action: 'record'; phrase: string; kind: WakeEnrollmentRecordingKind }
	| { action: 'stop' }
	/** Add a recording from a WAV file instead of the microphone. The CLI's route. */
	| { action: 'import'; phrase: string; kind: WakeEnrollmentRecordingKind; path: string }
	| { action: 'remove-last-clip'; phrase: string }
	| { action: 'clear-background'; phrase: string }
	| { action: 'train'; phrase: string }
	| { action: 'remove'; phrase: string };

/** What comes back. `ok: false` carries the sentence to show. */
export type WakeEnrollmentReply =
	| {
			ok: true;
			status: WakeEnrollmentStatus | null;
			/** `list`: every phrase with recordings. */
			phrases?: string[];
			/** `list`: the status of each of `phrases`, in the same order. */
			statuses?: WakeEnrollmentStatus[];
	  }
	| { ok: false; reason: string };

/** Narrow whatever crossed the bridge. An unknown verb is refused, never guessed. */
export function parseWakeEnrollmentRequest(raw: unknown): WakeEnrollmentRequest | null {
	if (!raw || typeof raw !== 'object') return null;
	const body = raw as Record<string, unknown>;
	if (typeof body.action !== 'string') return null;
	const phrase = typeof body.phrase === 'string' ? body.phrase.trim() : '';
	switch (body.action) {
		case 'list':
		case 'stop':
			return { action: body.action };
		case 'record':
			if (body.kind !== 'phrase' && body.kind !== 'background') return null;
			return { action: 'record', phrase, kind: body.kind };
		case 'import':
			if (body.kind !== 'phrase' && body.kind !== 'background') return null;
			if (typeof body.path !== 'string' || !body.path) return null;
			return { action: 'import', phrase, kind: body.kind, path: body.path };
		case 'status':
		case 'remove-last-clip':
		case 'clear-background':
		case 'train':
		case 'remove':
			return { action: body.action, phrase };
		default:
			return null;
	}
}

/** The one line under a trained phrase: what it measured, in words. */
export function describeWakeEnrollmentReport(report: WakeEnrollmentReport): string {
	const recognized = `Recognised ${report.recognized} of ${report.clipsUsed} recordings`;
	const alarms =
		report.falseAlarms === 0
			? 'no false alarms'
			: `${report.falseAlarms} false alarm${report.falseAlarms === 1 ? '' : 's'}`;
	const seconds = Math.round(report.backgroundMs / 1000);
	return `${recognized}, ${alarms} in ${seconds} s of other speech.`;
}
