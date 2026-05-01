/**
 * Tests for WorkGraphStorage optimistic locking (#435).
 *
 * Covers:
 * - version field starts at 0 and increments on every updateItem call
 * - updateItem without expectedVersion always succeeds (opt-in safety)
 * - updateItem with correct expectedVersion succeeds and increments version
 * - updateItem with stale expectedVersion throws STALE_VERSION error with currentVersion
 *
 * better-sqlite3 is a native Electron ABI module that cannot load in vitest,
 * so we mock the WorkGraphDB dependency and drive WorkGraphStorage through its
 * public API using an in-memory JavaScript map.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-memory row store
// ─────────────────────────────────────────────────────────────────────────────

interface WorkItemRowLike {
	id: string;
	type: string;
	status: string;
	title: string;
	description: string | null;
	slug: string | null;
	parent_work_item_id: string | null;
	project_path: string;
	git_path: string;
	mirror_hash: string | null;
	source: string;
	readonly: number;
	owner_json: string | null;
	github_json: string | null;
	capabilities_json: string;
	priority: number | null;
	due_at: string | null;
	completed_at: string | null;
	metadata_json: string | null;
	version: number;
	created_at: string;
	updated_at: string;
	tracker_backend_id: string | null;
	tracker_sync_state: string;
	tracker_external_id: string | null;
	tracker_external_url: string | null;
	tracker_last_synced_at: number | null;
	tracker_last_error: string | null;
	tracker_hash: string | null;
}

// Rows keyed by id
let itemStore: Map<string, WorkItemRowLike>;
// Tags keyed by work_item_id
let tagStore: Map<string, string[]>;

function resetStores() {
	itemStore = new Map();
	tagStore = new Map();
}

function buildMockDb() {
	// Simple in-memory SQLite statement mock
	function makePrepare(sql: string) {
		return {
			run: (...params: unknown[]) => {
				const s = sql.trim();

				// INSERT INTO work_items
				if (s.startsWith('INSERT INTO work_items')) {
					const row: WorkItemRowLike = {
						id: params[0] as string,
						type: params[1] as string,
						status: params[2] as string,
						title: params[3] as string,
						description: (params[4] as string | null) ?? null,
						project_path: params[5] as string,
						git_path: params[6] as string,
						mirror_hash: (params[7] as string | null) ?? null,
						source: params[8] as string,
						readonly: params[9] as number,
						slug: params[10] as string,
						parent_work_item_id: (params[11] as string | null) ?? null,
						owner_json: (params[12] as string | null) ?? null,
						github_json: (params[13] as string | null) ?? null,
						capabilities_json: (params[14] as string) ?? '[]',
						priority: (params[15] as number | null) ?? null,
						due_at: (params[16] as string | null) ?? null,
						completed_at: null,
						metadata_json: (params[17] as string | null) ?? null,
						created_at: params[18] as string,
						updated_at: params[19] as string,
						version: 0,
						tracker_backend_id: null,
						tracker_sync_state: 'unsynced',
						tracker_external_id: null,
						tracker_external_url: null,
						tracker_last_synced_at: null,
						tracker_last_error: null,
						tracker_hash: null,
					};
					itemStore.set(row.id, row);
					return { changes: 1 };
				}

				// UPDATE work_items SET ... version = ? ... WHERE id = ?
				if (s.startsWith('UPDATE work_items SET')) {
					// params layout from updateItem (after migration):
					// type, status, title, description, project_path, git_path,
					// mirror_hash, source, readonly, slug, parent_work_item_id,
					// owner_json, github_json, capabilities_json, priority, due_at,
					// completed_at, metadata_json, version, updated_at, id
					const id = params[params.length - 1] as string;
					const existing = itemStore.get(id);
					if (!existing) return { changes: 0 };

					// Find version and updated_at by column position:
					// We know version is at index 18 (0-based), updated_at at 19, id at 20
					const newVersion = params[18] as number;
					const newUpdatedAt = params[19] as string;

					itemStore.set(id, {
						...existing,
						type: params[0] as string,
						status: params[1] as string,
						title: params[2] as string,
						description: (params[3] as string | null) ?? null,
						project_path: params[4] as string,
						git_path: params[5] as string,
						mirror_hash: (params[6] as string | null) ?? null,
						source: params[7] as string,
						readonly: params[8] as number,
						slug: params[9] as string,
						parent_work_item_id: (params[10] as string | null) ?? null,
						owner_json: (params[11] as string | null) ?? null,
						github_json: (params[12] as string | null) ?? null,
						capabilities_json: (params[13] as string) ?? '[]',
						priority: (params[14] as number | null) ?? null,
						due_at: (params[15] as string | null) ?? null,
						completed_at: (params[16] as string | null) ?? null,
						metadata_json: (params[17] as string | null) ?? null,
						version: newVersion,
						updated_at: newUpdatedAt,
					});
					return { changes: 1 };
				}

				return { changes: 0 };
			},
			get: (...params: unknown[]) => {
				const s = sql.trim();

				if (s.startsWith('SELECT * FROM work_items WHERE id = ?')) {
					return itemStore.get(params[0] as string) ?? undefined;
				}
				if (s.startsWith('SELECT id FROM work_items WHERE id = ?')) {
					const row = itemStore.get(params[0] as string);
					return row ? { id: row.id } : undefined;
				}
				return undefined;
			},
			all: (...params: unknown[]) => {
				const s = sql.trim();

				if (s.includes('FROM work_item_tags WHERE work_item_id = ?')) {
					return (tagStore.get(params[0] as string) ?? []).map((tag) => ({ tag }));
				}
				if (s.includes('FROM work_item_dependencies WHERE from_work_item_id = ?')) {
					return [];
				}
				if (s.includes('FROM work_item_claims WHERE work_item_id = ?')) {
					return undefined;
				}
				// PRAGMA table_info — return an empty column list so createItem's
				// tag upsert skips the INSERT INTO tag_registry check
				if (s.startsWith('PRAGMA')) {
					return [];
				}
				return [];
			},
		};
	}

	const mockDb = {
		prepare: vi.fn((sql: string) => makePrepare(sql)),
		transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
	};

	return mockDb;
}

// Mock WorkGraphDB shape
function buildMockWorkGraphDB() {
	const innerDb = buildMockDb();
	return {
		isReady: vi.fn(() => true),
		initialize: vi.fn(),
		get database() {
			return innerDb;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Mocks for modules with Electron / native dependencies
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/test') } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/work-graph/singleton', () => ({
	getWorkGraphDB: vi.fn(),
}));
// disk-mirror is lazily imported in writeDiskMirror — not exercised here
vi.mock('../../../main/work-graph/disk-mirror', () => ({}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function importStorage() {
	// Dynamic import so mocks are in place before module code runs
	const { WorkGraphStorage } = await import('../../../main/work-graph/storage');
	return WorkGraphStorage;
}

function buildCreateInput(overrides: Partial<{ title: string }> = {}) {
	return {
		type: 'task' as const,
		title: overrides.title ?? 'Test Task',
		projectPath: '/projects/test',
		gitPath: '/projects/test',
		source: 'manual' as const,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkGraphStorage — optimistic locking', () => {
	let WorkGraphStorage: Awaited<ReturnType<typeof importStorage>>;
	let storage: InstanceType<typeof WorkGraphStorage>;
	let mockDb: ReturnType<typeof buildMockWorkGraphDB>;

	beforeEach(async () => {
		resetStores();
		WorkGraphStorage = await importStorage();
		mockDb = buildMockWorkGraphDB();
		// @ts-expect-error — injecting mock WorkGraphDB for testing
		storage = new WorkGraphStorage(mockDb);
	});

	it('new items start at version 0', async () => {
		const item = await storage.createItem(buildCreateInput());
		expect(item.version).toBe(0);
	});

	it('updateItem without expectedVersion increments version', async () => {
		const created = await storage.createItem(buildCreateInput());
		expect(created.version).toBe(0);

		const updated = await storage.updateItem({
			id: created.id,
			patch: { title: 'Updated Title' },
		});
		expect(updated.version).toBe(1);
	});

	it('updateItem increments version on each successive call (opt-in safety skipped)', async () => {
		const created = await storage.createItem(buildCreateInput());

		const v1 = await storage.updateItem({ id: created.id, patch: { title: 'v1' } });
		expect(v1.version).toBe(1);

		const v2 = await storage.updateItem({ id: created.id, patch: { title: 'v2' } });
		expect(v2.version).toBe(2);

		const v3 = await storage.updateItem({ id: created.id, patch: { title: 'v3' } });
		expect(v3.version).toBe(3);
	});

	it('updateItem with correct expectedVersion succeeds and increments', async () => {
		const created = await storage.createItem(buildCreateInput());
		expect(created.version).toBe(0);

		const updated = await storage.updateItem(
			{ id: created.id, patch: { title: 'Safe Update' } },
			{ expectedVersion: 0 }
		);
		expect(updated.version).toBe(1);
		expect(updated.title).toBe('Safe Update');
	});

	it('updateItem with stale expectedVersion throws STALE_VERSION', async () => {
		const created = await storage.createItem(buildCreateInput());

		// Advance the version to 1 without using expectedVersion (simulates another agent writing)
		await storage.updateItem({ id: created.id, patch: { title: 'Concurrent Update' } });

		// Now try to update using the stale expectedVersion of 0
		await expect(
			storage.updateItem({ id: created.id, patch: { title: 'My Update' } }, { expectedVersion: 0 })
		).rejects.toThrow('STALE_VERSION');
	});

	it('STALE_VERSION error has code and currentVersion properties', async () => {
		const created = await storage.createItem(buildCreateInput());

		// Advance version once
		await storage.updateItem({ id: created.id, patch: { title: 'First' } });
		// version is now 1

		let caught: (Error & { code?: string; currentVersion?: number }) | null = null;
		try {
			await storage.updateItem(
				{ id: created.id, patch: { title: 'Stale write' } },
				{ expectedVersion: 0 }
			);
		} catch (e) {
			caught = e as Error & { code?: string; currentVersion?: number };
		}

		expect(caught).not.toBeNull();
		expect(caught?.code).toBe('STALE_VERSION');
		expect(caught?.currentVersion).toBe(1);
	});

	it('updateItem with expectedVersion matching current version succeeds after multiple updates', async () => {
		const created = await storage.createItem(buildCreateInput());

		const v1 = await storage.updateItem({ id: created.id, patch: { title: 'v1' } });
		expect(v1.version).toBe(1);

		const v2 = await storage.updateItem({ id: created.id, patch: { title: 'v2' } });
		expect(v2.version).toBe(2);

		// Correctly use the current version (2) to safely update
		const v3 = await storage.updateItem(
			{ id: created.id, patch: { title: 'v3 safe' } },
			{ expectedVersion: 2 }
		);
		expect(v3.version).toBe(3);
		expect(v3.title).toBe('v3 safe');
	});
});
