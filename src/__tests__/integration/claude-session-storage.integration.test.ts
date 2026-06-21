import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionStorage } from '../../main/storage/claude-session-storage';
import { encodeClaudeProjectPath } from '../../main/utils/statsCache';
import type { SshRemoteConfig } from '../../shared/types';

const testState = vi.hoisted(() => ({
	homeDir: '',
	listDirWithStatsRemote: vi.fn(),
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	statRemote: vi.fn(),
}));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const mockedHomedir = vi.fn(() => testState.homeDir);
	return {
		...actual,
		default: {
			...actual,
			homedir: mockedHomedir,
		},
		homedir: mockedHomedir,
	};
});

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../main/utils/remote-fs', () => ({
	listDirWithStatsRemote: testState.listDirWithStatsRemote,
	readDirRemote: testState.readDirRemote,
	readFileRemote: testState.readFileRemote,
	statRemote: testState.statRemote,
}));

interface OriginsData {
	origins: Record<string, Record<string, unknown>>;
}

function createOriginsStore(initialOrigins: OriginsData['origins'] = {}) {
	const data: OriginsData = { origins: initialOrigins };
	return {
		get: vi.fn((key: keyof OriginsData, fallback: unknown) => data[key] ?? fallback),
		set: vi.fn((key: keyof OriginsData, value: OriginsData[typeof key]) => {
			data[key] = value;
		}),
		data,
	};
}

function sessionJsonl(lines: Array<Record<string, unknown> | string>) {
	return `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
}

function userMessage(uuid: string, content: unknown, timestamp = '2026-05-25T10:00:00.000Z') {
	return {
		type: 'user',
		uuid,
		timestamp,
		message: {
			role: 'user',
			content,
		},
	};
}

function assistantMessage(uuid: string, content: unknown, timestamp = '2026-05-25T10:00:05.000Z') {
	return {
		type: 'assistant',
		uuid,
		timestamp,
		message: {
			role: 'assistant',
			content,
			usage: {
				input_tokens: 25,
				output_tokens: 10,
				cache_read_input_tokens: 5,
				cache_creation_input_tokens: 2,
			},
		},
	};
}

describe('ClaudeSessionStorage direct integration', () => {
	let tempRoot: string;
	let projectPath: string;
	let projectDir: string;
	let originsStore: ReturnType<typeof createOriginsStore>;
	let storage: ClaudeSessionStorage;

	const sshConfig: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Remote',
		host: 'remote.example.test',
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
	};

	async function writeSession(sessionId: string, lines: Array<Record<string, unknown> | string>) {
		const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
		await fs.writeFile(sessionPath, sessionJsonl(lines), 'utf-8');
		return sessionPath;
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'maestro-claude-store-'));
		testState.homeDir = path.join(tempRoot, 'home');
		projectPath = path.join(tempRoot, 'workspace', 'project');
		projectDir = path.join(
			testState.homeDir,
			'.claude',
			'projects',
			encodeClaudeProjectPath(projectPath)
		);
		await fs.mkdir(projectDir, { recursive: true });
		originsStore = createOriginsStore();
		storage = new ClaudeSessionStorage(originsStore as any);
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('lists and paginates local sessions while skipping malformed filesystem entries', async () => {
		const validPath = await writeSession('valid', [
			userMessage('u-valid', 42),
			assistantMessage('a-valid', [{ type: 'text', text: 'Valid assistant summary' }]),
			'not-json',
		]);
		const validOldPath = await writeSession('valid-old', [
			userMessage('u-valid-old', 'Older local session'),
			assistantMessage('a-valid-old', [{ type: 'text', text: 'Older assistant response' }]),
		]);
		await fs.mkdir(path.join(projectDir, 'directory.jsonl'));
		const oversized = path.join(projectDir, 'oversized.jsonl');
		await fs.writeFile(oversized, '{}\n', 'utf-8');
		await fs.truncate(oversized, 100 * 1024 * 1024 + 1);
		await fs.utimes(
			validPath,
			new Date('2026-05-25T10:00:00.000Z'),
			new Date('2026-05-25T10:00:00.000Z')
		);
		await fs.utimes(
			validOldPath,
			new Date('2026-05-25T09:00:00.000Z'),
			new Date('2026-05-25T09:00:00.000Z')
		);

		storage.registerSessionOrigin(projectPath, 'valid', 'auto', 'Named valid session');
		storage.updateSessionStarred(projectPath, 'valid', true);
		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'valid',
				firstMessage: 'Valid assistant summary',
				origin: 'auto',
				sessionName: 'Named valid session',
				starred: true,
			}),
			expect.objectContaining({
				sessionId: 'valid-old',
				firstMessage: 'Older assistant response',
			}),
		]);
		const searchResults = await storage.searchSessions(projectPath, 'assistant summary', 'all');
		expect(searchResults).toEqual([
			expect.objectContaining({
				sessionId: 'valid',
				matchPreview: expect.stringContaining('Valid assistant summary'),
			}),
		]);

		const page = await storage.listSessionsPaginated(projectPath, {
			cursor: 'missing-cursor',
			limit: 1,
		});
		expect(page).toMatchObject({
			totalCount: 4,
			hasMore: true,
			nextCursor: expect.any(String),
		});
		expect(page.sessions).toEqual([]);

		await expect(storage.listSessions(path.join(tempRoot, 'missing-project'))).resolves.toEqual([]);
	});

	it('handles local parse, stat, pagination, and searchable-message read failures', async () => {
		await writeSession('valid', [
			userMessage('u-valid', 'Needle in listed metadata'),
			assistantMessage('a-valid', [{ type: 'text', text: 'Valid assistant summary' }]),
		]);
		await writeSession('parse-throws', [userMessage('u-throws', [null])]);
		await writeSession('range', [userMessage('u-range', 'Range failure')]);
		await fs.symlink(path.join(tempRoot, 'missing-target'), path.join(projectDir, 'broken.jsonl'));

		const originalReadFile = fs.readFile.bind(fs);
		let validReads = 0;
		const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (filePath, options) => {
			const filePathString = String(filePath);
			if (filePathString.endsWith('parse-throws.jsonl')) {
				return null as unknown as Awaited<ReturnType<typeof fs.readFile>>;
			}
			if (filePathString.endsWith('range.jsonl')) {
				throw new RangeError('too large to allocate');
			}
			if (filePathString.endsWith('valid.jsonl')) {
				validReads += 1;
				if (validReads > 3) {
					throw new Error('search read failed');
				}
			}
			return originalReadFile(filePath, options);
		}) as typeof fs.readFile);

		try {
			const sessions = await storage.listSessions(projectPath);
			expect(sessions.map((session) => session.sessionId)).toEqual(['valid']);

			const page = await storage.listSessionsPaginated(projectPath, { limit: 10 });
			expect(page.sessions.map((session) => session.sessionId)).toEqual(['valid']);
			expect(page.totalCount).toBe(3);

			await expect(
				storage.listSessionsPaginated(path.join(tempRoot, 'missing-project'))
			).resolves.toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});

			await expect(storage.searchSessions(projectPath, 'needle', 'all')).resolves.toEqual([]);
		} finally {
			readFileSpy.mockRestore();
		}
	});

	it('covers remote session listing, pagination, read, and search boundaries', async () => {
		const remoteDir = `~/.claude/projects/${encodeClaudeProjectPath(projectPath)}`;
		const remoteContent = sessionJsonl([
			userMessage('u-remote', [{ type: 'text', text: 'Remote user asks for coverage' }]),
			assistantMessage('a-remote', [{ type: 'text', text: 'Remote assistant answers needle' }]),
		]);

		testState.listDirWithStatsRemote.mockResolvedValue({
			success: true,
			data: [
				{ name: 'remote-ok.jsonl', size: 120, mtime: 3000 },
				{ name: 'remote-second.jsonl', size: 120, mtime: 2500 },
				{ name: 'oversized.jsonl', size: 100 * 1024 * 1024 + 1, mtime: 1000 },
				{ name: 'read-fails.jsonl', size: 120, mtime: 2000 },
				{ name: 'read-throws.jsonl', size: 120, mtime: 2000 },
			],
		});
		testState.statRemote.mockImplementation(async (filePath: string) => {
			if (filePath.includes('stat-fails')) return { success: false, error: 'stat denied' };
			if (filePath.includes('stat-throws')) throw new Error('stat exploded');
			if (filePath.includes('oversized')) {
				return { success: true, data: { size: 100 * 1024 * 1024 + 1, mtime: 1000 } };
			}
			return {
				success: true,
				data: {
					size: 120,
					mtime: filePath.includes('remote-ok')
						? 3000
						: filePath.includes('remote-second')
							? 2500
							: 2000,
				},
			};
		});
		testState.readFileRemote.mockImplementation(async (filePath: string) => {
			if (filePath.includes('read-fails')) return { success: false, error: 'read denied' };
			if (filePath.includes('read-throws')) throw new Error('read exploded');
			return { success: true, data: remoteContent };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);
		expect(sessions.map((session) => session.sessionId)).toEqual(['remote-ok', 'remote-second']);
		expect(testState.listDirWithStatsRemote).toHaveBeenCalledWith(remoteDir, sshConfig, {
			nameSuffix: '.jsonl',
		});

		const page = await storage.listSessionsPaginated(projectPath, { limit: 1 }, sshConfig);
		expect(page).toMatchObject({
			totalCount: 5,
			hasMore: true,
			nextCursor: expect.any(String),
		});
		expect(page.sessions.map((session) => session.sessionId)).toEqual(['remote-ok']);

		const cursorPage = await storage.listSessionsPaginated(
			projectPath,
			{ cursor: 'remote-ok', limit: 10 },
			sshConfig
		);
		expect(cursorPage).toMatchObject({
			totalCount: 5,
			hasMore: false,
			nextCursor: null,
		});
		expect(cursorPage.sessions.map((session) => session.sessionId)).toEqual(['remote-second']);

		await expect(
			storage.searchSessions(projectPath, 'needle', 'assistant', sshConfig)
		).resolves.toEqual([
			expect.objectContaining({ sessionId: 'remote-ok' }),
			expect.objectContaining({ sessionId: 'remote-second' }),
		]);

		await expect(
			storage.readSessionMessages(projectPath, 'remote-ok', { limit: 10 }, sshConfig)
		).resolves.toMatchObject({ total: 2, hasMore: false });

		testState.readFileRemote.mockResolvedValueOnce({ success: false, error: 'missing' });
		await expect(
			storage.readSessionMessages(projectPath, 'missing', {}, sshConfig)
		).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});

		testState.listDirWithStatsRemote.mockResolvedValueOnce({ success: false, error: 'no dir' });
		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);

		testState.listDirWithStatsRemote.mockResolvedValueOnce({ success: false, error: 'no dir' });
		await expect(
			storage.listSessionsPaginated(projectPath, { limit: 5 }, sshConfig)
		).resolves.toEqual({
			sessions: [],
			hasMore: false,
			totalCount: 0,
			nextCursor: null,
		});

		let remoteOkReads = 0;
		testState.listDirWithStatsRemote.mockResolvedValueOnce({
			success: true,
			data: [{ name: 'remote-ok.jsonl', size: 120, mtime: 3000 }],
		});
		testState.readFileRemote.mockImplementationOnce(async () => {
			remoteOkReads += 1;
			return { success: true, data: remoteContent };
		});
		testState.readFileRemote.mockImplementationOnce(async () => {
			remoteOkReads += 1;
			return { success: false, error: 'search read denied' };
		});
		await expect(storage.searchSessions(projectPath, 'needle', 'all', sshConfig)).resolves.toEqual([
			expect.objectContaining({ sessionId: 'remote-ok', matchCount: 0 }),
		]);
		expect(remoteOkReads).toBe(2);

		expect(storage.getSessionPath(projectPath, 'remote-ok', sshConfig)).toBe(
			`${remoteDir}/remote-ok.jsonl`
		);
	});

	it('deletes local message pairs by fallback content and handles unsupported or failed deletes', async () => {
		await writeSession('tool-read', [
			assistantMessage('a-tool', [
				{ type: 'text', text: 'Tool call follows' },
				{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
			]),
		]);
		await expect(storage.readSessionMessages(projectPath, 'tool-read')).resolves.toMatchObject({
			messages: [expect.objectContaining({ toolUse: [expect.objectContaining({ id: 'tool-1' })] })],
		});

		await writeSession('delete-by-content', [
			'malformed',
			userMessage('u-keep-before', 'Keep before'),
			userMessage('u-delete', [{ type: 'text', text: 'Delete this request' }]),
			assistantMessage('a-delete', 'Delete this response'),
			userMessage('u-keep-after', 'Keep after'),
		]);

		const deleted = await storage.deleteMessagePair(
			projectPath,
			'delete-by-content',
			'missing-uuid',
			'Delete this request'
		);
		expect(deleted).toEqual({ success: true, linesRemoved: 2 });
		await expect(
			storage.readSessionMessages(projectPath, 'delete-by-content')
		).resolves.toMatchObject({
			total: 2,
		});

		await expect(
			storage.deleteMessagePair(projectPath, 'delete-by-content', 'missing-uuid', 'not present')
		).resolves.toMatchObject({ success: false, error: 'User message not found' });
		await expect(
			storage.deleteMessagePair(
				projectPath,
				'delete-by-content',
				'u-keep-before',
				undefined,
				sshConfig
			)
		).resolves.toMatchObject({ success: false, error: 'Delete not supported for remote sessions' });
		await expect(
			storage.deleteMessagePair(projectPath, 'missing-session', 'u-missing')
		).resolves.toMatchObject({ success: false });
	});

	it('cleans orphaned tool results when deleting a tool-use turn', async () => {
		await writeSession('delete-tool-result', [
			userMessage('u-delete', 'Run the tool'),
			assistantMessage('a-tool', [
				{ type: 'text', text: 'Using a tool' },
				{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
			]),
			userMessage('u-string', 'String content is left alone'),
			assistantMessage('a-keep', 'Assistant message outside the deleted pair'),
			userMessage('u-trim', [
				{ type: 'tool_result', tool_use_id: 'tool-1', content: 'deleted result' },
				{ type: 'text', text: 'kept text' },
			]),
			userMessage('u-unchanged', [
				{ type: 'tool_result', tool_use_id: 'other-tool', content: 'still linked' },
				{ type: 'text', text: 'unchanged text' },
			]),
			userMessage('u-remove', [
				{ type: 'tool_result', tool_use_id: 'tool-1', content: 'only deleted result' },
			]),
		]);

		await expect(
			storage.deleteMessagePair(projectPath, 'delete-tool-result', 'u-delete')
		).resolves.toEqual({
			success: true,
			linesRemoved: 2,
		});

		const content = await fs.readFile(path.join(projectDir, 'delete-tool-result.jsonl'), 'utf-8');
		expect(content).toContain('String content is left alone');
		expect(content).toContain('kept text');
		expect(content).toContain('unchanged text');
		expect(content).toContain('still linked');
		expect(content).toContain('Assistant message outside the deleted pair');
		expect(content).not.toContain('deleted result');
		expect(content).not.toContain('only deleted result');
	});

	it('persists origin name, starred, context usage, and named-session lookups', async () => {
		await writeSession('named-existing', [userMessage('u-named', 'Named content')]);
		storage.updateSessionName(projectPath, 'new-name', 'Created Name');
		storage.registerSessionOrigin(projectPath, 'string-origin', 'auto');
		storage.registerSessionOrigin(projectPath, 'string-starred', 'auto');
		storage.registerSessionOrigin(projectPath, 'string-context', 'auto');
		storage.updateSessionName(projectPath, 'string-origin', 'Upgraded Name');
		storage.updateSessionStarred(projectPath, 'string-origin', true);
		storage.updateSessionContextUsage(projectPath, 'string-origin', 67);
		storage.updateSessionName(projectPath, 'string-origin', 'Updated Name');
		storage.updateSessionStarred(projectPath, 'string-starred', true);
		storage.updateSessionContextUsage(projectPath, 'string-context', 80);
		storage.updateSessionStarred(projectPath, 'new-starred', true);
		storage.updateSessionContextUsage(projectPath, 'new-context', 25);
		storage.updateSessionName(projectPath, 'named-existing', 'Existing File');
		const otherProject = path.join(tempRoot, 'other-project');
		const contextProject = path.join(tempRoot, 'context-project');
		storage.updateSessionStarred(otherProject, 'other-starred', true);
		storage.updateSessionContextUsage(contextProject, 'other-context', 40);

		expect(storage.getSessionOrigins(projectPath)).toMatchObject({
			'new-name': { origin: 'user', sessionName: 'Created Name' },
			'string-origin': {
				origin: 'auto',
				sessionName: 'Updated Name',
				starred: true,
				contextUsage: 67,
			},
			'string-starred': { origin: 'auto', starred: true },
			'string-context': { origin: 'auto', contextUsage: 80 },
			'new-starred': { origin: 'user', starred: true },
			'new-context': { origin: 'user', contextUsage: 25 },
		});
		expect(storage.getSessionOrigins(otherProject)).toMatchObject({
			'other-starred': { origin: 'user', starred: true },
		});
		expect(storage.getSessionOrigins(contextProject)).toMatchObject({
			'other-context': { origin: 'user', contextUsage: 40 },
		});

		const namedSessions = await storage.getAllNamedSessions();
		expect(namedSessions).toEqual([
			expect.objectContaining({
				agentSessionId: 'named-existing',
				sessionName: 'Existing File',
			}),
		]);

		originsStore.data.origins[projectPath].legacy = 'auto';
		expect(storage.getSessionOrigins(projectPath).legacy).toEqual({ origin: 'auto' });

		storage.updateSessionName(projectPath, 'stale-named', 'Stale named session');
		const originalGetSessionPath = storage.getSessionPath.bind(storage);
		const getSessionPathSpy = vi
			.spyOn(storage, 'getSessionPath')
			.mockImplementation((targetProjectPath, targetSessionId, targetSshConfig) => {
				if (targetSessionId === 'stale-named') {
					return null;
				}
				return originalGetSessionPath(targetProjectPath, targetSessionId, targetSshConfig);
			});
		try {
			const sessionsWithoutStale = await storage.getAllNamedSessions();
			expect(sessionsWithoutStale.map((session) => session.agentSessionId)).toEqual([
				'named-existing',
			]);
		} finally {
			getSessionPathSpy.mockRestore();
		}
	});
});
