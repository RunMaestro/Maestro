import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLogger, tuiLogFilePath } from '../logger';

describe('file logger', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-log-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes under <userData>/logs/maestro-tui.log', () => {
		expect(tuiLogFilePath('/data')).toBe(path.join('/data', 'logs', 'maestro-tui.log'));
	});

	it('creates the logs directory and appends one line per call', () => {
		const file = tuiLogFilePath(dir);
		const log = createFileLogger(file, () => new Date('2026-10-04T12:00:00.000Z'));
		log.info('started', 'run', { turn: 1 });
		log.error('boom');
		expect(fs.readFileSync(file, 'utf-8').split('\n')).toEqual([
			'2026-10-04T12:00:00.000Z INFO [run] started {"turn":1}',
			'2026-10-04T12:00:00.000Z ERROR boom',
			'',
		]);
	});

	it('records an Error with its stack', () => {
		const file = tuiLogFilePath(dir);
		createFileLogger(file).warn('failed', undefined, new Error('nope'));
		expect(fs.readFileSync(file, 'utf-8')).toMatch(/WARN failed Error: nope/);
	});
});
