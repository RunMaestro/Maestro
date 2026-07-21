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
import type {
	MarketplaceManifest,
	MarketplaceCache,
	MarketplacePlaybook,
} from '../../shared/marketplace-types';
import { MarketplaceFetchError, MarketplaceImportError } from '../../shared/marketplace-types';
import { isCompatible } from '../../shared/marketplace-compatibility';
import { SshRemoteConfig } from '../../shared/types';
import { writeFileRemote, mkdirRemote } from '../utils/remote-fs';
import { captureException } from '../utils/sentry';

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/RunMaestro/Maestro-Playbooks/main';
const MANIFEST_URL = `${GITHUB_RAW_BASE}/manifest.json`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
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
			playbooks: official.playbooks.map((p) => ({ ...p, source: 'official' as const })),
		};
	}
	if (!official && local) {
		return {
			...local,
			playbooks: local.playbooks.map((p) => ({ ...p, source: 'local' as const })),
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
		localMap.set(playbook.id, { ...playbook, source: 'local' });
	}
	const mergedPlaybooks = officialPlaybooks.map((official) => {
		const localOverride = localMap.get(official.id);
		if (localOverride) {
			logger.info(`Local playbook "${official.id}" overrides official version`, LOG_CONTEXT);
			return localOverride;
		}
		return { ...official, source: 'official' as const };
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
		const response = await fetch(MANIFEST_URL);
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
		const response = await fetch(url);
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
		const response = await fetch(url);
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
	const response = await fetch(url);
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
	};
	importedDocs: string[];
	importedAssets: string[];
}

/**
 * Import a playbook to the Auto Run folder (local or remote via SSH).
 * Mirrors the IPC handler import flow exactly.
 */
export async function importMarketplacePlaybook(
	opts: ImportPlaybookOptions
): Promise<ImportPlaybookServiceResult> {
	const { app, playbookId, targetFolderName, autoRunFolderPath, sessionId, sshConfig } = opts;
	const isRemote = !!sshConfig;

	assertSafeTargetFolderName(targetFolderName);

	logger.info(
		`Importing playbook "${playbookId}" to "${targetFolderName}"${isRemote ? ' (remote via SSH)' : ''}`,
		LOG_CONTEXT
	);

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

	const targetPath = isRemote
		? autoRunFolderPath.endsWith('/')
			? `${autoRunFolderPath}${targetFolderName}`
			: `${autoRunFolderPath}/${targetFolderName}`
		: path.join(autoRunFolderPath, targetFolderName);

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
			const content = await fetchDocument(marketplacePlaybook.path, doc.filename);
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
		prompt: marketplacePlaybook.prompt ?? '',
	};

	const playbooksDir = path.join(app.getPath('userData'), 'playbooks');
	await fs.mkdir(playbooksDir, { recursive: true });
	const playbooksFilePath = path.join(playbooksDir, `${sessionId}.json`);
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
