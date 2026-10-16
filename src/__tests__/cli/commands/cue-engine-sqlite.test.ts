/**
 * Under plain Node a dev checkout's `better-sqlite3` is built for Electron's
 * ABI and refuses to load. In the bundle the alias's first constructor call
 * throws `SqliteUnavailableError`. `cue engine start` must report its message
 * (or `sqlite_unavailable` under --json) and exit 1 before taking the lock or
 * building an engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const UNAVAILABLE_MESSAGE =
	"Maestro's database module (better-sqlite3) cannot be loaded under Node.js v22.22.1 (NODE_MODULE_VERSION 127).\n" +
	'The better-sqlite3 it found was compiled for NODE_MODULE_VERSION 145.';

vi.mock('better-sqlite3', async () => {
	const { SqliteUnavailableError } = await import('../../../cli/utils/native-sqlite');
	return {
		default: class {
			constructor() {
				throw new SqliteUnavailableError(UNAVAILABLE_MESSAGE, []);
			}
		},
	};
});
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
	it("prints the loader's message and exits 1", async () => {
		await expect(cueEngineStart({ dataDir: tmp })).rejects.toThrow('__exit__');
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(`[Cue] ${UNAVAILABLE_MESSAGE}`);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(tmp, 'cue.db'))).toBe(false);
	});

	it('reports sqlite_unavailable as the only stdout output under --json', async () => {
		await expect(cueEngineStart({ dataDir: tmp, json: true })).rejects.toThrow('__exit__');
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			error: 'sqlite_unavailable',
			message: UNAVAILABLE_MESSAGE,
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
		expect(lines.at(-1).message).toBe(UNAVAILABLE_MESSAGE);
		expect(logSpy).not.toHaveBeenCalled();
	});
});
