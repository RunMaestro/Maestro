/**
 * Dictation on the browser's own microphone: the web interface's
 * `window.maestro.localModels.dictation`.
 *
 * On the desktop a dictation is recorded on the computer running Maestro. A
 * browser on the web interface is somewhere else (a phone, a laptop in another
 * room), so recording there would capture the wrong room. Here the browser
 * records the clip itself and sends it to the host, which transcribes it with
 * the Dictation assignment (`localModels:dictation:transcribe`).
 *
 * Nothing here is a second implementation:
 *
 *   - the capture graph is A Cappella's `MicCapture` (echo cancellation, 16 kHz
 *     mono, 20 ms frames), the one the audio host runs;
 *   - the clip state machine is the host's own `ClipCapture` (busy, start
 *     timeout, the length cap, a device lost mid-sentence);
 *   - the answer is the host's `DictationResult`, so `services/dictation.ts`
 *     runs one state machine for both and cannot tell them apart.
 *
 * A browser opens its microphone only in a secure context (HTTPS or
 * localhost). Over plain HTTP on a LAN address `getUserMedia` does not exist;
 * {@link browserDictationBlocker} names that, so the button says why before it
 * is pressed instead of failing after.
 */

import type { LocalModelsApi } from '../../main/preload/localModels';
import { encodeWav, float32ToInt16 } from '../../shared/audio/pcm';
import { ClipCapture } from '../../shared/local-models/clip-capture';
import type { DictationResult, DictationStartResult } from '../../shared/local-models/dictation';
import { readBlobAsDataUrl } from '../utils/imageData';

/** The calls `services/dictation.ts` makes, on whichever side records. */
export type DictationTransport = Pick<
	LocalModelsApi['dictation'],
	'start' | 'stop' | 'cancel' | 'onInterrupted'
>;

/**
 * Why this browser cannot record a dictation, or null when it can. Read before
 * a press, so the button shows the reason instead of a refusal after it.
 */
export function browserDictationBlocker(): string | null {
	const secure = typeof window !== 'undefined' && window.isSecureContext;
	if (!secure || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
		return 'A browser opens its microphone only over HTTPS. Open Maestro through Remote Control, or at localhost on the computer running it, to dictate.';
	}
	return null;
}

const CANCELLED: DictationStartResult = Object.freeze({
	started: false,
	code: 'cancelled',
	message: 'Dictation was cancelled.',
});

/** The capture graph's pieces, loaded on the first dictation rather than at boot. */
type CaptureModule = typeof import('../acappella-audio/capture');

/**
 * Build the transport. Exported for tests; the app uses
 * {@link getBrowserDictation}.
 *
 * @param loadCapture How the capture graph is loaded. A dynamic import, so the
 *        worklet chunk is fetched only by someone who dictates.
 */
export function createBrowserDictation(
	loadCapture: () => Promise<{ capture: CaptureModule; workletUrl: string }> = async () => {
		const [capture, worklet] = await Promise.all([
			import('../acappella-audio/capture'),
			import('../acappella-audio/worklet-url'),
		]);
		return { capture, workletUrl: worklet.pcmWorkletUrl };
	}
): DictationTransport {
	let context: AudioContext | null = null;
	let mic: InstanceType<CaptureModule['MicCapture']> | null = null;
	let loaded: { capture: CaptureModule; workletUrl: string } | null = null;
	/** Bumped by a cancel, so a start still loading or checking readiness stands down. */
	let attempt = 0;
	/** Transcriptions this client is waiting on, so a cancel knows to reach the host. */
	let transcribing = 0;

	const clip: ClipCapture = new ClipCapture({
		// `ClipCapture` refuses a second start as busy; nothing else borrows this microphone.
		refusal: () => null,
		onActiveChange: () => undefined,
		// The browser asks inside `getUserMedia`; a denial arrives as a `mic-error`.
		requestMicPermission: async () => ({ state: 'granted', settingsLabel: '' }),
		ensureAudioHost: () => {
			if (!context || !loaded) return false;
			mic ??= new loaded.capture.MicCapture({
				context,
				workletUrl: loaded.workletUrl,
				onFrame: (frame) => clip.pushFrame(new Int16Array(frame.pcm)),
				onStatus: (status) => clip.handleStatus(status),
			});
			return true;
		},
		startCapture: () => void mic?.start(),
		stopCapture: () => mic?.stop('requested'),
	});

	return {
		async start(): Promise<DictationStartResult> {
			const blocker = browserDictationBlocker();
			if (blocker) return { started: false, code: 'unsupported', message: blocker };
			if (clip.isActive) {
				return { started: false, code: 'busy', message: 'A dictation is already recording.' };
			}
			const mine = ++attempt;
			// Made now, inside the press: a context created after an await may stay
			// suspended in browsers that want a user gesture to play or record.
			try {
				context ??= new AudioContext();
			} catch (error) {
				return {
					started: false,
					code: 'audio-init-failed',
					message: error instanceof Error ? error.message : String(error),
				};
			}
			void context.resume().catch(() => undefined);

			// Refused before the user says a word, as on the host.
			const [readiness] = await window.maestro.localModels.taskReadiness('dictation');
			if (mine !== attempt) return CANCELLED;
			if (!readiness || readiness.state !== 'ready') {
				return {
					started: false,
					code: readiness?.state === 'off' ? 'task-off' : 'task-unavailable',
					message: [readiness?.detail, readiness?.suggestedAction].filter(Boolean).join(' '),
				};
			}

			loaded ??= await loadCapture();
			if (mine !== attempt) return CANCELLED;
			return clip.start();
		},

		async stop(): Promise<DictationResult> {
			if (!clip.isActive) return { status: 'idle' };
			const recorded = await clip.stop();
			const interruption = recorded.interruption ? { interruption: recorded.interruption } : {};
			if (recorded.audio.length === 0)
				return { status: 'ok', text: '', audioMs: 0, ...interruption };

			const wav = encodeWav(float32ToInt16(recorded.audio), recorded.sampleRate);
			transcribing += 1;
			try {
				const audio = await readBlobAsDataUrl(
					new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' })
				);
				return await window.maestro.localModels.dictation.transcribe({ audio, ...interruption });
			} finally {
				transcribing -= 1;
			}
		},

		async cancel(): Promise<void> {
			attempt += 1;
			await clip.cancel();
			// Only a clip already sent has anything on the host to abort.
			if (transcribing > 0) await window.maestro.localModels.dictation.cancel();
		},

		onInterrupted: (handler) => clip.onInterrupted(handler),
	};
}

let browserDictation: DictationTransport | null = null;

/** The one browser transport: there is one microphone per page. */
export function getBrowserDictation(): DictationTransport {
	browserDictation ??= createBrowserDictation();
	return browserDictation;
}

/** Tests only: forget the transport and the capture graph it built. */
export function __resetBrowserDictation(): void {
	browserDictation = null;
}
