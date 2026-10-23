/**
 * @file dictation.test.ts
 *
 * Dictation's core: the one-shot `transcribeClip` and the recording sequence
 * around it, with the task router, task readiness, and the microphone mocked.
 * Properties worth protecting:
 *
 *   - **`transcribeClip` runs the Dictation task**, and nothing else.
 *   - **No microphone, no recording.** Refused by name, never a throw.
 *   - **The task is checked before the microphone is opened.**
 *   - **One recording, owned by the client that started it.**
 *   - **The microphone is released before the transcript is awaited**, so the
 *     next recording can start while the last one decodes.
 *   - **A stop before the microphone opened cancels**; nothing was recorded.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const localClip = vi.hoisted(() => ({
	assignments: {} as Record<string, unknown>,
	transcribe: vi.fn(),
}));
vi.mock('../../../main/local-models/sources', () => ({
	readLocalModelAssignments: () => localClip.assignments,
}));
vi.mock('../../../main/local-models/speech-to-text', () => ({
	transcribeSpeech: localClip.transcribe,
}));

const router = vi.hoisted(() => ({ runSpeechToTextTask: vi.fn() }));
const readiness = vi.hoisted(() => ({ resolveTaskReadiness: vi.fn() }));
const correction = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../main/local-models/speech-vocabulary', () => ({
	correctSpeechVocabulary: correction.run,
}));

vi.mock('../../../main/local-models/task-router', () => ({
	runSpeechToTextTask: router.runSpeechToTextTask,
}));
vi.mock('../../../main/local-models/task-readiness', () => ({
	resolveTaskReadiness: readiness.resolveTaskReadiness,
}));

import {
	__resetDictation,
	cancelDictation,
	isDictationRecording,
	onDictationInterrupted,
	registerDictationMicrophone,
	startDictation,
	stopDictation,
	transcribeAudioFileRequest,
	transcribeClip,
	resolveLocalClipTranscriber,
	type DictationClip,
	type DictationMicrophone,
} from '../../../main/local-models/dictation';
import type {
	DictationInterruption,
	DictationStartResult,
} from '../../../shared/local-models/dictation';
import { encodeWav } from '../../../shared/audio/pcm';

const SOURCE = { type: 'local', modelId: 'parakeet-tdt-0.6b-v2' } as const;
const CLIP: DictationClip = { audio: new Float32Array(16000), sampleRate: 16000 };

/** A promise a test settles by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function fakeMicrophone(
	start: () => Promise<DictationStartResult> = async () => ({ started: true })
) {
	const listeners = new Set<(interruption: DictationInterruption) => void>();
	const microphone = {
		start: vi.fn(start),
		stop: vi.fn(async (): Promise<DictationClip> => CLIP),
		cancel: vi.fn(async () => {}),
		onInterrupted: vi.fn((listener: (interruption: DictationInterruption) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	} satisfies DictationMicrophone;
	return {
		microphone,
		interrupt: (interruption: DictationInterruption) => {
			for (const listener of listeners) listener(interruption);
		},
	};
}

beforeEach(() => {
	__resetDictation();
	correction.run.mockReset().mockImplementation(async (text: string) => text);
	localClip.assignments = {};
	localClip.transcribe.mockReset().mockResolvedValue({ text: 'synthetic fixture', audioMs: 1000 });
	router.runSpeechToTextTask.mockReset().mockResolvedValue({
		status: 'ok',
		text: 'Ship it.',
		audioMs: 1000,
		source: SOURCE,
		durationMs: 120,
	});
	readiness.resolveTaskReadiness.mockReset().mockResolvedValue({
		state: 'ready',
		detail: 'Runs Parakeet on this machine.',
	});
});

describe('transcribeClip', () => {
	it('shares live dictionary hints with the recognizer and applies optional correction once', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone, () => ['🏢 Pedro Sidián']);
		router.runSpeechToTextTask.mockResolvedValue({
			status: 'ok',
			text: 'ask Pet Sidian',
			audioMs: 1000,
			source: SOURCE,
			durationMs: 20,
		});
		correction.run.mockResolvedValue('ask Pedro Sidián');
		await expect(transcribeClip(new Float32Array(8), 16000)).resolves.toMatchObject({
			text: 'ask Pedro Sidián',
		});
		expect(router.runSpeechToTextTask).toHaveBeenCalledWith(
			'dictation',
			expect.objectContaining({ vocabulary: ['Pedro Sidián'] })
		);
		expect(correction.run).toHaveBeenCalledWith('ask Pet Sidian', ['Pedro Sidián'], undefined);
	});
	it('runs the clip through the Dictation task assignment', async () => {
		const audio = new Float32Array(8);
		const abort = new AbortController();

		await expect(transcribeClip(audio, 48000, { signal: abort.signal })).resolves.toMatchObject({
			status: 'ok',
			text: 'Ship it.',
		});
		expect(router.runSpeechToTextTask).toHaveBeenCalledWith('dictation', {
			audio,
			sampleRate: 48000,
			signal: abort.signal,
		});
	});

	it('passes an off or unavailable verdict back as it is, with no fallback', async () => {
		router.runSpeechToTextTask.mockResolvedValue({ status: 'off' });
		await expect(transcribeClip(new Float32Array(8), 16000)).resolves.toEqual({ status: 'off' });
		expect(router.runSpeechToTextTask).toHaveBeenCalledTimes(1);
	});
});

describe('startDictation', () => {
	it('refuses by name when no microphone is registered', async () => {
		await expect(startDictation('window:1')).resolves.toMatchObject({
			started: false,
			code: 'no-microphone',
		});
		expect(readiness.resolveTaskReadiness).not.toHaveBeenCalled();
	});

	it('opens the microphone once the Dictation task is ready', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);

		await expect(startDictation('window:1')).resolves.toEqual({ started: true });
		expect(readiness.resolveTaskReadiness).toHaveBeenCalledWith('dictation');
		expect(microphone.start).toHaveBeenCalledTimes(1);
		expect(isDictationRecording()).toBe(true);
	});

	it.each([
		['off', 'task-off'],
		['unavailable', 'task-unavailable'],
	] as const)('refuses a task that is %s BEFORE the microphone is opened', async (state, code) => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		readiness.resolveTaskReadiness.mockResolvedValue({
			state,
			detail: 'Parakeet TDT 0.6B (English) is not downloaded.',
			suggestedAction: 'Download it in Settings.',
		});

		await expect(startDictation('window:1')).resolves.toEqual({
			started: false,
			code,
			message: 'Parakeet TDT 0.6B (English) is not downloaded. Download it in Settings.',
		});
		expect(microphone.start).not.toHaveBeenCalled();
		expect(isDictationRecording()).toBe(false);
	});

	it('passes a microphone refusal through and holds no slot afterwards', async () => {
		const refusal = {
			started: false,
			code: 'permission-denied',
			message: 'Maestro does not have access to the microphone.',
		} as const;
		const { microphone } = fakeMicrophone(async () => refusal);
		registerDictationMicrophone(microphone);

		await expect(startDictation('window:1')).resolves.toEqual(refusal);
		expect(isDictationRecording()).toBe(false);
	});

	it('refuses a second recording while one is in progress', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await expect(startDictation('window:2')).resolves.toMatchObject({
			started: false,
			code: 'busy',
		});
		expect(microphone.start).toHaveBeenCalledTimes(1);
	});

	it('frees the slot when opening the microphone throws', async () => {
		const { microphone } = fakeMicrophone(async () => {
			throw new Error('host exploded');
		});
		registerDictationMicrophone(microphone);

		await expect(startDictation('window:1')).rejects.toThrow('host exploded');
		expect(isDictationRecording()).toBe(false);
	});
});

describe('stopDictation', () => {
	it('closes the microphone, transcribes the clip, and returns the text', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await expect(stopDictation('window:1')).resolves.toEqual({
			status: 'ok',
			text: 'Ship it.',
			audioMs: 1000,
		});
		expect(microphone.stop).toHaveBeenCalledTimes(1);
		expect(router.runSpeechToTextTask).toHaveBeenCalledWith(
			'dictation',
			expect.objectContaining({ audio: CLIP.audio, sampleRate: 16000 })
		);
	});

	it('answers idle for a client that is not the one recording, and leaves it running', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await expect(stopDictation('window:2')).resolves.toEqual({ status: 'idle' });
		expect(microphone.stop).not.toHaveBeenCalled();
		expect(isDictationRecording()).toBe(true);
	});

	it('frees the microphone before the transcript is back', async () => {
		const transcript = deferred<unknown>();
		router.runSpeechToTextTask.mockReturnValueOnce(transcript.promise);
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		const stopping = stopDictation('window:1');
		await vi.waitFor(() => expect(router.runSpeechToTextTask).toHaveBeenCalledTimes(1));
		// Still decoding, and the next recording can already start.
		await expect(startDictation('window:1')).resolves.toEqual({ started: true });

		transcript.resolve({
			status: 'ok',
			text: 'First.',
			audioMs: 500,
			source: SOURCE,
			durationMs: 9,
		});
		await expect(stopping).resolves.toMatchObject({ status: 'ok', text: 'First.' });
	});

	it('cancels a start whose microphone has not opened yet', async () => {
		const opening = deferred<DictationStartResult>();
		const { microphone } = fakeMicrophone(() => opening.promise);
		microphone.cancel.mockImplementation(async () => {
			opening.resolve({ started: false, code: 'cancelled', message: 'Dictation was cancelled.' });
		});
		registerDictationMicrophone(microphone);

		const starting = startDictation('window:1');
		await vi.waitFor(() => expect(microphone.start).toHaveBeenCalledTimes(1));

		await expect(stopDictation('window:1')).resolves.toEqual({ status: 'cancelled' });
		await expect(starting).resolves.toMatchObject({ started: false, code: 'cancelled' });
		expect(router.runSpeechToTextTask).not.toHaveBeenCalled();
		expect(isDictationRecording()).toBe(false);
	});

	it('reports a source that could not transcribe, naming the reason', async () => {
		router.runSpeechToTextTask.mockResolvedValue({
			status: 'unavailable',
			source: SOURCE,
			reason: 'Parakeet failed on this clip.',
			code: 'generation-failed',
		});
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await expect(stopDictation('window:1')).resolves.toEqual({
			status: 'unavailable',
			reason: 'Parakeet failed on this clip.',
			code: 'generation-failed',
		});
	});

	it('carries the reason a recording ended on its own', async () => {
		const interruption = { code: 'max-duration', message: 'Stopped after 5 minutes.' } as const;
		const { microphone } = fakeMicrophone();
		microphone.stop.mockResolvedValue({ ...CLIP, interruption });
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await expect(stopDictation('window:1')).resolves.toMatchObject({
			status: 'ok',
			interruption,
		});
	});
});

describe('cancelDictation', () => {
	it('discards a recording without transcribing it', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await cancelDictation('window:1');

		expect(microphone.cancel).toHaveBeenCalledTimes(1);
		expect(microphone.stop).not.toHaveBeenCalled();
		expect(router.runSpeechToTextTask).not.toHaveBeenCalled();
		expect(isDictationRecording()).toBe(false);
	});

	it('does nothing for a client that owns no recording', async () => {
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');

		await cancelDictation('window:2');
		expect(microphone.cancel).not.toHaveBeenCalled();
		expect(isDictationRecording()).toBe(true);
	});

	it('aborts a transcript still being produced', async () => {
		let signal: AbortSignal | undefined;
		router.runSpeechToTextTask.mockImplementationOnce(
			(_task: string, input: { signal?: AbortSignal }) => {
				signal = input.signal;
				return new Promise((resolve) => {
					input.signal?.addEventListener('abort', () =>
						resolve({ status: 'cancelled', source: SOURCE })
					);
				});
			}
		);
		const { microphone } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		await startDictation('window:1');
		const stopping = stopDictation('window:1');
		await vi.waitFor(() => expect(signal).toBeDefined());

		await cancelDictation('window:1');

		expect(signal?.aborted).toBe(true);
		await expect(stopping).resolves.toEqual({ status: 'cancelled' });
	});
});

describe('interruptions and the microphone registration', () => {
	it('tells listeners which client lost its recording', async () => {
		const { microphone, interrupt } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		const seen: Array<[string, DictationInterruption]> = [];
		onDictationInterrupted((ownerId, interruption) => seen.push([ownerId, interruption]));
		await startDictation('window:7');

		const interruption = { code: 'device-lost', message: 'The microphone stopped.' } as const;
		interrupt(interruption);

		expect(seen).toEqual([['window:7', interruption]]);
	});

	it('says nothing about an interruption when nobody is recording', () => {
		const { microphone, interrupt } = fakeMicrophone();
		registerDictationMicrophone(microphone);
		const listener = vi.fn();
		onDictationInterrupted(listener);

		interrupt({ code: 'device-lost', message: 'The microphone stopped.' });
		expect(listener).not.toHaveBeenCalled();
	});

	it('unregistering the microphone ends a recording made through it', async () => {
		const { microphone } = fakeMicrophone();
		const unregister = registerDictationMicrophone(microphone);
		await startDictation('window:1');

		unregister();

		expect(microphone.cancel).toHaveBeenCalledTimes(1);
		expect(isDictationRecording()).toBe(false);
		await expect(startDictation('window:1')).resolves.toMatchObject({ code: 'no-microphone' });
	});
});

describe('transcribeAudioFileRequest', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-dictation-'));
		router.runSpeechToTextTask.mockResolvedValue({
			status: 'ok',
			text: 'from a file',
			audioMs: 500,
			source: SOURCE,
			durationMs: 40,
		});
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('decodes a WAV file and runs it on the Dictation task', async () => {
		const file = path.join(dir, 'clip.wav');
		await fs.writeFile(file, encodeWav(new Int16Array([0, 16384, -16384, 32767]), 22050));

		const result = await transcribeAudioFileRequest(file);

		expect(result).toMatchObject({ status: 'ok', text: 'from a file' });
		const [taskId, input] = router.runSpeechToTextTask.mock.calls[0];
		expect(taskId).toBe('dictation');
		expect(input.sampleRate).toBe(22050);
		expect(input.audio).toBeInstanceOf(Float32Array);
		expect(input.audio).toHaveLength(4);
		expect(input.audio[1]).toBeCloseTo(0.5, 2);
	});

	it('passes a task that is off through as an answer, not a throw', async () => {
		router.runSpeechToTextTask.mockResolvedValue({ status: 'off' });
		const file = path.join(dir, 'clip.wav');
		await fs.writeFile(file, encodeWav(new Int16Array(8)));
		await expect(transcribeAudioFileRequest(file)).resolves.toEqual({ status: 'off' });
	});

	it.each([[undefined], [''], [42], ['relative/clip.wav']])(
		'refuses a request without an absolute path (%j)',
		async (bad) => {
			await expect(transcribeAudioFileRequest(bad)).rejects.toThrow(/absolute path to a WAV file/);
			expect(router.runSpeechToTextTask).not.toHaveBeenCalled();
		}
	);

	it('names a file that does not exist', async () => {
		const missing = path.join(dir, 'nope.wav');
		await expect(transcribeAudioFileRequest(missing)).rejects.toThrow(`No such file: ${missing}`);
	});

	it('refuses a directory', async () => {
		await expect(transcribeAudioFileRequest(dir)).rejects.toThrow(/Not a file/);
	});

	it('refuses a file that is not a WAV and says what is read', async () => {
		const file = path.join(dir, 'clip.mp3');
		await fs.writeFile(file, Buffer.from('ID3 not a wav at all'));
		await expect(transcribeAudioFileRequest(file)).rejects.toThrow(
			/Not a WAV file\. Dictation reads 16-bit PCM WAV files\./
		);
		expect(router.runSpeechToTextTask).not.toHaveBeenCalled();
	});
});

describe('local-only Dictation snapshot', () => {
	it.each(['whisper-base', 'whisper-small'])(
		'keeps selected %s across settings changes while readiness is pending',
		async (modelId) => {
			const gate = deferred<{ state: string; reason?: string }>();
			localClip.assignments = {
				dictation: { type: 'local', modelId, language: 'de' },
			};
			readiness.resolveTaskReadiness.mockReturnValueOnce(gate.promise);
			const pending = resolveLocalClipTranscriber();
			localClip.assignments.dictation = { type: 'endpoint', endpointId: 'cloud', model: 'paid' };
			gate.resolve({ state: 'ready' });
			const snapshot = await pending;
			expect(snapshot.modelId).toBe(modelId);
			expect(snapshot.language).toBe('de');
			await snapshot.transcribe(CLIP.audio, CLIP.sampleRate, { language: 'de' });
			expect(localClip.transcribe).toHaveBeenCalledWith(
				{ type: 'local', modelId, language: 'de' },
				CLIP.audio,
				CLIP.sampleRate,
				{ language: 'de' }
			);
		}
	);
	it.each([{ type: 'off' }, { type: 'endpoint', endpointId: 'cloud', model: 'paid' }])(
		'refuses $type without probing or invoking it',
		async (assignment) => {
			localClip.assignments = { dictation: assignment };
			const snapshot = await resolveLocalClipTranscriber();
			expect(snapshot.reason).toBe(assignment.type === 'off' ? 'off' : 'local-required');
			expect(readiness.resolveTaskReadiness).not.toHaveBeenCalled();
			await expect(
				snapshot.transcribe(CLIP.audio, CLIP.sampleRate, { language: 'de' })
			).rejects.toMatchObject({ code: 'model-unsupported' });
			expect(localClip.transcribe).not.toHaveBeenCalled();
		}
	);
});
