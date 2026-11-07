/**
 * Cuts a microphone stream into bursts of speech.
 *
 * A burst is one stretch of talking with silence either side: a wake phrase, a
 * short command, one repetition of a phrase being recorded. Two callers need
 * exactly that and had no business each owning a copy of the bookkeeping: the
 * transcription wake engine decodes the start of every burst looking for the
 * phrase, and wake phrase enrollment keeps each burst as one recording.
 *
 * Built on the voice activity detector, which says when speech starts and ends.
 * What this adds is the audio: a little of the silence BEFORE the onset (the
 * detector needs a few frames to be sure, and those frames are the first
 * syllable), everything up to the endpoint, and a cap, so a monologue is handed
 * over once at the cap rather than buffered until the speaker stops.
 */

import { SPEECH_SAMPLE_RATE } from '../../../shared/audio/pcm';
import { VoiceActivityDetector, type VadConfig, type VadFrameResult } from './vad';

/** One stretch of speech. */
export interface SpeechBurst {
	/** The audio: lead-in, speech, and the silence that ended it. 16 kHz mono. */
	pcm: Int16Array;
	/**
	 * True when the burst hit the cap and was handed over while the speaker was
	 * still talking. The audio is the START of what they said.
	 */
	truncated: boolean;
	/** How long the speech itself lasted. Only known for a burst that ended on its own. */
	speechMs?: number;
}

export interface SpeechBurstSegmenterOptions {
	/** Audio kept ahead of speech onset, so the first syllable is not clipped. */
	preSpeechMs: number;
	/** Longest burst handed over. Past this the burst is cut and the rest ignored. */
	maxBurstMs: number;
	/** Overrides for the detector, for a caller whose bursts end sooner or later than a turn does. */
	vad?: Partial<VadConfig>;
	/** A burst is ready. Called once per burst: at the cap, or when the speech ends. */
	onBurst: (burst: SpeechBurst) => void;
}

export class SpeechBurstSegmenter {
	private readonly vad: VoiceActivityDetector;
	private readonly preSpeechSamples: number;
	private readonly maxBurstSamples: number;
	/** Recent silence, so a burst starts a little before its onset. */
	private lead: Int16Array[] = [];
	private leadSamples = 0;
	/** The burst being collected, or null between bursts. */
	private burst: Int16Array[] | null = null;
	private burstSamples = 0;
	/** Whether this burst was already handed over at the cap. */
	private handedOver = false;

	constructor(private readonly options: SpeechBurstSegmenterOptions) {
		this.vad = new VoiceActivityDetector(options.vad);
		this.preSpeechSamples = (options.preSpeechMs / 1000) * SPEECH_SAMPLE_RATE;
		this.maxBurstSamples = (options.maxBurstMs / 1000) * SPEECH_SAMPLE_RATE;
	}

	/** True between a speech onset and its endpoint. */
	get inSpeech(): boolean {
		return this.burst !== null;
	}

	/** Forget the burst in progress and the detector's memory of the room. */
	reset(): void {
		this.vad.reset();
		this.lead = [];
		this.leadSamples = 0;
		this.burst = null;
		this.burstSamples = 0;
		this.handedOver = false;
	}

	/**
	 * One 20 ms capture frame.
	 *
	 * @returns The detector's reading of the frame, for a caller that also wants
	 *          the level.
	 */
	pushFrame(frame: Int16Array): VadFrameResult {
		const result = this.vad.process(frame);
		// Copied: the caller's frame is usually a view over a buffer it reuses.
		const copy = Int16Array.from(frame);

		if (this.burst) {
			if (!this.handedOver) {
				this.burst.push(copy);
				this.burstSamples += copy.length;
			}
			if (!this.handedOver && this.burstSamples >= this.maxBurstSamples) {
				// Cut at the cap: whatever the caller wants is at the start.
				this.handedOver = true;
				this.options.onBurst({ pcm: this.take(), truncated: true });
			}
			if (result.event?.type === 'speech-end') {
				if (!this.handedOver) {
					this.options.onBurst({
						pcm: this.take(),
						truncated: false,
						speechMs: result.event.durationMs,
					});
				}
				this.burst = null;
				this.burstSamples = 0;
				this.handedOver = false;
			}
			return result;
		}

		if (result.event?.type === 'speech-start') {
			this.burst = [...this.lead, copy];
			this.burstSamples = this.leadSamples + copy.length;
			this.handedOver = false;
			this.lead = [];
			this.leadSamples = 0;
			return result;
		}

		this.lead.push(copy);
		this.leadSamples += copy.length;
		while (this.leadSamples > this.preSpeechSamples && this.lead.length > 1) {
			this.leadSamples -= this.lead.shift()!.length;
		}
		return result;
	}

	/** The collected burst as one array. */
	private take(): Int16Array {
		const out = new Int16Array(this.burstSamples);
		let offset = 0;
		for (const chunk of this.burst ?? []) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}
