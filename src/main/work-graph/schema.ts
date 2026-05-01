export const CREATE_MIGRATIONS_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS _migrations (
		version INTEGER PRIMARY KEY,
		description TEXT NOT NULL,
		applied_at INTEGER NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
		error_message TEXT
	)
`;

export const CREATE_META_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS _meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)
`;

export const WORK_ITEM_SOURCE_CHECK_VALUES = [
	'manual',
	'living-wiki',
	'delivery-planner',
	'agent-dispatch',
	'github',
	'mcp',
	'spec-kit',
	'openspec',
	'playbook',
	'director-notes',
] as const;

export const WORK_ITEM_SOURCE_CHECK_SQL = WORK_ITEM_SOURCE_CHECK_VALUES.map(
	(source) => `'${source}'`
).join(', ');

export const WORK_GRAPH_SCHEMA_SQL = [
	`
		CREATE TABLE IF NOT EXISTS work_items (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL CHECK(type IN ('task', 'bug', 'feature', 'chore', 'document', 'decision', 'milestone')),
			status TEXT NOT NULL CHECK(status IN ('discovered', 'planned', 'ready', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'archived', 'canceled')),
			title TEXT NOT NULL,
			description TEXT,
			project_path TEXT NOT NULL,
			git_path TEXT NOT NULL,
			mirror_hash TEXT,
			source TEXT NOT NULL CHECK(source IN (${WORK_ITEM_SOURCE_CHECK_SQL})),
			readonly INTEGER NOT NULL DEFAULT 0 CHECK(readonly IN (0, 1)),
			slug TEXT NOT NULL,
			parent_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
			owner_json TEXT,
			github_json TEXT,
			capabilities_json TEXT NOT NULL DEFAULT '[]',
			priority INTEGER,
			due_at TEXT,
			completed_at TEXT,
			metadata_json TEXT,
			version INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			tracker_backend_id TEXT,
			tracker_sync_state TEXT NOT NULL DEFAULT 'unsynced',
			tracker_external_id TEXT,
			tracker_external_url TEXT,
			tracker_last_synced_at INTEGER,
			tracker_last_error TEXT,
			tracker_hash TEXT
		)
	`,
	`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_unique_slug_scope
		ON work_items(project_path, type, COALESCE(parent_work_item_id, ''), slug)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_items_project_type_status
		ON work_items(project_path, type, status)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_items_parent
		ON work_items(parent_work_item_id)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_items_timestamps
		ON work_items(updated_at, created_at)
	`,
	`
		CREATE TABLE IF NOT EXISTS work_item_dependencies (
			id TEXT PRIMARY KEY,
			from_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			to_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			type TEXT NOT NULL CHECK(type IN ('blocks', 'relates_to', 'duplicates', 'parent_child')),
			status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'ignored')),
			created_at TEXT NOT NULL,
			created_by_json TEXT,
			CHECK(from_work_item_id <> to_work_item_id),
			UNIQUE(from_work_item_id, to_work_item_id, type)
		)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_dependencies_from
		ON work_item_dependencies(from_work_item_id, status, type)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_dependencies_to
		ON work_item_dependencies(to_work_item_id, status, type)
	`,
	`
		CREATE TABLE IF NOT EXISTS work_item_tags (
			work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			project_path TEXT NOT NULL,
			tag TEXT NOT NULL,
			source TEXT NOT NULL CHECK(source IN (${WORK_ITEM_SOURCE_CHECK_SQL})),
			created_at TEXT NOT NULL,
			PRIMARY KEY(work_item_id, tag)
		)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_tags_tag_project
		ON work_item_tags(tag, project_path, work_item_id)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_tags_ready_dispatch
		ON work_item_tags(project_path, tag, work_item_id)
		WHERE tag = 'agent-ready'
	`,
	`
		CREATE TABLE IF NOT EXISTS work_item_events (
			id TEXT PRIMARY KEY,
			work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			type TEXT NOT NULL,
			actor_json TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			before_json TEXT,
			after_json TEXT,
			message TEXT,
			prior_state_json TEXT,
			new_state_json TEXT,
			reason TEXT,
			artifact_link TEXT
		)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_events_item_timestamp
		ON work_item_events(work_item_id, timestamp)
	`,
	`
		CREATE TABLE IF NOT EXISTS work_item_claims (
			id TEXT PRIMARY KEY,
			work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			owner_type TEXT NOT NULL,
			owner_id TEXT NOT NULL,
			owner_json TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'released', 'completed', 'expired')),
			source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'auto-pickup')),
			claimed_at TEXT NOT NULL,
			expires_at TEXT,
			released_at TEXT,
			completed_at TEXT,
			note TEXT
		)
	`,
	`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_claims_one_active
		ON work_item_claims(work_item_id)
		WHERE status = 'active'
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_claims_owner_status
		ON work_item_claims(owner_type, owner_id, status)
	`,
	`
		CREATE TABLE IF NOT EXISTS work_item_sources (
			id TEXT PRIMARY KEY,
			work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			source TEXT NOT NULL CHECK(source IN (${WORK_ITEM_SOURCE_CHECK_SQL})),
			project_path TEXT NOT NULL,
			git_path TEXT NOT NULL,
			external_type TEXT NOT NULL,
			external_id TEXT NOT NULL,
			url TEXT,
			metadata_json TEXT,
			imported_at TEXT NOT NULL,
			UNIQUE(source, project_path, external_type, external_id)
		)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_sources_work_item
		ON work_item_sources(work_item_id)
	`,
	`
		CREATE TABLE IF NOT EXISTS work_item_mirrors (
			id TEXT PRIMARY KEY,
			work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
			project_path TEXT NOT NULL,
			git_path TEXT NOT NULL,
			mirror_path TEXT NOT NULL,
			mirror_hash TEXT,
			frontmatter_json TEXT,
			synced_at TEXT NOT NULL,
			UNIQUE(project_path, mirror_path)
		)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_work_item_mirrors_path
		ON work_item_mirrors(project_path, git_path, mirror_path)
	`,
	`
		CREATE TABLE IF NOT EXISTS tag_registry (
			name TEXT PRIMARY KEY,
			description TEXT,
			color TEXT,
			source TEXT NOT NULL CHECK(source IN (${WORK_ITEM_SOURCE_CHECK_SQL})),
			readonly INTEGER NOT NULL DEFAULT 0 CHECK(readonly IN (0, 1)),
			canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical IN (0, 1)),
			capabilities_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`,
	`
		CREATE INDEX IF NOT EXISTS idx_tag_registry_capability_routing
		ON tag_registry(canonical, name)
	`,
	`
		CREATE VIRTUAL TABLE IF NOT EXISTS work_item_fts USING fts5(
			work_item_id UNINDEXED,
			title,
			description,
			tags,
			metadata,
			tokenize = 'porter unicode61'
		)
	`,
];
