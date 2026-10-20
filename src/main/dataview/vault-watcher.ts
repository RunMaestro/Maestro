/**
 * The file watcher behind a LOCAL Dataview index (DV-5, DV-7). chokidar watches the whole root and every
 * burst of events is debounced into ONE batch of vault-relative paths, which `VaultIndex` then stats and
 * applies together. A remote root has no watcher: chokidar cannot watch over SSH, so the index polls.
 *
 * Configuration follows the repo's chokidar watchers (`src/main/cue/cue-file-watcher.ts`, the Document
 * Graph watcher): `ignoreInitial`, a root-relative ignore rule (chokidar 3 tests `ignored` against the
 * ABSOLUTE path, so an absolute dotfile regex would also match the root's own ancestors), and events whose
 * path falls outside the root are dropped.
 */

import * as path from 'path';
import * as chokidar from 'chokidar';
import { VAULT_BOOKMARKS_PATH, VAULT_MAX_DEPTH, isIndexedVaultPath } from './vault-fs';
import { VAULT_MARKER_DIR, invalidateVaultRootCache } from './vault-root';

/** Quiet time that closes a burst of watcher events into one batch. */
export const DATAVIEW_WATCH_DEBOUNCE_MS = 250;

export interface VaultWatcherOptions {
	root: string;
	/** One call per burst, with every vault-relative POSIX path that changed in it. */
	onChange: (relPaths: string[]) => void;
	onError?: (error: unknown) => void;
}

export interface VaultWatcher {
	/** Resolves once chokidar has finished its initial walk; earlier changes may be missed. */
	readonly ready: Promise<void>;
	close(): Promise<void>;
}

/**
 * `absPath` as a vault-relative POSIX path, `''` for the root, or null when it is outside the root. A remote
 * root passes `path.posix`, since the remote host's paths are POSIX whatever this machine runs.
 */
export function toVaultRelativePath(
	root: string,
	absPath: string,
	pathApi: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path
): string | null {
	const rel = pathApi.relative(root, absPath);
	if (rel === '') return '';
	if (rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return null;
	return rel.split(pathApi.sep).join('/');
}

/**
 * Whether the watcher reports `relPath`: every path the index covers, plus the two inside dot folders that
 * still matter. A `.obsidian` folder itself (never its contents) marks a vault root appearing or vanishing,
 * and the root's `.obsidian/bookmarks.json` backs `file.starred`.
 */
export function isWatchedVaultPath(relPath: string): boolean {
	if (relPath === '' || isIndexedVaultPath(relPath) || relPath === VAULT_BOOKMARKS_PATH)
		return true;
	const slash = relPath.lastIndexOf('/');
	const parent = slash < 0 ? '' : relPath.slice(0, slash);
	return (
		relPath.slice(slash + 1) === VAULT_MARKER_DIR && (parent === '' || isIndexedVaultPath(parent))
	);
}

/** The chokidar `ignored` function for a vault root. */
export function vaultWatchIgnored(root: string): (absPath: string) => boolean {
	return (absPath) => {
		const rel = toVaultRelativePath(root, absPath);
		return rel === null || !isWatchedVaultPath(rel);
	};
}

const WATCHED_EVENTS = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const;

/** Watch a local vault root. */
export function createVaultWatcher({ root, onChange, onError }: VaultWatcherOptions): VaultWatcher {
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = () => {
		timer = null;
		const relPaths = [...pending];
		pending.clear();
		if (relPaths.length > 0) onChange(relPaths);
	};

	const watcher = chokidar.watch(root, {
		ignored: vaultWatchIgnored(root),
		ignoreInitial: true,
		persistent: true,
		depth: VAULT_MAX_DEPTH,
	});

	for (const event of WATCHED_EVENTS) {
		watcher.on(event, (absPath: string) => {
			const rel = toVaultRelativePath(root, absPath);
			if (!rel) return;
			// A vault root appeared or vanished at the folder above, so resolveVaultRoot() answers change.
			if (
				(event === 'addDir' || event === 'unlinkDir') &&
				path.basename(absPath) === VAULT_MARKER_DIR
			) {
				invalidateVaultRootCache(absPath);
			}
			pending.add(rel);
			if (timer) clearTimeout(timer);
			timer = setTimeout(flush, DATAVIEW_WATCH_DEBOUNCE_MS);
		});
	}
	watcher.on('error', (error: unknown) => onError?.(error));

	const ready = new Promise<void>((resolve) => {
		watcher.once('ready', () => resolve());
	});

	return {
		ready,
		async close() {
			if (timer) clearTimeout(timer);
			timer = null;
			pending.clear();
			await watcher.close();
		},
	};
}
