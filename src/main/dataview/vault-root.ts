/**
 * Vault root resolution for Dataview (DV-4).
 *
 * The vault root of a file is the nearest ancestor folder (the file's own
 * folder included) that contains a `.obsidian/` directory. A file outside any
 * vault resolves to the owning agent's working directory.
 *
 * Results are cached per directory for the process lifetime. The cache holds
 * the found root, or `null` for "no vault above this folder", so the cwd
 * fallback stays per call: two agents can share a folder and still fall back
 * to their own cwd. A watcher that sees a `.obsidian` folder appear or vanish
 * calls `invalidateVaultRootCache()` with that folder's path.
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { findAncestorWithDirRemote } from '../utils/remote-fs';
import { getSshRemoteById } from '../stores/getters';
import { isPathAtOrUnderRoot, normalizeWorktreePath } from '../../shared/worktreePaths';
import { sshUnresolvedRemoteMessage } from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';

/** The folder whose presence marks an Obsidian vault root. */
export const VAULT_MARKER_DIR = '.obsidian';

export interface ResolveVaultRootOptions {
	/** The owning agent's working directory: the root when no vault is found. */
	agentCwd: string;
	/** Set when the file lives on an SSH remote. */
	sshRemoteId?: string | null;
}

type PathApi = Pick<typeof path, 'dirname'>;

/** Errors that mean "no marker here" rather than a broken filesystem. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

/** `<remote id or empty>\0<directory>` to the found root, or null. */
const rootCache = new Map<string, string | null>();
/** Concurrent lookups for one directory share one walk. */
const inFlight = new Map<string, Promise<string | null>>();
/** Bumped on every invalidation so a walk that started earlier cannot cache a stale answer. */
let cacheGeneration = 0;

function cacheKey(dir: string, sshRemoteId: string | null | undefined): string {
	return `${sshRemoteId ?? ''}\0${dir}`;
}

/**
 * Every directory from `dir` up to and including the filesystem root, nearest
 * first. `pathApi` selects the platform rules (`path.win32` stops at `C:\`,
 * `path.posix` at `/`).
 */
export function ancestorDirs(dir: string, pathApi: PathApi = path): string[] {
	const dirs: string[] = [];
	let current = dir;
	for (;;) {
		dirs.push(current);
		const parent = pathApi.dirname(current);
		if (parent === current) return dirs;
		current = parent;
	}
}

async function hasLocalMarker(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(path.join(dir, VAULT_MARKER_DIR))).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code && ABSENT_CODES.has(code)) return false;
		throw error;
	}
}

/** Cache `root` for every visited directory, unless an invalidation landed mid-walk. */
function remember(
	dirs: string[],
	root: string | null,
	sshRemoteId: string | null | undefined,
	generation: number
): void {
	if (generation !== cacheGeneration) return;
	for (const dir of dirs) rootCache.set(cacheKey(dir, sshRemoteId), root);
}

async function findLocalRoot(startDir: string): Promise<string | null> {
	const generation = cacheGeneration;
	const visited: string[] = [];
	for (const dir of ancestorDirs(startDir)) {
		const cached = rootCache.get(cacheKey(dir, null));
		if (cached !== undefined) {
			remember(visited, cached, null, generation);
			return cached;
		}
		visited.push(dir);
		if (await hasLocalMarker(dir)) {
			remember(visited, dir, null, generation);
			return dir;
		}
	}
	remember(visited, null, null, generation);
	return null;
}

async function findRemoteRoot(startDir: string, sshRemoteId: string): Promise<string | null> {
	const generation = cacheGeneration;
	const sshRemote = getSshRemoteById(sshRemoteId);
	if (!sshRemote) {
		throw new Error(sshUnresolvedRemoteMessage({ enabled: true, remoteId: sshRemoteId }));
	}
	const result = await findAncestorWithDirRemote(startDir, VAULT_MARKER_DIR, sshRemote);
	if (!result.success) {
		throw new Error(result.error ?? `Failed to resolve the vault root of ${startDir}`);
	}
	const root = result.data ?? null;
	// Every directory between the start and the root shares the answer. When
	// the remote shell rewrote the path (a `~` it expanded), the root is not
	// in the textual chain, so only the start directory is safe to cache.
	const chain = ancestorDirs(startDir, path.posix);
	const rootIndex = root === null ? chain.length - 1 : chain.indexOf(root);
	remember(
		rootIndex === -1 ? [startDir] : chain.slice(0, rootIndex + 1),
		root,
		sshRemoteId,
		generation
	);
	return root;
}

/**
 * Resolve the vault root for `filePath` (DV-4): the nearest ancestor holding
 * `.obsidian/`, otherwise `agentCwd`. Over SSH the whole walk is one remote
 * command. Throws when `sshRemoteId` names no configured remote, or when the
 * remote lookup fails: it never falls back to the local filesystem.
 */
export async function resolveVaultRoot(
	filePath: string,
	{ agentCwd, sshRemoteId }: ResolveVaultRootOptions
): Promise<string> {
	const startDir = sshRemoteId
		? path.posix.dirname(path.posix.normalize(filePath))
		: path.dirname(path.resolve(filePath));
	const key = cacheKey(startDir, sshRemoteId);

	const cached = rootCache.get(key);
	if (cached !== undefined) return cached ?? agentCwd;

	let pending = inFlight.get(key);
	if (!pending) {
		const walk = (
			sshRemoteId ? findRemoteRoot(startDir, sshRemoteId) : findLocalRoot(startDir)
		).finally(() => {
			// An invalidation may have replaced this entry with a newer walk.
			if (inFlight.get(key) === walk) inFlight.delete(key);
		});
		pending = walk;
		inFlight.set(key, walk);
	}
	return (await pending) ?? agentCwd;
}

/**
 * Drop cached roots after a watcher event on `changedPath`. Only a path whose
 * last segment is `.obsidian` matters: its parent may have just become, or
 * stopped being, a vault root, so every cached directory at or under that
 * parent is forgotten. Returns whether anything was invalidated.
 */
export function invalidateVaultRootCache(
	changedPath: string,
	sshRemoteId?: string | null
): boolean {
	const pathApi = sshRemoteId ? path.posix : path;
	if (pathApi.basename(changedPath) !== VAULT_MARKER_DIR) return false;

	const posix = Boolean(sshRemoteId);
	const parent = normalizeWorktreePath(pathApi.dirname(changedPath), posix);
	const prefix = `${sshRemoteId ?? ''}\0`;
	cacheGeneration++;
	inFlight.clear();
	let removed = false;
	for (const key of [...rootCache.keys()]) {
		if (!key.startsWith(prefix)) continue;
		const dir = normalizeWorktreePath(key.slice(prefix.length), posix);
		if (isPathAtOrUnderRoot(dir, parent)) {
			rootCache.delete(key);
			removed = true;
		}
	}
	return removed;
}

/** Test-only: forget every cached root. */
export function __resetVaultRootCacheForTest(): void {
	rootCache.clear();
	inFlight.clear();
	cacheGeneration++;
}
