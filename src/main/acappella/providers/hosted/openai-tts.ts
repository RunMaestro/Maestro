/**
 * OpenAI text-to-speech.
 *
 * The second hosted voice, and the reason it exists is the key count: OpenAI
 * already fills the hosted Speech-to-Text and Conductor Brain slots, so with
 * this one an OpenAI key alone runs a complete hosted trio. Before it, a user
 * with one key still needed a second account for the voice.
 *
 * Same shape as `elevenlabs-tts.ts`, on purpose. One request per sentence so the
 * first words are audible while the rest are still being made and so
 * `cancel()` has at most a sentence to abort; the abort really cancels the
 * request rather than setting a flag, because barge-in is the most common thing
 * a user does and it has to be free.
 *
 * Audio is asked for as raw `pcm`, which the endpoint delivers as 24 kHz signed
 * 16-bit mono - straight onto the audio host's `pcm16` path with no decoder.
 */

import { OPENAI_TTS_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { getCredential } from '../credentials';
import { hostedRequest, requireCredential, type HostedFetch } from './http';

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/** Their low-latency voice model. */
const DEFAULT_MODEL = 'gpt-4o-mini-tts';

const DEFAULT_VOICE = 'alloy';

/** What `response_format: 'pcm'` delivers. Not negotiable per request. */
export const OPENAI_TTS_SAMPLE_RATE = 24_000;

const DEFAULT_TIMEOUT_MS = 15_000;

/** The endpoint's own bounds for `speed`. */
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;

/**
 * The voices the model offers. A fixed list rather than a request: the endpoint
 * has no voice listing, and these are documented rather than per-account.
 */
export const OPENAI_TTS_VOICES: ReadonlyArray<{ id: string; name: string }> = Object.freeze(
	[
		'alloy',
		'ash',
		'ballad',
		'coral',
		'echo',
		'fable',
		'nova',
		'onyx',
		'sage',
		'shimmer',
		'verse',
	].map((id) => Object.freeze({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }))
);

export interface OpenAiTtsOptions {
	model?: string;
	voiceId?: string;
	timeoutMs?: number;
	fetchImpl?: HostedFetch;
	readCredential?: typeof getCredential;
}

export class OpenAiTtsProvider implements TtsProvider {
	readonly id = OPENAI_TTS_PROVIDER_ID;
	readonly label = 'OpenAI (hosted)';
	readonly tier = 'cloud' as const;

	private readonly model: string;
	private readonly defaultVoiceId: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl?: HostedFetch;
	private readonly readCredential: typeof getCredential;

	/** Bumped by `cancel()` and by every new run, so a stale iterator returns. */
	private run = 0;
	private inFlight: AbortController | null = null;

	constructor(options: OpenAiTtsOptions = {}) {
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultVoiceId = options.voiceId ?? DEFAULT_VOICE;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
		this.readCredential = options.readCredential ?? getCredential;
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		// Claimed here rather than in the generator body, so a second `speak()`
		// supersedes the first before either has produced anything.
		return this.stream(splitIntoSpokenSentences(text), ++this.run, options);
	}

	cancel(): void {
		this.run += 1;
		this.inFlight?.abort();
		this.inFlight = null;
	}

	/** The documented voices, for the picker. No request is made. */
	listVoices(): Array<{ id: string; name: string }> {
		return OPENAI_TTS_VOICES.map((voice) => ({ ...voice }));
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
				// A barge-in aborts the request, and an abort is not a failure.
				if (this.run !== run) return;
				throw error;
			}

			// Re-checked after the await: a barge-in during synthesis must not
			// deliver the sentence it interrupted.
			if (this.run !== run) return;

			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentences[index],
				format: 'pcm16',
				audio,
				sampleRate: OPENAI_TTS_SAMPLE_RATE,
			};
		}
	}

	private async synthesize(sentence: string, options: TtsSpeakOptions): Promise<Uint8Array> {
		const key = requireCredential(this.id, 'openai', this.readCredential);
		const controller = new AbortController();
		this.inFlight = controller;

		// A voice chosen for another provider (an ElevenLabs id, a system voice
		// name) is not one of these, and sending it would fail every sentence.
		const requested = options.voiceId ?? this.defaultVoiceId;
		const voice = OPENAI_TTS_VOICES.some((entry) => entry.id === requested)
			? requested
			: this.defaultVoiceId;

		const body: Record<string, unknown> = {
			model: this.model,
			input: sentence,
			voice,
			response_format: 'pcm',
		};
		if (options.rate !== undefined && options.rate > 0) {
			body.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, options.rate));
		}

		try {
			const response = await hostedRequest({
				providerId: this.id,
				service: 'openai',
				url: SPEECH_URL,
				init: {
					method: 'POST',
					headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				},
				timeoutMs: this.timeoutMs,
				signal: controller.signal,
				// One sentence, one request. A retry could repeat words the user has
				// already heard the start of.
				retry: false,
				fetchImpl: this.fetchImpl,
			});

			return new Uint8Array(await response.arrayBuffer());
		} finally {
			if (this.inFlight === controller) this.inFlight = null;
		}
	}
}
