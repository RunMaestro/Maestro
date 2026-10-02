/**
 * @file cue-engine-status.test.ts
 * @description `maestro-cli cue engine status` when the database cannot be opened.
 *
 * Status reads its heartbeat and event count from `cue.db`. Under a Node whose
 * ABI no better-sqlite3 copy fits, that open throws `SqliteUnavailableError`;
 * the command must print the error's instructions and exit 1, not crash with
 * a stack trace.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() => ({
		pid: 4242,
		mode: 'standalone',
		startedAt: '2026-09-25T00:00:00.000Z',
	})),
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	countCueEvents: vi.fn(() => 0),
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
import { initCueDb } from '../../../main/cue/cue-db';
import { SqliteUnavailableError } from '../../../cli/utils/native-sqlite';

const UNAVAILABLE = new SqliteUnavailableError(
	"Maestro's database module (better-sqlite3) cannot be loaded under Node.js v22.22.1 (NODE_MODULE_VERSION 127).",
	[]
);

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.mocked(initCueDb).mockReset();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errorSpy.mockRestore();
	process.exitCode = undefined;
});

describe('cue engine status', () => {
	it('prints the database fix and exits 1 when better-sqlite3 cannot load', async () => {
		vi.mocked(initCueDb).mockImplementation(() => {
			throw UNAVAILABLE;
		});

		await cueEngineStatus();

		expect(errorSpy).toHaveBeenCalledWith(`[Cue] ${UNAVAILABLE.message}`);
		expect(logSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('reports the same failure as JSON with --json', async () => {
		vi.mocked(initCueDb).mockImplementation(() => {
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
		vi.mocked(initCueDb).mockImplementation(() => {
			throw new Error('disk full');
		});

		await expect(cueEngineStatus()).rejects.toThrow('disk full');
	});

	it('still reports a running engine when the database opens', async () => {
		await cueEngineStatus();

		expect(String(logSpy.mock.calls[0][0])).toContain('[Cue] Running: standalone (pid 4242)');
		expect(process.exitCode).toBeUndefined();
	});
});
