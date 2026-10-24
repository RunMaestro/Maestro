import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { forEachJsonlLine } from '../../../main/utils/jsonl-stream';

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
});
