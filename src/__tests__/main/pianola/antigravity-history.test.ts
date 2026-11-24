// @vitest-environment node
/**
 * Antigravity (agy) as a Pianola memory history source: discovery lists the
 * conversation summary index, and the window reader returns the messages the
 * session storage parses out of each conversation's protobuf step log. The
 * stores are real SQLite files laid out like agy's, under an account root that
 * is NOT the user's home, so the root the user configured is what gets read.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	HistoryExclusions,
	defaultHistoryRoots,
	discoverHistoricalSources,
	readHistoricalWindow,
} from '../../../main/storage/historical-inventory';
import type { MemoryRoot, MemorySource } from '../../../shared/pianola/memory';

const INDEXED = '11111111-1111-4111-8111-111111111111';
const BY_LAST_MAP = '22222222-2222-4222-8222-222222222222';
const BY_COMMAND_CWD = '33333333-3333-4333-8333-333333333333';
const UNATTRIBUTED = '44444444-4444-4444-8444-444444444444';
const SUBAGENT = '55555555-5555-4555-8555-555555555555';
const STORE_GONE = '66666666-6666-4666-8666-666666666666';
const T0 = 1_791_295_505; // 2026-10-06T14:05:05Z

function varint(value: number): number[] {
	const out: number[] = [];
	while (value > 0x7f) {
		out.push((value & 0x7f) | 0x80);
		value = Math.floor(value / 128);
	}
	out.push(value);
	return out;
}
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
function field(n: number, body: Uint8Array | string): number[] {
	const b = typeof body === 'string' ? Array.from(new TextEncoder().encode(body)) : [...body];
	return [...varint(n * 8 + 2), ...varint(b.length), ...b];
}
const num = (n: number, value: number) => [...varint(n * 8), ...varint(value)];
const meta = (seconds: number, ...extra: number[][]) =>
	field(5, bytes(field(1, bytes(num(1, seconds))), ...extra));
const userStep = (seconds: number, prompt: string) =>
	bytes(num(1, 14), meta(seconds), field(19, bytes(field(2, prompt))));
const modelStep = (seconds: number, text: string) =>
	bytes(num(1, 15), meta(seconds), field(20, bytes(field(1, text))));
const toolStep = (seconds: number, args: object) =>
	bytes(
		num(1, 132),
		meta(
			seconds,
			field(4, bytes(field(1, 'call_1'), field(2, 'run_command'), field(3, JSON.stringify(args))))
		)
	);

let dir = '';
let account = '';

function writeConversation(id: string, steps: Array<[number, Uint8Array]>): void {
	const db = new DatabaseSync(path.join(account, 'conversations', `${id}.db`));
	db.exec(
		'CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)'
	);
	const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
	steps.forEach(([type, payload], idx) => insert.run(idx, type, payload));
	db.close();
}

function writeIndex(
	rows: Array<{ id: string; steps: number; workspace?: string; parent?: string }>
): void {
	const db = new DatabaseSync(path.join(account, 'conversation_summaries.db'));
	db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "",
		step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
		parent_conversation_id text NOT NULL DEFAULT "")`);
	const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)');
	for (const row of rows)
		insert.run(
			row.id,
			'title',
			row.steps,
			'2026-10-06 14:05:09.248083+00:00',
			row.workspace ? JSON.stringify([pathToFileURL(row.workspace).href]) : '',
			row.parent ?? ''
		);
	db.close();
}

const root = (): MemoryRoot => ({
	provider: 'antigravity',
	path: account,
	userId: 'owner',
	authorship: 'human',
	enabled: true,
});

async function discover(policy: HistoryExclusions): Promise<MemorySource[]> {
	const sources: MemorySource[] = [];
	for await (const source of discoverHistoricalSources(root(), policy)) sources.push(source);
	return sources;
}

it('lists Antigravity among the default history roots at agy home', () => {
	const home = path.resolve('/home/someone');
	expect(defaultHistoryRoots(home)).toContainEqual(
		expect.objectContaining({
			provider: 'antigravity',
			path: path.join(home, '.gemini', 'antigravity-cli'),
			enabled: false,
		})
	);
});

it('yields an empty inventory when the agy directory does not exist', async () => {
	const missing = path.join(os.tmpdir(), 'agy-history-missing-' + process.pid);
	const sources: MemorySource[] = [];
	for await (const source of discoverHistoricalSources(
		{ ...root(), path: missing },
		await HistoryExclusions.create([])
	))
		sources.push(source);
	expect(sources).toEqual([]);
});

describe.skipIf(!canLoadNodeSqlite())('Antigravity history', () => {
	const project = () => path.join(dir, 'project');
	const other = () => path.join(dir, 'other');
	const scanned = () => path.join(dir, 'scanned');

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-history-')));
		account = path.join(dir, 'agy-account');
		fs.mkdirSync(path.join(account, 'conversations'), { recursive: true });
		fs.mkdirSync(path.join(account, 'cache'), { recursive: true });
		for (const folder of [project(), other(), scanned()]) fs.mkdirSync(folder, { recursive: true });

		writeConversation(INDEXED, [
			[14, userStep(T0, 'Prefer SQLite for local stores.')],
			[15, modelStep(T0 + 1, 'Noted: SQLite it is.')],
		]);
		writeConversation(BY_LAST_MAP, [[14, userStep(T0, 'From the last-conversation map.')]]);
		writeConversation(BY_COMMAND_CWD, [
			[14, userStep(T0, 'Run ls.')],
			[132, toolStep(T0 + 1, { CommandLine: 'ls', Cwd: scanned() })],
		]);
		writeConversation(UNATTRIBUTED, [[14, userStep(T0, 'No folder anywhere.')]]);
		writeConversation(SUBAGENT, [[14, userStep(T0, 'Internal worker.')]]);
		writeIndex([
			{ id: INDEXED, steps: 2, workspace: project() },
			{ id: BY_LAST_MAP, steps: 1 },
			{ id: BY_COMMAND_CWD, steps: 2 },
			{ id: UNATTRIBUTED, steps: 1 },
			{ id: SUBAGENT, steps: 1, workspace: project(), parent: INDEXED },
			{ id: STORE_GONE, steps: 1, workspace: project() },
		]);
		fs.writeFileSync(
			path.join(account, 'cache', 'last_conversations.json'),
			JSON.stringify({ [other()]: BY_LAST_MAP })
		);
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('discovers one source per top-level conversation, attributed to its folder', async () => {
		const sources = await discover(await HistoryExclusions.create([]));
		// Keyed by store: a failed source names its file, not the conversation id.
		const byId = new Map(sources.map((source) => [path.basename(source.filePath, '.db'), source]));
		expect([...byId.keys()].sort()).toEqual(
			[INDEXED, BY_LAST_MAP, BY_COMMAND_CWD, UNATTRIBUTED].sort()
		);
		expect(byId.get(INDEXED)).toEqual(
			expect.objectContaining({
				provider: 'antigravity',
				projectPath: project(),
				filePath: path.join(account, 'conversations', `${INDEXED}.db`),
				state: 'pending',
				authorship: 'human',
			})
		);
		expect(byId.get(BY_LAST_MAP)?.projectPath).toBe(other());
		expect(byId.get(BY_COMMAND_CWD)?.projectPath).toBe(scanned());
		expect(byId.get(UNATTRIBUTED)).toEqual(
			expect.objectContaining({ state: 'failed', error: expect.stringMatching(/attribute/) })
		);
		// Revision follows the index row, not the WAL-lagged store mtime.
		expect(byId.get(INDEXED)?.revision).not.toMatch(/^\d+:/);
	});

	it('skips conversations in an excluded project', async () => {
		const sources = await discover(await HistoryExclusions.create([project()]));
		expect(sources.map((source) => source.sessionId)).not.toContain(INDEXED);
		expect(sources.map((source) => source.sessionId)).toContain(BY_LAST_MAP);
	});

	it('yields an empty inventory when the summary index is missing', async () => {
		fs.rmSync(path.join(account, 'conversation_summaries.db'));
		expect(await discover(await HistoryExclusions.create([]))).toEqual([]);
	});

	it('reads a conversation window as session messages, counting the cursor in messages', async () => {
		const policy = await HistoryExclusions.create([]);
		const source = (await discover(policy)).find((s) => s.sessionId === INDEXED)!;
		const first = await readHistoricalWindow(source, 0, policy);
		expect(first).toEqual({
			messages: [
				expect.objectContaining({
					type: 'user',
					role: 'user',
					content: 'Prefer SQLite for local stores.',
					timestamp: new Date(T0 * 1000).toISOString(),
				}),
				expect.objectContaining({
					type: 'assistant',
					role: 'assistant',
					content: 'Noted: SQLite it is.',
				}),
			],
			cursor: 2,
			complete: true,
		});
		const resumed = await readHistoricalWindow(source, 1, policy);
		expect(resumed.messages.map((m) => m.role)).toEqual(['assistant']);
		expect(resumed).toEqual(expect.objectContaining({ cursor: 2, complete: true }));
	});

	it('refuses to read a conversation whose project became excluded', async () => {
		const source = (await discover(await HistoryExclusions.create([]))).find(
			(s) => s.sessionId === INDEXED
		)!;
		await expect(
			readHistoricalWindow(source, 0, await HistoryExclusions.create([project()]))
		).rejects.toThrow(/excluded/);
	});
});
