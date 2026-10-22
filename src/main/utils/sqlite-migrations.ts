/**
 * Versioned schema migrations for a better-sqlite3 database.
 *
 * One runner for every SQLite file Maestro owns that evolves its schema
 * (`stats.db`, `embeddings.db`). Each database supplies its own ordered list of
 * migrations; the bookkeeping is the same everywhere:
 *
 * 1. Create the `_migrations` table if it does not exist.
 * 2. Read the schema version from the `user_version` pragma.
 * 3. Re-apply already-covered migrations whose schema is missing.
 * 4. Run each pending migration in its own transaction.
 * 5. Record each one in `_migrations` and advance `user_version`.
 *
 * It lives in `utils/` rather than under `stats/` because the runner knows
 * nothing about any one schema. A second copy would drift on exactly the parts
 * that are easy to get subtly wrong: recording a failure outside the rolled
 * back transaction, and repairing a version number that lies.
 */

import type Database from 'better-sqlite3';
import { logger } from './logger';

/**
 * One step of a database's schema history.
 */
export interface SqliteMigration {
	/** Version number (must be sequential starting from 1) */
	version: number;
	/** Human-readable description of the migration */
	description: string;
	/** Function to apply the migration */
	up: (db: Database.Database) => void;
	/**
	 * Whether the migration's schema is actually present. When set, a database
	 * whose user_version already covers this migration but lacks its schema gets
	 * `up` re-applied, so `up` must be idempotent.
	 */
	isApplied?: (db: Database.Database) => boolean;
}

/** The only table created outside the migration system. */
export const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
    error_message TEXT
  )
`;

/**
 * The schema version a database reports (0 for a fresh file).
 */
export function sqliteUserVersion(db: Database.Database): number {
	const versionResult = db.pragma('user_version') as Array<{ user_version: number }>;
	return versionResult[0]?.user_version ?? 0;
}

/**
 * Bring a database up to the newest migration in `migrations`.
 *
 * Throws when a migration fails, after recording the failure. The caller
 * decides what a database that cannot be migrated means for its feature.
 */
export function runSqliteMigrations(
	db: Database.Database,
	migrations: SqliteMigration[],
	logContext: string
): void {
	db.prepare(CREATE_MIGRATIONS_TABLE_SQL).run();

	const currentVersion = sqliteUserVersion(db);
	repairSkippedMigrations(db, migrations, currentVersion, logContext);

	const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

	if (pendingMigrations.length === 0) {
		logger.debug(`Database is up to date (version ${currentVersion})`, logContext);
		return;
	}

	// Sort by version to ensure sequential execution
	pendingMigrations.sort((a, b) => a.version - b.version);

	logger.info(
		`Running ${pendingMigrations.length} pending migration(s) (current version: ${currentVersion})`,
		logContext
	);

	for (const migration of pendingMigrations) {
		applyMigration(db, migration, logContext);
	}
}

/**
 * Re-apply migrations the version check says ran but whose schema is missing.
 *
 * user_version is a bare number, and it only means the same thing on every
 * branch up to stats v7. Past that, rc and main number their migrations
 * differently, so a database last opened by an rc build can report a version
 * that covers a main migration it never ran. Every write that touches the
 * missing schema then fails, e.g. `table query_events has no column named
 * input_tokens` on each query event (MAESTRO-113/114). Only migrations that
 * declare `isApplied` are checked, and their bodies are idempotent.
 * user_version is left alone.
 */
function repairSkippedMigrations(
	db: Database.Database,
	migrations: SqliteMigration[],
	currentVersion: number,
	logContext: string
): void {
	for (const migration of migrations) {
		if (migration.version > currentVersion || !migration.isApplied) continue;
		if (migration.isApplied(db)) continue;

		logger.warn(
			`Re-applying migration v${migration.version} (schema missing at version ${currentVersion}): ${migration.description}`,
			logContext
		);
		db.transaction(() => migration.up(db))();
	}
}

/**
 * Apply a single migration within a transaction.
 * Records the migration in the _migrations table with success/failure status.
 */
function applyMigration(
	db: Database.Database,
	migration: SqliteMigration,
	logContext: string
): void {
	const startTime = Date.now();
	logger.info(`Applying migration v${migration.version}: ${migration.description}`, logContext);

	try {
		const runMigrationTxn = db.transaction(() => {
			migration.up(db);

			db.prepare(
				`
        INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
        VALUES (?, ?, ?, 'success', NULL)
      `
			).run(migration.version, migration.description, Date.now());

			db.pragma(`user_version = ${migration.version}`);
		});

		runMigrationTxn();

		const duration = Date.now() - startTime;
		logger.info(`Migration v${migration.version} completed in ${duration}ms`, logContext);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		db.prepare(
			`
      INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
      VALUES (?, ?, ?, 'failed', ?)
    `
		).run(migration.version, migration.description, Date.now(), errorMessage);

		logger.error(`Migration v${migration.version} failed: ${errorMessage}`, logContext);
		throw error;
	}
}
