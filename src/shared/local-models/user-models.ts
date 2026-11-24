/**
 * Models the user adds from Hugging Face: a repo id and a GGUF file name.
 *
 * The curated catalog (`model-catalog.ts`) is what Maestro ships: every hash in
 * it was read and recorded by hand. A user entry is the same shape with one
 * difference that every surface states (`USER_MODEL_UNVERIFIED_LABEL`): its
 * revision is pinned to the commit the repo was at when it was added and its
 * hash is the one Hugging Face reports for that commit, so the download is
 * checked for damage, but nobody at Maestro looked at what the file is.
 *
 * Everything here is pure. The main process fetches the repo's metadata and
 * owns the file (`src/main/local-models/user-models.ts`); this module turns
 * that metadata into a record, a record into a catalog entry, and a stored file
 * back into records, refusing anything it cannot vouch for the shape of. The
 * metadata and the stored file are both read as untrusted text.
 */

import {
	HUGGING_FACE_BASE_URL,
	defineModel,
	ggufSplitPart,
	isCuratedLocalModelId,
} from './model-catalog';
import { estimateKvLayout, estimateParametersB } from './model-fit';
import { MODEL_SERVER_AGENT_MIN_CONTEXT } from './model-server';
import type { LocalModelEntry, LocalModelLicense } from './types';

/** The user models file, relative to Maestro's data folder. Machine-local, like the models. */
export const USER_LOCAL_MODELS_FILE = 'local-models-user.json';

/** The version of the file's shape. */
export const USER_LOCAL_MODELS_VERSION = 1;

/** What a user-added model is called on every surface that lists it. */
export const USER_MODEL_UNVERIFIED_LABEL = 'Not verified by Maestro';

/** What the label means, in one sentence, for a tooltip or a CLI line. */
export const USER_MODEL_UNVERIFIED_DETAIL =
	'You added this model. Maestro pinned its revision and checks the download against the hash Hugging Face reports, but has not tested it.';

/** Every user model id starts with this, so one can never collide with a curated id by accident. */
export const USER_MODEL_ID_PREFIX = 'hf-';

/** The license text shown when a model card states none. */
export const USER_MODEL_LICENSE_UNSTATED = 'No license stated';

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const FILE_PATH = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const USER_MODEL_ID = /^hf-[a-z0-9][a-z0-9._-]{0,119}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TEXT = 120;
/** How many of a repo's GGUF files a "no such file" message names. */
const MAX_FILES_NAMED = 8;

/** What is stored for one user model: enough to rebuild its catalog entry. */
export interface UserLocalModelRecord {
	id: string;
	displayName: string;
	repo: string;
	/** The commit the repo was at when the model was added. 40 hex characters. */
	revision: string;
	license: LocalModelLicense;
	files: Array<{ path: string; sha256: string; bytes: number }>;
	/** Total parameters, in billions. */
	parametersB: number;
	/** The context the model was trained for, in tokens. */
	contextLength: number;
	/** Epoch ms the model was added. */
	addedAt: number;
}

export type UserModelResult<T> = { ok: true; value: T } | { ok: false; message: string };

function refuse<T>(message: string): UserModelResult<T> {
	return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Printable ASCII only, trimmed and capped: this text reaches a terminal and a tooltip. */
function plainText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value
		.replace(/[^\x20-\x7e]/g, '')
		.trim()
		.slice(0, MAX_TEXT);
	return cleaned.length > 0 ? cleaned : null;
}

function httpsUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

/** A Hugging Face repo id (`owner/name`) as typed, or why it is not one. */
export function parseHuggingFaceRepoId(raw: unknown): UserModelResult<string> {
	const repo =
		typeof raw === 'string' ? raw.trim().replace(/^https:\/\/huggingface\.co\//, '') : '';
	if (!REPO_ID.test(repo) || repo.includes('..')) {
		return refuse(
			'A Hugging Face repo id looks like owner/name, for example unsloth/Qwen3.5-2B-GGUF.'
		);
	}
	return { ok: true, value: repo };
}

/** Whether a path names a vision projector rather than a model's weights. */
function isProjectorPath(path: string): boolean {
	return (path.split('/').pop() ?? path).toLowerCase().startsWith('mmproj');
}

/** A GGUF file name within a repo as typed, or why Maestro cannot add it. */
export function parseHuggingFaceFileName(raw: unknown): UserModelResult<string> {
	const file = typeof raw === 'string' ? raw.trim() : '';
	if (!FILE_PATH.test(file) || file.split('/').some((part) => part === '..' || part === '.')) {
		return refuse('Name one file in the repo, for example Qwen3.5-2B-Q4_K_M.gguf.');
	}
	if (!file.toLowerCase().endsWith('.gguf')) {
		return refuse(`${file} is not a GGUF file. Maestro can add GGUF text models only.`);
	}
	if (isProjectorPath(file)) {
		return refuse(`${file} is a vision projector, not a model. Name the model's own GGUF file.`);
	}
	return { ok: true, value: file };
}

/** The file name without its directory, its `.gguf`, or a split part's `-00001-of-00003`. */
function fileStem(file: string): string {
	const base = file.split('/').pop() ?? file;
	return base.replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '');
}

/**
 * The id a repo file gets: `hf-<owner>-<file stem>`, lowercased and filename-safe.
 * Deterministic, so adding the same file twice is recognized rather than duplicated.
 */
export function userLocalModelId(repo: string, file: string): string {
	const owner = repo.split('/')[0] ?? repo;
	const slug = `${owner}-${fileStem(file)}`
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-._]+|[-._]+$/g, '');
	return `${USER_MODEL_ID_PREFIX}${slug}`.slice(0, 120);
}

/** The Hugging Face API URL that describes a repo: its commit, files, hashes, card and GGUF metadata. */
export function huggingFaceModelApiUrl(repo: string, baseUrl = HUGGING_FACE_BASE_URL): string {
	return `${baseUrl.replace(/\/+$/, '')}/api/models/${repo}?blobs=true`;
}

/** The license a model card states, or the "none stated" text linked to the card. */
function cardLicense(info: Record<string, unknown>, repo: string): LocalModelLicense {
	const card = isRecord(info.cardData) ? info.cardData : {};
	const stated = Array.isArray(card.license) ? card.license[0] : card.license;
	let spdx = plainText(stated);
	// A card that says "other" names its license in a second field.
	if (spdx?.toLowerCase() === 'other') spdx = plainText(card.license_name) ?? spdx;
	if (!spdx && Array.isArray(info.tags)) {
		const tag = info.tags.find(
			(value): value is string => typeof value === 'string' && value.startsWith('license:')
		);
		spdx = plainText(tag?.slice('license:'.length));
	}
	return {
		spdx: spdx ?? USER_MODEL_LICENSE_UNSTATED,
		url: httpsUrl(card.license_link) ?? `${HUGGING_FACE_BASE_URL}/${repo}`,
	};
}

interface RepoFile {
	path: string;
	bytes: number | null;
	sha256: string | null;
}

function repoFiles(info: Record<string, unknown>): RepoFile[] {
	const siblings = Array.isArray(info.siblings) ? info.siblings : [];
	const files: RepoFile[] = [];
	for (const sibling of siblings) {
		if (!isRecord(sibling) || typeof sibling.rfilename !== 'string') continue;
		const lfs = isRecord(sibling.lfs) ? sibling.lfs : {};
		const bytes = typeof lfs.size === 'number' ? lfs.size : sibling.size;
		files.push({
			path: sibling.rfilename,
			bytes: typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
			sha256: typeof lfs.sha256 === 'string' && SHA256.test(lfs.sha256) ? lfs.sha256 : null,
		});
	}
	return files;
}

/** Every file of the set `file` belongs to: itself, or all parts of its split GGUF, in order. */
function ggufSetFiles(files: readonly RepoFile[], file: string): UserModelResult<RepoFile[]> {
	const named = files.find((candidate) => candidate.path === file);
	if (!named) {
		const ggufs = files
			.map((candidate) => candidate.path)
			.filter((path) => path.toLowerCase().endsWith('.gguf') && !isProjectorPath(path));
		if (ggufs.length === 0) return refuse(`The repo has no GGUF file, so there is no ${file}.`);
		const listed = ggufs.slice(0, MAX_FILES_NAMED).join(', ');
		const more =
			ggufs.length > MAX_FILES_NAMED ? `, and ${ggufs.length - MAX_FILES_NAMED} more` : '';
		return refuse(`The repo has no file named ${file}. Its GGUF files: ${listed}${more}.`);
	}
	const part = ggufSplitPart(file);
	if (!part) return { ok: true, value: [named] };

	const prefix = file.replace(/-\d{5}-of-\d{5}\.gguf$/i, '');
	const parts: RepoFile[] = [];
	for (let index = 1; index <= part.count; index++) {
		const path = `${prefix}-${String(index).padStart(5, '0')}-of-${String(part.count).padStart(5, '0')}.gguf`;
		const found = files.find((candidate) => candidate.path.toLowerCase() === path.toLowerCase());
		if (!found) {
			return refuse(`${file} is one part of ${part.count}, and the repo is missing part ${index}.`);
		}
		parts.push(found);
	}
	return { ok: true, value: parts };
}

/**
 * Turn Hugging Face's description of a repo (`huggingFaceModelApiUrl`) into the
 * record for one of its GGUF files. Refuses, by name, anything Maestro could
 * not download and check: a gated repo, a file with no reported SHA-256, a repo
 * with no GGUF metadata.
 */
export function huggingFaceModelRecord(
	info: unknown,
	repo: string,
	file: string,
	now: number
): UserModelResult<UserLocalModelRecord> {
	if (!isRecord(info)) return refuse(`Hugging Face did not describe ${repo}.`);
	if (info.private === true || (info.gated !== undefined && info.gated !== false)) {
		return refuse(
			`${repo} is gated on Hugging Face: its files need an account that accepted its terms, and Maestro downloads without one.`
		);
	}
	const revision = typeof info.sha === 'string' ? info.sha : '';
	if (!REVISION.test(revision)) return refuse(`Hugging Face reported no commit for ${repo}.`);

	const set = ggufSetFiles(repoFiles(info), file);
	if (!set.ok) return set;
	const files: UserLocalModelRecord['files'] = [];
	for (const part of set.value) {
		if (part.sha256 === null || part.bytes === null) {
			return refuse(
				`Hugging Face reports no SHA-256 for ${part.path}, so its download could not be checked.`
			);
		}
		files.push({ path: part.path, sha256: part.sha256, bytes: part.bytes });
	}

	const gguf = isRecord(info.gguf) ? info.gguf : {};
	const contextLength = gguf.context_length;
	if (
		typeof contextLength !== 'number' ||
		!Number.isSafeInteger(contextLength) ||
		contextLength <= 0
	) {
		return refuse(
			`Hugging Face reports no GGUF metadata for ${repo}, so Maestro cannot tell the model's context length.`
		);
	}
	const totalBytes = files.reduce((sum, part) => sum + part.bytes, 0);
	const parameters =
		typeof gguf.total === 'number' && Number.isFinite(gguf.total) && gguf.total > 0
			? gguf.total / 1e9
			: estimateParametersB(totalBytes);

	return {
		ok: true,
		value: {
			id: userLocalModelId(repo, file),
			displayName: fileStem(file),
			repo,
			revision,
			license: cardLicense(info, repo),
			files,
			parametersB: Math.max(0.01, Math.round(parameters * 100) / 100),
			contextLength,
			addedAt: now,
		},
	};
}

/**
 * The catalog entry for a record.
 *
 * A text model on the llama runtime, with no role (nothing was measured, so it
 * is never called an agent or a judge), the whole parameter count as active
 * (Hugging Face does not say which models are MoE, and dense is the careful
 * reading), and the typical attention shape for its size. It runs at the agent
 * floor or its own context, whichever is smaller.
 *
 * Throws what `defineModel` throws: an incomplete split set, for example.
 */
export function userLocalModelEntry(record: UserLocalModelRecord): LocalModelEntry {
	return defineModel({
		id: record.id,
		displayName: record.displayName,
		kind: 'text-gen',
		runtime: 'llama',
		source: { repo: record.repo, revision: record.revision },
		license: record.license,
		description: `Added from Hugging Face (${record.repo}).`,
		goodAt: 'Not measured: you added this model, so Maestro has not tested what it is good at.',
		roles: [],
		parameters: { totalB: record.parametersB, activeB: record.parametersB },
		contextLength: record.contextLength,
		defaultContext: Math.min(record.contextLength, MODEL_SERVER_AGENT_MIN_CONTEXT),
		kvLayout: estimateKvLayout(record.parametersB),
		kvEstimated: true,
		files: record.files,
		userAdded: true,
	});
}

/** One stored record, checked field by field, or null for anything that is not one. */
function parseRecord(raw: unknown): UserLocalModelRecord | null {
	if (!isRecord(raw)) return null;
	const { id, repo, revision, license, files, parametersB, contextLength, addedAt } = raw;
	const displayName = plainText(raw.displayName);
	if (typeof id !== 'string' || !USER_MODEL_ID.test(id) || id.includes('..')) return null;
	if (isCuratedLocalModelId(id) || displayName === null) return null;
	if (typeof repo !== 'string' || !parseHuggingFaceRepoId(repo).ok) return null;
	if (typeof revision !== 'string' || !REVISION.test(revision)) return null;
	if (!isRecord(license)) return null;
	const spdx = plainText(license.spdx);
	const url = httpsUrl(license.url);
	if (spdx === null || url === null) return null;
	if (!Array.isArray(files) || files.length === 0) return null;
	const parsedFiles: UserLocalModelRecord['files'] = [];
	for (const file of files) {
		if (!isRecord(file)) return null;
		const path = parseHuggingFaceFileName(file.path);
		if (!path.ok || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) return null;
		if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
			return null;
		}
		parsedFiles.push({ path: path.value, sha256: file.sha256, bytes: file.bytes });
	}
	if (typeof parametersB !== 'number' || !Number.isFinite(parametersB) || parametersB <= 0) {
		return null;
	}
	if (
		typeof contextLength !== 'number' ||
		!Number.isSafeInteger(contextLength) ||
		contextLength <= 0
	) {
		return null;
	}
	return {
		id,
		displayName,
		repo,
		revision,
		license: { spdx, url },
		files: parsedFiles,
		parametersB,
		contextLength,
		addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : 0,
	};
}

export interface ParsedUserLocalModels {
	/** The records that parsed and build a valid entry, in file order, each id once. */
	records: UserLocalModelRecord[];
	/** The catalog entry of each record, in the same order. */
	entries: LocalModelEntry[];
	/** How many stored records were refused. */
	dropped: number;
}

/**
 * Read the stored file's contents (`{ version, models: [...] }`). A record that
 * fails a check, repeats an id, or does not build a valid entry is dropped and
 * counted, never repaired: the file is only ever written by Maestro, so a
 * record that does not parse was edited or damaged.
 */
export function parseUserLocalModels(raw: unknown): ParsedUserLocalModels {
	const list = isRecord(raw) && Array.isArray(raw.models) ? raw.models : [];
	const parsed: ParsedUserLocalModels = { records: [], entries: [], dropped: 0 };
	const seen = new Set<string>();
	for (const item of list) {
		const record = parseRecord(item);
		if (!record || seen.has(record.id)) {
			parsed.dropped++;
			continue;
		}
		try {
			parsed.entries.push(userLocalModelEntry(record));
		} catch {
			parsed.dropped++;
			continue;
		}
		seen.add(record.id);
		parsed.records.push(record);
	}
	return parsed;
}

/** The file contents for a list of records. */
export function serializeUserLocalModels(records: readonly UserLocalModelRecord[]): {
	version: number;
	models: UserLocalModelRecord[];
} {
	return { version: USER_LOCAL_MODELS_VERSION, models: [...records] };
}
