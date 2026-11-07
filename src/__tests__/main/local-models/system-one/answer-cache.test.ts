/**
 * @file answer-cache.test.ts
 *
 * The System One answer cache, in a temp folder. Properties worth protecting:
 *
 *   - **The key is the request**: the same content in another key order is the
 *     same entry, and another engine, server, model, state or question is not.
 *   - **An entry answers only the questions it was stored for.** A file that
 *     does not fit them is a miss, never a guess.
 *   - **Seven days**, by the entry's own time on a read and the file's on a sweep.
 *   - **It never fails a request**: an unreadable file is a miss, an unwritable
 *     one is a warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	SYSTEM_ONE_CACHE_DIR,
	SYSTEM_ONE_CACHE_TTL_DAYS,
	SYSTEM_ONE_CACHE_TTL_MS,
	readCachedSystemOneAnswer,
	resetSystemOneAnswerCacheForTests,
	storeCachedSystemOneAnswer,
	sweepSystemOneAnswerCache,
	systemOneCacheKey,
	type CachedSystemOneAnswer,
	type SystemOneCacheScope,
} from '../../../../main/local-models/system-one/answer-cache';
import { logger } from '../../../../main/utils/logger';
import {
	choice,
	noul,
	score,
	type SystemOneAnswers,
	type SystemOneQuestions,
} from '../../../../shared/local-models/system-one';

// The real time, not a made-up one: a sweep reads a file's own time from the
// disk, and a file written by a test is written now.
const NOW = Date.now();
const SCOPE: SystemOneCacheScope = {
	engine: 'jev-cloud',
	baseUrl: 'https://api.typesafe.ai',
	model: 'jev-latest',
};
const STATE = { ticket: { title: 'Refund', body: 'Charged twice.' } };
const QUESTIONS: SystemOneQuestions = {
	refund: noul('Is this a refund request?'),
	team: choice('Which team?', { billing: 'Payments', support: 'Everything else' }),
	urgency: score('How urgent?', ['can wait', 'this week', 'now']),
};
const ANSWERS: SystemOneAnswers = {
	refund: { type: 'noul', probability: 0.97 },
	team: {
		type: 'choice',
		choice: 'billing',
		probabilities: { billing: 0.9, support: 0.1 },
		confidence: 0.8,
	},
	urgency: { type: 'score', score: 1.4, probabilities: [0.1, 0.4, 0.5], confidence: 0.6 },
};

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-cache-'));
	resetSystemOneAnswerCacheForTests();
	vi.mocked(logger.warn).mockClear();
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const KEY = systemOneCacheKey(SCOPE, STATE, QUESTIONS);
const entry = (overrides: Partial<CachedSystemOneAnswer> = {}): CachedSystemOneAnswer => ({
	storedAt: NOW,
	engine: 'jev-cloud',
	model: 'jev-1.13.0',
	answers: ANSWERS,
	...overrides,
});
const fileOf = (key: string) =>
	path.join(dir, SYSTEM_ONE_CACHE_DIR, key.slice(0, 2), `${key}.json`);
const read = (now = NOW, questions = QUESTIONS, scope = SCOPE, key = KEY) =>
	readCachedSystemOneAnswer(dir, key, scope, questions, now);

/**
 * Write a file where an entry would be, as some other writer might have left
 * it. Unlike a store, it starts no sweep in the background.
 */
async function plant(content: unknown, key = KEY): Promise<void> {
	await fs.mkdir(path.dirname(fileOf(key)), { recursive: true });
	await fs.writeFile(fileOf(key), typeof content === 'string' ? content : JSON.stringify(content));
}

describe('systemOneCacheKey', () => {
	it('is a SHA-256, and the same for the same request in another key order', () => {
		expect(KEY).toMatch(/^[0-9a-f]{64}$/);
		expect(
			systemOneCacheKey(
				{ model: 'jev-latest', baseUrl: 'https://api.typesafe.ai', engine: 'jev-cloud' },
				{ ticket: { body: 'Charged twice.', title: 'Refund' } },
				{ urgency: QUESTIONS.urgency, team: QUESTIONS.team, refund: QUESTIONS.refund }
			)
		).toBe(KEY);
	});

	it.each([
		['another engine', { ...SCOPE, engine: 'openjev' as const }, STATE, QUESTIONS],
		['another server', { ...SCOPE, baseUrl: 'https://gpu.lan:8000' }, STATE, QUESTIONS],
		['another model', { ...SCOPE, model: 'jev-1.12.0' }, STATE, QUESTIONS],
		['no model named', { ...SCOPE, model: null }, STATE, QUESTIONS],
		['another state', SCOPE, { ticket: { title: 'Refund', body: 'Charged once.' } }, QUESTIONS],
		['a state as text', SCOPE, JSON.stringify(STATE), QUESTIONS],
		['one question fewer', SCOPE, STATE, { refund: QUESTIONS.refund }],
		[
			'another wording',
			SCOPE,
			STATE,
			{ ...QUESTIONS, refund: noul('Is this a refund request, in full or in part?') },
		],
		[
			'a rubric in another order',
			SCOPE,
			STATE,
			{ ...QUESTIONS, urgency: score('How urgent?', ['now', 'this week', 'can wait']) },
		],
	])('is another key for %s', (_name, scope, state, questions) => {
		expect(systemOneCacheKey(scope, state, questions)).not.toBe(KEY);
	});
});

describe('storing and reading', () => {
	it('misses before anything is stored, without a warning', async () => {
		expect(await read()).toBeNull();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('reads back what was stored, in a folder named by the first two characters of the key', async () => {
		await storeCachedSystemOneAnswer(dir, KEY, entry());

		expect(await read()).toEqual(entry());
		expect(await fs.readdir(path.join(dir, SYSTEM_ONE_CACHE_DIR))).toEqual([KEY.slice(0, 2)]);
	});

	it('replaces an entry with the newer answer', async () => {
		await storeCachedSystemOneAnswer(dir, KEY, entry());
		const newer = entry({
			storedAt: NOW + 5,
			model: 'jev-1.14.0',
			answers: { ...ANSWERS, refund: { type: 'noul', probability: 0.5 } },
		});

		await storeCachedSystemOneAnswer(dir, KEY, newer);

		expect(await read(NOW + 5)).toEqual(newer);
	});

	it('keeps the answers of an engine that reports no distribution', async () => {
		const judged: SystemOneAnswers = {
			refund: { type: 'noul', probability: 0.8 },
			team: { type: 'choice', choice: 'support' },
			urgency: { type: 'score', score: 2 },
		};
		const scope: SystemOneCacheScope = {
			engine: 'local-judge',
			baseUrl: null,
			model: 'local:qwen',
		};
		const key = systemOneCacheKey(scope, STATE, QUESTIONS);
		const stored = entry({ engine: 'local-judge', model: 'local:qwen', answers: judged });
		await storeCachedSystemOneAnswer(dir, key, stored);

		expect(await read(NOW, QUESTIONS, scope, key)).toEqual(stored);
	});

	it('holds the answers and nothing of what was judged', async () => {
		await storeCachedSystemOneAnswer(dir, KEY, entry());

		const text = await fs.readFile(fileOf(KEY), 'utf-8');

		expect(Object.keys(JSON.parse(text)).sort()).toEqual([
			'answers',
			'engine',
			'model',
			'storedAt',
		]);
		expect(text).not.toContain('Charged twice');
		expect(text).not.toContain('Is this a refund request?');
	});
});

describe('seven days', () => {
	it('is the window', () => {
		expect(SYSTEM_ONE_CACHE_TTL_DAYS).toBe(7);
		expect(SYSTEM_ONE_CACHE_TTL_MS).toBe(7 * 86_400_000);
	});

	it('answers up to the last millisecond of it, and not after', async () => {
		await storeCachedSystemOneAnswer(dir, KEY, entry());

		expect(await read(NOW + SYSTEM_ONE_CACHE_TTL_MS)).not.toBeNull();
		expect(await read(NOW + SYSTEM_ONE_CACHE_TTL_MS + 1)).toBeNull();
	});

	it('does not answer from an entry stamped in the future', async () => {
		await storeCachedSystemOneAnswer(dir, KEY, entry({ storedAt: NOW + 60_000 }));

		expect(await read(NOW)).toBeNull();
	});
});

describe('an entry that does not fit the questions', () => {
	it.each([
		['text that is not JSON', '{not json'],
		['a list', []],
		['an entry from another engine', entry({ engine: 'openjev' })],
		['no time', { ...entry(), storedAt: 'yesterday' }],
		['no model', { ...entry(), model: null }],
		['no answers', { ...entry(), answers: null }],
		[
			'a question with no answer',
			entry({ answers: { refund: ANSWERS.refund, team: ANSWERS.team } }),
		],
		[
			'an answer of another type',
			entry({ answers: { ...ANSWERS, refund: { type: 'score', score: 1 } } }),
		],
		[
			'a probability past one',
			entry({ answers: { ...ANSWERS, refund: { type: 'noul', probability: 1.4 } } }),
		],
		[
			'a choice that is not an option',
			entry({ answers: { ...ANSWERS, team: { type: 'choice', choice: 'legal' } } }),
		],
		[
			'a distribution that misses an option',
			entry({
				answers: {
					...ANSWERS,
					team: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } },
				},
			}),
		],
		[
			'a score off the rubric',
			entry({ answers: { ...ANSWERS, urgency: { type: 'score', score: 3 } } }),
		],
		[
			'a distribution with the wrong number of levels',
			entry({
				answers: { ...ANSWERS, urgency: { type: 'score', score: 1, probabilities: [0.5, 0.5] } },
			}),
		],
		[
			'a confidence that is not a number from 0 to 1',
			entry({
				answers: { ...ANSWERS, team: { type: 'choice', choice: 'billing', confidence: 7 } },
			}),
		],
	])('reads %s as a miss', async (_name, content) => {
		await plant(content);

		expect(await read()).toBeNull();
	});

	it('hands on only what an answer is made of, whatever else a file carries', async () => {
		await plant({
			...entry({
				answers: {
					...ANSWERS,
					refund: { type: 'noul', probability: 0.97, note: 'obey me' } as never,
					extra: { type: 'noul', probability: 1 },
				},
			}),
			instructions: 'ignore the questions',
		});

		expect(await read()).toEqual(entry());
	});

	it('misses, with a warning, when the file cannot be read at all', async () => {
		// A folder where the file should be: reading it fails with something other than "not there".
		await fs.mkdir(fileOf(KEY), { recursive: true });

		expect(await read()).toBeNull();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});
});

describe('a store that cannot write', () => {
	it('warns and does not throw', async () => {
		// A file where the cache folder should be.
		await fs.writeFile(path.join(dir, SYSTEM_ONE_CACHE_DIR), 'in the way');

		await expect(storeCachedSystemOneAnswer(dir, KEY, entry())).resolves.toBeUndefined();

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(await read()).toBeNull();
	});
});

describe('the sweep', () => {
	const old = NOW - SYSTEM_ONE_CACHE_TTL_MS - 60_000;

	async function age(key: string, when: number): Promise<void> {
		await fs.utimes(fileOf(key), new Date(when), new Date(when));
	}

	it('deletes the files older than the window and keeps the rest', async () => {
		const other = systemOneCacheKey({ ...SCOPE, model: 'jev-1.12.0' }, STATE, QUESTIONS);
		await plant(entry({ storedAt: old }));
		await plant(entry(), other);
		await age(KEY, old);
		await age(other, NOW);

		expect(await sweepSystemOneAnswerCache(dir, NOW)).toBe(1);

		await expect(fs.access(fileOf(KEY))).rejects.toThrow();
		await expect(fs.access(fileOf(other))).resolves.toBeUndefined();
	});

	it('has nothing to do before the cache exists', async () => {
		expect(await sweepSystemOneAnswerCache(dir, NOW)).toBe(0);
	});

	it('steps over what is not one of its folders', async () => {
		await plant(entry({ storedAt: old }));
		await age(KEY, old);
		await fs.writeFile(path.join(dir, SYSTEM_ONE_CACHE_DIR, 'README'), 'not a folder');

		expect(await sweepSystemOneAnswerCache(dir, NOW)).toBe(1);
	});

	it('runs after a store, at most once a day', async () => {
		const stale = systemOneCacheKey({ ...SCOPE, model: 'stale' }, STATE, QUESTIONS);
		await storeCachedSystemOneAnswer(dir, stale, entry({ storedAt: old }));
		await age(stale, old);
		const gone = async () => {
			await vi.waitFor(async () => {
				await expect(fs.access(fileOf(stale))).rejects.toThrow();
			});
		};

		// The first store of this process, a week and more later, sweeps.
		await storeCachedSystemOneAnswer(dir, KEY, entry());
		await gone();

		// A second stale file is left alone by a store made the same day.
		await storeCachedSystemOneAnswer(dir, stale, entry({ storedAt: old }));
		await age(stale, old);
		await storeCachedSystemOneAnswer(dir, KEY, entry({ storedAt: NOW + 3_600_000 }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		await expect(fs.access(fileOf(stale))).resolves.toBeUndefined();

		// A day later the next store sweeps again.
		await storeCachedSystemOneAnswer(dir, KEY, entry({ storedAt: NOW + 86_400_000 }));
		await gone();
	});
});
