/**
 * ElevenLabs text-to-speech.
 *
 * **One request per sentence, not one per reply.** The session service announces
 * a sentence count and emits one `speak-sentence` per chunk, and barge-in has to
 * cut speech off mid-reply without waiting for a whole paragraph to synthesise.
 * Synthesising sentence by sentence means the first words are audible while the
 * rest are still being made, and `cancel()` has something to abort that is at
 * most one sentence long.
 *
 * **`cancel()` aborts the socket, it does not set a flag.** A cancelled run that
 * merely stops yielding leaves the request running and the account paying for
 * audio nobody will hear. Barge-in is the most common interaction in a voice UI;
 * it has to be free.
 *
 * Audio comes back as raw 16 kHz PCM rather than MP3 so it can go straight to the
 * audio host's `pcm16` playback path with no decoder in the main process.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../../shared/acappella/audio-host';
import { ELEVENLABS_TTS_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { getCredential } from '../credentials';
import { hostedJson, hostedRequest, requireCredential, type HostedFetch } from './http';

const API_ROOT = 'https://api.elevenlabs.io/v1';

/** Their low-latency model. A voice assistant is the case it exists for. */
const DEFAULT_MODEL = 'eleven_flash_v2_5';

/** "Rachel". Overridden the moment the user picks a voice. */
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Rate is sent as ElevenLabs' `speed`, which they bound to 0.7 - 1.2. Anything
 * outside that is rejected for the whole request, so a user's slider is clamped
 * here rather than becoming a failed reply.
 */
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.2;

/** One selectable voice, as the voice picker renders it. */
export interface TtsVoice {
	id: string;
	name: string;
	/** Free-text descriptor from the service ("american, calm"). Optional. */
	description?: string;
	/** A sample the picker can play without spending a synthesis call. */
	previewUrl?: string;
}

/** Per-voice knobs. Sent verbatim; the service owns the ranges. */
export interface ElevenLabsVoiceSettings {
	stability?: number;
	similarityBoost?: number;
	style?: number;
}

export interface ElevenLabsTtsOptions {
	model?: string;
	voiceId?: string;
	voiceSettings?: ElevenLabsVoiceSettings;
	timeoutMs?: number;
	fetchImpl?: HostedFetch;
	readCredential?: typeof getCredential;
}

export class ElevenLabsTtsProvider implements TtsProvider {
	readonly id = ELEVENLABS_TTS_PROVIDER_ID;
	readonly label = 'ElevenLabs (hosted)';
	readonly tier = 'cloud' as const;

	private readonly model: string;
	private readonly defaultVoiceId: string;
	private readonly voiceSettings?: ElevenLabsVoiceSettings;
	private readonly timeoutMs: number;
	private readonly fetchImpl?: HostedFetch;
	private readonly readCredential: typeof getCredential;

	/** Bumped by `cancel()` and by every new run, so a stale iterator returns. */
	private run = 0;
	private inFlight: AbortController | null = null;

	constructor(options: ElevenLabsTtsOptions = {}) {
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultVoiceId = options.voiceId ?? DEFAULT_VOICE_ID;
		this.voiceSettings = options.voiceSettings;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
		this.readCredential = options.readCredential ?? getCredential;
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		// The run is claimed here, not in the generator body: a generator does not
		// start until its first `next()`, and a second `speak()` must supersede the
		// first immediately.
		return this.stream(splitIntoSpokenSentences(text), ++this.run, options);
	}

	cancel(): void {
		this.run += 1;
		this.inFlight?.abort();
		this.inFlight = null;
	}

	/** Every voice on the account, for the picker. */
	async listVoices(): Promise<TtsVoice[]> {
		const key = requireCredential(this.id, 'elevenlabs', this.readCredential);
		const payload = await hostedJson<{ voices?: RawVoice[] }>({
			providerId: this.id,
			service: 'elevenlabs',
			url: `${API_ROOT}/voices`,
			init: { method: 'GET', headers: { 'xi-api-key': key } },
			timeoutMs: this.timeoutMs,
			fetchImpl: this.fetchImpl,
		});

		return (payload.voices ?? [])
			.filter((voice): voice is RawVoice & { voice_id: string } => Boolean(voice?.voice_id))
			.map((voice) => ({
				id: voice.voice_id,
				name: voice.name ?? voice.voice_id,
				description: voice.labels ? Object.values(voice.labels).join(', ') : undefined,
				previewUrl: voice.preview_url,
			}));
	}

	// -- Internals -----------------------------------------------------------

	private async *stream(
		sentences: string[],
		run: number,
		options: TtsSpeakOptions
	): AsyncGenerator<TtsChunk> {
		for (let index = 0; index < sentences.length; index++) {
			if (this.run !== run) return;

			let audio: Uint8Array;
			try {
				audio = await this.synthesize(sentences[index], options);
			} catch (error) {
				// A barge-in aborts the request, and an abort is not a failure: the run
				// it belonged to is already over, so it ends quietly. Everything else
				// travels, classified or not - the session announces the classified ones
				// and Sentry gets the rest.
				if (this.run !== run) return;
				throw error;
			}

			// Re-checked after the await: a barge-in during synthesis must not deliver
			// the sentence it interrupted.
			if (this.run !== run) return;

			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentences[index],
				format: 'pcm16',
				audio,
				sampleRate: ACAPPELLA_AUDIO_SAMPLE_RATE,
			};
		}
	}

	private async synthesize(sentence: string, options: TtsSpeakOptions): Promise<Uint8Array> {
		const key = requireCredential(this.id, 'elevenlabs', this.readCredential);
		const controller = new AbortController();
		this.inFlight = controller;

		const voiceId = options.voiceId ?? this.defaultVoiceId;
		const body: Record<string, unknown> = {
			text: sentence,
			model_id: this.model,
		};
		const settings = this.buildVoiceSettings(options.rate);
		if (settings) body.voice_settings = settings;

		try {
			const response = await hostedRequest({
				providerId: this.id,
				service: 'elevenlabs',
				url: `${API_ROOT}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_16000`,
				init: {
					method: 'POST',
					headers: { 'xi-api-key': key, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				},
				timeoutMs: this.timeoutMs,
				signal: controller.signal,
				// Retrying a sentence the user may already have heard the start of
				// would repeat words. One attempt; a failure ends the run honestly.
				retry: false,
				fetchImpl: this.fetchImpl,
			});

			return new Uint8Array(await response.arrayBuffer());
		} finally {
			if (this.inFlight === controller) this.inFlight = null;
		}
	}

	private buildVoiceSettings(rate?: number): Record<string, number> | null {
		const settings: Record<string, number> = {};
		if (this.voiceSettings?.stability !== undefined) {
			settings.stability = this.voiceSettings.stability;
		}
		if (this.voiceSettings?.similarityBoost !== undefined) {
			settings.similarity_boost = this.voiceSettings.similarityBoost;
		}
		if (this.voiceSettings?.style !== undefined) settings.style = this.voiceSettings.style;
		if (rate !== undefined && rate > 0) {
			settings.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, rate));
		}
		return Object.keys(settings).length > 0 ? settings : null;
	}
}

interface RawVoice {
	voice_id?: string;
	name?: string;
	preview_url?: string;
	labels?: Record<string, string>;
}
