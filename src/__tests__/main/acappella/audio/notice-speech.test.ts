/**
 * @file notice-speech.test.ts
 *
 * The audio host's speakers in their session-less mode. The class takes no
 * session service at all, so "starts no voice session" is true by
 * construction; what these pin is everything it does with the playback path it
 * borrows:
 *
 *   - **Nothing is sent before the host can hear it.**
 *   - **It resolves when the audio was HEARD**, not when it was sent.
 *   - **A lost drain report cannot hold the queue.**
 *   - **An abort cuts the audio**: the synthesiser stops and the host flushes.
 *   - **A voice that produced nothing is a failure**, never a silent success.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	NOTICE_DRAIN_MARGIN_MS,
	NOTICE_HOST_READY_TIMEOUT_MS,
	NoticeSpeech,
	type NoticeSpeechDeps,
} from '../../../../main/acappella/audio/notice-speech';
import type { AudioHostCommand } from '../../../../shared/acappella/audio-host';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';

const SAMPLE_RATE = 24_000;

/** One second of silence as pcm16. */
function oneSecond(): Uint8Array {
	return new Uint8Array(SAMPLE_RATE * 2);
}

/** A voice that yields the chunks a test gives it, and records what it was asked. */
function fakeTts(chunks: Array<Partial<TtsChunk>> = [{}]) {
	const asked: Array<{ text: string; options: TtsSpeakOptions }> = [];
	const tts = {
		id: 'system-tts',
		label: 'System voice',
		tier: 'local' as const,
		cancel: vi.fn(),
		speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
			asked.push({ text, options });
			return (async function* () {
				for (const [index, chunk] of chunks.entries()) {
					yield {
						utteranceId: options.utteranceId,
						index,
						text,
						format: 'pcm16',
						audio: oneSecond(),
						sampleRate: SAMPLE_RATE,
						...chunk,
					} as TtsChunk;
				}
			})();
		},
	} satisfies TtsProvider;
	return { tts, asked };
}

function harness(
	overrides: Partial<NoticeSpeechDeps> & { tts?: TtsProvider; ready?: boolean } = {}
) {
	const commands: AudioHostCommand[] = [];
	const voice = fakeTts();
	let ready = overrides.ready ?? true;
	const deps: NoticeSpeechDeps = {
		refusal: overrides.refusal ?? (() => null),
		readVoice:
			overrides.readVoice ??
			(() => ({ tts: overrides.tts ?? voice.tts, voiceId: 'Samantha', rate: 1.1, volume: 0.6 })),
		ensureAudioHost: vi.fn(overrides.ensureAudioHost ?? (() => true)),
		isAudioHostReady: () => ready,
		sendCommand: (command) => commands.push(command),
		hostReadyTimeoutMs: overrides.hostReadyTimeoutMs,
		drainMarginMs: overrides.drainMarginMs,
	};
	const speech = new NoticeSpeech(deps);
	return {
		speech,
		deps,
		commands,
		voice,
		kinds: () => commands.map((command) => command.kind),
		hostBecomesReady() {
			ready = true;
			speech.handleStatus({ kind: 'ready' });
		},
		/** The host reports the utterance drained. */
		drain() {
			speech.handleStatus({
				kind: 'playback-state',
				playing: false,
				utteranceId: null,
				queuedMs: 0,
			});
		},
	};
}

/** Let the async generator and the awaits inside `speak` run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('NoticeSpeech', () => {
	it('removes emoji from agent announcements before passing them to the voice', async () => {
		const h = harness();
		const speaking = h.speech.speak(
			'🏢 **Pedro Sidián** finished ✅',
			new AbortController().signal
		);
		await flush();
		expect(h.voice.asked[0].text).toBe('Pedro Sidián finished');
		h.drain();
		await speaking;
	});
	it('does not open an audio host for an emoji-only notice', async () => {
		const h = harness();
		await h.speech.speak('🎉', new AbortController().signal);
		expect(h.commands).toEqual([]);
		expect(h.voice.asked).toEqual([]);
	});
	it('reports whatever keeps it silent (a live voice session)', () => {
		const refusal = { code: 'voice-session-active' as const, message: 'A session is live.' };
		expect(harness({ refusal: () => refusal }).speech.refusal()).toBe(refusal);
		expect(harness().speech.refusal()).toBeNull();
	});

	it('sets the volume, plays the audio, marks the end, and resolves once it was heard', async () => {
		const h = harness();
		let settled = false;
		const speaking = h.speech.speak('Backend finished', new AbortController().signal).then(() => {
			settled = true;
		});
		await flush();

		expect(h.kinds()).toEqual(['set-volume', 'play', 'end-utterance']);
		expect(h.commands[0]).toEqual({ kind: 'set-volume', volume: 0.6 });
		expect(h.commands[1]).toMatchObject({ kind: 'play', format: 'pcm16', sampleRate: SAMPLE_RATE });
		expect(h.voice.asked).toEqual([
			{
				text: 'Backend finished',
				options: { utteranceId: 'notice-1', voiceId: 'Samantha', rate: 1.1 },
			},
		]);
		// Sent is not heard: the audio is still playing.
		expect(settled).toBe(false);

		h.drain();
		await speaking;
		expect(settled).toBe(true);
	});

	it('does not mistake the gap between two sentences for the end', async () => {
		const voice = fakeTts([{}, {}]);
		const h = harness({ tts: voice.tts });
		let settled = false;
		const speaking = h.speech.speak('One. Two.', new AbortController().signal).then(() => {
			settled = true;
		});
		await flush();

		// The host drained between sentences and still names the utterance.
		h.speech.handleStatus({
			kind: 'playback-state',
			playing: false,
			utteranceId: 'notice-1',
			queuedMs: 0,
		});
		await flush();
		expect(settled).toBe(false);

		h.drain();
		await speaking;
		expect(h.kinds()).toEqual(['set-volume', 'play', 'play', 'end-utterance']);
	});

	it('waits for the host to load before it sends anything', async () => {
		const h = harness({ ready: false });
		const speaking = h.speech.speak('Backend finished', new AbortController().signal);
		await flush();

		expect(h.deps.ensureAudioHost).toHaveBeenCalled();
		expect(h.commands).toEqual([]);

		h.hostBecomesReady();
		await flush();
		expect(h.kinds()).toEqual(['set-volume', 'play', 'end-utterance']);
		h.drain();
		await speaking;
	});

	it('fails by name when the host never loads', async () => {
		const h = harness({ ready: false });
		const speaking = h.speech.speak('Backend finished', new AbortController().signal);
		const outcome = expect(speaking).rejects.toThrow(/audio host did not start/);

		await vi.advanceTimersByTimeAsync(NOTICE_HOST_READY_TIMEOUT_MS);
		await outcome;
		expect(h.commands).toEqual([]);
	});

	it('fails by name when there is no audio host to open', async () => {
		const h = harness({ ensureAudioHost: () => false });
		await expect(h.speech.speak('hi', new AbortController().signal)).rejects.toThrow(
			/no audio host/
		);
		expect(h.commands).toEqual([]);
	});

	it('does not hold the queue when the drain report is lost', async () => {
		const h = harness();
		let settled = false;
		const speaking = h.speech.speak('Backend finished', new AbortController().signal).then(() => {
			settled = true;
		});
		await flush();

		// One second of audio plus the margin, and no report ever arrives.
		await vi.advanceTimersByTimeAsync(1000 + NOTICE_DRAIN_MARGIN_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await speaking;
		expect(settled).toBe(true);
	});

	it('cuts the audio when aborted: the voice stops and the host flushes', async () => {
		const h = harness();
		const abort = new AbortController();
		const speaking = h.speech.speak('Backend finished', abort.signal);
		const outcome = expect(speaking).rejects.toThrow(/cancelled/);
		await flush();

		abort.abort();
		await outcome;

		expect(h.voice.tts.cancel).toHaveBeenCalled();
		expect(h.kinds()).toContain('flush');
	});

	it('speaks nothing when it was aborted before it began', async () => {
		const h = harness();
		const abort = new AbortController();
		abort.abort();

		await expect(h.speech.speak('hi', abort.signal)).rejects.toThrow(/cancelled/);
		expect(h.commands).toEqual([]);
	});

	it('fails when the voice produced no audio, instead of resolving in silence', async () => {
		const voice = fakeTts([{ format: 'none', audio: null }]);
		const h = harness({ tts: voice.tts });

		await expect(h.speech.speak('hi', new AbortController().signal)).rejects.toThrow(
			/produced no audio/
		);
		expect(h.kinds()).toEqual(['set-volume']);
	});

	it("passes the voice's own failure through, so the notice names it", async () => {
		const tts = {
			...fakeTts().tts,
			speak(): AsyncIterable<TtsChunk> {
				return (async function* (): AsyncGenerator<TtsChunk> {
					throw new Error('No system speech engine is installed (espeak-ng).');
				})();
			},
		} satisfies TtsProvider;
		const h = harness({ tts });

		await expect(h.speech.speak('hi', new AbortController().signal)).rejects.toThrow(/espeak-ng/);
	});

	it('gives each notice its own utterance id', async () => {
		const h = harness();
		const first = h.speech.speak('one', new AbortController().signal);
		await flush();
		h.drain();
		await first;
		const second = h.speech.speak('two', new AbortController().signal);
		await flush();
		h.drain();
		await second;

		expect(h.voice.asked.map((ask) => ask.options.utteranceId)).toEqual(['notice-1', 'notice-2']);
	});
});
