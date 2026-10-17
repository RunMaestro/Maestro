/**
 * @file capped-log-file.test.ts
 *
 * The capped log against a real folder: it appends across opens, moves the file
 * to `.1` when a write would pass the cap (replacing the one before, so two
 * files at most), keeps the newest part of a chunk larger than the cap, and
 * turns a failure into one report and silence rather than a throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CAPPED_LOG_PREVIOUS_SUFFIX, openCappedLogFile } from '../../../main/utils/capped-log-file';

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
