/**
 * Regression tests for stale WAL/SHM sidecar cleanup (MAESTRO-TX).
 *
 * `removeStaleWalFiles` runs before the database is opened so a leftover WAL
 * from a crashed run can't trigger a false corruption verdict. It is
 * best-effort: SQLite recovers from a live WAL on its own, so a failed unlink
 * must not fail startup and must not page us. EBUSY is the normal Windows
 * result when a second instance still holds the database open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
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
	},
}));

const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-stale-wal');
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => mockUserDataPath) },
}));

const mockFsExistsSync = vi.fn(() => true);
const mockFsUnlinkSync = vi.fn();

vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
	mkdirSync: vi.fn(),
	copyFileSync: vi.fn(),
	unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
	renameSync: vi.fn(),
	statSync: vi.fn(() => ({ size: 1024 })),
	readFileSync: vi.fn(() => String(Date.now())),
	writeFileSync: vi.fn(),
	readdirSync: vi.fn(() => [] as string[]),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock('../../../main/stats/migrations', () => ({
	runMigrations: vi.fn(),
	getMigrationHistory: vi.fn(() => []),
	getCurrentVersion: vi.fn(() => 1),
	getTargetVersion: vi.fn(() => 1),
	hasPendingMigrations: vi.fn(() => false),
}));

import { StatsDB } from '../../../main/stats/stats-db';

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: sidecar unlink failed`), { code });
}

describe('stale WAL/SHM sidecar cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFsExistsSync.mockReturnValue(true);
		mockDb.pragma.mockReturnValue([{ integrity_check: 'ok' }] as never);
	});

	it.each(['EBUSY', 'EPERM', 'EACCES', 'EROFS', 'ENOENT'])(
		'does not report %s to Sentry - the sidecar is held or protected, not corrupt',
		(code) => {
			mockFsUnlinkSync.mockImplementation(() => {
				throw errnoError(code);
			});

			const db = new StatsDB();
			expect(() => db.initialize()).not.toThrow();

			expect(mockCaptureException).not.toHaveBeenCalled();
		}
	);

	it('still reports an unexpected sidecar failure to Sentry', () => {
		mockFsUnlinkSync.mockImplementation(() => {
			throw errnoError('EIO');
		});

		const db = new StatsDB();
		db.initialize();

		expect(mockCaptureException).toHaveBeenCalledTimes(1);
		expect(mockCaptureException.mock.calls[0][0]).toMatchObject({ code: 'EIO' });
	});
});
