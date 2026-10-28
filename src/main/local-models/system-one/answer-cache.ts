/**
 * The System One answer cache: an agent's request that was already answered is
 * answered again from disk, at no cost.
 *
 * It is the `jev` CLI's cache, kept by Maestro: seven days, keyed on the request
 * itself. The key is the SHA-256 of `canonicalJson` of the engine, where it is
 * called, the model that is asked, the state and the questions, so the same
 * request spelled with its keys in another order is the same entry, and a
 * request to another engine, server or model is not.
 *
 *   <data dir>/system-one-cache/<first two hex of the key>/<key>.json
 *
 * Four rules:
 *
 *   1. **It holds answers, never text.** An entry is the typed answers and the
 *      model that gave them. The state and the questions are in the key only as
 *      a hash, and the hash is taken AFTER redaction, so a secret is not hashed
 *      into a file name either.
 *   2. **An entry answers only the questions it was stored for.** A read checks
 *      every answer against the question asked (its id, its type, its options,
 *      its range). A file that does not fit is a miss, never a guess.
 *   3. **Seven days.** `jev-latest` moves when TypeSafe releases a model; a week
 *      bounds how stale a cached answer can be. An older file is a miss, and is
 *      deleted the next time the cache is swept (at most once a day).
 *   4. **It can never fail a request.** A file that cannot be read is a miss; a
 *      file that cannot be written is a warning in the log.
 *
 * Only the agent service uses it. A task's gate (`runSystemOneTask`) always
 * asks: a gate's answer is recorded as a decision, and a decision is not
 * replayed.
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { canonicalJson } from '../../../shared/canonicalJson';
import type {
	SystemOneAnswer,
	SystemOneAnswers,
	SystemOneEngineId,
	SystemOneQuestion,
	SystemOneQuestions,
	SystemOneState,
} from '../../../shared/local-models/system-one';
import { atomicWriteFile } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'SystemOne';

/** The cache's folder, relative to the data folder. */
export const SYSTEM_ONE_CACHE_DIR = 'system-one-cache';

/** How long an answer is reused. */
export const SYSTEM_ONE_CACHE_TTL_DAYS = 7;

export const SYSTEM_ONE_CACHE_TTL_MS = SYSTEM_ONE_CACHE_TTL_DAYS * 86_400_000;

/** Bump when the key's recipe or an entry's shape changes: old entries then miss. */
const CACHE_VERSION = 1;

/** How often expired files are swept. A read never returns one in between. */
const SWEEP_INTERVAL_MS = 86_400_000;

/** What separates two requests with the same content. */
export interface SystemOneCacheScope {
	engine: SystemOneEngineId;
	/** Where the engine is called. Null for the local judge. */
	baseUrl: string | null;
	/** The model that is asked: a pin, the hosted alias, or the judge's source. */
	model: string | null;
}

/** One stored answer. */
export interface CachedSystemOneAnswer {
	/** Epoch ms. */
	storedAt: number;
	engine: SystemOneEngineId;
	/** The model the engine said answered. */
	model: string;
	answers: SystemOneAnswers;
}

/**
 * The key of a request. Hand it the request AS IT IS SENT (redacted): two
 * requests that differ only in a secret are sent as the same text.
 */
export function systemOneCacheKey(
	scope: SystemOneCacheScope,
	state: SystemOneState,
	questions: SystemOneQuestions
): string {
	const text = canonicalJson({
		v: CACHE_VERSION,
		engine: scope.engine,
		baseUrl: scope.baseUrl,
		model: scope.model,
		state,
		questions,
	});
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function entryPath(dataDir: string, key: string): string {
	return path.join(dataDir, SYSTEM_ONE_CACHE_DIR, key.slice(0, 2), `${key}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
	return typeof value === 'number' && value >= 0 && value <= 1;
}

/**
 * The stored answer when it is an answer to this question, else null. The
 * answer is rebuilt field by field, so nothing a file carries beyond the
 * answer's own shape is handed on.
 */
function answerFor(question: SystemOneQuestion, raw: unknown): SystemOneAnswer | null {
	if (!isRecord(raw) || raw.type !== question.type) return null;
	if (question.type === 'noul') {
		return isUnit(raw.probability) ? { type: 'noul', probability: raw.probability } : null;
	}

	if (raw.confidence !== undefined && !isUnit(raw.confidence)) return null;
	const confidence = raw.confidence === undefined ? {} : { confidence: raw.confidence };
	const stored = raw.probabilities;

	if (question.type === 'choice') {
		const options = Object.keys(question.criteria);
		if (typeof raw.choice !== 'string' || !options.includes(raw.choice)) return null;
		if (stored === undefined) return { type: 'choice', choice: raw.choice, ...confidence };
		if (!isRecord(stored)) return null;
		const probabilities: Record<string, number> = {};
		for (const option of options) {
			const p = stored[option];
			if (!isUnit(p)) return null;
			probabilities[option] = p;
		}
		return { type: 'choice', choice: raw.choice, probabilities, ...confidence };
	}

	const top = question.criteria.length - 1;
	if (typeof raw.score !== 'number' || !(raw.score >= 0) || raw.score > top) return null;
	if (stored === undefined) return { type: 'score', score: raw.score, ...confidence };
	if (!Array.isArray(stored) || stored.length !== top + 1 || !stored.every(isUnit)) return null;
	return { type: 'score', score: raw.score, probabilities: [...stored], ...confidence };
}

/** A file's content as an entry that answers exactly these questions, else null. */
function readEntry(
	raw: unknown,
	scope: SystemOneCacheScope,
	questions: SystemOneQuestions
): CachedSystemOneAnswer | null {
	if (!isRecord(raw) || raw.engine !== scope.engine) return null;
	if (typeof raw.storedAt !== 'number' || typeof raw.model !== 'string') return null;
	if (!isRecord(raw.answers)) return null;
	const answers: SystemOneAnswers = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = answerFor(question, raw.answers[id]);
		if (!answer) return null;
		answers[id] = answer;
	}
	return { storedAt: raw.storedAt, engine: scope.engine, model: raw.model, answers };
}

/**
 * The stored answer of a request, or null: nothing stored, stored more than
 * seven days ago, or stored for other questions. Never throws.
 */
export async function readCachedSystemOneAnswer(
	dataDir: string,
	key: string,
	scope: SystemOneCacheScope,
	questions: SystemOneQuestions,
	now: number = Date.now()
): Promise<CachedSystemOneAnswer | null> {
	let text: string;
	try {
		text = await fs.readFile(entryPath(dataDir, key), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn(`Could not read a System One cache entry: ${error}`, LOG_CONTEXT);
		}
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const entry = readEntry(parsed, scope, questions);
	if (!entry) return null;
	const age = now - entry.storedAt;
	return age >= 0 && age <= SYSTEM_ONE_CACHE_TTL_MS ? entry : null;
}

let lastSweptAt = 0;

/**
 * Store a request's answer. A failure to write is logged and not thrown: the
 * request was answered, and the next one simply asks again.
 */
export async function storeCachedSystemOneAnswer(
	dataDir: string,
	key: string,
	entry: CachedSystemOneAnswer
): Promise<void> {
	const file = entryPath(dataDir, key);
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await atomicWriteFile(file, JSON.stringify(entry));
	} catch (error) {
		logger.warn(`Could not store a System One cache entry: ${error}`, LOG_CONTEXT);
		return;
	}
	if (entry.storedAt - lastSweptAt >= SWEEP_INTERVAL_MS) {
		lastSweptAt = entry.storedAt;
		void sweepSystemOneAnswerCache(dataDir, entry.storedAt).catch((error: unknown) => {
			logger.warn(`Could not sweep the System One answer cache: ${error}`, LOG_CONTEXT);
		});
	}
}

/**
 * Delete entries stored more than seven days ago, by the file's own time, and
 * answer how many went. A read already refuses them; this returns the disk.
 */
export async function sweepSystemOneAnswerCache(
	dataDir: string,
	now: number = Date.now()
): Promise<number> {
	const root = path.join(dataDir, SYSTEM_ONE_CACHE_DIR);
	let shards: string[];
	try {
		shards = await fs.readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw error;
	}
	let deleted = 0;
	for (const shard of shards) {
		const dir = path.join(root, shard);
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			// Not a folder, or gone since the listing: nothing of ours to sweep.
			continue;
		}
		for (const name of names) {
			const file = path.join(dir, name);
			try {
				const { mtimeMs } = await fs.stat(file);
				if (now - mtimeMs <= SYSTEM_ONE_CACHE_TTL_MS) continue;
				await fs.unlink(file);
				deleted += 1;
			} catch (error) {
				// Another sweep, or a store that replaced it, got there first.
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
	}
	if (deleted > 0) logger.info(`Swept ${deleted} expired System One answer(s)`, LOG_CONTEXT);
	return deleted;
}

/** Forget when the cache was last swept, so each test starts from a fresh process. */
export function resetSystemOneAnswerCacheForTests(): void {
	lastSweptAt = 0;
}
