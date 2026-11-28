// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('better-sqlite3', async () => {
	const { nodeSqliteBetterSqlite3Mock } = await import('../../helpers/nodeSqlite');
	return nodeSqliteBetterSqlite3Mock();
});
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
import { readCompletedOpenCodeReply } from '../../../main/storage/opencode-session-storage';
let dir: string, file: string, db: DatabaseSync;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-test-'));
	file = path.join(dir, 'opencode.db');
	db = new DatabaseSync(file);
	db.exec(
		'CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)'
	);
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});
function message(id: string, role: string, at: number, extra = {}) {
	db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
		id,
		'ses_test',
		at,
		JSON.stringify({ role, ...extra })
	);
}
function part(id: string, text: string, type = 'text') {
	db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
		id,
		'a',
		'ses_test',
		102,
		JSON.stringify({ type, text })
	);
}
function complete(extra = {}) {
	message('u', 'user', 100);
	message('a', 'assistant', 101, {
		parentID: 'u',
		finish: 'stop',
		time: { completed: 103 },
		...extra,
	});
	part('p1', 'full');
	part('p2', ' answer');
	part('p3', 'SECRET TOOL OUTPUT', 'tool');
}
it('recovers the entire completed response when stdout lost it', () => {
	complete();
	expect(readCompletedOpenCodeReply('ses_test', 99, file)).toEqual({
		messageId: 'a',
		text: 'full answer',
	});
});
it('does not replay an earlier request or another provider session', () => {
	complete();
	expect(readCompletedOpenCodeReply('ses_test', 104, file)).toBeNull();
	expect(readCompletedOpenCodeReply('ses_other', 99, file)).toBeNull();
});
it.each([
	{ finish: 'tool-calls' },
	{ time: {} },
	{ error: { message: 'failed' } },
	{ parentID: 'other' },
])('rejects incomplete, failed, or unbound answers %j', (extra) => {
	complete(extra);
	expect(readCompletedOpenCodeReply('ses_test', 99, file)).toBeNull();
});
it('does not substitute a prior completed response for a new unfinished turn', () => {
	complete();
	message('u2', 'user', 105);
	message('a2', 'assistant', 106, { parentID: 'u2' });
	expect(readCompletedOpenCodeReply('ses_test', 99, file)).toBeNull();
});
it('does not create a missing database', () => {
	expect(readCompletedOpenCodeReply('ses_test', 99, file + '.missing')).toBeNull();
	expect(fs.existsSync(file + '.missing')).toBe(false);
});

it('rejects an assistant envelope from a different concurrent invocation', () => {
	complete();
	expect(readCompletedOpenCodeReply('ses_test', 99, file, 'different-envelope')).toBeNull();
});
