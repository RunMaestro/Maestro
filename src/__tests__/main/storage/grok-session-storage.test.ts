import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be declared before imports)
// ============================================================================

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readDirRemote: vi.fn(),
	statRemote: vi.fn(),
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
	},
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { GrokSessionStorage } from '../../../main/storage/grok-session-storage';
import * as remoteFs from '../../../main/utils/remote-fs';
import { captureException } from '../../../main/utils/sentry';
import type { SshRemoteConfig } from '../../../shared/types';

// ============================================================================
// Fixtures
//
// Record shapes are derived from real captured Grok CLI sessions (see the
// Phase 02 research notes); paths and content are synthesized so nothing
// private lands in the repo.
// ============================================================================

const SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const PROJECT = '/Users/test/my-project';
const OTHER_PROJECT = '/Users/test/other-project';
const SESSION_ID = '019f0000-aaaa-7000-8000-000000000001';

const sshConfig: SshRemoteConfig = {
	id: 'r1',
	name: 'r1',
	host: 'h',
	port: 22,
	username: 'u',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
};

/** summary.json content matching Grok's on-disk shape. */
function summaryJson(id: string, cwd: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		info: { id, cwd },
		session_summary: 'Create hello.txt File and Read Contents Back',
		generated_title: 'Create hello.txt File and Read Contents Back',
		created_at: '2026-07-09T17:44:28.000Z',
		updated_at: '2026-07-09T17:45:14.000Z',
		num_messages: 8,
		current_model_id: 'grok-4.5',
		...overrides,
	});
}

/**
 * A realistic chat_history.jsonl: system prompt, `<user_info>` environment
 * block, synthetic context injection, a real `<user_query>`-wrapped prompt,
 * reasoning, a tool call with its tool_result, and a final assistant reply.
 * Parses to 3 display messages (user, assistant+tool, assistant).
 */
function chatHistoryJsonl(): string {
	return [
		{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
		{
			type: 'user',
			content: [
				{ type: 'text', text: '<user_info>\nOS Version: macos\nShell: /bin/zsh\n</user_info>' },
			],
		},
		{
			type: 'user',
			synthetic_reason: 'project_instructions',
			content: [
				{ type: 'text', text: '<system-reminder>\nProject instructions here.\n</system-reminder>' },
			],
		},
		{
			type: 'user',
			content: [
				{
					type: 'text',
					text: '<user_query>\nCreate a file named hello.txt containing the word hello, then read it back\n</user_query>',
				},
			],
		},
		{ type: 'reasoning', id: 'r1', status: 'completed', encrypted_content: 'opaque' },
		{
			type: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'call-1', name: 'write', arguments: '{"file_path":"hello.txt","contents":"hello"}' },
			],
		},
		{
			type: 'tool_result',
			tool_call_id: 'call-1',
			content: 'The file hello.txt has been created.',
		},
		{ type: 'assistant', content: 'Created `hello.txt` and read it back.' },
	]
		.map((record) => JSON.stringify(record))
		.join('\n');
}

/** A never-prompted session: only system/environment/synthetic records. */
function neverPromptedJsonl(): string {
	return [
		{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
		{
			type: 'user',
			content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }],
		},
		{
			type: 'user',
			synthetic_reason: 'system_reminder',
			content: [{ type: 'text', text: '<system-reminder>\nSkills available.\n</system-reminder>' }],
		},
	]
		.map((record) => JSON.stringify(record))
		.join('\n');
}

/** Build the two on-disk files for one session under its percent-encoded cwd folder. */
function sessionFiles(
	cwd: string,
	sessionId: string,
	summary: string,
	chatHistory: string
): Record<string, string> {
	const dir = path.join(SESSIONS_DIR, encodeURIComponent(cwd), sessionId);
	return {
		[path.join(dir, 'summary.json')]: summary,
		[path.join(dir, 'chat_history.jsonl')]: chatHistory,
	};
}

/**
 * Wire the fs/promises mocks to serve a virtual file tree. Directories are
 * derived from file paths; anything else throws ENOENT like the real fs.
 */
function mockLocalFs(
	files: Record<string, string>,
	options: { sizeOverrides?: Record<string, number> } = {}
): void {
	// dir path -> child name -> isFile
	const children = new Map<string, Map<string, boolean>>();
	for (const filePath of Object.keys(files)) {
		let childPath = filePath;
		let isFile = true;
		for (;;) {
			const parent = path.dirname(childPath);
			if (parent === childPath) break;
			let entries = children.get(parent);
			if (!entries) {
				entries = new Map();
				children.set(parent, entries);
			}
			if (!entries.has(path.basename(childPath))) {
				entries.set(path.basename(childPath), isFile);
			}
			childPath = parent;
			isFile = false;
		}
	}

	const enoent = (p: string) =>
		Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: 'ENOENT' });

	vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
		const entries = children.get(String(dirPath));
		if (!entries) throw enoent(String(dirPath));
		return [...entries.entries()].map(([name, isFile]) => ({
			name,
			isDirectory: () => !isFile,
			isFile: () => isFile,
		})) as never;
	});

	vi.mocked(fs.stat).mockImplementation(async (filePath) => {
		const p = String(filePath);
		if (!(p in files)) throw enoent(p);
		return {
			size: options.sizeOverrides?.[p] ?? Buffer.byteLength(files[p]),
			mtimeMs: 1_752_082_000_000,
		} as never;
	});

	vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
		const p = String(filePath);
		if (!(p in files)) throw enoent(p);
		return files[p] as never;
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('GrokSessionStorage — local listing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists sessions for the project and excludes other projects without opening their files', async () => {
		const otherId = '019f0000-aaaa-7000-8000-000000000002';
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			...sessionFiles(
				OTHER_PROJECT,
				otherId,
				summaryJson(otherId, OTHER_PROJECT),
				chatHistoryJsonl()
			),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
		expect(sessions[0].projectPath).toBe(PROJECT);
		// Project filtering happens on folder names — the foreign session's
		// files must never be opened.
		const readPaths = vi.mocked(fs.readFile).mock.calls.map((c) => String(c[0]));
		expect(readPaths.some((p) => p.includes(encodeURIComponent(OTHER_PROJECT)))).toBe(false);
	});

	it('exposes summary.json metadata: title, timestamps, preview, message count, zero tokens', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		expect(session.sessionName).toBe('Create hello.txt File and Read Contents Back');
		expect(session.timestamp).toBe('2026-07-09T17:44:28.000Z');
		expect(session.modifiedAt).toBe('2026-07-09T17:45:14.000Z');
		expect(session.durationSeconds).toBe(46);
		// Preview is the real prompt with the <user_query> wrapper stripped.
		expect(session.firstMessage).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);
		expect(session.messageCount).toBe(3);
		// Grok transcripts carry no token counts; zeros, not fabricated values.
		expect(session.inputTokens).toBe(0);
		expect(session.outputTokens).toBe(0);
	});

	it('matches sessions recorded under /private/var when the project path uses /var (and vice versa)', async () => {
		const recordedCwd = '/private/var/folders/T/grok-test';
		mockLocalFs(
			sessionFiles(
				recordedCwd,
				SESSION_ID,
				summaryJson(SESSION_ID, recordedCwd),
				chatHistoryJsonl()
			)
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions('/var/folders/T/grok-test');

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
	});

	it('includes sessions whose recorded cwd is a subdirectory of the project path', async () => {
		const subdirCwd = `${PROJECT}/packages/app`;
		mockLocalFs(
			sessionFiles(subdirCwd, SESSION_ID, summaryJson(SESSION_ID, subdirCwd), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		// A sibling project sharing the prefix must NOT match.
		expect(await storage.listSessions('/Users/test/my-proj')).toEqual([]);
	});

	it('returns an empty list when the sessions directory does not exist', async () => {
		mockLocalFs({}); // no files: readdir on the base dir throws ENOENT

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
		expect(vi.mocked(captureException)).not.toHaveBeenCalled();
	});

	it('excludes never-prompted sessions that contain only system/synthetic records', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), neverPromptedJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
	});

	it('skips a session with malformed summary.json without throwing, keeping good sessions', async () => {
		const goodId = '019f0000-aaaa-7000-8000-000000000003';
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, 'not valid json {', chatHistoryJsonl()),
			...sessionFiles(PROJECT, goodId, summaryJson(goodId, PROJECT), chatHistoryJsonl()),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId)).toEqual([goodId]);
	});

	it('tolerates malformed transcript lines (live-write partial line) without throwing', async () => {
		// Grok appends while running, so a live session can end mid-record.
		const truncated = `${chatHistoryJsonl()}\n{"type":"assistant","content":"cut off mid-wri`;
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), truncated));

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].messageCount).toBe(3);
	});

	it('sorts sessions newest-first by modifiedAt', async () => {
		const olderId = '019f0000-aaaa-7000-8000-00000000000a';
		const newerId = '019f0000-aaaa-7000-8000-00000000000b';
		mockLocalFs({
			...sessionFiles(
				PROJECT,
				olderId,
				summaryJson(olderId, PROJECT, { updated_at: '2026-07-08T00:00:00.000Z' }),
				chatHistoryJsonl()
			),
			...sessionFiles(
				PROJECT,
				newerId,
				summaryJson(newerId, PROJECT, { updated_at: '2026-07-09T00:00:00.000Z' }),
				chatHistoryJsonl()
			),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId)).toEqual([newerId, olderId]);
	});

	it('skips sessions whose transcript exceeds the 100MB read budget without reading it', async () => {
		const files = sessionFiles(
			PROJECT,
			SESSION_ID,
			summaryJson(SESSION_ID, PROJECT),
			chatHistoryJsonl()
		);
		const transcriptPath = Object.keys(files).find((p) => p.endsWith('chat_history.jsonl'))!;
		mockLocalFs(files, { sizeOverrides: { [transcriptPath]: 200 * 1024 * 1024 } });

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
		const readPaths = vi.mocked(fs.readFile).mock.calls.map((c) => String(c[0]));
		expect(readPaths).not.toContain(transcriptPath);
	});
});

describe('GrokSessionStorage — reading messages', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('maps transcript records to display messages, merging tool_result into the tool call', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(false);
		const [user, toolTurn, reply] = result.messages;

		// The <user_query> wrapper is stripped; synthetic/system/reasoning
		// records never surface.
		expect(user.role).toBe('user');
		expect(user.content).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);

		expect(toolTurn.role).toBe('assistant');
		const toolUse = toolTurn.toolUse as Array<{
			tool?: string;
			state: { status: string; input?: unknown; output?: string };
		}>;
		expect(toolUse).toHaveLength(1);
		expect(toolUse[0].tool).toBe('write');
		expect(toolUse[0].state.status).toBe('completed');
		expect(toolUse[0].state.input).toEqual({ file_path: 'hello.txt', contents: 'hello' });
		expect(toolUse[0].state.output).toBe('The file hello.txt has been created.');

		expect(reply.role).toBe('assistant');
		expect(reply.content).toBe('Created `hello.txt` and read it back.');
	});

	it('returns an empty result for a session owned by a different project (ownership guard)', async () => {
		mockLocalFs(
			sessionFiles(
				OTHER_PROJECT,
				SESSION_ID,
				summaryJson(SESSION_ID, OTHER_PROJECT),
				chatHistoryJsonl()
			)
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result).toEqual({ messages: [], total: 0, hasMore: false });
	});

	it('paginates from the end of the transcript', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 2 });

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(true);
		expect(result.messages).toHaveLength(2);
		// Most recent messages come back: the tool turn and the final reply.
		expect(result.messages[1].content).toBe('Created `hello.txt` and read it back.');
	});
});

describe('GrokSessionStorage — SSH remote', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const encodedProject = encodeURIComponent(PROJECT);

	/** Wire the remote mocks to serve one session under the project's cwd folder. */
	function mockRemoteSession(): void {
		vi.mocked(remoteFs.readDirRemote).mockImplementation(async (dirPath: string) => {
			if (dirPath === '~/.grok/sessions') {
				return {
					success: true,
					data: [{ name: encodedProject, isDirectory: true, isSymlink: false }],
				};
			}
			if (dirPath === `~/.grok/sessions/${encodedProject}`) {
				return {
					success: true,
					data: [{ name: SESSION_ID, isDirectory: true, isSymlink: false }],
				};
			}
			return { success: false, error: 'Directory not found or not accessible' };
		});
		vi.mocked(remoteFs.statRemote).mockResolvedValue({
			success: true,
			data: { size: 2048, isDirectory: false, mtime: 1_752_082_000_000 },
		});
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath.endsWith('/summary.json')) {
				return { success: true, data: summaryJson(SESSION_ID, PROJECT) };
			}
			if (filePath.endsWith('/chat_history.jsonl')) {
				return { success: true, data: chatHistoryJsonl() };
			}
			return { success: false, error: 'No such file' };
		});
	}

	it('lists and reads sessions on a remote host via remote-fs', async () => {
		mockRemoteSession();

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT, sshConfig);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
		// No local fs access on the remote path.
		expect(vi.mocked(fs.readdir)).not.toHaveBeenCalled();
		expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();

		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);
		expect(result.total).toBe(3);
		expect(result.messages[0].content).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);
	});

	it('returns an empty list when the remote sessions directory does not exist, without reporting', async () => {
		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: false,
			error: 'Directory not found or not accessible',
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT, sshConfig);

		expect(sessions).toEqual([]);
		expect(vi.mocked(remoteFs.readFileRemote)).not.toHaveBeenCalled();
		expect(vi.mocked(captureException)).not.toHaveBeenCalled();
	});
});

describe('GrokSessionStorage — misc contract', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('reports message-pair deletion as unsupported', async () => {
		const storage = new GrokSessionStorage();
		const result = await storage.deleteMessagePair(PROJECT, SESSION_ID, 'grok-msg-0');

		expect(result.success).toBe(false);
		expect(result.error).toContain('not supported');
	});

	it('getSessionPath returns the encoded-cwd transcript path guess', async () => {
		const storage = new GrokSessionStorage();
		const sessionPath = storage.getSessionPath(PROJECT, SESSION_ID);

		expect(sessionPath).toBe(
			path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'chat_history.jsonl')
		);
	});
});
