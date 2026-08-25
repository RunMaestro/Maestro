/**
 * The realtime speech-to-speech tier.
 *
 * The cascade runs three engines in series: speech to text, text to a decision
 * and a rewrite, text back to speech. Each hop has its own round trip, and the
 * sum is what makes a hands-free assistant feel like a form submission. A
 * provider's realtime API collapses all three into one bidirectional socket with
 * the model's own endpointing and interruption, which is worth roughly a second
 * of turn latency.
 *
 * What it costs, stated here because it is stated in the settings copy too: the
 * assistant speaks in that provider's voice, and the microphone's samples go to
 * their servers. Neither is true of the local cascade, which is why realtime is
 * an opt-in and never a fallback.
 *
 * ## How it satisfies three interfaces at once
 *
 * `RealtimeVoiceAdapter` is ONE object registered as the STT, TTS, and Brain of a
 * {@link RealtimePipeline}. That is not a trick to fit an interface: it is the
 * accurate model of what a realtime session is - a single conversation that
 * happens to be sampled at three points. Because it satisfies the same three
 * seams the cascade does, the session service, the protocol, the router, and
 * every client are byte-for-byte unaware of which shape is running.
 *
 * ## Routing stays Maestro's
 *
 * The realtime model is NOT allowed to decide where a prompt goes by talking
 * about it. A `route_utterance` tool is declared on the session, and the model's
 * function call carries a `RouteDecision` that Maestro validates against the live
 * roster and executes itself. Tab and agent dispatch therefore work identically
 * in both pipeline shapes, and a model that invents an agent id gets the same
 * treatment it gets in the cascade: the conductor takes the turn.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../../shared/acappella/audio-host';
import { OPENAI_REALTIME_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	BrainProvider,
	SttCallbacks,
	SttProvider,
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
	VoiceConverseContext,
	VoicePipeline,
	VoiceProviderTrio,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import { ROUTE_DECISION_JSON_SCHEMA } from '../../../../shared/acappella/route-decision';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { logger } from '../../../utils/logger';
import { buildRouteUserPrompt, parseRouteDecision, routeSystemPrompt } from '../brain-prompt';
import { getCredential } from '../credentials';
import { requireCredential } from '../hosted/http';
import { resampleLinear } from '../pcm';

const LOG_CONTEXT = 'ACappella';

const DEFAULT_MODEL = 'gpt-4o-realtime-preview';
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/** The realtime API speaks 24 kHz PCM in both directions. */
const REALTIME_SAMPLE_RATE = 24_000;

/** The tool the model must call to route. Its schema is the shared one. */
export const ROUTE_TOOL_NAME = 'route_utterance';

/**
 * How long a turn waits for the model's routing tool call.
 *
 * Past this the conductor takes the turn rather than the session hanging: a
 * spoken instruction that produces nothing at all is the worst outcome, and the
 * conductor can always be asked to hand it on.
 */
const ROUTE_TIMEOUT_MS = 6_000;

/** How long a spoken rewrite may take before the turn gives up on audio. */
const RESPONSE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Socket seam
// ---------------------------------------------------------------------------

/**
 * The slice of a WebSocket this file uses.
 *
 * Injected rather than imported so the whole protocol - tool calls, barge-in,
 * transcript deltas - is testable without a network or an API key. The default
 * factory below is the only place `ws` is touched.
 */
export interface RealtimeSocket {
	send(data: string): void;
	close(): void;
	on(event: 'open', handler: () => void): void;
	on(event: 'message', handler: (data: string) => void): void;
	on(event: 'close', handler: () => void): void;
	on(event: 'error', handler: (error: Error) => void): void;
}

export type RealtimeSocketFactory = (
	url: string,
	headers: Record<string, string>
) => RealtimeSocket;

/** The production factory. `ws` is already a Maestro dependency. */
export const defaultRealtimeSocketFactory: RealtimeSocketFactory = (url, headers) => {
	// Required lazily: a user who never turns on the realtime tier should not pay
	// for the module, and the import must not run in a test that stubs the socket.
	const { WebSocket } = require('ws') as typeof import('ws');
	const socket = new WebSocket(url, { headers });

	return {
		send: (data) => socket.send(data),
		close: () => socket.close(),
		on: (event: string, handler: (...args: never[]) => void) => {
			if (event === 'message') {
				socket.on('message', (data: Buffer | string) =>
					(handler as unknown as (text: string) => void)(data.toString())
				);
				return;
			}
			socket.on(event as 'open', handler as () => void);
		},
	} as RealtimeSocket;
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface RealtimeSessionOptions {
	model?: string;
	voice?: string;
	socketFactory?: RealtimeSocketFactory;
	readCredential?: typeof getCredential;
	routeTimeoutMs?: number;
	responseTimeoutMs?: number;
}

/** One realtime conversation, wearing all three provider hats. */
export class RealtimeVoiceAdapter implements SttProvider, TtsProvider, BrainProvider {
	readonly id = OPENAI_REALTIME_PROVIDER_ID;
	readonly label = 'OpenAI Realtime';
	readonly tier = 'cloud' as const;
	/**
	 * What `feed()` takes, which is the capture path's rate. The API wants 24 kHz,
	 * so the conversion happens inside `feed()` rather than being pushed onto the
	 * audio pipeline: the capture rate is a property of the microphone and of the
	 * VAD tuned against it, not of whichever provider happens to be selected.
	 */
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	readonly acceptsAudio = true;

	private readonly model: string;
	private readonly voice: string;
	private readonly socketFactory: RealtimeSocketFactory;
	private readonly readCredential: typeof getCredential;
	private readonly routeTimeoutMs: number;
	private readonly responseTimeoutMs: number;

	private socket: RealtimeSocket | null = null;
	private callbacks: SttCallbacks | null = null;
	private opened: Promise<void> | null = null;

	/** Resolved by the model's routing tool call, or by its timeout. */
	private pendingRoute: Deferred<Record<string, unknown>> | null = null;
	/** Resolved when the model finishes a spoken response. */
	private pendingResponse: Deferred<SpokenResponse> | null = null;

	/** Sentence-aligned audio for the reply currently being generated. */
	private building: ResponseBuilder = newResponseBuilder();
	/** The last completed response, waiting for `speak()` to hand it out. */
	private spoken: SpokenResponse | null = null;

	/** Bumped by `cancel()` and by every speech run, so a stale iterator returns. */
	private run = 0;

	constructor(options: RealtimeSessionOptions = {}) {
		this.model = options.model ?? DEFAULT_MODEL;
		this.voice = options.voice ?? 'alloy';
		this.socketFactory = options.socketFactory ?? defaultRealtimeSocketFactory;
		this.readCredential = options.readCredential ?? getCredential;
		this.routeTimeoutMs = options.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;
		this.responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
	}

	// -- SttProvider ---------------------------------------------------------

	async start(callbacks: SttCallbacks): Promise<void> {
		const key = requireCredential(this.id, 'openai', this.readCredential);
		this.callbacks = callbacks;

		const socket = this.socketFactory(`${REALTIME_URL}?model=${encodeURIComponent(this.model)}`, {
			Authorization: `Bearer ${key}`,
			'OpenAI-Beta': 'realtime=v1',
		});
		this.socket = socket;

		this.opened = new Promise<void>((resolve, reject) => {
			socket.on('open', () => {
				this.configureSession();
				resolve();
			});
			socket.on('error', (error) =>
				reject(
					new VoiceProviderError(
						`The realtime connection failed: ${error.message}. Check your connection, or switch to the cascade pipeline.`,
						{ kind: 'network', providerId: this.id, cause: error }
					)
				)
			);
		});

		socket.on('message', (data) => this.handleMessage(data));
		socket.on('close', () => this.handleClose());

		await this.opened;
	}

	/**
	 * Push audio to the model.
	 *
	 * Base64 over the socket, which is what the API takes. No local endpointing:
	 * the model's own semantic VAD decides when a turn ended, and that judgement is
	 * most of what the realtime tier is buying.
	 */
	feed(pcm: Int16Array): void {
		if (!this.socket) return;
		const upsampled = resampleLinear(pcm, ACAPPELLA_AUDIO_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
		this.send({
			type: 'input_audio_buffer.append',
			audio: Buffer.from(upsampled.buffer, upsampled.byteOffset, upsampled.byteLength).toString(
				'base64'
			),
		});
	}

	/** Force endpointing. Used by push-to-talk, where the key release IS the end. */
	async flush(): Promise<void> {
		if (!this.socket) return;
		this.send({ type: 'input_audio_buffer.commit' });
	}

	async stop(): Promise<void> {
		this.callbacks = null;
		this.pendingRoute?.reject(sessionClosed(this.id));
		this.pendingRoute = null;
		this.pendingResponse?.reject(sessionClosed(this.id));
		this.pendingResponse = null;
		this.spoken = null;

		const socket = this.socket;
		this.socket = null;
		try {
			socket?.close();
		} catch {
			// A socket that will not close cleanly must not wedge session teardown.
		}
	}

	// -- BrainProvider -------------------------------------------------------

	/**
	 * The routing decision for an utterance.
	 *
	 * The model has already heard the audio, so this does not re-send the words: it
	 * publishes the roster the decision has to be made against and waits for the
	 * tool call. Maestro validates and executes it, exactly as in the cascade.
	 */
	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		if (!this.socket) throw sessionClosed(this.id);

		const pending = deferred<Record<string, unknown>>();
		this.pendingRoute = pending;

		// The roster changes between turns, so it is pushed per turn rather than
		// baked into the session instructions at connect time.
		this.send({
			type: 'conversation.item.create',
			item: {
				type: 'message',
				role: 'system',
				content: [{ type: 'input_text', text: buildRouteUserPrompt(input, context) }],
			},
		});
		this.send({
			type: 'response.create',
			response: { modalities: ['text'], tool_choice: { type: 'function', name: ROUTE_TOOL_NAME } },
		});

		const args = await withTimeout(pending.promise, this.routeTimeoutMs, null);
		if (this.pendingRoute === pending) this.pendingRoute = null;

		if (!args) {
			logger.warn('Realtime session did not route in time; the conductor takes it', LOG_CONTEXT);
			return { target: 'conductor', tabAction: 'current', prompt: input.trim(), confidence: 0.3 };
		}

		// Same parser as every other Brain: a tool call is a well-formed shape, not
		// a true one, and only the roster knows which agent ids exist.
		return parseRouteDecision(JSON.stringify(args), context, input);
	}

	/**
	 * Turn an agent's written answer into the spoken reply.
	 *
	 * The realtime model produces the words AND the audio in one response, so this
	 * generates both and keeps the audio for the `speak()` that follows. Returning
	 * the text first is what lets the session service count sentences and announce
	 * the run before a sample is played, which is the ordering every client's
	 * transcript depends on.
	 */
	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		if (!this.socket) throw sessionClosed(this.id);

		const pending = deferred<SpokenResponse>();
		this.pendingResponse = pending;
		this.building = newResponseBuilder();

		const limit = context.maxSentences ?? 2;
		this.send({
			type: 'conversation.item.create',
			item: {
				type: 'message',
				role: 'system',
				content: [
					{
						type: 'input_text',
						text: `An agent answered. Say this out loud in at most ${limit} sentence${
							limit === 1 ? '' : 's'
						}, plainly, with no code or file paths:\n\n${agentText}`,
					},
				],
			},
		});
		this.send({ type: 'response.create', response: { modalities: ['audio', 'text'] } });

		const response = await withTimeout(pending.promise, this.responseTimeoutMs, null);
		if (this.pendingResponse === pending) this.pendingResponse = null;

		if (!response) {
			throw new VoiceProviderError('The realtime model did not answer in time.', {
				kind: 'timeout',
				providerId: this.id,
			});
		}

		this.spoken = response;
		return response.text;
	}

	// -- TtsProvider ---------------------------------------------------------

	/**
	 * Hand out the audio the model already generated in `converse()`.
	 *
	 * `text` is ignored on purpose: re-synthesising it would be a second
	 * generation of something the user is about to hear, in a tier whose entire
	 * point is doing this once. The sentences were cut from the model's own
	 * transcript, so the chunk boundaries line up with what it actually said.
	 */
	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		const response = this.spoken;
		this.spoken = null;
		return this.stream(response ?? { text, sentences: [] }, ++this.run, options);
	}

	/** Barge-in. Cancels generation AND drops audio already queued on the server. */
	cancel(): void {
		this.run += 1;
		this.spoken = null;
		if (!this.socket) return;
		this.send({ type: 'response.cancel' });
		// Without this the server keeps streaming the audio it had already made,
		// and the user hears the assistant talk over the interruption.
		this.send({ type: 'output_audio_buffer.clear' });
	}

	// -- Internals -----------------------------------------------------------

	private async *stream(
		response: SpokenResponse,
		run: number,
		options: TtsSpeakOptions
	): AsyncGenerator<TtsChunk> {
		const sentences = response.sentences.length
			? response.sentences
			: splitIntoSpokenSentences(response.text).map((sentence) => ({
					text: sentence,
					audio: null,
				}));

		for (let index = 0; index < sentences.length; index++) {
			if (this.run !== run) return;
			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentences[index].text,
				format: sentences[index].audio ? 'pcm16' : 'none',
				audio: sentences[index].audio,
				sampleRate: REALTIME_SAMPLE_RATE,
			};
		}
	}

	/**
	 * Declare the session: audio format, transcription, the routing tool, and
	 * server-side turn detection.
	 */
	private configureSession(): void {
		this.send({
			type: 'session.update',
			session: {
				modalities: ['text', 'audio'],
				voice: this.voice,
				instructions: routeSystemPrompt(),
				input_audio_format: 'pcm16',
				output_audio_format: 'pcm16',
				input_audio_transcription: { model: 'whisper-1' },
				// Server VAD with interruption: the model stops speaking when the user
				// starts, which is the behaviour the cascade has to emulate with its own
				// detector and its own barge-in path.
				turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true },
				tools: [
					{
						type: 'function',
						name: ROUTE_TOOL_NAME,
						description:
							'Route the user utterance to an agent and a tab. Always call this instead of describing where it should go.',
						parameters: ROUTE_DECISION_JSON_SCHEMA,
					},
				],
			},
		});
	}

	private handleMessage(raw: string): void {
		let event: RealtimeEvent;
		try {
			event = JSON.parse(raw) as RealtimeEvent;
		} catch {
			// A frame we cannot parse is one lost delta, not a dead session.
			return;
		}

		switch (event.type) {
			case 'conversation.item.input_audio_transcription.delta':
				if (event.delta) this.callbacks?.onPartial(event.delta, 0.5);
				return;

			case 'conversation.item.input_audio_transcription.completed':
				if (event.transcript?.trim()) this.callbacks?.onFinal(event.transcript.trim(), 1);
				return;

			case 'response.audio_transcript.delta':
				if (event.delta) appendTranscript(this.building, event.delta);
				return;

			case 'response.audio.delta':
				if (event.delta) appendAudio(this.building, Buffer.from(event.delta, 'base64'));
				return;

			case 'response.function_call_arguments.done':
				this.resolveRoute(event.arguments);
				return;

			case 'response.done':
				this.pendingResponse?.resolve(finishResponse(this.building));
				this.pendingResponse = null;
				this.building = newResponseBuilder();
				return;

			case 'error':
				this.reportError(event.error?.message ?? 'The realtime session reported an error.');
				return;

			default:
				return;
		}
	}

	private resolveRoute(rawArguments?: string): void {
		if (!this.pendingRoute || !rawArguments) return;
		try {
			this.pendingRoute.resolve(JSON.parse(rawArguments) as Record<string, unknown>);
		} catch {
			// Unparseable arguments are the same as no decision: the timeout path
			// hands the turn to the conductor rather than guessing.
			this.pendingRoute.resolve({});
		}
		this.pendingRoute = null;
	}

	private handleClose(): void {
		this.pendingRoute?.resolve({});
		this.pendingRoute = null;
		this.pendingResponse?.reject(sessionClosed(this.id));
		this.pendingResponse = null;
		if (!this.callbacks) return;
		this.reportError('The realtime connection closed. Start voice mode again to reconnect.');
	}

	private reportError(message: string): void {
		this.callbacks?.onError(
			new VoiceProviderError(message, { kind: 'network', providerId: this.id })
		);
	}

	private send(payload: Record<string, unknown>): void {
		this.socket?.send(JSON.stringify(payload));
	}
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * The realtime pipeline: one adapter in all three slots.
 *
 * One of exactly two `VoicePipeline` implementations. Everything downstream is
 * handed the same `VoiceProviderTrio` it would get from the cascade.
 */
export class RealtimePipeline implements VoicePipeline {
	readonly shape = 'realtime' as const;
	readonly providers: VoiceProviderTrio;

	constructor(private readonly adapter: RealtimeVoiceAdapter) {
		this.providers = { stt: adapter, tts: adapter, brain: adapter };
	}

	async dispose(): Promise<void> {
		await this.adapter.stop();
	}
}

export function createRealtimePipeline(options: RealtimeSessionOptions = {}): RealtimePipeline {
	return new RealtimePipeline(new RealtimeVoiceAdapter(options));
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

/** One sentence of a spoken reply, with the audio that was generated for it. */
export interface SpokenSentence {
	text: string;
	audio: Uint8Array | null;
}

export interface SpokenResponse {
	text: string;
	sentences: SpokenSentence[];
}

interface ResponseBuilder {
	transcript: string;
	audio: Buffer[];
	/** Sentences already cut, with the audio that had arrived when they were. */
	sentences: SpokenSentence[];
	/** Transcript length already accounted for by a cut sentence. */
	cutAt: number;
}

function newResponseBuilder(): ResponseBuilder {
	return { transcript: '', audio: [], sentences: [], cutAt: 0 };
}

/**
 * Fold a transcript delta in, cutting a sentence whenever one completes.
 *
 * The audio and transcript deltas of a realtime response are interleaved in
 * generation order, so the audio that has arrived by the time a sentence closes
 * IS that sentence's audio, near enough to a frame. This is what lets a realtime
 * reply emit one `speak-sentence` per sentence like every other provider, instead
 * of one giant chunk that no client could show progress through.
 */
function appendTranscript(builder: ResponseBuilder, delta: string): void {
	builder.transcript += delta;

	const pending = builder.transcript.slice(builder.cutAt);
	const sentences = splitIntoSpokenSentences(pending);
	// The last fragment may still be growing, so only completed ones are cut.
	if (sentences.length < 2) return;

	for (const sentence of sentences.slice(0, -1)) {
		builder.sentences.push({ text: sentence, audio: drainAudio(builder) });
		builder.cutAt += pending.indexOf(sentence) + sentence.length;
	}
}

function appendAudio(builder: ResponseBuilder, chunk: Buffer): void {
	builder.audio.push(chunk);
}

/** Everything buffered since the last cut, as one buffer. */
function drainAudio(builder: ResponseBuilder): Uint8Array | null {
	if (builder.audio.length === 0) return null;
	const joined = Buffer.concat(builder.audio);
	builder.audio = [];
	return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

function finishResponse(builder: ResponseBuilder): SpokenResponse {
	const tail = builder.transcript.slice(builder.cutAt).trim();
	if (tail) builder.sentences.push({ text: tail, audio: drainAudio(builder) });
	else if (builder.audio.length && builder.sentences.length) {
		// Trailing audio with no trailing text: append it to the last sentence
		// rather than dropping it, or the reply is cut off mid-word.
		const last = builder.sentences[builder.sentences.length - 1];
		last.audio = concatAudio(last.audio, drainAudio(builder));
	}

	return {
		text: builder.sentences
			.map((sentence) => sentence.text)
			.join(' ')
			.trim(),
		sentences: builder.sentences,
	};
}

function concatAudio(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
	if (!a) return b;
	if (!b) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

// ---------------------------------------------------------------------------

interface RealtimeEvent {
	type: string;
	delta?: string;
	transcript?: string;
	arguments?: string;
	error?: { message?: string };
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// Attached so a rejection that nobody is awaiting yet (a socket that closed
	// between turns) cannot become an unhandled rejection and kill the process.
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/** Resolve with `fallback` when `promise` has not settled in time. */
async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T | null
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T | null>((resolve) => {
				timer = setTimeout(() => resolve(fallback), ms);
				timer.unref?.();
			}),
		]);
	} catch {
		return fallback;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sessionClosed(providerId: string): VoiceProviderError {
	return new VoiceProviderError(
		'The realtime session is not connected. Start voice mode again to reconnect.',
		{ kind: 'network', providerId }
	);
}
