/**
 * Local text-to-speech on Kokoro, through ONNX Runtime.
 *
 * **Per sentence, and cancellable between sentences.** One inference run per
 * sentence means the first words are audible while the rest of the reply is still
 * being made, and `cancel()` has something small to interrupt. Barge-in that has
 * to wait out a whole synthesised paragraph does not feel like barge-in.
 *
 * **`cancel()` cuts the run, it does not wait for it.** The generator checks the
 * run token before every yield and after every await, so a cancelled run stops
 * delivering audio immediately even though the ONNX call it was inside has to
 * finish - ONNX Runtime has no mid-inference abort. The user hears silence at the
 * moment they interrupted, which is the property that matters; one orphaned
 * tensor is cheaper than a voice that talks over its interruption.
 *
 * ## The phoneme front end
 *
 * Kokoro takes PHONEME ids, not characters. Turning English text into phonemes is
 * a grapheme-to-phoneme step (espeak-ng, or the misaki front end Kokoro ships
 * with) and it is a real dependency, not a lookup table. This build does not have
 * one yet, so `phonemize` is an injected seam with no default: without it the
 * provider reports itself unavailable through the same classified path as a
 * missing model, and Voice Setup says so. It does NOT approximate. A character
 * level fallback would synthesise confident nonsense, and a voice reading nonsense
 * aloud is a worse failure than a voice that says nothing and explains why.
 */

import { KOKORO_82M_ID } from '../../../../shared/acappella/model-catalog';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { modelFilePath } from '../../models/model-store';
import { float32ToInt16 } from '../pcm';
import { loadLocalRuntime } from './runtime';

/** Catalog files this provider loads. */
const MODEL_FILE = 'onnx/model.onnx';

/**
 * The bundled voice. Kokoro voice packs are one file each, and only this one is
 * in the catalog, so it is the only id that can resolve without another download.
 */
const BUNDLED_VOICE = {
	id: 'af_heart',
	name: 'Heart (American English)',
	file: 'voices/af_heart.bin',
};

/** Kokoro outputs 24 kHz audio, whatever the capture path runs at. */
const KOKORO_SAMPLE_RATE = 24_000;

/**
 * A voice pack is a table of style vectors, one row per token count, each 256
 * floats wide. The row is picked by the length of the phoneme sequence.
 */
const STYLE_VECTOR_WIDTH = 256;

/** Kokoro's own bounds. Outside these the model produces artefacts, not speech. */
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

/** Turns text into the phoneme ids Kokoro's vocabulary uses. */
export type Phonemizer = (text: string) => Promise<number[]> | number[];

/** The ONNX Runtime surface this provider uses, structurally. */
interface OnnxTensor {
	data: Float32Array | BigInt64Array;
	dims: readonly number[];
}

interface OnnxSession {
	run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
	release?(): Promise<void>;
}

interface OnnxModule {
	InferenceSession: {
		create(path: string, options?: Record<string, unknown>): Promise<OnnxSession>;
	};
	Tensor: new (
		type: string,
		data: Float32Array | BigInt64Array,
		dims: readonly number[]
	) => OnnxTensor;
}

export interface KokoroTtsOptions {
	/** Required for real synthesis. See the module comment. */
	phonemize?: Phonemizer;
	modelPath?: string;
	voicePackPath?: string;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadLocalRuntime;
	/** Injected in tests. Production reads the installed voice pack from disk. */
	readVoicePack?: (path: string) => Promise<Float32Array>;
}

export class KokoroTtsProvider implements TtsProvider {
	readonly id = LOCAL_TTS_PROVIDER_ID;
	readonly label = 'Kokoro (local)';
	readonly tier = 'local' as const;

	private readonly phonemize?: Phonemizer;
	private readonly modelPathOverride?: string;
	private readonly voicePackPathOverride?: string;
	private readonly loadRuntime: typeof loadLocalRuntime;
	private readonly readVoicePack: (path: string) => Promise<Float32Array>;

	/** Bumped by `cancel()` and by every new run, so a stale iterator returns. */
	private run = 0;
	private session: OnnxSession | null = null;
	private tensorFactory: OnnxModule['Tensor'] | null = null;
	private voicePack: Float32Array | null = null;
	/** In-flight load, so two sentences racing do not each open the model. */
	private loading: Promise<void> | null = null;

	constructor(options: KokoroTtsOptions = {}) {
		this.phonemize = options.phonemize;
		this.modelPathOverride = options.modelPath;
		this.voicePackPathOverride = options.voicePackPath;
		this.loadRuntime = options.loadRuntime ?? loadLocalRuntime;
		this.readVoicePack = options.readVoicePack ?? readVoicePackFromDisk;
	}

	/** The voices this install can actually speak with, for the picker. */
	listVoices(): Array<{ id: string; name: string }> {
		return [{ id: BUNDLED_VOICE.id, name: BUNDLED_VOICE.name }];
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		// The run is claimed here, not in the generator body: a generator does not
		// start until its first `next()`, and a second `speak()` must supersede the
		// first immediately.
		return this.stream(splitIntoSpokenSentences(text), ++this.run, options);
	}

	cancel(): void {
		this.run += 1;
	}

	/** Release the session. Called when the pipeline is torn down or swapped. */
	async dispose(): Promise<void> {
		this.cancel();
		const session = this.session;
		this.session = null;
		this.voicePack = null;
		this.loading = null;
		try {
			await session?.release?.();
		} catch {
			// A session that will not close must not wedge a provider swap.
		}
	}

	// -- Internals -----------------------------------------------------------

	private async *stream(
		sentences: string[],
		run: number,
		options: TtsSpeakOptions
	): AsyncGenerator<TtsChunk> {
		if (sentences.length === 0) return;
		await this.ensureLoaded();
		if (this.run !== run) return;

		for (let index = 0; index < sentences.length; index++) {
			if (this.run !== run) return;

			const audio = await this.synthesize(sentences[index], options.rate);
			// Re-checked after the inference: a barge-in during synthesis must not
			// deliver the sentence it interrupted.
			if (this.run !== run) return;

			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentences[index],
				format: 'pcm16',
				audio,
				sampleRate: KOKORO_SAMPLE_RATE,
			};
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.session) return;
		this.loading ??= this.load();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	private async load(): Promise<void> {
		if (!this.phonemize) {
			throw new VoiceProviderError(
				'Local speech synthesis needs a phoneme front end, which is not part of this build yet. Switch Text-to-Speech to a hosted voice, or keep it on the mock until the front end ships.',
				{ kind: 'unavailable', providerId: this.id }
			);
		}

		const module = await this.loadRuntime<OnnxModule>('onnx', this.id);
		const modelPath = this.modelPathOverride ?? modelFilePath(KOKORO_82M_ID, MODEL_FILE);
		const voicePath =
			this.voicePackPathOverride ?? modelFilePath(KOKORO_82M_ID, BUNDLED_VOICE.file);

		try {
			this.session = await module.InferenceSession.create(modelPath);
			this.tensorFactory = module.Tensor;
			this.voicePack = await this.readVoicePack(voicePath);
		} catch (error) {
			this.session = null;
			throw new VoiceProviderError(
				'The Kokoro voice could not be opened. Re-verify it in Settings > Plugins > A Cappella > Models.',
				{ kind: 'unavailable', providerId: this.id, cause: error }
			);
		}
	}

	private async synthesize(sentence: string, rate?: number): Promise<Uint8Array> {
		const session = this.session;
		const Tensor = this.tensorFactory;
		const voicePack = this.voicePack;
		if (!session || !Tensor || !voicePack || !this.phonemize) {
			throw new VoiceProviderError('The local voice is not loaded.', {
				kind: 'unavailable',
				providerId: this.id,
			});
		}

		const tokens = await this.phonemize(sentence);
		const style = styleVectorFor(voicePack, tokens.length);
		const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, rate && rate > 0 ? rate : 1));

		const outputs = await session.run({
			// The leading and trailing zero are Kokoro's sequence boundary tokens.
			// Without them the first phoneme is clipped and the last is held.
			input_ids: new Tensor('int64', BigInt64Array.from([0n, ...tokens.map(BigInt), 0n]), [
				1,
				tokens.length + 2,
			]),
			style: new Tensor('float32', style, [1, STYLE_VECTOR_WIDTH]),
			speed: new Tensor('float32', Float32Array.from([speed]), [1]),
		});

		const waveform = Object.values(outputs)[0]?.data;
		if (!(waveform instanceof Float32Array)) {
			throw new VoiceProviderError('The local voice produced no audio for that sentence.', {
				kind: 'unavailable',
				providerId: this.id,
			});
		}

		const pcm = float32ToInt16(waveform);
		return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	}
}

// ---------------------------------------------------------------------------

/**
 * The style row for a phoneme sequence of this length.
 *
 * Clamped rather than trusted: a sentence longer than the pack has rows for would
 * read past the end of the buffer and produce a vector of whatever followed it in
 * memory, which comes out as a burst of noise at full volume in someone's
 * headphones.
 */
export function styleVectorFor(pack: Float32Array, tokenCount: number): Float32Array {
	const rows = Math.max(1, Math.floor(pack.length / STYLE_VECTOR_WIDTH));
	const row = Math.min(rows - 1, Math.max(0, tokenCount));
	const offset = row * STYLE_VECTOR_WIDTH;
	return pack.slice(offset, offset + STYLE_VECTOR_WIDTH);
}

/** Read a Kokoro voice pack: a flat little-endian float32 table. */
async function readVoicePackFromDisk(path: string): Promise<Float32Array> {
	const { readFile } = await import('fs/promises');
	const buffer = await readFile(path);
	return new Float32Array(
		buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
	);
}
