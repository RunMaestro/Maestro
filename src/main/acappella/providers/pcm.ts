/**
 * The utterance buffer the providers share.
 *
 * The capture path produces 16 kHz mono `Int16Array` frames (see
 * `src/shared/acappella/audio-host.ts`), and two providers need that same audio
 * in a different wrapper: a hosted STT wants an uploadable container, and a local
 * recogniser wants one contiguous float buffer. The conversions themselves are
 * pure arithmetic and live in `src/shared/audio/pcm.ts`, where the core Local
 * Models speech-to-text service reads them too; they are re-exported here so a
 * provider keeps one import site.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../shared/acappella/audio-host';
import { encodeWav, int16ToFloat32 } from '../../../shared/audio/pcm';

export {
	decodeWavPcm16,
	encodeWav,
	float32ToInt16,
	int16ToFloat32,
	resampleLinear,
} from '../../../shared/audio/pcm';

/**
 * Accumulates capture frames for a provider that transcribes an utterance rather
 * than a stream.
 *
 * Bounded on purpose: a microphone left open by a forgotten session must not grow
 * a buffer until the process dies. Past the cap the OLDEST audio is dropped,
 * because for speech recognition the end of an utterance is the part that matters
 * and the alternative (dropping the newest) would silently truncate what the user
 * just said.
 */
export class PcmBuffer {
	private readonly chunks: Int16Array[] = [];
	private samples = 0;

	constructor(
		private readonly maxSamples: number = ACAPPELLA_AUDIO_SAMPLE_RATE * 60,
		readonly sampleRate: number = ACAPPELLA_AUDIO_SAMPLE_RATE
	) {}

	get length(): number {
		return this.samples;
	}

	get durationMs(): number {
		return Math.round((this.samples / this.sampleRate) * 1000);
	}

	push(pcm: Int16Array): void {
		if (pcm.length === 0) return;
		// Copied, not retained: the capture path reuses its frame buffers, so
		// keeping the reference would hand the transcriber whatever audio happened
		// to be in that slot later.
		this.chunks.push(Int16Array.from(pcm));
		this.samples += pcm.length;
		this.trim();
	}

	clear(): void {
		this.chunks.length = 0;
		this.samples = 0;
	}

	/**
	 * Drop the oldest audio until at most `maxSamples` remain.
	 *
	 * For a recogniser holding a little context ahead of the first word: a room
	 * that has been quiet for a minute must not turn into a minute of silence in
	 * front of the utterance, which is slower to decode and easier to hallucinate
	 * over. Whole frames are dropped, so the tail may sit a frame under the cap.
	 */
	keepLast(maxSamples: number): void {
		while (this.chunks.length > 1 && this.samples - this.chunks[0].length >= maxSamples) {
			const dropped = this.chunks.shift();
			this.samples -= dropped?.length ?? 0;
		}
	}

	/** Everything buffered, as one contiguous buffer. Does not clear. */
	toInt16(): Int16Array {
		const out = new Int16Array(this.samples);
		let offset = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	/** Everything buffered as normalised floats, which is what whisper.cpp takes. */
	toFloat32(): Float32Array {
		return int16ToFloat32(this.toInt16());
	}

	/** Everything buffered as an uploadable WAV. Does not clear. */
	toWav(): Uint8Array {
		return encodeWav(this.toInt16(), this.sampleRate);
	}

	private trim(): void {
		while (this.samples > this.maxSamples && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			this.samples -= dropped?.length ?? 0;
		}
	}
}
