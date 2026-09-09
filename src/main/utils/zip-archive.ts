/**
 * @file zip-archive.ts
 * @description Read a zip in memory without extract-to-disk.
 *
 * Playbook import, Cue backup inspect/restore, and the debug-package tests
 * only need entry names and bytes. adm-zip's extractAllTo is what GHSA-vwc7-r8mq-g2x9
 * is about (overwrite follows a destination symlink). There is no patched
 * adm-zip release, so read here and write with fs after checking the dest
 * is a real file, not a symlink.
 *
 * unzipSync inflates every selected entry. Pass `names` or `filter` so a
 * caller that only needs `manifest.json` does not expand the rest, and the
 * default original-size / entry-count caps refuse a zip bomb before the
 * bytes land in the main process.
 */

import * as fs from 'fs';
import * as path from 'path';
import { unzipSync, type UnzipFileInfo } from 'fflate';

export type { UnzipFileInfo };

/** Default cap on how many entries a read will inflate. */
export const DEFAULT_ZIP_MAX_ENTRIES = 10_000;

/** Default cap on aggregate uncompressed size of inflated entries (256 MiB). */
export const DEFAULT_ZIP_MAX_ORIGINAL_SIZE = 256 * 1024 * 1024;

export interface ZipEntry {
	readonly entryName: string;
	readonly isDirectory: boolean;
	readonly size: number;
	getData(): Buffer;
}

export interface ZipArchive {
	getEntries(): ZipEntry[];
	getEntry(name: string): ZipEntry | undefined;
}

export interface ReadZipArchiveOptions {
	/** Only inflate these entry names. Compared after slash normalization. */
	names?: readonly string[];
	/** Predicate over zip metadata. Runs before inflation. Combined with `names`. */
	filter?: (file: UnzipFileInfo) => boolean;
	/** Aggregate `originalSize` of selected entries. Defaults to 256 MiB. Pass `Infinity` for a first-party archive the caller already wrote without a create-time cap. */
	maxOriginalSize?: number;
	/** Selected entry count. Defaults to 10_000. Pass `Infinity` to match an uncapped writer. */
	maxEntries?: number;
}

function normalizeZipEntryName(name: string): string {
	return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isUnsafeZipEntryName(name: string): boolean {
	const rel = normalizeZipEntryName(name);
	if (!rel || rel.includes('\0')) return true;
	if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return true;
	return rel.split('/').some((part) => part === '..');
}

function toEntry(entryName: string, bytes: Uint8Array): ZipEntry {
	const isDirectory = entryName.endsWith('/');
	return {
		entryName,
		isDirectory,
		size: bytes.byteLength,
		getData: () => Buffer.from(bytes),
	};
}

function selectedForRead(
	file: UnzipFileInfo,
	allowedNames: Set<string> | null,
	filter?: (file: UnzipFileInfo) => boolean
): boolean {
	const name = normalizeZipEntryName(file.name);
	if (allowedNames && !allowedNames.has(name)) return false;
	if (filter && !filter(file)) return false;
	return true;
}

/**
 * Load a zip from disk. Throws if the file is missing or not a zip, or if
 * selected entries exceed the size / count caps.
 */
export function readZipArchive(filePath: string, options?: ReadZipArchiveOptions): ZipArchive {
	const raw = fs.readFileSync(filePath);
	const maxEntries = options?.maxEntries ?? DEFAULT_ZIP_MAX_ENTRIES;
	const maxOriginalSize = options?.maxOriginalSize ?? DEFAULT_ZIP_MAX_ORIGINAL_SIZE;
	const allowedNames = options?.names ? new Set(options.names.map(normalizeZipEntryName)) : null;
	let selectedCount = 0;
	let selectedOriginalSize = 0;
	let refuse: Error | undefined;

	const unzipped = unzipSync(new Uint8Array(raw), {
		filter(file) {
			if (refuse) return false;
			if (!selectedForRead(file, allowedNames, options?.filter)) return false;

			selectedCount += 1;
			if (selectedCount > maxEntries) {
				refuse = new Error(`Refusing zip: more than ${maxEntries} entries`);
				return false;
			}

			selectedOriginalSize += file.originalSize;
			if (selectedOriginalSize > maxOriginalSize) {
				refuse = new Error(`Refusing zip: expanded size exceeds ${maxOriginalSize} bytes`);
				return false;
			}
			return true;
		},
	});

	if (refuse) throw refuse;

	const byName = new Map<string, ZipEntry>();
	let inflatedBytes = 0;
	for (const [name, bytes] of Object.entries(unzipped)) {
		const entryName = normalizeZipEntryName(name);
		if (!entryName) continue;
		inflatedBytes += bytes.byteLength;
		if (inflatedBytes > maxOriginalSize) {
			throw new Error(`Refusing zip: expanded size exceeds ${maxOriginalSize} bytes`);
		}
		byName.set(entryName, toEntry(entryName, bytes));
	}

	return {
		getEntries() {
			return [...byName.values()];
		},
		getEntry(name: string) {
			return byName.get(normalizeZipEntryName(name));
		},
	};
}

function assertNoSymlinkOnPath(destRoot: string, target: string): void {
	const rel = path.relative(destRoot, target);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`Refusing zip entry outside destination: ${rel || target}`);
	}

	let current = destRoot;
	for (const part of rel.split(path.sep)) {
		if (!part || part === '.') continue;
		current = path.join(current, part);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`Refusing to write through symlink: ${current}`);
		}
	}
}

/**
 * Write zip entries under destDir. Refuses zip-slip names, will not
 * overwrite a destination that is already a symlink, and will not write
 * through an intermediate path component that is already a symlink.
 */
export function extractZipTo(zipPath: string, destDir: string): void {
	fs.mkdirSync(destDir, { recursive: true });
	const destRoot = fs.realpathSync(destDir);
	const zip = readZipArchive(zipPath);

	for (const entry of zip.getEntries()) {
		if (entry.isDirectory) continue;
		if (isUnsafeZipEntryName(entry.entryName)) {
			throw new Error(`Refusing zip entry outside destination: ${entry.entryName}`);
		}

		const dest = path.resolve(destRoot, entry.entryName);
		const inside = dest === destRoot || dest.startsWith(destRoot + path.sep);
		if (!inside) {
			throw new Error(`Refusing zip entry outside destination: ${entry.entryName}`);
		}

		assertNoSymlinkOnPath(destRoot, dest);

		const parent = path.dirname(dest);
		fs.mkdirSync(parent, { recursive: true });
		assertNoSymlinkOnPath(destRoot, dest);

		const realParent = fs.realpathSync(parent);
		if (realParent !== destRoot && !realParent.startsWith(destRoot + path.sep)) {
			throw new Error(`Refusing zip entry outside destination: ${entry.entryName}`);
		}

		if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
			throw new Error(`Refusing to overwrite symlink: ${entry.entryName}`);
		}
		fs.writeFileSync(dest, entry.getData());
	}
}
