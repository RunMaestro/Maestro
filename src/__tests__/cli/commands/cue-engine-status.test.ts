/**
 * @file cue-engine-status.test.ts
 * @description `maestro-cli cue engine status` when the database cannot be opened.
 *
 * Status reads its heartbeat and event count from `cue.db`, read-only (see
 * `readCueDbStatusFigures`). Under a Node whose ABI no better-sqlite3 copy
 * fits, that open throws `SqliteUnavailableError`; the command must print the
 * error's instructions and exit 1, not crash with a stack trace. A database
 * that is missing or unreadable leaves the figures null with a reason, and
 * the lock is still reported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() => ({
		pid: 4242,
		mode: 'standalone',
		startedAt: '2026-09-25T00:00:00.000Z',
	})),
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	readCueDbStatusFigures: vi.fn(),
}));

vi.mock('../../../cli/services/cue-standalone-engine', () => ({
	createStandaloneCueEngine: vi.fn(),
}));

vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	startCueTriggerInbox: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(() => []),
}));

import { cueEngineStatus } from '../../../cli/commands/cue-engine';
import { initCueDb, readCueDbStatusFigures } from '../../../main/cue/cue-db';
import { SqliteUnavailableError } from '../../../cli/utils/native-sqlite';

const UNAVAILABLE = new SqliteUnavailableError(
	"Maestro's database module (better-sqlite3) cannot be loaded under Node.js v22.22.1 (NODE_MODULE_VERSION 127).",
	[]
);

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// `status` refuses a data directory that does not exist, so give it one.
let dataDir: string;
let savedUserData: string | undefined;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cue-status-'));
	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = dataDir;
	vi.mocked(initCueDb).mockReset();
	vi.mocked(readCueDbStatusFigures).mockReset();
	vi.mocked(readCueDbStatusFigures).mockReturnValue({
		ok: true,
		lastHeartbeatMs: null,
		totalEvents: 0,
	});
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errorSpy.mockRestore();
	process.exitCode = undefined;
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cue engine status', () => {
	it('prints the database fix and exits 1 when better-sqlite3 cannot load', async () => {
		vi.mocked(readCueDbStatusFigures).mockImplementation(() => {
			throw UNAVAILABLE;
		});

		await cueEngineStatus();

		expect(errorSpy).toHaveBeenCalledWith(`[Cue] ${UNAVAILABLE.message}`);
		expect(logSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('reports the same failure as JSON with --json', async () => {
		vi.mocked(readCueDbStatusFigures).mockImplementation(() => {
			throw UNAVAILABLE;
		});

		await cueEngineStatus({ json: true });

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			error: 'sqlite_unavailable',
			message: UNAVAILABLE.message,
		});
		expect(process.exitCode).toBe(1);
	});

	it('does not swallow other failures', async () => {
		vi.mocked(readCueDbStatusFigures).mockImplementation(() => {
			throw new Error('disk full');
		});

		await expect(cueEngineStatus()).rejects.toThrow('disk full');
	});

	it('still reports a running engine when the database opens', async () => {
		await cueEngineStatus();

		expect(String(logSpy.mock.calls[0][0])).toContain('[Cue] Running: standalone (pid 4242)');
		expect(process.exitCode).toBeUndefined();
	});

	it('never opens the database through the writer path', async () => {
		await cueEngineStatus({ json: true });

		expect(initCueDb).not.toHaveBeenCalled();
		expect(readCueDbStatusFigures).toHaveBeenCalledTimes(1);
	});

	it('reports the lock and null figures with a reason when cue.db cannot be read', async () => {
		vi.mocked(readCueDbStatusFigures).mockReturnValue({
			ok: false,
			reason: '/data/cue.db does not exist',
		});

		await cueEngineStatus({ json: true });

		expect(logSpy).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(payload).toMatchObject({
			running: true,
			mode: 'standalone',
			pid: 4242,
			startedAt: '2026-09-25T00:00:00.000Z',
			lastHeartbeatMs: null,
			lastHeartbeatAgeMs: null,
			totalEvents: null,
			dbUnavailableReason: '/data/cue.db does not exist',
		});
		expect(process.exitCode).toBeUndefined();
	});

	it('says why the figures are missing in the text output', async () => {
		vi.mocked(readCueDbStatusFigures).mockReturnValue({
			ok: false,
			reason: 'could not read /data/cue.db: unable to open database file',
		});

		await cueEngineStatus();

		const text = String(logSpy.mock.calls[0][0]);
		expect(text).toContain('[Cue] Running: standalone (pid 4242)');
		expect(text).toContain(
			'Database figures unavailable: could not read /data/cue.db: unable to open database file'
		);
		expect(text).not.toContain('Total events recorded');
		expect(process.exitCode).toBeUndefined();
	});
});
