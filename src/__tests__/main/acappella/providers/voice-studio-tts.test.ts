/** Native seeded synthesis, stable voice names, cancellation and incomplete-stream refusal. */
import { describe, expect, it, vi } from 'vitest';
import {
	VoiceStudioClient,
	VoiceStudioTtsProvider,
} from '../../../../main/acappella/providers/local/voice-studio-tts';
import { DEFAULT_VOICE_STUDIO_CONFIG } from '../../../../shared/acappella/voice-studio';
import type { TtsChunk } from '../../../../shared/acappella/providers';

describe('VoiceStudioTtsProvider', () => {
	it('uses the native seeded route and resolves a profile again after its id changes', async () => {
		let profileId = 'first-import';
		const request = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/profiles'))
				return Response.json([{ id: profileId, name: 'Pedram VoxCPM2' }]);
			const form = init?.body as FormData;
			expect(url).toBe('http://127.0.0.1:3900/generate');
			expect(Object.fromEntries(form.entries())).toMatchObject({
				profile_id: profileId,
				engine: 'voxcpm2',
				seed: '11',
				stream: 'true',
				effect_preset: 'raw',
				speed: '1.2',
			});
			const events = [
				{ type: 'start', sample_rate: 48000, channels: 1, format: 'pcm16' },
				{ type: 'chunk', seq: 0, pcm: 'AQACAA==' },
				{ type: 'done', dropped_chunks: 0 },
			];
			// Split inside a JSON token and omit the final newline.
			const wire = events.map((event) => JSON.stringify(event)).join('\n');
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(wire.slice(0, 17)));
						controller.enqueue(new TextEncoder().encode(wire.slice(17)));
						controller.close();
					},
				})
			);
		});
		const provider = new VoiceStudioTtsProvider(
			new VoiceStudioClient(DEFAULT_VOICE_STUDIO_CONFIG, request)
		);
		expect(await provider.listVoices()).toEqual([{ id: 'Pedram VoxCPM2', name: 'Pedram VoxCPM2' }]);
		for (const id of ['first-import', 'second-import']) {
			profileId = id;
			const chunks: TtsChunk[] = [];
			for await (const chunk of provider.speak('First sentence. Second sentence.', {
				utteranceId: 'u1',
				voiceId: 'Pedram VoxCPM2',
				rate: 1.2,
			}))
				chunks.push(chunk);
			expect(chunks.map(({ text, sampleRate }) => ({ text, sampleRate }))).toEqual([
				{ text: 'First sentence.', sampleRate: 48000 },
				{ text: 'Second sentence.', sampleRate: 48000 },
			]);
			expect([...chunks[0].audio!]).toEqual([1, 0, 2, 0]);
		}
	});
	it('refuses a stale voice name before sending text for synthesis', async () => {
		const request = vi.fn(async () => Response.json([{ id: 'new-id', name: 'Other voice' }]));
		const provider = new VoiceStudioTtsProvider(
			new VoiceStudioClient(DEFAULT_VOICE_STUDIO_CONFIG, request)
		);
		await expect(
			provider
				.speak('Hello.', { utteranceId: 'u', voiceId: 'Missing voice' })
				[Symbol.asyncIterator]()
				.next()
		).rejects.toMatchObject({ kind: 'unavailable' });
		expect(request).toHaveBeenCalledTimes(1);
	});
	it('aborts an in-flight render on barge-in and drops the cancelled sentence', async () => {
		let signal: AbortSignal | undefined;
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const request = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/profiles')) return Response.json([{ id: 'id', name: 'Pedram VoxCPM2' }]);
			signal = init?.signal ?? undefined;
			notifyStarted();
			return new Promise<Response>((_resolve, reject) =>
				signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
					once: true,
				})
			);
		});
		const provider = new VoiceStudioTtsProvider(
			new VoiceStudioClient(DEFAULT_VOICE_STUDIO_CONFIG, request)
		);
		const next = provider
			.speak('Hello.', { utteranceId: 'u', voiceId: 'Pedram VoxCPM2' })
			[Symbol.asyncIterator]()
			.next();
		await started;
		provider.cancel();
		expect((await next).done).toBe(true);
		expect(signal?.aborted).toBe(true);
	});
	it.each([
		'{"type":"start","sample_rate":48000,"channels":1,"format":"pcm16"}\n{"type":"chunk","seq":0,"pcm":"AQACAA=="}\n',
		'{"type":"chunk","seq":0,"pcm":"AQACAA=="}\n{"type":"done"}\n',
		'{"type":"start","sample_rate":24000,"channels":1,"format":"pcm16"}\n{"type":"chunk","seq":0,"pcm":"AQACAA=="}\n{"type":"done","dropped_chunks":1}\n',
	])('refuses incomplete or invalid audio without yielding it', async (wire) => {
		const request = vi.fn(async () => new Response(wire));
		await expect(
			new VoiceStudioClient(DEFAULT_VOICE_STUDIO_CONFIG, request).synthesize(
				'Hello.',
				'id',
				1,
				new AbortController().signal
			)
		).rejects.toMatchObject({ kind: 'server' });
	});
	it('reports worker contention without replaying the sentence', async () => {
		const request = vi.fn(async () => new Response('', { status: 429 }));
		await expect(
			new VoiceStudioClient(DEFAULT_VOICE_STUDIO_CONFIG, request).synthesize(
				'Hello.',
				'id',
				1,
				new AbortController().signal
			)
		).rejects.toMatchObject({ kind: 'busy' });
		expect(request).toHaveBeenCalledTimes(1);
	});
	it('checks health and profiles without synthesizing speech', async () => {
		const request = vi.fn(async (url: string) =>
			Response.json(
				url.endsWith('/health')
					? { status: 'ok', version: '0.5.2' }
					: [{ id: 'id', name: 'Pedram VoxCPM2' }]
			)
		);
		expect(
			await new VoiceStudioClient(DEFAULT_VOICE_STUDIO_CONFIG, request).status()
		).toMatchObject({ connected: true, profiles: [{ name: 'Pedram VoxCPM2' }] });
		expect(request.mock.calls.map(([url]) => url)).toEqual([
			'http://127.0.0.1:3900/health',
			'http://127.0.0.1:3900/profiles',
		]);
	});
});
