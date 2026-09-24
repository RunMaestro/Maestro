/**
 * Whisper's log-mel spectrogram, in plain TypeScript.
 *
 * This is the front half of local speech-to-text: Whisper's encoder does not
 * take audio, it takes an 80 x 3000 log-mel image, and every constant below is
 * dictated by the checkpoint rather than chosen here. Get one of them wrong and
 * nothing raises - the encoder happily consumes the wrong picture and the decoder
 * free-runs into a fluent, confident, entirely invented sentence. That failure
 * mode is why this file is pure, exported, and tested against reference features
 * rather than folded into the provider.
 *
 * **Why a Bluestein DFT and not a padded radix-2 FFT.** Whisper's `n_fft` is 400,
 * which is not a power of two. Zero-padding a 400-sample window into a 512-point
 * FFT is a DIFFERENT transform, not a cheaper one: the bins move from `SR/400` to
 * `SR/512` spacing, so every mel filter integrates the wrong frequencies. It
 * looks like it works - the first word or two decode correctly - and then the
 * transcript collapses into a repeating phrase. Bluestein's chirp-z gives the
 * exact 400-point DFT using a power-of-two FFT underneath, so the features are
 * right by construction instead of right to a tolerance.
 *
 * Everything here matches `WhisperFeatureExtractor`: a periodic Hann window,
 * reflect padding (`torch.stft(center=True, pad_mode='reflect')`), a Slaney mel
 * scale, log10 magnitudes, and the fixed `(max - 8)` floor and `(x + 4) / 4`
 * rescale that Whisper applies before the encoder sees anything.
 */

/** Sample rate the whole voice path runs at, and the only one Whisper accepts. */
export const WHISPER_SAMPLE_RATE = 16000;
/** Window length in samples. NOT a power of two - see the Bluestein note above. */
export const WHISPER_N_FFT = 400;
/** Hop between frames: 10 ms at 16 kHz. */
export const WHISPER_HOP_LENGTH = 160;
/** Mel bins the base/small checkpoints expect. */
export const WHISPER_N_MELS = 80;
/** Frames in one 30 s window. The encoder's input width is fixed at this. */
export const WHISPER_N_FRAMES = 3000;
/** Samples in one 30 s window. Shorter audio is zero-padded up to it. */
export const WHISPER_N_SAMPLES = WHISPER_SAMPLE_RATE * 30;

/** Slaney mel scale: linear below 1 kHz, logarithmic above it. */
const MEL_LINEAR_SLOPE = 200 / 3;
const MEL_LOG_START_HZ = 1000;
const MEL_LOG_START = MEL_LOG_START_HZ / MEL_LINEAR_SLOPE;
const MEL_LOG_STEP = Math.log(6.4) / 27;

function hzToMel(hz: number): number {
	if (hz >= MEL_LOG_START_HZ) {
		return MEL_LOG_START + Math.log(hz / MEL_LOG_START_HZ) / MEL_LOG_STEP;
	}
	return hz / MEL_LINEAR_SLOPE;
}

function melToHz(mel: number): number {
	if (mel >= MEL_LOG_START) {
		return MEL_LOG_START_HZ * Math.exp(MEL_LOG_STEP * (mel - MEL_LOG_START));
	}
	return mel * MEL_LINEAR_SLOPE;
}

/**
 * The mel filterbank, flattened to `N_MELS x nBins` row-major.
 *
 * Triangular filters on the Slaney scale, area-normalised the way librosa does
 * it (`norm='slaney'`), which is what the checkpoint was trained against.
 */
export function melFilterBank(
	nMels = WHISPER_N_MELS,
	nFft = WHISPER_N_FFT,
	sampleRate = WHISPER_SAMPLE_RATE
): Float32Array {
	const nBins = nFft / 2 + 1;
	const melMin = hzToMel(0);
	const melMax = hzToMel(sampleRate / 2);
	// nMels + 2 points: each filter needs a left foot, a peak, and a right foot,
	// and neighbours share feet.
	const points = new Float64Array(nMels + 2);
	for (let i = 0; i < points.length; i++) {
		points[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
	}

	const filters = new Float32Array(nMels * nBins);
	for (let m = 0; m < nMels; m++) {
		const left = points[m];
		const centre = points[m + 1];
		const right = points[m + 2];
		// Slaney normalisation: equal AREA per filter, so wide high-frequency
		// filters do not swamp narrow low-frequency ones.
		const scale = 2 / (right - left);
		for (let k = 0; k < nBins; k++) {
			const freq = (k * sampleRate) / nFft;
			const weight = Math.min((freq - left) / (centre - left), (right - freq) / (right - centre));
			if (weight > 0) filters[m * nBins + k] = weight * scale;
		}
	}
	return filters;
}

/** In-place iterative radix-2 complex FFT. `re`/`im` must be a power-of-two length. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			const tr = re[i];
			re[i] = re[j];
			re[j] = tr;
			const ti = im[i];
			im[i] = im[j];
			im[j] = ti;
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const angle = (-2 * Math.PI) / len;
		const stepRe = Math.cos(angle);
		const stepIm = Math.sin(angle);
		const half = len >> 1;
		for (let i = 0; i < n; i += len) {
			let wRe = 1;
			let wIm = 0;
			for (let k = 0; k < half; k++) {
				const uRe = re[i + k];
				const uIm = im[i + k];
				const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
				const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe;
				re[i + k] = uRe + vRe;
				im[i + k] = uIm + vIm;
				re[i + k + half] = uRe - vRe;
				im[i + k + half] = uIm - vIm;
				const nextRe = wRe * stepRe - wIm * stepIm;
				wIm = wRe * stepIm + wIm * stepRe;
				wRe = nextRe;
			}
		}
	}
}

/**
 * A reusable exact-DFT plan for one window size.
 *
 * The chirp table and the transformed convolution kernel depend only on `n`, so
 * they are built once and reused across all 3000 frames. Rebuilding them per
 * frame was the difference between a mel pass costing 140 ms and costing
 * several seconds.
 */
export interface DftPlan {
	readonly n: number;
	readonly m: number;
	readonly cos: Float64Array;
	readonly sin: Float64Array;
	readonly kernelRe: Float64Array;
	readonly kernelIm: Float64Array;
}

/** Build a Bluestein plan for an exact `n`-point DFT, for any `n`. */
export function createDftPlan(n: number): DftPlan {
	let m = 1;
	while (m < 2 * n - 1) m <<= 1;

	const cos = new Float64Array(n);
	const sin = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		// (i*i) mod 2n before the multiply: i*i overflows double precision's exact
		// integer range for large n, and the angle is periodic in 2n anyway.
		const angle = (Math.PI * ((i * i) % (2 * n))) / n;
		cos[i] = Math.cos(angle);
		sin[i] = Math.sin(angle);
	}

	const kernelRe = new Float64Array(m);
	const kernelIm = new Float64Array(m);
	kernelRe[0] = cos[0];
	kernelIm[0] = sin[0];
	for (let i = 1; i < n; i++) {
		kernelRe[i] = kernelRe[m - i] = cos[i];
		kernelIm[i] = kernelIm[m - i] = sin[i];
	}
	fftInPlace(kernelRe, kernelIm);

	return { n, m, cos, sin, kernelRe, kernelIm };
}

/**
 * Power spectrum (magnitude squared) of the first `n / 2 + 1` bins of `frame`.
 *
 * `frame` must be `plan.n` long and `out` must be `plan.n / 2 + 1` long. Both
 * are caller-owned so a 3000-frame pass allocates nothing per frame.
 */
export function dftPowerSpectrum(plan: DftPlan, frame: Float64Array, out: Float64Array): void {
	const { n, m, cos, sin, kernelRe, kernelIm } = plan;
	const re = new Float64Array(m);
	const im = new Float64Array(m);
	for (let i = 0; i < n; i++) {
		re[i] = frame[i] * cos[i];
		im[i] = -frame[i] * sin[i];
	}
	fftInPlace(re, im);

	// Multiply by the transformed chirp: convolution in the time domain.
	for (let i = 0; i < m; i++) {
		const r = re[i] * kernelRe[i] - im[i] * kernelIm[i];
		const j = re[i] * kernelIm[i] + im[i] * kernelRe[i];
		re[i] = r;
		im[i] = j;
	}

	// Inverse transform by conjugating either side of a forward transform.
	for (let i = 0; i < m; i++) im[i] = -im[i];
	fftInPlace(re, im);
	for (let i = 0; i < m; i++) {
		re[i] /= m;
		im[i] = -im[i] / m;
	}

	const bins = n / 2;
	for (let k = 0; k <= bins; k++) {
		const r = re[k] * cos[k] + im[k] * sin[k];
		const j = -re[k] * sin[k] + im[k] * cos[k];
		out[k] = r * r + j * j;
	}
}

/** A periodic Hann window, matching `torch.hann_window(periodic=True)`. */
export function hannWindow(size: number): Float64Array {
	const window = new Float64Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
	return window;
}

/**
 * Reusable scratch for repeated mel passes.
 *
 * Local speech-to-text re-transcribes the utterance so far roughly once a
 * second, so this runs constantly for the whole time someone is speaking.
 * Holding the plan, the filterbank, and the window across calls keeps a pass
 * allocation-light on a hot path.
 */
export class WhisperMelExtractor {
	private readonly plan: DftPlan;
	private readonly filters: Float32Array;
	private readonly window: Float64Array;
	private readonly nBins: number;

	constructor(
		private readonly nMels = WHISPER_N_MELS,
		private readonly nFft = WHISPER_N_FFT,
		private readonly hop = WHISPER_HOP_LENGTH,
		sampleRate = WHISPER_SAMPLE_RATE
	) {
		this.plan = createDftPlan(nFft);
		this.filters = melFilterBank(nMels, nFft, sampleRate);
		this.window = hannWindow(nFft);
		this.nBins = nFft / 2 + 1;
	}

	/**
	 * Log-mel features for `audio`, shaped `nMels x WHISPER_N_FRAMES` row-major.
	 *
	 * Audio longer than 30 s is TRUNCATED rather than chunked: the encoder's input
	 * width is fixed, and a caller that needs more must window it themselves.
	 */
	extract(audio: Float32Array): Float32Array {
		const padded = new Float32Array(WHISPER_N_SAMPLES);
		padded.set(audio.subarray(0, Math.min(audio.length, WHISPER_N_SAMPLES)));

		const mel = new Float32Array(this.nMels * WHISPER_N_FRAMES);
		const frame = new Float64Array(this.nFft);
		const power = new Float64Array(this.nBins);
		const pad = this.nFft / 2;

		// Reflect padding at both ends, matching `pad_mode='reflect'`. Indices are
		// mirrored rather than clamped, so the edge sample is not repeated.
		const sampleAt = (index: number): number => {
			let i = index;
			if (i < 0) i = -i;
			if (i >= WHISPER_N_SAMPLES) i = 2 * WHISPER_N_SAMPLES - 2 - i;
			return padded[i];
		};

		for (let t = 0; t < WHISPER_N_FRAMES; t++) {
			const start = t * this.hop - pad;
			for (let i = 0; i < this.nFft; i++) frame[i] = sampleAt(start + i) * this.window[i];
			dftPowerSpectrum(this.plan, frame, power);
			for (let m = 0; m < this.nMels; m++) {
				let sum = 0;
				const row = m * this.nBins;
				for (let k = 0; k < this.nBins; k++) sum += this.filters[row + k] * power[k];
				// 1e-10 floor before the log: silence is exactly zero power, and
				// log10(0) would poison the whole feature map with -Infinity.
				mel[m * WHISPER_N_FRAMES + t] = Math.log10(Math.max(sum, 1e-10));
			}
		}

		// Whisper's own normalisation: clamp to 8 decades below the loudest bin in
		// THIS window, then map to roughly [-1, 1]. Deliberately relative to the
		// window, which is what makes the model level-insensitive.
		let peak = -Infinity;
		for (let i = 0; i < mel.length; i++) if (mel[i] > peak) peak = mel[i];
		const floor = peak - 8;
		for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], floor) + 4) / 4;

		return mel;
	}
}
