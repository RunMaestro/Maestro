/**
 * The models the user added from Hugging Face: the store, and the one
 * implementation of look up, add and remove.
 *
 *   userData/local-models-user.json     { version, models: [record, ...] }
 *
 * The file sits beside the models root, not inside it: "remove all models"
 * deletes that whole directory, and it must not take the list of what the user
 * added with it. It is machine-local, like the model files it describes.
 *
 * Settings > Models > Library and `maestro-cli models add-hf` / `remove-hf`
 * both call the functions here, through the `localModels:hf:*` channels and the
 * `local_models_hf_*` bridge messages. What a record may hold, and how it
 * becomes a catalog entry, is `src/shared/local-models/user-models.ts`.
 *
 * Look up and add reach the network (one request to Hugging Face's API, for the
 * repo the user named) and nothing else here does. Neither downloads the model:
 * that is the row's Download button, or `models install`.
 *
 * A refusal the user can act on (no such repo, a gated repo, a file with no
 * hash) comes back as `{ ok: false, message }`. Anything else throws.
 */

import { readFileSync, renameSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import { parseJsonWithBom } from '../../shared/jsonUtils';
import { downloadSourceName } from '../../shared/local-models/download-base';
import {
	getLocalModel,
	isCuratedLocalModelId,
	setUserLocalModels,
	userLocalModels,
} from '../../shared/local-models/model-catalog';
import {
	USER_LOCAL_MODELS_FILE,
	huggingFaceModelApiUrl,
	huggingFaceModelRecord,
	parseHuggingFaceFileName,
	parseHuggingFaceRepoId,
	parseUserLocalModels,
	serializeUserLocalModels,
	userLocalModelEntry,
	type UserLocalModelRecord,
	type UserModelResult,
} from '../../shared/local-models/user-models';
import type { LocalModelEntry } from '../../shared/local-models/types';
import { corruptStorePath } from '../stores/corrupt-store-recovery';
import { atomicWriteJson, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { fetchWithTimeout, isFetchTimeoutError } from '../utils/fetchWithTimeout';
import { logger } from '../utils/logger';
import { currentDownloadBase } from './download-base';
import { getModelDownloader } from './model-downloader';
import { remove } from './model-store';
import { localModelsDataDir } from './paths';

const LOG_CONTEXT = 'LocalModels';

/** One metadata request; a repo's file list is small. */
const HUGGING_FACE_API_TIMEOUT_MS = 30_000;

/** What a look up shows before anything is saved. */
export interface HuggingFaceModelPreview {
	/** The catalog entry the model would have: its size, license, revision and files. */
	entry: LocalModelEntry;
	/** True when this exact model is already in the Library. */
	alreadyAdded: boolean;
}

/** What an add did. `added` is false when the model was already in the Library. */
export interface HuggingFaceModelAdded {
	entry: LocalModelEntry;
	added: boolean;
}

/** What a remove freed. */
export interface UserLocalModelRemoved {
	id: string;
	displayName: string;
	bytes: number;
}

let records: UserLocalModelRecord[] = [];
let hydrated = false;
const writes = createKeyedWriteQueue();
const listeners = new Set<(entries: readonly LocalModelEntry[]) => void>();

function storePath(): string {
	return path.join(localModelsDataDir(), USER_LOCAL_MODELS_FILE);
}

/**
 * Read the user models file into this process's catalog. Synchronous and run
 * once at startup, before anything lists or loads a model: every lookup in the
 * catalog is synchronous, so the user's entries have to be there first.
 *
 * A file that is not JSON is moved aside, never overwritten, so what it listed
 * can still be recovered. A record that fails its checks is dropped and counted.
 */
export function hydrateUserLocalModels(): void {
	hydrated = true;
	const file = storePath();
	let text: string;
	try {
		text = readFileSync(file, 'utf-8');
	} catch (error) {
		// No file is the state of a machine where nothing was ever added.
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			records = [];
			setUserLocalModels([]);
			return;
		}
		throw error;
	}
	let raw: unknown;
	try {
		raw = parseJsonWithBom(text);
	} catch {
		const sidecar = corruptStorePath(file);
		renameSync(file, sidecar);
		logger.warn(
			`${USER_LOCAL_MODELS_FILE} was not JSON. It was moved to ${path.basename(sidecar)}, and the Library starts with no added models.`,
			LOG_CONTEXT
		);
		records = [];
		setUserLocalModels([]);
		return;
	}
	const parsed = parseUserLocalModels(raw);
	if (parsed.dropped > 0) {
		logger.warn(
			`Ignored ${parsed.dropped} unusable record(s) in ${USER_LOCAL_MODELS_FILE}`,
			LOG_CONTEXT
		);
	}
	records = parsed.records;
	setUserLocalModels(parsed.entries);
}

function ensureHydrated(): void {
	if (!hydrated) hydrateUserLocalModels();
}

/** The models the user added, in the order they were added. A memory read. */
export function listUserLocalModels(): readonly LocalModelEntry[] {
	ensureHydrated();
	return userLocalModels();
}

/**
 * Hear about every change to the user's models, with the new list. Returns the
 * unsubscribe. The IPC layer broadcasts it, so each window's catalog follows.
 */
export function onUserLocalModelsChanged(
	listener: (entries: readonly LocalModelEntry[]) => void
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Persist `next`, then make it this process's catalog and tell the listeners. */
async function commit(next: UserLocalModelRecord[]): Promise<void> {
	const file = storePath();
	await writes.enqueue(file, async () => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await atomicWriteJson(file, serializeUserLocalModels(next));
	});
	records = next;
	setUserLocalModels(next.map(userLocalModelEntry));
	const entries = userLocalModels();
	for (const listener of listeners) listener(entries);
}

/**
 * Ask Hugging Face (or the configured download base, a mirror of it) to
 * describe a repo. One request; the body is JSON.
 */
async function fetchRepoInfo(repo: string): Promise<UserModelResult<unknown>> {
	const base = currentDownloadBase();
	const source = downloadSourceName(base);
	let response: Response;
	try {
		response = await fetchWithTimeout(
			huggingFaceModelApiUrl(repo, base),
			{ headers: { accept: 'application/json' } },
			HUGGING_FACE_API_TIMEOUT_MS
		);
	} catch (error) {
		if (isFetchTimeoutError(error)) {
			return { ok: false, message: `${source} did not answer in time. Try again.` };
		}
		// No route, DNS failure, a blocked network: expected, and the user's to fix.
		return {
			ok: false,
			message: `Could not reach ${source}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	// Hugging Face answers 401 for a repo that does not exist, so a private repo
	// cannot be told from a missing one.
	if (response.status === 401 || response.status === 403 || response.status === 404) {
		return {
			ok: false,
			message: `${source} has no public repo named ${repo}. Check the id, or the repo is private.`,
		};
	}
	if (!response.ok) {
		return { ok: false, message: `${source} answered HTTP ${response.status} for ${repo}.` };
	}
	try {
		return { ok: true, value: await response.json() };
	} catch {
		return { ok: false, message: `${source} sent an answer for ${repo} that is not JSON.` };
	}
}

async function resolveRecord(
	rawRepo: unknown,
	rawFile: unknown
): Promise<UserModelResult<UserLocalModelRecord>> {
	const repo = parseHuggingFaceRepoId(rawRepo);
	if (!repo.ok) return repo;
	const file = parseHuggingFaceFileName(rawFile);
	if (!file.ok) return file;
	const info = await fetchRepoInfo(repo.value);
	if (!info.ok) return info;
	return huggingFaceModelRecord(info.value, repo.value, file.value, Date.now());
}

/** Why a record cannot join the catalog, or its entry and whether it is already there. */
function placeRecord(record: UserLocalModelRecord): UserModelResult<HuggingFaceModelPreview> {
	if (isCuratedLocalModelId(record.id)) {
		return { ok: false, message: `Maestro already ships a model with the id ${record.id}.` };
	}
	const existing = records.find((candidate) => candidate.id === record.id);
	if (existing && existing.repo !== record.repo) {
		return {
			ok: false,
			message: `A model from ${existing.repo} already has the id ${record.id}. Remove it before adding this one.`,
		};
	}
	if (existing) {
		// Already added: the Library keeps the revision it pinned then, whatever
		// the repo has moved to since.
		return { ok: true, value: { entry: userLocalModelEntry(existing), alreadyAdded: true } };
	}
	try {
		return { ok: true, value: { entry: userLocalModelEntry(record), alreadyAdded: false } };
	} catch (error) {
		// `defineModel` refused the shape (a split set that is not one set).
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Look a repo file up on Hugging Face and describe the model it would add: its
 * license from the model card, its size, its pinned revision. Saves nothing and
 * downloads nothing, so the license is read before either happens.
 */
export async function previewHuggingFaceModel(
	rawRepo: unknown,
	rawFile: unknown
): Promise<UserModelResult<HuggingFaceModelPreview>> {
	ensureHydrated();
	const record = await resolveRecord(rawRepo, rawFile);
	return record.ok ? placeRecord(record.value) : record;
}

/**
 * Add a repo file to the Library as a user entry. It is listed, not downloaded.
 * Adding a model that is already there answers with the existing entry.
 */
export async function addHuggingFaceModel(
	rawRepo: unknown,
	rawFile: unknown
): Promise<UserModelResult<HuggingFaceModelAdded>> {
	ensureHydrated();
	const record = await resolveRecord(rawRepo, rawFile);
	if (!record.ok) return record;
	const placed = placeRecord(record.value);
	if (!placed.ok) return placed;
	if (placed.value.alreadyAdded) {
		return { ok: true, value: { entry: placed.value.entry, added: false } };
	}
	await commit([...records, record.value]);
	// The registry's own frozen entry, not the preview's copy of it.
	return { ok: true, value: { entry: getLocalModel(record.value.id)!, added: true } };
}

/**
 * Take a user model out of the Library and delete its files. A curated model is
 * refused: Maestro ships that entry, and only its files can be removed.
 */
export async function removeUserLocalModel(
	rawId: unknown
): Promise<UserModelResult<UserLocalModelRemoved>> {
	ensureHydrated();
	const id = typeof rawId === 'string' ? rawId.trim() : '';
	const record = records.find((candidate) => candidate.id === id);
	if (!record) {
		const curated = getLocalModel(id);
		return {
			ok: false,
			message: curated
				? `${curated.displayName} is a model Maestro ships, so it stays in the Library. Delete its files with Remove.`
				: `No model you added has the id "${id}".`,
		};
	}
	// Cancel first: deleting the directory under a live writer would let the
	// writer recreate the file it was told to stop writing.
	await getModelDownloader().cancel(id);
	const bytes = await remove(id);
	await commit(records.filter((candidate) => candidate.id !== id));
	return { ok: true, value: { id, displayName: record.displayName, bytes } };
}

/** Forget everything read from disk. Tests only. */
export function resetUserLocalModelsForTests(): void {
	records = [];
	hydrated = false;
	listeners.clear();
	setUserLocalModels([]);
}
