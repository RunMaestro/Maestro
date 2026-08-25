/**
 * TTS playback for the A Cappella audio host.
 *
 * One `AudioContext` output chain shared with capture, which is what gives
 * Chromium's echo canceller a reference signal to subtract: the assistant's own
 * voice is removed from the microphone input, so the mic can stay open while it
 * speaks and barge-in detection never fires on our own audio.
 *
 * Two operations carry the barge-in guarantee:
 *
 *   - {@link TtsPlayback.duck} ramps the output down so the user's voice wins
 *     the room while the pipeline decides whether they meant to interrupt.
 *   - {@link TtsPlayback.flush} stops every scheduled source immediately and
 *     drops everything queued. Not "stop scheduling new audio" - already
 *     scheduled buffers keep playing, and the felt latency of an interruption is
 *     exactly how long the last one runs.
 */

import {
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	type AudioHostStatus,
	type PlaybackFormat,
} from '../../shared/acappella/audio-host';

export interface PlaybackChunk {
	utteranceId: string;
	format: PlaybackFormat;
	/** Required for `pcm16`. Ignored for `encoded`, where the container decides. */
	sampleRate?: number;
	data: ArrayBuffer;
}

export interface TtsPlaybackOptions {
	context: AudioContext;
	onStatus: (status: AudioHostStatus) => void;
}

/** Signed 16-bit little-endian mono -> the float samples an AudioBuffer wants. */
export function pcm16ToFloat32(data: ArrayBuffer): Float32Array {
	const source = new Int16Array(data);
	const out = new Float32Array(source.length);
	for (let i = 0; i < source.length; i++) {
		// Mirrors the worklet's asymmetric quantisation, so a round trip is lossless.
		out[i] = source[i] < 0 ? source[i] / 0x8000 : source[i] / 0x7fff;
	}
	return out;
}

/** Long enough that a volume change is a fade rather than a click. */
const VOLUME_RAMP_MS = 40;

export class TtsPlayback {
	private readonly options: TtsPlaybackOptions;
	private readonly gain: GainNode;
	/** The user's output volume. Ducking multiplies this; a flush restores it. */
	private volume = 1;
	private readonly sources = new Set<AudioBufferSourceNode>();
	/** Context time the next chunk starts at, so consecutive chunks are gapless. */
	private nextStartTime = 0;
	private currentUtteranceId: string | null = null;
	/** Utterances main has said it is done sending chunks for. */
	private readonly endedUtterances = new Set<string>();
	private pendingDecodes = 0;
	/**
	 * Bumped by {@link flush}. A decode that started before a flush resolves after
	 * it, and scheduling that buffer would resurrect audio the user just talked
	 * over - the single most jarring failure this class can have.
	 */
	private generation = 0;
	private disposed = false;

	constructor(options: TtsPlaybackOptions) {
		this.options = options;
		this.gain = options.context.createGain();
		this.gain.connect(options.context.destination);
	}

	/**
	 * The node every scheduled chunk passes through on its way to the speakers.
	 *
	 * Exposed so the WebRTC leg can tap the SAME output the local speakers hear
	 * (`peer-connection.ts` wires it into a `MediaStreamAudioDestinationNode`).
	 * Tapping here rather than re-synthesising per device is what guarantees a
	 * phone hears the voice the user configured, at the volume they set, with the
	 * same ducking - one TTS run, two places it comes out.
	 */
	get outputNode(): AudioNode {
		return this.gain;
	}

	/** Audio scheduled but not yet heard. Bounds how late a barge-in can land. */
	get queuedMs(): number {
		return Math.max(0, (this.nextStartTime - this.options.context.currentTime) * 1000);
	}

	get playing(): boolean {
		return this.sources.size > 0 || this.pendingDecodes > 0;
	}

	/** Decode a chunk and schedule it after everything already queued. */
	async enqueue(chunk: PlaybackChunk): Promise<void> {
		if (this.disposed) return;
		const generation = this.generation;
		this.currentUtteranceId = chunk.utteranceId;
		this.endedUtterances.delete(chunk.utteranceId);
		this.pendingDecodes += 1;
		this.emitState();

		let buffer: AudioBuffer;
		try {
			buffer = await this.decode(chunk);
		} finally {
			this.pendingDecodes -= 1;
		}

		// Flushed (or disposed) while decoding: this audio belongs to a run the user
		// already interrupted.
		if (this.disposed || generation !== this.generation) {
			this.emitState();
			return;
		}
		this.schedule(buffer);
	}

	/**
	 * No more chunks are coming for `utteranceId`. Playback keeps running; this
	 * only lets the drain report an honest idle instead of a maybe-more-coming
	 * pause.
	 */
	endUtterance(utteranceId: string): void {
		this.endedUtterances.add(utteranceId);
		if (this.playing) return;
		// Already drained before the end marker arrived (a short final sentence):
		// close it out here, or nothing else ever will.
		if (this.currentUtteranceId === utteranceId) {
			this.endedUtterances.delete(utteranceId);
			this.currentUtteranceId = null;
		}
		this.emitState();
	}

	/**
	 * Stop now and discard the queue.
	 *
	 * Gain is restored to the USER'S volume here, not to 1. Ducking only has
	 * meaning while something is playing, so leaving a barge-in's duck in place
	 * would make the next utterance come out inaudible with nothing on screen to
	 * explain it - and restoring to full would just as silently undo a mute.
	 */
	flush(): void {
		this.generation += 1;
		for (const source of this.sources) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// Already stopped or never started; disconnecting is all that is left.
			}
			source.disconnect();
		}
		this.sources.clear();
		this.nextStartTime = 0;
		this.currentUtteranceId = null;
		this.endedUtterances.clear();
		this.setGain(this.volume, 0);
		this.emitState();
	}

	/**
	 * Ramp output gain to `gain` (0 to 1) over `ms`, RELATIVE to the user's volume.
	 *
	 * Relative rather than absolute because ducking to 0.2 means "a fifth as loud
	 * as whatever we were", and a duck that jumped to an absolute 0.2 would make
	 * a barge-in LOUDER for anyone running the assistant quietly.
	 */
	duck(gain: number, ms: number): void {
		this.setGain(this.volume * Math.min(1, Math.max(0, gain)), Math.max(0, ms));
	}

	/**
	 * Set the base output volume (0 to 1).
	 *
	 * Applied with a short ramp rather than instantly: a step change in gain on a
	 * playing buffer is an audible click, and the one thing a volume control must
	 * not do is make a noise of its own.
	 */
	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
		this.setGain(this.volume, VOLUME_RAMP_MS);
	}

	dispose(): void {
		if (this.disposed) return;
		this.flush();
		this.disposed = true;
		this.gain.disconnect();
	}

	private setGain(value: number, ms: number): void {
		const now = this.options.context.currentTime;
		const param = this.gain.gain;
		param.cancelScheduledValues(now);
		// Pin the current value first: without it the ramp starts from whatever was
		// last *scheduled*, which jumps when a duck interrupts a duck.
		param.setValueAtTime(param.value, now);
		if (ms <= 0) param.setValueAtTime(value, now);
		else param.linearRampToValueAtTime(value, now + ms / 1000);
	}

	private async decode(chunk: PlaybackChunk): Promise<AudioBuffer> {
		const { context } = this.options;
		if (chunk.format === 'encoded') return context.decodeAudioData(chunk.data);

		const samples = pcm16ToFloat32(chunk.data);
		const rate = chunk.sampleRate ?? ACAPPELLA_AUDIO_SAMPLE_RATE;
		// A buffer whose rate differs from the context's is resampled by the source
		// node on playback, so a 22 kHz local voice needs no work here.
		const buffer = context.createBuffer(1, samples.length, rate);
		buffer.getChannelData(0).set(samples);
		return buffer;
	}

	private schedule(buffer: AudioBuffer): void {
		const { context } = this.options;
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.gain);

		const startAt = Math.max(context.currentTime, this.nextStartTime);
		source.start(startAt);
		this.nextStartTime = startAt + buffer.duration;
		this.sources.add(source);

		source.onended = () => {
			source.disconnect();
			this.sources.delete(source);
			if (!this.playing) {
				this.nextStartTime = 0;
				// Only forget the utterance once main has said no more chunks are
				// coming. A streaming TTS run drains between sentences, and reporting
				// "nothing is speaking" in that gap would let the pipeline close a
				// speech run that is still mid-sentence.
				if (this.currentUtteranceId && this.endedUtterances.has(this.currentUtteranceId)) {
					this.endedUtterances.delete(this.currentUtteranceId);
					this.currentUtteranceId = null;
				}
			}
			this.emitState();
		};
		this.emitState();
	}

	private emitState(): void {
		this.options.onStatus({
			kind: 'playback-state',
			playing: this.playing,
			utteranceId: this.currentUtteranceId,
			queuedMs: this.queuedMs,
		});
	}
}
