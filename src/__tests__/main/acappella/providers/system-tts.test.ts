/**
 * @file system-tts.test.ts
 *
 * The operating system's voice as a TTS provider. The engine is injected for
 * every test but the last, because the point of the provider is its contract
 * with the speech scheduler (one chunk per sentence, a real cancel, classified
 * failures), not whether `say` exists on the CI runner. The last test runs the
 * real macOS engine and is skipped everywhere else.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	SystemVoiceTtsProvider,
	parseMacVoiceList,
	systemVoiceUnavailability,
	type SystemVoiceAudio,
	type SystemVoiceRequest,
} from '../../../../main/acappella/providers/local/system-tts';
import { decodeWavPcm16, encodeWav } from '../../../../main/acappella/providers/pcm';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { TtsChunk } from '../../../../shared/acappella/providers';

async function collect(iterable: AsyncIterable<TtsChunk>): Promise<TtsChunk[]> {
	const chunks: TtsChunk[] = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

/** An engine that returns a short buffer per sentence and records what it saw. */
function fakeEngine(options: { delayMs?: number; sampleRate?: number } = {}) {
	const requests: SystemVoiceRequest[] = [];
	const synthesize = vi.fn(async (request: SystemVoiceRequest): Promise<SystemVoiceAudio> => {
		requests.push(request);
		if (options.delayMs) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.delayMs);
				request.signal.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new Error('cancelled'));
				});
			});
		}
		return { sampleRate: options.sampleRate ?? 24_000, pcm: new Int16Array(480) };
	});
	return { synthesize, requests };
}

describe('SystemVoiceTtsProvider', () => {
	it('synthesises one chunk per sentence, as 16-bit PCM at the engine rate', async () => {
		const engine = fakeEngine({ sampleRate: 22_050 });
		const provider = new SystemVoiceTtsProvider({
			synthesize: engine.synthesize,
			listVoices: async () => [],
		});

		const chunks = await collect(provider.speak('First one. Second one.', { utteranceId: 'u1' }));

		expect(chunks.map((chunk) => chunk.text)).toEqual(['First one.', 'Second one.']);
		expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
		expect(chunks[0].format).toBe('pcm16');
		expect(chunks[0].sampleRate).toBe(22_050);
		expect(chunks[0].audio?.byteLength).toBe(480 * 2);
		expect(engine.requests.map((request) => request.text)).toEqual(['First one.', 'Second one.']);
	});

	it('passes the rate through and drops a voice this machine does not have', async () => {
		const engine = fakeEngine();
		const provider = new SystemVoiceTtsProvider({
			synthesize: engine.synthesize,
			listVoices: async () => [{ id: 'Samantha', name: 'Samantha (en_US)' }],
		});

		await collect(provider.speak('Hello.', { utteranceId: 'u1', voiceId: 'Samantha', rate: 1.2 }));
		// An ElevenLabs id left in settings must not reach `say -v` and fail every
		// sentence; the engine's default voice speaks instead.
		await collect(provider.speak('Hello.', { utteranceId: 'u2', voiceId: '21m00Tcm4TlvDq8ikWAM' }));

		expect(engine.requests[0]).toMatchObject({ voiceId: 'Samantha', rate: 1.2 });
		expect(engine.requests[1].voiceId).toBeUndefined();
	});

	it('cancels the sentence being made and delivers nothing after it', async () => {
		const engine = fakeEngine({ delayMs: 50 });
		const provider = new SystemVoiceTtsProvider({
			synthesize: engine.synthesize,
			listVoices: async () => [],
		});

		const iterator = provider
			.speak('One. Two. Three.', { utteranceId: 'u1' })
			[Symbol.asyncIterator]();
		const first = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 10));
		provider.cancel();

		const result = await first;
		// The abort reaches the engine and the run ends quietly, without the
		// sentence it interrupted and without throwing into the scheduler.
		expect(result.done).toBe(true);
		expect(engine.requests[0].signal.aborted).toBe(true);
		expect(engine.synthesize).toHaveBeenCalledTimes(1);
	});

	it('drops the rest of a run that was cancelled between sentences', async () => {
		const engine = fakeEngine();
		const provider = new SystemVoiceTtsProvider({
			synthesize: engine.synthesize,
			listVoices: async () => [],
		});

		const chunks: TtsChunk[] = [];
		for await (const chunk of provider.speak('One. Two. Three.', { utteranceId: 'u1' })) {
			chunks.push(chunk);
			provider.cancel();
		}

		expect(chunks).toHaveLength(1);
	});

	it('lets a classified engine failure through so the session can announce it', async () => {
		const provider = new SystemVoiceTtsProvider({
			synthesize: async () => {
				throw new VoiceProviderError('The system speech engine (espeak-ng) is not installed.', {
					kind: 'unavailable',
					providerId: 'system-tts',
				});
			},
			listVoices: async () => [],
		});

		await expect(collect(provider.speak('Hello.', { utteranceId: 'u1' }))).rejects.toMatchObject({
			kind: 'unavailable',
			providerId: 'system-tts',
		});
	});

	it('speaks nothing for text with no sentences in it', async () => {
		const engine = fakeEngine();
		const provider = new SystemVoiceTtsProvider({
			synthesize: engine.synthesize,
			listVoices: async () => [],
		});

		expect(await collect(provider.speak('   ', { utteranceId: 'u1' }))).toEqual([]);
		expect(engine.synthesize).not.toHaveBeenCalled();
	});

	it('reads the installed voices once and caches them', async () => {
		const listVoices = vi.fn(async () => [{ id: 'Daniel', name: 'Daniel (en_GB)' }]);
		const provider = new SystemVoiceTtsProvider({
			synthesize: fakeEngine().synthesize,
			listVoices,
		});

		expect(await provider.listVoices()).toEqual([{ id: 'Daniel', name: 'Daniel (en_GB)' }]);
		await provider.listVoices();
		expect(listVoices).toHaveBeenCalledTimes(1);
	});
});

describe('parseMacVoiceList', () => {
	it('parses `say -v ?` and lists English voices first', () => {
		const output = [
			'Alice               it_IT    # Ciao! Mi chiamo Alice.',
			'Daniel              en_GB    # Hello! My name is Daniel.',
			'Eddy (English (US)) en_US    # Hello! My name is Eddy.',
			'not a voice line',
		].join('\n');

		expect(parseMacVoiceList(output)).toEqual([
			{ id: 'Daniel', name: 'Daniel (en_GB)' },
			{ id: 'Eddy (English (US))', name: 'Eddy (English (US)) (en_US)' },
			{ id: 'Alice', name: 'Alice (it_IT)' },
		]);
	});
});

describe('decodeWavPcm16', () => {
	it('round-trips the encoder and survives a leading JUNK chunk', () => {
		const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
		const wav = encodeWav(pcm, 24_000);

		const decoded = decodeWavPcm16(wav);
		expect(decoded.sampleRate).toBe(24_000);
		expect(Array.from(decoded.pcm)).toEqual(Array.from(pcm));

		// macOS `say` writes a JUNK chunk ahead of `fmt `. A reader that assumed
		// the canonical 44-byte header would read garbage as samples.
		const junk = new Uint8Array(8 + 4);
		junk.set([0x4a, 0x55, 0x4e, 0x4b, 4, 0, 0, 0], 0);
		const padded = new Uint8Array(12 + junk.length + (wav.length - 12));
		padded.set(wav.subarray(0, 12), 0);
		padded.set(junk, 12);
		padded.set(wav.subarray(12), 12 + junk.length);
		expect(Array.from(decodeWavPcm16(padded).pcm)).toEqual(Array.from(pcm));
	});

	it('refuses anything that is not 16-bit PCM', () => {
		expect(() => decodeWavPcm16(new Uint8Array([1, 2, 3]))).toThrow(/Not a WAV/);
	});
});

describe('systemVoiceUnavailability', () => {
	it('never reports a missing engine on macOS or Windows', async () => {
		if (process.platform !== 'darwin' && process.platform !== 'win32') return;
		expect(await systemVoiceUnavailability()).toBeNull();
	});
});

// The real engine, on the one platform this suite runs on that has it. Proves
// the argument list, the stdin hand-off, and the WAV decode against the actual
// binary rather than a fake of it.
describe.runIf(process.platform === 'darwin')('SystemVoiceTtsProvider on macOS', () => {
	it('speaks a sentence through `say` and returns audible 24 kHz PCM', async () => {
		const provider = new SystemVoiceTtsProvider();
		const chunks = await collect(
			provider.speak('Maestro is listening.', { utteranceId: 'u1', rate: 1.1 })
		);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].sampleRate).toBe(24_000);
		const samples = new Int16Array(
			chunks[0].audio!.buffer,
			chunks[0].audio!.byteOffset,
			chunks[0].audio!.byteLength / 2
		);
		// Longer than half a second, and not silence.
		expect(samples.length).toBeGreaterThan(12_000);
		expect(samples.some((sample) => Math.abs(sample) > 1000)).toBe(true);

		const voices = await provider.listVoices();
		expect(voices.length).toBeGreaterThan(0);
	}, 20_000);
});
