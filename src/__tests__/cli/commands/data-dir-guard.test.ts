/**
 * Commands that must never act on a GUESSED data directory refuse when it does
 * not exist: the four `cue engine` verbs and `bundle export`.
 *
 * With no MAESTRO_USER_DATA the directory is a guess (an install writes
 * `Maestro`, a dev checkout `maestro` or `maestro-dev`). Before this guard,
 * `cue engine start` created the guessed folder and ran a healthy-looking engine
 * over zero agents, and `stop` / `status` / `inspect` answered "nothing here"
 * from the wrong place. Each now exits 1 with `DATA_DIR_NOT_FOUND`, names the
 * MAESTRO_USER_DATA fix, and creates nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/cue-standalone-engine', () => ({
	createStandaloneCueEngine: vi.fn(() => {
		throw new Error('the engine must not be created for a missing data dir');
	}),
}));

import { createStandaloneCueEngine } from '../../../cli/services/cue-standalone-engine';
import {
	cueEngineInspect,
	cueEngineStart,
	cueEngineStatus,
	cueEngineStop,
} from '../../../cli/commands/cue-engine';
import { bundleExport } from '../../../cli/commands/bundle';

let tmp: string;
let missing: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-data-dir-guard-')));
	missing = path.join(tmp, 'Maestro');
	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = missing;
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const verbs: Array<[string, (json: boolean) => Promise<void>]> = [
	['cue engine start', (json) => cueEngineStart({ json })],
	['cue engine stop', (json) => cueEngineStop({ json })],
	['cue engine status', (json) => cueEngineStatus({ json })],
	['cue engine inspect', (json) => cueEngineInspect({ json })],
	['bundle export', (json) => bundleExport('0.0.0', { pipeline: 'p', json })],
];

describe.each(verbs)('%s with a missing data dir', (_name, run) => {
	it('refuses with exit 1, names MAESTRO_USER_DATA, and creates nothing', async () => {
		await expect(run(false)).rejects.toThrow('__exit__');
		expect(exitSpy.mock.calls[0]).toEqual([1]);
		const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
		expect(stderr).toContain(`not found at ${missing}`);
		expect(stderr).toContain('MAESTRO_USER_DATA');
		expect(fs.existsSync(missing)).toBe(false);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
	});

	it('reports DATA_DIR_NOT_FOUND in JSON', async () => {
		await expect(run(true)).rejects.toThrow('__exit__');
		const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(payload).toMatchObject({ success: false, code: 'DATA_DIR_NOT_FOUND' });
		expect(payload.error).toContain(`not found at ${missing}`);
		expect(fs.existsSync(missing)).toBe(false);
	});
});

describe('a data dir that exists', () => {
	it('lets the verb proceed past the guard', async () => {
		fs.mkdirSync(missing);
		await cueEngineStatus({ json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ running: false });
	});
});
