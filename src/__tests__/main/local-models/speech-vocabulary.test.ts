import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/local-models/task-router', () => ({ runLocalTask: vi.fn() }));

import {
	applySpeechVocabularyCorrections,
	correctSpeechVocabulary,
} from '../../../main/local-models/speech-vocabulary';
import type { LocalTaskInput, LocalTaskResult } from '../../../main/local-models/task-router';

const vocabulary = ['Pedro Sidián', 'Maestro'];
const edit = (from: string, to: string) => ({ replacements: [{ from, to }] });
const reply = (json: unknown): LocalTaskResult => ({
	status: 'ok',
	text: JSON.stringify(json),
	json,
	source: { type: 'local', modelId: 'small-model' },
	durationMs: 1,
});

afterEach(() => vi.useRealTimers());

describe('dictionary correction validation', () => {
	it('fixes a misheard name and preserves every other byte, including negation', () => {
		expect(
			applySpeechVocabularyCorrections(
				"Don't send Pet Sidian the 42 files.",
				vocabulary,
				edit('Pet Sidian', 'Pedro Sidián')
			)
		).toBe("Don't send Pedro Sidián the 42 files.");
	});
	it('rejects unknown terms, arbitrary rewrites, partial words, repeated spans and numeric edits', () => {
		for (const [text, value] of [
			['ask Pet Sidian', edit('Pet Sidian', 'Other agent')],
			["Don't send it", edit("Don't send it", 'Maestro')],
			['xPet Sidianx', edit('Pet Sidian', 'Pedro Sidián')],
			['Pet Sidian and Pet Sidian', edit('Pet Sidian', 'Pedro Sidián')],
			['42', edit('42', 'Maestro')],
		] as const)
			expect(applySpeechVocabularyCorrections(text, vocabulary, value)).toBe(text);
	});
	it('preserves ambiguity between similar names and refuses to change a valid dictionary name', () => {
		const names = ['Pedro Sidián', 'Pedro Sidian', 'Peter Sidian'];
		expect(
			applySpeechVocabularyCorrections('Pet Sidian', names, edit('Pet Sidian', 'Pedro Sidián'))
		).toBe('Pet Sidian');
		expect(
			applySpeechVocabularyCorrections('Peter Sidian', names, edit('Peter Sidian', 'Pedro Sidián'))
		).toBe('Peter Sidian');
	});
});

describe('bounded optional correction', () => {
	it('constrains model output to the dictionary and sends data in a separate JSON prompt', async () => {
		const run = vi.fn(async (_input: LocalTaskInput) => reply(edit('Pet Sidian', 'Pedro Sidián')));
		await expect(
			correctSpeechVocabulary('ask Pet Sidian', vocabulary, undefined, run)
		).resolves.toBe('ask Pedro Sidián');
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ maxTokens: 256, temperature: 0, jsonSchema: expect.any(Object) })
		);
		expect(JSON.parse(run.mock.calls[0][0].prompt)).toEqual({
			transcript: 'ask Pet Sidian',
			vocabulary,
		});
	});
	it('keeps original text when off, unavailable, malformed or failed', async () => {
		for (const result of [{ status: 'off' } as const, reply({ replacements: 'bad' })]) {
			await expect(
				correctSpeechVocabulary('ask Pet Sidian', vocabulary, undefined, async () => result)
			).resolves.toBe('ask Pet Sidian');
		}
		await expect(
			correctSpeechVocabulary('ask Pet Sidian', vocabulary, undefined, async () => {
				throw new Error('offline');
			})
		).resolves.toBe('ask Pet Sidian');
	});
	it('returns the original at the deadline even when a runner ignores abort', async () => {
		vi.useFakeTimers();
		const run = vi.fn((_input: LocalTaskInput) => new Promise<LocalTaskResult>(() => {}));
		const pending = correctSpeechVocabulary('Pet Sidian', vocabulary, undefined, run);
		await vi.advanceTimersByTimeAsync(1500);
		await expect(pending).resolves.toBe('Pet Sidian');
		expect(run.mock.calls[0][0].signal?.aborted).toBe(true);
	});
	it('cancels in flight and never publishes a late correction', async () => {
		const abort = new AbortController();
		let done!: (result: LocalTaskResult) => void;
		const pending = correctSpeechVocabulary(
			'Pet Sidian',
			vocabulary,
			abort.signal,
			() =>
				new Promise((resolve) => {
					done = resolve;
				})
		);
		abort.abort();
		await expect(pending).resolves.toBe('Pet Sidian');
		done(reply(edit('Pet Sidian', 'Pedro Sidián')));
	});
});
