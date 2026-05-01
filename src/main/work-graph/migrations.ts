import type Database from 'better-sqlite3';
import type { Migration, MigrationRecord, MigrationRecordRow } from './types';
import { WORK_GRAPH_READY_TAG_DEFINITION } from '../../shared/work-graph-types';
import {
	CREATE_MIGRATIONS_TABLE_SQL,
	WORK_GRAPH_SCHEMA_SQL,
	WORK_ITEM_SOURCE_CHECK_SQL,
} from './schema';
import { mapMigrationRecordRow, LOG_CONTEXT } from './utils';
import { logger } from '../utils/logger';

export function getMigrations(): Migration[] {
	return [
		{
			version: 1,
			description: 'Initialize Work Graph database lifecycle metadata',
			up: () => {
				// Product Work Graph tables are introduced by later migrations.
			},
		},
		{
			version: 2,
			description: 'Create Work Graph item schema and indexes',
			up: (db) => {
				for (const statement of WORK_GRAPH_SCHEMA_SQL) {
					db.prepare(statement).run();
				}

				const timestamp = new Date().toISOString();
				db.prepare(
					`
						INSERT INTO tag_registry (
							name,
							description,
							color,
							source,
							readonly,
							canonical,
							capabilities_json,
							created_at,
							updated_at
						)
						VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?)
						ON CONFLICT(name) DO UPDATE SET
							description = excluded.description,
							source = excluded.source,
							readonly = excluded.readonly,
							canonical = excluded.canonical,
							updated_at = excluded.updated_at
					`
				).run(
					WORK_GRAPH_READY_TAG_DEFINITION.name,
					WORK_GRAPH_READY_TAG_DEFINITION.description ?? null,
					WORK_GRAPH_READY_TAG_DEFINITION.source,
					WORK_GRAPH_READY_TAG_DEFINITION.readonly ? 1 : 0,
					WORK_GRAPH_READY_TAG_DEFINITION.canonical ? 1 : 0,
					timestamp,
					timestamp
				);
			},
		},
		{
			version: 3,
			description: 'Allow archived Work Graph item status',
			up: (db) => {
				const row = db
					.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_items'")
					.get() as { sql?: string } | undefined;
				if (!row?.sql || row.sql.includes("'archived'")) {
					return;
				}

				const nextSql = row.sql.replace("'done', 'canceled'", "'done', 'archived', 'canceled'");
				if (nextSql === row.sql) {
					throw new Error('Unable to update work_items status CHECK constraint');
				}

				db.pragma('writable_schema = ON');
				try {
					db.prepare(
						"UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'work_items'"
					).run(nextSql);
					const schemaVersionResult = db.pragma('schema_version') as Array<{
						schema_version: number;
					}>;
					const schemaVersion = schemaVersionResult[0]?.schema_version ?? 0;
					db.pragma(`schema_version = ${schemaVersion + 1}`);
				} finally {
					db.pragma('writable_schema = OFF');
				}
			},
		},
		{
			version: 4,
			description: 'Allow source-owned Work Graph importer sources',
			up: (db) => {
				for (const tableName of [
					'work_items',
					'work_item_tags',
					'work_item_sources',
					'tag_registry',
				]) {
					expandSourceCheckConstraint(db, tableName);
				}
			},
		},
		{
			version: 5,
			description: 'Record Work Graph claim source',
			up: (db) => {
				const columns = db.prepare('PRAGMA table_info(work_item_claims)').all() as Array<{
					name: string;
				}>;
				if (columns.some((column) => column.name === 'source')) {
					return;
				}

				db.prepare(
					`
						ALTER TABLE work_item_claims
						ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
						CHECK(source IN ('manual', 'auto-pickup'))
					`
				).run();
			},
		},
		{
			version: 6,
			description: 'Add tracker sync columns to work_items',
			up: (db) => {
				const columns = db.prepare('PRAGMA table_info(work_items)').all() as Array<{
					name: string;
				}>;
				const existing = new Set(columns.map((c) => c.name));

				if (!existing.has('tracker_backend_id')) {
					db.prepare('ALTER TABLE work_items ADD COLUMN tracker_backend_id TEXT').run();
				}
				if (!existing.has('tracker_sync_state')) {
					db.prepare(
						"ALTER TABLE work_items ADD COLUMN tracker_sync_state TEXT NOT NULL DEFAULT 'unsynced'"
					).run();
				}
				if (!existing.has('tracker_external_id')) {
					db.prepare('ALTER TABLE work_items ADD COLUMN tracker_external_id TEXT').run();
				}
				if (!existing.has('tracker_external_url')) {
					db.prepare('ALTER TABLE work_items ADD COLUMN tracker_external_url TEXT').run();
				}
				if (!existing.has('tracker_last_synced_at')) {
					db.prepare('ALTER TABLE work_items ADD COLUMN tracker_last_synced_at INTEGER').run();
				}
				if (!existing.has('tracker_last_error')) {
					db.prepare('ALTER TABLE work_items ADD COLUMN tracker_last_error TEXT').run();
				}
				if (!existing.has('tracker_hash')) {
					db.prepare('ALTER TABLE work_items ADD COLUMN tracker_hash TEXT').run();
				}

				// Backfill any existing rows with a NULL sync state (NOT NULL DEFAULT handles new rows)
				db.prepare(
					"UPDATE work_items SET tracker_sync_state = 'unsynced' WHERE tracker_sync_state IS NULL"
				).run();
			},
		},
	];
}

function expandSourceCheckConstraint(db: Database.Database, tableName: string): void {
	const row = db
		.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName) as { sql?: string } | undefined;
	if (!row?.sql || row.sql.includes("'director-notes'")) {
		return;
	}

	const nextSql = row.sql.replace(/source TEXT NOT NULL CHECK\(source IN \([^)]+\)\)/g, () => {
		return `source TEXT NOT NULL CHECK(source IN (${WORK_ITEM_SOURCE_CHECK_SQL}))`;
	});
	if (nextSql === row.sql) {
		throw new Error(`Unable to update ${tableName} source CHECK constraint`);
	}

	db.pragma('writable_schema = ON');
	try {
		db.prepare('UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?').run(
			nextSql,
			'table',
			tableName
		);
		const schemaVersionResult = db.pragma('schema_version') as Array<{
			schema_version: number;
		}>;
		const schemaVersion = schemaVersionResult[0]?.schema_version ?? 0;
		db.pragma(`schema_version = ${schemaVersion + 1}`);
	} finally {
		db.pragma('writable_schema = OFF');
	}
}

export function runMigrations(db: Database.Database): void {
	db.prepare(CREATE_MIGRATIONS_TABLE_SQL).run();

	const versionResult = db.pragma('user_version') as Array<{ user_version: number }>;
	const currentVersion = versionResult[0]?.user_version ?? 0;
	const pendingMigrations = getMigrations()
		.filter((migration) => migration.version > currentVersion)
		.sort((a, b) => a.version - b.version);

	if (pendingMigrations.length === 0) {
		logger.debug(`Work Graph database is up to date (version ${currentVersion})`, LOG_CONTEXT);
		return;
	}

	logger.info(
		`Running ${pendingMigrations.length} Work Graph migration(s) (current version: ${currentVersion})`,
		LOG_CONTEXT
	);

	for (const migration of pendingMigrations) {
		applyMigration(db, migration);
	}
}

function applyMigration(db: Database.Database, migration: Migration): void {
	const startTime = Date.now();
	logger.info(
		`Applying Work Graph migration v${migration.version}: ${migration.description}`,
		LOG_CONTEXT
	);

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
		logger.info(
			`Work Graph migration v${migration.version} completed in ${Date.now() - startTime}ms`,
			LOG_CONTEXT
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		db.prepare(
			`
				INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
				VALUES (?, ?, ?, 'failed', ?)
			`
		).run(migration.version, migration.description, Date.now(), errorMessage);

		logger.error(`Work Graph migration v${migration.version} failed: ${errorMessage}`, LOG_CONTEXT);
		throw error;
	}
}

export function getMigrationHistory(db: Database.Database): MigrationRecord[] {
	const tableExists = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
		.get();

	if (!tableExists) {
		return [];
	}

	const rows = db
		.prepare(
			`
				SELECT version, description, applied_at, status, error_message
				FROM _migrations
				ORDER BY version ASC
			`
		)
		.all() as MigrationRecordRow[];

	return rows.map(mapMigrationRecordRow);
}

export function getCurrentVersion(db: Database.Database): number {
	const versionResult = db.pragma('user_version') as Array<{ user_version: number }>;
	return versionResult[0]?.user_version ?? 0;
}

export function getTargetVersion(): number {
	const migrations = getMigrations();
	return migrations.length === 0
		? 0
		: Math.max(...migrations.map((migration) => migration.version));
}

export function hasPendingMigrations(db: Database.Database): boolean {
	return getCurrentVersion(db) < getTargetVersion();
}
