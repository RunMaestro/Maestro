import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import archiver from 'archiver';
import {
	extractZipTo,
	isUnsafeZipEntryName,
	readZipArchive,
} from '../../../main/utils/zip-archive';

async function writeArchiverZip(
	dir: string,
	files: Record<string, string | Buffer>
): Promise<string> {
	const zipPath = path.join(dir, 'archiver.zip');
	await new Promise<void>((resolve, reject) => {
		const output = createWriteStream(zipPath);
		const archive = archiver('zip', { zlib: { level: 9 } });
		output.on('close', () => resolve());
		output.on('error', reject);
		archive.on('error', reject);
		archive.pipe(output);
		for (const [name, content] of Object.entries(files)) {
			archive.append(content, { name });
		}
		void archive.finalize();
	});
	return zipPath;
}

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

	it('inflates only the named entries', () => {
		const zipPath = writeZip(tmp, {
			'manifest.json': '{"ok":true}',
			'workspaces/ws/cue.yaml': 'subscriptions: []\n',
			'workspaces/ws/prompts/hi.md': '# hi\n',
		});

		const zip = readZipArchive(zipPath, { names: ['manifest.json'] });
		expect(zip.getEntry('manifest.json')?.getData().toString('utf-8')).toBe('{"ok":true}');
		expect(zip.getEntry('workspaces/ws/cue.yaml')).toBeUndefined();
		expect(zip.getEntries().map((e) => e.entryName)).toEqual(['manifest.json']);
	});

	it('applies a predicate before inflation', () => {
		const zipPath = writeZip(tmp, {
			'keep.json': '{}',
			'skip.bin': 'nope',
		});

		const zip = readZipArchive(zipPath, {
			filter: (file) => file.name.endsWith('.json'),
		});
		expect(zip.getEntry('keep.json')).toBeDefined();
		expect(zip.getEntry('skip.bin')).toBeUndefined();
	});

	it('refuses a selected entry count above the cap', () => {
		const zipPath = writeZip(tmp, {
			'a.txt': 'a',
			'b.txt': 'b',
			'c.txt': 'c',
		});
		expect(() => readZipArchive(zipPath, { maxEntries: 2 })).toThrow(/more than 2 entries/);
	});

	it('refuses an aggregate originalSize above the cap', () => {
		const zipPath = writeZip(tmp, {
			'big.txt': '0123456789',
		});
		expect(() => readZipArchive(zipPath, { maxOriginalSize: 5 })).toThrow(
			/expanded size exceeds 5 bytes/
		);
	});

	it('reads an archiver zip and can inflate only the manifest', async () => {
		const zipPath = await writeArchiverZip(tmp, {
			'manifest.json': JSON.stringify({
				name: 'Imported Playbook',
				workspaces: [{ id: 'ws_abc' }],
			}),
			'workspaces/ws_abc/cue.yaml': 'subscriptions: []\n',
			'workspaces/ws_abc/prompts/hello.md': '# hi\n',
			'documents/doc1.md': '# Document content',
		});

		const full = readZipArchive(zipPath);
		expect(full.getEntry('manifest.json')?.getData().toString('utf-8')).toContain('ws_abc');
		expect(full.getEntry('workspaces/ws_abc/cue.yaml')?.getData().toString('utf-8')).toBe(
			'subscriptions: []\n'
		);
		expect(full.getEntry('documents/doc1.md')?.getData().toString('utf-8')).toBe(
			'# Document content'
		);

		const manifestOnly = readZipArchive(zipPath, { names: ['manifest.json'] });
		expect(
			JSON.parse(manifestOnly.getEntry('manifest.json')!.getData().toString('utf-8')).name
		).toBe('Imported Playbook');
		expect(manifestOnly.getEntry('workspaces/ws_abc/cue.yaml')).toBeUndefined();
		expect(manifestOnly.getEntry('documents/doc1.md')).toBeUndefined();

		const dest = path.join(tmp, 'extracted');
		extractZipTo(zipPath, dest);
		expect(fs.readFileSync(path.join(dest, 'documents', 'doc1.md'), 'utf8')).toBe(
			'# Document content'
		);
		expect(fs.readFileSync(path.join(dest, 'workspaces', 'ws_abc', 'cue.yaml'), 'utf8')).toBe(
			'subscriptions: []\n'
		);
	});

	it('lets a caller opt out of the default caps', () => {
		const zipPath = writeZip(tmp, {
			'big.txt': '0123456789',
		});
		expect(() => readZipArchive(zipPath, { maxOriginalSize: 5 })).toThrow(
			/expanded size exceeds 5 bytes/
		);
		expect(
			readZipArchive(zipPath, { maxOriginalSize: Number.POSITIVE_INFINITY })
				.getEntry('big.txt')
				?.getData()
				.toString('utf-8')
		).toBe('0123456789');
	});

	it('does not count skipped entries toward the caps', () => {
		const zipPath = writeZip(tmp, {
			'manifest.json': '{}',
			'huge.txt': '0123456789',
		});
		const zip = readZipArchive(zipPath, {
			names: ['manifest.json'],
			maxEntries: 1,
			maxOriginalSize: 4,
		});
		expect(zip.getEntry('manifest.json')?.getData().toString('utf-8')).toBe('{}');
		expect(zip.getEntry('huge.txt')).toBeUndefined();
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

	it.skipIf(process.platform === 'win32')('refuses to overwrite a destination symlink', () => {
		const zipPath = writeZip(tmp, { 'secret.txt': 'from-zip' });
		const dest = path.join(tmp, 'out');
		fs.mkdirSync(dest);
		const outside = path.join(tmp, 'outside.txt');
		fs.writeFileSync(outside, 'keep');
		fs.symlinkSync(outside, path.join(dest, 'secret.txt'));

		expect(() => extractZipTo(zipPath, dest)).toThrow(/symlink/);
		expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
	});

	it.skipIf(process.platform === 'win32')(
		'refuses to write through an intermediate symlink',
		() => {
			const zipPath = writeZip(tmp, { 'nested/file.txt': 'pwn' });
			const dest = path.join(tmp, 'out');
			fs.mkdirSync(dest);
			const outside = path.join(tmp, 'outside');
			fs.mkdirSync(outside);
			fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
			fs.symlinkSync(outside, path.join(dest, 'nested'));

			expect(() => extractZipTo(zipPath, dest)).toThrow(/symlink/);
			expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
			expect(fs.existsSync(path.join(outside, 'file.txt'))).toBe(false);
		}
	);
});
