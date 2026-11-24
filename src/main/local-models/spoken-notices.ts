/**
 * Spoken notices: say one line aloud when an agent finishes a turn.
 *
 * Three small parts.
 *
 * **The line.** {@link announceAgentFinished} asks the `spoken-notices` task
 * for a summary of the turn and puts the agent's name in front of it. When the
 * task is off, when its model cannot run, when it takes too long, and when it
 * writes nothing usable, the line is `<agent name> finished`, which needs no
 * model. So the task assignment decides how much a notice SAYS, never whether
 * one is spoken: that is the `spokenNotices` setting alone.
 *
 * **The queue.** One notice is spoken at a time, and the next waits out a
 * quiet window after the last one ended, so five agents finishing together are
 * five separate sentences rather than one overlapping noise. A notice that
 * waited too long is dropped as no longer news, and the queue is short: older
 * waiting notices give way to newer ones.
 *
 * **The voice.** The core does not own a speaker. Whoever can make sound
 * registers a {@link NoticeSpeaker}; today that is A Cappella's audio host,
 * with a local voice and no voice session
 * (`src/main/acappella/audio/notice-speech.ts`). With none registered (the
 * standalone runner, a test) a notice is refused by name.
 *
 * Rules this module holds:
 *
 *   - **Never while a voice session is live.** The session speaks for itself,
 *     and a notice over it would be two voices. The speaker reports the session
 *     through {@link NoticeSpeaker.refusal}, asked before the model is called
 *     and again at the moment of speaking, and {@link cancelSpokenNotices} cuts
 *     a notice off when a session starts under it.
 *   - **Never over a dictation.** A notice waits while a dictation is
 *     recording, because the microphone would record the notice into the text.
 *   - **Every outcome is an answer.** Callers get a {@link SpokenNoticeResult},
 *     never a rejection, so a CLI caller can tell "spoken" from "skipped, and
 *     here is why".
 */

import {
	DEFAULT_SPOKEN_NOTICE_MODE,
	SPOKEN_NOTICE_MAX_REQUEST_CHARS,
	SPOKEN_NOTICE_REPLY_SCHEMA,
	SPOKEN_NOTICES_SETTING_KEY,
	asSpokenNoticeMode,
	cleanSpokenText,
	composeNoticeLine,
	fallbackNoticeLine,
	formatSpokenNoticeInput,
	parseAgentFinishedNotice,
	parseSpokenNoticeReply,
	shouldSpeakNotice,
	type AgentFinishedNotice,
	type SpokenNoticeLineSource,
	type SpokenNoticeMode,
	type SpokenNoticeResult,
	type SpokenNoticeSkipCode,
} from '../../shared/spokenNotices';
import { getPrompt } from '../prompt-manager';
import { getSettingsStore } from '../stores/getters';
import { logger } from '../utils/logger';
import type { SafeSendFn } from '../utils/safe-send';
import { captureException } from '../utils/sentry';
import { isDictationRecording } from './dictation';
import { clearLocalTaskNotice, reportLocalTaskUnavailable } from './task-notices';
import { runLocalTask } from './task-router';

const LOG_CONTEXT = '[SpokenNotices]';

const TASK_ID = 'spoken-notices';

/** One short sentence, as JSON. */
const NOTICE_LINE_MAX_TOKENS = 120;

/**
 * How long the model may take to write the line. A notice is news: past this
 * the plain line is spoken instead of a better one that arrives late.
 */
export const SPOKEN_NOTICE_LINE_TIMEOUT_MS = 20 * 1000;

/** The silence kept after one notice ends before the next may start. */
export const SPOKEN_NOTICE_QUIET_MS = 3 * 1000;

/** A notice that waited longer than this is dropped instead of spoken. */
export const SPOKEN_NOTICE_STALE_MS = 60 * 1000;

/** How many notices may wait behind the one being spoken. */
export const SPOKEN_NOTICE_MAX_QUEUED = 4;

/** How often a notice held behind a dictation looks again. */
const HOLD_RETRY_MS = 1000;

/** Something that can turn a line of text into sound. */
export interface NoticeSpeaker {
	/**
	 * Why nothing may be spoken right now, or null when it may. A live voice
	 * session is reported here.
	 */
	refusal(): { code: SpokenNoticeSkipCode; message: string } | null;
	/**
	 * Speak one line. Resolves when the last of it has been heard. Rejects with
	 * an `Error` whose message is written for a person when the voice cannot
	 * speak. Aborting `signal` must cut the audio off, not let it finish.
	 */
	speak(text: string, signal: AbortSignal): Promise<void>;
}

interface QueuedNotice {
	text: string;
	lineSource: SpokenNoticeLineSource;
	queuedAt: number;
	settle: (result: SpokenNoticeResult) => void;
}

let speaker: NoticeSpeaker | null = null;
const queue: QueuedNotice[] = [];
/** The notice being spoken. */
interface SpeakingRun {
	/** Cuts the audio off. */
	abort: AbortController;
	/** Set by a cancel, so the run settles with the reason it was cut. */
	cancelled: { code: SpokenNoticeSkipCode; message: string } | null;
}

let speaking: SpeakingRun | null = null;
/** Wall-clock time before which no notice may start. */
let quietUntil = 0;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

function skipped(code: SpokenNoticeSkipCode, message: string): SpokenNoticeResult {
	return { spoken: false, code, message };
}

const NO_SPEAKER_MESSAGE = 'Nothing in this process can speak a notice.';

/**
 * Supply the voice notices are spoken with. One at a time: a second
 * registration replaces the first.
 *
 * @returns Unregister, which also drops every notice waiting on it.
 */
export function registerNoticeSpeaker(device: NoticeSpeaker): () => void {
	speaker = device;
	return () => {
		if (speaker !== device) return;
		cancelSpokenNotices('no-speaker', NO_SPEAKER_MESSAGE);
		speaker = null;
	};
}

/** The stored `spokenNotices` mode. Anything unreadable is `off`. */
export function readSpokenNoticeMode(): SpokenNoticeMode {
	return asSpokenNoticeMode(
		getSettingsStore().get(SPOKEN_NOTICES_SETTING_KEY, DEFAULT_SPOKEN_NOTICE_MODE)
	);
}

/** Whether a notice is being spoken or waiting to be. */
export function isSpeakingNotice(): boolean {
	return speaking !== null || queue.length > 0;
}

/**
 * Cut off the notice being spoken and drop every one waiting.
 *
 * Called when a voice session starts: from that moment the session owns the
 * speakers. Each dropped notice settles with `code`, so its caller learns why.
 */
export function cancelSpokenNotices(
	code: SpokenNoticeSkipCode = 'cancelled',
	message = 'The notice was cancelled.'
): void {
	if (pumpTimer) {
		clearTimeout(pumpTimer);
		pumpTimer = null;
	}
	for (const item of queue.splice(0)) item.settle(skipped(code, message));
	if (speaking) {
		speaking.cancelled = { code, message };
		speaking.abort.abort();
	}
}

/** Add a line to the queue. Resolves once it was spoken, or with why it was not. */
function enqueue(text: string, lineSource: SpokenNoticeLineSource): Promise<SpokenNoticeResult> {
	return new Promise<SpokenNoticeResult>((settle) => {
		queue.push({ text, lineSource, queuedAt: Date.now(), settle });
		// The newest notices are the news. Past the cap the oldest one waiting
		// gives way; the one being spoken is never interrupted for it.
		while (queue.length > SPOKEN_NOTICE_MAX_QUEUED) {
			queue
				.shift()
				?.settle(skipped('superseded', 'Newer notices arrived before this one could be spoken.'));
		}
		pump();
	});
}

function pumpLater(delayMs: number): void {
	pumpTimer = setTimeout(() => {
		pumpTimer = null;
		pump();
	}, delayMs);
}

/** Start the next notice when nothing is speaking and the quiet window is over. */
function pump(): void {
	if (speaking || pumpTimer || queue.length === 0) return;

	const wait = quietUntil - Date.now();
	if (wait > 0) {
		pumpLater(wait);
		return;
	}
	// Held, not dropped: the dictation ends in seconds, and the notice is still
	// news then. One that waits too long is dropped as stale below.
	if (isDictationRecording() && Date.now() - queue[0].queuedAt <= SPOKEN_NOTICE_STALE_MS) {
		pumpLater(HOLD_RETRY_MS);
		return;
	}

	const item = queue.shift();
	if (!item) return;
	if (Date.now() - item.queuedAt > SPOKEN_NOTICE_STALE_MS) {
		item.settle(skipped('stale', 'The notice waited too long behind others to still be news.'));
		pump();
		return;
	}
	const device = speaker;
	if (!device) {
		item.settle(skipped('no-speaker', NO_SPEAKER_MESSAGE));
		pump();
		return;
	}
	// Asked again here, not only when the notice was queued: a voice session can
	// start while a notice waits.
	const refusal = device.refusal();
	if (refusal) {
		item.settle(skipped(refusal.code, refusal.message));
		pump();
		return;
	}
	void speakItem(device, item);
}

async function speakItem(device: NoticeSpeaker, item: QueuedNotice): Promise<void> {
	const run: SpeakingRun = { abort: new AbortController(), cancelled: null };
	speaking = run;
	let result: SpokenNoticeResult;
	try {
		await device.speak(item.text, run.abort.signal);
		result = run.cancelled
			? skipped(run.cancelled.code, run.cancelled.message)
			: { spoken: true, text: item.text, lineSource: item.lineSource };
	} catch (error) {
		if (run.cancelled) {
			result = skipped(run.cancelled.code, run.cancelled.message);
		} else {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn(`A notice could not be spoken: ${reason}`, LOG_CONTEXT);
			result = skipped('speech-failed', reason);
		}
	}
	speaking = null;
	quietUntil = Date.now() + SPOKEN_NOTICE_QUIET_MS;
	item.settle(result);
	pump();
}

export interface AnnounceAgentFinishedContext {
	/** Whether a Maestro window has focus right now. */
	appFocused: boolean;
	/** For the one-time toast when the assigned model cannot run. */
	safeSend?: SafeSendFn;
}

/**
 * Write the line for a finished turn: the model's summary behind the agent's
 * name, or the plain line when there is no usable summary.
 */
async function writeNoticeLine(
	notice: AgentFinishedNotice,
	safeSend: SafeSendFn | undefined
): Promise<{ text: string; lineSource: SpokenNoticeLineSource }> {
	const fallback = { text: fallbackNoticeLine(notice.agentName), lineSource: 'fallback' as const };
	let verdict: Awaited<ReturnType<typeof runLocalTask>>;
	try {
		verdict = await runLocalTask(TASK_ID, {
			system: getPrompt('spoken-notice-local'),
			prompt: formatSpokenNoticeInput(notice),
			maxTokens: NOTICE_LINE_MAX_TOKENS,
			jsonSchema: SPOKEN_NOTICE_REPLY_SCHEMA,
			signal: AbortSignal.timeout(SPOKEN_NOTICE_LINE_TIMEOUT_MS),
		});
	} catch (error) {
		// An unclassified engine failure is a bug and belongs in Sentry, but it is
		// not a reason to stay silent: the plain line needs no model.
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'spokenNotices:writeLine',
		});
		return fallback;
	}

	switch (verdict.status) {
		case 'off':
		case 'use-utility-agent':
			return fallback;
		case 'cancelled':
			logger.warn('The notice summary timed out; speaking the plain line', LOG_CONTEXT, {
				source: verdict.source,
			});
			return fallback;
		case 'unavailable':
			reportLocalTaskUnavailable({ safeSend, taskId: TASK_ID, verdict });
			return fallback;
		case 'ok': {
			clearLocalTaskNotice(TASK_ID);
			const text = composeNoticeLine(notice.agentName, parseSpokenNoticeReply(verdict.json));
			if (!text) {
				logger.warn('The assigned model wrote no usable notice summary', LOG_CONTEXT, {
					source: verdict.source,
					responseLength: verdict.text.length,
				});
				return fallback;
			}
			return { text, lineSource: 'model' };
		}
	}
}

/**
 * An agent finished a turn: speak one line about it, when the user asked for
 * that and nothing forbids it.
 *
 * Resolves once the line was spoken, or with why it was not. The setting and
 * the voice session are checked BEFORE the model is called, so a notice nobody
 * will hear costs no inference.
 */
export async function announceAgentFinished(
	notice: AgentFinishedNotice,
	context: AnnounceAgentFinishedContext
): Promise<SpokenNoticeResult> {
	const mode = readSpokenNoticeMode();
	if (mode === 'off') {
		return skipped(
			'setting-off',
			'Speak when an agent finishes is off (Settings > Notifications).'
		);
	}
	if (!shouldSpeakNotice(mode, context.appFocused)) {
		return skipped(
			'app-focused',
			'Maestro is focused, and notices are set to speak only when it is not.'
		);
	}
	const device = speaker;
	if (!device) return skipped('no-speaker', NO_SPEAKER_MESSAGE);
	const refusal = device.refusal();
	if (refusal) return skipped(refusal.code, refusal.message);

	const line = await writeNoticeLine(notice, context.safeSend);
	return enqueue(line.text, line.lineSource);
}

/**
 * Speak text the caller supplies: `maestro-cli notify speak` and the Test
 * button in Settings.
 *
 * An explicit request, so the `spokenNotices` setting and window focus are not
 * consulted. Everything else holds: the same voice, the same queue and quiet
 * window, and never while a voice session is live.
 */
export async function speakNotice(text: string): Promise<SpokenNoticeResult> {
	const cleaned = cleanSpokenText(text, SPOKEN_NOTICE_MAX_REQUEST_CHARS);
	if (!cleaned) return skipped('empty', 'There is nothing to say.');
	const device = speaker;
	if (!device) return skipped('no-speaker', NO_SPEAKER_MESSAGE);
	const refusal = device.refusal();
	if (refusal) return skipped(refusal.code, refusal.message);
	return enqueue(cleaned, 'given');
}

/**
 * The transport-facing entry for {@link speakNotice}: IPC
 * (`localModels:spokenNotices:speak`) and the CLI bridge (`notify_speak`) hand
 * over an untrusted value, checked here once for both.
 */
export async function speakNoticeRequest(text: unknown): Promise<SpokenNoticeResult> {
	if (typeof text !== 'string' || text.trim() === '') {
		throw new Error('Text to speak is required.');
	}
	if (text.length > SPOKEN_NOTICE_MAX_REQUEST_CHARS) {
		throw new Error(`Text to speak is limited to ${SPOKEN_NOTICE_MAX_REQUEST_CHARS} characters.`);
	}
	return speakNotice(text);
}

/**
 * The transport-facing entry for {@link announceAgentFinished}
 * (`localModels:spokenNotices:agentFinished`).
 */
export async function announceAgentFinishedRequest(
	notice: unknown,
	context: AnnounceAgentFinishedContext
): Promise<SpokenNoticeResult> {
	return announceAgentFinished(parseAgentFinishedNotice(notice), context);
}

/** Tests only: forget the speaker, the queue, and the quiet window. */
export function __resetSpokenNotices(): void {
	if (pumpTimer) clearTimeout(pumpTimer);
	pumpTimer = null;
	queue.length = 0;
	speaking = null;
	quietUntil = 0;
	speaker = null;
}
