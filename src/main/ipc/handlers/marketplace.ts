/**
 * Marketplace IPC Handlers
 *
 * Provides handlers for fetching, caching, and importing playbooks from
 * the Maestro Playbooks marketplace (GitHub repository).
 *
 * Cache Strategy:
 * - Manifest is cached locally with 6-hour TTL
 * - Individual documents are fetched on-demand (not cached)
 * - Force refresh bypasses cache and fetches fresh data
 */

import { ipcMain, App } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import type {
  MarketplaceManifest,
  MarketplaceCache,
  MarketplacePlaybook,
} from '../../../shared/marketplace-types';
import {
  MarketplaceFetchError,
  MarketplaceImportError,
} from '../../../shared/marketplace-types';
import { SshRemoteConfig } from '../../../shared/types';
import { writeFileRemote, mkdirRemote } from '../../utils/remote-fs';
import type { MaestroSettings } from './persistence';

// ============================================================================
// Constants
// ============================================================================

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/pedramamini/Maestro-Playbooks/main';
const MANIFEST_URL = `${GITHUB_RAW_BASE}/manifest.json`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LOG_CONTEXT = '[Marketplace]';

// ============================================================================
// Dependencies Interface
// ============================================================================

export interface MarketplaceHandlerDependencies {
  app: App;
  /** Settings store for SSH remote configuration lookup */
  settingsStore?: Store<MaestroSettings>;
}

// Module-level reference to settings store (set during registration)
let marketplaceSettingsStore: Store<MaestroSettings> | undefined;

// File watcher for local manifest
let localManifestWatcher: fsSync.FSWatcher | undefined;

// Debounce timer for file changes
let watcherDebounceTimer: NodeJS.Timeout | undefined;

const WATCHER_DEBOUNCE_MS = 500;

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found or store not provided.
 */
function getSshRemoteById(sshRemoteId: string): SshRemoteConfig | undefined {
  if (!marketplaceSettingsStore) {
    logger.warn(`${LOG_CONTEXT} Settings store not available for SSH remote lookup`, LOG_CONTEXT);
    return undefined;
  }
  const sshRemotes = marketplaceSettingsStore.get('sshRemotes', []) as SshRemoteConfig[];
  return sshRemotes.find((r) => r.id === sshRemoteId && r.enabled);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the path to the marketplace cache file.
 */
function getCacheFilePath(app: App): string {
  return path.join(app.getPath('userData'), 'marketplace-cache.json');
}

/**
 * Get the path to the local manifest file.
 * Local manifest allows users to define custom/private playbooks that extend
 * or override the official marketplace catalog.
 */
function getLocalManifestPath(app: App): string {
  return path.join(app.getPath('userData'), 'local-manifest.json');
}

/**
 * Check if a path is a local filesystem path (absolute or tilde-prefixed).
 * Returns true for paths like:
 * - /absolute/path
 * - ~/home/path
 * - C:\Windows\path (on Windows)
 * Returns false for GitHub repository paths.
 */
function isLocalPath(pathStr: string): boolean {
  // Check for absolute paths
  if (path.isAbsolute(pathStr)) {
    return true;
  }
  // Check for tilde-prefixed paths
  if (pathStr.startsWith('~/') || pathStr.startsWith('~\\')) {
    return true;
  }
  return false;
}

/**
 * Read the local manifest from disk.
 * Returns null if the file doesn't exist or is invalid.
 * Logs warnings for invalid JSON but doesn't throw - graceful degradation.
 */
async function readLocalManifest(app: App): Promise<MarketplaceManifest | null> {
  const localManifestPath = getLocalManifestPath(app);

  try {
    const content = await fs.readFile(localManifestPath, 'utf-8');
    const data = JSON.parse(content);

    // Validate local manifest structure
    if (!data.playbooks || !Array.isArray(data.playbooks)) {
      logger.warn('Invalid local manifest structure: missing playbooks array', LOG_CONTEXT);
      return null;
    }

    logger.info(`Loaded local manifest with ${data.playbooks.length} playbook(s)`, LOG_CONTEXT);
    return data as MarketplaceManifest;
  } catch (error) {
    // File doesn't exist - this is normal, treat as empty
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug('No local manifest found (this is normal)', LOG_CONTEXT);
      return null;
    }

    // Invalid JSON or other error - log warning but don't crash
    logger.warn('Failed to read local manifest, ignoring', LOG_CONTEXT, { error });
    return null;
  }
}

/**
 * Merge official and local manifests.
 *
 * Merge semantics:
 * - Playbooks are merged by `id` field
 * - Local playbooks with same `id` override official ones
 * - Local-only `id`s are appended to the catalog
 * - All playbooks are tagged with `source` field for UI distinction
 *
 * @param official Official manifest from GitHub (may be null)
 * @param local Local manifest from filesystem (may be null)
 * @returns Merged manifest with source tags
 */
function mergeManifests(
  official: MarketplaceManifest | null,
  local: MarketplaceManifest | null
): MarketplaceManifest {
  // If no manifests at all, return empty
  if (!official && !local) {
    return {
      lastUpdated: new Date().toISOString().split('T')[0],
      playbooks: [],
    };
  }

  // If only official exists, tag all as official
  if (official && !local) {
    return {
      ...official,
      playbooks: official.playbooks.map((p) => ({ ...p, source: 'official' as const })),
    };
  }

  // If only local exists, tag all as local
  if (!official && local) {
    return {
      ...local,
      playbooks: local.playbooks.map((p) => ({ ...p, source: 'local' as const })),
    };
  }

  // Both exist - merge by ID
  const officialPlaybooks = official!.playbooks;
  const localPlaybooks = local!.playbooks;

  // Create map of local playbooks by ID for fast lookup
  const localMap = new Map<string, MarketplacePlaybook>();
  for (const playbook of localPlaybooks) {
    if (!playbook.id) {
      logger.warn('Local playbook missing required "id" field, skipping', LOG_CONTEXT, {
        title: playbook.title,
      });
      continue;
    }
    // Validate required fields
    if (!playbook.title || !playbook.path || !playbook.documents) {
      logger.warn(`Local playbook "${playbook.id}" missing required fields, skipping`, LOG_CONTEXT);
      continue;
    }
    localMap.set(playbook.id, { ...playbook, source: 'local' });
  }

  // Override official playbooks with local matches, tag official ones
  const mergedPlaybooks = officialPlaybooks.map((official) => {
    const localOverride = localMap.get(official.id);
    if (localOverride) {
      logger.info(`Local playbook "${official.id}" overrides official version`, LOG_CONTEXT);
      return localOverride;
    }
    return { ...official, source: 'official' as const };
  });

  // Find local-only playbooks (not in official catalog)
  const officialIds = new Set(officialPlaybooks.map((p) => p.id));
  const localOnlyPlaybooks = Array.from(localMap.values()).filter(
    (local) => !officialIds.has(local.id)
  );

  // Append local-only playbooks
  const finalPlaybooks = [...mergedPlaybooks, ...localOnlyPlaybooks];

  logger.info(
    `Merged manifest: ${officialPlaybooks.length} official, ${localPlaybooks.length} local, ${finalPlaybooks.length} total`,
    LOG_CONTEXT
  );

  return {
    lastUpdated: official?.lastUpdated || local?.lastUpdated || new Date().toISOString().split('T')[0],
    playbooks: finalPlaybooks,
  };
}

/**
 * Read the marketplace cache from disk.
 * Returns null if cache doesn't exist or is invalid.
 */
async function readCache(app: App): Promise<MarketplaceCache | null> {
  const cachePath = getCacheFilePath(app);

  try {
    const content = await fs.readFile(cachePath, 'utf-8');
    const data = JSON.parse(content);

    // Validate cache structure
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
    // File doesn't exist or is invalid JSON
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('Cache read error (non-ENOENT)', LOG_CONTEXT, { error });
    }
    return null;
  }
}

/**
 * Write the marketplace cache to disk.
 */
async function writeCache(app: App, manifest: MarketplaceManifest): Promise<void> {
  const cachePath = getCacheFilePath(app);

  try {
    const cache: MarketplaceCache = {
      fetchedAt: Date.now(),
      manifest,
    };

    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    logger.debug('Cache written successfully', LOG_CONTEXT);
  } catch (error) {
    logger.warn('Failed to write cache', LOG_CONTEXT, { error });
    // Don't throw - cache write failure shouldn't fail the operation
  }
}

/**
 * Check if the cache is still valid (within TTL).
 */
function isCacheValid(cache: MarketplaceCache): boolean {
  const age = Date.now() - cache.fetchedAt;
  return age < CACHE_TTL_MS;
}

/**
 * Fetch the manifest from GitHub.
 */
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

    // Validate manifest structure
    if (!data.playbooks || !Array.isArray(data.playbooks)) {
      throw new MarketplaceFetchError('Invalid manifest structure: missing playbooks array');
    }

    logger.info(`Fetched manifest with ${data.playbooks.length} playbooks`, LOG_CONTEXT);
    return data as unknown as MarketplaceManifest;
  } catch (error) {
    if (error instanceof MarketplaceFetchError) {
      throw error;
    }
    throw new MarketplaceFetchError(
      `Network error fetching manifest: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Resolve tilde (~) to user's home directory.
 */
function resolveTildePath(pathStr: string): string {
  if (pathStr.startsWith('~/') || pathStr.startsWith('~\\')) {
    const homedir = require('os').homedir();
    return path.join(homedir, pathStr.slice(2));
  }
  return pathStr;
}

/**
 * Fetch a document from GitHub or local filesystem.
 * If playbookPath is a local filesystem path, reads from disk.
 * Otherwise, fetches from GitHub.
 */
async function fetchDocument(playbookPath: string, filename: string): Promise<string> {
  // Check if this is a local path
  if (isLocalPath(playbookPath)) {
    const resolvedPath = resolveTildePath(playbookPath);
    const docPath = path.join(resolvedPath, `${filename}.md`);
    logger.debug(`Reading local document: ${docPath}`, LOG_CONTEXT);

    try {
      const content = await fs.readFile(docPath, 'utf-8');
      return content;
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

  // GitHub path - fetch from remote
  const url = `${GITHUB_RAW_BASE}/${playbookPath}/${filename}.md`;
  logger.debug(`Fetching document from GitHub: ${url}`, LOG_CONTEXT);

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
    if (error instanceof MarketplaceFetchError) {
      throw error;
    }
    throw new MarketplaceFetchError(
      `Network error fetching document: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Fetch an asset file from GitHub or local filesystem (from assets/ subfolder).
 * Returns the raw content as a Buffer for binary-safe handling.
 */
async function fetchAsset(playbookPath: string, assetFilename: string): Promise<Buffer> {
  // Check if this is a local path
  if (isLocalPath(playbookPath)) {
    const resolvedPath = resolveTildePath(playbookPath);
    const assetPath = path.join(resolvedPath, 'assets', assetFilename);
    logger.debug(`Reading local asset: ${assetPath}`, LOG_CONTEXT);

    try {
      const content = await fs.readFile(assetPath);
      return content;
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

  // GitHub path - fetch from remote
  const url = `${GITHUB_RAW_BASE}/${playbookPath}/assets/${assetFilename}`;
  logger.debug(`Fetching asset from GitHub: ${url}`, LOG_CONTEXT);

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

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof MarketplaceFetchError) {
      throw error;
    }
    throw new MarketplaceFetchError(
      `Network error fetching asset: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Fetch README from GitHub or local filesystem.
 */
async function fetchReadme(playbookPath: string): Promise<string | null> {
  // Check if this is a local path
  if (isLocalPath(playbookPath)) {
    const resolvedPath = resolveTildePath(playbookPath);
    const readmePath = path.join(resolvedPath, 'README.md');
    logger.debug(`Reading local README: ${readmePath}`, LOG_CONTEXT);

    try {
      const content = await fs.readFile(readmePath, 'utf-8');
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // README is optional
      }
      // Other errors are non-fatal for README
      logger.debug(`Local README read failed (non-fatal): ${error}`, LOG_CONTEXT);
      return null;
    }
  }

  // GitHub path - fetch from remote
  const url = `${GITHUB_RAW_BASE}/${playbookPath}/README.md`;
  logger.debug(`Fetching README from GitHub: ${url}`, LOG_CONTEXT);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        return null; // README is optional
      }
      throw new MarketplaceFetchError(
        `Failed to fetch README: ${response.status} ${response.statusText}`
      );
    }

    return await response.text();
  } catch (error) {
    if (error instanceof MarketplaceFetchError) {
      throw error;
    }
    // README fetch failures are non-fatal, return null
    logger.debug(`README fetch failed (non-fatal): ${error}`, LOG_CONTEXT);
    return null;
  }
}

/**
 * Setup file watcher for local manifest changes.
 * Enables hot reload during development - changes to local-manifest.json
 * trigger a manifest refresh event.
 */
function setupLocalManifestWatcher(app: App): void {
  const localManifestPath = getLocalManifestPath(app);

  try {
    // Clean up existing watcher if any
    if (localManifestWatcher) {
      localManifestWatcher.close();
      localManifestWatcher = undefined;
    }

    // Create new watcher
    localManifestWatcher = fsSync.watch(
      localManifestPath,
      (eventType: string) => {
        logger.debug(`Local manifest file changed (${eventType}), debouncing refresh...`, LOG_CONTEXT);

        // Clear existing timer
        if (watcherDebounceTimer) {
          clearTimeout(watcherDebounceTimer);
        }

        // Debounce file changes (wait for rapid saves to settle)
        watcherDebounceTimer = setTimeout(async () => {
          logger.info('Local manifest changed, broadcasting refresh event', LOG_CONTEXT);

          // Send IPC event to all renderer windows
          const { BrowserWindow } = require('electron');
          const allWindows = BrowserWindow.getAllWindows();
          for (const win of allWindows) {
            win.webContents.send('marketplace:manifestChanged');
          }
        }, WATCHER_DEBOUNCE_MS);
      }
    );

    logger.debug('Local manifest file watcher initialized', LOG_CONTEXT);
  } catch (error) {
    // File might not exist yet - this is normal
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to setup local manifest watcher (non-fatal)', LOG_CONTEXT, { error });
    }
    // Don't throw - watcher failure shouldn't prevent normal operation
  }
}

/**
 * Cleanup file watcher on app shutdown.
 */
function cleanupLocalManifestWatcher(): void {
  if (watcherDebounceTimer) {
    clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = undefined;
  }

  if (localManifestWatcher) {
    try {
      localManifestWatcher.close();
      logger.debug('Local manifest watcher cleaned up', LOG_CONTEXT);
    } catch (error) {
      logger.warn('Error closing local manifest watcher', LOG_CONTEXT, { error });
    }
    localManifestWatcher = undefined;
  }
}

/**
 * Helper to create handler options with consistent context.
 */
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess,
});

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all Marketplace-related IPC handlers.
 */
export function registerMarketplaceHandlers(deps: MarketplaceHandlerDependencies): void {
  const { app, settingsStore } = deps;

  // Store settings reference for SSH remote lookups
  marketplaceSettingsStore = settingsStore;

  // Setup hot reload watcher for local manifest
  setupLocalManifestWatcher(app);

  // Cleanup watcher on app quit
  app.on('will-quit', () => {
    cleanupLocalManifestWatcher();
  });

  // -------------------------------------------------------------------------
  // marketplace:getManifest - Get manifest (from cache if valid, else fetch)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'marketplace:getManifest',
    createIpcHandler(handlerOpts('getManifest'), async () => {
      // Try to read from cache first
      const cache = await readCache(app);
      let officialManifest: MarketplaceManifest | null = null;
      let fromCache = false;
      let cacheAge: number | undefined;

      if (cache && isCacheValid(cache)) {
        cacheAge = Date.now() - cache.fetchedAt;
        logger.debug(`Serving official manifest from cache (age: ${Math.round(cacheAge / 1000)}s)`, LOG_CONTEXT);
        officialManifest = cache.manifest;
        fromCache = true;
      } else {
        // Cache miss or expired - fetch fresh data
        try {
          officialManifest = await fetchManifest();
          await writeCache(app, officialManifest);
        } catch (error) {
          logger.warn('Failed to fetch official manifest, continuing with local only', LOG_CONTEXT, { error });
          // Continue - we might still have local playbooks
        }
      }

      // Read local manifest (always, not cached)
      const localManifest = await readLocalManifest(app);
      logger.info(`Local manifest loaded: ${localManifest ? localManifest.playbooks.length : 0} playbooks`, LOG_CONTEXT);

      // Merge manifests
      const mergedManifest = mergeManifests(officialManifest, localManifest);
      logger.info(`Merged manifest: ${mergedManifest.playbooks.length} total playbooks`, LOG_CONTEXT);

      return {
        manifest: mergedManifest,
        fromCache,
        cacheAge,
      };
    })
  );

  // -------------------------------------------------------------------------
  // marketplace:refreshManifest - Force refresh (bypass cache)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'marketplace:refreshManifest',
    createIpcHandler(handlerOpts('refreshManifest'), async () => {
      logger.info('Force refreshing manifest (bypass cache)', LOG_CONTEXT);

      let officialManifest: MarketplaceManifest | null = null;
      try {
        officialManifest = await fetchManifest();
        await writeCache(app, officialManifest);
      } catch (error) {
        logger.warn('Failed to fetch official manifest during refresh, continuing with local only', LOG_CONTEXT, { error });
      }

      // Read local manifest (always fresh, not cached)
      const localManifest = await readLocalManifest(app);

      // Merge manifests
      const mergedManifest = mergeManifests(officialManifest, localManifest);

      return {
        manifest: mergedManifest,
        fromCache: false,
      };
    })
  );

  // -------------------------------------------------------------------------
  // marketplace:getDocument - Fetch a single document
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'marketplace:getDocument',
    createIpcHandler(
      handlerOpts('getDocument'),
      async (playbookPath: string, filename: string) => {
        const content = await fetchDocument(playbookPath, filename);
        return { content };
      }
    )
  );

  // -------------------------------------------------------------------------
  // marketplace:getReadme - Fetch README for a playbook
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'marketplace:getReadme',
    createIpcHandler(
      handlerOpts('getReadme'),
      async (playbookPath: string) => {
        const content = await fetchReadme(playbookPath);
        return { content };
      }
    )
  );

  // -------------------------------------------------------------------------
  // marketplace:importPlaybook - Import a playbook to Auto Run folder (local or remote via SSH)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'marketplace:importPlaybook',
    createIpcHandler(
      handlerOpts('importPlaybook'),
      async (
        playbookId: string,
        targetFolderName: string,
        autoRunFolderPath: string,
        sessionId: string,
        sshRemoteId?: string
      ) => {
        // Get SSH config if provided
        const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
        const isRemote = !!sshConfig;

        logger.info(
          `Importing playbook "${playbookId}" to "${targetFolderName}"${isRemote ? ' (remote via SSH)' : ''}`,
          LOG_CONTEXT
        );

        // Get the manifest to find the playbook
        const cache = await readCache(app);
        let manifest: MarketplaceManifest;

        if (cache && isCacheValid(cache)) {
          manifest = cache.manifest;
        } else {
          manifest = await fetchManifest();
          await writeCache(app, manifest);
        }

        // Find the playbook
        const marketplacePlaybook = manifest.playbooks.find((p) => p.id === playbookId);
        if (!marketplacePlaybook) {
          throw new MarketplaceImportError(`Playbook not found: ${playbookId}`);
        }

        // Create target folder path (use POSIX paths for remote, native for local)
        const targetPath = isRemote
          ? (autoRunFolderPath.endsWith('/') ? `${autoRunFolderPath}${targetFolderName}` : `${autoRunFolderPath}/${targetFolderName}`)
          : path.join(autoRunFolderPath, targetFolderName);

        // Create target directory (SSH-aware)
        if (isRemote) {
          const mkdirResult = await mkdirRemote(targetPath, sshConfig!, true);
          if (!mkdirResult.success) {
            throw new MarketplaceImportError(`Failed to create remote directory: ${mkdirResult.error}`);
          }
        } else {
          await fs.mkdir(targetPath, { recursive: true });
        }

        // Fetch and write all documents (SSH-aware)
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
            logger.debug(`Imported document: ${doc.filename}${isRemote ? ' (remote)' : ''}`, LOG_CONTEXT);
          } catch (error) {
            logger.warn(`Failed to import document ${doc.filename}`, LOG_CONTEXT, { error });
            // Continue importing other documents
          }
        }

        // Fetch and write all assets from assets/ subfolder (if any)
        const importedAssets: string[] = [];
        if (marketplacePlaybook.assets && marketplacePlaybook.assets.length > 0) {
          // Create assets subdirectory
          const assetsPath = isRemote
            ? `${targetPath}/assets`
            : path.join(targetPath, 'assets');

          if (isRemote) {
            const mkdirResult = await mkdirRemote(assetsPath, sshConfig!, true);
            if (!mkdirResult.success) {
              logger.warn(`Failed to create remote assets directory: ${mkdirResult.error}`, LOG_CONTEXT);
            }
          } else {
            await fs.mkdir(assetsPath, { recursive: true });
          }

          for (const assetFilename of marketplacePlaybook.assets) {
            try {
              const content = await fetchAsset(marketplacePlaybook.path, assetFilename);
              const assetPath = isRemote
                ? `${assetsPath}/${assetFilename}`
                : path.join(assetsPath, assetFilename);

              if (isRemote) {
                // Pass buffer directly - writeFileRemote handles binary content via base64
                const writeResult = await writeFileRemote(assetPath, content, sshConfig!);
                if (!writeResult.success) {
                  throw new Error(writeResult.error || 'Failed to write remote asset file');
                }
              } else {
                await fs.writeFile(assetPath, content);
              }

              importedAssets.push(assetFilename);
              logger.debug(`Imported asset: ${assetFilename}${isRemote ? ' (remote)' : ''}`, LOG_CONTEXT);
            } catch (error) {
              logger.warn(`Failed to import asset ${assetFilename}`, LOG_CONTEXT, { error });
              // Continue importing other assets
            }
          }
        }

        // Create the playbook entry for local storage
        // Prefix document filenames with the target folder path so they can be found
        // when the playbook is loaded (allDocuments contains relative paths from root)
        const now = Date.now();
        const newPlaybook = {
          id: crypto.randomUUID(),
          name: marketplacePlaybook.title,
          createdAt: now,
          updatedAt: now,
          documents: marketplacePlaybook.documents.map((d) => ({
            // Include target folder in the path (e.g., "development/security-audit/1_ANALYZE")
            filename: targetFolderName ? `${targetFolderName}/${d.filename}` : d.filename,
            resetOnCompletion: d.resetOnCompletion,
          })),
          loopEnabled: marketplacePlaybook.loopEnabled,
          maxLoops: marketplacePlaybook.maxLoops,
          // Use empty string if prompt is null - BatchRunnerModal and batch processor
          // will fall back to DEFAULT_BATCH_PROMPT when prompt is empty
          prompt: marketplacePlaybook.prompt ?? '',
        };

        // Save the playbook to the session's playbooks storage
        const playbooksDir = path.join(app.getPath('userData'), 'playbooks');
        await fs.mkdir(playbooksDir, { recursive: true });

        const playbooksFilePath = path.join(playbooksDir, `${sessionId}.json`);
        let playbooks: any[] = [];

        try {
          const content = await fs.readFile(playbooksFilePath, 'utf-8');
          const data = JSON.parse(content);
          playbooks = Array.isArray(data.playbooks) ? data.playbooks : [];
        } catch {
          // File doesn't exist or is invalid, start fresh
        }

        playbooks.push(newPlaybook);
        await fs.writeFile(playbooksFilePath, JSON.stringify({ playbooks }, null, 2), 'utf-8');

        logger.info(
          `Successfully imported playbook "${marketplacePlaybook.title}" with ${importedDocs.length} documents and ${importedAssets.length} assets`,
          LOG_CONTEXT
        );

        return {
          playbook: newPlaybook,
          importedDocs,
          importedAssets,
        };
      }
    )
  );

  logger.debug(`${LOG_CONTEXT} Marketplace IPC handlers registered`);
}
