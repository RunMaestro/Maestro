/**
 * @file openai-tts.test.ts
 *
 * OpenAI as the hosted voice. Same contract the ElevenLabs suite pins - one
 * request per sentence, a cancel that aborts the socket, classified failures -
 * plus the two things specific to this endpoint: raw 24 kHz PCM comes back and
 * goes out unchanged, and a voice chosen for a different provider is not sent.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	OpenAiTtsProvider,
	OPENAI_TTS_SAMPLE_RATE,
	OPENAI_TTS_VOICES,
} from '../../../../main/acappella/providers/hosted/openai-tts';
import type { TtsChunk } from '../../../../shared/acappella/providers';

async function collect(iterable: AsyncIterable<TtsChunk>): Promise<TtsChunk[]> {
	const chunks: TtsChunk[] = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

function fetchReturningPcm(bytes = 960) {
	const calls: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			signal: init?.signal ?? undefined,
		});
		return new Response(new Uint8Array(bytes), { status: 200 });
	});
	return { fetchImpl, calls };
}

describe('OpenAiTtsProvider', () => {
	it('refuses without a key, before any request is made', async () => {
		const { fetchImpl } = fetchReturningPcm();
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => null });

		await expect(collect(provider.speak('Hello.', { utteranceId: 'u1' }))).rejects.toMatchObject({
			kind: 'unavailable',
			providerId: 'openai-tts',
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('synthesises one request per sentence and returns 24 kHz PCM', async () => {
		const { fetchImpl, calls } = fetchReturningPcm();
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => 'sk-test' });

		const chunks = await collect(
			provider.speak('First one. Second one.', { utteranceId: 'u1', voiceId: 'nova', rate: 1.2 })
		);

		expect(chunks.map((chunk) => chunk.text)).toEqual(['First one.', 'Second one.']);
		expect(chunks[0].format).toBe('pcm16');
		expect(chunks[0].sampleRate).toBe(OPENAI_TTS_SAMPLE_RATE);
		expect(chunks[0].audio?.byteLength).toBe(960);
		expect(calls).toHaveLength(2);
		expect(calls[0].url).toBe('https://api.openai.com/v1/audio/speech');
		expect(calls[0].body).toMatchObject({
			model: 'gpt-4o-mini-tts',
			input: 'First one.',
			voice: 'nova',
			response_format: 'pcm',
			speed: 1.2,
		});
	});

	it('falls back to its own default voice for an id from another provider', async () => {
		const { fetchImpl, calls } = fetchReturningPcm();
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => 'sk-test' });

		await collect(provider.speak('Hello.', { utteranceId: 'u1', voiceId: 'Samantha' }));

		expect(calls[0].body.voice).toBe('alloy');
	});

	it('aborts the in-flight request on cancel and ends the run quietly', async () => {
		let abortSignal: AbortSignal | undefined;
		const fetchImpl = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					abortSignal = init?.signal ?? undefined;
					abortSignal?.addEventListener('abort', () =>
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
					);
				})
		);
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => 'sk-test' });

		const iterator = provider.speak('Hello there.', { utteranceId: 'u1' })[Symbol.asyncIterator]();
		const first = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 5));
		provider.cancel();

		expect((await first).done).toBe(true);
		expect(abortSignal?.aborted).toBe(true);
	});

	it('classifies an auth failure by name', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => 'sk-test' });

		await expect(collect(provider.speak('Hello.', { utteranceId: 'u1' }))).rejects.toMatchObject({
			kind: 'auth',
			httpStatus: 401,
		});
	});

	it('clamps the speed to the range the endpoint accepts', async () => {
		const { fetchImpl, calls } = fetchReturningPcm();
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => 'sk-test' });

		await collect(provider.speak('Hello.', { utteranceId: 'u1', rate: 9 }));

		expect(calls[0].body.speed).toBe(4);
	});

	it('lists the documented voices without a request', () => {
		const { fetchImpl } = fetchReturningPcm();
		const provider = new OpenAiTtsProvider({ fetchImpl, readCredential: () => null });

		expect(provider.listVoices().map((voice) => voice.id)).toEqual(
			OPENAI_TTS_VOICES.map((voice) => voice.id)
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
