import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import {
	extractZipTo,
	isUnsafeZipEntryName,
	readZipArchive,
} from '../../../main/utils/zip-archive';

function writeZip(dir: string, files: Record<string, string>): string {
	const encoded: Record<string, Uint8Array> = {};
	for (const [name, text] of Object.entries(files)) {
		encoded[name] = new TextEncoder().encode(text);
	}
	const zipPath = path.join(dir, 'sample.zip');
	fs.writeFileSync(zipPath, zipSync(encoded));
	return zipPath;
}

describe('zip-archive', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-zip-archive-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('reads entry names and bytes from a zip on disk', () => {
		const zipPath = writeZip(tmp, {
			'manifest.json': '{"name":"demo"}',
			'documents/a.md': '# hello',
		});

		const zip = readZipArchive(zipPath);
		const names = zip
			.getEntries()
			.map((e) => e.entryName)
			.sort();
		expect(names).toEqual(['documents/a.md', 'manifest.json']);
		expect(zip.getEntry('manifest.json')?.getData().toString('utf-8')).toBe('{"name":"demo"}');
		expect(zip.getEntry('documents/a.md')?.size).toBe('# hello'.length);
	});

	it('treats missing entries as undefined rather than throwing', () => {
		const zipPath = writeZip(tmp, { 'only.txt': 'x' });
		expect(readZipArchive(zipPath).getEntry('missing.txt')).toBeUndefined();
	});

	it('extracts files under the destination and skips directories', () => {
		const zipPath = writeZip(tmp, {
			'readme.txt': 'ok',
			'nested/file.txt': 'inner',
		});
		const dest = path.join(tmp, 'out');
		extractZipTo(zipPath, dest);
		expect(fs.readFileSync(path.join(dest, 'readme.txt'), 'utf8')).toBe('ok');
		expect(fs.readFileSync(path.join(dest, 'nested', 'file.txt'), 'utf8')).toBe('inner');
	});

	it('refuses zip-slip names before writing', () => {
		expect(isUnsafeZipEntryName('../etc/passwd')).toBe(true);
		expect(isUnsafeZipEntryName('/etc/passwd')).toBe(true);
		expect(isUnsafeZipEntryName('C:/Windows/win.ini')).toBe(true);
		expect(isUnsafeZipEntryName('nested/ok.txt')).toBe(false);

		const zipPath = path.join(tmp, 'slip.zip');
		fs.writeFileSync(zipPath, zipSync({ '../escape.txt': new TextEncoder().encode('no') }));
		expect(() => extractZipTo(zipPath, path.join(tmp, 'out'))).toThrow(/outside destination/);
		expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
	});

	it('refuses to overwrite a destination symlink', () => {
		const zipPath = writeZip(tmp, { 'secret.txt': 'from-zip' });
		const dest = path.join(tmp, 'out');
		fs.mkdirSync(dest);
		const outside = path.join(tmp, 'outside.txt');
		fs.writeFileSync(outside, 'keep');
		fs.symlinkSync(outside, path.join(dest, 'secret.txt'));

		expect(() => extractZipTo(zipPath, dest)).toThrow(/symlink/);
		expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
	});
});
