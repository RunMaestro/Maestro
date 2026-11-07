/**
 * VoiceStudio's native, seeded TTS route. The OpenAI-compatible route accepts
 * a seed but VoxCPM2 does not apply it there. One native render per spoken
 * sentence keeps the existing transcript, playback and barge-in contract.
 */
import {
	normalizeVoiceStudioConfig,
	voiceStudioConfigProblem,
	type VoiceStudioConfig,
	type VoiceStudioProfile,
	type VoiceStudioStatus,
} from '../../../../shared/acappella/voice-studio';
import { VOICE_STUDIO_TTS_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout';

type VoiceStudioFetch = typeof fetchWithTimeout;
const PROBE_TIMEOUT_MS = 5_000;
const SYNTHESIS_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_CHARS = MAX_AUDIO_BYTES * 2;

function failure(
	kind: 'network' | 'server' | 'request' | 'busy' | 'timeout' | 'unavailable',
	message: string
): VoiceProviderError {
	return new VoiceProviderError(message, { kind, providerId: VOICE_STUDIO_TTS_PROVIDER_ID });
}

/** Shared by the source card and the provider; probes never synthesize or load an engine. */
export class VoiceStudioClient {
	readonly config: VoiceStudioConfig;
	constructor(
		config: VoiceStudioConfig,
		private readonly request: VoiceStudioFetch = fetchWithTimeout
	) {
		const problem = voiceStudioConfigProblem(config);
		if (problem) throw failure('unavailable', problem);
		this.config = normalizeVoiceStudioConfig(config);
	}

	private async response(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
		try {
			const response = await this.request(`${this.config.baseUrl}${path}`, init, timeoutMs);
			if (response.ok) return response;
			await response.body?.cancel();
			if (response.status === 429 || response.status === 503) {
				throw failure(
					'busy',
					'VoiceStudio is busy or warming up. Try again when its current job finishes.'
				);
			}
			throw failure(
				response.status >= 500 ? 'server' : 'request',
				'VoiceStudio refused the request. Check its source settings and engine.'
			);
		} catch (error) {
			if (error instanceof VoiceProviderError || init.signal?.aborted) throw error;
			throw failure(
				'network',
				'Cannot reach VoiceStudio. Start the local service and check its source URL.'
			);
		}
	}

	async profiles(signal?: AbortSignal): Promise<VoiceStudioProfile[]> {
		try {
			const response = await this.response(
				'/profiles',
				{
					signal: signal
						? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
						: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				},
				PROBE_TIMEOUT_MS
			);
			const body: unknown = await response.json();
			if (!Array.isArray(body))
				throw failure('server', 'VoiceStudio returned an invalid profile list.');
			return body
				.filter(
					(entry): entry is VoiceStudioProfile =>
						entry &&
						typeof entry.id === 'string' &&
						typeof entry.name === 'string' &&
						entry.name.trim().length > 0
				)
				.map(({ id, name }) => ({ id, name }));
		} catch (error) {
			if (signal?.aborted || error instanceof VoiceProviderError) throw error;
			throw failure(
				'server',
				'VoiceStudio could not return its voice profiles. Check the local service.'
			);
		}
	}

	async status(): Promise<VoiceStudioStatus> {
		try {
			const response = await this.response(
				'/health',
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
				PROBE_TIMEOUT_MS
			);
			const health = (await response.json()) as { status?: string; version?: string };
			if (health.status !== 'ok')
				throw failure(
					'unavailable',
					'VoiceStudio is still starting. Check it again once startup finishes.'
				);
			return {
				connected: true,
				profiles: await this.profiles(),
				version: typeof health.version === 'string' ? health.version : undefined,
			};
		} catch (error) {
			return {
				connected: false,
				message:
					error instanceof VoiceProviderError
						? error.message
						: 'VoiceStudio returned a response Maestro could not read.',
			};
		}
	}

	async synthesize(
		text: string,
		profileId: string,
		rate: number | undefined,
		callerSignal: AbortSignal
	): Promise<{ audio: Uint8Array; sampleRate: number }> {
		const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS)]);
		const form = new FormData();
		for (const [key, value] of Object.entries({
			text,
			profile_id: profileId,
			engine: this.config.engine,
			seed: String(this.config.seed),
			effect_preset: 'raw',
			language: 'en',
			stream: 'true',
			speed: String(rate ?? 1),
		})) {
			form.set(key, value);
		}
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await this.response(
				'/generate',
				{ method: 'POST', body: form, signal },
				SYNTHESIS_TIMEOUT_MS
			);
			if (!response.body) throw failure('server', 'VoiceStudio returned no audio stream.');
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = '';
			let sampleRate = 0;
			let bytes = 0;
			let done = false;
			let sequence = 0;
			const chunks: Uint8Array[] = [];
			const consume = (line: string) => {
				if (!line.trim()) return;
				const value: unknown = JSON.parse(line);
				if (!value || typeof value !== 'object' || Array.isArray(value))
					throw failure('server', 'VoiceStudio returned an invalid stream frame.');
				const event = value as Record<string, unknown>;
				if (done) throw failure('server', 'VoiceStudio sent data after the audio stream ended.');
				if (event.type === 'error')
					throw failure(
						event.code === 'generation_busy' ? 'busy' : 'server',
						'VoiceStudio could not render the sentence. Check the engine and its current jobs.'
					);
				if (event.type === 'start') {
					if (
						sampleRate ||
						event.format !== 'pcm16' ||
						event.channels !== 1 ||
						typeof event.sample_rate !== 'number' ||
						!Number.isInteger(event.sample_rate) ||
						event.sample_rate < 8_000 ||
						event.sample_rate > 192_000
					)
						throw failure('server', 'VoiceStudio returned an unsupported audio format.');
					sampleRate = event.sample_rate;
				} else if (event.type === 'chunk') {
					if (
						!sampleRate ||
						event.seq !== sequence++ ||
						typeof event.pcm !== 'string' ||
						event.pcm.length % 4 !== 0 ||
						!/^[A-Za-z0-9+/]*={0,2}$/.test(event.pcm)
					)
						throw failure('server', 'VoiceStudio returned an invalid audio chunk.');
					const audio = Buffer.from(event.pcm, 'base64');
					bytes += audio.byteLength;
					if (audio.byteLength % 2 || bytes > MAX_AUDIO_BYTES)
						throw failure('server', 'VoiceStudio returned an invalid or oversized audio buffer.');
					chunks.push(audio);
				} else if (event.type === 'done') {
					if (typeof event.dropped_chunks === 'number' && event.dropped_chunks > 0)
						throw failure(
							'server',
							'VoiceStudio dropped part of the sentence. No audio was played.'
						);
					done = true;
				}
			};
			while (true) {
				const part = await reader.read();
				pending += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
				if (pending.length > MAX_FRAME_CHARS)
					throw failure('server', 'VoiceStudio returned an oversized stream frame.');
				let newline: number;
				while ((newline = pending.indexOf('\n')) >= 0) {
					consume(pending.slice(0, newline));
					pending = pending.slice(newline + 1);
				}
				if (part.done) break;
			}
			consume(pending);
			if (!done || !sampleRate || !bytes)
				throw failure('server', 'VoiceStudio ended before delivering a complete sentence.');
			return { audio: Buffer.concat(chunks, bytes), sampleRate };
		} catch (error) {
			if (callerSignal.aborted || error instanceof VoiceProviderError) throw error;
			if (signal.aborted)
				throw failure(
					'timeout',
					'VoiceStudio took too long to render the sentence. Check its engine and current jobs.'
				);
			if (error instanceof SyntaxError)
				throw failure('server', 'VoiceStudio returned an invalid audio stream.');
			throw failure('network', 'The VoiceStudio audio connection was interrupted.');
		} finally {
			await reader?.cancel().catch(() => undefined);
			reader?.releaseLock();
		}
	}
}

export class VoiceStudioTtsProvider implements TtsProvider {
	readonly id = VOICE_STUDIO_TTS_PROVIDER_ID;
	readonly label = 'VoiceStudio (local voices)';
	readonly tier = 'local' as const;
	private run = 0;
	private inFlight: AbortController | null = null;
	constructor(private readonly client: VoiceStudioClient) {}

	async listVoices(): Promise<VoiceStudioProfile[]> {
		return (await this.client.profiles()).map(({ name }) => ({ id: name, name }));
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		this.cancel();
		return this.stream(splitIntoSpokenSentences(text), options, this.run);
	}

	cancel(): void {
		this.run++;
		this.inFlight?.abort();
		this.inFlight = null;
	}

	private async *stream(
		sentences: string[],
		options: TtsSpeakOptions,
		run: number
	): AsyncGenerator<TtsChunk> {
		if (!sentences.length || run !== this.run) return;
		const controller = new AbortController();
		this.inFlight = controller;
		try {
			const profiles = await this.client.profiles(controller.signal);
			if (run !== this.run) return;
			const matches = profiles.filter(({ name }) => name === options.voiceId);
			if (matches.length !== 1)
				throw failure(
					'unavailable',
					'Choose a unique VoiceStudio profile in A Cappella > Voice Output. Profiles are selected by name.'
				);
			for (let index = 0; index < sentences.length; index++) {
				if (run !== this.run) return;
				const audio = await this.client.synthesize(
					sentences[index],
					matches[0].id,
					options.rate,
					controller.signal
				);
				if (run !== this.run) return;
				yield {
					utteranceId: options.utteranceId,
					index,
					text: sentences[index],
					format: 'pcm16',
					...audio,
				};
			}
		} catch (error) {
			if (run !== this.run) return;
			throw error;
		} finally {
			controller.abort();
			if (this.inFlight === controller) this.inFlight = null;
		}
	}
}
