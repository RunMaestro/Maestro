import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockStatement = {
	run: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	all: ReturnType<typeof vi.fn>;
};

type MockDatabaseInstance = {
	dbPath: string;
	options?: unknown;
	pragma: ReturnType<typeof vi.fn>;
	prepare: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	transaction: ReturnType<typeof vi.fn>;
};

type ConstructorSetup = Error | ((db: MockDatabaseInstance) => void);

const controls = vi.hoisted(() => {
	const createStatement = (): MockStatement => ({
		run: vi.fn(() => ({ changes: 1 })),
		get: vi.fn(() => undefined),
		all: vi.fn(() => []),
	});

	return {
		userDataPath: '/tmp/maestro-stats-core-edges',
		instances: [] as MockDatabaseInstance[],
		constructorSetups: [] as ConstructorSetup[],
		preparedSql: [] as string[],
		createStatement,
		pragmaImpl: undefined as undefined | ((sql: string, db: MockDatabaseInstance) => unknown),
		prepareImpl: undefined as
			undefined | ((sql: string, db: MockDatabaseInstance) => MockStatement),
		fs: {
			existsSync: vi.fn(() => true),
			mkdirSync: vi.fn(),
			copyFileSync: vi.fn(),
			unlinkSync: vi.fn(),
			renameSync: vi.fn(),
			statSync: vi.fn(() => ({ size: 1024 })),
			readdirSync: vi.fn(() => [] as string[]),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		migrations: {
			runMigrations: vi.fn(),
			getMigrationHistory: vi.fn(() => []),
			getCurrentVersion: vi.fn(() => 4),
			getTargetVersion: vi.fn(() => 4),
			hasPendingMigrations: vi.fn(() => false),
		},
		clearQueryEventCache: vi.fn(),
		clearAutoRunCache: vi.fn(),
		clearSessionLifecycleCache: vi.fn(),
	};
});

vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		dbPath: string;
		options?: unknown;
		pragma: ReturnType<typeof vi.fn>;
		prepare: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		transaction: ReturnType<typeof vi.fn>;

		constructor(dbPath: string, options?: unknown) {
			const setup = controls.constructorSetups.shift();
			if (setup instanceof Error) {
				throw setup;
			}

			this.dbPath = dbPath;
			this.options = options;
			this.pragma = vi.fn((sql: string) => {
				if (controls.pragmaImpl) {
					return controls.pragmaImpl(sql, this);
				}
				if (sql === 'integrity_check') {
					return [{ integrity_check: 'ok' }];
				}
				if (sql === 'user_version') {
					return [{ user_version: 4 }];
				}
				return [];
			});
			this.prepare = vi.fn((sql: string) => {
				controls.preparedSql.push(sql);
				if (controls.prepareImpl) {
					return controls.prepareImpl(sql, this);
				}
				return controls.createStatement();
			});
			this.close = vi.fn();
			this.transaction = vi.fn((fn: () => void) => () => fn());

			if (typeof setup === 'function') {
				setup(this);
			}
			controls.instances.push(this);
		}
	},
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => controls.userDataPath),
	},
}));

vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => controls.fs.existsSync(...args),
	mkdirSync: (...args: unknown[]) => controls.fs.mkdirSync(...args),
	copyFileSync: (...args: unknown[]) => controls.fs.copyFileSync(...args),
	unlinkSync: (...args: unknown[]) => controls.fs.unlinkSync(...args),
	renameSync: (...args: unknown[]) => controls.fs.renameSync(...args),
	statSync: (...args: unknown[]) => controls.fs.statSync(...args),
	readdirSync: (...args: unknown[]) => controls.fs.readdirSync(...args),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: controls.logger,
}));

vi.mock('../../../main/stats/migrations', () => controls.migrations);

vi.mock('../../../main/stats/query-events', () => ({
	insertQueryEvent: vi.fn(() => 'query-event-id'),
	getQueryEvents: vi.fn(() => []),
	clearQueryEventCache: controls.clearQueryEventCache,
}));

vi.mock('../../../main/stats/auto-run', () => ({
	insertAutoRunSession: vi.fn(() => 'auto-run-session-id'),
	updateAutoRunSession: vi.fn(() => true),
	getAutoRunSessions: vi.fn(() => []),
	insertAutoRunTask: vi.fn(() => 'auto-run-task-id'),
	getAutoRunTasks: vi.fn(() => []),
	clearAutoRunCache: controls.clearAutoRunCache,
}));

vi.mock('../../../main/stats/session-lifecycle', () => ({
	recordSessionCreated: vi.fn(() => 'session-lifecycle-id'),
	recordSessionClosed: vi.fn(() => true),
	getSessionLifecycleEvents: vi.fn(() => []),
	clearSessionLifecycleCache: controls.clearSessionLifecycleCache,
}));

vi.mock('../../../main/stats/aggregations', () => ({
	getAggregatedStats: vi.fn(() => ({ totalCost: 0 })),
}));

vi.mock('../../../main/stats/data-management', () => ({
	clearOldData: vi.fn(() => ({ success: true })),
	exportToCsv: vi.fn(() => 'csv'),
}));

const dbPath = path.join(controls.userDataPath, 'stats.db');

async function loadStatsDB() {
	const mod = await import('../../../main/stats/stats-db');
	return mod.StatsDB;
}

function resetControls(): void {
	vi.resetModules();
	controls.instances.length = 0;
	controls.constructorSetups.length = 0;
	controls.preparedSql.length = 0;
	controls.pragmaImpl = undefined;
	controls.prepareImpl = undefined;

	for (const fn of Object.values(controls.fs)) {
		fn.mockReset();
	}
	controls.fs.existsSync.mockReturnValue(true);
	controls.fs.statSync.mockReturnValue({ size: 1024 });
	controls.fs.readdirSync.mockReturnValue([]);

	for (const fn of Object.values(controls.logger)) {
		fn.mockClear();
	}
	for (const fn of Object.values(controls.migrations)) {
		fn.mockClear();
	}
	controls.migrations.getMigrationHistory.mockReturnValue([]);
	controls.migrations.getCurrentVersion.mockReturnValue(4);
	controls.migrations.getTargetVersion.mockReturnValue(4);
	controls.migrations.hasPendingMigrations.mockReturnValue(false);
	controls.clearQueryEventCache.mockClear();
	controls.clearAutoRunCache.mockClear();
	controls.clearSessionLifecycleCache.mockClear();
}

describe('StatsDB core lifecycle edge cases', () => {
	beforeEach(() => {
		resetControls();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('propagates initialization failure when corruption recovery cannot open a database', async () => {
		controls.constructorSetups.push((db) => {
			db.pragma.mockImplementation((sql: string) => {
				if (sql === 'integrity_check') {
					throw new Error('cannot open original');
				}
				return [{ user_version: 4 }];
			});
		}, new Error('cannot create replacement'));

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(() => db.initialize()).toThrow('Failed to open or recover database');
		expect(controls.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to initialize stats database'),
			'[StatsDB]'
		);
	});

	it('skips weekly VACUUM when the last run is recent', async () => {
		const selectLastVacuum = controls.createStatement();
		selectLastVacuum.get.mockReturnValue({ value: String(Date.now()) });
		controls.prepareImpl = (sql) =>
			sql.includes("SELECT value FROM _meta WHERE key = 'last_vacuum_at'")
				? selectLastVacuum
				: controls.createStatement();

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(controls.preparedSql).not.toContain('VACUUM');
		expect(controls.logger.debug).toHaveBeenCalledWith(
			expect.stringContaining('Skipping VACUUM'),
			'[StatsDB]'
		);
	});

	it('updates the weekly VACUUM timestamp after vacuuming a large database', async () => {
		const selectLastVacuum = controls.createStatement();
		selectLastVacuum.get.mockReturnValue({ value: '0' });
		const updateLastVacuum = controls.createStatement();
		controls.prepareImpl = (sql) => {
			if (sql.includes("SELECT value FROM _meta WHERE key = 'last_vacuum_at'")) {
				return selectLastVacuum;
			}
			if (sql.includes("INSERT OR REPLACE INTO _meta (key, value) VALUES ('last_vacuum_at', ?)")) {
				return updateLastVacuum;
			}
			return controls.createStatement();
		};
		controls.fs.statSync.mockReturnValue({ size: 101 * 1024 * 1024 });

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(controls.preparedSql).toContain('VACUUM');
		expect(updateLastVacuum.run).toHaveBeenCalledWith(expect.any(String));
	});

	it('reports integrity states for uninitialized, healthy, corrupt, and throwing databases', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(db.checkIntegrity()).toEqual({
			ok: false,
			errors: ['Database not initialized'],
		});

		db.initialize();
		expect(db.checkIntegrity()).toEqual({ ok: true, errors: [] });

		const activeDb = controls.instances.at(-1)!;
		activeDb.pragma.mockReturnValueOnce([
			{ integrity_check: 'row 1 missing from index' },
			{ integrity_check: 'wrong page count' },
		]);
		expect(db.checkIntegrity()).toEqual({
			ok: false,
			errors: ['row 1 missing from index', 'wrong page count'],
		});

		activeDb.pragma.mockImplementationOnce(() => {
			throw 'pragma exploded';
		});
		expect(db.checkIntegrity()).toEqual({ ok: false, errors: ['pragma exploded'] });
	});

	it('returns backup failures for missing database files and copy errors', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		controls.fs.existsSync.mockImplementation((target: unknown) => target !== dbPath);
		expect(db.backupDatabase()).toEqual({
			success: false,
			error: 'Database file does not exist',
		});

		controls.fs.existsSync.mockReturnValue(true);
		controls.fs.copyFileSync.mockImplementationOnce(() => {
			throw new Error('disk full');
		});
		expect(db.backupDatabase()).toEqual({ success: false, error: 'disk full' });
	});

	it('continues initialization when daily backup creation fails', async () => {
		const today = new Date().toISOString().split('T')[0];
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.includes(`daily.${today}`)) return false;
			return true;
		});
		controls.fs.copyFileSync.mockImplementationOnce(() => {
			throw new Error('backup volume unavailable');
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(() => db.initialize()).not.toThrow();
		expect(db.isReady()).toBe(true);
		expect(controls.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to create daily backup'),
			'[StatsDB]'
		);
	});

	it('rotates only daily backups older than the retention cutoff', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-02-10T12:00:00Z'));
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.endsWith('-wal') || value.endsWith('-shm')) return false;
			if (value.includes('daily.2026-02-10')) return false;
			return true;
		});
		controls.fs.readdirSync.mockReturnValue([
			'stats.db.daily.2026-01-31',
			'stats.db.daily.2026-02-06',
			'not-a-backup.txt',
		]);

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(controls.fs.unlinkSync).toHaveBeenCalledWith(
			path.join(controls.userDataPath, 'stats.db.daily.2026-01-31')
		);
		expect(controls.fs.unlinkSync).not.toHaveBeenCalledWith(
			path.join(controls.userDataPath, 'stats.db.daily.2026-02-06')
		);
	});

	it('returns an empty backup list when backup directory listing fails', async () => {
		controls.fs.readdirSync.mockImplementation(() => {
			throw new Error('permission denied');
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(db.getAvailableBackups()).toEqual([]);
	});

	it('restores a backup even when closing the current database throws', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();
		controls.instances.at(-1)!.close.mockImplementationOnce(() => {
			throw new Error('already closed');
		});

		expect(db.restoreFromBackup('/tmp/backup.db')).toBe(true);
		expect(controls.fs.copyFileSync).toHaveBeenCalledWith('/tmp/backup.db', dbPath);
	});

	it('returns false when restore cleanup or copy fails', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();
		controls.fs.copyFileSync.mockImplementationOnce(() => {
			throw new Error('copy failed');
		});

		expect(db.restoreFromBackup('/tmp/backup.db')).toBe(false);
		expect(controls.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to restore from backup'),
			'[StatsDB]'
		);
	});

	it('restores from the latest valid backup during corruption recovery', async () => {
		controls.constructorSetups.push(
			(db) => {
				db.pragma.mockImplementation((sql: string) => {
					if (sql === 'integrity_check') return [{ integrity_check: 'bad root page' }];
					return [{ user_version: 4 }];
				});
			},
			(db) => {
				db.pragma.mockImplementation((sql: string) => {
					if (sql === 'integrity_check') return [{ integrity_check: 'ok' }];
					return [{ user_version: 4 }];
				});
			}
		);
		controls.fs.readdirSync.mockReturnValue(['stats.db.daily.2026-02-08']);

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(controls.fs.copyFileSync).toHaveBeenCalledWith(
			path.join(controls.userDataPath, 'stats.db.daily.2026-02-08'),
			dbPath
		);
		expect(db.isReady()).toBe(true);
	});

	it('skips invalid and unreadable backups before creating a replacement database', async () => {
		controls.constructorSetups.push(
			(db) => {
				db.pragma.mockImplementation((sql: string) => {
					if (sql === 'integrity_check') return [{ integrity_check: 'corrupt original' }];
					return [{ user_version: 4 }];
				});
			},
			(db) => {
				db.pragma.mockImplementation((sql: string) => {
					if (sql === 'integrity_check') return [{ integrity_check: 'corrupt backup' }];
					return [{ user_version: 4 }];
				});
			},
			new Error('backup unreadable')
		);
		controls.fs.readdirSync.mockReturnValue([
			'stats.db.daily.2026-02-08',
			'stats.db.daily.2026-02-07',
		]);

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(db.isReady()).toBe(true);
		expect(controls.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('failed integrity check'),
			'[StatsDB]'
		);
		expect(controls.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('is unreadable'),
			'[StatsDB]'
		);
	});

	it('logs recovery failure and still opens a replacement when corruption cleanup fails', async () => {
		controls.constructorSetups.push((db) => {
			db.pragma.mockImplementation((sql: string) => {
				if (sql === 'integrity_check') return [{ integrity_check: 'corrupt original' }];
				return [{ user_version: 4 }];
			});
		});
		controls.fs.renameSync.mockImplementationOnce(() => {
			throw new Error('rename denied');
		});
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.endsWith('-wal') || value.endsWith('-shm')) return false;
			return true;
		});
		controls.fs.unlinkSync.mockImplementationOnce(() => {
			throw new Error('unlink denied');
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(db.isReady()).toBe(true);
		expect(controls.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to recover from database corruption'),
			'[StatsDB]'
		);
		expect(controls.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Database corruption recovery failed'),
			'[StatsDB]'
		);
	});

	it('continues opening when stale WAL cleanup fails', async () => {
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.endsWith('-wal')) return true;
			return true;
		});
		controls.fs.unlinkSync.mockImplementationOnce(() => {
			throw new Error('wal locked');
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(db.isReady()).toBe(true);
		expect(controls.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to remove stale WAL/SHM files'),
			'[StatsDB]'
		);
	});

	it('returns earliest timestamp across stats tables and null for empty or failed queries', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		controls.prepareImpl = (sql) => {
			const statement = controls.createStatement();
			statement.get.mockReturnValue(
				sql.includes('query_events')
					? { earliest: 300 }
					: sql.includes('auto_run_sessions')
						? { earliest: 100 }
						: { earliest: 200 }
			);
			return statement;
		};
		expect(db.getEarliestTimestamp()).toBe(100);

		controls.prepareImpl = () => {
			const statement = controls.createStatement();
			statement.get.mockReturnValue({ earliest: null });
			return statement;
		};
		expect(db.getEarliestTimestamp()).toBeNull();

		controls.prepareImpl = () => {
			throw new Error('stats table missing');
		};
		expect(db.getEarliestTimestamp()).toBeNull();
	});

	it('handles database size and VACUUM failure paths', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(db.vacuum()).toEqual({
			success: false,
			bytesFreed: 0,
			error: 'Database not initialized',
		});

		db.initialize();
		controls.fs.statSync.mockImplementationOnce(() => {
			throw new Error('stat failed');
		});
		expect(db.getDatabaseSize()).toBe(0);

		controls.prepareImpl = (sql) => {
			const statement = controls.createStatement();
			if (sql === 'VACUUM') {
				statement.run.mockImplementationOnce(() => {
					throw 'vacuum failed';
				});
			}
			return statement;
		};

		expect(db.vacuum()).toEqual({
			success: false,
			bytesFreed: 0,
			error: 'vacuum failed',
		});

		controls.prepareImpl = (sql) => {
			const statement = controls.createStatement();
			if (sql === 'VACUUM') {
				statement.run.mockImplementationOnce(() => {
					throw new Error('vacuum error');
				});
			}
			return statement;
		};

		expect(db.vacuum()).toEqual({
			success: false,
			bytesFreed: 0,
			error: 'vacuum error',
		});
	});

	it('logs and continues when weekly VACUUM schedule lookup fails', async () => {
		controls.prepareImpl = (sql) => {
			if (sql.includes("SELECT value FROM _meta WHERE key = 'last_vacuum_at'")) {
				throw new Error('meta table unavailable');
			}
			return controls.createStatement();
		};

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(() => db.initialize()).not.toThrow();
		expect(controls.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to check/update VACUUM schedule'),
			'[StatsDB]'
		);
	});

	it('logs and continues when rotating daily backups fails', async () => {
		const today = new Date().toISOString().split('T')[0];
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.includes(`daily.${today}`)) return false;
			return true;
		});
		controls.fs.readdirSync.mockImplementation(() => {
			throw new Error('directory locked');
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(() => db.initialize()).not.toThrow();
		expect(controls.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to rotate old backups'),
			'[StatsDB]'
		);
	});

	it('restores without deleting absent WAL, SHM, or current database files', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();
		controls.fs.unlinkSync.mockClear();
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value === '/tmp/backup.db') return true;
			if (value === dbPath || value.endsWith('-wal') || value.endsWith('-shm')) return false;
			return true;
		});

		expect(db.restoreFromBackup('/tmp/backup.db')).toBe(true);
		expect(controls.fs.unlinkSync).not.toHaveBeenCalled();
	});

	it('falls back to fresh recovery when a valid backup cannot be restored', async () => {
		controls.constructorSetups.push(
			(db) => {
				db.pragma.mockImplementation((sql: string) => {
					if (sql === 'integrity_check') return [{ integrity_check: 'corrupt original' }];
					return [{ user_version: 4 }];
				});
			},
			(db) => {
				db.pragma.mockImplementation((sql: string) => {
					if (sql === 'integrity_check') return [{ integrity_check: 'ok' }];
					return [{ user_version: 4 }];
				});
			}
		);
		controls.fs.readdirSync.mockReturnValue(['stats.db.daily.2026-02-08']);
		controls.fs.copyFileSync.mockImplementationOnce(() => {
			throw new Error('restore copy failed');
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(db.isReady()).toBe(true);
		expect(controls.logger.warn).toHaveBeenCalledWith(
			'No valid backup found, will create fresh database',
			'[StatsDB]'
		);
	});

	it('creates a fresh replacement when corruption recovery leaves no database file', async () => {
		controls.constructorSetups.push((db) => {
			db.pragma.mockImplementation((sql: string) => {
				if (sql === 'integrity_check') return [{ integrity_check: 'corrupt original' }];
				return [{ user_version: 4 }];
			});
		});
		controls.fs.readdirSync.mockReturnValue([]);
		let dbPathChecks = 0;
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.endsWith('-wal') || value.endsWith('-shm')) return false;
			if (value === dbPath) {
				dbPathChecks++;
				return dbPathChecks === 1;
			}
			return true;
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(db.isReady()).toBe(true);
		expect(controls.logger.info).toHaveBeenCalledWith(
			'Fresh database created after corruption recovery',
			'[StatsDB]'
		);
	});

	it('stringifies non-Error corruption recovery failures', async () => {
		controls.constructorSetups.push((db) => {
			db.pragma.mockImplementation((sql: string) => {
				if (sql === 'integrity_check') return [{ integrity_check: 'corrupt original' }];
				return [{ user_version: 4 }];
			});
		});
		controls.fs.existsSync.mockImplementation((target: unknown) => {
			const value = String(target);
			if (value.endsWith('-wal') || value.endsWith('-shm')) return false;
			return true;
		});
		controls.fs.renameSync.mockImplementationOnce(() => {
			throw new Error('rename denied');
		});
		controls.fs.unlinkSync.mockImplementationOnce(() => {
			throw 'unlink denied';
		});

		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();

		expect(controls.logger.error).toHaveBeenCalledWith(
			'Failed to recover from database corruption: unlink denied',
			'[StatsDB]'
		);
	});

	it('delegates auto-run, session lifecycle, clear, and export APIs once initialized', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		expect(db.clearOldData(30)).toEqual({
			success: false,
			deletedQueryEvents: 0,
			deletedAutoRunSessions: 0,
			deletedAutoRunTasks: 0,
			deletedSessionLifecycle: 0,
			error: 'Database not initialized',
		});

		db.initialize();

		expect(db.insertAutoRunSession({} as never)).toBe('auto-run-session-id');
		expect(db.updateAutoRunSession('auto-run-session-id', {})).toBe(true);
		expect(db.getAutoRunSessions('day')).toEqual([]);
		expect(db.insertAutoRunTask({} as never)).toBe('auto-run-task-id');
		expect(db.getAutoRunTasks('auto-run-session-id')).toEqual([]);
		expect(db.recordSessionCreated({} as never)).toBe('session-lifecycle-id');
		expect(db.recordSessionClosed('session-id', 123)).toBe(true);
		expect(db.getSessionLifecycleEvents('day')).toEqual([]);
		expect(db.clearOldData(30)).toEqual({ success: true });
		expect(db.exportToCsv('day')).toBe('csv');
	});

	it('covers backup and integrity Error/string fallback branches', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();
		db.initialize();
		const activeDb = controls.instances.at(-1)!;

		activeDb.pragma.mockImplementationOnce(() => {
			throw new Error('integrity failed');
		});
		expect(db.checkIntegrity()).toEqual({
			ok: false,
			errors: ['integrity failed'],
		});

		controls.fs.copyFileSync.mockImplementationOnce(() => {
			throw 'copy failed';
		});
		expect(db.backupDatabase()).toEqual({ success: false, error: 'copy failed' });
	});

	it('backs up without checkpointing when no database connection is open', async () => {
		const StatsDB = await loadStatsDB();
		const db = new StatsDB();

		const result = db.backupDatabase();

		expect(result.success).toBe(true);
		expect(controls.fs.copyFileSync).toHaveBeenCalledWith(
			dbPath,
			expect.stringContaining(`${dbPath}.backup.`)
		);
		expect(controls.instances).toHaveLength(0);
	});
});
