/**
 * @file hosted-providers.test.ts
 *
 * The hosted tier, against a mocked transport. Three properties per backend,
 * because these are the three that fail silently in production:
 *
 *   - **Streaming.** Partial transcripts arrive as the deltas do, rather than in
 *     one lump at the end.
 *   - **Cancellation aborts the REQUEST.** A barge-in that only stops iterating
 *     leaves the socket open and the account paying for audio nobody will hear,
 *     so the test asserts the abort signal actually fired.
 *   - **Classification.** Quota, auth, and network come back as distinct kinds
 *     with distinct protocol codes. Collapsing them is what tells a user with an
 *     expired key to go and download a model.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpenAiSttProvider } from '../../../../main/acappella/providers/hosted/openai-stt';
import { ElevenLabsTtsProvider } from '../../../../main/acappella/providers/hosted/elevenlabs-tts';
import { OpenAiBrainProvider } from '../../../../main/acappella/providers/hosted/openai-brain';
import { AnthropicBrainProvider } from '../../../../main/acappella/providers/hosted/anthropic-brain';
import { hostedRequest, MAX_ATTEMPTS } from '../../../../main/acappella/providers/hosted/http';
import { isVoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { SttCallbacks, TtsChunk } from '../../../../shared/acappella/providers';
import type { RosterAgent } from '../../../../shared/acappella/protocol';

const KEY = () => 'sk-test-abcdefghijklmnopqrstuvwxyz';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
	},
];

function recorder(): {
	callbacks: SttCallbacks;
	partials: string[];
	finals: string[];
	errors: Error[];
} {
	const partials: string[] = [];
	const finals: string[] = [];
	const errors: Error[] = [];
	return {
		partials,
		finals,
		errors,
		callbacks: {
			onPartial: (text) => partials.push(text),
			onFinal: (text) => finals.push(text),
			onError: (error) => errors.push(error),
		},
	};
}

/** A `text/event-stream` body built from event objects. */
function sseResponse(events: unknown[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One second of silence, enough to clear the minimum-utterance floor. */
function utterancePcm(): Int16Array {
	return new Int16Array(16_000);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe('hosted transport', () => {
	const base = {
		providerId: 'openai-stt',
		service: 'openai' as const,
		url: 'https://example.test/v1/thing',
		timeoutMs: 1_000,
		delayMs: async () => {},
	};

	it('retries a 429 and succeeds', async () => {
		let calls = 0;
		const response = await hostedRequest({
			...base,
			fetchImpl: async () => {
				calls += 1;
				return calls === 1
					? new Response('', { status: 429 })
					: new Response('{}', { status: 200 });
			},
		});

		expect(calls).toBe(2);
		expect(response.status).toBe(200);
	});

	it('gives up after a bounded number of attempts', async () => {
		let calls = 0;
		await expect(
			hostedRequest({
				...base,
				fetchImpl: async () => {
					calls += 1;
					return new Response('', { status: 503 });
				},
			})
		).rejects.toMatchObject({ kind: 'server' });

		expect(calls).toBe(MAX_ATTEMPTS);
	});

	it('never retries an auth failure', async () => {
		let calls = 0;
		const error = await hostedRequest({
			...base,
			fetchImpl: async () => {
				calls += 1;
				return new Response('', { status: 401 });
			},
		}).catch((err: unknown) => err);

		expect(calls).toBe(1);
		expect(isVoiceProviderError(error) && error.kind).toBe('auth');
		expect(isVoiceProviderError(error) && error.sessionErrorCode).toBe('provider-auth-failed');
	});

	it('classifies quota, network, and request failures distinctly', async () => {
		const quota = await hostedRequest({
			...base,
			retry: false,
			fetchImpl: async () => new Response('', { status: 402 }),
		}).catch((err: unknown) => err);
		expect(isVoiceProviderError(quota) && quota.sessionErrorCode).toBe('provider-quota-exceeded');

		const network = await hostedRequest({
			...base,
			retry: false,
			fetchImpl: async () => {
				throw new TypeError('fetch failed');
			},
		}).catch((err: unknown) => err);
		expect(isVoiceProviderError(network) && network.sessionErrorCode).toBe(
			'provider-network-error'
		);

		const bad = await hostedRequest({
			...base,
			retry: false,
			fetchImpl: async () => new Response('', { status: 400 }),
		}).catch((err: unknown) => err);
		expect(isVoiceProviderError(bad) && bad.kind).toBe('request');
	});

	it('never quotes the response body, which can echo the key', async () => {
		const error = await hostedRequest({
			...base,
			retry: false,
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: { message: `bad key ${KEY()}` } }), { status: 401 }),
		}).catch((err: unknown) => err);

		expect((error as Error).message).not.toContain(KEY());
	});

	it('aborts when the caller cancels', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			hostedRequest({ ...base, signal: controller.signal, fetchImpl: async () => new Response() })
		).rejects.toMatchObject({ kind: 'network' });
	});
});

// ---------------------------------------------------------------------------
// OpenAI STT
// ---------------------------------------------------------------------------

describe('OpenAiSttProvider', () => {
	it('refuses to start without a key, before any audio is buffered', async () => {
		const provider = new OpenAiSttProvider({ readCredential: () => null });
		const { callbacks } = recorder();

		await expect(provider.start(callbacks)).rejects.toThrow(/API key/i);
	});

	it('sends nothing until the floor has been opened', async () => {
		const fetchImpl = vi.fn(async () => sseResponse([]));
		const provider = new OpenAiSttProvider({ readCredential: KEY, fetchImpl });

		// `feed` before `start`: audio that arrives with no session behind it must
		// never reach a hosted service.
		provider.feed(utterancePcm());
		await provider.flush();

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('streams partials as deltas arrive and a final at the end', async () => {
		const provider = new OpenAiSttProvider({
			readCredential: KEY,
			fetchImpl: async () =>
				sseResponse([
					{ type: 'transcript.text.delta', delta: 'open the ' },
					{ type: 'transcript.text.delta', delta: 'auth tab' },
					{ type: 'transcript.text.done', text: 'open the auth tab' },
				]),
		});
		const { callbacks, partials, finals } = recorder();

		await provider.start(callbacks);
		provider.feed(utterancePcm());
		await provider.flush();

		expect(partials).toEqual(['open the ', 'open the auth tab']);
		expect(finals).toEqual(['open the auth tab']);
	});

	it('reports a classified failure through onError rather than throwing', async () => {
		const provider = new OpenAiSttProvider({
			readCredential: KEY,
			fetchImpl: async () => new Response('', { status: 429 }),
		});
		const { callbacks, errors } = recorder();

		await provider.start(callbacks);
		provider.feed(utterancePcm());
		await provider.flush();

		expect(errors).toHaveLength(1);
		expect(isVoiceProviderError(errors[0]) && errors[0].kind).toBe('quota');
	});

	it('aborts the in-flight upload on stop', async () => {
		let signal: AbortSignal | undefined;
		const provider = new OpenAiSttProvider({
			readCredential: KEY,
			fetchImpl: async (_url, init) => {
				signal = init?.signal ?? undefined;
				return sseResponse([{ type: 'transcript.text.done', text: 'hello' }]);
			},
		});
		const { callbacks } = recorder();

		await provider.start(callbacks);
		provider.feed(utterancePcm());
		const inflight = provider.flush();
		await provider.stop();
		await inflight;

		expect(signal?.aborted).toBe(true);
	});

	it('does not upload a cough', async () => {
		const fetchImpl = vi.fn(async () => sseResponse([]));
		const provider = new OpenAiSttProvider({ readCredential: KEY, fetchImpl });
		const { callbacks } = recorder();

		await provider.start(callbacks);
		provider.feed(new Int16Array(100));
		await provider.flush();

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('sends nothing for a client that did its own transcription', async () => {
		const fetchImpl = vi.fn(async () => sseResponse([]));
		const provider = new OpenAiSttProvider({ readCredential: KEY, fetchImpl });
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.injectUtterance('typed instead of spoken');

		expect(finals).toEqual(['typed instead of spoken']);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------

describe('ElevenLabsTtsProvider', () => {
	function pcmResponse(): Response {
		return new Response(new Uint8Array(320).buffer, { status: 200 });
	}

	it('synthesises one chunk per sentence', async () => {
		const fetchImpl = vi.fn(async () => pcmResponse());
		const provider = new ElevenLabsTtsProvider({ readCredential: KEY, fetchImpl });

		const chunks = [];
		for await (const chunk of provider.speak('First one. Second one.', { utteranceId: 'u1' })) {
			chunks.push(chunk);
		}

		expect(chunks.map((chunk) => chunk.text)).toEqual(['First one.', 'Second one.']);
		expect(chunks[0].format).toBe('pcm16');
		expect(chunks[0].sampleRate).toBe(16_000);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('cancels an in-flight synthesis by aborting the request', async () => {
		let signal: AbortSignal | undefined;
		let started: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});

		const provider = new ElevenLabsTtsProvider({
			readCredential: KEY,
			// A request that never settles on its own, so the only way this run can
			// end is the abort. That is the property under test: a `cancel()` that
			// merely stopped iterating would leave this socket open and the account
			// paying for audio nobody will hear.
			fetchImpl: (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					signal = init?.signal ?? undefined;
					signal?.addEventListener('abort', () => reject(new Error('aborted')));
					started();
				}),
		});

		const chunks: TtsChunk[] = [];
		const run = (async () => {
			for await (const chunk of provider.speak('First. Second.', { utteranceId: 'u1' })) {
				chunks.push(chunk);
			}
		})();

		await requestStarted;
		provider.cancel();
		await run;

		expect(signal?.aborted).toBe(true);
		// The run ends quietly: a barge-in is not a failure to report.
		expect(chunks).toHaveLength(0);
	});

	it('drops the rest of a run that was cancelled between sentences', async () => {
		const provider = new ElevenLabsTtsProvider({
			readCredential: KEY,
			fetchImpl: async () => pcmResponse(),
		});

		const chunks = [];
		for await (const chunk of provider.speak('First. Second. Third.', { utteranceId: 'u1' })) {
			chunks.push(chunk);
			provider.cancel();
		}

		expect(chunks).toHaveLength(1);
	});

	it('clamps the speed to the range the service accepts', async () => {
		let body: Record<string, unknown> = {};
		const provider = new ElevenLabsTtsProvider({
			readCredential: KEY,
			fetchImpl: async (_url, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return pcmResponse();
			},
		});

		for await (const _chunk of provider.speak('Hello.', { utteranceId: 'u1', rate: 9 })) {
			// drain
		}

		expect((body.voice_settings as Record<string, number>).speed).toBe(1.2);
	});

	it('classifies an auth failure rather than reporting a generic one', async () => {
		const provider = new ElevenLabsTtsProvider({
			readCredential: KEY,
			fetchImpl: async () => new Response('', { status: 401 }),
		});

		const iterate = async () => {
			for await (const _chunk of provider.speak('Hello.', { utteranceId: 'u1' })) {
				// drain
			}
		};

		await expect(iterate()).rejects.toMatchObject({ kind: 'auth' });
	});

	it('lists the voices on the account', async () => {
		const provider = new ElevenLabsTtsProvider({
			readCredential: KEY,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						voices: [{ voice_id: 'v1', name: 'Rachel', labels: { accent: 'us' } }],
					}),
					{ status: 200 }
				),
		});

		expect(await provider.listVoices()).toEqual([
			{ id: 'v1', name: 'Rachel', description: 'us', previewUrl: undefined },
		]);
	});
});

// ---------------------------------------------------------------------------
// Hosted Brains
// ---------------------------------------------------------------------------

describe('hosted Brain providers', () => {
	const decision = {
		target: { sessionId: 'agent-backend' },
		tabAction: 'new',
		tabName: 'Auth',
		prompt: 'refactor the auth module',
		confidence: 0.9,
	};

	it('OpenAI routes through the shared parser', async () => {
		const provider = new OpenAiBrainProvider({
			readCredential: KEY,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }),
					{ status: 200 }
				),
		});

		const result = await provider.route('ask backend to refactor auth', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		expect(result).toMatchObject({ target: { sessionId: 'agent-backend' }, tabAction: 'new' });
	});

	it('Anthropic restores its JSON prefill before parsing', async () => {
		const provider = new AnthropicBrainProvider({
			readCredential: () => 'sk-ant-abcdefghijklmnop',
			fetchImpl: async () =>
				new Response(
					// The prefill `{` is not echoed, so the body starts mid-object.
					JSON.stringify({
						content: [{ type: 'text', text: JSON.stringify(decision).slice(1) }],
					}),
					{ status: 200 }
				),
		});

		const result = await provider.route('ask backend to refactor auth', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		expect(result.target).toEqual({ sessionId: 'agent-backend' });
	});

	it('sends the conductor an utterance naming an agent that is not running', async () => {
		const provider = new OpenAiBrainProvider({
			readCredential: KEY,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({ ...decision, target: { sessionId: 'ghost' } }),
								},
							},
						],
					}),
					{ status: 200 }
				),
		});

		const result = await provider.route('ask ghost something', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		// A hallucinated id must never be dispatched to. The conductor takes it.
		expect(result.target).toBe('conductor');
	});

	it('trims a spoken rewrite to the sentence budget', async () => {
		const provider = new OpenAiBrainProvider({
			readCredential: KEY,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: 'One. Two. Three. Four.' } }],
					}),
					{ status: 200 }
				),
		});

		const spoken = await provider.converse('...', {
			agentSessionId: 'agent-backend',
			tabId: 'tab-auth',
			maxSentences: 2,
		});

		expect(spoken).toBe('One. Two.');
	});

	it('refuses without a key before any request is made', async () => {
		const fetchImpl = vi.fn();
		const provider = new OpenAiBrainProvider({
			readCredential: () => null,
			fetchImpl: fetchImpl as never,
		});

		await expect(
			provider.route('anything', { roster: ROSTER, scope: { kind: 'conductor' } })
		).rejects.toMatchObject({ kind: 'unavailable' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
