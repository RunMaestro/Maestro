// @vitest-environment node
/**
 * OpenCode session storage against a real `opencode.db`.
 *
 * OpenCode v1.2+ keeps every conversation in SQLite. On macOS the Go binary
 * uses XDG paths, not `~/Library/Application Support`, so the database lives
 * at `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/`).
 * Pre-v1.2 installs left JSON under `.../opencode/storage/`, and a migrated
 * machine can have both.
 *
 * These tests build that layout under a temp home and run the real queries
 * (through the `node:sqlite` shim, since the better-sqlite3 binary is built
 * for Electron). They cover what the resume flow reads back: the turns a
 * `run --session <id>` continuation appended, which project a session belongs
 * to, and the JSON fallback/merge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { canLoadNodeSqlite } from '../../helpers/nodeSqlite';

const { homeRef } = vi.hoisted(() => ({ homeRef: { current: '' } }));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const mocked = { ...actual, homedir: () => homeRef.current };
	return { ...mocked, default: mocked };
});

vi.mock('better-sqlite3', async () => {
	const { nodeSqliteBetterSqlite3Mock } = await import('../../helpers/nodeSqlite');
	return nodeSqliteBetterSqlite3Mock();
});

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../shared/platformDetection', async () => {
	const actual = await vi.importActual<typeof import('../../../shared/platformDetection')>(
		'../../../shared/platformDetection'
	);
	// macOS: no %APPDATA% fallback candidate.
	return { ...actual, isWindows: () => false, isMacOS: () => true };
});

type Storage = import('../../../main/storage/opencode-session-storage').OpenCodeSessionStorage;

// Resolved so the fixtures speak the host's native path form: the storage
// compares path.resolve()d paths, and OpenCode records native ones (on the
// Windows CI leg this becomes a drive-letter path).
const PROJECT = path.resolve('/Users/jane/Code/my_app');

interface Turn {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	at: number;
	tokens?: { input: number; output: number; cache?: { read: number; write: number } };
	cost?: number;
}

/** Create `opencode.db` with the v1.2 tables Maestro reads. */
function createDb(dbPath: string): DatabaseSync {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
		CREATE TABLE session (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT, title TEXT,
			version TEXT, time_created INTEGER, time_updated INTEGER,
			summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER
		);
		CREATE TABLE message (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER,
			time_updated INTEGER, data TEXT NOT NULL
		);
		CREATE TABLE part (
			id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL
		);
	`);
	return db;
}

function addProject(db: DatabaseSync, id: string, worktree: string): void {
	db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run(id, worktree);
}

function addSession(
	db: DatabaseSync,
	s: {
		id: string;
		projectId: string;
		directory: string;
		title?: string;
		created: number;
		updated: number;
	}
): void {
	db.prepare(
		'INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run(s.id, s.projectId, s.directory, s.title ?? '', '1.2.0', s.created, s.updated);
}

function addTurns(db: DatabaseSync, sessionId: string, turns: Turn[]): void {
	for (const t of turns) {
		db.prepare(
			'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
		).run(
			t.id,
			sessionId,
			t.at,
			t.at,
			JSON.stringify({ role: t.role, tokens: t.tokens, cost: t.cost })
		);
		db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run(
			`${t.id}-p`,
			t.id,
			t.at,
			JSON.stringify({ type: 'text', text: t.text })
		);
	}
}

/** Write a pre-v1.2 JSON store under `<dataDir>/storage`. */
function writeJsonSession(
	dataDir: string,
	s: { projectId: string; worktree: string; sessionId: string; turns: Turn[]; updated: number }
): void {
	const storage = path.join(dataDir, 'storage');
	const write = (rel: string, data: unknown) => {
		const file = path.join(storage, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(data));
	};
	write(`project/${s.projectId}.json`, { id: s.projectId, worktree: s.worktree });
	write(`session/${s.projectId}/${s.sessionId}.json`, {
		id: s.sessionId,
		projectID: s.projectId,
		directory: s.worktree,
		title: 'legacy',
		time: { created: s.turns[0]?.at ?? s.updated, updated: s.updated },
	});
	for (const t of s.turns) {
		write(`message/${s.sessionId}/${t.id}.json`, {
			id: t.id,
			sessionID: s.sessionId,
			role: t.role,
			time: { created: t.at },
		});
		write(`part/${t.id}/${t.id}-p.json`, {
			id: `${t.id}-p`,
			messageID: t.id,
			type: 'text',
			text: t.text,
		});
	}
}

/** Two `opencode run --session <id>` invocations appending to one conversation. */
function twoResumedTurns(prefix: string, start: number): Turn[] {
	return [
		{
			id: `${prefix}-m1`,
			role: 'user',
			text: 'add a test',
			at: start,
		},
		{
			id: `${prefix}-m2`,
			role: 'assistant',
			text: 'Added a test.',
			at: start + 5_000,
			tokens: { input: 100, output: 20, cache: { read: 50, write: 10 } },
			cost: 0.01,
		},
		// Turn 2: a later `run --session` continuation of the same conversation.
		{ id: `${prefix}-m3`, role: 'user', text: 'now run it', at: start + 60_000 },
		{
			id: `${prefix}-m4`,
			role: 'assistant',
			text: 'All tests pass.',
			at: start + 65_000,
			tokens: { input: 200, output: 30, cache: { read: 80, write: 0 } },
			cost: 0.02,
		},
	];
}

describe.skipIf(!canLoadNodeSqlite())('OpenCodeSessionStorage (SQLite, macOS layout)', () => {
	let root: string;
	let dataDir: string;
	const savedXdg = process.env.XDG_DATA_HOME;

	/** The module resolves its paths at import time, so import after setup. */
	async function loadStorage(): Promise<Storage> {
		vi.resetModules();
		const mod = await import('../../../main/storage/opencode-session-storage');
		return new mod.OpenCodeSessionStorage();
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'maestro-opencode-'));
		homeRef.current = path.join(root, 'Users', 'jane');
		dataDir = path.join(homeRef.current, '.local', 'share', 'opencode');
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdg;
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('locating opencode.db', () => {
		it('reads ~/.local/share/opencode/opencode.db (XDG layout, not ~/Library)', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addSession(db, {
				id: 'ses_a',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1,
				updated: 2,
			});
			db.close();

			const storage = await loadStorage();
			expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toEqual(['ses_a']);
		});

		it('prefers $XDG_DATA_HOME/opencode when it holds the database', async () => {
			const xdg = path.join(root, 'xdg');
			process.env.XDG_DATA_HOME = xdg;
			const preferred = createDb(path.join(xdg, 'opencode', 'opencode.db'));
			addProject(preferred, 'proj1', PROJECT);
			addSession(preferred, {
				id: 'ses_xdg',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1,
				updated: 2,
			});
			preferred.close();
			const other = createDb(path.join(dataDir, 'opencode.db'));
			addProject(other, 'proj1', PROJECT);
			addSession(other, {
				id: 'ses_home',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1,
				updated: 2,
			});
			other.close();

			const storage = await loadStorage();
			expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toEqual(['ses_xdg']);
		});

		it('falls back to ~/.local/share when $XDG_DATA_HOME has no database', async () => {
			process.env.XDG_DATA_HOME = path.join(root, 'empty-xdg');
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addSession(db, {
				id: 'ses_home',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1,
				updated: 2,
			});
			db.close();

			const storage = await loadStorage();
			expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toEqual(['ses_home']);
		});
	});

	describe('turn continuation', () => {
		it('reads back every turn a resumed session accumulated, in order', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addSession(db, {
				id: 'ses_resumed',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1_000,
				updated: 66_000,
			});
			// Insert out of order: reads must sort by time, not insertion.
			const turns = twoResumedTurns('r', 1_000);
			addTurns(db, 'ses_resumed', [turns[2], turns[0], turns[3], turns[1]]);
			db.close();

			const storage = await loadStorage();
			const { messages } = await storage.readSessionMessages(PROJECT, 'ses_resumed');

			expect(messages.map((m) => [m.role, m.content])).toEqual([
				['user', 'add a test'],
				['assistant', 'Added a test.'],
				['user', 'now run it'],
				['assistant', 'All tests pass.'],
			]);
		});

		it('aggregates tokens and cost across both turns in the listing', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addSession(db, {
				id: 'ses_resumed',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1_000,
				updated: 66_000,
			});
			addTurns(db, 'ses_resumed', twoResumedTurns('r', 1_000));
			db.close();

			const storage = await loadStorage();
			const [info] = await storage.listSessions(PROJECT);

			expect(info).toMatchObject({
				sessionId: 'ses_resumed',
				messageCount: 4,
				inputTokens: 300,
				outputTokens: 50,
				cacheReadTokens: 130,
				cacheCreationTokens: 10,
				durationSeconds: 65,
				// Preview is the first assistant reply.
				firstMessage: 'Added a test.',
			});
			expect(info.costUsd).toBeCloseTo(0.03);
		});

		it('returns an empty history for a session created but not yet answered, without a JSON fallback', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addSession(db, {
				id: 'ses_new',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1,
				updated: 1,
			});
			db.close();
			// A stale JSON copy with the same id must not be served instead.
			writeJsonSession(dataDir, {
				projectId: 'proj1',
				worktree: PROJECT,
				sessionId: 'ses_new',
				updated: 1,
				turns: [{ id: 'stale', role: 'user', text: 'stale json', at: 1 }],
			});

			const storage = await loadStorage();
			expect((await storage.readSessionMessages(PROJECT, 'ses_new')).messages).toEqual([]);
		});
	});

	describe('which sessions belong to the agent', () => {
		it('includes a session started in a subdirectory of the project, and tolerates a trailing slash', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', path.join(PROJECT, 'packages', 'web'));
			addSession(db, {
				id: 'ses_sub',
				projectId: 'proj1',
				directory: path.join(PROJECT, 'packages', 'web'),
				created: 1,
				updated: 2,
			});
			db.close();

			const storage = await loadStorage();
			expect((await storage.listSessions(`${PROJECT}${path.sep}`)).map((s) => s.sessionId)).toEqual(
				['ses_sub']
			);
		});

		it('matches global-project sessions by directory, treating _ and % literally', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'global', '/');
			addSession(db, {
				id: 'ses_mine',
				projectId: 'global',
				directory: path.join(PROJECT, 'src'),
				created: 1,
				updated: 3,
			});
			// `my_app` as a LIKE pattern would also match `myXapp`; it must not.
			addSession(db, {
				id: 'ses_lookalike',
				projectId: 'global',
				directory: path.resolve('/Users/jane/Code/myXapp/src'),
				created: 1,
				updated: 2,
			});
			db.close();

			const storage = await loadStorage();
			expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toEqual(['ses_mine']);
		});

		it('lists newest first across dedicated and global projects', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addProject(db, 'global', '/');
			addSession(db, {
				id: 'ses_old',
				projectId: 'proj1',
				directory: PROJECT,
				created: 1,
				updated: 10,
			});
			addSession(db, {
				id: 'ses_new',
				projectId: 'global',
				directory: PROJECT,
				created: 1,
				updated: 20,
			});
			db.close();

			const storage = await loadStorage();
			expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toEqual([
				'ses_new',
				'ses_old',
			]);
		});
	});

	describe('pre-v1.2 JSON storage', () => {
		it('falls back to JSON when there is no database (older OpenCode on this Mac)', async () => {
			writeJsonSession(dataDir, {
				projectId: 'proj1',
				worktree: PROJECT,
				sessionId: 'ses_json',
				updated: 66_000,
				turns: twoResumedTurns('j', 1_000),
			});

			const storage = await loadStorage();
			expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toEqual(['ses_json']);
			const { messages } = await storage.readSessionMessages(PROJECT, 'ses_json');
			expect(messages.map((m) => m.content)).toEqual([
				'add a test',
				'Added a test.',
				'now run it',
				'All tests pass.',
			]);
		});

		it('merges a migrated machine: SQLite wins for shared ids, JSON-only sessions still show', async () => {
			const db = createDb(path.join(dataDir, 'opencode.db'));
			addProject(db, 'proj1', PROJECT);
			addSession(db, {
				id: 'ses_both',
				projectId: 'proj1',
				directory: PROJECT,
				title: 'sqlite',
				created: 1,
				updated: 30,
			});
			db.close();
			writeJsonSession(dataDir, {
				projectId: 'proj1',
				worktree: PROJECT,
				sessionId: 'ses_both',
				updated: 5,
				turns: [],
			});
			writeJsonSession(dataDir, {
				projectId: 'proj1',
				worktree: PROJECT,
				sessionId: 'ses_legacy_only',
				updated: 10,
				turns: [{ id: 'l1', role: 'user', text: 'legacy', at: 10 }],
			});

			const storage = await loadStorage();
			const sessions = await storage.listSessions(PROJECT);

			expect(sessions.map((s) => s.sessionId)).toEqual(['ses_both', 'ses_legacy_only']);
			expect(sessions[0].firstMessage).toBe('sqlite');
		});
	});
});
