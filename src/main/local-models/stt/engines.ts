/**
 * Which engine runs each catalog speech-to-text model.
 *
 * Parakeet and Whisper are different models with the same shape at this seam:
 * each opens a few ONNX graphs and transcribes a BUFFER of 16 kHz mono audio.
 * The inference lives beside this file (`parakeet/engine.ts`,
 * `whisper/engine.ts`); this is the one table that binds a catalog model id to
 * its engine, its files, and the longest buffer one pass accepts.
 *
 * One table, because three consumers open these models (a voice session's
 * recogniser, the transcription wake word, a dictated clip) and they must not
 * disagree about which files make up a model. They reach it through the shared
 * pool in `speech-to-text.ts`, never directly.
 */

import { readFile } from 'node:fs/promises';

import {
	getLocalModel,
	PARAKEET_TDT_V2_ID,
	WHISPER_BASE_EN_ID,
	WHISPER_BASE_ID,
	WHISPER_SMALL_ID,
} from '../../../shared/local-models/model-catalog';
import type { LocalModelEntry } from '../../../shared/local-models/types';
import { LocalModelError } from '../errors';
import { isInstalled, modelFilePath } from '../model-store';
import type { OnnxModule } from '../runtime/onnx-types';
import { runtimeSetupLocation } from '../runtime/runtime-consumers';
import { ParakeetEngine, PARAKEET_MAX_SAMPLES } from './parakeet/engine';
import { WhisperEngine, WHISPER_MAX_SAMPLES } from './whisper/engine';
import { WHISPER_MULTILINGUAL_SPECIAL_TOKENS } from './whisper/tokenizer';

/** Options belong to one decode, never to the shared resident engine. */
export interface SpeechToTextDecodeOptions {
	/** Literal vocabulary hints, preserved for decoders that support them. */
	vocabulary?: readonly string[];
	language?: string;
	signal?: AbortSignal;
}

/** What a local recogniser provides: open, close, and transcribe one buffer. */
export interface SpeechToTextEngine {
	load(module: OnnxModule): Promise<void>;
	unload(): Promise<void>;
	/** Transcribe 16 kHz mono audio. Returns trimmed text, empty for nothing. */
	transcribe(audio: Float32Array, options?: SpeechToTextDecodeOptions): Promise<string>;
}

interface SpeechToTextBinding {
	/** The longest buffer one pass accepts, in samples at 16 kHz. */
	readonly maxSamples: number;
	/** Build the engine over the model's files. `file` resolves a catalog path. */
	create(file: (relative: string) => string, consumerId: string): Promise<SpeechToTextEngine>;
}

/**
 * The catalog files each engine loads, by their path inside the model
 * directory. Named here rather than inlined so the set a decode needs and the
 * set the catalog downloads can be compared at a glance when either changes.
 */
const BINDINGS: Readonly<Record<string, SpeechToTextBinding>> = Object.freeze({
	[PARAKEET_TDT_V2_ID]: {
		maxSamples: PARAKEET_MAX_SAMPLES,
		create: async (file, consumerId) =>
			new ParakeetEngine({
				preprocessorPath: file('nemo128.onnx'),
				encoderPath: file('encoder-model.int8.onnx'),
				decoderJointPath: file('decoder_joint-model.int8.onnx'),
				vocabText: await readFile(file('vocab.txt'), 'utf8'),
				consumerId,
			}),
	},
	[WHISPER_BASE_EN_ID]: {
		// One encoder pass covers a fixed 30 s window.
		maxSamples: WHISPER_MAX_SAMPLES,
		create: async (file, consumerId) =>
			new WhisperEngine({
				encoderPath: file('onnx/encoder_model.onnx'),
				decoderPath: file('onnx/decoder_model_merged_q4.onnx'),
				tokenizerJson: await readFile(file('tokenizer.json'), 'utf8'),
				consumerId,
			}),
	},
	[WHISPER_BASE_ID]: {
		maxSamples: WHISPER_MAX_SAMPLES,
		create: async (file, consumerId) =>
			new WhisperEngine({
				encoderPath: file('onnx/encoder_model.onnx'),
				decoderPath: file('onnx/decoder_model_merged_q4.onnx'),
				tokenizerJson: await readFile(file('tokenizer.json'), 'utf8'),
				specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS,
				consumerId,
			}),
	},
	[WHISPER_SMALL_ID]: {
		maxSamples: WHISPER_MAX_SAMPLES,
		create: async (file, consumerId) =>
			new WhisperEngine({
				encoderPath: file('onnx/encoder_model.onnx'),
				decoderPath: file('onnx/decoder_model_merged_q4.onnx'),
				tokenizerJson: await readFile(file('tokenizer.json'), 'utf8'),
				geometry: { layers: 12, heads: 12, headDim: 64 },
				specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS,
				consumerId,
			}),
	},
});

/** Whether this build has an engine for a catalog speech-to-text model. */
export function hasSpeechToTextEngine(modelId: string): boolean {
	return Object.prototype.hasOwnProperty.call(BINDINGS, modelId);
}

/** An installed speech-to-text model, ready to have its engine built. */
export interface InstalledSpeechToTextModel {
	entry: LocalModelEntry;
	/** The longest buffer one pass accepts, in samples at 16 kHz. */
	maxSamples: number;
	createEngine(): Promise<SpeechToTextEngine>;
}

/**
 * The installed files of a catalog speech-to-text model, or a classified
 * refusal.
 *
 * Checked on every load (not every call), with the store's cheap check
 * (manifest plus byte lengths), so a model deleted since the last run is named
 * as such instead of surfacing as an opaque ONNX Runtime open failure.
 */
export async function resolveInstalledSpeechToTextModel(
	modelId: string,
	consumerId: string
): Promise<InstalledSpeechToTextModel> {
	const entry = getLocalModel(modelId);
	const binding = hasSpeechToTextEngine(modelId) ? BINDINGS[modelId] : undefined;
	if (!entry || entry.kind !== 'stt' || !binding) {
		throw new LocalModelError(`"${modelId}" is not a local speech-to-text model.`, {
			code: 'model-unsupported',
			recovery: 'Choose a speech-to-text model from the Local Models catalog.',
			consumerId,
		});
	}
	if (entry.pending) {
		throw new LocalModelError(entry.pending, {
			code: 'model-unsupported',
			recovery: 'Use a qualified model from the Local Models catalog.',
			consumerId,
		});
	}
	if (!(await isInstalled(modelId))) {
		throw new LocalModelError(`${entry.displayName} is not downloaded.`, {
			code: 'model-not-installed',
			recovery: `Download it in ${runtimeSetupLocation(entry.runtime)}.`,
			consumerId,
		});
	}
	return {
		entry,
		maxSamples: binding.maxSamples,
		createEngine: () => binding.create((relative) => modelFilePath(modelId, relative), consumerId),
	};
}
