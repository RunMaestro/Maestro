/**
 * A Cappella model store - what is on disk, and whether it can be trusted.
 *
 * Install layout, one directory per model:
 *
 *   userData/models/acappella/<model-id>/
 *     manifest.json          what was installed, from where, and when it was last verified
 *     <file path from the catalog>
 *
 * The single most important rule in this file: **`isInstalled` never answers
 * from `existsSync`.** A killed download leaves a real file at the real path
 * with the wrong length, and an existence check would call that installed. The
 * failure then surfaces hours later as an inference crash inside a model
 * runtime, which is about the worst possible place to learn that a download was
 * interrupted. So an install is only an install when a manifest exists, its
 * recorded hashes match the catalog's, and every file's byte length on disk
 * matches the recorded length exactly.
 *
 * `verify()` is the stronger, slower check: it re-hashes the bytes. A mismatch
 * is recorded as corrupt and REPORTED - never silently re-downloaded. Silently
 * repairing would spend a gigabyte of someone's connection without asking, and
 * would hide the fact that something on this machine is modifying model files.
 *
 * Manifests are written through `atomicWriteJson` plus a per-model write queue,
 * matching `src/main/utils/atomic-json-store.ts`. Concurrent non-atomic writes
 * have already corrupted JSON state in this codebase once (history files); this
 * store does not get to relearn that lesson.
 */

import { app } from 'electron';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { createReadStream, type Dirent } from 'fs';
import * as path from 'path';

import {
	getVoiceModel,
	VOICE_MODEL_CATALOG,
	type VoiceModelEntry,
	type VoiceModelFile,
} from '../../../shared/acappella/model-catalog';
import { atomicWriteJson, createKeyedWriteQueue } from '../../utils/atomic-json-store';

/** Directory name under userData. Also the thing the reclaim-disk flow deletes. */
export const ACAPPELLA_MODELS_DIRNAME = path.join('models', 'acappella');

export const MODEL_MANIFEST_FILENAME = 'manifest.json';

/** Suffix an in-flight download writes to. Never treated as installed. */
export const PARTIAL_SUFFIX = '.part';

/** Per-file record inside a manifest. */
export interface ModelManifestFile {
	path: string;
	sha256: string;
	bytes: number;
}

/**
 * What a completed install recorded about itself. Deliberately self-contained:
 * a manifest has to be readable against a catalog whose revision has since moved
 * on, so it repeats the revision and the source rather than pointing at them.
 */
export interface ModelManifest {
	id: string;
	revision: string;
	/** Hash over the model's files, in catalog order. See {@link modelDigest}. */
	sha256: string;
	bytes: number;
	sourceUrl: string;
	license: string;
	files: ModelManifestFile[];
	/** Epoch ms the install completed. */
	installedAt: number;
	/** Epoch ms of the last successful `verify()`. Equals `installedAt` on install. */
	verifiedAt: number;
}

/** Why a model is not usable. `ok` is the only state voice mode may start in. */
export type ModelStatusKind = 'installed' | 'not-installed' | 'corrupt';

export interface ModelStatus {
	id: string;
	status: ModelStatusKind;
	/** Present for `installed` and for a `corrupt` install whose manifest still parses. */
	manifest: ModelManifest | null;
	/** Human-readable reason, present when the status is not `installed`. */
	detail?: string;
	/** Bytes actually occupied on disk by this model's directory. */
	bytesOnDisk: number;
}

export interface ModelFootprint {
	/** Sum of `bytesOnDisk` over every model directory, including stray ones. */
	bytes: number;
	models: Array<{ id: string; bytes: number }>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve the Maestro data dir, matching the pianola / plugin store semantics.
 * A new path constant is deliberately NOT introduced: `MAESTRO_USER_DATA` has to
 * keep working, and it only does if every store asks the same question.
 */
function dataDir(): string {
	if (process.env.MAESTRO_USER_DATA) return path.resolve(process.env.MAESTRO_USER_DATA);
	return app.getPath('userData');
}

/** Root every A Cappella model lives under. */
export function modelsRoot(): string {
	return path.join(dataDir(), ACAPPELLA_MODELS_DIRNAME);
}

/**
 * Install directory for one model.
 *
 * Guarded rather than trusting the caller: ids reach this function from IPC, and
 * a `../` in one would let a caller point the installer (and, worse, `remove()`)
 * at an arbitrary directory. Only ids that are in the catalog are accepted, which
 * makes the guard a whitelist rather than a sanitiser.
 */
export function modelDir(id: string): string {
	if (!getVoiceModel(id)) throw new Error(`UnknownVoiceModel: ${id}`);
	return path.join(modelsRoot(), id);
}

/** Absolute path of one file within a model's install directory. */
export function modelFilePath(id: string, filePath: string): string {
	const dir = modelDir(id);
	const resolved = path.resolve(dir, filePath);
	// Belt and braces: catalog paths are authored in this repo, but a relative
	// path that escapes its root is the one mistake that turns a delete into a
	// disaster, so it is checked rather than assumed.
	if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
		throw new Error(`UnsafeModelFilePath: ${filePath}`);
	}
	return resolved;
}

function manifestPath(id: string): string {
	return path.join(modelDir(id), MODEL_MANIFEST_FILENAME);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Stable digest identifying a whole model: the per-file SHA-256s joined in
 * catalog order and hashed again.
 *
 * A single-file model would let the manifest just carry the file hash, but two of
 * the catalog's models are multi-file, and "the model's hash" has to mean the
 * same thing for both. Deriving it from the catalog rather than storing it means
 * a manifest written by an older build still compares correctly.
 */
export function modelDigest(files: readonly { path: string; sha256: string }[]): string {
	const hash = createHash('sha256');
	for (const file of files) hash.update(`${file.path}:${file.sha256}\n`);
	return hash.digest('hex');
}

/** SHA-256 of a file on disk, streamed so a 1 GB model does not land in memory. */
export async function hashFile(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	const stream = createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

/**
 * Serialises every mutation of a given model's manifest. Two callers doing a
 * read-modify-write on the same file (install finishing while a verify stamps
 * `verifiedAt`) is precisely the lost-update case this queue exists for.
 */
const manifestWrites = createKeyedWriteQueue();

/** Read a manifest. Null when absent or unparseable - both mean "not installed". */
export async function readManifest(id: string): Promise<ModelManifest | null> {
	let raw: string;
	try {
		raw = await fs.readFile(manifestPath(id), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}

	try {
		const parsed = JSON.parse(raw) as ModelManifest;
		if (!parsed || typeof parsed !== 'object' || parsed.id !== id) return null;
		if (!Array.isArray(parsed.files)) return null;
		return parsed;
	} catch {
		// A manifest we cannot read is not an install. Reporting it as corrupt
		// rather than throwing keeps a hand-edited file from bricking the panel.
		return null;
	}
}

/** Atomically replace a model's manifest, serialised against other writers. */
export async function writeManifest(manifest: ModelManifest): Promise<void> {
	await manifestWrites.enqueue(manifest.id, async () => {
		await fs.mkdir(modelDir(manifest.id), { recursive: true });
		await atomicWriteJson(manifestPath(manifest.id), manifest);
	});
}

/** Build the manifest a freshly completed install should record. */
export function buildManifest(entry: VoiceModelEntry, installedAt: number): ModelManifest {
	return {
		id: entry.id,
		revision: entry.revision,
		sha256: modelDigest(entry.files),
		bytes: entry.bytes,
		sourceUrl: entry.files[0]?.sourceUrl ?? '',
		license: entry.license,
		files: entry.files.map((file) => ({
			path: file.path,
			sha256: file.sha256,
			bytes: file.bytes,
		})),
		installedAt,
		verifiedAt: installedAt,
	};
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function fileSize(filePath: string): Promise<number | null> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() ? stat.size : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/** Recursive byte total for a directory. Missing directory reads as zero. */
async function dirBytes(dir: string): Promise<number> {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw error;
	}

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await dirBytes(full);
		} else if (entry.isFile()) {
			total += (await fileSize(full)) ?? 0;
		}
	}
	return total;
}

/**
 * Full status of one model: manifest present, hashes matching the catalog, and
 * every file the right length.
 *
 * The length check is the whole point. A `.part` renamed too early, a disk that
 * filled, or an app killed mid-write all produce a file that exists and is
 * short, and every one of them reads as installed to an `existsSync`.
 */
export async function getStatus(id: string): Promise<ModelStatus> {
	const entry = getVoiceModel(id);
	if (!entry) {
		return { id, status: 'not-installed', manifest: null, detail: 'Unknown model', bytesOnDisk: 0 };
	}

	const bytesOnDisk = await dirBytes(modelDir(id));
	const manifest = await readManifest(id);

	if (!manifest) {
		return {
			id,
			status: 'not-installed',
			manifest: null,
			detail: bytesOnDisk > 0 ? 'Files present with no manifest' : 'Not installed',
			bytesOnDisk,
		};
	}

	// An install from an older catalog revision is not corrupt, it is stale: the
	// bytes are exactly what they claimed to be, they are just no longer what we
	// ship. Reporting it as not-installed points the user at Download, which is
	// the correct recovery.
	if (manifest.sha256 !== modelDigest(entry.files)) {
		return {
			id,
			status: 'not-installed',
			manifest,
			detail: `Installed revision ${manifest.revision} no longer matches the catalog`,
			bytesOnDisk,
		};
	}

	for (const file of entry.files) {
		const size = await fileSize(modelFilePath(id, file.path));
		if (size === null) {
			return {
				id,
				status: 'not-installed',
				manifest,
				detail: `Missing file ${file.path}`,
				bytesOnDisk,
			};
		}
		if (size !== file.bytes) {
			return {
				id,
				status: 'corrupt',
				manifest,
				detail: `${file.path} is ${size} bytes, expected ${file.bytes}`,
				bytesOnDisk,
			};
		}
	}

	return { id, status: 'installed', manifest, bytesOnDisk };
}

/**
 * Cheap installed check: manifest plus byte lengths, never a bare `existsSync`.
 * This is what the capability gate calls on every readiness query, so it must not
 * re-hash a gigabyte.
 */
export async function isInstalled(id: string): Promise<boolean> {
	return (await getStatus(id)).status === 'installed';
}

/** Status of every catalog model, in catalog order. */
export async function listStatuses(): Promise<ModelStatus[]> {
	const statuses: ModelStatus[] = [];
	for (const entry of VOICE_MODEL_CATALOG) statuses.push(await getStatus(entry.id));
	return statuses;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
	id: string;
	ok: boolean;
	status: ModelStatusKind;
	detail?: string;
	/** Populated on a hash mismatch so the UI can show both sides. */
	mismatch?: { path: string; expected: string; actual: string };
	verifiedAt?: number;
}

/**
 * Re-hash a model's files and compare against the catalog.
 *
 * On success the manifest's `verifiedAt` is stamped. On a mismatch the model is
 * reported CORRUPT and left exactly as it is: no delete, no silent re-download.
 * The user decides whether to spend the bandwidth again, and gets told which file
 * disagreed and by what hash, because "your model is corrupt" with no evidence is
 * indistinguishable from a bug in this function.
 */
export async function verify(id: string): Promise<VerifyResult> {
	const entry = getVoiceModel(id);
	if (!entry) return { id, ok: false, status: 'not-installed', detail: 'Unknown model' };

	const status = await getStatus(id);
	if (status.status === 'not-installed') {
		return { id, ok: false, status: 'not-installed', detail: status.detail };
	}

	for (const file of entry.files) {
		const full = modelFilePath(id, file.path);
		const actual = await hashFile(full);
		if (actual !== file.sha256) {
			return {
				id,
				ok: false,
				status: 'corrupt',
				detail: `${file.path} failed verification`,
				mismatch: { path: file.path, expected: file.sha256, actual },
			};
		}
	}

	// A model whose lengths were wrong but whose hashes match is not a thing that
	// can happen; if getStatus said corrupt on length, hashing said otherwise, and
	// we got here, the lengths are right by construction.
	const verifiedAt = Date.now();
	const manifest = status.manifest ?? buildManifest(entry, verifiedAt);
	await writeManifest({ ...manifest, verifiedAt });

	return { id, ok: true, status: 'installed', verifiedAt };
}

// ---------------------------------------------------------------------------
// Install completion and removal
// ---------------------------------------------------------------------------

/**
 * Record a completed install. Called by the downloader AFTER every file has been
 * hashed and renamed into place, never before: a manifest is the store's promise
 * that the bytes are good, so writing one over an incomplete install would break
 * the one guarantee `isInstalled` rests on.
 */
export async function markInstalled(entry: VoiceModelEntry): Promise<ModelManifest> {
	const manifest = buildManifest(entry, Date.now());
	await writeManifest(manifest);
	return manifest;
}

/**
 * Delete a model's entire directory, manifest and stray `.part` files included.
 *
 * @returns bytes reclaimed.
 */
export async function remove(id: string): Promise<number> {
	const dir = modelDir(id);
	const bytes = await dirBytes(dir);
	await fs.rm(dir, { recursive: true, force: true });
	return bytes;
}

/**
 * Disk used by A Cappella models.
 *
 * Walks the models root rather than the catalog, so a directory left behind by a
 * model that has since been dropped from the catalog is still counted and still
 * reclaimable. Disk the user cannot see is disk they cannot get back.
 */
export async function totalFootprint(): Promise<ModelFootprint> {
	const root = modelsRoot();
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, models: [] };
		throw error;
	}

	const models: Array<{ id: string; bytes: number }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		models.push({ id: entry.name, bytes: await dirBytes(path.join(root, entry.name)) });
	}

	return { bytes: models.reduce((total, model) => total + model.bytes, 0), models };
}

/**
 * Delete every A Cappella model directory. The reclaim-disk action behind the
 * Encore Feature being switched off; scoped to the A Cappella root so it can
 * never reach another feature's models.
 *
 * @returns bytes reclaimed.
 */
export async function removeAll(): Promise<number> {
	const footprint = await totalFootprint();
	await fs.rm(modelsRoot(), { recursive: true, force: true });
	return footprint.bytes;
}

/** Ensure a model's install directory (and any nested file directories) exist. */
export async function ensureModelDir(entry: VoiceModelEntry): Promise<void> {
	await fs.mkdir(modelDir(entry.id), { recursive: true });
	for (const file of entry.files) {
		const dir = path.dirname(modelFilePath(entry.id, file.path));
		await fs.mkdir(dir, { recursive: true });
	}
}

/** Absolute on-disk path of a catalog file. Exported for the bill of materials. */
export function installPathFor(entry: VoiceModelEntry, file: VoiceModelFile): string {
	return modelFilePath(entry.id, file.path);
}
