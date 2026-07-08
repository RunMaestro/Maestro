/**
 * @file agent-session-storage.integration.test.ts
 * @description Integration tests for Codex and OpenCode session storage against real temp files.
 */

import * as fsPromises from 'fs/promises';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Store from 'electron-store';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';
import type { SshRemoteConfig } from '../../shared/types';
import type { ClaudeSessionOriginsData } from '../../main/storage/claude-session-storage';

let tempRoot: string;
let homeDir: string;
let userDataDir: string;
let originalEnv: NodeJS.ProcessEnv;

async function resetStorageModules() {
	originalEnv = { ...process.env };
	tempRoot = await mkdtemp(path.join(tmpdir(), 'maestro-agent-storage-'));
	homeDir = path.join(tempRoot, 'home');
	userDataDir = path.join(tempRoot, 'user-data');
	await mkdir(homeDir, { recursive: true });
	await mkdir(userDataDir, { recursive: true });

	vi.resetModules();
	vi.doMock('os', () => ({
		default: { homedir: () => homeDir },
		homedir: () => homeDir,
	}));
	vi.doMock('electron', () => ({
		app: {
			getPath: vi.fn(() => userDataDir),
		},
	}));
	vi.doMock('../../main/utils/logger', () => ({
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	}));
	vi.doMock('../../main/utils/sentry', () => ({
		captureException: vi.fn(),
	}));
}

async function writeJson(filePath: string, value: unknown) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(value), 'utf-8');
}

async function writeCodexSession(projectPath: string, sessionId: string) {
	const sessionDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '25');
	const sessionFile = path.join(sessionDir, `rollout-20260525_120000_000-${sessionId}.jsonl`);
	const lines = [
		{
			type: 'session_meta',
			timestamp: '2026-05-25T12:00:00.000Z',
			payload: {
				id: sessionId,
				cwd: projectPath,
				timestamp: '2026-05-25T12:00:00.000Z',
			},
		},
		{
			type: 'message',
			role: 'user',
			timestamp: '2026-05-25T12:00:01.000Z',
			content: [{ type: 'input_text', text: '<environment_context><cwd>/ignored</cwd>' }],
		},
		{
			type: 'message',
			role: 'user',
			timestamp: '2026-05-25T12:00:02.000Z',
			content: [{ type: 'input_text', text: 'Add integration coverage' }],
		},
		{
			type: 'message',
			role: 'assistant',
			timestamp: '2026-05-25T12:00:04.000Z',
			content: [{ type: 'output_text', text: 'Implemented storage coverage' }],
		},
		{
			type: 'turn.completed',
			timestamp: '2026-05-25T12:00:05.000Z',
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				reasoning_output_tokens: 5,
				cached_input_tokens: 3,
			},
		},
		{
			type: 'response_item',
			timestamp: '2026-05-25T12:00:06.000Z',
			payload: {
				type: 'function_call',
				name: 'shell',
				arguments: '{"cmd":"ls"}',
				call_id: 'call-1',
			},
		},
		{
			type: 'response_item',
			timestamp: '2026-05-25T12:00:07.000Z',
			payload: {
				type: 'function_call_output',
				call_id: 'call-1',
				output: 'ok',
			},
		},
		{
			type: 'message',
			role: 'user',
			timestamp: '2026-05-25T12:00:08.000Z',
			content: [{ type: 'input_text', text: 'Second request' }],
		},
		{
			type: 'turn.completed',
			timestamp: '2026-05-25T12:00:08.500Z',
			usage: {},
		},
		{
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: {},
			},
		},
		{
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: {
					total_token_usage: {},
				},
			},
		},
	];
	await mkdir(sessionDir, { recursive: true });
	await writeFile(
		sessionFile,
		`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
		'utf-8'
	);
	const timestamp = new Date('2026-05-25T12:00:10.000Z');
	await utimes(sessionFile, timestamp, timestamp);
	return sessionFile;
}

async function writeCodexJsonl(
	filename: string,
	entries: Array<Record<string, unknown> | string>,
	modifiedAt: string = '2026-05-26T12:00:00.000Z'
) {
	const sessionDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '26');
	const sessionFile = path.join(sessionDir, filename);
	await mkdir(sessionDir, { recursive: true });
	await writeFile(
		sessionFile,
		`${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`,
		'utf-8'
	);
	const timestamp = new Date(modifiedAt);
	await utimes(sessionFile, timestamp, timestamp);
	return sessionFile;
}

async function writeClaudeSession(
	projectPath: string,
	sessionId: string,
	entries: Array<Record<string, unknown> | string>,
	modifiedAt: string
) {
	const encodedProjectPath = encodeClaudeProjectPath(projectPath);
	const sessionDir = path.join(homeDir, '.claude', 'projects', encodedProjectPath);
	const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
	await mkdir(sessionDir, { recursive: true });
	await writeFile(
		sessionFile,
		`${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`,
		'utf-8'
	);
	const timestamp = new Date(modifiedAt);
	await utimes(sessionFile, timestamp, timestamp);
	return { sessionDir, sessionFile };
}

function claudeUser(uuid: string, content: unknown, timestamp: string) {
	return {
		type: 'user',
		uuid,
		timestamp,
		message: { role: 'user', content },
	};
}

function claudeAssistant(uuid: string, content: unknown, timestamp: string) {
	return {
		type: 'assistant',
		uuid,
		timestamp,
		message: {
			role: 'assistant',
			content,
			usage: {
				input_tokens: 11,
				output_tokens: 13,
				cache_read_input_tokens: 17,
				cache_creation_input_tokens: 19,
			},
		},
	};
}

function createClaudeOriginsStore() {
	const data: ClaudeSessionOriginsData = { origins: {} };
	const store = {
		get: vi.fn((key: string, defaultValue?: unknown) => {
			return (data as unknown as Record<string, unknown>)[key] ?? defaultValue;
		}),
		set: vi.fn((key: string, value: unknown) => {
			(data as unknown as Record<string, unknown>)[key] = value;
		}),
	};
	return store as unknown as Store<ClaudeSessionOriginsData>;
}

async function writeOpenCodeSession(projectPath: string) {
	const storageRoot = path.join(homeDir, '.local', 'share', 'opencode', 'storage');
	const projectId = 'project-alpha';
	const sessionId = 'ses_alpha';
	await writeJson(path.join(storageRoot, 'project', `${projectId}.json`), {
		id: projectId,
		worktree: projectPath,
	});
	await writeJson(path.join(storageRoot, 'session', projectId, `${sessionId}.json`), {
		id: sessionId,
		projectID: projectId,
		directory: projectPath,
		title: 'OpenCode title fallback',
		time: {
			created: Date.parse('2026-05-25T13:00:00.000Z'),
			updated: Date.parse('2026-05-25T13:00:10.000Z'),
		},
	});

	const messages = [
		{
			id: 'msg-user',
			sessionID: sessionId,
			role: 'user',
			time: { created: Date.parse('2026-05-25T13:00:01.000Z') },
			tokens: { input: 4, cache: { read: 1, write: 2 } },
			cost: 0.01,
		},
		{
			id: 'msg-assistant',
			sessionID: sessionId,
			role: 'assistant',
			time: { created: Date.parse('2026-05-25T13:00:05.000Z') },
			tokens: { output: 9 },
			cost: 0.02,
		},
		{
			id: 'msg-next',
			sessionID: sessionId,
			role: 'user',
			time: { created: Date.parse('2026-05-25T13:00:09.000Z') },
		},
	] as const;

	for (const message of messages) {
		await writeJson(path.join(storageRoot, 'message', sessionId, `${message.id}.json`), message);
	}
	await writeJson(path.join(storageRoot, 'part', 'msg-user', 'part-user.json'), {
		id: 'part-user',
		messageID: 'msg-user',
		type: 'text',
		text: 'Run OpenCode integration storage test',
	});
	await writeJson(path.join(storageRoot, 'part', 'msg-assistant', 'part-assistant.json'), {
		id: 'part-assistant',
		messageID: 'msg-assistant',
		type: 'text',
		text: 'OpenCode storage integration complete',
	});
	await writeJson(path.join(storageRoot, 'part', 'msg-assistant', 'part-tool.json'), {
		id: 'tool-part',
		messageID: 'msg-assistant',
		type: 'tool',
		tool: 'bash',
		state: { status: 'completed', output: 'ok' },
	});
	await writeJson(path.join(storageRoot, 'part', 'msg-next', 'part-next.json'), {
		id: 'part-next',
		messageID: 'msg-next',
		type: 'text',
		text: 'Follow-up request',
	});

	return { storageRoot, projectId, sessionId };
}

describe('agent session storage integration', () => {
	beforeEach(async () => {
		await resetStorageModules();
	});

	afterEach(async () => {
		vi.doUnmock('os');
		vi.doUnmock('electron');
		vi.doUnmock('../../main/utils/logger');
		vi.doUnmock('../../main/utils/sentry');
		vi.doUnmock('../../main/utils/remote-fs');
		vi.doUnmock('../../shared/platformDetection');
		vi.doUnmock('better-sqlite3');
		vi.doUnmock('fs/promises');
		vi.resetModules();
		process.env = originalEnv;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it('indexes, reads, searches, paginates, caches, and deletes Codex JSONL sessions', async () => {
		const projectPath = path.join(tempRoot, 'project');
		await mkdir(projectPath, { recursive: true });
		const sessionId = '11111111-1111-4111-8111-111111111111';
		const sessionFile = await writeCodexSession(projectPath, sessionId);
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			projectPath,
			firstMessage: 'Implemented storage coverage',
			messageCount: 4,
			inputTokens: 10,
			outputTokens: 25,
			cacheReadTokens: 3,
		});

		const page = await storage.listSessionsPaginated(projectPath, { limit: 1 });
		expect(page).toMatchObject({ totalCount: 1, hasMore: false, nextCursor: null });

		const messages = await storage.readSessionMessages(projectPath, sessionId, { limit: 10 });
		expect(messages.total).toBe(5);
		expect(messages.messages.map((message) => message.content)).toEqual([
			'<environment_context><cwd>/ignored</cwd>',
			'Add integration coverage',
			'Implemented storage coverage',
			'Tool: shell',
			'Second request',
		]);
		expect(messages.messages[3].toolUse?.[0]?.state?.input).toEqual({ cmd: 'ls' });
		expect(messages.messages[3].toolUse?.[0]?.state?.output).toBe('ok');

		const search = await storage.searchSessions(projectPath, 'storage coverage', 'assistant');
		expect(search).toEqual([
			expect.objectContaining({
				sessionId,
				matchType: 'assistant',
				matchCount: 1,
			}),
		]);

		const deleteResult = await storage.deleteMessagePair(
			projectPath,
			sessionId,
			'codex-msg-does-not-match-file-index',
			'Add integration coverage'
		);
		expect(deleteResult).toMatchObject({ success: true, linesRemoved: 5 });
		const updatedContent = await readFile(sessionFile, 'utf-8');
		expect(updatedContent).toContain('Second request');
		expect(updatedContent).not.toContain('Implemented storage coverage');

		const cacheFile = path.join(userDataDir, 'stats-cache', 'codex-sessions-cache.json');
		await expect(stat(cacheFile)).resolves.toMatchObject({ size: expect.any(Number) });
	});

	it('returns empty Codex results for missing local session storage and unsupported path lookup', async () => {
		const projectPath = path.join(tempRoot, 'codex-empty-project');
		await mkdir(projectPath, { recursive: true });
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		await expect(storage.readSessionMessages(projectPath, 'missing-session')).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
		await expect(storage.searchSessions(projectPath, '   ', 'all')).resolves.toEqual([]);
		expect(storage.getSessionPath(projectPath, 'missing-session')).toBeNull();
		await expect(
			storage.deleteMessagePair(projectPath, 'missing-session', 'codex-msg-0')
		).resolves.toEqual({
			success: false,
			error: 'Session file not found',
		});
	});

	it('reads Codex messages with missing optional ids, timestamps, arguments, and outputs', async () => {
		const projectPath = path.join(tempRoot, 'codex-optional-fields-project');
		await mkdir(projectPath, { recursive: true });
		const fallbackId = '55555555-5555-4555-8555-555555555555';
		await writeCodexJsonl(`rollout-20260526_083000_000-${fallbackId}.jsonl`, [
			{
				type: 'session_meta',
				payload: { id: fallbackId, cwd: projectPath, timestamp: '2026-05-26T08:30:00.000Z' },
			},
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'system',
					content: [{ type: 'output_text', text: 'Ignored system response item' }],
				},
			},
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					content: [],
				},
			},
			{
				type: 'response_item',
				payload: {
					type: 'function_call',
					name: 'fallback-tool',
				},
			},
			{
				type: 'response_item',
				payload: {
					type: 'function_call_output',
				},
			},
			{
				type: 'item.completed',
				item: { type: 'agent_message' },
			},
			{
				type: 'item.completed',
				item: { type: 'tool_call', tool: 'legacy-fallback-tool' },
			},
			{
				type: 'item.completed',
				item: { type: 'tool_result' },
			},
		]);
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const result = await storage.readSessionMessages(projectPath, fallbackId, { limit: 10 });

		expect(result.total).toBe(5);
		expect(result.messages.map((message) => message.content)).toEqual([
			'Tool: fallback-tool',
			'[Tool result]',
			'',
			'Tool: legacy-fallback-tool',
			'[Tool result]',
		]);
		expect(result.messages[0].toolUse?.[0]?.state?.input).toEqual({});
		expect(result.messages.map((message) => message.uuid)).toEqual([
			'codex-msg-0',
			'codex-msg-1',
			'codex-msg-2',
			'codex-msg-3',
			'codex-msg-4',
		]);
		expect(result.messages.every((message) => message.timestamp === '')).toBe(true);
	});

	it('indexes mixed local Codex formats, filters projects, and reads legacy tool output', async () => {
		const projectPath = path.join(tempRoot, 'codex-modern-project');
		const nestedProjectPath = path.join(projectPath, 'packages', 'app');
		const outsideProjectPath = path.join(tempRoot, 'codex-other-project');
		await mkdir(nestedProjectPath, { recursive: true });
		await mkdir(outsideProjectPath, { recursive: true });
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const outsideSessionId = '33333333-3333-4333-8333-333333333333';
		await writeCodexJsonl(
			`rollout-20260526_090000_000-${sessionId}.jsonl`,
			[
				{
					type: 'session_meta',
					timestamp: '2026-05-26T09:00:00.000Z',
					payload: {
						id: sessionId,
						cwd: nestedProjectPath,
						timestamp: '2026-05-26T09:00:00.000Z',
					},
				},
				{
					type: 'message',
					role: 'user',
					timestamp: '2026-05-26T09:00:01.000Z',
					content: [{ type: 'input_text', text: '# Context Hidden system prompt' }],
				},
				{
					type: 'response_item',
					timestamp: '2026-05-26T09:00:02.000Z',
					payload: {
						type: 'message',
						role: 'user',
						id: 'modern-user',
						content: [{ type: 'input_text', text: 'Modern user prompt' }],
					},
				},
				{
					type: 'response_item',
					timestamp: '2026-05-26T09:00:04.000Z',
					payload: {
						type: 'message',
						role: 'assistant',
						id: 'modern-assistant',
						content: [{ type: 'output_text', text: 'Modern assistant response' }],
					},
				},
				{
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 7,
								output_tokens: 11,
								reasoning_output_tokens: 2,
								cached_input_tokens: 4,
							},
						},
					},
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-26T09:00:06.000Z',
					item: {
						type: 'agent_message',
						id: 'legacy-agent',
						text: 'Legacy agent response',
					},
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-26T09:00:07.000Z',
					item: {
						type: 'tool_call',
						id: 'legacy-tool',
						tool: 'shell',
						args: { cmd: 'pwd' },
					},
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-26T09:00:08.000Z',
					item: {
						type: 'tool_result',
						id: 'legacy-tool-result',
						tool_call_id: 'legacy-tool',
						output: [111, 107],
					},
				},
				'{malformed-json',
			],
			'2026-05-26T09:00:10.000Z'
		);
		await writeCodexJsonl(
			`rollout-20260526_100000_000-${outsideSessionId}.jsonl`,
			[
				{
					type: 'session_meta',
					payload: {
						id: outsideSessionId,
						cwd: outsideProjectPath,
						timestamp: '2026-05-26T10:00:00.000Z',
					},
				},
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Outside project response' }],
				},
			],
			'2026-05-26T10:00:10.000Z'
		);
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				projectPath: nestedProjectPath,
				firstMessage: 'Modern assistant response',
				messageCount: 4,
				inputTokens: 7,
				outputTokens: 13,
				cacheReadTokens: 4,
				durationSeconds: 8,
			}),
		]);

		const messages = await storage.readSessionMessages(projectPath, sessionId, { limit: 10 });
		expect(messages.total).toBe(6);
		expect(messages.messages.map((message) => message.content)).toEqual([
			'# Context Hidden system prompt',
			'Modern user prompt',
			'Modern assistant response',
			'Legacy agent response',
			'Tool: shell',
			'ok',
		]);
		expect(messages.messages[4].toolUse).toEqual([{ tool: 'shell', args: { cmd: 'pwd' } }]);

		const page = await storage.readSessionMessages(projectPath, sessionId, { offset: 1, limit: 2 });
		expect(page).toMatchObject({ total: 6, hasMore: true });
		expect(page.messages.map((message) => message.content)).toEqual([
			'Legacy agent response',
			'Tool: shell',
		]);

		await expect(storage.searchSessions(projectPath, 'legacy agent', 'assistant')).resolves.toEqual(
			[
				expect.objectContaining({
					sessionId,
					matchType: 'assistant',
					matchCount: 1,
				}),
			]
		);
		await expect(storage.searchSessions(projectPath, 'outside project', 'all')).resolves.toEqual(
			[]
		);
	});

	it('handles local Codex traversal, cache, parsing, metadata lookup, and deletion edges', async () => {
		const projectPath = path.join(tempRoot, 'codex-edge-project');
		const childProjectPath = path.join(projectPath, 'packages', 'app');
		await mkdir(childProjectPath, { recursive: true });
		const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
		const dayDir = path.join(sessionsRoot, '2026', '05', '26');
		await mkdir(dayDir, { recursive: true });
		await writeFile(path.join(sessionsRoot, 'notes.txt'), 'ignored', 'utf-8');
		await writeFile(path.join(sessionsRoot, '2023'), 'not a directory', 'utf-8');
		await fsPromises.symlink(path.join(tempRoot, 'missing-year'), path.join(sessionsRoot, '2024'));
		await mkdir(path.join(sessionsRoot, '2026', 'bad-month'), { recursive: true });
		await writeFile(path.join(sessionsRoot, '2026', '06'), 'not a directory', 'utf-8');
		await fsPromises.symlink(
			path.join(tempRoot, 'missing-month'),
			path.join(sessionsRoot, '2026', '07')
		);
		await mkdir(path.join(sessionsRoot, '2026', '05', 'bad-day'), { recursive: true });
		await writeFile(path.join(sessionsRoot, '2026', '05', '23'), 'not a directory', 'utf-8');
		await fsPromises.symlink(
			path.join(tempRoot, 'missing-day'),
			path.join(sessionsRoot, '2026', '05', '24')
		);
		await writeFile(path.join(dayDir, 'empty.jsonl'), '', 'utf-8');
		await writeFile(path.join(dayDir, 'whitespace.jsonl'), ' \n\n', 'utf-8');
		await fsPromises.symlink(
			path.join(tempRoot, 'missing-session-file'),
			path.join(dayDir, 'stat-failure.jsonl')
		);
		await mkdir(path.join(dayDir, 'directory-session.jsonl'), { recursive: true });
		const oversizedFile = path.join(dayDir, 'oversized.jsonl');
		await writeFile(oversizedFile, '', 'utf-8');
		await fsPromises.truncate(oversizedFile, 101 * 1024 * 1024);
		const legacyId = 'legacy-metadata-session';
		await writeCodexJsonl(
			'plain-session.jsonl',
			[
				{ id: legacyId, timestamp: '2026-05-26T08:00:00.000Z' },
				{
					type: 'message',
					role: 'user',
					timestamp: '2026-05-26T07:59:00.000Z',
					content: [{ type: 'input_text', text: `<cwd>${childProjectPath}</cwd>` }],
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-26T08:02:00.000Z',
					item: { type: 'agent_message', id: 'agent-one', text: 'Legacy assistant preview' },
				},
				{
					type: 'response_item',
					timestamp: '2026-05-26T08:03:00.000Z',
					payload: {
						type: 'function_call',
						name: 'shell',
						arguments: '{bad-json',
						call_id: 'bad-args',
					},
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-26T08:04:00.000Z',
					item: { type: 'tool_result', id: 'object-result', output: { ok: true } },
				},
			],
			'2026-05-26T08:05:00.000Z'
		);
		const responseCwdId = '55555555-5555-4555-8555-555555555555';
		await writeCodexJsonl(
			`rollout-20260526_083000_000-${responseCwdId}.jsonl`,
			[
				{
					type: 'session_meta',
					timestamp: '2026-05-26T08:30:00.000Z',
					payload: { id: responseCwdId, timestamp: '2026-05-26T08:30:00.000Z' },
				},
				{
					type: 'response_item',
					timestamp: '2026-05-26T08:31:00.000Z',
					payload: {
						type: 'message',
						role: 'user',
						id: 'response-cwd-user',
						content: [{ type: 'input_text', text: `<cwd>${projectPath}</cwd>` }],
					},
				},
				{
					type: 'response_item',
					timestamp: '2026-05-26T08:32:00.000Z',
					payload: {
						type: 'message',
						role: 'assistant',
						id: 'response-cwd-assistant',
						content: [{ type: 'output_text', text: 'Response cwd assistant' }],
					},
				},
			],
			'2026-05-26T08:35:00.000Z'
		);
		const missingContentId = '66666666-6666-4666-8666-666666666666';
		await writeCodexJsonl(
			`rollout-20260526_084000_000-${missingContentId}.jsonl`,
			[
				{
					type: 'session_meta',
					payload: { id: missingContentId, cwd: projectPath },
				},
				{ type: 'message', role: 'user' },
				{ type: 'message', role: 'assistant', content: [{ type: 'text', text: '   ' }] },
			],
			'2026-05-26T08:40:00.000Z'
		);
		const deleteId = '77777777-7777-4777-8777-777777777777';
		const deleteFile = await writeCodexJsonl(
			`rollout-20260526_085000_000-${deleteId}.jsonl`,
			[
				{
					type: 'session_meta',
					payload: { id: deleteId, cwd: projectPath },
				},
				'{malformed-delete-line',
				{
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: 'Delete target' }],
				},
				{
					type: 'item.completed',
					item: { type: 'tool_call', id: 'tool-delete', tool: 'shell' },
				},
				{
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: 'Keep target' }],
				},
				{
					type: 'item.completed',
					item: { type: 'tool_result', tool_call_id: 'tool-delete', output: 'remove orphan' },
				},
				{
					type: 'item.completed',
					item: { type: 'tool_result', tool_call_id: 'other-tool', output: 'keep result' },
				},
			],
			'2026-05-26T08:50:00.000Z'
		);
		const cacheDir = path.join(userDataDir, 'stats-cache');
		await mkdir(cacheDir, { recursive: true });
		await writeFile(
			path.join(cacheDir, 'codex-sessions-cache.json'),
			JSON.stringify({ version: 2, lastProcessedAt: 1, sessions: {} }),
			'utf-8'
		);
		const { CodexSessionStorage, isSystemContextMessage } =
			await import('../../main/storage/codex-session-storage');
		const { logger } = await import('../../main/utils/logger');
		class TestableCodexSessionStorage extends CodexSessionStorage {
			readSearchableMessagesForTest(
				sessionId: string,
				currentProjectPath: string,
				sshConfig?: SshRemoteConfig
			) {
				return this.getSearchableMessages(sessionId, currentProjectPath, sshConfig);
			}
		}
		const storage = new TestableCodexSessionStorage();

		expect(isSystemContextMessage('')).toBe(false);
		const sessions = await storage.listSessions(projectPath);
		expect(sessions.map((session) => session.sessionId)).toEqual([
			deleteId,
			missingContentId,
			responseCwdId,
			legacyId,
		]);
		expect(sessions.find((session) => session.sessionId === legacyId)).toMatchObject({
			projectPath: childProjectPath,
			firstMessage: 'Legacy assistant preview',
			durationSeconds: 300,
		});
		expect(sessions.find((session) => session.sessionId === responseCwdId)).toMatchObject({
			projectPath,
			firstMessage: 'Response cwd assistant',
		});

		const metadataMessages = await storage.readSessionMessages(projectPath, legacyId, {
			limit: 10,
		});
		expect(metadataMessages.messages.map((message) => message.content)).toEqual([
			`<cwd>${childProjectPath}</cwd>`,
			'Legacy assistant preview',
			'Tool: shell',
			'[object Object]',
		]);
		expect(metadataMessages.messages[2].toolUse?.[0]?.state?.input).toBe('{bad-json');
		await expect(
			storage.readSearchableMessagesForTest('missing-local-session', projectPath)
		).resolves.toEqual([]);
		await expect(storage.readSessionMessages(projectPath, missingContentId)).resolves.toMatchObject(
			{
				total: 0,
			}
		);

		const deleteResult = await storage.deleteMessagePair(projectPath, deleteId, 'codex-msg-0');
		expect(deleteResult).toEqual({ success: true, linesRemoved: 3 });
		const updatedDeleteContent = await readFile(deleteFile, 'utf-8');
		expect(updatedDeleteContent).toContain('Keep target');
		expect(updatedDeleteContent).toContain('keep result');
		expect(updatedDeleteContent).not.toContain('Delete target');
		expect(updatedDeleteContent).not.toContain('remove orphan');
		await expect(storage.deleteMessagePair(projectPath, deleteId, 'codex-msg-99')).resolves.toEqual(
			{
				success: false,
				error: 'User message not found',
			}
		);
		await expect(
			storage.deleteMessagePair(projectPath, 'directory-session', 'codex-msg-0')
		).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('EISDIR'),
		});

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Error reading Codex session file:'),
			'[CodexSessionStorage]',
			expect.any(Error)
		);
	});

	it('logs local Codex cache save failures when the cache directory is blocked', async () => {
		const projectPath = path.join(tempRoot, 'codex-cache-failure-project');
		await mkdir(projectPath, { recursive: true });
		const sessionId = '88888888-8888-4888-8888-888888888888';
		await writeCodexJsonl(
			`rollout-20260526_090000_000-${sessionId}.jsonl`,
			[
				{
					type: 'session_meta',
					payload: { id: sessionId, cwd: projectPath },
				},
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Cache save still returns sessions' }],
				},
			],
			'2026-05-26T09:00:00.000Z'
		);
		await writeFile(path.join(userDataDir, 'stats-cache'), 'not a directory', 'utf-8');
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const { logger } = await import('../../main/utils/logger');
		const storage = new CodexSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toHaveLength(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to save Codex session cache',
			'[CodexSessionStorage]',
			expect.objectContaining({ error: expect.any(Error) })
		);
	});

	it('removes stale local Codex cache entries after a real file disappears', async () => {
		const projectPath = path.join(tempRoot, 'codex-stale-cache-project');
		await mkdir(projectPath, { recursive: true });
		const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
		const sessionFile = await writeCodexJsonl(
			`rollout-20260526_092000_000-${sessionId}.jsonl`,
			[
				{
					type: 'session_meta',
					payload: { id: sessionId, cwd: projectPath },
				},
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Fresh cache session' }],
				},
			],
			'2026-05-26T09:20:00.000Z'
		);
		const stalePath = path.join(homeDir, '.codex', 'sessions', '2026', '05', '26', 'stale.jsonl');
		const cacheDir = path.join(userDataDir, 'stats-cache');
		await mkdir(cacheDir, { recursive: true });
		await writeFile(
			path.join(cacheDir, 'codex-sessions-cache.json'),
			JSON.stringify({
				version: 3,
				lastProcessedAt: 1,
				sessions: {
					[stalePath]: {
						session: {
							sessionId: 'stale',
							projectPath,
							timestamp: '2026-05-26T09:00:00.000Z',
							modifiedAt: '2026-05-26T09:00:00.000Z',
							firstMessage: 'stale',
							messageCount: 1,
							sizeBytes: 1,
						},
						fileMtimeMs: 1,
					},
				},
			}),
			'utf-8'
		);
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toEqual([
			expect.objectContaining({ sessionId }),
		]);
		const cacheContent = await readFile(path.join(cacheDir, 'codex-sessions-cache.json'), 'utf-8');
		expect(cacheContent).toContain(sessionFile);
		expect(cacheContent).not.toContain(stalePath);
	});

	it('skips local Codex files that fail with RangeError during parsing', async () => {
		const projectPath = path.join(tempRoot, 'codex-range-error-project');
		const rangeId = '99999999-8888-4777-8666-555555555555';
		const sessionsDir = path.join(homeDir, '.codex', 'sessions');
		const yearDir = path.join(sessionsDir, '2026');
		const monthDir = path.join(yearDir, '05');
		const dayDir = path.join(monthDir, '26');
		const rangeFileName = `rollout-20260526_091000_000-${rangeId}.jsonl`;
		const rangeFile = path.join(dayDir, rangeFileName);
		const cachePath = path.join(userDataDir, 'stats-cache', 'codex-sessions-cache.json');
		let throwSessionRootRead = false;
		const accessMock = vi.fn(async (target: string) => {
			if (target === sessionsDir) return undefined;
			throw new Error(`missing ${target}`);
		});
		const readdirMock = vi.fn(async (target: string) => {
			if (throwSessionRootRead && target === sessionsDir) throw new Error('root read failed');
			if (target === sessionsDir) return ['2026'];
			if (target === yearDir) return ['05'];
			if (target === monthDir) return ['26'];
			if (target === dayDir) return [rangeFileName];
			return [];
		});
		const statMock = vi.fn(async (target: string) => {
			if (target === yearDir || target === monthDir || target === dayDir) {
				return { isDirectory: () => true };
			}
			if (target === rangeFile) {
				return { size: 10, mtimeMs: Date.parse('2026-05-26T09:10:00.000Z') };
			}
			throw new Error(`missing stat ${target}`);
		});
		const readFileMock = vi.fn(async (target: string) => {
			if (target === cachePath) throw new Error('no cache');
			if (target === rangeFile) throw new RangeError('invalid string length');
			throw new Error(`missing read ${target}`);
		});
		const mkdirMock = vi.fn(async () => undefined);
		const writeFileMock = vi.fn(async () => undefined);
		vi.doMock('fs/promises', () => {
			const fsMock = {
				access: accessMock,
				readdir: readdirMock,
				stat: statMock,
				readFile: readFileMock,
				mkdir: mkdirMock,
				writeFile: writeFileMock,
			};
			return {
				default: fsMock,
				...fsMock,
			};
		});
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		class TestableCodexSessionStorage extends CodexSessionStorage {
			readSearchableMessagesForTest(sessionId: string, currentProjectPath: string) {
				return this.getSearchableMessages(sessionId, currentProjectPath);
			}
		}
		const { logger } = await import('../../main/utils/logger');
		const storage = new TestableCodexSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			'Codex session file too large to parse',
			'[CodexSessionStorage]',
			{ filePath: rangeFile }
		);
		throwSessionRootRead = true;
		await expect(storage.readSearchableMessagesForTest(rangeId, projectPath)).resolves.toEqual([]);
	});

	it('lists, reads, searches, and rejects deletion for Codex remote JSONL sessions', async () => {
		const sshConfig: SshRemoteConfig = {
			id: 'remote-codex',
			name: 'Remote Codex',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		const projectPath = '/srv/codex-app';
		const sessionId = '44444444-4444-4444-8444-444444444444';
		const remoteSessionPath = `~/.codex/sessions/2026/05/26/rollout-20260526_110000_000-${sessionId}.jsonl`;
		const remoteFiles = new Map<string, string>();
		const remoteDirs = new Map<string, Array<{ name: string; isDirectory: boolean }>>();
		const remoteStats = new Map<string, { size: number; mtime: number }>();
		const putRemoteDir = (
			dirPath: string,
			entries: Array<{ name: string; isDirectory?: boolean }>
		) => {
			remoteDirs.set(
				dirPath,
				entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory ?? false }))
			);
		};
		const remoteContent = [
			JSON.stringify({
				id: sessionId,
				timestamp: '2026-05-26T11:00:00.000Z',
			}),
			JSON.stringify({
				type: 'message',
				role: 'user',
				timestamp: '2026-05-26T11:00:01.000Z',
				content: [{ type: 'input_text', text: `<cwd>${projectPath}</cwd>` }],
			}),
			JSON.stringify({
				type: 'response_item',
				timestamp: '2026-05-26T11:00:06.000Z',
				payload: {
					type: 'message',
					role: 'assistant',
					id: 'remote-assistant',
					content: [{ type: 'output_text', text: 'Remote Codex response' }],
				},
			}),
			JSON.stringify({
				type: 'turn.completed',
				usage: {
					input_tokens: 3,
					output_tokens: 5,
					reasoning_output_tokens: 7,
					cached_input_tokens: 2,
				},
			}),
			JSON.stringify({
				type: 'turn.completed',
				usage: {},
			}),
			JSON.stringify({
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {},
				},
			}),
		].join('\n');

		putRemoteDir('~/.codex/sessions', [
			{ name: 'notes', isDirectory: false },
			{ name: 'draft', isDirectory: true },
			{ name: '2026', isDirectory: true },
		]);
		putRemoteDir('~/.codex/sessions/2026', [
			{ name: 'bad-month', isDirectory: true },
			{ name: '05', isDirectory: true },
		]);
		putRemoteDir('~/.codex/sessions/2026/05', [
			{ name: 'bad-day', isDirectory: true },
			{ name: '26', isDirectory: true },
		]);
		putRemoteDir('~/.codex/sessions/2026/05/26', [
			{ name: 'folder.jsonl', isDirectory: true },
			{ name: 'stat-failure.jsonl' },
			{ name: 'empty.jsonl' },
			{ name: 'oversized.jsonl' },
			{ name: 'read-failure.jsonl' },
			{ name: `rollout-20260526_110000_000-${sessionId}.jsonl` },
		]);
		remoteFiles.set(remoteSessionPath, remoteContent);
		remoteStats.set('~/.codex/sessions/2026/05/26/empty.jsonl', { size: 0, mtime: 1 });
		remoteStats.set('~/.codex/sessions/2026/05/26/oversized.jsonl', {
			size: 101 * 1024 * 1024,
			mtime: 2,
		});
		remoteStats.set('~/.codex/sessions/2026/05/26/read-failure.jsonl', { size: 100, mtime: 3 });
		remoteStats.set(remoteSessionPath, {
			size: Buffer.byteLength(remoteContent),
			mtime: Date.parse('2026-05-26T11:00:10.000Z'),
		});

		vi.doMock('../../main/utils/remote-fs', () => ({
			readDirRemote: vi.fn(async (dirPath: string) => ({
				success: remoteDirs.has(dirPath),
				data: remoteDirs.get(dirPath),
			})),
			readFileRemote: vi.fn(async (filePath: string) => {
				const data = remoteFiles.get(filePath);
				return data === undefined ? { success: false, error: 'missing' } : { success: true, data };
			}),
			statRemote: vi.fn(async (filePath: string) => {
				const data = remoteStats.get(filePath);
				return data === undefined ? { success: false, error: 'missing' } : { success: true, data };
			}),
		}));
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const sessions = await storage.listSessions(projectPath, sshConfig);
		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				projectPath,
				firstMessage: 'Remote Codex response',
				messageCount: 2,
				inputTokens: 3,
				outputTokens: 12,
				cacheReadTokens: 2,
				durationSeconds: 6,
			}),
		]);

		await expect(
			storage.listSessionsPaginated(projectPath, { limit: 1 }, sshConfig)
		).resolves.toMatchObject({
			totalCount: 1,
			hasMore: false,
			nextCursor: null,
		});
		await expect(
			storage.readSessionMessages(projectPath, sessionId, {}, sshConfig)
		).resolves.toMatchObject({
			total: 2,
			messages: [
				expect.objectContaining({
					content: `<cwd>${projectPath}</cwd>`,
				}),
				expect.objectContaining({
					uuid: 'remote-assistant',
					content: 'Remote Codex response',
				}),
			],
		});
		await expect(
			storage.searchSessions(projectPath, 'remote codex response', 'assistant', sshConfig)
		).resolves.toEqual([
			expect.objectContaining({
				sessionId,
				matchType: 'assistant',
				matchCount: 1,
			}),
		]);
		await expect(
			storage.readSessionMessages(projectPath, 'missing-remote-session', {}, sshConfig)
		).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-0', undefined, sshConfig)
		).resolves.toEqual({
			success: false,
			error: 'Delete not supported for remote sessions',
		});
	});

	it('handles remote Codex empty traversal, sorting, metadata lookup, and read failures', async () => {
		const sshConfig: SshRemoteConfig = {
			id: 'remote-codex-edge',
			name: 'Remote Codex Edge',
			host: 'remote-edge.test',
			port: 22,
			username: 'tester',
			enabled: true,
		};
		const projectPath = '/srv/codex-edge';
		const childProjectPath = `${projectPath}/packages/app`;
		const legacyId = 'remote-legacy-session';
		const modernId = '99999999-9999-4999-8999-999999999999';
		const metadataLookupId = 'remote-metadata-lookup';
		const userFallbackId = 'remote-user-fallback';
		const responseCwdId = 'remote-response-cwd';
		const agentOnlyId = 'remote-agent-only';
		const readFailureId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const badContentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		const legacyPath = '~/.codex/sessions/2026/05/26/remote-legacy.jsonl';
		const modernPath = `~/.codex/sessions/2026/05/26/rollout-20260526_120000_000-${modernId}.jsonl`;
		const metadataLookupPath = '~/.codex/sessions/2026/05/26/metadata-lookup.jsonl';
		const whitespacePath = '~/.codex/sessions/2026/05/26/whitespace.jsonl';
		const userFallbackPath = '~/.codex/sessions/2026/05/26/remote-user-fallback.jsonl';
		const responseCwdPath = '~/.codex/sessions/2026/05/26/remote-response-cwd.jsonl';
		const agentOnlyPath = '~/.codex/sessions/2026/05/26/remote-agent-only.jsonl';
		const throwParsePath = '~/.codex/sessions/2026/05/26/throw-parse.jsonl';
		const readFailurePath = `~/.codex/sessions/2026/05/26/rollout-20260526_121500_000-${readFailureId}.jsonl`;
		const badContentPath = `~/.codex/sessions/2026/05/26/rollout-20260526_122000_000-${badContentId}.jsonl`;
		const remoteFiles = new Map<string, string>();
		const remoteDirs = new Map<string, Array<{ name: string; isDirectory: boolean }>>();
		const remoteStats = new Map<string, { size: number; mtime: number }>();
		const putRemoteDir = (
			dirPath: string,
			entries: Array<{ name: string; isDirectory?: boolean }>
		) => {
			remoteDirs.set(
				dirPath,
				entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory ?? false }))
			);
		};
		const legacyContent = [
			{ id: legacyId, timestamp: '2026-05-26T10:00:00.000Z' },
			{
				type: 'message',
				role: 'user',
				timestamp: '2026-05-26T09:59:00.000Z',
				content: [{ type: 'input_text', text: `<cwd>${childProjectPath}</cwd>` }],
			},
			{
				type: 'message',
				role: 'assistant',
				timestamp: '2026-05-26T10:01:00.000Z',
				content: [{ type: 'output_text', text: 'Remote legacy assistant' }],
			},
			{
				type: 'response_item',
				timestamp: '2026-05-26T10:02:00.000Z',
				payload: {
					type: 'message',
					role: 'user',
					id: 'remote-response-user',
					content: [{ type: 'input_text', text: 'Remote response user' }],
				},
			},
			{
				type: 'response_item',
				timestamp: '2026-05-26T10:03:00.000Z',
				payload: {
					type: 'message',
					role: 'assistant',
					id: 'remote-response-assistant',
					content: [{ type: 'output_text', text: 'Remote response assistant' }],
				},
			},
			{
				type: 'item.completed',
				timestamp: '2026-05-26T10:04:00.000Z',
				item: { type: 'agent_message', id: 'remote-agent', text: 'Remote agent text' },
			},
			{
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {
							input_tokens: 13,
							output_tokens: 17,
							reasoning_output_tokens: 19,
							cached_input_tokens: 23,
						},
					},
				},
			},
			{
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {},
					},
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join('\n');
		const modernContent = [
			{
				type: 'session_meta',
				timestamp: '2026-05-26T12:00:00.000Z',
				payload: { id: modernId, cwd: projectPath, timestamp: '2026-05-26T12:00:00.000Z' },
			},
			{
				type: 'message',
				role: 'assistant',
				timestamp: '2026-05-26T12:01:00.000Z',
				content: [{ type: 'output_text', text: 'Remote modern assistant' }],
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join('\n');
		const metadataLookupContent = [
			{ id: metadataLookupId, timestamp: '2026-05-26T11:00:00.000Z' },
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: `<cwd>${projectPath}</cwd>` }],
			},
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'Remote metadata lookup assistant' }],
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join('\n');
		const userFallbackContent = [
			{
				type: 'session_meta',
				payload: { id: userFallbackId, cwd: projectPath },
			},
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Remote user fallback preview' }],
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join('\n');
		const responseCwdContent = [
			{
				type: 'session_meta',
				payload: { id: responseCwdId },
			},
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'user',
					id: 'remote-response-cwd-user',
					content: [{ type: 'input_text', text: `<cwd>${projectPath}</cwd>` }],
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join('\n');
		const agentOnlyContent = [
			{
				type: 'session_meta',
				payload: { id: agentOnlyId, cwd: projectPath },
			},
			{
				type: 'item.completed',
				item: { type: 'agent_message', id: 'agent-only', text: 'Remote agent-only preview' },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join('\n');
		vi.doMock('../../main/utils/remote-fs', () => ({
			readDirRemote: vi.fn(async (dirPath: string) => ({
				success: remoteDirs.has(dirPath),
				data: remoteDirs.get(dirPath),
			})),
			readFileRemote: vi.fn(async (filePath: string) => {
				if (filePath === throwParsePath) {
					throw new Error('remote parser exploded');
				}
				if (filePath === badContentPath) {
					return {
						success: true,
						data: {
							split: () => {
								throw new Error('bad split');
							},
						} as unknown as string,
					};
				}
				const data = remoteFiles.get(filePath);
				return data === undefined ? { success: false, error: 'missing' } : { success: true, data };
			}),
			statRemote: vi.fn(async (filePath: string) => {
				const data = remoteStats.get(filePath);
				return data === undefined ? { success: false, error: 'missing' } : { success: true, data };
			}),
		}));
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		class TestableCodexSessionStorage extends CodexSessionStorage {
			readSearchableMessagesForTest(
				sessionId: string,
				currentProjectPath: string,
				remoteConfig?: SshRemoteConfig
			) {
				return this.getSearchableMessages(sessionId, currentProjectPath, remoteConfig);
			}
		}
		const storage = new TestableCodexSessionStorage();

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);
		putRemoteDir('~/.codex/sessions', []);
		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);

		putRemoteDir('~/.codex/sessions', [
			{ name: 'notes', isDirectory: false },
			{ name: 'draft', isDirectory: true },
			{ name: '2024', isDirectory: true },
			{ name: '2025', isDirectory: true },
			{ name: '2026', isDirectory: true },
		]);
		putRemoteDir('~/.codex/sessions/2025', []);
		putRemoteDir('~/.codex/sessions/2026', [
			{ name: 'bad-month', isDirectory: true },
			{ name: '04', isDirectory: true },
			{ name: '05', isDirectory: true },
		]);
		putRemoteDir('~/.codex/sessions/2026/05', [
			{ name: 'bad-day', isDirectory: true },
			{ name: '25', isDirectory: true },
			{ name: '26', isDirectory: true },
		]);
		putRemoteDir('~/.codex/sessions/2026/05/26', [
			{ name: 'folder.jsonl', isDirectory: true },
			{ name: 'whitespace.jsonl' },
			{ name: 'remote-legacy.jsonl' },
			{ name: `rollout-20260526_120000_000-${modernId}.jsonl` },
			{ name: 'metadata-lookup.jsonl' },
			{ name: 'remote-user-fallback.jsonl' },
			{ name: 'remote-response-cwd.jsonl' },
			{ name: 'remote-agent-only.jsonl' },
			{ name: 'throw-parse.jsonl' },
			{ name: `rollout-20260526_121500_000-${readFailureId}.jsonl` },
			{ name: `rollout-20260526_122000_000-${badContentId}.jsonl` },
		]);
		remoteFiles.set(legacyPath, legacyContent);
		remoteFiles.set(modernPath, modernContent);
		remoteFiles.set(metadataLookupPath, metadataLookupContent);
		remoteFiles.set(whitespacePath, '  \n\n');
		remoteFiles.set(userFallbackPath, userFallbackContent);
		remoteFiles.set(responseCwdPath, responseCwdContent);
		remoteFiles.set(agentOnlyPath, agentOnlyContent);
		remoteStats.set(legacyPath, {
			size: Buffer.byteLength(legacyContent),
			mtime: Date.parse('2026-05-26T10:05:00.000Z'),
		});
		remoteStats.set(modernPath, {
			size: Buffer.byteLength(modernContent),
			mtime: Date.parse('2026-05-26T12:05:00.000Z'),
		});
		remoteStats.set(metadataLookupPath, {
			size: Buffer.byteLength(metadataLookupContent),
			mtime: Date.parse('2026-05-26T11:05:00.000Z'),
		});
		remoteStats.set(whitespacePath, { size: 3, mtime: Date.parse('2026-05-26T09:30:00.000Z') });
		remoteStats.set(userFallbackPath, {
			size: Buffer.byteLength(userFallbackContent),
			mtime: Date.parse('2026-05-26T10:10:00.000Z'),
		});
		remoteStats.set(responseCwdPath, {
			size: Buffer.byteLength(responseCwdContent),
			mtime: Date.parse('2026-05-26T10:15:00.000Z'),
		});
		remoteStats.set(agentOnlyPath, {
			size: Buffer.byteLength(agentOnlyContent),
			mtime: Date.parse('2026-05-26T10:20:00.000Z'),
		});
		remoteStats.set(throwParsePath, { size: 10, mtime: Date.parse('2026-05-26T10:25:00.000Z') });
		remoteStats.set(readFailurePath, { size: 10, mtime: Date.parse('2026-05-26T12:15:00.000Z') });
		remoteStats.set(badContentPath, { size: 10, mtime: Date.parse('2026-05-26T12:20:00.000Z') });

		const sessions = await storage.listSessions(projectPath, sshConfig);
		expect(sessions.map((session) => session.sessionId)).toEqual([
			modernId,
			metadataLookupId,
			agentOnlyId,
			responseCwdId,
			userFallbackId,
			legacyId,
		]);
		expect(sessions.find((session) => session.sessionId === legacyId)).toMatchObject({
			projectPath: childProjectPath,
			firstMessage: 'Remote legacy assistant',
			inputTokens: 13,
			outputTokens: 36,
			cacheReadTokens: 23,
			durationSeconds: 300,
		});
		expect(sessions.find((session) => session.sessionId === userFallbackId)).toMatchObject({
			firstMessage: 'Remote user fallback preview',
		});
		expect(sessions.find((session) => session.sessionId === responseCwdId)).toMatchObject({
			projectPath,
		});
		expect(sessions.find((session) => session.sessionId === agentOnlyId)).toMatchObject({
			firstMessage: 'Remote agent-only preview',
		});
		await expect(
			storage.readSessionMessages(projectPath, metadataLookupId, { limit: 10 }, sshConfig)
		).resolves.toMatchObject({
			total: 2,
			messages: [
				expect.objectContaining({ content: `<cwd>${projectPath}</cwd>` }),
				expect.objectContaining({ content: 'Remote metadata lookup assistant' }),
			],
		});
		await expect(
			storage.readSessionMessages(projectPath, readFailureId, undefined, sshConfig)
		).resolves.toEqual({ messages: [], total: 0, hasMore: false });
		await expect(
			storage.readSessionMessages(projectPath, badContentId, undefined, sshConfig)
		).resolves.toEqual({ messages: [], total: 0, hasMore: false });
		await expect(
			storage.readSearchableMessagesForTest('missing-remote-session', projectPath, sshConfig)
		).resolves.toEqual([]);
		await expect(
			storage.readSearchableMessagesForTest(readFailureId, projectPath, sshConfig)
		).resolves.toEqual([]);
		remoteDirs.clear();
		await expect(
			storage.readSearchableMessagesForTest(readFailureId, projectPath, sshConfig)
		).resolves.toEqual([]);
	});

	it('indexes, reads, searches, paginates, names, and deletes Claude JSONL sessions', async () => {
		const projectPath = path.join(tempRoot, 'claude-project');
		await mkdir(projectPath, { recursive: true });
		const alphaSessionId = 'claude-alpha';
		const betaSessionId = 'claude-beta';
		const { sessionDir, sessionFile } = await writeClaudeSession(
			projectPath,
			alphaSessionId,
			[
				claudeUser(
					'user-alpha',
					[
						{ type: 'text', text: 'Please test Claude storage' },
						{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ignored' } },
					],
					'2026-05-25T14:00:00.000Z'
				),
				claudeAssistant(
					'assistant-alpha',
					[
						{ type: 'text', text: 'Claude storage covered' },
						{ type: 'tool_use', id: 'toolu_alpha', name: 'Read', input: { file_path: 'a.ts' } },
					],
					'2026-05-25T14:01:00.000Z'
				),
				claudeUser(
					'tool-result-alpha',
					[{ type: 'tool_result', tool_use_id: 'toolu_alpha', content: 'tool output' }],
					'2026-05-25T14:02:00.000Z'
				),
				'not valid json',
				claudeUser('user-keep', 'Keep this request', '2026-05-25T14:04:00.000Z'),
			],
			'2026-05-25T14:05:00.000Z'
		);
		await writeClaudeSession(
			projectPath,
			betaSessionId,
			[
				claudeUser('user-beta', 'Beta request', '2026-05-25T13:00:00.000Z'),
				claudeAssistant('assistant-beta', 'Beta assistant response', '2026-05-25T13:01:00.000Z'),
			],
			'2026-05-25T13:05:00.000Z'
		);
		await writeFile(path.join(sessionDir, 'empty.jsonl'), '', 'utf-8');
		await writeFile(path.join(sessionDir, 'notes.txt'), 'ignored', 'utf-8');

		const { ClaudeSessionStorage } = await import('../../main/storage/claude-session-storage');
		const storage = new ClaudeSessionStorage(createClaudeOriginsStore());
		storage.registerSessionOrigin(projectPath, alphaSessionId, 'auto', 'Auto alpha');
		storage.updateSessionStarred(projectPath, alphaSessionId, true);
		storage.updateSessionContextUsage(projectPath, alphaSessionId, 72);
		storage.updateSessionName(projectPath, betaSessionId, 'Manual beta');

		const sessions = await storage.listSessions(projectPath);
		expect(sessions.map((session) => session.sessionId)).toEqual([alphaSessionId, betaSessionId]);
		expect(sessions[0]).toMatchObject({
			sessionId: alphaSessionId,
			projectPath,
			firstMessage: 'Claude storage covered',
			messageCount: 4,
			inputTokens: 11,
			outputTokens: 13,
			cacheReadTokens: 17,
			cacheCreationTokens: 19,
			origin: 'auto',
			sessionName: 'Auto alpha',
			starred: true,
		});
		expect(sessions[0].durationSeconds).toBe(240);
		expect(sessions[0].costUsd).toBeGreaterThan(0);

		const firstPage = await storage.listSessionsPaginated(projectPath, { limit: 1 });
		expect(firstPage).toMatchObject({
			totalCount: 2,
			hasMore: true,
			nextCursor: alphaSessionId,
		});
		expect(firstPage.sessions[0].sessionId).toBe(alphaSessionId);
		const secondPage = await storage.listSessionsPaginated(projectPath, {
			limit: 1,
			cursor: alphaSessionId,
		});
		expect(secondPage).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null });
		expect(secondPage.sessions[0].sessionId).toBe(betaSessionId);

		const messages = await storage.readSessionMessages(projectPath, alphaSessionId, { limit: 10 });
		expect(messages.total).toBe(3);
		expect(messages.messages).toEqual([
			expect.objectContaining({
				type: 'user',
				role: 'user',
				content: 'Please test Claude storage',
				uuid: 'user-alpha',
			}),
			expect.objectContaining({
				type: 'assistant',
				role: 'assistant',
				content: 'Claude storage covered',
				uuid: 'assistant-alpha',
				toolUse: [expect.objectContaining({ id: 'toolu_alpha', name: 'Read' })],
			}),
			expect.objectContaining({
				type: 'user',
				role: 'user',
				content: 'Keep this request',
				uuid: 'user-keep',
			}),
		]);
		const latestMessage = await storage.readSessionMessages(projectPath, alphaSessionId, {
			limit: 1,
		});
		expect(latestMessage).toMatchObject({ total: 3, hasMore: true });
		expect(latestMessage.messages[0].content).toBe('Keep this request');

		const search = await storage.searchSessions(projectPath, 'storage covered', 'assistant');
		expect(search).toEqual([
			expect.objectContaining({
				sessionId: alphaSessionId,
				matchType: 'assistant',
				matchCount: 1,
			}),
		]);
		expect(storage.getSessionPath(projectPath, alphaSessionId)).toBe(sessionFile);
		expect(storage.getSessionOrigins(projectPath)[alphaSessionId]).toEqual({
			origin: 'auto',
			sessionName: 'Auto alpha',
			starred: true,
			contextUsage: 72,
		});
		await expect(storage.getAllNamedSessions()).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agentSessionId: alphaSessionId,
					projectPath,
					sessionName: 'Auto alpha',
					starred: true,
				}),
				expect.objectContaining({
					agentSessionId: betaSessionId,
					projectPath,
					sessionName: 'Manual beta',
				}),
			])
		);

		const sshConfig: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Remote 1',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		await expect(
			storage.deleteMessagePair(projectPath, alphaSessionId, 'user-alpha', undefined, sshConfig)
		).resolves.toEqual({
			success: false,
			error: 'Delete not supported for remote sessions',
		});

		const deleteResult = await storage.deleteMessagePair(projectPath, alphaSessionId, 'user-alpha');
		expect(deleteResult).toMatchObject({ success: true, linesRemoved: 2 });
		const updatedContent = await readFile(sessionFile, 'utf-8');
		expect(updatedContent).toContain('Keep this request');
		expect(updatedContent).not.toContain('Claude storage covered');
		expect(updatedContent).not.toContain('toolu_alpha');
		const remainingMessages = await storage.readSessionMessages(projectPath, alphaSessionId, {
			limit: 10,
		});
		expect(remainingMessages.messages).toEqual([
			expect.objectContaining({
				uuid: 'user-keep',
				content: 'Keep this request',
			}),
		]);
	});

	it('indexes, reads, searches, resolves paths, and deletes OpenCode JSON sessions', async () => {
		const projectPath = path.join(tempRoot, 'opencode-project');
		await mkdir(projectPath, { recursive: true });
		const { storageRoot, sessionId } = await writeOpenCodeSession(projectPath);
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			projectPath,
			firstMessage: 'OpenCode storage integration complete',
			messageCount: 3,
			costUsd: 0.03,
			inputTokens: 4,
			outputTokens: 9,
			cacheReadTokens: 1,
			cacheCreationTokens: 2,
			durationSeconds: 8,
		});

		expect(storage.getSessionPath(projectPath, sessionId)).toBe(
			path.join(storageRoot, 'message', sessionId)
		);

		const messages = await storage.readSessionMessages(projectPath, sessionId, { limit: 10 });
		expect(messages.messages).toEqual([
			expect.objectContaining({
				uuid: 'msg-user',
				role: 'user',
				content: 'Run OpenCode integration storage test',
			}),
			expect.objectContaining({
				uuid: 'msg-assistant',
				role: 'assistant',
				content: 'OpenCode storage integration complete',
				toolUse: [expect.objectContaining({ id: 'tool-part', tool: 'bash' })],
			}),
			expect.objectContaining({
				uuid: 'msg-next',
				role: 'user',
				content: 'Follow-up request',
			}),
		]);

		const search = await storage.searchSessions(projectPath, 'integration complete', 'assistant');
		expect(search).toEqual([
			expect.objectContaining({
				sessionId,
				matchType: 'assistant',
				matchCount: 1,
			}),
		]);

		const deleteResult = await storage.deleteMessagePair(projectPath, sessionId, 'msg-user');
		expect(deleteResult.success).toBe(true);
		expect(deleteResult.linesRemoved).toBeGreaterThanOrEqual(5);
		await expect(
			stat(path.join(storageRoot, 'message', sessionId, 'msg-user.json'))
		).rejects.toThrow();
		await expect(
			stat(path.join(storageRoot, 'part', 'msg-assistant', 'part-assistant.json'))
		).rejects.toThrow();

		const remaining = await storage.readSessionMessages(projectPath, sessionId, { limit: 10 });
		expect(remaining.messages).toEqual([
			expect.objectContaining({
				uuid: 'msg-next',
				content: 'Follow-up request',
			}),
		]);
	});

	it('uses OpenCode global JSON sessions when no dedicated project exists', async () => {
		const projectPath = path.join(tempRoot, 'opencode-global-project');
		await mkdir(projectPath, { recursive: true });
		const storageRoot = path.join(homeDir, '.local', 'share', 'opencode', 'storage');
		const sessionId = 'ses_global_match';
		await writeJson(path.join(storageRoot, 'project', 'global.json'), {
			id: 'global',
			worktree: '/',
		});
		await writeJson(path.join(storageRoot, 'session', 'global', `${sessionId}.json`), {
			id: sessionId,
			projectID: 'global',
			directory: path.join(projectPath, 'nested'),
			title: 'Global fallback title',
			time: {
				created: Date.parse('2026-05-25T15:00:00.000Z'),
				updated: Date.parse('2026-05-25T15:00:03.000Z'),
			},
		});
		await writeJson(path.join(storageRoot, 'session', 'global', 'ses_other.json'), {
			id: 'ses_other',
			projectID: 'global',
			directory: path.join(tempRoot, 'elsewhere'),
			title: 'Filtered out',
			time: {
				created: Date.parse('2026-05-25T14:00:00.000Z'),
				updated: Date.parse('2026-05-25T14:00:03.000Z'),
			},
		});
		await writeJson(path.join(storageRoot, 'message', sessionId, 'msg-user.json'), {
			id: 'msg-user',
			sessionID: sessionId,
			role: 'user',
			time: { created: Date.parse('2026-05-25T15:00:01.000Z') },
		});
		await writeJson(path.join(storageRoot, 'part', 'msg-user', 'part-user.json'), {
			id: 'part-user',
			messageID: 'msg-user',
			type: 'text',
			text: 'Global project request',
		});

		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				projectPath,
				firstMessage: 'Global project request',
				messageCount: 1,
			}),
		]);
		expect(storage.getSessionPath(projectPath, sessionId)).toBe(
			path.join(storageRoot, 'message', sessionId)
		);
	});

	it('matches OpenCode JSON projects by parent path and removes orphaned tool references on delete', async () => {
		const projectRoot = path.join(tempRoot, 'opencode-parent-project');
		const nestedProjectPath = path.join(projectRoot, 'packages', 'api');
		await mkdir(nestedProjectPath, { recursive: true });
		const storageRoot = path.join(homeDir, '.local', 'share', 'opencode', 'storage');
		const projectId = 'project-parent';
		const sessionId = 'ses_parent';
		await writeJson(path.join(storageRoot, 'project', `${projectId}.json`), {
			id: projectId,
			worktree: projectRoot,
		});
		await writeFile(path.join(storageRoot, 'project', 'broken.json'), '{bad json', 'utf-8');
		await writeJson(path.join(storageRoot, 'session', projectId, `${sessionId}.json`), {
			id: sessionId,
			projectID: projectId,
			directory: nestedProjectPath,
			title: 'Parent path title',
			time: {
				created: Date.parse('2026-05-25T17:00:00.000Z'),
				updated: Date.parse('2026-05-25T17:00:10.000Z'),
			},
		});
		await writeFile(
			path.join(storageRoot, 'session', projectId, 'malformed.json'),
			'{bad json',
			'utf-8'
		);
		const messages = [
			{ id: 'delete-user', role: 'user', created: '2026-05-25T17:00:01.000Z' },
			{ id: 'delete-assistant', role: 'assistant', created: '2026-05-25T17:00:02.000Z' },
			{ id: 'keep-user', role: 'user', created: '2026-05-25T17:00:03.000Z' },
		] as const;
		for (const message of messages) {
			await writeJson(path.join(storageRoot, 'message', sessionId, `${message.id}.json`), {
				id: message.id,
				sessionID: sessionId,
				role: message.role,
				time: { created: Date.parse(message.created) },
			});
		}
		await writeFile(
			path.join(storageRoot, 'message', sessionId, 'bad-message.json'),
			'{bad json',
			'utf-8'
		);
		await writeJson(path.join(storageRoot, 'part', 'delete-user', 'delete-text.json'), {
			id: 'delete-text',
			messageID: 'delete-user',
			type: 'text',
			text: 'Delete this request',
		});
		await writeJson(path.join(storageRoot, 'part', 'delete-assistant', 'assistant-text.json'), {
			id: 'assistant-text',
			messageID: 'delete-assistant',
			type: 'text',
			text: 'Tool cleanup answer',
		});
		await writeJson(path.join(storageRoot, 'part', 'delete-assistant', 'tool-delete.json'), {
			id: 'tool-delete',
			messageID: 'delete-assistant',
			type: 'tool',
			tool: 'bash',
			state: { status: 'completed', output: 'artifact id tool-delete' },
		});
		await writeJson(path.join(storageRoot, 'part', 'keep-user', 'keep-text.json'), {
			id: 'keep-text',
			messageID: 'keep-user',
			type: 'text',
			text: 'Keep this request',
		});
		await writeJson(path.join(storageRoot, 'part', 'keep-user', 'orphan-ref.json'), {
			id: 'orphan-ref',
			messageID: 'keep-user',
			type: 'tool',
			tool: 'bash',
			state: { status: 'completed', output: 'references tool-delete' },
		});

		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		const sessions = await storage.listSessions(nestedProjectPath);
		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				projectPath: nestedProjectPath,
				firstMessage: 'Tool cleanup answer',
				messageCount: 3,
				durationSeconds: 2,
			}),
		]);

		const result = await storage.deleteMessagePair(nestedProjectPath, sessionId, 'delete-user');
		expect(result).toEqual({ success: true, linesRemoved: 6 });
		await expect(
			stat(path.join(storageRoot, 'part', 'keep-user', 'orphan-ref.json'))
		).rejects.toThrow();
		await expect(
			stat(path.join(storageRoot, 'part', 'keep-user', 'keep-text.json'))
		).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }));
		const remaining = await storage.readSessionMessages(nestedProjectPath, sessionId, {
			limit: 10,
		});
		expect(remaining.messages).toEqual([
			expect.objectContaining({
				uuid: 'keep-user',
				content: 'Keep this request',
			}),
		]);
	});

	it('reads OpenCode JSON sessions from the Windows APPDATA storage path', async () => {
		const appData = path.join(tempRoot, 'AppData', 'Roaming');
		process.env.APPDATA = appData;
		vi.doMock('../../shared/platformDetection', () => ({
			isWindows: () => true,
		}));
		const projectPath = path.join(tempRoot, 'opencode-windows-project');
		await mkdir(projectPath, { recursive: true });
		const storageRoot = path.join(appData, 'opencode', 'storage');
		const projectId = 'windows-project';
		const sessionId = 'ses_windows';
		await writeJson(path.join(storageRoot, 'project', `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		await writeJson(path.join(storageRoot, 'session', projectId, `${sessionId}.json`), {
			id: sessionId,
			projectID: projectId,
			directory: projectPath,
			title: 'Windows OpenCode session',
			time: {
				created: Date.parse('2026-05-25T18:00:00.000Z'),
				updated: Date.parse('2026-05-25T18:00:01.000Z'),
			},
		});

		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toEqual([
			expect.objectContaining({
				sessionId,
				firstMessage: 'Windows OpenCode session',
			}),
		]);
		expect(storage.getSessionPath(projectPath, sessionId)).toBe(
			path.join(storageRoot, 'message', sessionId)
		);
	});

	it('merges OpenCode SQLite sessions with JSON-only history and rejects SQLite deletion', async () => {
		const projectPath = path.join(tempRoot, 'opencode-sqlite-project');
		await mkdir(projectPath, { recursive: true });
		const { sessionId: jsonOnlySessionId } = await writeOpenCodeSession(projectPath);
		const opencodeDir = path.join(homeDir, '.local', 'share', 'opencode');
		const dbPath = path.join(opencodeDir, 'opencode.db');
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(dbPath, '', 'utf-8');
		const sqliteProjects = [
			{ id: 'sqlite-project', worktree: projectPath },
			{ id: 'global', worktree: '/' },
		];
		const sqliteSessions = [
			{
				id: 'ses_sqlite',
				project_id: 'sqlite-project',
				directory: projectPath,
				title: 'SQLite title fallback',
				version: '1.2.0',
				time_created: Date.parse('2026-05-26T12:00:00.000Z'),
				time_updated: Date.parse('2026-05-26T12:05:00.000Z'),
				summary_additions: null,
				summary_deletions: null,
				summary_files: null,
			},
			{
				id: 'ses_global_sqlite',
				project_id: 'global',
				directory: path.join(projectPath, 'nested'),
				title: 'Global SQLite title',
				version: '1.2.0',
				time_created: Date.parse('2026-05-26T11:00:00.000Z'),
				time_updated: Date.parse('2026-05-26T11:05:00.000Z'),
				summary_additions: null,
				summary_deletions: null,
				summary_files: null,
			},
			{
				id: 'ses_global_other',
				project_id: 'global',
				directory: path.join(tempRoot, 'other-project'),
				title: 'Other SQLite title',
				version: '1.2.0',
				time_created: Date.parse('2026-05-26T10:00:00.000Z'),
				time_updated: Date.parse('2026-05-26T10:05:00.000Z'),
				summary_additions: null,
				summary_deletions: null,
				summary_files: null,
			},
		];
		const sqliteMessages = [
			{
				id: 'sqlite-user',
				session_id: 'ses_sqlite',
				time_created: Date.parse('2026-05-26T12:00:10.000Z'),
				time_updated: Date.parse('2026-05-26T12:00:10.000Z'),
				data: JSON.stringify({
					role: 'user',
					tokens: { input: 6, cache: { read: 3 } },
					cost: 0.01,
				}),
			},
			{
				id: 'sqlite-assistant',
				session_id: 'ses_sqlite',
				time_created: Date.parse('2026-05-26T12:02:10.000Z'),
				time_updated: Date.parse('2026-05-26T12:02:10.000Z'),
				data: JSON.stringify({
					role: 'assistant',
					tokens: { output: 12, cache: { write: 1 } },
					cost: 0.02,
				}),
			},
			{
				id: 'global-assistant',
				session_id: 'ses_global_sqlite',
				time_created: Date.parse('2026-05-26T11:00:10.000Z'),
				time_updated: Date.parse('2026-05-26T11:00:10.000Z'),
				data: JSON.stringify({ role: 'assistant' }),
			},
		];
		const sqliteParts = [
			{
				id: 'sqlite-user-text',
				message_id: 'sqlite-user',
				time_created: Date.parse('2026-05-26T12:00:11.000Z'),
				data: JSON.stringify({ type: 'text', text: 'SQLite user prompt' }),
			},
			{
				id: 'sqlite-assistant-text',
				message_id: 'sqlite-assistant',
				time_created: Date.parse('2026-05-26T12:02:11.000Z'),
				data: JSON.stringify({ type: 'text', text: 'SQLite assistant answer' }),
			},
			{
				id: 'sqlite-tool',
				message_id: 'sqlite-assistant',
				time_created: Date.parse('2026-05-26T12:02:12.000Z'),
				data: JSON.stringify({
					type: 'tool',
					tool: 'bash',
					state: { status: 'completed', output: 'ok' },
				}),
			},
			{
				id: 'global-assistant-text',
				message_id: 'global-assistant',
				time_created: Date.parse('2026-05-26T11:00:11.000Z'),
				data: JSON.stringify({ type: 'text', text: 'Global SQLite answer' }),
			},
		];
		vi.doMock('better-sqlite3', () => ({
			default: vi.fn(function MockDatabase() {
				return {
					prepare: (sql: string) => {
						if (sql.includes('sqlite_master')) {
							return {
								get: (tableName: string) =>
									['session', 'project', 'message', 'part'].includes(tableName)
										? { name: tableName }
										: undefined,
							};
						}
						if (sql === 'SELECT id, worktree FROM project') {
							return { all: () => sqliteProjects };
						}
						if (sql.includes('FROM session WHERE project_id IN')) {
							return {
								all: (...projectIds: string[]) =>
									sqliteSessions.filter((session) => projectIds.includes(session.project_id)),
							};
						}
						if (sql.includes("FROM session WHERE project_id = 'global'")) {
							return {
								all: () =>
									sqliteSessions.filter(
										(session) =>
											session.project_id === 'global' &&
											session.directory.startsWith(`${projectPath}${path.sep}`)
									),
							};
						}
						if (sql.includes('FROM message WHERE session_id IN')) {
							return {
								all: (...sessionIds: string[]) =>
									sqliteMessages
										.filter((message) => sessionIds.includes(message.session_id))
										.sort((a, b) => a.time_created - b.time_created),
							};
						}
						if (sql.includes('FROM part WHERE message_id IN')) {
							return {
								all: (...messageIds: string[]) =>
									sqliteParts
										.filter((part) => messageIds.includes(part.message_id))
										.sort((a, b) => a.time_created - b.time_created),
							};
						}
						if (sql.includes('FROM message WHERE session_id = ?')) {
							return {
								all: (sessionId: string) =>
									sqliteMessages
										.filter((message) => message.session_id === sessionId)
										.sort((a, b) => a.time_created - b.time_created),
							};
						}
						if (sql.includes('FROM part WHERE message_id = ?')) {
							return {
								all: (messageId: string) =>
									sqliteParts
										.filter((part) => part.message_id === messageId)
										.sort((a, b) => a.time_created - b.time_created),
							};
						}
						if (sql === 'SELECT 1 FROM session WHERE id = ? LIMIT 1') {
							return {
								get: (sessionId: string) =>
									sqliteSessions.some((session) => session.id === sessionId)
										? { exists: 1 }
										: undefined,
							};
						}
						throw new Error(`Unexpected SQLite query: ${sql}`);
					},
					close: vi.fn(),
				};
			}),
		}));
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		expect(sessions.map((session) => session.sessionId)).toEqual([
			'ses_sqlite',
			'ses_global_sqlite',
			jsonOnlySessionId,
		]);
		expect(sessions[0]).toMatchObject({
			sessionId: 'ses_sqlite',
			projectPath,
			firstMessage: 'SQLite assistant answer',
			messageCount: 2,
			costUsd: 0.03,
			inputTokens: 6,
			outputTokens: 12,
			cacheReadTokens: 3,
			cacheCreationTokens: 1,
			durationSeconds: 120,
		});
		expect(sessions[1].firstMessage).toBe('Global SQLite answer');

		await expect(storage.readSessionMessages(projectPath, 'ses_sqlite')).resolves.toMatchObject({
			total: 2,
			messages: [
				expect.objectContaining({
					uuid: 'sqlite-user',
					content: 'SQLite user prompt',
				}),
				expect.objectContaining({
					uuid: 'sqlite-assistant',
					content: 'SQLite assistant answer',
					toolUse: [expect.objectContaining({ id: 'sqlite-tool', tool: 'bash' })],
				}),
			],
		});
		await expect(
			storage.searchSessions(projectPath, 'sqlite assistant', 'assistant')
		).resolves.toEqual([
			expect.objectContaining({
				sessionId: 'ses_sqlite',
				matchType: 'assistant',
				matchCount: 1,
			}),
		]);
		expect(storage.getSessionPath(projectPath, 'ses_sqlite')).toBe(dbPath);
		await expect(
			storage.deleteMessagePair(projectPath, 'ses_sqlite', 'sqlite-user')
		).resolves.toEqual({
			success: false,
			error: 'Delete not supported for OpenCode v1.2+ SQLite sessions',
		});
	});

	it('indexes, reads, searches, and rejects deletion for OpenCode remote JSON sessions', async () => {
		const sshConfig: SshRemoteConfig = {
			id: 'remote-opencode',
			name: 'Remote OpenCode',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		const projectPath = '/srv/app';
		const sessionId = 'ses_remote';
		const remoteFiles = new Map<string, string>();
		const remoteDirs = new Map<string, Array<{ name: string; isDirectory: boolean }>>();
		const remoteStats = new Map<string, { size: number }>();
		const putRemoteJson = (filePath: string, value: unknown) => {
			remoteFiles.set(filePath, JSON.stringify(value));
		};
		const putRemoteDir = (
			dirPath: string,
			entries: Array<{ name: string; isDirectory?: boolean }>
		) => {
			remoteDirs.set(
				dirPath,
				entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory ?? false }))
			);
		};

		putRemoteDir('~/.local/share/opencode/storage/project', [
			{ name: 'remote-project.json' },
			{ name: 'global.json' },
		]);
		putRemoteJson('~/.local/share/opencode/storage/project/remote-project.json', {
			id: 'remote-project',
			worktree: projectPath,
		});
		putRemoteJson('~/.local/share/opencode/storage/project/global.json', {
			id: 'global',
			worktree: '/',
		});
		putRemoteDir('~/.local/share/opencode/storage/session/remote-project', [
			{ name: `${sessionId}.json` },
		]);
		putRemoteJson(`~/.local/share/opencode/storage/session/remote-project/${sessionId}.json`, {
			id: sessionId,
			projectID: 'remote-project',
			directory: projectPath,
			title: 'Remote fallback title',
			time: {
				created: Date.parse('2026-05-25T16:00:00.000Z'),
				updated: Date.parse('2026-05-25T16:00:08.000Z'),
			},
		});
		remoteStats.set(`~/.local/share/opencode/storage/session/remote-project/${sessionId}.json`, {
			size: 321,
		});
		putRemoteDir(`~/.local/share/opencode/storage/message/${sessionId}`, [
			{ name: 'msg-user.json' },
			{ name: 'msg-assistant.json' },
		]);
		putRemoteJson(`~/.local/share/opencode/storage/message/${sessionId}/msg-user.json`, {
			id: 'msg-user',
			sessionID: sessionId,
			role: 'user',
			time: { created: Date.parse('2026-05-25T16:00:01.000Z') },
			tokens: { input: 5, cache: { read: 1, write: 2 } },
			cost: 0.01,
		});
		putRemoteJson(`~/.local/share/opencode/storage/message/${sessionId}/msg-assistant.json`, {
			id: 'msg-assistant',
			sessionID: sessionId,
			role: 'assistant',
			time: { created: Date.parse('2026-05-25T16:00:06.000Z') },
			tokens: { output: 11 },
			cost: 0.02,
		});
		putRemoteDir('~/.local/share/opencode/storage/part/msg-user', [{ name: 'part-user.json' }]);
		putRemoteJson('~/.local/share/opencode/storage/part/msg-user/part-user.json', {
			id: 'part-user',
			messageID: 'msg-user',
			type: 'text',
			text: 'Remote OpenCode request',
		});
		putRemoteDir('~/.local/share/opencode/storage/part/msg-assistant', [
			{ name: 'part-assistant.json' },
			{ name: 'part-tool.json' },
		]);
		putRemoteJson('~/.local/share/opencode/storage/part/msg-assistant/part-assistant.json', {
			id: 'part-assistant',
			messageID: 'msg-assistant',
			type: 'text',
			text: 'Remote OpenCode response',
		});
		putRemoteJson('~/.local/share/opencode/storage/part/msg-assistant/part-tool.json', {
			id: 'part-tool',
			messageID: 'msg-assistant',
			type: 'tool',
			tool: 'bash',
			state: { status: 'completed', output: 'ok' },
		});

		vi.doMock('../../main/utils/remote-fs', () => ({
			readDirRemote: vi.fn(async (dirPath: string) => ({
				success: true,
				data: remoteDirs.get(dirPath) ?? [],
			})),
			readFileRemote: vi.fn(async (filePath: string) => {
				const data = remoteFiles.get(filePath);
				return data === undefined ? { success: false, error: 'missing' } : { success: true, data };
			}),
			statRemote: vi.fn(async (filePath: string) => {
				const data = remoteStats.get(filePath);
				return data === undefined ? { success: false, error: 'missing' } : { success: true, data };
			}),
			writeFileRemote: vi.fn(),
			mkdirRemote: vi.fn(),
		}));
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		const sessions = await storage.listSessions(projectPath, sshConfig);
		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				projectPath,
				firstMessage: 'Remote OpenCode response',
				messageCount: 2,
				sizeBytes: 321,
				costUsd: 0.03,
				inputTokens: 5,
				outputTokens: 11,
				cacheReadTokens: 1,
				cacheCreationTokens: 2,
				durationSeconds: 5,
			}),
		]);

		const messages = await storage.readSessionMessages(projectPath, sessionId, {}, sshConfig);
		expect(messages.messages).toEqual([
			expect.objectContaining({
				uuid: 'msg-user',
				content: 'Remote OpenCode request',
			}),
			expect.objectContaining({
				uuid: 'msg-assistant',
				content: 'Remote OpenCode response',
				toolUse: [expect.objectContaining({ id: 'part-tool', tool: 'bash' })],
			}),
		]);
		await expect(
			storage.searchSessions(projectPath, 'remote opencode response', 'assistant', sshConfig)
		).resolves.toEqual([
			expect.objectContaining({
				sessionId,
				matchType: 'assistant',
				matchCount: 1,
			}),
		]);
		expect(storage.getSessionPath(projectPath, sessionId, sshConfig)).toBe(
			`~/.local/share/opencode/storage/message/${sessionId}`
		);
		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'msg-user', undefined, sshConfig)
		).resolves.toEqual({
			success: false,
			error: 'Delete not supported for remote sessions',
		});
	});
});
