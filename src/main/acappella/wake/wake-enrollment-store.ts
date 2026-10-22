/**
 * Where a user's own wake phrase lives on disk.
 *
 * One directory per phrase under `userData/acappella/wake-phrases/`, named by
 * `wakePhraseKey`:
 *
 *   enrollment.json    the phrase as typed, so the directory can be listed
 *   clips/0001.wav     one recording of the phrase each
 *   background/0001.wav  ordinary speech, one file per recording run
 *   model.json         the trained matcher's numbers and its report
 *   templates.f32      the matcher's examples, raw little-endian float32
 *
 * **The recordings are kept, and that is a decision.** They are the user's
 * voice, so they never leave this directory and deleting the phrase deletes
 * them. But they are also the only thing a model can be rebuilt from: adding
 * five more recordings next week retrains from all of them, and a future
 * matcher can be trained from the same audio without asking the user to say the
 * phrase forty times again.
 *
 * This is NOT the Local Models store. That holds catalog models every user
 * downloads identically; this holds something one person made, which no catalog
 * entry describes and no download can restore.
 */

import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';

import { SPEECH_SAMPLE_RATE, decodeWavPcm16, encodeWav } from '../../../shared/audio/pcm';
import {
	wakePhraseKey,
	type WakeEnrollmentModelInfo,
	type WakeEnrollmentReport,
} from '../../../shared/acappella/wake-enrollment';
import { atomicWriteJson, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';
import {
	ENROLLED_WAKE_MODEL_VERSION,
	isUsableEnrolledWakeModel,
	type EnrolledWakeModel,
} from './enrolled-wake-model';

const LOG_CONTEXT = 'ACappella';

const ENROLLMENT_FILE = 'enrollment.json';
const MODEL_FILE = 'model.json';
const TEMPLATES_FILE = 'templates.f32';
const CLIPS_DIR = 'clips';
const BACKGROUND_DIR = 'background';

/** One phrase's writes at a time: a clip saved mid-train must not interleave with the model. */
const writeQueue = createKeyedWriteQueue();

/** Injectable in tests: the real path needs an Electron app object. */
let rootOverride: string | null = null;

/** Point the store at a different directory. Test seam; production uses `userData`. */
export function setWakeEnrollmentRoot(dir: string | null): void {
	rootOverride = dir;
	revisions.clear();
}

function root(): string {
	return rootOverride ?? path.join(app.getPath('userData'), 'acappella', 'wake-phrases');
}

/** A phrase's directory, or null for a phrase with nothing sayable in it. */
function phraseDir(phrase: string): string | null {
	const key = wakePhraseKey(phrase);
	return key ? path.join(root(), key) : null;
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

async function listWavs(dir: string): Promise<string[]> {
	try {
		const names = await fs.readdir(dir);
		return names.filter((name) => name.endsWith('.wav')).sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
}

async function readWav(file: string): Promise<Int16Array> {
	const { pcm } = decodeWavPcm16(new Uint8Array(await fs.readFile(file)));
	return pcm;
}

/** The next free `NNNN.wav` in a directory. Numbered from the highest present, never reused. */
async function nextWavPath(dir: string): Promise<string> {
	const names = await listWavs(dir);
	const last = names.length ? parseInt(names[names.length - 1], 10) : 0;
	const index = (Number.isFinite(last) ? last : names.length) + 1;
	return path.join(dir, `${String(index).padStart(4, '0')}.wav`);
}

async function appendWav(phrase: string, subdir: string, pcm: Int16Array): Promise<void> {
	const dir = phraseDir(phrase);
	if (!dir) throw new Error('That phrase has nothing sayable in it.');
	await writeQueue.enqueue(dir, async () => {
		await fs.mkdir(path.join(dir, subdir), { recursive: true });
		const enrollment = path.join(dir, ENROLLMENT_FILE);
		if (!existsSync(enrollment)) {
			await atomicWriteJson(enrollment, { phrase: phrase.trim(), createdAt: Date.now() });
		}
		await fs.writeFile(await nextWavPath(path.join(dir, subdir)), encodeWav(pcm));
	});
}

/** Keep one recording of the phrase. 16 kHz mono. */
export function addWakeClip(phrase: string, pcm: Int16Array): Promise<void> {
	return appendWav(phrase, CLIPS_DIR, pcm);
}

/** Keep a run of ordinary speech. 16 kHz mono. */
export function addWakeBackground(phrase: string, pcm: Int16Array): Promise<void> {
	return appendWav(phrase, BACKGROUND_DIR, pcm);
}

/** Drop the newest recording of the phrase. Returns false when there was none. */
export async function removeLastWakeClip(phrase: string): Promise<boolean> {
	const dir = phraseDir(phrase);
	if (!dir) return false;
	return writeQueue.enqueue(dir, async () => {
		const names = await listWavs(path.join(dir, CLIPS_DIR));
		if (!names.length) return false;
		await fs.rm(path.join(dir, CLIPS_DIR, names[names.length - 1]), { force: true });
		return true;
	});
}

/** Drop the ordinary speech, so it can be recorded again. */
export async function clearWakeBackground(phrase: string): Promise<void> {
	const dir = phraseDir(phrase);
	if (!dir) return;
	await writeQueue.enqueue(dir, () =>
		fs.rm(path.join(dir, BACKGROUND_DIR), { recursive: true, force: true })
	);
}

/** Every recording of the phrase, oldest first. */
export async function readWakeClips(phrase: string): Promise<Int16Array[]> {
	const dir = phraseDir(phrase);
	if (!dir) return [];
	const names = await listWavs(path.join(dir, CLIPS_DIR));
	return Promise.all(names.map((name) => readWav(path.join(dir, CLIPS_DIR, name))));
}

/** All the ordinary speech, joined in the order it was recorded. */
export async function readWakeBackground(phrase: string): Promise<Int16Array> {
	const dir = phraseDir(phrase);
	if (!dir) return new Int16Array(0);
	const names = await listWavs(path.join(dir, BACKGROUND_DIR));
	const parts = await Promise.all(
		names.map((name) => readWav(path.join(dir, BACKGROUND_DIR, name)))
	);
	const joined = new Int16Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

/** What is on disk for a phrase, without decoding any audio. */
export interface WakeEnrollmentSummary {
	clips: number;
	backgroundMs: number;
	model: WakeEnrollmentModelInfo | null;
}

/** A canonical 16-bit mono WAV's header is 44 bytes; the rest is samples. */
const WAV_HEADER_BYTES = 44;

export async function readWakeEnrollmentSummary(phrase: string): Promise<WakeEnrollmentSummary> {
	const dir = phraseDir(phrase);
	if (!dir) return { clips: 0, backgroundMs: 0, model: null };
	const clips = await listWavs(path.join(dir, CLIPS_DIR));
	const background = await listWavs(path.join(dir, BACKGROUND_DIR));
	let samples = 0;
	for (const name of background) {
		// Sized from the file rather than decoded: this runs on every status read,
		// and the files are the ones `encodeWav` wrote.
		const { size } = await fs.stat(path.join(dir, BACKGROUND_DIR, name));
		samples += Math.max(0, size - WAV_HEADER_BYTES) / 2;
	}
	return {
		clips: clips.length,
		backgroundMs: Math.round((samples / SPEECH_SAMPLE_RATE) * 1000),
		model: await readModelInfo(dir),
	};
}

// ---------------------------------------------------------------------------
// The trained model
// ---------------------------------------------------------------------------

/** `model.json`: everything but the examples. */
interface StoredModel {
	version: number;
	phrase: string;
	key: string;
	trainedAt: number;
	frames: number;
	width: number;
	mean: number[];
	count: number;
	midpoint: number;
	steepness: number;
	report: WakeEnrollmentReport;
}

/**
 * `trainedAt` per phrase key, or null for "no model". Read synchronously by the
 * always-on listener on every settings check, so it is remembered rather than
 * re-read: the one writer is in this module and keeps it current.
 */
const revisions = new Map<string, number | null>();

async function readStoredModel(dir: string): Promise<StoredModel | null> {
	try {
		const stored = JSON.parse(
			await fs.readFile(path.join(dir, MODEL_FILE), 'utf-8')
		) as StoredModel;
		return stored.version === ENROLLED_WAKE_MODEL_VERSION ? stored : null;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		// A model file that will not parse is a phrase that is not trained. Say so
		// once in the log; the user's recordings are untouched and retraining fixes it.
		logger.warn(`Wake phrase model unreadable in ${dir}: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}
}

async function readModelInfo(dir: string): Promise<WakeEnrollmentModelInfo | null> {
	const stored = await readStoredModel(dir);
	return stored ? { trainedAt: stored.trainedAt, report: stored.report } : null;
}

/**
 * Floats to bytes and back, little-endian explicitly, for the same reason
 * `encodeWav` is: a typed array's own bytes are the host's order, which is right
 * everywhere Maestro ships and would be wrong silently anywhere it was not.
 */
function encodeFloat32(values: Float32Array): Uint8Array {
	const view = new DataView(new ArrayBuffer(values.length * 4));
	for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
	return new Uint8Array(view.buffer);
}

function decodeFloat32(bytes: Uint8Array): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const values = new Float32Array(Math.floor(bytes.byteLength / 4));
	for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
	return values;
}

/** Persist a trained model. The examples are written first, so `model.json` never names a file that is not there. */
export async function saveEnrolledWakeModel(model: EnrolledWakeModel): Promise<void> {
	const dir = phraseDir(model.phrase);
	if (!dir) throw new Error('That phrase has nothing sayable in it.');
	await writeQueue.enqueue(dir, async () => {
		await fs.mkdir(dir, { recursive: true });
		const templates = path.join(dir, TEMPLATES_FILE);
		await fs.writeFile(`${templates}.tmp`, encodeFloat32(model.templates));
		await fs.rename(`${templates}.tmp`, templates);
		const stored: StoredModel = {
			version: model.version,
			phrase: model.phrase,
			key: model.key,
			trainedAt: model.trainedAt,
			frames: model.frames,
			width: model.width,
			mean: Array.from(model.mean),
			count: model.count,
			midpoint: model.midpoint,
			steepness: model.steepness,
			report: model.report,
		};
		await atomicWriteJson(path.join(dir, MODEL_FILE), stored);
	});
	revisions.set(model.key, model.trainedAt);
}

/** The trained model for a phrase, or null when it has none this build can use. */
export async function loadEnrolledWakeModel(phrase: string): Promise<EnrolledWakeModel | null> {
	const dir = phraseDir(phrase);
	if (!dir) return null;
	const stored = await readStoredModel(dir);
	if (!stored) return null;
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(path.join(dir, TEMPLATES_FILE));
	} catch (err) {
		logger.warn(`Wake phrase examples missing in ${dir}: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}
	const templates = decodeFloat32(bytes);
	const model: EnrolledWakeModel = {
		version: ENROLLED_WAKE_MODEL_VERSION,
		phrase: stored.phrase,
		key: stored.key,
		trainedAt: stored.trainedAt,
		frames: stored.frames,
		width: stored.width,
		mean: Float32Array.from(stored.mean),
		templates,
		count: stored.count,
		midpoint: stored.midpoint,
		steepness: stored.steepness,
		report: stored.report,
	};
	if (!isUsableEnrolledWakeModel(model)) {
		logger.warn(`Wake phrase model in ${dir} does not match its examples`, LOG_CONTEXT);
		return null;
	}
	return model;
}

/**
 * When a phrase was last trained, or null when it has no model.
 *
 * Synchronous on purpose: the always-on listener folds it into the key it
 * re-arms on, and that key is computed from a synchronous settings read.
 */
export function enrolledWakeRevision(phrase: string): number | null {
	const key = wakePhraseKey(phrase);
	if (!key) return null;
	const known = revisions.get(key);
	if (known !== undefined) return known;
	let revision: number | null = null;
	try {
		const stored = JSON.parse(
			readFileSync(path.join(root(), key, MODEL_FILE), 'utf-8')
		) as StoredModel;
		if (stored.version === ENROLLED_WAKE_MODEL_VERSION && Number.isFinite(stored.trainedAt)) {
			revision = stored.trainedAt;
		}
	} catch {
		// No model, or one that will not parse: either way the phrase is untrained.
	}
	revisions.set(key, revision);
	return revision;
}

/** Whether a phrase has a model trained from the user's recordings. */
export function hasEnrolledWakeModel(phrase: string): boolean {
	return enrolledWakeRevision(phrase) !== null;
}

/** Forget the trained model and keep the recordings. */
export async function deleteEnrolledWakeModel(phrase: string): Promise<void> {
	const dir = phraseDir(phrase);
	if (!dir) return;
	await writeQueue.enqueue(dir, async () => {
		await fs.rm(path.join(dir, MODEL_FILE), { force: true });
		await fs.rm(path.join(dir, TEMPLATES_FILE), { force: true });
	});
	revisions.set(wakePhraseKey(phrase), null);
}

/** Forget a phrase entirely: the model and every recording. */
export async function deleteWakeEnrollment(phrase: string): Promise<void> {
	const dir = phraseDir(phrase);
	if (!dir) return;
	await writeQueue.enqueue(dir, () => fs.rm(dir, { recursive: true, force: true }));
	revisions.set(wakePhraseKey(phrase), null);
}

/** Every phrase with anything on disk, as typed when it was first recorded. */
export async function listWakeEnrollments(): Promise<string[]> {
	let keys: string[];
	try {
		keys = await fs.readdir(root());
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
	const phrases: string[] = [];
	for (const key of keys.sort()) {
		try {
			const stored = JSON.parse(
				await fs.readFile(path.join(root(), key, ENROLLMENT_FILE), 'utf-8')
			) as { phrase?: unknown };
			if (typeof stored.phrase === 'string' && wakePhraseKey(stored.phrase) === key) {
				phrases.push(stored.phrase);
			}
		} catch {
			// Not an enrollment directory.
		}
	}
	return phrases;
}
