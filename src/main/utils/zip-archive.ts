/**
 * @file zip-archive.ts
 * @description Read a zip in memory without extract-to-disk.
 *
 * Playbook import, Cue backup inspect/restore, and the debug-package tests
 * only need entry names and bytes. adm-zip's extractAllTo is what GHSA-vwc7-r8mq-g2x9
 * is about (overwrite follows a destination symlink). There is no patched
 * adm-zip release, so read here and write with fs after checking the dest
 * is a real file, not a symlink.
 */

import * as fs from 'fs';
import * as path from 'path';
import { unzipSync } from 'fflate';

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

/** Load a zip from disk. Throws if the file is missing or not a zip. */
export function readZipArchive(filePath: string): ZipArchive {
	const raw = fs.readFileSync(filePath);
	const unzipped = unzipSync(new Uint8Array(raw));
	const byName = new Map<string, ZipEntry>();
	for (const [name, bytes] of Object.entries(unzipped)) {
		const entryName = normalizeZipEntryName(name);
		if (!entryName) continue;
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

/**
 * Write zip entries under destDir. Refuses zip-slip names and will not
 * overwrite a destination that is already a symlink (the adm-zip advisory).
 */
export function extractZipTo(zipPath: string, destDir: string): void {
	const destRoot = path.resolve(destDir);
	fs.mkdirSync(destRoot, { recursive: true });
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

		fs.mkdirSync(path.dirname(dest), { recursive: true });
		if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
			throw new Error(`Refusing to overwrite symlink: ${entry.entryName}`);
		}
		fs.writeFileSync(dest, entry.getData());
	}
}
