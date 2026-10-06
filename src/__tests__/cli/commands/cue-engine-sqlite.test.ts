/**
 * Under plain Node a dev checkout's `better-sqlite3` is built for Electron's
 * ABI and refuses to load. `cue engine start` must report that as one line
 * (or `SQLITE_NATIVE_UNAVAILABLE` under --json) and exit 1 before taking the
 * lock or building an engine - not as a raw multi-line dlopen dump.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ABI_MESSAGE =
	"The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\n" +
	'NODE_MODULE_VERSION 145. This version of Node.js requires\nNODE_MODULE_VERSION 127. Please try re-compiling';

vi.mock('better-sqlite3', () => ({
	default: class {
		constructor() {
			throw Object.assign(new Error(ABI_MESSAGE), { code: 'ERR_DLOPEN_FAILED' });
		}
	},
}));
vi.mock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
	createStandaloneCueEngine: vi.fn(() => {
		throw new Error('the engine must not be created when SQLite cannot load');
	}),
}));

import { createStandaloneCueEngine } from '../../../cli/services/cue-standalone-engine';
import { cueEngineStart } from '../../../cli/commands/cue-engine';

let tmp: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let stderrSpy: MockInstance;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cue-sqlite-')));
	savedUserData = process.env.MAESTRO_USER_DATA;
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cue engine start with an unloadable better-sqlite3', () => {
	it('prints one line naming the ABI mismatch and exits 1', async () => {
		await expect(cueEngineStart({ dataDir: tmp })).rejects.toThrow('__exit__');
		expect(process.exit).toHaveBeenCalledWith(1);
		const failure = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('ABI'));
		expect(failure).toBeDefined();
		expect(failure).not.toContain('\n');
		expect(failure).toContain('module ABI 145');
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(tmp, 'cue.db'))).toBe(false);
	});

	it('reports SQLITE_NATIVE_UNAVAILABLE as the only stdout line under --json', async () => {
		await expect(cueEngineStart({ dataDir: tmp, json: true })).rejects.toThrow('__exit__');
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			success: false,
			code: 'SQLITE_NATIVE_UNAVAILABLE',
		});
	});

	it('logs the data dir and the failure as JSON lines under --log-format json', async () => {
		await expect(cueEngineStart({ dataDir: tmp, logFormat: 'json' })).rejects.toThrow('__exit__');
		const lines = stderrSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
		expect(lines[0]).toMatchObject({
			level: 'info',
			message: `Data directory: ${tmp} (from --data-dir)`,
		});
		expect(lines.at(-1)).toMatchObject({ level: 'error' });
		expect(lines.at(-1).message).toContain('module ABI 145');
		expect(logSpy).not.toHaveBeenCalled();
	});
});
