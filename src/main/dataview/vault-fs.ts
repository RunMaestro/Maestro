/**
 * File access for one Dataview vault root (DV-5, DV-6): a local folder through `fs`, or a folder on an SSH
 * remote through `remote-fs.ts`, behind one interface so `VaultIndex` never branches on where the vault is.
 *
 * Paths handed out and taken in are vault-relative POSIX paths (`People/Pedram Amini.md`). What gets
 * indexed follows Obsidian: dot-prefixed files and folders are skipped (`.obsidian/`, `.trash/`, `.git/`,
 * and `.maestro/` included; see the guide's "Semantics traps"), and so are `node_modules/` and the Windows
 * system files the watchers already skip.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SshRemoteConfig } from '../../shared/types';
import { isMarkdownPagePath } from '../../shared/dataview';
import { walkLocalFileTree, type LocalTreeNode } from '../utils/file-tree-walk';
import { listFilesWithStatsRemote, readFileInRootRemote, readFileRemote } from '../utils/remote-fs';
import { resolvePathInRealRoot } from '../utils/real-path-containment';
import { WINDOWS_LOCKED_SYSTEM_FILES } from '../utils/watcher-ignore';
import { LOCAL_SESSION_READ_CONCURRENCY } from '../utils/concurrency';
import { mapWithConcurrency } from '../../shared/concurrency';

/**
 * Names pruned from every vault walk, local and remote. `.*` covers `.obsidian`, `.trash`, `.git`, and
 * every other dot folder; `node_modules` is named because a vault with a JS project inside it would
 * otherwise drown the scan.
 */
export const VAULT_PRUNED_NAMES = ['.*', 'node_modules'] as const;

/** Obsidian's Bookmarks core plugin file, the source of `file.starred`: the one dot-folder file read. */
export const VAULT_BOOKMARKS_PATH = '.obsidian/bookmarks.json';

/** Deepest folder level a local walk (and the local watcher) descends to. */
export const VAULT_MAX_DEPTH = 64;

/** The stat of one markdown file, in milliseconds and bytes. */
export interface VaultFileStat {
	size: number;
	mtime: number;
	/** Creation time: `birthtime`, falling back to the change time when the filesystem has none. */
	ctime: number;
}

/** What a single path is now: a file with its stat, or a folder. */
export type VaultEntryStat = ({ kind: 'file' } & VaultFileStat) | { kind: 'folder' };

/** Everything a full scan needs from the file system. */
export interface VaultListing {
	/** Every indexed file, any extension. */
	files: string[];
	/** Every indexed folder, empty ones included where the platform reports them. */
	folders: string[];
	/** The stat of every markdown page in `files`. A page whose stat failed is left out of both. */
	stats: Map<string, VaultFileStat>;
}

export interface VaultFs {
	/** The vault root as the platform spells it (an absolute local path, or a POSIX path on the remote). */
	readonly root: string;
	/** Set when the root lives on an SSH remote. */
	readonly sshRemoteId: string | null;
	list(): Promise<VaultListing>;
	/** Read a vault-relative file as UTF-8 text. Throws when it cannot be read. */
	readText(relPath: string): Promise<string>;
	/**
	 * Read a vault-relative file for UNTRUSTED code (DataviewJS `dv.io.load`, D4): only when its REAL path,
	 * symlinks resolved, stays inside the real root and is still a path the index holds (`isIndexedVaultPath()`,
	 * so a symlink cannot lead into `.obsidian/`, `.git/`, or `node_modules`), and reading the resolved file.
	 * `relPath` must already be a normalized root-relative path (`normalizeRootRelativePath()`). Null when no
	 * regular file is there. Throws for a path that resolves outside the root or into an excluded folder, a
	 * file over `maxBytes`, or a failed read.
	 */
	readTextInRoot(relPath: string, maxBytes: number): Promise<string | null>;
	/**
	 * Stat one vault-relative path; null when it no longer exists. Only a local vault has it: the watcher
	 * that needs it is local, and a remote vault is polled through `list()` instead.
	 */
	stat?(relPath: string): Promise<VaultEntryStat | null>;
}

/** Errors that mean the path is gone rather than that the file system is broken. */
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Whether a vault-relative path belongs in the index: no dot-prefixed segment, no `node_modules`
 * segment, and not a Windows system file.
 */
export function isIndexedVaultPath(relPath: string): boolean {
	if (!relPath) return false;
	for (const segment of relPath.split('/')) {
		if (segment.startsWith('.') || segment === 'node_modules') return false;
	}
	return !WINDOWS_LOCKED_SYSTEM_FILES.test(relPath);
}

/** Creation time per the guide's `file.ctime` trap: birth time, else the inode change time. */
function creationTime(birthtimeMs: number, ctimeMs: number): number {
	return birthtimeMs > 0 ? birthtimeMs : ctimeMs;
}

function flattenTree(
	nodes: LocalTreeNode[],
	prefix: string,
	files: string[],
	folders: string[]
): void {
	for (const node of nodes) {
		const relPath = prefix ? `${prefix}/${node.name}` : node.name;
		if (!isIndexedVaultPath(relPath)) continue;
		if (node.type === 'folder') {
			folders.push(relPath);
			flattenTree(node.children ?? [], relPath, files, folders);
		} else files.push(relPath);
	}
}

/** A vault on the local disk. */
export function createLocalVaultFs(root: string): VaultFs {
	const absolute = (relPath: string) => path.join(root, ...relPath.split('/'));
	return {
		root,
		sshRemoteId: null,
		async list() {
			const { tree } = await walkLocalFileTree(root, {
				maxDepth: VAULT_MAX_DEPTH,
				ignorePatterns: [...VAULT_PRUNED_NAMES],
			});
			const files: string[] = [];
			const folders: string[] = [];
			flattenTree(tree, '', files, folders);

			const stats = new Map<string, VaultFileStat>();
			const pages = files.filter(isMarkdownPagePath);
			const statted = await mapWithConcurrency(
				pages,
				LOCAL_SESSION_READ_CONCURRENCY,
				async (page) => {
					try {
						return await fs.stat(absolute(page));
					} catch {
						return null; // Deleted between the walk and the stat.
					}
				}
			);
			const gone = new Set<string>();
			pages.forEach((page, i) => {
				const stat = statted[i];
				if (!stat) gone.add(page);
				else
					stats.set(page, {
						size: stat.size,
						mtime: stat.mtimeMs,
						ctime: creationTime(stat.birthtimeMs, stat.ctimeMs),
					});
			});
			return { files: gone.size ? files.filter((f) => !gone.has(f)) : files, folders, stats };
		},
		readText(relPath) {
			return fs.readFile(absolute(relPath), 'utf8');
		},
		async readTextInRoot(relPath, maxBytes) {
			const target = await resolvePathInRealRoot(root, relPath);
			if (target.kind === 'missing') return null;
			if (target.kind === 'outside') throw new Error(`${relPath} resolves outside ${root}`);
			if (!isIndexedVaultPath(target.realRelativePath)) {
				throw new Error(
					`${relPath} resolves to ${target.realRelativePath}, which DataviewJS cannot read`
				);
			}
			const stat = await fs.stat(target.realPath);
			if (!stat.isFile()) return null;
			if (stat.size > maxBytes) throw new Error(`${relPath} is larger than ${maxBytes} bytes`);
			return fs.readFile(target.realPath, 'utf8');
		},
		async stat(relPath) {
			let stat;
			try {
				stat = await fs.stat(absolute(relPath));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code && GONE_CODES.has(code)) return null;
				throw error;
			}
			if (stat.isDirectory()) return { kind: 'folder' };
			return {
				kind: 'file',
				size: stat.size,
				mtime: stat.mtimeMs,
				ctime: creationTime(stat.birthtimeMs, stat.ctimeMs),
			};
		},
	};
}

/** A vault on an SSH remote. The listing is one round trip; each read is one more. */
export function createRemoteVaultFs(root: string, sshRemote: SshRemoteConfig): VaultFs {
	const absolute = (relPath: string) => path.posix.join(root, relPath);
	return {
		root,
		sshRemoteId: sshRemote.id,
		async list() {
			const result = await listFilesWithStatsRemote(root, [...VAULT_PRUNED_NAMES], sshRemote);
			if (!result.success || !result.data) {
				throw new Error(result.error ?? `Failed to list the vault at ${root}`);
			}
			const files: string[] = [];
			const folders = new Set<string>();
			const stats = new Map<string, VaultFileStat>();
			for (const entry of result.data) {
				if (!isIndexedVaultPath(entry.path)) continue;
				files.push(entry.path);
				for (let slash = entry.path.lastIndexOf('/'); slash > 0; ) {
					const folder = entry.path.slice(0, slash);
					if (folders.has(folder)) break;
					folders.add(folder);
					slash = folder.lastIndexOf('/');
				}
				if (isMarkdownPagePath(entry.path)) {
					stats.set(entry.path, {
						size: entry.size,
						mtime: entry.mtime,
						ctime: creationTime(entry.birthtime, entry.ctime),
					});
				}
			}
			return { files, folders: [...folders], stats };
		},
		async readText(relPath) {
			const result = await readFileRemote(absolute(relPath), sshRemote);
			if (!result.success || result.data === undefined) {
				throw new Error(result.error ?? `Failed to read ${relPath}`);
			}
			return result.data;
		},
		async readTextInRoot(relPath, maxBytes) {
			const result = await readFileInRootRemote(root, relPath, maxBytes, sshRemote);
			if (!result.success || result.data === undefined) {
				throw new Error(result.error ?? `Failed to read ${relPath}`);
			}
			return result.data;
		},
	};
}
