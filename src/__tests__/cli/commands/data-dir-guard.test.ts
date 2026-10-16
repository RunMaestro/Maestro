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

vi.mock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
	createStandaloneCueEngine: vi.fn(() => {
		throw new Error('the engine must not be created for a missing data dir');
	}),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(() => {
		throw new Error('cue trigger must not reach the desktop for a missing data dir');
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
import { cueTrigger } from '../../../cli/commands/cue-trigger';
import { withMaestroClient } from '../../../cli/services/maestro-client';

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

/**
 * `--data-dir <path>` names the folder explicitly. It wins over an inherited
 * MAESTRO_USER_DATA (the operator typed that path), and a missing folder is
 * still refused rather than created - a typo must not provision an empty data
 * directory beside the real one.
 */
const flagVerbs: Array<[string, (dataDir: string, json: boolean) => Promise<void>]> = [
	['cue engine start', (dataDir, json) => cueEngineStart({ dataDir, json })],
	['cue engine stop', (dataDir, json) => cueEngineStop({ dataDir, json })],
	['cue engine status', (dataDir, json) => cueEngineStatus({ dataDir, json })],
	['cue engine inspect', (dataDir, json) => cueEngineInspect({ dataDir, json })],
	['cue trigger', (dataDir, json) => cueTrigger('sub', { dataDir, json })],
];

describe.each(flagVerbs)('%s --data-dir', (_name, run) => {
	it('refuses a missing folder with DATA_DIR_NOT_FOUND, even when MAESTRO_USER_DATA exists', async () => {
		const real = path.join(tmp, 'real');
		fs.mkdirSync(real);
		process.env.MAESTRO_USER_DATA = real;
		const typo = path.join(tmp, 'typo');

		await expect(run(typo, true)).rejects.toThrow('__exit__');
		expect(exitSpy.mock.calls[0]).toEqual([1]);
		const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(payload).toMatchObject({ success: false, code: 'DATA_DIR_NOT_FOUND' });
		expect(payload.error).toContain(`not found at ${typo}`);
		expect(fs.existsSync(typo)).toBe(false);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});

describe('--data-dir precedence', () => {
	it('wins over MAESTRO_USER_DATA, which is left pointing at the flag for every reader', async () => {
		// The env names a folder that does not exist; the flag names one that does.
		const real = path.join(tmp, 'real');
		fs.mkdirSync(real);
		await cueEngineStatus({ dataDir: real, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ running: false });
		expect(process.env.MAESTRO_USER_DATA).toBe(real);
	});

	it('resolves a relative path against the working directory', async () => {
		const real = path.join(tmp, 'rel');
		fs.mkdirSync(real);
		vi.spyOn(process, 'cwd').mockReturnValue(tmp);
		await cueEngineStatus({ dataDir: 'rel', json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(process.env.MAESTRO_USER_DATA).toBe(real);
	});
});
