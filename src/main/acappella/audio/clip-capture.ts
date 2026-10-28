/**
 * Clip capture - the audio host's microphone, with no voice session behind it.
 *
 * Dictation needs one thing from A Cappella: its capture path. The hidden audio
 * host already opens the microphone through Chromium's audio processing,
 * resamples to 16 kHz in a worklet, and ships 20 ms frames to main. This module
 * is the mode of that path that records a clip and does nothing else:
 *
 *   - **No session.** Nothing here touches `VoiceSessionService`. No floor is
 *     opened, nothing is routed, nothing is spoken, and no protocol event is
 *     published.
 *   - **No second capture.** There is one microphone. The frames this records
 *     are the same frames the host already sends; it taps them, exactly as the
 *     wake word Test does.
 *   - **Refused while the microphone is spoken for.** A live voice session is
 *     already transcribing what is said and dispatching it; recording the same
 *     speech into a text box as well would send one sentence two places.
 *   - **The wake word stands down.** While a clip is recording the always-on
 *     wake word must not fire: a dictated "hey jarvis" is text, not a wake. The
 *     hands-free listener asks {@link ClipCapture.isActive} and disarms.
 *
 * It implements the core's `DictationMicrophone` seam and is registered at
 * startup, so dictation works whether or not the A Cappella Encore Feature is
 * on. Free of Electron: the host commands, the permission ask, and the frame
 * and status feeds are injected (see `src/main/ipc/handlers/acappella.ts`).
 */

import type { AudioHostStatus } from '../../../shared/acappella/audio-host';
import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../shared/acappella/audio-host';
import type { MicPermission } from '../../../shared/acappella/protocol';
import { int16ToFloat32 } from '../../../shared/audio/pcm';
import {
	DICTATION_MAX_CLIP_MS,
	type DictationInterruption,
	type DictationRefusalCode,
	type DictationStartResult,
} from '../../../shared/local-models/dictation';
import type { DictationClip, DictationMicrophone } from '../../local-models/dictation';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'ACappella';

/**
 * How long the microphone may take to open. The first clip after launch also
 * pays for the audio host window loading its bundle, which is the slow part.
 */
export const CLIP_CAPTURE_START_TIMEOUT_MS = 10_000;

export interface ClipCaptureDeps {
	/**
	 * Why the microphone may not be borrowed right now (a live voice session, a
	 * wake word Test), or null when it may.
	 */
	refusal(): { code: DictationRefusalCode; message: string } | null;
	/**
	 * Called whenever {@link ClipCapture.isActive} changes, and awaited before
	 * the microphone is opened, so the always-on wake word has disarmed by then.
	 */
	onActiveChange(): Promise<void> | void;
	/** Ask the OS for the microphone. The same ask a session start makes. */
	requestMicPermission(): Promise<{ state: MicPermission; settingsLabel: string }>;
	/** Make sure the audio host window exists. False when there is none to open. */
	ensureAudioHost(): boolean;
	/** Send `start-capture` on the user's chosen device. Idempotent in the host. */
	startCapture(): void;
	/** Send `stop-capture`, unless something else still needs the microphone. */
	stopCapture(): void;
	/** Defaults to {@link DICTATION_MAX_CLIP_MS}. */
	maxClipMs?: number;
	/** Defaults to {@link CLIP_CAPTURE_START_TIMEOUT_MS}. */
	startTimeoutMs?: number;
}

type ClipCaptureState = 'idle' | 'starting' | 'recording' | 'ended';

export class ClipCapture implements DictationMicrophone {
	private readonly maxSamples: number;
	private readonly startTimeoutMs: number;

	private state: ClipCaptureState = 'idle';
	/**
	 * Bumped per `start()`. A start that was cancelled while it awaited (the
	 * permission ask, the wake word standing down) must not wake up and carry on
	 * inside the NEXT clip's `starting` state.
	 */
	private attempt = 0;
	private chunks: Int16Array[] = [];
	private samples = 0;
	private interruption: DictationInterruption | null = null;
	/**
	 * Whether this clip asked the host to open the microphone. A clip refused
	 * before that (no permission, no host) has nothing of its own to close.
	 */
	private captureRequested = false;
	/** Settles the `start()` in flight. Null until the microphone is asked for. */
	private settleStart: ((result: DictationStartResult) => void) | null = null;
	private readonly listeners = new Set<(interruption: DictationInterruption) => void>();

	constructor(private readonly deps: ClipCaptureDeps) {
		this.maxSamples = Math.round(
			((deps.maxClipMs ?? DICTATION_MAX_CLIP_MS) / 1000) * ACAPPELLA_AUDIO_SAMPLE_RATE
		);
		this.startTimeoutMs = deps.startTimeoutMs ?? CLIP_CAPTURE_START_TIMEOUT_MS;
	}

	/**
	 * True from the moment a clip is asked for until its microphone is given
	 * back. The wake word and the Test button read this to stay out of the way.
	 */
	get isActive(): boolean {
		return this.state !== 'idle';
	}

	async start(): Promise<DictationStartResult> {
		if (this.state !== 'idle') {
			return { started: false, code: 'busy', message: 'A dictation is already recording.' };
		}
		const refusal = this.deps.refusal();
		if (refusal) return { started: false, ...refusal };

		// Claimed before the first await, so a second start cannot slip in.
		this.state = 'starting';
		const attempt = ++this.attempt;
		this.resetClip();
		const result = await this.open(attempt);
		if (result.started) return result;

		// A refused start borrowed nothing it may keep. Skipped when a newer clip
		// has already taken over: the state is that clip's now.
		if (this.attempt === attempt) await this.release();
		return result;
	}

	/** One 20 ms frame from the audio host. Ignored unless a clip is recording. */
	pushFrame(pcm: Int16Array): void {
		// Frames are kept while `starting` too: they only arrive then if the
		// microphone was already open, and they are the user's first syllable.
		if (this.state !== 'starting' && this.state !== 'recording') return;
		if (pcm.length === 0) return;

		const room = this.maxSamples - this.samples;
		// Copied, not retained: the frame's buffer belongs to the IPC message.
		const kept = pcm.length <= room ? Int16Array.from(pcm) : Int16Array.from(pcm.subarray(0, room));
		if (kept.length > 0) {
			this.chunks.push(kept);
			this.samples += kept.length;
		}
		if (this.samples >= this.maxSamples && this.state === 'recording') {
			const minutes = Math.round(this.maxSamples / ACAPPELLA_AUDIO_SAMPLE_RATE / 60);
			this.end({
				code: 'max-duration',
				message: `Dictation stops recording after ${minutes} minutes. What was said up to then is kept.`,
			});
		}
	}

	/** One control-plane message from the audio host. */
	handleStatus(status: AudioHostStatus): void {
		if (this.state !== 'starting' && this.state !== 'recording') return;

		switch (status.kind) {
			case 'ready':
				// The host window just finished loading: a command sent before that had
				// no listener and vanished. Ask again, as the wake word Test does.
				if (this.captureRequested) this.deps.startCapture();
				break;
			case 'capture-start':
				// Only an announcement that answers THIS clip's request opens it. The
				// host answers a start on a stream that is already open too, so a
				// microphone the wake word left running is still announced.
				if (this.state === 'starting' && this.settleStart) {
					this.state = 'recording';
					this.settleStart({ started: true });
				}
				break;
			case 'mic-error':
				if (this.state === 'starting') {
					this.settleStart?.({ started: false, code: status.code, message: status.message });
				} else {
					this.end({ code: status.code, message: status.message });
				}
				break;
			case 'capture-stop':
				if (this.state !== 'recording') break;
				if (status.reason === 'requested') {
					// Something else closed the microphone (a voice session that started
					// during the clip just ended). The clip still needs it.
					this.captureRequested = true;
					this.deps.startCapture();
				} else {
					this.end({
						code: 'device-lost',
						message: 'The microphone stopped. What was said up to then is kept.',
					});
				}
				break;
			default:
				break;
		}
	}

	async stop(): Promise<DictationClip> {
		const clip = this.takeClip();
		await this.finish();
		return clip;
	}

	async cancel(): Promise<void> {
		await this.finish();
	}

	onInterrupted(listener: (interruption: DictationInterruption) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// -- Internals -----------------------------------------------------------

	/** Borrow, ask, and open. Resolves once audio is flowing or with why not. */
	private async open(attempt: number): Promise<DictationStartResult> {
		const superseded = () => this.attempt !== attempt || this.state !== 'starting';

		await this.deps.onActiveChange();
		if (superseded()) return CANCELLED;

		const permission = await this.deps.requestMicPermission();
		if (superseded()) return CANCELLED;
		if (permission.state === 'denied' || permission.state === 'restricted') {
			return {
				started: false,
				code: 'permission-denied',
				message: `Maestro does not have access to the microphone. Allow it in ${permission.settingsLabel}.`,
			};
		}

		if (!this.deps.ensureAudioHost()) {
			return {
				started: false,
				code: 'no-microphone',
				message: 'There is no audio host to capture the microphone through.',
			};
		}

		return new Promise<DictationStartResult>((resolve) => {
			const timer = setTimeout(() => {
				this.settleStart?.({
					started: false,
					code: 'timeout',
					message: 'The microphone did not open. Try again.',
				});
			}, this.startTimeoutMs);
			this.settleStart = (result) => {
				clearTimeout(timer);
				this.settleStart = null;
				resolve(result);
			};
			this.captureRequested = true;
			this.deps.startCapture();
		});
	}

	/** A recording ended on its own. The audio is kept for the `stop()` to come. */
	private end(interruption: DictationInterruption): void {
		if (this.state !== 'recording') return;
		this.state = 'ended';
		this.interruption = interruption;
		logger.info(`Dictation recording ended (${interruption.code})`, LOG_CONTEXT);
		// The microphone goes back now, not when the owner gets round to stopping:
		// an indicator nobody dismissed must not hold a device open.
		this.closeMicrophone();
		for (const listener of this.listeners) listener(interruption);
	}

	/** Leave whatever state the capture is in and give the microphone back. */
	private async finish(): Promise<void> {
		const state = this.state;
		if (state === 'idle') return;
		// A start still waiting on the microphone resolves as cancelled; `start()`
		// then releases. Releasing here as well would close the device twice.
		if (state === 'starting') {
			if (this.settleStart) this.settleStart(CANCELLED);
			// Still awaiting the permission ask: mark it cancelled and let it unwind.
			else this.state = 'ended';
			return;
		}
		await this.release();
	}

	private async release(): Promise<void> {
		this.state = 'idle';
		this.resetClip();
		this.closeMicrophone();
		// After the state change, so whoever is told reads `isActive` as false.
		await this.deps.onActiveChange();
	}

	/** Close the microphone this clip opened. A no-op when it opened none. */
	private closeMicrophone(): void {
		if (!this.captureRequested) return;
		this.captureRequested = false;
		this.deps.stopCapture();
	}

	private takeClip(): DictationClip {
		const pcm = new Int16Array(this.samples);
		let offset = 0;
		for (const chunk of this.chunks) {
			pcm.set(chunk, offset);
			offset += chunk.length;
		}
		return {
			audio: int16ToFloat32(pcm),
			sampleRate: ACAPPELLA_AUDIO_SAMPLE_RATE,
			...(this.interruption ? { interruption: this.interruption } : {}),
		};
	}

	private resetClip(): void {
		this.chunks = [];
		this.samples = 0;
		this.interruption = null;
	}
}

const CANCELLED: DictationStartResult = Object.freeze({
	started: false,
	code: 'cancelled',
	message: 'Dictation was cancelled.',
});
