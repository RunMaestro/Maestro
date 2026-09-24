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

/**
 * Read 16-bit PCM out of a WAV file.
 *
 * The inverse of {@link encodeWav}, for the system voice: every OS speech engine
 * hands its audio back as a WAV, and the chunk walk matters because they do not
 * all put `fmt ` first (macOS `say` writes a `JUNK` chunk ahead of it). Only
 * 16-bit integer PCM is accepted; anything else is a bug in the caller's engine
 * arguments, not something to guess a decode for. A stereo file keeps its first
 * channel, since speech engines are mono and the odd stereo one carries the same
 * signal twice.
 */
export function decodeWavPcm16(bytes: Uint8Array): { sampleRate: number; pcm: Int16Array } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, length: number): string => {
		let out = '';
		for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
		return out;
	};
	if (bytes.byteLength < 12 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
		throw new Error('Not a WAV file');
	}

	let format = 0;
	let channels = 0;
	let sampleRate = 0;
	let bits = 0;
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = ascii(offset, 4);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
			format = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bits = view.getUint16(body + 14, true);
		} else if (id === 'data') {
			if (format !== 1 || bits !== 16 || channels < 1 || sampleRate <= 0) {
				throw new Error(
					`Unsupported WAV: format ${format}, ${bits}-bit, ${channels} channel(s), ${sampleRate} Hz`
				);
			}
			// A streaming writer may leave the data size as 0 or 0xFFFFFFFF; the
			// file's real end is the honest bound either way.
			const available = bytes.byteLength - body;
			const dataBytes = size === 0 || size > available ? available : size;
			const frames = Math.floor(dataBytes / (2 * channels));
			const pcm = new Int16Array(frames);
			for (let i = 0; i < frames; i++) {
				pcm[i] = view.getInt16(body + i * channels * 2, true);
			}
			return { sampleRate, pcm };
		}
		// Chunks are word-aligned: an odd size is followed by one pad byte.
		offset = body + size + (size % 2);
	}
	throw new Error('WAV file has no data chunk');
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
