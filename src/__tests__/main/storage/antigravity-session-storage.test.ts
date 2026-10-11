/**
 * AntigravitySessionStorage against real SQLite files laid out like agy's
 * (`conversation_summaries.db`, `conversations/<id>.db`), with step payloads
 * encoded in the protobuf field layout read off agy 1.2.16/1.3.0 stores.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

const home = vi.hoisted(() => ({ dir: '' }));
/** Every store the storage opened, so a test can prove a cache hit never touched one. */
const opened = vi.hoisted(() => ({ files: [] as string[] }));

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
vi.mock('electron', () => ({ app: { getPath: () => home.dir } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/parsers/antigravity-step-store', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../main/parsers/antigravity-step-store')>();
	return {
		...actual,
		openAntigravityDb: (file: string) => {
			opened.files.push(file);
			return actual.openAntigravityDb(file);
		},
	};
});
vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return {
		...actual,
		default: { ...actual, homedir: () => home.dir },
		homedir: () => home.dir,
	};
});

import {
	AntigravitySessionStorage,
	parseConversationSteps,
} from '../../../main/storage/antigravity-session-storage';
import {
	SessionInfoCache,
	setSessionInfoCacheForTest,
} from '../../../main/storage/session-info-cache';

// Real absolute paths on the OS running the test (a drive letter on Windows),
// written into the index the way agy writes them, as file:// URLs.
const PROJECT = path.resolve('/Users/test/project');
const OTHER = path.resolve('/Users/test/other');
const INDEXED = '11111111-1111-4111-8111-111111111111';
const BY_LAST_MAP = '22222222-2222-4222-8222-222222222222';
const BY_COMMAND_CWD = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const SUBAGENT = '55555555-5555-4555-8555-555555555555';

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
/** Step metadata (field 5): created time, plus whatever else the caller adds. */
const meta = (seconds: number, ...extra: number[][]) =>
	field(5, bytes(field(1, bytes(num(1, seconds), num(2, 500_000_000))), ...extra));

const userStep = (seconds: number, prompt: string) =>
	bytes(num(1, 14), meta(seconds), field(19, bytes(field(2, prompt))));

const modelStep = (
	seconds: number,
	text: string,
	calls: Array<{ id: string; name: string; args: object }>,
	usage: { input: number; output: number; cacheRead: number }
) =>
	bytes(
		num(1, 15),
		meta(
			seconds,
			field(
				9,
				bytes(num(1, 1320), num(2, usage.input), num(3, usage.output), num(5, usage.cacheRead))
			)
		),
		field(
			20,
			bytes(
				...(text ? [field(1, text)] : []),
				field(3, 'thinking that must not show up as a message'),
				...calls.map((call) =>
					field(
						7,
						bytes(field(1, call.id), field(2, call.name), field(3, JSON.stringify(call.args)))
					)
				)
			)
		)
	);

const toolStep = (seconds: number, id: string, name: string, args: object, result: string) =>
	bytes(
		num(1, 132),
		meta(seconds, field(4, bytes(field(1, id), field(2, name), field(3, JSON.stringify(args))))),
		field(140, bytes(field(2, bytes(field(1, result)))))
	);

function writeConversation(id: string, steps: Array<[number, Uint8Array]>): void {
	const db = new DatabaseSync(
		path.join(home.dir, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`)
	);
	db.exec(
		'CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)'
	);
	const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
	steps.forEach(([type, payload], idx) => insert.run(idx, type, payload));
	db.close();
}

function writeIndex(
	rows: Array<{
		id: string;
		title: string;
		steps: number;
		workspace?: string;
		uris?: string[];
		parent?: string;
	}>
): void {
	const db = new DatabaseSync(
		path.join(home.dir, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
	);
	db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "",
		step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
		parent_conversation_id text NOT NULL DEFAULT "")`);
	const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)');
	for (const row of rows) {
		insert.run(
			row.id,
			row.title,
			row.steps,
			'2026-10-06 14:05:09.248083+00:00',
			row.uris
				? JSON.stringify(row.uris)
				: row.workspace
					? JSON.stringify([pathToFileURL(row.workspace).href])
					: '',
			row.parent ?? ''
		);
	}
	db.close();
}

const T0 = 1_791_295_505; // 2026-10-06T14:05:05Z

describe.skipIf(!canLoadNodeSqlite())('AntigravitySessionStorage', () => {
	beforeEach(() => {
		home.dir = fs.mkdtempSync(path.join(tmpdir(), 'agy-sessions-'));
		const agyHome = path.join(home.dir, '.gemini', 'antigravity-cli');
		fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });
		fs.mkdirSync(path.join(agyHome, 'cache'), { recursive: true });
		setSessionInfoCacheForTest(
			'antigravity',
			new SessionInfoCache('antigravity', path.join(home.dir, 'userData'))
		);

		writeConversation(INDEXED, [
			[14, userStep(T0, 'List the files, then explain them.')],
			[
				15,
				modelStep(
					T0 + 1,
					'',
					[
						{
							id: 'call_1',
							name: 'run_command',
							args: {
								CommandLine: 'ls',
								Cwd: PROJECT,
								toolAction: 'Listing',
								toolSummary: 'Run ls',
							},
						},
						{ id: 'call_2', name: 'run_command', args: { CommandLine: 'false', Cwd: PROJECT } },
					],
					{ input: 15800, output: 194, cacheRead: 0 }
				),
			],
			[
				132,
				toolStep(
					T0 + 2,
					'call_1',
					'run_command',
					{ CommandLine: 'ls' },
					'\nThe command exited with code 0.\nOutput:\nhello.txt\r\n\n'
				),
			],
			[
				132,
				toolStep(
					T0 + 3,
					'call_2',
					'run_command',
					{ CommandLine: 'false' },
					'\nThe command exited with code 1.\nStdout:\n\nStderr:\n\n'
				),
			],
			[
				15,
				modelStep(T0 + 4, 'There is one file, hello.txt.', [], {
					input: 6000,
					output: 231,
					cacheRead: 10275,
				}),
			],
		]);
		writeConversation(BY_LAST_MAP, [
			[14, userStep(T0, 'Found through last_conversations.json')],
			[15, modelStep(T0 + 1, 'ok', [], { input: 10, output: 1, cacheRead: 0 })],
		]);
		writeConversation(BY_COMMAND_CWD, [
			[14, userStep(T0, 'Found through a command Cwd')],
			[
				15,
				modelStep(
					T0 + 1,
					'',
					[{ id: 'c', name: 'run_command', args: { CommandLine: 'pwd', Cwd: `${PROJECT}/sub` } }],
					{ input: 10, output: 1, cacheRead: 0 }
				),
			],
			[
				132,
				toolStep(
					T0 + 2,
					'c',
					'run_command',
					{ CommandLine: 'pwd', Cwd: `${PROJECT}/sub` },
					'\nThe command exited with code 0.\nOutput:\n/x\n'
				),
			],
		]);
		writeConversation(OTHER_PROJECT, [[14, userStep(T0, 'elsewhere')]]);
		writeConversation(SUBAGENT, [[14, userStep(T0, 'a worker agy spawned')]]);
		writeIndex([
			{
				id: INDEXED,
				title: 'Listing Files',
				steps: 5,
				// The first URI cannot become a local path (a host on POSIX); it must not
				// cost the row the URI that does.
				uris: ['file://otherhost/share/x', pathToFileURL(PROJECT).href],
			},
			{ id: BY_LAST_MAP, title: 'From Last Map', steps: 2 },
			{ id: BY_COMMAND_CWD, title: 'From Command Cwd', steps: 3 },
			{ id: OTHER_PROJECT, title: 'Elsewhere', steps: 1, workspace: OTHER },
			{ id: SUBAGENT, title: 'Worker', steps: 1, workspace: PROJECT, parent: INDEXED },
		]);
		fs.writeFileSync(
			path.join(agyHome, 'cache', 'last_conversations.json'),
			JSON.stringify({ [PROJECT]: BY_LAST_MAP, [OTHER]: OTHER_PROJECT })
		);
	});

	afterEach(() => {
		setSessionInfoCacheForTest('antigravity', null);
		fs.rmSync(home.dir, { recursive: true, force: true });
	});

	it("lists the project's conversations from the index, the last-conversation map, and command Cwds", async () => {
		const sessions = await new AntigravitySessionStorage().listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId).sort()).toEqual(
			[INDEXED, BY_LAST_MAP, BY_COMMAND_CWD].sort()
		);
		const indexed = sessions.find((s) => s.sessionId === INDEXED)!;
		expect(indexed).toMatchObject({
			projectPath: PROJECT,
			sessionName: 'Listing Files',
			firstMessage: 'List the files, then explain them.',
			messageCount: 3,
			// Summed over model steps: 15800 + 6000 input, 194 + 231 output.
			inputTokens: 21800,
			outputTokens: 425,
			cacheReadTokens: 10275,
			cacheCreationTokens: 0,
			timestamp: '2026-10-06T14:05:05.500Z',
		});
		expect(sessions.find((s) => s.sessionId === BY_COMMAND_CWD)?.projectPath).toBe(
			`${PROJECT}/sub`
		);
	});

	it('reads messages with tool calls settled by their stored results', async () => {
		const storage = new AntigravitySessionStorage();
		const { messages, total } = await storage.readSessionMessages(PROJECT, INDEXED);

		expect(total).toBe(3);
		expect(messages.map((m) => [m.type, m.content])).toEqual([
			['user', 'List the files, then explain them.'],
			['assistant', ''],
			['assistant', 'There is one file, hello.txt.'],
		]);
		expect(messages[1].toolUse).toEqual([
			{
				tool: 'run_command',
				args: JSON.stringify({
					CommandLine: 'ls',
					Cwd: PROJECT,
					toolAction: 'Listing',
					toolSummary: 'Run ls',
				}),
				// agy's UI labels are dropped from the input the badge shows.
				state: {
					status: 'completed',
					input: { CommandLine: 'ls', Cwd: PROJECT },
					output: 'hello.txt',
				},
			},
			{
				tool: 'run_command',
				args: JSON.stringify({ CommandLine: 'false', Cwd: PROJECT }),
				state: {
					status: 'failed',
					input: { CommandLine: 'false', Cwd: PROJECT },
					output: 'The command exited with code 1.',
				},
			},
		]);
	});

	it("never returns another project's or a subagent's conversation", async () => {
		const storage = new AntigravitySessionStorage();
		expect((await storage.readSessionMessages(PROJECT, OTHER_PROJECT)).total).toBe(0);
		expect((await storage.readSessionMessages(PROJECT, SUBAGENT)).total).toBe(0);
		expect((await storage.readSessionMessages(PROJECT, '../../etc/passwd')).total).toBe(0);
		expect((await storage.listSessions(OTHER)).map((s) => s.sessionId)).toEqual([OTHER_PROJECT]);
	});

	it('serves an unchanged conversation from the cache and re-reads one whose store changed', async () => {
		const storage = new AntigravitySessionStorage();
		await storage.listSessions(PROJECT);
		const store = path.join(
			home.dir,
			'.gemini',
			'antigravity-cli',
			'conversations',
			`${INDEXED}.db`
		);

		// Unchanged (same index row, size and mtime): served without opening the store.
		opened.files.length = 0;
		expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).toContain(INDEXED);
		expect(opened.files).not.toContain(store);

		// A different size moves the fingerprint: re-read, unreadable, dropped.
		fs.writeFileSync(store, 'not a database any more');
		opened.files.length = 0;
		expect((await storage.listSessions(PROJECT)).map((s) => s.sessionId)).not.toContain(INDEXED);
		expect(opened.files).toContain(store);
	});

	it.runIf(process.platform === 'win32')(
		'matches the project folder case-insensitively on Windows',
		async () => {
			const sessions = await new AntigravitySessionStorage().listSessions(PROJECT.toUpperCase());
			expect(sessions.map((s) => s.sessionId)).toContain(INDEXED);
		}
	);

	it('is local only, opts out of the transcript mirror, and refuses message deletion', async () => {
		const storage = new AntigravitySessionStorage();
		const ssh = {
			id: 'r',
			name: 'r',
			host: 'h',
			port: 22,
			username: 'u',
			privateKeyPath: '',
			enabled: true,
		};
		expect(await storage.listSessions(PROJECT, ssh)).toEqual([]);
		// The mirror copies one file, and a WAL store is not one self-contained file.
		expect(storage.getSessionPath()).toBeNull();
		expect((await storage.deleteMessagePair()).success).toBe(false);
	});
});

describe('parseConversationSteps', () => {
	// One real view_file result contained agy's status sentence; it must not read as failed.
	it('reads an exit code only from a run_command result', () => {
		const viewArgs = { AbsolutePath: '/w/notes.md' };
		const { messages } = parseConversationSteps([
			{ idx: 0, step_type: 14, step_payload: userStep(T0, 'Read notes.md') },
			{
				idx: 1,
				step_type: 15,
				step_payload: modelStep(T0 + 1, '', [{ id: 'v', name: 'view_file', args: viewArgs }], {
					input: 10,
					output: 1,
					cacheRead: 0,
				}),
			},
			{
				idx: 2,
				step_type: 132,
				step_payload: toolStep(
					T0 + 2,
					'v',
					'view_file',
					viewArgs,
					'File Path: `file:///w/notes.md`\nThe command exited with code 1.\nOutput:\nfrom an old log\n'
				),
			},
		]);
		expect(messages[1].toolUse).toEqual([
			{
				tool: 'view_file',
				args: JSON.stringify(viewArgs),
				state: {
					status: 'completed',
					input: viewArgs,
					output: 'File Path: `file:///w/notes.md`',
				},
			},
		]);
	});
});
