/**
 * PCM plumbing shared by the providers.
 *
 * The capture path produces 16 kHz mono `Int16Array` frames (see
 * `src/shared/acappella/audio-host.ts`), and two providers need that same audio
 * in a different wrapper: a hosted STT wants an uploadable container, and a local
 * recogniser wants one contiguous float buffer. Both conversions are three lines
 * of arithmetic that are wrong in an interesting way if you get the endianness or
 * the divisor off by one, so they live here once with the reason attached.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../shared/acappella/audio-host';

/** Bytes of a canonical 44-byte PCM WAV header. */
const WAV_HEADER_BYTES = 44;

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

/**
 * Wrap 16-bit mono samples in a WAV container.
 *
 * A container rather than raw PCM because every hosted transcription endpoint
 * takes a file and infers the format from it; posting bare samples means also
 * posting a sample rate in a side channel that half of them ignore.
 */
export function encodeWav(pcm: Int16Array, sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE): Uint8Array {
	const dataBytes = pcm.length * 2;
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);

	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // PCM header length
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels: mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate: rate * blockAlign
	view.setUint16(32, 2, true); // block align: 1 channel * 16 bit
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataBytes, true);

	// Little-endian explicitly. `new Uint8Array(pcm.buffer)` would inherit the
	// host's endianness, which is right on every machine Maestro ships for and
	// wrong in a way nobody would find until it was.
	for (let i = 0; i < pcm.length; i++) {
		view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i], true);
	}

	return new Uint8Array(buffer);
}

/** 16-bit samples to the -1..1 floats every inference runtime expects. */
export function int16ToFloat32(pcm: Int16Array): Float32Array {
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) {
		// 32768 for negatives and 32767 for positives is the pedantically correct
		// pair; using one divisor for both is standard and keeps the waveform
		// symmetric, which matters more than the half-LSB.
		out[i] = pcm[i] / 32768;
	}
	return out;
}

/**
 * Linear resample between two rates.
 *
 * Linear interpolation, not a windowed filter, and that is a deliberate ceiling:
 * this exists for the 16 kHz capture path feeding a service that insists on
 * 24 kHz, where the content is speech that was band-limited at 8 kHz before it
 * ever got here. There is nothing above the old Nyquist for a better kernel to
 * preserve, and a proper resampler in the per-frame hot path would cost more than
 * it could possibly recover.
 */
export function resampleLinear(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
	if (fromRate === toRate || pcm.length === 0) return pcm;

	const ratio = toRate / fromRate;
	const out = new Int16Array(Math.max(1, Math.round(pcm.length * ratio)));

	for (let i = 0; i < out.length; i++) {
		const position = i / ratio;
		const left = Math.floor(position);
		const right = Math.min(pcm.length - 1, left + 1);
		const fraction = position - left;
		out[i] = Math.round(pcm[left] * (1 - fraction) + pcm[right] * fraction);
	}

	return out;
}

/** Floats back to 16-bit samples, clamped. The TTS side of the same conversion. */
export function float32ToInt16(samples: Float32Array): Int16Array {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const clamped = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
		out[i] = Math.round(clamped * 32767);
	}
	return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
