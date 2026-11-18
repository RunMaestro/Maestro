/**
 * Regression tests: only SQLite corruption moves stats.db aside.
 *
 * A packaged build shipped a better-sqlite3 addon compiled for plain Node
 * (NODE_MODULE_VERSION 147) inside an Electron that wanted 145. The addon only
 * loads on the first `new Database()`, so the dlopen error surfaced from the
 * open of a healthy stats.db, was treated as corruption, and the user's whole
 * history was renamed to `stats.db.corrupted.<ts>`. The Usage Dashboard then
 * showed "Failed to load usage data".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const mockOpen = vi.fn();
const mockDb = {
	pragma: vi.fn(() => [{ integrity_check: 'ok' }]),
	prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
	close: vi.fn(),
	transaction: vi.fn((fn: () => void) => () => fn()),
};

vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		pragma = mockDb.pragma;
		prepare = mockDb.prepare;
		close = mockDb.close;
		transaction = mockDb.transaction;
		constructor(dbPath: string) {
			mockOpen(dbPath);
		}
	},
}));

const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-open-failure');
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => mockUserDataPath) },
}));

const mockRenameSync = vi.fn();
vi.mock('fs', () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	copyFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	renameSync: (...args: unknown[]) => mockRenameSync(...args),
	statSync: vi.fn(() => ({ size: 1024 })),
	readFileSync: vi.fn(() => String(Date.now())),
	writeFileSync: vi.fn(),
	readdirSync: vi.fn(() => [] as string[]),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../main/stats/migrations', () => ({
	runMigrations: vi.fn(),
	getMigrationHistory: vi.fn(() => []),
	getCurrentVersion: vi.fn(() => 1),
	getTargetVersion: vi.fn(() => 1),
	hasPendingMigrations: vi.fn(() => false),
}));

import { StatsDB } from '../../../main/stats/stats-db';

const dbPath = path.join(mockUserDataPath, 'stats.db');

function codedError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

function movedAside(): boolean {
	return mockRenameSync.mock.calls.some(
		([from, to]) => from === dbPath && String(to).startsWith(`${dbPath}.corrupted.`)
	);
}

describe('StatsDB open failure classification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ integrity_check: 'ok' }] as never);
	});

	it('leaves a healthy stats.db in place when the native addon fails to load', () => {
		const dlopen = codedError(
			'was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 145.',
			'ERR_DLOPEN_FAILED'
		);
		mockOpen.mockImplementation(() => {
			throw dlopen;
		});

		const db = new StatsDB();
		expect(() => db.initialize()).toThrow(dlopen);
		expect(movedAside()).toBe(false);
		expect(db.isReady()).toBe(false);
	});

	it('leaves stats.db in place on a lock error from the integrity check', () => {
		mockOpen.mockImplementation(() => undefined);
		mockDb.pragma.mockImplementationOnce(() => {
			throw codedError('database is locked', 'SQLITE_BUSY');
		});

		const db = new StatsDB();
		expect(() => db.initialize()).toThrow('database is locked');
		expect(movedAside()).toBe(false);
		// The handle opened before the pragma threw is not leaked.
		expect(mockDb.close).toHaveBeenCalledOnce();
	});

	it('still moves a corrupt stats.db aside and opens a fresh one', () => {
		mockOpen.mockImplementationOnce(() => {
			throw codedError('file is not a database', 'SQLITE_NOTADB');
		});
		mockOpen.mockImplementation(() => undefined);

		const db = new StatsDB();
		db.initialize();
		expect(movedAside()).toBe(true);
		expect(db.isReady()).toBe(true);
	});
});
