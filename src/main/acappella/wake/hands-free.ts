/**
 * Hands-free: the always-on wake word behind the Voice Controls toggle.
 *
 * The toggle used to be persisted and read by nothing. The detector existed, the
 * Test button exercised it, and switching "Wake word" on changed no behaviour at
 * all: no microphone opened, nothing listened, and saying the phrase did
 * nothing. This module is the missing owner.
 *
 * **What it decides.** One question, re-asked whenever anything it depends on
 * changes: should the wake word be listening right now? Yes only when the user
 * switched it on, the capability gate says the phrase can actually fire (front
 * end, the phrase's own classifier, and the runtime are all present), no voice
 * session holds the floor, and neither the Test button nor a dictation is
 * borrowing the microphone. Every other combination is a no, and a no closes
 * the microphone it opened (unless whoever caused the no is using it).
 *
 * **What a hit does.** It hands the floor to a voice session through the same
 * main-side start path a global hotkey uses, with `source: 'wake-word'`. The
 * microphone is NOT closed on the way: capture start is idempotent in the audio
 * host, so the session's pipeline picks up the stream already flowing instead of
 * reopening the device under the user's first words. When the session ends, the
 * listener re-arms.
 *
 * **What it never does.** Score audio anywhere but this machine (the detector's
 * scorer is typed local-only), or open the microphone for a feature the user did
 * not switch on. Enabling the A Cappella Encore Feature alone still opens no
 * device: the wake word toggle is its own, separate consent.
 */

import type { VoiceSessionState } from '../../../shared/acappella/session-state';
import { logger } from '../../utils/logger';
import type { WakeEngine } from '../../../shared/acappella/voice-controls';
import { wakeScorerFactory } from './transcription-wake';
import {
	createWakeDetector,
	globalWakePhrase,
	type WakeDetection,
	type WakeDetector,
	type WakeDetectorOptions,
} from './wake-detector';

const LOG_CONTEXT = 'ACappella';

/** What the listener needs to know about the user's wake settings. */
export interface HandsFreeSettings {
	/** The Voice Controls "Wake word" toggle. */
	enabled: boolean;
	phrase?: string;
	sensitivity?: number;
	debounceMs?: number;
	/** Classifier (default) or transcription. */
	engine?: WakeEngine;
	/**
	 * When the phrase's own model was last trained from the user's recordings, or
	 * null when it has none. Part of what a detector is built from: retraining
	 * the phrase has to replace the detector that loaded the old model.
	 */
	modelRevision?: number | null;
}

export interface HandsFreeDeps {
	readSettings(): HandsFreeSettings;
	/** Whether the gate says the wake word can fire. Asked before every arm. */
	canRunHandsFree(): Promise<boolean>;
	getSessionState(): VoiceSessionState;
	/**
	 * Whether another feature is recording through the microphone right now: a
	 * dictation, or a wake phrase being recorded for training. While one is, the
	 * wake word stands down: a dictated "hey jarvis" is text for a text box, and
	 * a phrase said twenty times for the trainer is not twenty wakes. Read on
	 * every `sync`, so the answer is never a copy.
	 */
	isMicrophoneBorrowed?(): boolean;
	/** Open the floor for a wake-word session. Rejections are logged, not thrown. */
	startSession(): Promise<unknown>;
	/** Make sure the audio host window exists; the microphone lives there. */
	ensureAudioHost(): void;
	requestMicPermission(): Promise<unknown>;
	startCapture(): void;
	stopCapture(): void;
	/** Injected in tests. */
	createDetector?: (options: WakeDetectorOptions) => WakeDetector;
}

export class HandsFreeListener {
	private detector: WakeDetector | null = null;
	/** The settings the armed detector was built from; a change re-arms it. */
	private armedKey: string | null = null;
	/** Borrowed by the Test button, which needs the same microphone. */
	private suspended = false;
	/** One `sync` at a time: arming awaits a model load, and two would build two detectors. */
	private syncing: Promise<void> | null = null;
	private resyncRequested = false;
	private disposed = false;
	/** Logged once per reason, so a refusal is visible without filling the log. */
	private lastRefusal: string | null = null;

	constructor(private readonly deps: HandsFreeDeps) {}

	/** True while a detector is armed and the microphone is open for it. */
	get isListening(): boolean {
		return this.detector !== null;
	}

	/**
	 * Re-evaluate whether to listen. Safe to call from any trigger, as often as
	 * needed: settings changes, session transitions, the Test button finishing.
	 */
	sync(): Promise<void> {
		if (this.syncing) {
			this.resyncRequested = true;
			return this.syncing;
		}
		this.syncing = this.runSync().finally(() => {
			this.syncing = null;
			if (this.resyncRequested && !this.disposed) {
				this.resyncRequested = false;
				void this.sync();
			}
		});
		return this.syncing;
	}

	/** One 20 ms frame from the audio host. Ignored unless armed. */
	pushFrame(samples: Int16Array): void {
		this.detector?.pushFrame(samples);
	}

	/**
	 * The audio host finished booting. A capture requested while it was still
	 * loading went nowhere, so an armed listener asks again.
	 */
	onAudioHostReady(): void {
		if (this.detector) this.deps.startCapture();
	}

	/** Lend the microphone to the Test button; `resume` takes it back. */
	async suspend(): Promise<void> {
		this.suspended = true;
		await this.sync();
	}

	async resume(): Promise<void> {
		this.suspended = false;
		await this.sync();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.syncing?.catch(() => undefined);
		await this.disarm({ closeMicrophone: true });
	}

	// -- Internals -----------------------------------------------------------

	private async runSync(): Promise<void> {
		const refusal = await this.refusalReason();
		if (refusal) {
			if (refusal !== this.lastRefusal) {
				this.lastRefusal = refusal;
				if (this.deps.readSettings().enabled) {
					logger.info(`Hands-free wake word not listening: ${refusal}`, LOG_CONTEXT);
				}
			}
			// A session holding the floor owns the microphone now, and so does a
			// feature that borrowed it; closing it here would cut either off
			// mid-sentence.
			await this.disarm({
				closeMicrophone: refusal !== SESSION_ACTIVE && refusal !== MICROPHONE_BORROWED,
			});
			return;
		}
		this.lastRefusal = null;
		if (this.detector && this.armedKey === armKey(this.deps.readSettings())) return;
		// A different phrase, engine, or sensitivity needs a new detector; keep the
		// microphone open across the swap.
		await this.disarm({ closeMicrophone: false });
		await this.arm();
	}

	private async refusalReason(): Promise<string | null> {
		if (this.disposed) return 'shutting down';
		if (!this.deps.readSettings().enabled) return 'switched off';
		if (this.suspended) return 'the Test button is using the microphone';
		if (this.deps.getSessionState() !== 'idle') return SESSION_ACTIVE;
		if (this.deps.isMicrophoneBorrowed?.()) return MICROPHONE_BORROWED;
		if (!(await this.deps.canRunHandsFree())) {
			return 'the wake word cannot fire yet (see Voice Setup)';
		}
		return null;
	}

	private async arm(): Promise<void> {
		const settings = this.deps.readSettings();
		const phrases = [globalWakePhrase(settings.phrase, settings.sensitivity)];
		const create = this.deps.createDetector ?? createWakeDetector;
		const detector = create({
			getPhrases: () => phrases,
			debounceMs: settings.debounceMs,
			createScorer: wakeScorerFactory(settings.engine ?? 'classifier'),
			onWake: (detection) => this.onWake(detection),
		});

		await this.deps.requestMicPermission();
		this.deps.ensureAudioHost();
		await detector.start();
		if (!detector.isArmed) {
			// The gate said yes and the model still would not load. Do not hold a
			// microphone open with nothing listening behind it.
			await detector.stop();
			logger.warn('Hands-free wake word could not load its model', LOG_CONTEXT);
			return;
		}
		if (this.disposed || (await this.refusalReason())) {
			await detector.stop();
			return;
		}
		this.detector = detector;
		this.armedKey = armKey(settings);
		this.deps.startCapture();
		logger.info(`Hands-free wake word listening for "${phrases[0].phrase}"`, LOG_CONTEXT);
	}

	private async disarm(options: { closeMicrophone: boolean }): Promise<void> {
		const detector = this.detector;
		if (!detector) return;
		this.detector = null;
		this.armedKey = null;
		await detector.stop();
		if (options.closeMicrophone) this.deps.stopCapture();
	}

	private onWake(detection: WakeDetection): void {
		logger.info(
			`Hands-free wake: "${detection.phrase}" (${detection.score.toFixed(2)}) opening a session`,
			LOG_CONTEXT
		);
		// Stop scoring but keep the microphone open: the session takes over the
		// stream that is already flowing.
		void this.disarm({ closeMicrophone: false }).then(async () => {
			try {
				await this.deps.startSession();
			} catch (err) {
				logger.warn(
					`Hands-free wake could not open a session: ${(err as Error).message}`,
					LOG_CONTEXT
				);
			}
			// Whatever happened, re-evaluate: a refused start leaves the session idle,
			// and the listener must re-arm rather than go deaf.
			await this.sync();
		});
	}
}

const SESSION_ACTIVE = 'a voice session holds the floor';
const MICROPHONE_BORROWED = 'another feature is using the microphone';

/** What a detector is built from; when this changes the armed one is stale. */
function armKey(settings: HandsFreeSettings): string {
	return [
		settings.phrase ?? '',
		settings.engine ?? 'classifier',
		settings.sensitivity ?? '',
		settings.modelRevision ?? '',
	].join('|');
}
