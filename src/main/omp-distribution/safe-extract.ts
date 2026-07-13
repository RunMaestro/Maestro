import { gunzipSync } from 'zlib';

const TAR_BLOCK_SIZE = 512;
const PACKAGE_PREFIX = 'package/';

export interface ExtractedTarFile {
	path: string;
	content: Buffer;
}

/** Extracts regular files from an npm gzip tarball without following archive-controlled paths. */
export function extractVerifiedTarball(tarball: Uint8Array): ExtractedTarFile[] {
	let archive: Buffer;
	try {
		archive = gunzipSync(tarball);
	} catch {
		throw new Error('invalid gzip tarball');
	}

	const files: ExtractedTarFile[] = [];
	const seenPaths = new Set<string>();
	let offset = 0;
	while (offset < archive.length) {
		if (offset + TAR_BLOCK_SIZE > archive.length) throw new Error('truncated tar header');
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) break;

		const type = String.fromCharCode(header[156] ?? 0);
		if (type === '1' || type === '2') throw new Error('tar link entries are forbidden');
		if (type !== '\0' && type !== '0') throw new Error(`unsupported tar entry type ${type}`);

		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const path = validateTarPath(prefix.length > 0 ? `${prefix}/${name}` : name);
		const size = readTarSize(header);
		const contentStart = offset + TAR_BLOCK_SIZE;
		const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
		const nextOffset = contentStart + paddedSize;
		if (nextOffset > archive.length) throw new Error('truncated tar content');

		if (seenPaths.has(path)) throw new Error(`duplicate tar path: ${path}`);
		seenPaths.add(path);
		files.push({ path, content: Buffer.from(archive.subarray(contentStart, contentStart + size)) });
		offset = nextOffset;
	}
	if (files.length === 0) throw new Error('tarball contains no package files');
	return files;
}

function readTarString(header: Buffer, start: number, length: number): string {
	const raw = header.subarray(start, start + length);
	const terminator = raw.indexOf(0);
	return raw.subarray(0, terminator === -1 ? raw.length : terminator).toString('utf8');
}

function readTarSize(header: Buffer): number {
	const raw = readTarString(header, 124, 12).trim();
	if (!/^[0-7]+$/.test(raw)) throw new Error('invalid tar size');
	const size = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid tar size');
	return size;
}

function validateTarPath(entryPath: string): string {
	if (!entryPath.startsWith(PACKAGE_PREFIX)) throw new Error(`unsafe tar path: ${entryPath}`);
	const relativePath = entryPath.slice(PACKAGE_PREFIX.length);
	if (
		relativePath.length === 0 ||
		relativePath.startsWith('/') ||
		relativePath.includes('\\') ||
		relativePath.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
	) {
		throw new Error(`unsafe tar path: ${entryPath}`);
	}
	return relativePath;
}
