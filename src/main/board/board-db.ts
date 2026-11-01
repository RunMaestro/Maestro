/** Machine-local Board workspace. The CLI bundle supplies its existing SQLite shim. */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BOARD_SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL DEFAULT 0,
  default_start_mode TEXT NOT NULL DEFAULT 'approval', global_wip_limit INTEGER
);
INSERT INTO workspace (id) VALUES (1);
CREATE TABLE collections (
  collection_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, legacy_board_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_key, legacy_board_id)
);
CREATE TABLE cards (
  collection_key TEXT NOT NULL REFERENCES collections(collection_key), id TEXT NOT NULL,
  payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_key, id)
);
CREATE TABLE profiles (
  profile_namespace TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL,
  source_key TEXT NOT NULL, PRIMARY KEY (profile_namespace, id)
);
CREATE TABLE repositories (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE workers (
  agent_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, paused INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, collection_key TEXT NOT NULL, card_id TEXT NOT NULL,
  attempt INTEGER NOT NULL, specification_json TEXT NOT NULL, outcome_json TEXT,
  FOREIGN KEY (collection_key, card_id) REFERENCES cards(collection_key, id),
  UNIQUE (collection_key, card_id, attempt)
);
CREATE TABLE reservations (
  worker_agent_id TEXT PRIMARY KEY REFERENCES workers(agent_id),
  collection_key TEXT NOT NULL, card_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  owner_epoch INTEGER NOT NULL, generation INTEGER NOT NULL, phase TEXT NOT NULL,
  FOREIGN KEY (collection_key, card_id) REFERENCES cards(collection_key, id),
  UNIQUE (collection_key, card_id)
);
CREATE TABLE runtime_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1), process_identity TEXT NOT NULL,
  epoch INTEGER NOT NULL, heartbeat INTEGER NOT NULL
);
CREATE TABLE migrations (
  source_key TEXT PRIMARY KEY, hashes_json TEXT NOT NULL, snapshot BLOB NOT NULL,
  mapping_json TEXT NOT NULL, committed_at INTEGER NOT NULL
);
CREATE TABLE commands (
  request_id TEXT PRIMARY KEY, principal TEXT NOT NULL, result_json TEXT NOT NULL, revision INTEGER NOT NULL
);
`;

/** Imported uncertainty fences workers without inventing an active runtime owner/run. */
const MIGRATION_HOLDS_SCHEMA = `
CREATE TABLE migration_worker_holds (
  worker_agent_id TEXT PRIMARY KEY, claims_json TEXT NOT NULL
);
CREATE TABLE migration_blockers (
  source_key TEXT PRIMARY KEY REFERENCES migrations(source_key), payload_json TEXT NOT NULL
);
`;

const ARCHIVE_SCHEMA = `
CREATE TABLE collection_archives (
 collection_key TEXT PRIMARY KEY REFERENCES collections(collection_key)
);
CREATE TABLE card_archives (
 collection_key TEXT NOT NULL, card_id TEXT NOT NULL,
 PRIMARY KEY (collection_key, card_id),
 FOREIGN KEY (collection_key, card_id) REFERENCES cards(collection_key, id)
);
`;

/** Explicitly created sources are distinct from imported provenance/ledger rows. */
const SOURCES_SCHEMA = `
CREATE TABLE board_sources (source_key TEXT PRIMARY KEY);
`;

/** Explicit path prevents tests or callers from accidentally opening the live workspace. */
export function openBoardDb(
	dbPath: string,
	DatabaseConstructor: typeof Database = Database
): Database.Database {
	if (!path.isAbsolute(dbPath)) throw new Error('Board database path must be absolute');
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseConstructor(dbPath);
	try {
		// Check before changing journal mode or schema, including on unsupported newer databases.
		const version = db.pragma('user_version', { simple: true }) as number;
		if (version > BOARD_SCHEMA_VERSION) {
			throw new Error(`Unsupported Board database schema version ${version}`);
		}
		db.pragma('busy_timeout = 5000');
		db.pragma('foreign_keys = ON');
		db.pragma('journal_mode = WAL');
		db.transaction(() => {
			const current = db.pragma('user_version', { simple: true }) as number;
			if (current > BOARD_SCHEMA_VERSION) {
				throw new Error(`Unsupported Board database schema version ${current}`);
			}
			if (current === 0) {
				db.exec(SCHEMA);
			}
			if (current < 2) {
				db.exec(MIGRATION_HOLDS_SCHEMA);
			}
			if (current < 3) db.exec(ARCHIVE_SCHEMA);
			if (current < 4) db.exec(SOURCES_SCHEMA);
			if (current < 5) db.exec('ALTER TABLE runs ADD COLUMN lifecycle_json TEXT');
			if (current < 6)
				db.exec(
					'CREATE TABLE board_source_locations (source_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL)'
				);
			db.pragma(`user_version = ${BOARD_SCHEMA_VERSION}`);
		}).immediate();
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
