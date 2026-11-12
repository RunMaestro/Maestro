/**
 * Marketplace Service
 *
 * Pure helpers for fetching, caching, and importing playbooks from the
 * Maestro Playbooks marketplace. Extracted from the IPC handler so the
 * web-server (mobile clients) can reuse the same logic without
 * round-tripping through the renderer.
 *
 * Cache + filesystem semantics mirror the IPC handler: 6h TTL on the
 * official manifest, on-demand document fetches, optional local manifest
 * for custom playbooks, SSH-aware import targets.
 */

import { App } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import type {
	MarketplaceManifest,
	MarketplaceCache,
	MarketplacePlaybook,
	PlaybookLaunchCompletion,
	PlaybookLaunchListOptions,
	PlaybookLaunchRecord,
	PlaybookLaunchRequest,
	PlaybookLaunchResult,
	PlaybookLaunchSpec,
	PlaybookLaunchValues,
} from '../../shared/marketplace-types';
import {
	MarketplaceFetchError,
	MarketplaceImportError,
	MarketplaceLaunchBusyError,
	MarketplaceLaunchCleanupError,
	MarketplaceLaunchValuesError,
} from '../../shared/marketplace-types';
import { isCompatible } from '../../shared/marketplace-compatibility';
import { generateDefaultFolderName } from '../../shared/marketplaceFolderName';
import { fileTimestampSlug } from '../../shared/formatters';
import {
	applyLaunchInputs,
	isLaunchAvailable,
	isLaunchValuesObject,
	parseLaunchSpec,
	resolveLaunchValues,
	validateLaunchValues,
} from '../../shared/playbookLaunch';
import { isTaskSelectionMode, SshRemoteConfig, type TaskSelectionMode } from '../../shared/types';
import { isPathAtOrUnderRoot, normalizeWorktreePath } from '../../shared/worktreePaths';
import { writeFileRemote, mkdirRemote, deleteDirectoryRemote } from '../utils/remote-fs';
import { captureException } from '../utils/sentry';
import { getSshRemoteById } from '../stores/getters';
import { getPlaybookLaunchStore } from '../stores/playbookLaunchStore';
import { deleteSavedPlaybook, getSavedPlaybooksFilePath } from '../stores/savedPlaybooksStore';
import { getAutoRunStateTracker } from '../autorun/autorun-state-tracker';

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/RunMaestro/Maestro-Playbooks/main';
const MANIFEST_URL = `${GITHUB_RAW_BASE}/manifest.json`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Request budget for marketplace downloads. These are playbook markdown and
 * assets pulled from GitHub raw on a user-initiated action, so the user is
 * waiting on them: a stalled socket must surface as an error, not a spinner
 * that never resolves.
 */
const MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;
const LOG_CONTEXT = '[Marketplace]';

export function getCacheFilePath(app: App): string {
	return path.join(app.getPath('userData'), 'marketplace-cache.json');
}

export function getLocalManifestPath(app: App): string {
	return path.join(app.getPath('userData'), 'local-manifest.json');
}

/**
 * Whether `pathStr` references the local filesystem (absolute or `~`-prefixed)
 * rather than a GitHub manifest path. Exported so the IPC + WS callers can
 * gate access - only locally-trusted (IPC) flows may resolve local paths.
 */
export function isLocalPath(pathStr: string): boolean {
	if (path.isAbsolute(pathStr)) return true;
	if (pathStr.startsWith('~/') || pathStr.startsWith('~\\')) return true;
	return false;
}

function resolveTildePath(pathStr: string): string {
	if (pathStr.startsWith('~/') || pathStr.startsWith('~\\')) {
		return path.join(os.homedir(), pathStr.slice(2));
	}
	return pathStr;
}

/**
 * Validate a `targetFolderName` from an untrusted client (e.g. mobile WS).
 * Rejects path separators and traversal sequences so the folder cannot
 * escape `autoRunFolderPath`. Throws `MarketplaceImportError` on bad input.
 */
/**
 * Points a playbook's asset references at the folder it was imported into.
 *
 * Exchange playbooks reference bundled files as `{{AUTORUN_FOLDER}}/assets/...`
 * (the documented convention), but the import writes them to
 * `<autoRunFolderPath>/<targetFolderName>/assets/`, and `{{AUTORUN_FOLDER}}`
 * expands to the Auto Run root, so the reference never resolved. Rewriting the
 * reference at import keeps `{{AUTORUN_FOLDER}}` meaning the root everywhere
 * else and keeps each playbook's assets in its own folder.
 */
export function rebaseAssetReferences(text: string, targetFolderName: string): string {
	if (!targetFolderName.trim()) return text;
	return text.replace(
		/\{\{AUTORUN_FOLDER\}\}\/assets(?![\w.-])/gi,
		() => `{{AUTORUN_FOLDER}}/${targetFolderName}/assets`
	);
}

export function assertSafeTargetFolderName(targetFolderName: string): void {
	if (!targetFolderName || targetFolderName.trim() === '') {
		throw new MarketplaceImportError('targetFolderName is required');
	}
	const trimmed = targetFolderName.trim();
	if (
		trimmed.includes('..') ||
		trimmed.includes('/') ||
		trimmed.includes('\\') ||
		trimmed.startsWith('~') ||
		path.isAbsolute(trimmed)
	) {
		throw new MarketplaceImportError(
			`targetFolderName must be a single folder name without separators: ${targetFolderName}`
		);
	}
}

function validateSafePath(basePath: string, requestedFile: string): string {
	const realBase = path.resolve(basePath);
	const resolved = path.resolve(basePath, requestedFile);
	if (!resolved.startsWith(realBase + path.sep) && resolved !== realBase) {
		throw new MarketplaceFetchError(`Path traversal blocked: ${requestedFile}`);
	}
	return resolved;
}

async function readLocalManifest(app: App): Promise<MarketplaceManifest | null> {
	const localManifestPath = getLocalManifestPath(app);
	try {
		const content = await fs.readFile(localManifestPath, 'utf-8');
		const data = JSON.parse(content);
		if (!data.playbooks || !Array.isArray(data.playbooks)) {
			logger.warn('Invalid local manifest structure: missing playbooks array', LOG_CONTEXT);
			return null;
		}
		logger.info(`Loaded local manifest with ${data.playbooks.length} playbook(s)`, LOG_CONTEXT);
		return data as MarketplaceManifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		logger.warn('Failed to read local manifest, ignoring', LOG_CONTEXT, { error });
		return null;
	}
}

/**
 * `documents[].filename` names a document WITHOUT its `.md` extension, and
 * every consumer appends one: the fetch URL, the file the import writes, the
 * saved playbook entry, and the label in the Marketplace modal. Some official
 * manifest entries carry the extension anyway (`Agent-Prompt.md`), so the
 * fetch asked GitHub for `Agent-Prompt.md.md`, got a 404, and the whole import
 * failed (MAESTRO-QB). Strip it once, here, so every consumer agrees.
 */
function withExtensionlessDocuments(playbook: MarketplacePlaybook): MarketplacePlaybook {
	if (!Array.isArray(playbook.documents)) return playbook;
	return {
		...playbook,
		documents: playbook.documents.map((doc) =>
			typeof doc?.filename === 'string'
				? { ...doc, filename: doc.filename.replace(/\.md$/i, '') }
				: doc
		),
	};
}

/**
 * A manifest entry's `launch` block is someone else's JSON, so only the normalized spec that
 * `parseLaunchSpec` returns is kept. An invalid block is dropped with a warning and the entry
 * stays, download-only: one bad block never breaks the manifest or hides the playbook.
 */
function withParsedLaunchSpec(playbook: MarketplacePlaybook): MarketplacePlaybook {
	const { launch, ...withoutLaunch } = playbook;
	// Absent, or `null` (how this manifest says "none", as with `prompt: null`): no block, no warning.
	if (launch === undefined || launch === null) return withoutLaunch;
	const { spec, errors } = parseLaunchSpec(launch);
	if (spec) return { ...withoutLaunch, launch: spec };
	logger.warn(
		`Playbook "${playbook.id}" has an invalid launch block, so it stays download-only`,
		LOG_CONTEXT,
		{ errors }
	);
	return withoutLaunch;
}

/** Every entry of either manifest passes through here before anything reads it. */
function normalizeManifestEntry(playbook: MarketplacePlaybook): MarketplacePlaybook {
	return withParsedLaunchSpec(withExtensionlessDocuments(playbook));
}

function mergeManifests(
	official: MarketplaceManifest | null,
	local: MarketplaceManifest | null
): MarketplaceManifest {
	if (!official && !local) {
		return { lastUpdated: new Date().toISOString().split('T')[0], playbooks: [] };
	}
	if (official && !local) {
		return {
			...official,
			playbooks: official.playbooks.map((p) => ({
				...normalizeManifestEntry(p),
				source: 'official' as const,
			})),
		};
	}
	if (!official && local) {
		return {
			...local,
			playbooks: local.playbooks.map((p) => ({
				...normalizeManifestEntry(p),
				source: 'local' as const,
			})),
		};
	}
	const officialPlaybooks = official!.playbooks;
	const localPlaybooks = local!.playbooks;
	const localMap = new Map<string, MarketplacePlaybook>();
	for (const playbook of localPlaybooks) {
		if (!playbook.id) {
			logger.warn('Local playbook missing required "id" field, skipping', LOG_CONTEXT, {
				title: playbook.title,
			});
			continue;
		}
		if (!playbook.title || !playbook.path || !playbook.documents) {
			logger.warn(`Local playbook "${playbook.id}" missing required fields, skipping`, LOG_CONTEXT);
			continue;
		}
		localMap.set(playbook.id, { ...normalizeManifestEntry(playbook), source: 'local' });
	}
	const mergedPlaybooks = officialPlaybooks.map((official) => {
		const localOverride = localMap.get(official.id);
		if (localOverride) {
			logger.info(`Local playbook "${official.id}" overrides official version`, LOG_CONTEXT);
			return localOverride;
		}
		return { ...normalizeManifestEntry(official), source: 'official' as const };
	});
	const officialIds = new Set(officialPlaybooks.map((p) => p.id));
	const localOnlyPlaybooks = Array.from(localMap.values()).filter(
		(local) => !officialIds.has(local.id)
	);
	return {
		lastUpdated:
			official?.lastUpdated || local?.lastUpdated || new Date().toISOString().split('T')[0],
		playbooks: [...mergedPlaybooks, ...localOnlyPlaybooks],
	};
}

async function readCache(app: App): Promise<MarketplaceCache | null> {
	const cachePath = getCacheFilePath(app);
	try {
		const content = await fs.readFile(cachePath, 'utf-8');
		const data = JSON.parse(content);
		if (
			typeof data.fetchedAt !== 'number' ||
			!data.manifest ||
			!Array.isArray(data.manifest.playbooks)
		) {
			logger.warn('Invalid cache structure, ignoring', LOG_CONTEXT);
			return null;
		}
		return data as MarketplaceCache;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.debug('Cache read error (non-ENOENT)', LOG_CONTEXT, { error });
		}
		return null;
	}
}

async function writeCache(app: App, manifest: MarketplaceManifest): Promise<void> {
	const cachePath = getCacheFilePath(app);
	try {
		const cache: MarketplaceCache = { fetchedAt: Date.now(), manifest };
		await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
	} catch (error) {
		logger.warn('Failed to write cache', LOG_CONTEXT, { error });
	}
}

function isCacheValid(cache: MarketplaceCache): boolean {
	return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

async function fetchManifest(): Promise<MarketplaceManifest> {
	logger.info('Fetching manifest from GitHub', LOG_CONTEXT);
	try {
		const response = await fetchWithTimeout(MANIFEST_URL, {}, MARKETPLACE_FETCH_TIMEOUT_MS);
		if (!response.ok) {
			throw new MarketplaceFetchError(
				`Failed to fetch manifest: ${response.status} ${response.statusText}`
			);
		}
		const data = (await response.json()) as { playbooks?: unknown[] };
		if (!data.playbooks || !Array.isArray(data.playbooks)) {
			throw new MarketplaceFetchError('Invalid manifest structure: missing playbooks array');
		}
		return data as unknown as MarketplaceManifest;
	} catch (error) {
		if (error instanceof MarketplaceFetchError) throw error;
		throw new MarketplaceFetchError(
			`Network error fetching manifest: ${error instanceof Error ? error.message : String(error)}`,
			error
		);
	}
}

async function fetchDocument(playbookPath: string, filename: string): Promise<string> {
	if (filename.includes('..')) throw new MarketplaceFetchError('Invalid filename');
	if (isLocalPath(playbookPath)) {
		const resolvedPath = resolveTildePath(playbookPath);
		const docPath = validateSafePath(resolvedPath, `${filename}.md`);
		try {
			return await fs.readFile(docPath, 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new MarketplaceFetchError(`Local document not found: ${docPath}`);
			}
			throw new MarketplaceFetchError(
				`Failed to read local document: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}
	}
	const url = `${GITHUB_RAW_BASE}/${playbookPath}/${filename}.md`;
	try {
		const response = await fetchWithTimeout(url, {}, MARKETPLACE_FETCH_TIMEOUT_MS);
		if (!response.ok) {
			if (response.status === 404) {
				throw new MarketplaceFetchError(`Document not found: ${filename}`, { status: 404 });
			}
			throw new MarketplaceFetchError(
				`Failed to fetch document: ${response.status} ${response.statusText}`
			);
		}
		return await response.text();
	} catch (error) {
		if (error instanceof MarketplaceFetchError) throw error;
		throw new MarketplaceFetchError(
			`Network error fetching document: ${error instanceof Error ? error.message : String(error)}`,
			error
		);
	}
}

async function fetchAsset(playbookPath: string, assetFilename: string): Promise<Buffer> {
	if (assetFilename.includes('..')) throw new MarketplaceFetchError('Invalid filename');
	if (isLocalPath(playbookPath)) {
		const resolvedPath = resolveTildePath(playbookPath);
		const assetPath = validateSafePath(resolvedPath, path.join('assets', assetFilename));
		try {
			return await fs.readFile(assetPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new MarketplaceFetchError(`Local asset not found: ${assetPath}`);
			}
			throw new MarketplaceFetchError(
				`Failed to read local asset: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}
	}
	const url = `${GITHUB_RAW_BASE}/${playbookPath}/assets/${assetFilename}`;
	try {
		const response = await fetchWithTimeout(url, {}, MARKETPLACE_FETCH_TIMEOUT_MS);
		if (!response.ok) {
			if (response.status === 404) {
				throw new MarketplaceFetchError(`Asset not found: ${assetFilename}`, { status: 404 });
			}
			throw new MarketplaceFetchError(
				`Failed to fetch asset: ${response.status} ${response.statusText}`
			);
		}
		return Buffer.from(await response.arrayBuffer());
	} catch (error) {
		if (error instanceof MarketplaceFetchError) throw error;
		throw new MarketplaceFetchError(
			`Network error fetching asset: ${error instanceof Error ? error.message : String(error)}`,
			error
		);
	}
}

async function fetchReadme(playbookPath: string): Promise<string | null> {
	if (isLocalPath(playbookPath)) {
		const resolvedPath = resolveTildePath(playbookPath);
		const readmePath = validateSafePath(resolvedPath, 'README.md');
		try {
			return await fs.readFile(readmePath, 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw new MarketplaceFetchError(
				`Failed to read local README: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}
	}
	const url = `${GITHUB_RAW_BASE}/${playbookPath}/README.md`;
	const response = await fetchWithTimeout(url, {}, MARKETPLACE_FETCH_TIMEOUT_MS);
	if (!response.ok) {
		if (response.status === 404) return null;
		throw new MarketplaceFetchError(
			`Failed to fetch README: ${response.status} ${response.statusText}`
		);
	}
	return await response.text();
}

export interface GetManifestServiceResult {
	manifest: MarketplaceManifest;
	fromCache: boolean;
	cacheAge?: number;
}

/**
 * Get the merged manifest (official + local), serving from cache when valid.
 */
export async function getMarketplaceManifest(app: App): Promise<GetManifestServiceResult> {
	const cache = await readCache(app);
	let officialManifest: MarketplaceManifest | null = null;
	let fromCache = false;
	let cacheAge: number | undefined;

	if (cache && isCacheValid(cache)) {
		cacheAge = Date.now() - cache.fetchedAt;
		officialManifest = cache.manifest;
		fromCache = true;
	} else {
		try {
			officialManifest = await fetchManifest();
			await writeCache(app, officialManifest);
		} catch (error) {
			void captureException(error);
			logger.warn('Failed to fetch official manifest from GitHub', LOG_CONTEXT, { error });
			if (cache) {
				cacheAge = Date.now() - cache.fetchedAt;
				officialManifest = cache.manifest;
				fromCache = true;
			}
		}
	}

	const localManifest = await readLocalManifest(app);
	const mergedManifest = mergeManifests(officialManifest, localManifest);
	return { manifest: mergedManifest, fromCache, cacheAge };
}

/**
 * Force refresh the manifest from GitHub, falling back to cache if the
 * network call fails.
 */
export async function refreshMarketplaceManifest(
	app: App
): Promise<{ manifest: MarketplaceManifest; fromCache: boolean }> {
	let officialManifest: MarketplaceManifest | null = null;
	let fromCache = false;
	try {
		officialManifest = await fetchManifest();
		await writeCache(app, officialManifest);
	} catch (error) {
		void captureException(error);
		logger.warn('Failed to fetch official manifest during refresh', LOG_CONTEXT, { error });
		const cache = await readCache(app);
		if (cache) {
			officialManifest = cache.manifest;
			fromCache = true;
		}
	}
	const localManifest = await readLocalManifest(app);
	const mergedManifest = mergeManifests(officialManifest, localManifest);
	return { manifest: mergedManifest, fromCache };
}

export async function getMarketplaceDocument(
	playbookPath: string,
	filename: string
): Promise<{ content: string }> {
	const content = await fetchDocument(playbookPath, filename);
	return { content };
}

export async function getMarketplaceReadme(
	playbookPath: string
): Promise<{ content: string | null }> {
	const content = await fetchReadme(playbookPath);
	return { content };
}

export interface ImportPlaybookOptions {
	app: App;
	playbookId: string;
	targetFolderName: string;
	autoRunFolderPath: string;
	sessionId: string;
	/** Resolved SSH config - caller is responsible for looking it up. */
	sshConfig?: SshRemoteConfig;
	/**
	 * Launch answers, keyed by input name. When given and the playbook has a launch spec, they are
	 * written into the saved prompt's configuration lines; task documents are written as a
	 * Download writes them. Absent (Download), the import is unchanged.
	 */
	launchValues?: PlaybookLaunchValues;
}

export interface ImportPlaybookServiceResult {
	playbook: {
		id: string;
		name: string;
		createdAt: number;
		updatedAt: number;
		documents: Array<{ filename: string; resetOnCompletion: boolean }>;
		loopEnabled: boolean;
		maxLoops?: number | null;
		prompt: string;
		taskSelectionMode?: TaskSelectionMode;
	};
	importedDocs: string[];
	importedAssets: string[];
}

/**
 * The values a launch writes: the answers resolved against the spec (a default fills what was
 * left empty), then checked. Throws `MarketplaceLaunchValuesError` naming every failing input.
 */
function resolveValidLaunchValues(
	spec: PlaybookLaunchSpec,
	answers: PlaybookLaunchValues
): PlaybookLaunchValues {
	const values = resolveLaunchValues(spec, answers);
	const fieldErrors = validateLaunchValues(spec, values);
	if (Object.keys(fieldErrors).length > 0) throw new MarketplaceLaunchValuesError(fieldErrors);
	return values;
}

/**
 * The prompt an import saves, before its asset references are rebased. A Download (no
 * `launchValues`, or a playbook without a launch spec) saves the shipped prompt; a launch saves it
 * with the answers on its configuration lines. The answers go in before the rebase, so a launch
 * with every default saves exactly what a Download saves. `launchValues` may come from IPC or the
 * web bridge, so its shape is checked too.
 */
function importedPromptFor(
	playbook: MarketplacePlaybook,
	launchValues: PlaybookLaunchValues | undefined
): string {
	const shipped = playbook.prompt ?? '';
	if (launchValues === undefined || launchValues === null) return shipped;
	if (!isLaunchValuesObject(launchValues)) {
		throw new MarketplaceImportError('launchValues must be an object keyed by input name');
	}
	const spec = playbook.launch;
	if (!spec) return shipped;
	return applyLaunchInputs(shipped, spec, resolveValidLaunchValues(spec, launchValues));
}

/**
 * `<autoRunFolderPath>/<folderName>` as an import writes it: joined for this computer, or with `/`
 * for an SSH remote, whose path is never resolved here.
 */
function importTargetPath(autoRunFolderPath: string, folderName: string, remote: boolean): string {
	if (!remote) return path.join(autoRunFolderPath, folderName);
	return autoRunFolderPath.endsWith('/')
		? `${autoRunFolderPath}${folderName}`
		: `${autoRunFolderPath}/${folderName}`;
}

/**
 * Import a playbook to the Auto Run folder (local or remote via SSH).
 * Mirrors the IPC handler import flow exactly.
 */
export async function importMarketplacePlaybook(
	opts: ImportPlaybookOptions
): Promise<ImportPlaybookServiceResult> {
	const { app, playbookId, targetFolderName, sshConfig } = opts;

	assertSafeTargetFolderName(targetFolderName);

	logger.info(
		`Importing playbook "${playbookId}" to "${targetFolderName}"${sshConfig ? ' (remote via SSH)' : ''}`,
		LOG_CONTEXT
	);

	return writeImportedPlaybook(await findImportablePlaybook(app, playbookId), opts);
}

/**
 * The merged manifest entry an import writes, from a fresh, cache-aware read of the merged
 * manifest, so local and official playbooks are both visible. Throws `MarketplaceImportError` for
 * an unknown id or a playbook that needs a newer Maestro.
 */
async function findImportablePlaybook(app: App, playbookId: string): Promise<MarketplacePlaybook> {
	// Re-resolve manifest (cache-aware) so local + official playbooks are visible
	const cache = await readCache(app);
	let officialManifest: MarketplaceManifest | null = null;
	if (cache && isCacheValid(cache)) {
		officialManifest = cache.manifest;
	} else {
		try {
			officialManifest = await fetchManifest();
			await writeCache(app, officialManifest);
		} catch (error) {
			void captureException(error);
			// Fall back to stale cache if present so a transient fetch failure
			// during import doesn't drop official playbooks the UI is still
			// showing from the same stale cache via getMarketplaceManifest().
			// Otherwise the user sees a visible playbook that import then
			// claims doesn't exist.
			if (cache) {
				officialManifest = cache.manifest;
				logger.warn(
					'Failed to fetch official manifest during import; falling back to stale cache',
					LOG_CONTEXT,
					{ error }
				);
			} else {
				logger.warn(
					'Failed to fetch official manifest during import, continuing with local only',
					LOG_CONTEXT,
					{ error }
				);
			}
		}
	}
	const localManifest = await readLocalManifest(app);
	const manifest = mergeManifests(officialManifest, localManifest);

	const marketplacePlaybook = manifest.playbooks.find((p) => p.id === playbookId);
	if (!marketplacePlaybook) {
		throw new MarketplaceImportError(`Playbook not found: ${playbookId}`);
	}

	// Defense-in-depth: re-check compatibility at the service layer even
	// though the UI disables install for incompatible tiles. Protects future
	// bypass paths (CLI, deep link, programmatic install, mobile WS).
	const runningVersion = app.getVersion();
	if (!isCompatible(marketplacePlaybook, runningVersion)) {
		throw new MarketplaceImportError(
			`This playbook requires Maestro ${marketplacePlaybook.minMaestroVersion}+; ` +
				`you have ${runningVersion}. Update Maestro and try again.`
		);
	}
	return marketplacePlaybook;
}

/**
 * Write a resolved playbook into `<autoRunFolderPath>/<targetFolderName>` (local or remote via SSH)
 * and add it to the agent's saved playbooks: everything an import does once it has the entry.
 */
async function writeImportedPlaybook(
	marketplacePlaybook: MarketplacePlaybook,
	opts: ImportPlaybookOptions
): Promise<ImportPlaybookServiceResult> {
	const { app, targetFolderName, autoRunFolderPath, sessionId, sshConfig, launchValues } = opts;
	const isRemote = !!sshConfig;

	// Built before anything touches the disk: a launch whose answers fail validation throws here
	// and leaves no folder behind.
	const prompt = rebaseAssetReferences(
		importedPromptFor(marketplacePlaybook, launchValues),
		targetFolderName
	);

	const targetPath = importTargetPath(autoRunFolderPath, targetFolderName, isRemote);

	if (isRemote) {
		const mkdirResult = await mkdirRemote(targetPath, sshConfig!, true);
		if (!mkdirResult.success) {
			throw new MarketplaceImportError(`Failed to create remote directory: ${mkdirResult.error}`);
		}
	} else {
		await fs.mkdir(targetPath, { recursive: true });
	}

	const importedDocs: string[] = [];
	for (const doc of marketplacePlaybook.documents) {
		try {
			const content = rebaseAssetReferences(
				await fetchDocument(marketplacePlaybook.path, doc.filename),
				targetFolderName
			);
			const docPath = isRemote
				? `${targetPath}/${doc.filename}.md`
				: path.join(targetPath, `${doc.filename}.md`);
			if (isRemote) {
				const writeResult = await writeFileRemote(docPath, content, sshConfig!);
				if (!writeResult.success) {
					throw new Error(writeResult.error || 'Failed to write remote file');
				}
			} else {
				await fs.writeFile(docPath, content, 'utf-8');
			}
			importedDocs.push(doc.filename);
		} catch (error) {
			void captureException(error);
			logger.warn(`Failed to import document ${doc.filename}`, LOG_CONTEXT, { error });
		}
	}

	// Refuse to persist a playbook whose documents all failed to write -
	// the per-doc loop is intentionally tolerant so one bad file doesn't
	// block the rest, but if every doc failed we'd otherwise create a
	// playbook with `documents: []`, return success, close the marketplace
	// sheet, and leave the user with an unusable imported entry.
	if (marketplacePlaybook.documents.length > 0 && importedDocs.length === 0) {
		throw new MarketplaceImportError(
			`Failed to import any documents for playbook: ${marketplacePlaybook.title}`
		);
	}

	// Build effective asset list (local: union manifest + discovered files)
	const manifestAssets = marketplacePlaybook.assets ?? [];
	let effectiveAssets = manifestAssets;
	if (isLocalPath(marketplacePlaybook.path)) {
		const discoveredAssets: string[] = [];
		const resolvedPlaybookPath = resolveTildePath(marketplacePlaybook.path);
		const localAssetsPath = path.join(resolvedPlaybookPath, 'assets');
		try {
			const entries = await fs.readdir(localAssetsPath);
			for (const entry of entries) {
				const entryPath = path.join(localAssetsPath, entry);
				try {
					const stat = await fs.stat(entryPath);
					if (stat.isFile()) discoveredAssets.push(entry);
				} catch (error) {
					void captureException(error);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn(`Failed to read local assets directory: ${localAssetsPath}`, LOG_CONTEXT, {
					error,
				});
			}
		}
		effectiveAssets = Array.from(new Set([...manifestAssets, ...discoveredAssets]));
	}

	const importedAssets: string[] = [];
	if (effectiveAssets.length > 0) {
		const assetsPath = isRemote ? `${targetPath}/assets` : path.join(targetPath, 'assets');
		if (isRemote) {
			const mkdirResult = await mkdirRemote(assetsPath, sshConfig!, true);
			if (!mkdirResult.success) {
				logger.warn(`Failed to create remote assets directory: ${mkdirResult.error}`, LOG_CONTEXT);
			}
		} else {
			await fs.mkdir(assetsPath, { recursive: true });
		}

		for (const assetFilename of effectiveAssets) {
			try {
				const content = await fetchAsset(marketplacePlaybook.path, assetFilename);
				const assetPath = isRemote
					? `${assetsPath}/${assetFilename}`
					: path.join(assetsPath, assetFilename);
				if (isRemote) {
					const writeResult = await writeFileRemote(assetPath, content, sshConfig!);
					if (!writeResult.success) {
						throw new Error(writeResult.error || 'Failed to write remote asset file');
					}
				} else {
					await fs.writeFile(assetPath, content);
				}
				importedAssets.push(assetFilename);
			} catch (error) {
				void captureException(error);
				logger.warn(`Failed to import asset ${assetFilename}`, LOG_CONTEXT, { error });
			}
		}
	}

	// Persist only documents that actually wrote to disk so the playbook
	// never references missing files. Filter manifest order against the
	// importedDocs success set.
	const importedDocSet = new Set(importedDocs);
	const now = Date.now();
	const newPlaybook = {
		id: crypto.randomUUID(),
		name: marketplacePlaybook.title,
		createdAt: now,
		updatedAt: now,
		documents: marketplacePlaybook.documents
			.filter((d) => importedDocSet.has(d.filename))
			.map((d) => ({
				filename: targetFolderName ? `${targetFolderName}/${d.filename}` : d.filename,
				resetOnCompletion: d.resetOnCompletion,
			})),
		loopEnabled: marketplacePlaybook.loopEnabled,
		maxLoops: marketplacePlaybook.maxLoops,
		prompt,
		// The manifest is someone else's JSON: only a value Auto Run knows is kept. Absent means
		// per task, so a playbook that never declared one imports exactly as it always has.
		...(isTaskSelectionMode(marketplacePlaybook.taskSelectionMode) && {
			taskSelectionMode: marketplacePlaybook.taskSelectionMode,
		}),
	};

	const playbooksFilePath = getSavedPlaybooksFilePath(app, sessionId);
	await fs.mkdir(path.dirname(playbooksFilePath), { recursive: true });
	let playbooks: any[] = [];
	try {
		const content = await fs.readFile(playbooksFilePath, 'utf-8');
		const data = JSON.parse(content);
		playbooks = Array.isArray(data.playbooks) ? data.playbooks : [];
	} catch (error) {
		// ENOENT is normal (first save). Anything else (corrupt JSON, EACCES,
		// etc.) means there's existing user data we couldn't read - refuse
		// to silently overwrite it, since starting from [] would drop their
		// previously-saved playbooks on the next write.
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			void captureException(error);
			throw new MarketplaceImportError(
				`Failed to read existing playbooks file (refusing to overwrite): ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}
	}
	playbooks.push(newPlaybook);
	await fs.writeFile(playbooksFilePath, JSON.stringify({ playbooks }, null, 2), 'utf-8');

	logger.info(
		`Successfully imported playbook "${marketplacePlaybook.title}" with ${importedDocs.length} documents and ${importedAssets.length} assets`,
		LOG_CONTEXT
	);

	return { playbook: newPlaybook, importedDocs, importedAssets };
}

/** What `deleteLaunchFolder` did. */
export interface DeleteLaunchFolderResult {
	/** The launch folder's path, on the SSH remote for a remote agent */
	targetPath: string;
	/** False when nothing was at `targetPath`, so there was nothing to delete */
	deleted: boolean;
}

/**
 * Windows drops a trailing dot or space from a name (`<root>\. ` is the root itself, and `foo.` is
 * `foo`) and reads a colon as a drive or a data stream, so such a name does not name the folder it
 * spells there. Launch folder names never hold one.
 */
const WINDOWS_ALIASED_NAME = /:|[.\s]$/;

/** An absolute remote path, or one under the remote home: the forms `shellEscapeRemotePath` expands. */
function isRemoteRootPath(remotePath: string): boolean {
	return (
		remotePath.startsWith('/') ||
		remotePath === '~' ||
		remotePath.startsWith('~/') ||
		remotePath === '$HOME' ||
		remotePath.startsWith('$HOME/')
	);
}

/**
 * Whether an Auto Run folder can hold a launch folder that cleanup finds again: an absolute path
 * on this computer, or on a remote an absolute path or one under the remote home.
 */
function isLaunchRoot(autoRunFolderPath: unknown, remote: boolean): autoRunFolderPath is string {
	if (typeof autoRunFolderPath !== 'string') return false;
	return remote
		? isRemoteRootPath(normalizeWorktreePath(autoRunFolderPath, true))
		: path.isAbsolute(autoRunFolderPath);
}

/**
 * The one path launch cleanup may delete, `<autoRunFolderPath>/<folder>`, where `folder` is one
 * plain folder name. Throws `MarketplaceLaunchCleanupError` for anything else. A local path is
 * resolved. A remote path is built as the import built it, with its slashes normalized and nothing
 * resolved, because the remote resolves it; only the checks normalize `.` segments.
 */
function launchFolderTarget(autoRunFolderPath: string, folder: string, remote: boolean): string {
	const refuse = (reason: string) => new MarketplaceLaunchCleanupError(folder, reason);
	try {
		assertSafeTargetFolderName(folder);
	} catch (error) {
		if (!(error instanceof MarketplaceImportError)) throw error;
		throw refuse('it is not a single folder name');
	}

	if (!isLaunchRoot(autoRunFolderPath, remote)) {
		throw refuse(
			remote
				? 'the Auto Run folder is not an absolute path on the remote'
				: 'the Auto Run folder is not an absolute path'
		);
	}

	let target: string;
	let rootKey: string;
	let targetKey: string;
	if (remote) {
		const root = normalizeWorktreePath(autoRunFolderPath, true);
		target = root.endsWith('/') ? `${root}${folder}` : `${root}/${folder}`;
		rootKey = normalizeWorktreePath(path.posix.normalize(root), true);
		targetKey = normalizeWorktreePath(path.posix.normalize(target), true);
	} else {
		const root = path.resolve(autoRunFolderPath);
		target = path.resolve(root, folder);
		// Compared with `/` separators, which `isPathAtOrUnderRoot` expects.
		rootKey = normalizeWorktreePath(root);
		targetKey = normalizeWorktreePath(target);
	}

	if (targetKey === rootKey) throw refuse('it names the Auto Run folder itself');
	if (!isPathAtOrUnderRoot(targetKey, rootKey)) {
		throw refuse('it resolves outside the Auto Run folder');
	}
	const rootPrefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
	if (targetKey !== `${rootPrefix}${folder}`) {
		throw refuse('it is not a folder directly inside the Auto Run folder');
	}
	if (WINDOWS_ALIASED_NAME.test(folder)) {
		throw refuse('a trailing dot or space, or a colon, makes Windows read it as another path');
	}
	return target;
}

/**
 * Delete one launch folder, `<autoRunFolderPath>/<folderRelativePath>`, and nothing else: the only
 * delete Launch cleanup makes. Pass the folder the launch record names, the Auto Run folder of the
 * agent the launch ran on, and that agent's SSH remote id when it runs on one.
 *
 * Refuses with `MarketplaceLaunchCleanupError`, deleting nothing: a folder that fails
 * `assertSafeTargetFolderName`, names the Auto Run folder itself, does not resolve directly inside
 * it, or is a name Windows reads as another path; a relative Auto Run folder; a symbolic link; a
 * file; and an SSH remote that is missing or disabled (it never falls back to this computer, where
 * the same path is a different folder). Nothing at the path resolves with `deleted: false`. On a
 * remote the checks and the delete run in one SSH command (`deleteDirectoryRemote`). Any other
 * failure, such as a permission error or a lost connection, is thrown as it is.
 */
export async function deleteLaunchFolder(
	autoRunFolderPath: string,
	folderRelativePath: string,
	sshRemoteId?: string
): Promise<DeleteLaunchFolderResult> {
	const targetPath = launchFolderTarget(autoRunFolderPath, folderRelativePath, !!sshRemoteId);
	const refuse = (reason: string) => new MarketplaceLaunchCleanupError(folderRelativePath, reason);

	let deleted: boolean;
	if (sshRemoteId) {
		const sshRemote = getSshRemoteById(sshRemoteId);
		if (!sshRemote?.enabled) {
			throw refuse(
				`SSH remote "${sshRemoteId}" is missing or disabled, and the same path on this computer is a different folder`
			);
		}
		const result = await deleteDirectoryRemote(targetPath, sshRemote);
		if (result.errorCode === 'symlink') throw refuse('it is a symbolic link');
		if (result.errorCode === 'not-directory') throw refuse('it is not a folder');
		if (!result.success) {
			throw new Error(
				`Failed to delete the launch folder ${targetPath} on SSH remote "${sshRemoteId}": ${result.error}`
			);
		}
		deleted = result.data === true;
	} else {
		const stats = await fs.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (stats) {
			if (stats.isSymbolicLink()) throw refuse('it is a symbolic link');
			if (!stats.isDirectory()) throw refuse('it is not a folder');
			// `fs.rm` removes links inside the folder without following them. The retries ride out
			// a file Windows still holds open just after the run.
			await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 3 });
		}
		deleted = stats !== undefined;
	}

	logger.info(
		deleted
			? `Deleted launch folder ${targetPath}${sshRemoteId ? ' (remote via SSH)' : ''}`
			: `Launch folder ${targetPath} was already gone`,
		LOG_CONTEXT
	);
	return { targetPath, deleted };
}

/** How many names a launch tries for its folder: `<base>`, then `<base>-2`, up to `<base>-10`. */
const LAUNCH_FOLDER_ATTEMPTS = 10;

/**
 * Agents with a launch in `launchMarketplacePlaybook` right now. A second launch on the same agent
 * is refused at once instead of importing beside the first, because an import rewrites the agent's
 * saved-playbooks file and two at once can lose an entry. Every launch runs in this main process.
 */
const launchesStarting = new Set<string>();

/** What a launch asks the renderer to run: the launch form of a `configure_auto_run` request. */
export interface LaunchAutoRunConfig {
	/** Relative to the agent's Auto Run folder and without `.md`, as the saved playbook names them */
	documents: Array<{ filename: string; resetOnCompletion: boolean }>;
	prompt: string;
	loopEnabled: boolean;
	/** Absent means no limit */
	maxLoops?: number;
	taskSelectionMode?: TaskSelectionMode;
	launch: true;
}

/**
 * Starts a launched playbook's Auto Run on an agent and resolves whether the renderer accepted it.
 * The desktop passes `configureAutoRunInRenderer`
 * (`src/main/web-server/callbacks/autoRunConfigCallbacks.ts`), the round trip the
 * `configure_auto_run` WS message uses.
 */
export type LaunchAutoRunStarter = (
	sessionId: string,
	config: LaunchAutoRunConfig
) => Promise<{ success: boolean; error?: string }>;

/**
 * What Playbook Launch needs from the app that runs it. `src/main/index.ts` builds one, which the
 * IPC handlers and the web bridge callbacks share, so a launch started or completed either way
 * behaves the same.
 */
export interface MarketplaceLaunchHost {
	app: App;
	startAutoRun: LaunchAutoRunStarter;
	/**
	 * Whether `maestro-cli` is installed on this computer (`MaestroCliStatus.installed`, which the
	 * launch modal shows too). Asked only for an agent on this computer, and only when the spec
	 * declares `preconditions.maestroCli`.
	 */
	isMaestroCliInstalled: () => Promise<boolean>;
	/**
	 * Tells every window and web client that a launch record changed, as the
	 * `marketplace:launchChanged` event with the record. Called when `completeMarketplaceLaunch`
	 * has ended a launch and cleaned up after it.
	 */
	onLaunchChanged: (launch: PlaybookLaunchRecord) => void;
}

/**
 * `<slug>-launch-<stamp>`: the folder name the Exchange proposes for the playbook's title (its id
 * when the title has no letter or digit), then the local time to the second.
 */
function launchFolderBaseName(playbook: MarketplacePlaybook): string {
	const slug =
		generateDefaultFolderName(playbook.title) ||
		generateDefaultFolderName(playbook.id) ||
		'playbook';
	return `${slug}-launch-${fileTimestampSlug()}`;
}

/**
 * Create a launch folder inside the Auto Run folder and return its name: `baseName`, or
 * `baseName-2` and on when that name is taken. The folder itself is created exclusively (`mkdir`
 * without `-p`), so two launches never share one, even when they start in the same second in a
 * shared Auto Run folder. Cleanup deletes the folder a record names, so a shared folder would take
 * the other run's documents with it.
 */
async function createLaunchFolder(
	autoRunFolderPath: string,
	baseName: string,
	sshConfig: SshRemoteConfig | undefined
): Promise<string> {
	if (sshConfig) {
		const root = await mkdirRemote(autoRunFolderPath, sshConfig, true);
		if (!root.success) {
			throw new MarketplaceImportError(`Failed to create remote directory: ${root.error}`);
		}
	} else {
		await fs.mkdir(autoRunFolderPath, { recursive: true });
	}

	for (let attempt = 1; attempt <= LAUNCH_FOLDER_ATTEMPTS; attempt++) {
		const name = attempt === 1 ? baseName : `${baseName}-${attempt}`;
		const target = importTargetPath(autoRunFolderPath, name, !!sshConfig);
		if (sshConfig) {
			const created = await mkdirRemote(target, sshConfig, false);
			if (created.success) return name;
			if (created.errorCode !== 'exists') {
				throw new MarketplaceImportError(`Failed to create remote directory: ${created.error}`);
			}
		} else {
			try {
				await fs.mkdir(target);
				return name;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
		}
	}
	throw new MarketplaceImportError(
		`Every launch folder name from ${baseName} to ${baseName}-${LAUNCH_FOLDER_ATTEMPTS} is taken`
	);
}

/** What one launch put on disk, for `undoLaunchImport`. */
interface LaunchImport {
	app: App;
	sessionId: string;
	autoRunFolderPath: string;
	folder: string;
	sshRemoteId?: string;
	/** Absent until the import has added the saved playbook */
	savedPlaybookId?: string;
}

/**
 * Take back a launch that will not run: delete its folder and the saved playbook its import added.
 * A failure here is reported and logged but not thrown, so the caller can still throw the error
 * that stopped the launch. Resolves whether the folder is gone.
 */
async function undoLaunchImport(launch: LaunchImport): Promise<boolean> {
	let folderRemoved = false;
	try {
		await deleteLaunchFolder(launch.autoRunFolderPath, launch.folder, launch.sshRemoteId);
		folderRemoved = true;
	} catch (error) {
		void captureException(error, { operation: 'marketplace:undoLaunch', folder: launch.folder });
		logger.warn(`Could not remove the launch folder ${launch.folder}`, LOG_CONTEXT, { error });
	}
	if (launch.savedPlaybookId) {
		try {
			await deleteSavedPlaybook(launch.app, launch.sessionId, launch.savedPlaybookId);
		} catch (error) {
			void captureException(error, {
				operation: 'marketplace:undoLaunch',
				savedPlaybookId: launch.savedPlaybookId,
			});
			logger.warn(
				`Could not remove the saved playbook ${launch.savedPlaybookId} of a launch`,
				LOG_CONTEXT,
				{ error }
			);
		}
	}
	return folderRemoved;
}

/**
 * Launch a marketplace playbook: import it with the user's answers into a launch folder of its
 * own, record the launch, and start its Auto Run on the agent. The launch modal (over IPC) and
 * `maestro-cli` (over the web bridge) both launch through here.
 *
 * Before anything is written it checks: `values` is an object; the Auto Run folder is absolute, so
 * cleanup can find the folder again; the SSH remote exists and is enabled (a launch never falls
 * back to this computer); no other launch is starting on the agent; the agent runs no launch
 * (`MarketplaceLaunchBusyError`) and no other Auto Run, which would make the renderer drop the new
 * run without saying so; the playbook exists and this Maestro can import it; `isLaunchAvailable`
 * passes for the agent; and the answers pass `validateLaunchValues` (else
 * `MarketplaceLaunchValuesError` names each failing input).
 *
 * The import writes the task documents as a Download does; only the saved prompt carries the
 * answers (with defaults filled in). The record keeps the folder, the Auto Run folder, the SSH
 * remote and the spec, which is all completion and the outro need. The Auto Run gets the saved
 * playbook's documents and prompt, its loop setting, `spec.maxLoops` when the spec sets one, and
 * its task selection mode. Resolves once the renderer has accepted the run.
 *
 * A launch that fails after its folder exists takes everything back: the folder and the saved
 * playbook are removed, even with `keepSavedPlaybook`, because a launch that never ran has nothing
 * to keep. When the Auto Run does not start, the record stays, marked `failed`.
 */
export async function launchMarketplacePlaybook(
	request: PlaybookLaunchRequest,
	host: MarketplaceLaunchHost
): Promise<PlaybookLaunchResult> {
	// `marketplace:launch` passes whatever its caller sent.
	if (typeof request !== 'object' || request === null) {
		throw new MarketplaceImportError('The launch request must be an object');
	}
	const { values, sessionId, autoRunFolderPath } = request;
	// An empty id means this computer, as everywhere else.
	const sshRemoteId = request.sshRemoteId || undefined;
	const remote = sshRemoteId !== undefined;

	if (typeof sessionId !== 'string' || sessionId === '') {
		throw new MarketplaceImportError('sessionId is required');
	}
	if (!isLaunchValuesObject(values)) {
		throw new MarketplaceImportError('values must be an object keyed by input name');
	}
	if (!isLaunchRoot(autoRunFolderPath, remote)) {
		throw new MarketplaceImportError(
			`The Auto Run folder must be an absolute path${remote ? ' on the SSH remote' : ''}: ${autoRunFolderPath}`
		);
	}
	let sshConfig: SshRemoteConfig | undefined;
	if (sshRemoteId) {
		sshConfig = getSshRemoteById(sshRemoteId);
		if (!sshConfig?.enabled) {
			throw new MarketplaceImportError(`SSH remote not found or disabled: ${sshRemoteId}`);
		}
	}

	if (launchesStarting.has(sessionId)) {
		throw new MarketplaceImportError(
			'This agent is already starting a launch. Wait for it to finish, or stop it, then launch again.'
		);
	}
	launchesStarting.add(sessionId);
	try {
		return await startLaunch({ ...request, sshRemoteId, sshConfig }, host);
	} finally {
		launchesStarting.delete(sessionId);
	}
}

/** A launch request whose shape `launchMarketplacePlaybook` has checked, with its SSH remote. */
interface CheckedLaunchRequest extends PlaybookLaunchRequest {
	sshConfig: SshRemoteConfig | undefined;
}

/** `launchMarketplacePlaybook` from the busy checks on, while the agent is held for it. */
async function startLaunch(
	request: CheckedLaunchRequest,
	host: MarketplaceLaunchHost
): Promise<PlaybookLaunchResult> {
	const { playbookId, values, sessionId, autoRunFolderPath, sshRemoteId, sshConfig } = request;
	const remote = sshConfig !== undefined;
	const keepSavedPlaybook = request.keepSavedPlaybook === true;
	const { app } = host;

	const store = getPlaybookLaunchStore(app);
	const running = await store.findRunningLaunchForSession(sessionId);
	if (running) throw new MarketplaceLaunchBusyError(running);
	if (getAutoRunStateTracker().isRunning(sessionId)) {
		throw new MarketplaceImportError(
			'This agent is already running an Auto Run. Wait for it to finish, or stop it, then launch again.'
		);
	}

	const playbook = await findImportablePlaybook(app, playbookId);
	const spec = playbook.launch;
	const needsMaestroCli = spec?.preconditions?.maestroCli !== undefined;
	const availability = isLaunchAvailable(
		playbook,
		app.getVersion(),
		process.platform,
		needsMaestroCli
			? { sshRemote: remote, maestroCliInstalled: !remote && (await host.isMaestroCliInstalled()) }
			: undefined
	);
	if (!spec || !availability.available) {
		throw new MarketplaceImportError(
			availability.reason ?? 'This playbook does not support Launch.'
		);
	}
	const launchValues = resolveValidLaunchValues(spec, values);

	const folder = await createLaunchFolder(
		autoRunFolderPath,
		launchFolderBaseName(playbook),
		sshConfig
	);
	const launchImport: LaunchImport = { app, sessionId, autoRunFolderPath, folder, sshRemoteId };

	let imported: ImportPlaybookServiceResult;
	try {
		imported = await writeImportedPlaybook(playbook, {
			app,
			playbookId,
			targetFolderName: folder,
			autoRunFolderPath,
			sessionId,
			sshConfig,
			launchValues,
		});
	} catch (error) {
		await undoLaunchImport(launchImport);
		throw error;
	}
	const saved = imported.playbook;
	launchImport.savedPlaybookId = saved.id;

	let record: PlaybookLaunchRecord;
	try {
		// Checks for a running launch again, in the same step as the write.
		record = await store.createLaunch({
			playbookId,
			playbookTitle: playbook.title,
			sessionId,
			folderRelativePath: folder,
			autoRunFolderPath,
			sshRemoteId,
			spec,
			savedPlaybookId: saved.id,
			keepSavedPlaybook,
			values: launchValues,
		});
	} catch (error) {
		await undoLaunchImport(launchImport);
		throw error;
	}

	/** Take the launch back, and close its record as failed with what cleanup managed to do. */
	const failLaunch = async (): Promise<void> => {
		const folderRemoved = await undoLaunchImport(launchImport);
		try {
			await store.updateLaunch(record.launchId, {
				status: 'failed',
				finishedAt: Date.now(),
				...(folderRemoved && { cleanup: 'done' as const }),
			});
		} catch (error) {
			// The record stays `running` and holds the agent until Maestro restarts.
			void captureException(error, {
				operation: 'marketplace:launch',
				launchId: record.launchId,
			});
			logger.warn(`Could not mark launch ${record.launchId} as failed`, LOG_CONTEXT, { error });
		}
	};

	const maxLoops = spec.maxLoops !== undefined ? spec.maxLoops : saved.maxLoops;
	let started: Awaited<ReturnType<LaunchAutoRunStarter>>;
	try {
		started = await host.startAutoRun(sessionId, {
			documents: saved.documents,
			prompt: saved.prompt,
			loopEnabled: saved.loopEnabled,
			// `null` is no limit, which an absent `maxLoops` already means to the renderer.
			...(typeof maxLoops === 'number' && { maxLoops }),
			...(saved.taskSelectionMode && { taskSelectionMode: saved.taskSelectionMode }),
			launch: true,
		});
	} catch (error) {
		await failLaunch();
		throw error;
	}
	if (!started.success) {
		await failLaunch();
		throw new MarketplaceImportError(
			`The Auto Run did not start: ${started.error || 'the desktop app gave no reason'}`
		);
	}

	logger.info(
		`Launched playbook "${playbook.title}" on agent ${sessionId} in "${folder}"${remote ? ' (remote via SSH)' : ''}`,
		LOG_CONTEXT,
		{ launchId: record.launchId }
	);
	return { launchId: record.launchId, folderRelativePath: folder };
}

/** A whole number of 0 or more, as a task count is. */
function isTaskCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

/** A finite number of 0 or more, as a duration or a cost is. */
function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The completion a caller reported, checked and copied field by field, because it crosses IPC or
 * the web bridge: nothing else it carries reaches the launch record. Throws
 * `MarketplaceImportError` naming the first field that is wrong.
 */
function checkedLaunchCompletion(completion: unknown): PlaybookLaunchCompletion {
	if (typeof completion !== 'object' || completion === null) {
		throw new MarketplaceImportError(
			'completion must be an object with completedTasks, totalTasks, elapsedTimeMs and wasStopped'
		);
	}
	const reported = completion as Partial<Record<keyof PlaybookLaunchCompletion, unknown>>;
	const { completedTasks, totalTasks, elapsedTimeMs, totalCostUsd, wasStopped } = reported;
	if (!isTaskCount(completedTasks)) {
		throw new MarketplaceImportError(
			'completion.completedTasks must be a whole number of 0 or more'
		);
	}
	if (!isTaskCount(totalTasks)) {
		throw new MarketplaceImportError('completion.totalTasks must be a whole number of 0 or more');
	}
	if (!isNonNegativeNumber(elapsedTimeMs)) {
		throw new MarketplaceImportError('completion.elapsedTimeMs must be a number of 0 or more');
	}
	if (totalCostUsd !== undefined && totalCostUsd !== null && !isNonNegativeNumber(totalCostUsd)) {
		throw new MarketplaceImportError(
			'completion.totalCostUsd must be a number of 0 or more, when it is given'
		);
	}
	if (typeof wasStopped !== 'boolean') {
		throw new MarketplaceImportError('completion.wasStopped must be true or false');
	}
	return {
		completedTasks,
		totalTasks,
		elapsedTimeMs,
		...(isNonNegativeNumber(totalCostUsd) && { totalCostUsd }),
		wasStopped,
	};
}

/**
 * The cleanup for a launch that has just ended, by the rules `completeMarketplaceLaunch` gives.
 * It never throws for a folder or a saved playbook it cannot remove: it reports and logs the
 * failure, and a folder it could not remove comes back as `failed` with the reason.
 */
async function cleanUpAfterLaunch(
	app: App,
	launch: PlaybookLaunchRecord
): Promise<Pick<PlaybookLaunchRecord, 'cleanup' | 'cleanupError'>> {
	if (launch.status === 'stopped') return { cleanup: 'skipped-stopped' };
	// A saved playbook names its documents inside the launch folder, so a reusable playbook keeps it.
	if (launch.spec?.cleanup === 'keep' || launch.keepSavedPlaybook) return { cleanup: 'kept' };

	try {
		await deleteLaunchFolder(
			launch.autoRunFolderPath,
			launch.folderRelativePath,
			launch.sshRemoteId
		);
	} catch (error) {
		void captureException(error, {
			operation: 'marketplace:completeLaunch',
			launchId: launch.launchId,
			folder: launch.folderRelativePath,
		});
		logger.warn(
			`Could not remove the launch folder ${launch.folderRelativePath}, so it and its saved playbook stay`,
			LOG_CONTEXT,
			{ launchId: launch.launchId, error }
		);
		return {
			cleanup: 'failed',
			cleanupError: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		await deleteSavedPlaybook(app, launch.sessionId, launch.savedPlaybookId);
	} catch (error) {
		// The documents are gone already, which is what the cleanup line reports. The saved playbook
		// left behind runs nothing, and the user can delete it from the Auto Run panel.
		void captureException(error, {
			operation: 'marketplace:completeLaunch',
			launchId: launch.launchId,
			savedPlaybookId: launch.savedPlaybookId,
		});
		logger.warn(
			`Could not remove the saved playbook ${launch.savedPlaybookId} of launch ${launch.launchId}`,
			LOG_CONTEXT,
			{ error }
		);
	}
	return { cleanup: 'done' };
}

/**
 * End a launch whose Auto Run has finished, and clean up after it. The renderer that ran the Auto
 * Run reports its end here over IPC, and `maestro-cli` can too, with the
 * `marketplace_complete_launch` WS message.
 *
 * The record ends first: `completed`, or `stopped` when the user stopped the run, with
 * `finishedAt` and the completion. That step refuses a launch that is not running, in the same
 * queued step as the write, so a second report of one run changes nothing; from then on the agent
 * is free for its next launch. Cleanup then follows the record, never the caller:
 *
 * - A stopped run keeps its folder, so it can be resumed (`skipped-stopped`).
 * - A spec with `cleanup: 'keep'`, or a playbook the user saved as reusable, keeps it too
 *   (`kept`): the saved playbook runs its documents from that folder.
 * - Otherwise `deleteLaunchFolder` removes the one folder the record names, inside the Auto Run
 *   folder and on the SSH remote the launch imported into, and then the saved playbook the import
 *   added goes (`done`).
 * - A folder that cannot be removed is reported and kept with its saved playbook (`failed`, with
 *   `cleanupError`). The launch still ends.
 *
 * Last, `onLaunchChanged` broadcasts the record, which the call also resolves. Throws
 * `MarketplaceImportError` for a missing launch id, a completion that is not well formed, an
 * unknown launch, and a launch that has already ended.
 */
export async function completeMarketplaceLaunch(
	launchId: string,
	completion: PlaybookLaunchCompletion,
	host: Pick<MarketplaceLaunchHost, 'app' | 'onLaunchChanged'>
): Promise<PlaybookLaunchRecord> {
	if (typeof launchId !== 'string' || launchId === '') {
		throw new MarketplaceImportError('launchId is required');
	}
	const ended = checkedLaunchCompletion(completion);
	const store = getPlaybookLaunchStore(host.app);

	const finish = await store.finishLaunch(launchId, {
		status: ended.wasStopped ? 'stopped' : 'completed',
		finishedAt: Date.now(),
		completion: ended,
	});
	if (!finish) throw new MarketplaceImportError(`Launch not found: ${launchId}`);
	if (!finish.finished) {
		throw new MarketplaceImportError(
			`Launch ${launchId} has already ended (${finish.record.status}), so it cannot be completed again`
		);
	}

	const cleanup = await cleanUpAfterLaunch(host.app, finish.record);
	// Only the record cap can drop a record that has ended, and what cleanup did still stands.
	const record = (await store.updateLaunch(launchId, cleanup)) ?? { ...finish.record, ...cleanup };

	logger.info(
		`Launch ${launchId} of "${record.playbookTitle}" ended ${record.status}; cleanup: ${record.cleanup}`,
		LOG_CONTEXT
	);
	host.onLaunchChanged(record);
	return record;
}

/**
 * One launch record, for the outro and `maestro-cli`. Throws `MarketplaceImportError` for a
 * missing id and for an id no launch has.
 */
export async function getMarketplaceLaunch(
	app: Pick<App, 'getPath'>,
	launchId: string
): Promise<PlaybookLaunchRecord> {
	if (typeof launchId !== 'string' || launchId === '') {
		throw new MarketplaceImportError('launchId is required');
	}
	const launch = await getPlaybookLaunchStore(app).getLaunch(launchId);
	if (!launch) throw new MarketplaceImportError(`Launch not found: ${launchId}`);
	return launch;
}

/**
 * Launch records, newest first: every launch, or those of one agent, at most `limit` of them.
 * The options cross IPC or the web bridge, so their shape is checked, and `null` (which JSON
 * sends for a value left out) means not given. Throws `MarketplaceImportError` for options that
 * are not an object, a `sessionId` that is not a string, and a `limit` that is not a positive
 * whole number.
 */
export async function listMarketplaceLaunches(
	app: Pick<App, 'getPath'>,
	options?: PlaybookLaunchListOptions | null
): Promise<PlaybookLaunchRecord[]> {
	const query: unknown = options ?? {};
	if (typeof query !== 'object' || query === null || Array.isArray(query)) {
		throw new MarketplaceImportError('options must be an object with sessionId and limit');
	}
	const given = query as Partial<Record<keyof PlaybookLaunchListOptions, unknown>>;
	const sessionId = given.sessionId ?? undefined;
	if (sessionId !== undefined && typeof sessionId !== 'string') {
		throw new MarketplaceImportError('sessionId must be a string');
	}
	const limit = (given.limit ?? undefined) as number | undefined;
	try {
		return await getPlaybookLaunchStore(app).listLaunches({ sessionId, limit });
	} catch (error) {
		// The store owns the limit rule. Its refusal is the caller's input, like the checks above.
		if (error instanceof RangeError) throw new MarketplaceImportError(error.message);
		throw error;
	}
}

/**
 * File watcher for the local manifest. Used by the IPC layer to broadcast
 * `marketplace:manifestChanged` events to the renderer.
 */
export function createLocalManifestWatcher(
	app: App,
	onChange: () => void,
	debounceMs = 500
): { stop: () => void } {
	let watcher: fsSync.FSWatcher | undefined;
	let debounceTimer: NodeJS.Timeout | undefined;
	const localManifestPath = getLocalManifestPath(app);
	try {
		watcher = fsSync.watch(localManifestPath, () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(onChange, debounceMs);
		});

		// Prevent runtime errors (e.g. Windows UNKNOWN, file removed) from
		// becoming unhandled rejections. Recoverable filesystem codes stay
		// warn-only; novel failure modes get reported to Sentry so we keep
		// production visibility.
		watcher.on('error', (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'EPERM' || code === 'UNKNOWN') {
				logger.warn(`Local manifest watcher error (${code}): ${error.message}`, LOG_CONTEXT);
				return;
			}
			void captureException(error, { operation: 'marketplace:localManifestWatcher' });
			logger.warn(`Local manifest watcher error: ${error.message}`, LOG_CONTEXT);
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn('Failed to setup local manifest watcher (non-fatal)', LOG_CONTEXT, { error });
		}
	}
	return {
		stop() {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
			if (watcher) {
				try {
					watcher.close();
				} catch (error) {
					void captureException(error);
				}
				watcher = undefined;
			}
		},
	};
}
