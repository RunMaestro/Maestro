import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import archiver from 'archiver';
import { SIGNATURE_EXCLUDED_DIRS, isExcludedSignaturePath, normalizeRelPath } from './signing';

const MAX_PACKED_PLUGIN_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_PACKED_PLUGIN_FILES = 5000;
const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;

export interface ExtractedPluginArchive {
	root: string;
	cleanup: () => void;
}

export function isPackedPluginArchivePath(sourcePath: string): boolean {
	const lower = sourcePath.toLowerCase();
	return lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
}

/**
 * Collect plugin-relative POSIX file paths to pack. Uses the same shared
 * exclusion policy as signing/verification. `signature.json` is included: the
 * host verifier needs it to validate the packed bytes after install.
 */
export function collectPluginArchiveFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const abs = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (SIGNATURE_EXCLUDED_DIRS.has(entry.name)) continue;
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = normalizeRelPath(path.relative(dir, abs));
			if (isExcludedSignaturePath(rel)) continue;
			out.push(rel);
		}
	};
	walk(dir);
	return out.sort();
}

/** Write a plugin directory into a gzip tar archive using plugin-relative paths. */
export function packPluginArchive(
	dir: string,
	outPath: string,
	files = collectPluginArchiveFiles(dir)
): Promise<void> {
	if (files.length === 0) throw new Error(`no packable files found in ${dir}`);
	return new Promise<void>((resolve, reject) => {
		const output = fs.createWriteStream(outPath);
		const archive = archiver('tar', { gzip: true });
		output.on('close', () => resolve());
		output.on('error', reject);
		archive.on('error', reject);
		archive.pipe(output);
		for (const rel of files) {
			archive.file(path.join(dir, rel), { name: rel });
		}
		void archive.finalize();
	});
}

function parseTarString(block: Buffer, offset: number, length: number): string {
	const raw = block.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function parseTarOctal(block: Buffer, offset: number, length: number): number {
	const raw = parseTarString(block, offset, length).trim();
	if (raw.length === 0) return 0;
	if (!/^[0-7]+$/.test(raw)) throw new Error('invalid tar size field');
	return Number.parseInt(raw, 8);
}

function isZeroBlock(block: Buffer): boolean {
	return block.every((byte) => byte === 0);
}

function archivePathSegments(entryPath: string): string[] {
	if (entryPath.includes('\\')) throw new Error(`unsafe archive path "${entryPath}"`);
	if (entryPath.startsWith('/') || /^[A-Za-z]:\//.test(entryPath)) {
		throw new Error(`unsafe archive path "${entryPath}"`);
	}
	const normalized = path.posix.normalize(entryPath);
	if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
		throw new Error(`unsafe archive path "${entryPath}"`);
	}
	const segments = normalized.split('/').filter(Boolean);
	if (segments.length === 0 || segments.some((segment) => segment === '..')) {
		throw new Error(`unsafe archive path "${entryPath}"`);
	}
	return segments;
}

function safeExtractTarget(stagingDir: string, entryPath: string): string {
	const segments = archivePathSegments(entryPath);
	const target = path.resolve(stagingDir, ...segments);
	const relative = path.relative(stagingDir, target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`unsafe archive path "${entryPath}"`);
	}
	return target;
}

function resolveExtractedPluginRoot(stagingDir: string): string {
	if (fs.existsSync(path.join(stagingDir, 'plugin.json'))) return stagingDir;
	const entries = fs.existsSync(stagingDir)
		? fs.readdirSync(stagingDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
		: [];
	if (entries.length === 1) {
		const candidate = path.join(stagingDir, entries[0].name);
		if (fs.existsSync(path.join(candidate, 'plugin.json'))) return candidate;
	}
	throw new Error('packed plugin archive must contain plugin.json at the root');
}

export function extractPluginArchive(
	archivePath: string,
	stagingParent = os.tmpdir()
): ExtractedPluginArchive {
	const resolvedArchive = path.resolve(archivePath);
	const archiveStat = fs.statSync(resolvedArchive);
	if (!archiveStat.isFile()) throw new Error('packed plugin source is not a file');
	if (archiveStat.size > MAX_PACKED_PLUGIN_ARCHIVE_BYTES) {
		throw new Error('packed plugin archive exceeds size limit');
	}

	fs.mkdirSync(stagingParent, { recursive: true });
	const stagingDir = fs.mkdtempSync(path.join(stagingParent, '__extract-'));
	let fileCount = 0;
	let totalUnpackedBytes = 0;

	try {
		const unpacked = zlib.gunzipSync(fs.readFileSync(resolvedArchive), {
			maxOutputLength: MAX_PACKED_PLUGIN_ARCHIVE_BYTES + TAR_END_BYTES,
		});
		let offset = 0;
		while (offset + TAR_BLOCK_BYTES <= unpacked.length) {
			const header = unpacked.subarray(offset, offset + TAR_BLOCK_BYTES);
			if (isZeroBlock(header)) break;
			const entryName = parseTarString(header, 0, 100);
			const entryPrefix = parseTarString(header, 345, 155);
			const entryPath = entryPrefix ? `${entryPrefix}/${entryName}` : entryName;
			const size = parseTarOctal(header, 124, 12);
			const typeFlag = parseTarString(header, 156, 1) || '0';
			const contentStart = offset + TAR_BLOCK_BYTES;
			const contentEnd = contentStart + size;
			if (contentEnd > unpacked.length) throw new Error('packed plugin archive is truncated');

			if (typeFlag === '1' || typeFlag === '2') {
				throw new Error('packed plugin archive link entries are not allowed');
			}
			const target = safeExtractTarget(stagingDir, entryPath);
			if (typeFlag === '5') {
				fs.mkdirSync(target, { recursive: true });
			} else if (typeFlag === '0') {
				fileCount += 1;
				totalUnpackedBytes += size;
				if (fileCount > MAX_PACKED_PLUGIN_FILES) {
					throw new Error('packed plugin archive contains too many files');
				}
				if (totalUnpackedBytes > MAX_PACKED_PLUGIN_ARCHIVE_BYTES) {
					throw new Error('packed plugin archive exceeds unpacked size limit');
				}
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, unpacked.subarray(contentStart, contentEnd));
			} else {
				throw new Error(`packed plugin archive entry type "${typeFlag}" is not supported`);
			}
			offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
		}
		return {
			root: resolveExtractedPluginRoot(stagingDir),
			cleanup: () => fs.rmSync(stagingDir, { recursive: true, force: true }),
		};
	} catch (error) {
		fs.rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}
}
