/**
 * A Cappella PCM worklet - downmix, resample, quantise, emit.
 *
 * Runs on the audio rendering thread inside `AudioWorkletGlobalScope`. It takes
 * whatever the microphone gives us (48 kHz stereo on most machines, 44.1 kHz on
 * some, 16 kHz on a headset that already speaks our language) and posts fixed
 * 20 ms frames of 16 kHz signed 16-bit mono to the main thread.
 *
 * **The resampling happens here, not on the main thread, on purpose.** The audio
 * thread is real-time scheduled and cannot be blocked by React rendering, a
 * garbage collection pause, or a busy IPC queue. Doing the same arithmetic in a
 * `message` handler would make every dropout in the renderer an audible hole in
 * the transcript, and STT accuracy falls off a cliff with missing audio.
 *
 * Loaded as a URL rather than imported: `capture.ts` hands
 * `AudioWorklet.addModule()` the bundled chunk that Vite emits for this file
 * (`?worker&url`). Importing it directly would link it into the main renderer
 * chunk, where `AudioWorkletProcessor` does not exist.
 */

import {
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	ACAPPELLA_PCM_WORKLET_NAME,
} from '../../shared/acappella/audio-host';

/**
 * The handful of `AudioWorkletGlobalScope` globals we use. They are not in
 * TypeScript's DOM lib, and declaring them with `declare` would leak them into
 * every renderer file, so they are read off `globalThis` through a local type
 * instead.
 */
interface AudioWorkletScope {
	/** The AudioContext's rate, fixed for the life of the processor. */
	readonly sampleRate: number;
	/** Start of the current render quantum, in the context's clock. */
	readonly currentTime: number;
	registerProcessor(name: string, processorCtor: unknown): void;
	readonly AudioWorkletProcessor: {
		new (options?: unknown): { readonly port: MessagePort };
	};
}

const scope = globalThis as unknown as AudioWorkletScope;
const { AudioWorkletProcessor, registerProcessor, sampleRate } = scope;

/** What the worklet posts per frame. `capture.ts` stamps seq and wall time. */
export interface PcmWorkletFrameMessage {
	/** Signed 16-bit little-endian mono samples, transferred (not copied). */
	pcm: ArrayBuffer;
	/** Root mean square over the frame, 0 to 1. */
	rms: number;
	/** Context time at emit, for deriving a wall clock without per-frame `Date.now()`. */
	t: number;
}

interface PcmProcessorOptions {
	processorOptions?: {
		targetSampleRate?: number;
		frameSamples?: number;
	};
}

class PcmDownsampleProcessor extends AudioWorkletProcessor {
	/** Input samples consumed per output sample. 3 for 48 kHz -> 16 kHz. */
	private readonly ratio: number;
	private readonly frameSamples: number;
	private readonly frame: Int16Array;
	private frameFill = 0;
	private sumSquares = 0;

	/**
	 * Fractional read position into the CURRENT block. Carried across blocks (it
	 * goes negative, meaning "between the last sample of the previous block and
	 * the first of this one") so the output has no periodic seam at the 128-sample
	 * render quantum boundary. A seam every 2.6 ms is audible as a buzz and is
	 * exactly the artefact naive per-block resamplers produce.
	 */
	private readPos = 0;
	/** Last sample of the previous block, the left neighbour when `readPos` is negative. */
	private tail = 0;

	private mono: Float32Array = new Float32Array(0);

	constructor(options?: PcmProcessorOptions) {
		super();
		const targetRate = options?.processorOptions?.targetSampleRate ?? ACAPPELLA_AUDIO_SAMPLE_RATE;
		this.frameSamples = options?.processorOptions?.frameSamples ?? ACAPPELLA_AUDIO_FRAME_SAMPLES;
		this.ratio = sampleRate / targetRate;
		this.frame = new Int16Array(this.frameSamples);
	}

	process(inputs: Float32Array[][]): boolean {
		const channels = inputs[0];
		// No input yet (the graph is still connecting) or the track ended. Staying
		// alive is right either way: returning false would retire the processor and
		// the node would have to be rebuilt to resume.
		if (!channels || channels.length === 0) return true;

		const blockLength = channels[0].length;
		if (blockLength === 0) return true;

		const mono = this.downmix(channels, blockLength);
		const last = blockLength - 1;

		while (this.readPos <= last) {
			const index = Math.floor(this.readPos);
			const frac = this.readPos - index;
			const left = index < 0 ? this.tail : mono[index];
			// When `index === last` the right neighbour lives in the next block, but
			// `frac` is 0 there, so `left` is the exact answer.
			const right = index + 1 <= last ? mono[index + 1] : left;
			this.push(left + (right - left) * frac);
			this.readPos += this.ratio;
		}

		this.tail = mono[last];
		this.readPos -= blockLength;
		return true;
	}

	/** Average the channels into a reusable scratch buffer. */
	private downmix(channels: Float32Array[], blockLength: number): Float32Array {
		if (channels.length === 1) return channels[0];

		if (this.mono.length !== blockLength) this.mono = new Float32Array(blockLength);
		const mono = this.mono;
		mono.set(channels[0]);
		for (let c = 1; c < channels.length; c++) {
			const channel = channels[c];
			for (let i = 0; i < blockLength; i++) mono[i] += channel[i];
		}
		const scale = 1 / channels.length;
		for (let i = 0; i < blockLength; i++) mono[i] *= scale;
		return mono;
	}

	private push(sample: number): void {
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		this.sumSquares += clamped * clamped;
		// Asymmetric scaling: two's complement reaches -32768 but only +32767, so
		// scaling both directions by 32768 would clip every full-scale positive peak.
		this.frame[this.frameFill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		if (this.frameFill === this.frameSamples) this.emit();
	}

	private emit(): void {
		const rms = Math.sqrt(this.sumSquares / this.frameSamples);
		// Copy, then transfer the copy: the processor keeps reusing `this.frame`,
		// and transferring it would detach the buffer we are about to write into.
		const pcm = this.frame.slice();
		const message: PcmWorkletFrameMessage = { pcm: pcm.buffer, rms, t: scope.currentTime };
		this.port.postMessage(message, [pcm.buffer]);
		this.frameFill = 0;
		this.sumSquares = 0;
	}
}

registerProcessor(ACAPPELLA_PCM_WORKLET_NAME, PcmDownsampleProcessor);
