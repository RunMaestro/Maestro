/**
 * @file log-sources.test.ts
 *
 * Reading a file log source by id: the id maps to the file in main, an unknown
 * or in-memory id is refused, and a poll that finds the file unchanged is
 * answered without its text.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let logFile = '';
vi.mock('../../main/local-models/server/supervisor', () => ({
	modelServerLogPath: () => logFile,
}));

import { readLogSource } from '../../main/log-sources';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sources-'));
	logFile = path.join(dir, 'model-server.log');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('readLogSource', () => {
	it("reads the model server's log file by id", async () => {
		fs.writeFileSync(logFile, 'main: server is listening\n');

		const read = await readLogSource('model-server');
		expect(read).toMatchObject({
			source: 'model-server',
			path: logFile,
			exists: true,
			text: 'main: server is listening\n',
			truncated: false,
		});
		expect(read.unchanged).toBeUndefined();
	});

	it('reports a log the server has not written yet', async () => {
		const read = await readLogSource('model-server');
		expect(read).toMatchObject({ exists: false, text: '', path: logFile });
	});

	it.each([['maestro'], ['/etc/passwd'], [undefined]])('refuses %s', async (source) => {
		await expect(readLogSource(source)).rejects.toThrow('Not a file log source');
	});

	it('answers an unchanged file without its text, and a changed one with it', async () => {
		fs.writeFileSync(logFile, 'one\n');
		const first = await readLogSource('model-server');
		const known = { size: first.size, mtimeMs: first.mtimeMs };

		const again = await readLogSource('model-server', { known });
		expect(again).toMatchObject({ unchanged: true, text: '', exists: true });

		fs.appendFileSync(logFile, 'two\n');
		const grown = await readLogSource('model-server', { known });
		expect(grown.unchanged).toBeUndefined();
		expect(grown.text).toBe('one\ntwo\n');
	});

	it('clamps the byte budget', async () => {
		fs.writeFileSync(logFile, 'first\nsecond\n');
		const read = await readLogSource('model-server', { maxBytes: 7 });
		expect(read.text).toBe('second\n');
		expect(read.truncated).toBe(true);

		// A nonsense budget falls back to the default, which holds the whole file.
		const whole = await readLogSource('model-server', { maxBytes: -1 });
		expect(whole.text).toBe('first\nsecond\n');
	});
});
