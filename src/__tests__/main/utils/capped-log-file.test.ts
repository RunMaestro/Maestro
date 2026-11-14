/**
 * @file capped-log-file.test.ts
 *
 * The capped log against a real folder: it appends across opens, moves the file
 * to `.1` when a write would pass the cap (replacing the one before, so two
 * files at most), keeps the newest part of a chunk larger than the cap, and
 * turns a failure into one report and silence rather than a throw. Reading
 * the tail joins the previous file to the current one within a byte budget and
 * never starts on half a line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	CAPPED_LOG_PREVIOUS_SUFFIX,
	openCappedLogFile,
	readCappedLogTail,
	statCappedLog,
} from '../../../main/utils/capped-log-file';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capped-log-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const read = (file: string): string => fs.readFileSync(file, 'utf8');

describe('openCappedLogFile', () => {
	it('creates the folder and appends what it is given, text or bytes', () => {
		const file = path.join(dir, 'logs', 'server.log');
		const log = openCappedLogFile(file, { maxBytes: 1024 });
		log.write('one\n');
		log.write(Buffer.from('two\n'));
		log.close();

		expect(read(file)).toBe('one\ntwo\n');
	});

	it('continues an existing file when opened again', () => {
		const file = path.join(dir, 'server.log');
		const first = openCappedLogFile(file, { maxBytes: 1024 });
		first.write('first run\n');
		first.close();
		const second = openCappedLogFile(file, { maxBytes: 1024 });
		second.write('second run\n');
		second.close();

		expect(read(file)).toBe('first run\nsecond run\n');
	});

	it('moves the file aside when a write would pass the cap, keeping two files at most', () => {
		const file = path.join(dir, 'server.log');
		const log = openCappedLogFile(file, { maxBytes: 10 });
		log.write('aaaaaaaa\n'); // 9 bytes
		log.write('bbbbbbbb\n'); // would make 18: rotates first
		log.write('cccccccc\n'); // rotates again, replacing the first file

		log.close();
		expect(read(file)).toBe('cccccccc\n');
		expect(read(file + CAPPED_LOG_PREVIOUS_SUFFIX)).toBe('bbbbbbbb\n');
		expect(fs.readdirSync(dir).sort()).toEqual([
			'server.log',
			`server.log${CAPPED_LOG_PREVIOUS_SUFFIX}`,
		]);
	});

	it('keeps the newest part of a chunk larger than the cap', () => {
		const file = path.join(dir, 'server.log');
		const log = openCappedLogFile(file, { maxBytes: 4 });
		log.write('0123456789');
		log.close();

		expect(read(file)).toBe('6789');
	});

	it('drops writes after close', () => {
		const file = path.join(dir, 'server.log');
		const log = openCappedLogFile(file, { maxBytes: 1024 });
		log.write('kept\n');
		log.close();
		log.write('dropped\n');
		log.close();

		expect(read(file)).toBe('kept\n');
	});

	it('reports a file it cannot open once, and never throws', () => {
		// A regular file where the folder should be.
		const blocker = path.join(dir, 'not-a-folder');
		fs.writeFileSync(blocker, '');
		const onError = vi.fn();
		const log = openCappedLogFile(path.join(blocker, 'server.log'), { onError });

		expect(() => log.write('lost\n')).not.toThrow();
		log.write('lost too\n');
		expect(onError).toHaveBeenCalledTimes(1);
	});
});

describe('readCappedLogTail', () => {
	it('reports a log that was never written', async () => {
		const tail = await readCappedLogTail(path.join(dir, 'none.log'), 1024);
		expect(tail).toEqual({ exists: false, text: '', truncated: false, size: 0, mtimeMs: 0 });
	});

	it('returns a small file whole, with its stamp', async () => {
		const file = path.join(dir, 'server.log');
		fs.writeFileSync(file, 'one\ntwo\n');

		const tail = await readCappedLogTail(file, 1024);
		expect(tail.exists).toBe(true);
		expect(tail.text).toBe('one\ntwo\n');
		expect(tail.truncated).toBe(false);
		expect(tail.size).toBe(8);
		expect(tail.mtimeMs).toBe(fs.statSync(file).mtimeMs);
	});

	it('keeps the newest bytes and starts on a whole line', async () => {
		const file = path.join(dir, 'server.log');
		fs.writeFileSync(file, 'first line\nsecond\nthird\n');

		const tail = await readCappedLogTail(file, 12);
		expect(tail.text).toBe('third\n');
		expect(tail.truncated).toBe(true);
	});

	it('keeps a whole line when the cut falls right after a newline', async () => {
		const file = path.join(dir, 'server.log');
		fs.writeFileSync(file, 'first line\nsecond\nthird\n');

		// The last 13 bytes are exactly "second\nthird\n".
		const tail = await readCappedLogTail(file, 13);
		expect(tail.text).toBe('second\nthird\n');
	});

	it('puts the end of the previous file before the current one', async () => {
		const file = path.join(dir, 'server.log');
		fs.writeFileSync(file + CAPPED_LOG_PREVIOUS_SUFFIX, 'old one\nold two\n');
		fs.writeFileSync(file, 'new\n');

		const whole = await readCappedLogTail(file, 1024);
		expect(whole.text).toBe('old one\nold two\nnew\n');
		expect(whole.truncated).toBe(false);
		expect(whole.size).toBe(4);

		const cut = await readCappedLogTail(file, 12);
		expect(cut.text).toBe('old two\nnew\n');
		expect(cut.truncated).toBe(true);
	});

	it('leaves the previous file out when the current one fills the budget', async () => {
		const file = path.join(dir, 'server.log');
		fs.writeFileSync(file + CAPPED_LOG_PREVIOUS_SUFFIX, 'old\n');
		fs.writeFileSync(file, 'new\n');

		const tail = await readCappedLogTail(file, 4);
		expect(tail.text).toBe('new\n');
		expect(tail.truncated).toBe(true);
	});

	it('reads a log that only has a previous file', async () => {
		const file = path.join(dir, 'server.log');
		fs.writeFileSync(file + CAPPED_LOG_PREVIOUS_SUFFIX, 'old\n');

		const tail = await readCappedLogTail(file, 1024);
		expect(tail.exists).toBe(true);
		expect(tail.text).toBe('old\n');
		expect(tail.size).toBe(0);
	});
});

describe('statCappedLog', () => {
	it('is null for a missing file and the stamp otherwise', async () => {
		const file = path.join(dir, 'server.log');
		expect(await statCappedLog(file)).toBeNull();
		fs.writeFileSync(file, 'x');
		expect(await statCappedLog(file)).toEqual({ size: 1, mtimeMs: fs.statSync(file).mtimeMs });
	});
});
