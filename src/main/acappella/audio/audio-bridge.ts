/**
 * A Cappella audio bridge - the composition root for real audio.
 *
 * Phase 02 built four self-contained pieces and deliberately wired none of them:
 * the pipeline (`audio-pipeline.ts`), the detector (`vad.ts`), the meter
 * (`level-meter.ts`), and the microphone projection (`mic-state.ts`). This is
 * where they meet the session service, and it is the only module that knows all
 * of them exist.
 *
 * What it owns, in one sentence each:
 *
 *   - **Capture follows the floor.** `listen-start` opens the microphone,
 *     `listen-stop` closes it, and the pipeline decides per frame whether the
 *     audio reaches the recogniser, the pre-roll, or the drop counter.
 *   - **A microphone is opened only for a provider that can hear.** The gate is
 *     `SttProvider.acceptsAudio`, not a list of provider ids: asking a user for a
 *     microphone permission on behalf of a text-in mock buys a level meter over a
 *     transcript that is never coming.
 *   - **Playback closes the duplex loop.** TTS chunks go out as `play` commands
 *     to the same audio host that captures, which is what gives Chromium's echo
 *     canceller a reference signal - and is therefore what makes it safe to keep
 *     the microphone open while the assistant speaks.
 *   - **Every audio fact becomes a protocol event.** The level meter and the
 *     microphone tracker publish through the session, so the HUD and the Phase 10
 *     phone read one ordered stream rather than two transports.
 *
 * Free of Electron: frames, statuses, and the command sink are injected. The IPC
 * layer owns the channels (see `src/main/ipc/handlers/acappella.ts`), and Phase
 * 10's phone will drive the same object with frames that arrived over WebRTC.
 */

import type {
	AudioFrame,
	AudioHostCommand,
	AudioHostErrorCode,
	AudioHostStatus,
	PlaybackFormat,
} from '../../../shared/acappella/audio-host';
import type { InterruptSource, MicState, VoiceEvent } from '../../../shared/acappella/protocol';
import type { SttProvider, TtsChunk } from '../../../shared/acappella/providers';
import type { VoiceSessionState } from '../../../shared/acappella/session-state';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { AudioPipeline, type AudioPipelineStats } from './audio-pipeline';
import { AudioLevelMeter, type AudioLevelMeterConfig } from './level-meter';
import { MicStateTracker } from './mic-state';
import type { VadConfig } from './vad';

const LOG_CONTEXT = 'ACappella';

/**
 * The slice of `VoiceSessionService` the bridge drives. Narrow on purpose: audio
 * publishes facts and performs exactly one action (barge-in). It never routes,
 * never speaks, and never starts or stops a session - that is floor control's.
 */
export interface AudioBridgeSession {
	getState(): VoiceSessionState;
	interrupt(source?: InterruptSource): boolean;
	subscribe(listener: (event: VoiceEvent) => void): () => void;
	getActiveStt(): SttProvider | null;
	publishAudioLevel(level: number, speech: boolean): void;
	publishMicState(state: MicState): void;
	reportAudioCaptureFailure(code: AudioHostErrorCode, message: string): void;
}

export interface VoiceAudioBridgeOptions {
	session: AudioBridgeSession;
	/** Sends one command to the audio host renderer. A closed host is a no-op. */
	sendCommand: (command: AudioHostCommand) => void;
	vad?: Partial<VadConfig>;
	/** Audio retained ahead of the floor opening. Clamped by the pipeline. */
	preRollMs?: number;
	meter?: Partial<AudioLevelMeterConfig>;
}

export class VoiceAudioBridge {
	private readonly options: VoiceAudioBridgeOptions;
	private readonly pipeline: AudioPipeline;
	private readonly meter: AudioLevelMeter;
	private readonly mic = new MicStateTracker();
	private readonly unsubscribe: () => void;

	/**
	 * Whether the host renderer has announced itself. Commands sent before that
	 * reach a window that is still loading its bundle and are lost, which matters
	 * for exactly one of them: the `start-capture` that a session start races.
	 */
	private hostReady = false;
	private disposed = false;

	constructor(options: VoiceAudioBridgeOptions) {
		this.options = options;
		this.meter = new AudioLevelMeter(options.meter);
		this.pipeline = new AudioPipeline({
			session: options.session,
			getStt: () => options.session.getActiveStt(),
			sendCommand: (command) => this.send(command),
			vad: options.vad,
			preRollMs: options.preRollMs,
			onFrame: ({ result }) => {
				const update = this.meter.push(result.rms, result.active);
				if (update) options.session.publishAudioLevel(update.level, update.speech);
			},
		});

		this.unsubscribe = options.session.subscribe((event) => this.handleEvent(event));
	}

	/** Counters for the current capture run. Every audio failure is otherwise silent. */
	getStats(): AudioPipelineStats {
		return this.pipeline.getStats();
	}

	/** One 20 ms frame from the audio host. */
	handleFrame(frame: AudioFrame): void {
		if (this.disposed) return;
		this.pipeline.handleFrame(frame);
	}

	/**
	 * One control-plane message from the audio host.
	 *
	 * Three consumers, in this order: the readiness latch (so a capture that was
	 * requested during boot is re-requested), the microphone projection (so a
	 * client can tell a quiet session from a deaf one), and the pipeline (so a
	 * device restart does not carry an open speech state across it).
	 */
	handleStatus(status: AudioHostStatus): void {
		if (this.disposed) return;

		if (status.kind === 'ready') this.onHostReady();

		const micState = this.mic.apply(status);
		if (micState) this.options.session.publishMicState(micState);

		if (status.kind === 'mic-error') {
			// A dead microphone must never present as a session that is merely quiet.
			this.options.session.reportAudioCaptureFailure(status.code, status.message);
		}

		if (status.kind === 'capture-stop' || status.kind === 'mic-error') this.meter.reset();

		this.pipeline.handleStatus(status);
	}

	/**
	 * Force the recogniser to endpoint now.
	 *
	 * The seam floor control's hold-to-talk release binds to: a user who let go of
	 * the key has already said the utterance is finished, so waiting out the VAD's
	 * endpoint silence would be latency bought with nothing.
	 */
	endUtterance(): void {
		const stt = this.options.session.getActiveStt();
		if (!stt) return;
		void stt.flush().catch((error: Error) => {
			// Endpointing is a hint. The recogniser still has the audio.
			void captureException(error, {
				context: 'acappella.audioBridge.endUtterance',
				providerId: stt.id,
			});
		});
	}

	/**
	 * Hand one chunk of synthesised speech to the audio host.
	 *
	 * Wired as the session's `onSpeechChunk`. Chunks with no samples behind them
	 * (the mock tier's `format: 'none'`) are dropped here rather than at the
	 * source: the session's job is to announce the sentence, and what is playable
	 * is the sink's question.
	 */
	handleSpeechChunk(chunk: TtsChunk): void {
		if (this.disposed) return;
		if (!chunk.audio || chunk.audio.byteLength === 0 || chunk.format === 'none') return;

		const format: PlaybackFormat = chunk.format === 'pcm16' ? 'pcm16' : 'encoded';
		if (format === 'pcm16' && !chunk.sampleRate) {
			// Raw samples with no rate cannot be played at all, and guessing one is how
			// a voice ends up an octave out. Dropping it is the honest failure.
			logger.warn(
				`Dropping pcm16 speech chunk with no sample rate (utterance ${chunk.utteranceId})`,
				LOG_CONTEXT
			);
			return;
		}

		this.send({
			kind: 'play',
			utteranceId: chunk.utteranceId,
			format,
			sampleRate: chunk.sampleRate,
			// Copied because the buffer crosses an IPC boundary and the provider may
			// well be reusing it for the next sentence.
			data: new Uint8Array(chunk.audio).buffer,
		});
	}

	/**
	 * Drop playback gain, for a barge-in the pipeline did not see coming.
	 *
	 * The pipeline already ducks on a CANDIDATE frame, before the detector has
	 * confirmed anything, which is what makes a spoken interruption feel instant.
	 * This is the other door: a client button, and the Phase 10 phone, where the
	 * first the audio path hears of it is that the session cancelled a run.
	 */
	duckPlayback(gain: number, ms: number): void {
		this.send({ kind: 'duck', gain, ms });
	}

	/** Discard audio already queued in the host. Audio the user talked over. */
	flushPlayback(): void {
		this.send({ kind: 'flush' });
	}

	/**
	 * Stop capture, release the host, and drop the subscription. Safe to repeat.
	 *
	 * The disposed flag is set LAST on purpose: `pipeline.dispose()` is what sends
	 * `stop-capture`, and a bridge that marked itself dead first would swallow the
	 * one message that closes the microphone.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.unsubscribe();
		this.pipeline.dispose();
		this.meter.reset();
		this.mic.reset();
		this.disposed = true;
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * Follow the session's own stream rather than being called at each site.
	 *
	 * The floor can open and close from places this module will never see: the
	 * wake word, a hotkey, the HUD button, a provider failure. Subscribing is what
	 * keeps "the microphone is open exactly while the session is listening" true no
	 * matter which of them did it.
	 */
	private handleEvent(event: VoiceEvent): void {
		switch (event.type) {
			case 'listen-start':
				this.startCapture();
				break;
			case 'listen-stop':
				this.pipeline.stop();
				this.meter.reset();
				break;
			case 'speak-end':
				// A completed run drains what is queued; anything else was cut off and
				// the queue is stale audio the user has already talked over.
				this.send(
					event.reason === 'complete'
						? { kind: 'end-utterance', utteranceId: event.utteranceId }
						: { kind: 'flush' }
				);
				break;
			default:
				break;
		}
	}

	/**
	 * Open the microphone, but only for a recogniser that consumes audio.
	 *
	 * The mock tier is text-in by construction. Opening a capture device for it
	 * would cost the user an OS permission prompt and give back a level meter over
	 * a transcript that is never coming, which is a worse lie than showing no meter
	 * at all.
	 */
	private startCapture(): void {
		const stt = this.options.session.getActiveStt();
		if (!stt?.acceptsAudio) {
			if (this.pipeline.isRunning) this.pipeline.stop();
			return;
		}
		this.pipeline.start();
	}

	/**
	 * The host renderer finished booting.
	 *
	 * The window is created on the first session start and the session reaches
	 * `listening` long before a renderer has loaded its bundle, so the first
	 * `start-capture` is normally sent into a window that cannot hear it yet.
	 * Re-requesting on `ready` costs one message and removes the race, which is
	 * cheaper than a command queue that would have to decide what a stale `duck` or
	 * `play` means once the host finally arrives.
	 */
	private onHostReady(): void {
		this.hostReady = true;
		if (!this.pipeline.isRunning) return;
		logger.debug('Audio host became ready mid-capture; re-requesting capture', LOG_CONTEXT);
		this.send({ kind: 'start-capture' });
	}

	private send(command: AudioHostCommand): void {
		if (this.disposed) return;
		// Before `ready` the host has no listener attached, so this would vanish.
		// `onHostReady` re-requests capture; nothing else is worth replaying.
		if (!this.hostReady && command.kind !== 'start-capture') return;
		this.options.sendCommand(command);
	}
}

export function createVoiceAudioBridge(options: VoiceAudioBridgeOptions): VoiceAudioBridge {
	return new VoiceAudioBridge(options);
}
