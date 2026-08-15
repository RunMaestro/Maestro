/**
 * OpenAI speech-to-text.
 *
 * **The rule that shapes this file: audio is only sent after the floor opens.**
 * `start()` is called by the session service at the moment a wake word, a hotkey,
 * or a client button has already opened a session, and this provider buffers
 * nothing before that call and drops everything on `stop()`. There is no
 * always-on connection, no pre-roll, and no reconnect that outlives a session. A
 * hosted recogniser that held a socket open between turns would be a microphone
 * pointed at someone's room with a network cable attached to it.
 *
 * **Why the utterance is uploaded rather than streamed frame by frame.** The
 * transcription endpoint streams its OUTPUT (server-sent `delta` events, which
 * become partials) but takes its input as one request. The alternative is the
 * realtime WebSocket API, and that is a different pipeline shape with a different
 * privacy story, which is exactly what `providers/realtime/` is. Keeping the
 * cascade's hosted STT on the plain endpoint means one hop, one deadline, and a
 * request that is provably scoped to a single utterance.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../../shared/acappella/audio-host';
import { OPENAI_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { SttCallbacks, SttProvider } from '../../../../shared/acappella/providers';
import { estimateSpokenDurationMs } from '../../../../shared/acappella/sentences';
import { getCredential } from '../credentials';
import { PcmBuffer } from '../pcm';
import { hostedRequest, requireCredential, type HostedFetch } from './http';

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Fast and cheap. Routing does not need the large model's last percent. */
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

/**
 * A spoken turn that has not produced a transcript in this long has already
 * failed as a conversation, whatever the network eventually says.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Below this, the "utterance" is a cough. Uploading it would cost a request. */
const MIN_UTTERANCE_SAMPLES = ACAPPELLA_AUDIO_SAMPLE_RATE / 5;

export interface OpenAiSttOptions {
	model?: string;
	timeoutMs?: number;
	fetchImpl?: HostedFetch;
	/** Injected in tests. Production reads the OS keychain. */
	readCredential?: typeof getCredential;
	/** Optional BCP-47 hint. Given, it measurably improves both speed and accuracy. */
	language?: string;
}

export class OpenAiSttProvider implements SttProvider {
	readonly id = OPENAI_STT_PROVIDER_ID;
	readonly label = 'OpenAI (hosted)';
	readonly tier = 'cloud' as const;
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	readonly acceptsAudio = true;

	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl?: HostedFetch;
	private readonly readCredential: typeof getCredential;
	private readonly language?: string;

	private callbacks: SttCallbacks | null = null;
	private buffer = new PcmBuffer();
	/** Aborts the in-flight upload. Replaced per utterance, cleared on stop. */
	private inFlight: AbortController | null = null;

	constructor(options: OpenAiSttOptions = {}) {
		this.model = options.model ?? DEFAULT_MODEL;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
		this.readCredential = options.readCredential ?? getCredential;
		this.language = options.language;
	}

	/**
	 * Open the floor.
	 *
	 * The key is checked HERE rather than at the first upload, so a missing key is
	 * a refusal before the microphone is ever opened rather than a failure after
	 * the user has finished speaking.
	 */
	async start(callbacks: SttCallbacks): Promise<void> {
		requireCredential(this.id, 'openai', this.readCredential);
		this.callbacks = callbacks;
		this.buffer = new PcmBuffer();
	}

	feed(pcm: Int16Array): void {
		// No callbacks means no session. Buffering here would be audio held for a
		// floor that is not open, which is the one thing this provider must not do.
		if (!this.callbacks) return;
		this.buffer.push(pcm);
	}

	/** Endpoint: upload what was said and stream the transcript back. */
	async flush(): Promise<void> {
		if (!this.callbacks) return;
		const pcm = this.buffer.toInt16();
		const durationMs = this.buffer.durationMs;
		this.buffer.clear();

		if (pcm.length < MIN_UTTERANCE_SAMPLES) return;
		await this.transcribe(pcm, durationMs);
	}

	async stop(): Promise<void> {
		this.inFlight?.abort();
		this.inFlight = null;
		this.callbacks = null;
		this.buffer.clear();
	}

	/**
	 * The text-in seam, for a client that did its own transcription. It lands on
	 * the same callbacks and, importantly, sends nothing: on-device dictation must
	 * not become an upload just because the configured provider is hosted.
	 */
	injectUtterance(text: string): void {
		this.buffer.clear();
		const utterance = text.trim();
		this.callbacks?.onFinal(utterance, 1, utterance ? estimateSpokenDurationMs(utterance) : 0);
	}

	// -- Internals -----------------------------------------------------------

	private async transcribe(pcm: Int16Array, durationMs: number): Promise<void> {
		// A new utterance supersedes an upload still in flight: the user has moved
		// on, and two transcripts racing for one turn is worse than losing the old.
		this.inFlight?.abort();
		const controller = new AbortController();
		this.inFlight = controller;

		const form = new FormData();
		form.append('model', this.model);
		form.append('response_format', 'json');
		form.append('stream', 'true');
		if (this.language) form.append('language', this.language);
		// The cast is safe by construction: `encodeUtterance` allocates its own
		// ArrayBuffer, so the widened `ArrayBufferLike` can never be a SharedArrayBuffer.
		const wav = encodeUtterance(pcm);
		form.append(
			'file',
			new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }),
			'utterance.wav'
		);

		try {
			const response = await hostedRequest({
				providerId: this.id,
				service: 'openai',
				url: TRANSCRIBE_URL,
				init: {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${requireCredential(this.id, 'openai', this.readCredential)}`,
					},
					body: form,
				},
				timeoutMs: this.timeoutMs,
				signal: controller.signal,
				// One utterance, one upload. A retry would re-send audio the user has
				// already moved past and could deliver a second transcript for a turn
				// that is over.
				retry: false,
				fetchImpl: this.fetchImpl,
			});

			await this.consume(response, controller, durationMs);
		} catch (error) {
			if (controller.signal.aborted) return;
			// Classified failures are the provider's own report; anything else is a
			// bug and belongs in Sentry rather than in a spoken apology.
			if (!(error instanceof VoiceProviderError)) throw error;
			this.callbacks?.onError(error);
		} finally {
			if (this.inFlight === controller) this.inFlight = null;
		}
	}

	/**
	 * Read the server-sent stream, turning `delta` events into partials and the
	 * final `done` (or a plain JSON body) into the transcript.
	 */
	private async consume(
		response: Response,
		controller: AbortController,
		durationMs: number
	): Promise<void> {
		const body = response.body;
		if (!body) {
			// Not every deployment honours `stream=true`. A plain JSON body is a
			// complete transcript with no partials, which is a worse experience and a
			// perfectly correct turn.
			const payload = (await response.json().catch(() => null)) as { text?: string } | null;
			this.emitFinal(payload?.text ?? '', durationMs);
			return;
		}

		let text = '';
		for await (const event of readServerSentEvents(body)) {
			if (controller.signal.aborted) return;
			const delta = typeof event.delta === 'string' ? event.delta : '';
			if (event.type === 'transcript.text.delta' && delta) {
				text += delta;
				// Stability rises with length: a hypothesis that has been building for a
				// while is less likely to be rewritten than its first word.
				this.callbacks?.onPartial(text, partialStability(text));
				continue;
			}
			if (event.type === 'transcript.text.done' && typeof event.text === 'string') {
				text = event.text;
			}
		}

		this.emitFinal(text, durationMs);
	}

	private emitFinal(text: string, durationMs: number): void {
		const utterance = text.trim();
		if (!utterance) return;
		// The endpoint reports no per-utterance confidence, and inventing one would
		// give a client something to dim that means nothing. 1 is the honest value
		// for "this provider does not tell us".
		this.callbacks?.onFinal(utterance, 1, durationMs);
	}
}

// ---------------------------------------------------------------------------

function encodeUtterance(pcm: Int16Array): Uint8Array {
	const buffer = new PcmBuffer();
	buffer.push(pcm);
	return buffer.toWav();
}

/** Longer hypotheses are firmer, capped short of certainty. */
function partialStability(text: string): number {
	return Math.min(0.9, 0.3 + text.length / 400);
}

interface SseEvent {
	type?: string;
	delta?: string;
	text?: string;
}

/**
 * Parse a `text/event-stream` body into its JSON payloads.
 *
 * Written out rather than pulled from a library because the whole grammar we
 * need is "lines starting with `data: `, blank line ends an event", and a
 * dependency for that would be a dependency in the audio path.
 */
export async function* readServerSentEvents(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let pending = '';

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });

			let newline: number;
			while ((newline = pending.indexOf('\n')) !== -1) {
				const line = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				if (!line.startsWith('data:')) continue;

				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				try {
					yield JSON.parse(payload) as SseEvent;
				} catch {
					// A partial frame that split mid-JSON. Dropping one delta costs a
					// partial nobody was going to read twice; throwing would lose the
					// whole transcript.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
