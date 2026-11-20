import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import type { ReadStream } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	forEachJsonlLine,
	readFirstJsonlLine,
} from '../../../shared/maestro-lib/storage/jsonl-stream';

describe('forEachJsonlLine', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-stream-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function linesOf(content: string): Promise<string[]> {
		const file = path.join(dir, 'transcript.jsonl');
		await fs.writeFile(file, content, 'utf-8');
		const lines: string[] = [];
		await forEachJsonlLine(file, (line) => lines.push(line));
		return lines;
	}

	it('yields every non-blank line in file order', async () => {
		expect(await linesOf('{"a":1}\n\n{"b":2}\n   \n{"c":3}\n')).toEqual([
			'{"a":1}',
			'{"b":2}',
			'{"c":3}',
		]);
	});

	it('yields a final line that has no trailing newline', async () => {
		expect(await linesOf('{"a":1}\n{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
	});

	it('strips CRLF line endings', async () => {
		expect(await linesOf('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
	});

	it('keeps multi-byte text intact across read chunks', async () => {
		// Longer than one 64KB stream chunk, so a code point straddles a boundary.
		const text = '✓ café \u{1F600} '.repeat(20_000);
		const line = JSON.stringify({ text });
		const [only] = await linesOf(`${line}\n`);
		expect(JSON.parse(only).text).toBe(text);
	});

	it('rejects for a missing file, as readFile did', async () => {
		await expect(forEachJsonlLine(path.join(dir, 'missing.jsonl'), () => {})).rejects.toMatchObject(
			{ code: 'ENOENT' }
		);
	});

	describe('file handle', () => {
		// On Windows an open handle blocks deleting or renaming the transcript,
		// so the handle must be closed by the time the read settles, however it ends.
		let opened: { handle: FileHandle; stream?: ReadStream }[];

		beforeEach(() => {
			opened = [];
			const realOpen = fsp.open.bind(fsp);
			vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
				const handle = await realOpen(...args);
				const entry: { handle: FileHandle; stream?: ReadStream } = { handle };
				const createReadStream = handle.createReadStream.bind(handle);
				handle.createReadStream = (options) => (entry.stream = createReadStream(options));
				opened.push(entry);
				return handle;
			});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		async function bigFile(): Promise<{ file: string; size: number }> {
			const file = path.join(dir, 'big.jsonl');
			const content = `${JSON.stringify({ n: 0 })}\n`.repeat(200_000);
			await fs.writeFile(file, content, 'utf-8');
			return { file, size: Buffer.byteLength(content) };
		}

		it('is closed after a full read', async () => {
			const { file } = await bigFile();
			await forEachJsonlLine(file, () => {});
			expect(opened).toHaveLength(1);
			// `closed` is set when the close has finished, not when it was asked for.
			expect(opened[0].stream?.closed).toBe(true);
			expect(opened[0].handle.fd).toBe(-1);
		});

		it('is closed when the callback throws partway through', async () => {
			const { file, size } = await bigFile();
			await expect(
				forEachJsonlLine(file, () => {
					throw new Error('stop');
				})
			).rejects.toThrow('stop');
			expect(opened[0].stream?.closed).toBe(true);
			expect(opened[0].handle.fd).toBe(-1);
			expect(opened[0].stream?.bytesRead).toBeLessThan(size);
		});
	});
});

describe('readFirstJsonlLine', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-first-'));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function write(content: string): Promise<string> {
		const file = path.join(dir, 'rollout.jsonl');
		await fs.writeFile(file, content, 'utf-8');
		return file;
	}

	it('returns the first non-blank line', async () => {
		expect(await readFirstJsonlLine(await write('\r\n{"id":"a"}\r\n{"id":"b"}\r\n'))).toBe(
			'{"id":"a"}'
		);
	});

	it('returns a first line longer than one read chunk whole', async () => {
		const header = JSON.stringify({ id: 'a', pad: 'x'.repeat(200_000) });
		expect(await readFirstJsonlLine(await write(`${header}\n{"id":"b"}\n`))).toBe(header);
	});

	it('returns null for a file with no lines', async () => {
		expect(await readFirstJsonlLine(await write(''))).toBeNull();
		expect(await readFirstJsonlLine(await write('\n  \n'))).toBeNull();
	});

	it('reads only as far as the first line and closes the file', async () => {
		// A header lookup runs for every rollout until the match, so it must not
		// read the rest of a multi-hundred-MB transcript (#1862).
		let handle: FileHandle | undefined;
		let stream: ReadStream | undefined;
		const realOpen = fsp.open.bind(fsp);
		vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
			handle = await realOpen(...args);
			const createReadStream = handle.createReadStream.bind(handle);
			handle.createReadStream = (options) => (stream = createReadStream(options));
			return handle;
		});
		const content = `{"id":"a"}\n${`${JSON.stringify({ n: 0 })}\n`.repeat(200_000)}`;
		expect(await readFirstJsonlLine(await write(content))).toBe('{"id":"a"}');
		expect(stream?.bytesRead).toBeLessThan(Buffer.byteLength(content) / 4);
		expect(stream?.closed).toBe(true);
		expect(handle?.fd).toBe(-1);
	});

	it('rejects for a missing file', async () => {
		await expect(readFirstJsonlLine(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});
