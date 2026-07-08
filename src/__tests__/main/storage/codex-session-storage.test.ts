import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	mockHomeDir: '/home/test-user',
	mockUserDataDir: '/tmp/maestro-user-data',
	mockLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	mockCaptureException: vi.fn(),
	mockReadDirRemote: vi.fn(),
	mockReadFileRemote: vi.fn(),
	mockStatRemote: vi.fn(),
}));

const {
	mockHomeDir,
	mockUserDataDir,
	mockLogger,
	mockCaptureException,
	mockReadDirRemote,
	mockReadFileRemote,
	mockStatRemote,
} = mocks;

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => mocks.mockUserDataDir),
	},
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => mocks.mockHomeDir),
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mocks.mockLogger,
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: mocks.mockCaptureException,
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	readDirRemote: mocks.mockReadDirRemote,
	readFileRemote: mocks.mockReadFileRemote,
	statRemote: mocks.mockStatRemote,
}));

import fs from 'fs/promises';
import { CodexSessionStorage } from '../../../main/storage/codex-session-storage';
import type { SshRemoteConfig } from '../../../shared/types';

type MockDirent = { name: string; isDirectory: boolean };

const sessionsDir = path.join(mockHomeDir, '.codex', 'sessions');
const cachePath = path.join(mockUserDataDir, 'stats-cache', 'codex-sessions-cache.json');
const projectPath = '/repo/project';
const childProjectPath = '/repo/project/packages/app';
const otherProjectPath = '/elsewhere/project';
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sessionFileName = `rollout-20260511_101010_000-${sessionId}.jsonl`;
const sessionFilePath = path.join(sessionsDir, '2026', '05', '11', sessionFileName);

function jsonl(...entries: Array<Record<string, unknown> | string>): string {
	return entries
		.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
		.join('\n');
}

function sessionMeta(id = sessionId, cwd = projectPath, timestamp = '2026-05-11T10:00:00.000Z') {
	return {
		type: 'session_meta',
		timestamp,
		payload: {
			id,
			cwd,
			timestamp,
			git: { branch: 'full-test-coverage' },
		},
	};
}

function message(
	role: 'user' | 'assistant',
	text: string,
	timestamp = role === 'user' ? '2026-05-11T10:01:00.000Z' : '2026-05-11T10:02:30.000Z'
) {
	return {
		type: 'message',
		role,
		timestamp,
		content: [{ type: role === 'user' ? 'input_text' : 'text', text }],
	};
}

function responseMessage(role: 'user' | 'assistant', text: string, id = `${role}-id`) {
	return {
		type: 'response_item',
		timestamp: '2026-05-11T10:03:00.000Z',
		payload: {
			id,
			type: 'message',
			role,
			content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
		},
	};
}

function setupLocalSessionTree(files: Record<string, string>): void {
	vi.mocked(fs.access).mockImplementation(async (target: string) => {
		if (target === sessionsDir) return undefined;
		throw new Error(`missing ${target}`);
	});

	vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
		if (target === sessionsDir)
			return ['2026', 'notes.txt'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		if (target === path.join(sessionsDir, '2026'))
			return ['05', 'bad'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		if (target === path.join(sessionsDir, '2026', '05'))
			return ['11', '99'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		if (target === path.join(sessionsDir, '2026', '05', '11')) {
			return Object.keys(files).map((filePath) => path.basename(filePath)) as unknown as Awaited<
				ReturnType<typeof fs.readdir>
			>;
		}
		return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
	});

	vi.mocked(fs.stat).mockImplementation(async (target: string) => {
		if (
			[
				path.join(sessionsDir, '2026'),
				path.join(sessionsDir, '2026', '05'),
				path.join(sessionsDir, '2026', '05', '11'),
			].includes(target)
		) {
			return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
		}
		if (files[target]) {
			return {
				size: Buffer.byteLength(files[target]),
				mtimeMs: new Date('2026-05-11T10:05:00.000Z').getTime(),
				isDirectory: () => false,
			} as Awaited<ReturnType<typeof fs.stat>>;
		}
		throw new Error(`missing stat ${target}`);
	});

	vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
		if (target === cachePath) throw new Error('no cache');
		if (files[target]) return files[target];
		throw new Error(`missing read ${target}`);
	});
}

function remoteDir(entries: MockDirent[]) {
	return { success: true, data: entries };
}

class TestableCodexSessionStorage extends CodexSessionStorage {
	readSearchableMessagesForTest(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	) {
		return this.getSearchableMessages(sessionId, projectPath, sshConfig);
	}
}

describe('CodexSessionStorage', () => {
	let storage: CodexSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		storage = new CodexSessionStorage();
	});

	it('lists local sessions for a project, parses usage, skips system previews, and writes cache', async () => {
		const content = jsonl(
			sessionMeta(),
			message('user', '<environment_context><cwd>/repo/project</cwd></environment_context>'),
			message('user', 'Build the feature', '2026-05-11T10:01:10.000Z'),
			message('assistant', 'Implementation plan', '2026-05-11T10:02:40.000Z'),
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					reasoning_output_tokens: 5,
					cached_input_tokens: 3,
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
			'{malformed-json'
		);
		setupLocalSessionTree({ [sessionFilePath]: content });

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			projectPath,
			firstMessage: 'Implementation plan',
			messageCount: 3,
			inputTokens: 17,
			outputTokens: 38,
			cacheReadTokens: 7,
			cacheCreationTokens: 0,
			durationSeconds: 160,
		});
		expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(cachePath), { recursive: true });
		expect(fs.writeFile).toHaveBeenCalledWith(
			cachePath,
			expect.stringContaining(sessionFilePath),
			'utf-8'
		);
	});

	it('parses local sessions with metadata and token default fallbacks', async () => {
		const topTimestampId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
		const mtimeTimestampId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
		const topTimestampFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			`rollout-20260511_111111_000-${topTimestampId}.jsonl`
		);
		const mtimeTimestampFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			`rollout-20260511_121212_000-${mtimeTimestampId}.jsonl`
		);
		const topTimestampContent = jsonl(
			{
				type: 'session_meta',
				timestamp: '2026-05-11T11:00:00.000Z',
				payload: { cwd: projectPath },
			},
			{
				type: 'message',
				role: 'user',
				timestamp: '2026-05-11T11:01:00.000Z',
				content: [{ type: 'text' }, { type: 'input_text', text: 'User fallback preview' }],
			},
			{ type: 'turn.completed', usage: {} },
			{
				type: 'event_msg',
				payload: { type: 'token_count', info: { total_token_usage: {} } },
			}
		);
		const mtimeTimestampContent = jsonl(
			{
				type: 'session_meta',
				payload: { cwd: projectPath },
			},
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Timestamp falls back to file mtime' }],
			}
		);
		setupLocalSessionTree({
			[topTimestampFile]: topTimestampContent,
			[mtimeTimestampFile]: mtimeTimestampContent,
		});

		const sessions = await storage.listSessions(projectPath);
		const topTimestampSession = sessions.find((session) => session.sessionId === topTimestampId);
		const mtimeTimestampSession = sessions.find(
			(session) => session.sessionId === mtimeTimestampId
		);

		expect(topTimestampSession).toMatchObject({
			projectPath,
			firstMessage: 'User fallback preview',
			timestamp: '2026-05-11T11:00:00.000Z',
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
		});
		expect(mtimeTimestampSession).toMatchObject({
			projectPath,
			firstMessage: 'Timestamp falls back to file mtime',
			timestamp: '2026-05-11T10:05:00.000Z',
		});
	});

	it('parses local sessions with missing optional fields without listing sessions outside the project', async () => {
		const noProjectId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
		const rootProjectId = '99999999-9999-9999-9999-999999999999';
		const unrecognizedMetadataId = '88888888-8888-8888-8888-888888888888';
		const noProjectFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			`rollout-20260511_151515_000-${noProjectId}.jsonl`
		);
		const rootProjectFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			`rollout-20260511_161616_000-${rootProjectId}.jsonl`
		);
		const unrecognizedMetadataFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			`rollout-20260511_171717_000-${unrecognizedMetadataId}.jsonl`
		);
		const noProjectContent = jsonl(
			{ type: 'session_meta', payload: { id: noProjectId } },
			{ type: 'event_msg', payload: { type: 'token_count', info: {} } },
			{ type: 'message', role: 'user' },
			message('user', 'User text without cwd'),
			{ type: 'message', role: 'system', content: [{ type: 'text', text: 'ignored' }] },
			{ type: 'message', role: 'assistant' },
			{ type: 'message', role: 'assistant', content: [{ type: 'text', text: '   ' }] },
			{ type: 'response_item', payload: { type: 'message', role: 'user' } },
			responseMessage('user', 'Response user without cwd', 'response-user-no-cwd'),
			{
				type: 'response_item',
				payload: { type: 'message', role: 'system', content: [{ type: 'text', text: 'ignored' }] },
			},
			{ type: 'response_item', payload: { type: 'message', role: 'assistant' } },
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: '   ' }],
				},
			},
			{ type: 'item.completed', item: { type: 'tool_call', tool: 'shell' } },
			{ type: 'item.completed', item: { type: 'agent_message' } }
		);
		const rootProjectContent = jsonl(
			sessionMeta(rootProjectId, projectPath),
			message('assistant', 'Root project preview')
		);
		const unrecognizedMetadataContent = jsonl(
			{ type: 'other' },
			message('user', `<cwd>${projectPath}</cwd>`),
			message('assistant', 'Unrecognized metadata preview')
		);
		setupLocalSessionTree({
			[noProjectFile]: noProjectContent,
			[rootProjectFile]: rootProjectContent,
			[unrecognizedMetadataFile]: unrecognizedMetadataContent,
		});

		const projectSessions = await storage.listSessions(projectPath);

		expect(projectSessions.map((session) => session.sessionId)).toEqual(
			expect.arrayContaining([rootProjectId, unrecognizedMetadataId])
		);
		expect(projectSessions).toHaveLength(2);
		const rootSessions = await storage.listSessions('/');

		expect(rootSessions.map((session) => session.sessionId)).toEqual(
			expect.arrayContaining([rootProjectId, unrecognizedMetadataId])
		);
		expect(rootSessions).toHaveLength(2);
	});

	it('returns cached sessions without reparsing unchanged files', async () => {
		const cachedNoProjectFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			'cached-no-project.jsonl'
		);
		const cachedSession = {
			sessionId: 'cached-session',
			projectPath: childProjectPath,
			timestamp: '2026-05-11T10:00:00.000Z',
			modifiedAt: '2026-05-11T10:05:00.000Z',
			firstMessage: 'Cached preview',
			messageCount: 1,
			sizeBytes: 10,
		};
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(sessionMeta()),
			[cachedNoProjectFile]: jsonl(sessionMeta('cached-no-project', '')),
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) {
				return JSON.stringify({
					version: 3,
					lastProcessedAt: 1,
					sessions: {
						[sessionFilePath]: {
							session: cachedSession,
							fileMtimeMs: new Date('2026-05-11T10:05:00.000Z').getTime(),
						},
						[cachedNoProjectFile]: {
							session: {
								...cachedSession,
								sessionId: 'cached-no-project',
								projectPath: '',
							},
							fileMtimeMs: new Date('2026-05-11T10:05:00.000Z').getTime(),
						},
					},
				});
			}
			throw new Error(`unexpected read ${target}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([cachedSession]);
		expect(fs.writeFile).not.toHaveBeenCalled();
	});

	it('filters out sessions from unrelated projects and removes stale cache entries', async () => {
		setupLocalSessionTree({ [sessionFilePath]: jsonl(sessionMeta(sessionId, otherProjectPath)) });
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) {
				return JSON.stringify({
					version: 3,
					lastProcessedAt: 1,
					sessions: {
						'/missing/session.jsonl': {
							session: {
								sessionId: 'stale',
								projectPath,
								timestamp: '2026-05-11T10:00:00.000Z',
								modifiedAt: '2026-05-11T10:00:00.000Z',
								firstMessage: 'stale',
								messageCount: 1,
								sizeBytes: 1,
							},
							fileMtimeMs: 1,
						},
					},
				});
			}
			return jsonl(sessionMeta(sessionId, otherProjectPath));
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([]);
		expect(fs.writeFile).toHaveBeenCalledWith(
			cachePath,
			expect.not.stringContaining('/missing/session.jsonl'),
			'utf-8'
		);
	});

	it('parses legacy local sessions and tolerates stale cache and save failures', async () => {
		const legacySessionId = 'legacy-session-id';
		const legacyFileName = 'plain-session.jsonl';
		const legacyFilePath = path.join(sessionsDir, '2026', '05', '11', legacyFileName);
		const emptyFilePath = path.join(sessionsDir, '2026', '05', '11', 'empty.jsonl');
		const legacyContent = jsonl(
			{
				id: legacySessionId,
				timestamp: '2026-05-11T09:00:00.000Z',
				git: { branch: 'legacy' },
			},
			message('user', `<cwd>${childProjectPath}</cwd>`, '2026-05-11T09:01:00.000Z'),
			message('assistant', 'Legacy answer', '2026-05-11T09:02:00.000Z')
		);

		vi.mocked(fs.access).mockResolvedValue(undefined);
		vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
			if (target === sessionsDir)
				return ['2025', '2026', 'notes.txt'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026'))
				return ['04', '05'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05'))
				return ['10', '11'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05', '11')) {
				return ['README.md', legacyFileName, 'empty.jsonl'] as unknown as Awaited<
					ReturnType<typeof fs.readdir>
				>;
			}
			return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		});
		vi.mocked(fs.stat).mockImplementation(async (target: string) => {
			if (
				target === path.join(sessionsDir, '2025') ||
				target === path.join(sessionsDir, '2026', '04') ||
				target === path.join(sessionsDir, '2026', '05', '10')
			) {
				return { isDirectory: () => false } as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (
				target === path.join(sessionsDir, '2026') ||
				target === path.join(sessionsDir, '2026', '05') ||
				target === path.join(sessionsDir, '2026', '05', '11')
			) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === emptyFilePath) {
				return {
					size: 0,
					mtimeMs: new Date('2026-05-11T09:04:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === legacyFilePath) {
				return {
					size: Buffer.byteLength(legacyContent),
					mtimeMs: new Date('2026-05-11T09:05:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			throw new Error(`missing stat ${target}`);
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) {
				return JSON.stringify({ version: 2, lastProcessedAt: 1, sessions: {} });
			}
			if (target === legacyFilePath) return legacyContent;
			throw new Error(`missing read ${target}`);
		});
		vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('cache disk full'));

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: legacySessionId,
			projectPath: childProjectPath,
			firstMessage: 'Legacy answer',
			messageCount: 2,
			durationSeconds: 120,
		});
		expect(fs.writeFile).toHaveBeenCalledWith(
			cachePath,
			expect.stringContaining(legacySessionId),
			'utf-8'
		);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Failed to save Codex session cache',
			'[CodexSessionStorage]',
			expect.objectContaining({ error: expect.any(Error) })
		);
	});

	it('skips local stat, oversized, RangeError, and read failures while reporting unexpected errors', async () => {
		const statFailureFile = path.join(sessionsDir, '2026', '05', '11', 'stat-failure.jsonl');
		const oversizedFile = path.join(sessionsDir, '2026', '05', '11', 'oversized.jsonl');
		const rangeErrorFile = path.join(sessionsDir, '2026', '05', '11', 'range-error.jsonl');
		const readErrorFile = path.join(sessionsDir, '2026', '05', '11', 'read-error.jsonl');

		vi.mocked(fs.access).mockResolvedValue(undefined);
		vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
			if (target === sessionsDir)
				return ['2026'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026'))
				return ['05'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05'))
				return ['11'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05', '11')) {
				return [
					'stat-failure.jsonl',
					'oversized.jsonl',
					'range-error.jsonl',
					'read-error.jsonl',
				] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			}
			return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		});
		vi.mocked(fs.stat).mockImplementation(async (target: string) => {
			if (
				target === path.join(sessionsDir, '2026') ||
				target === path.join(sessionsDir, '2026', '05') ||
				target === path.join(sessionsDir, '2026', '05', '11')
			) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === statFailureFile) {
				throw new Error('stat failed');
			}
			if (target === oversizedFile) {
				return {
					size: 101 * 1024 * 1024,
					mtimeMs: new Date('2026-05-11T09:05:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			return {
				size: 100,
				mtimeMs: new Date('2026-05-11T09:06:00.000Z').getTime(),
				isDirectory: () => false,
			} as Awaited<ReturnType<typeof fs.stat>>;
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) throw new Error('no cache');
			if (target === rangeErrorFile) throw new RangeError('invalid string length');
			if (target === readErrorFile) throw new Error('disk read failed');
			throw new Error(`unexpected read ${target}`);
		});

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);

		expect(mockLogger.error).toHaveBeenCalledWith(
			'Error stating Codex session file: stat-failure.jsonl',
			'[CodexSessionStorage]',
			expect.any(Error)
		);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Skipping oversized Codex session file',
			'[CodexSessionStorage]',
			expect.objectContaining({ filePath: oversizedFile, size: 101 * 1024 * 1024 })
		);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Codex session file too large to parse',
			'[CodexSessionStorage]',
			{ filePath: rangeErrorFile }
		);
		expect(mockLogger.error).toHaveBeenCalledWith(
			`Error reading Codex session file: ${readErrorFile}`,
			'[CodexSessionStorage]',
			expect.any(Error)
		);
		expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'codexStorage:statSessionFile',
			filename: 'stat-failure.jsonl',
		});
		expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'codexStorage:readSessionFile',
			filePath: readErrorFile,
		});
		expect(mockCaptureException).not.toHaveBeenCalledWith(
			expect.any(RangeError),
			expect.anything()
		);
	});

	it('parses current local response-item sessions and sorts by modified date', async () => {
		const newerId = '11111111-2222-3333-4444-555555555555';
		const olderId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
		const newerFileName = `rollout-20260511_120000_000-${newerId}.jsonl`;
		const olderFileName = `rollout-20260511_110000_000-${olderId}.jsonl`;
		const newerFilePath = path.join(sessionsDir, '2026', '05', '11', newerFileName);
		const olderFilePath = path.join(sessionsDir, '2026', '05', '11', olderFileName);
		const newerContent = jsonl(
			'{malformed metadata',
			responseMessage('user', `<cwd>${projectPath}</cwd>`, 'current-user-cwd'),
			responseMessage('user', 'Current request', 'current-user-request'),
			responseMessage('assistant', 'Current assistant', 'current-assistant')
		);
		const olderContent = jsonl(sessionMeta(olderId, projectPath, '2026-05-11T11:00:00.000Z'), {
			type: 'item.completed',
			item: { type: 'agent_message', text: 'Older agent reply' },
		});

		vi.mocked(fs.access).mockResolvedValue(undefined);
		vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
			if (target === sessionsDir)
				return ['2026'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026'))
				return ['05'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05'))
				return ['11'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05', '11')) {
				return [olderFileName, newerFileName] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			}
			return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		});
		vi.mocked(fs.stat).mockImplementation(async (target: string) => {
			if (
				target === path.join(sessionsDir, '2026') ||
				target === path.join(sessionsDir, '2026', '05') ||
				target === path.join(sessionsDir, '2026', '05', '11')
			) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === newerFilePath) {
				return {
					size: Buffer.byteLength(newerContent),
					mtimeMs: new Date('2026-05-11T12:10:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === olderFilePath) {
				return {
					size: Buffer.byteLength(olderContent),
					mtimeMs: new Date('2026-05-11T11:10:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			throw new Error(`missing stat ${target}`);
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) throw new Error('no cache');
			if (target === newerFilePath) return newerContent;
			if (target === olderFilePath) return olderContent;
			throw new Error(`missing read ${target}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((session) => session.sessionId)).toEqual([newerId, olderId]);
		expect(sessions[0]).toMatchObject({
			projectPath,
			firstMessage: 'Current assistant',
			messageCount: 3,
		});
		expect(sessions[1]).toMatchObject({
			projectPath,
			firstMessage: 'Older agent reply',
			messageCount: 1,
		});
	});

	it('returns null for non-empty local sessions without parseable lines', async () => {
		const blankContentFile = path.join(sessionsDir, '2026', '05', '11', 'blank-content.jsonl');
		vi.mocked(fs.access).mockResolvedValue(undefined);
		vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
			if (target === sessionsDir)
				return ['2026'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026'))
				return ['05'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05'))
				return ['11'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05', '11')) {
				return ['blank-content.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			}
			return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		});
		vi.mocked(fs.stat).mockImplementation(async (target: string) => {
			if (
				target === path.join(sessionsDir, '2026') ||
				target === path.join(sessionsDir, '2026', '05') ||
				target === path.join(sessionsDir, '2026', '05', '11')
			) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === blankContentFile) {
				return {
					size: 1,
					mtimeMs: new Date('2026-05-11T09:05:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			throw new Error(`missing stat ${target}`);
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) throw new Error('no cache');
			if (target === blankContentFile) return '\n';
			throw new Error(`missing read ${target}`);
		});

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
	});

	it('logs when the local sessions directory is missing', async () => {
		vi.mocked(fs.access).mockRejectedValueOnce(new Error('missing sessions dir'));
		vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('no cache'));

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);

		expect(mockLogger.info).toHaveBeenCalledWith(
			'No Codex sessions found',
			'[CodexSessionStorage]'
		);
	});

	it('skips malformed and inaccessible local date directories while keeping valid sessions', async () => {
		vi.mocked(fs.access).mockResolvedValue(undefined);
		vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
			if (target === sessionsDir)
				return ['notes.txt', '2025', '2026'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026'))
				return ['xx', '04', '05'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05'))
				return ['x', '11'] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			if (target === path.join(sessionsDir, '2026', '05', '11')) {
				return [sessionFileName] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
			}
			return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		});
		vi.mocked(fs.stat).mockImplementation(async (target: string) => {
			if (target === path.join(sessionsDir, '2025')) throw new Error('year stat failed');
			if (target === path.join(sessionsDir, '2026', '04')) throw new Error('month stat failed');
			if (
				target === path.join(sessionsDir, '2026') ||
				target === path.join(sessionsDir, '2026', '05') ||
				target === path.join(sessionsDir, '2026', '05', '11')
			) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
			}
			if (target === sessionFilePath) {
				return {
					size: 256,
					mtimeMs: new Date('2026-05-11T10:05:00.000Z').getTime(),
					isDirectory: () => false,
				} as Awaited<ReturnType<typeof fs.stat>>;
			}
			throw new Error(`missing stat ${target}`);
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) throw new Error('no cache');
			if (target === sessionFilePath) {
				return jsonl(sessionMeta(), message('assistant', 'Valid session survived traversal skips'));
			}
			throw new Error(`missing read ${target}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			firstMessage: 'Valid session survived traversal skips',
		});
	});

	it('reads local messages across Codex JSONL formats with pagination', async () => {
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(
				sessionMeta(),
				message('user', 'Legacy user'),
				responseMessage('assistant', 'Response assistant', 'assistant-response'),
				{
					type: 'response_item',
					timestamp: '2026-05-11T10:04:00.000Z',
					payload: {
						type: 'function_call',
						name: 'shell',
						arguments: '{"cmd":"npm test"}',
						call_id: 'call-1',
					},
				},
				{
					type: 'response_item',
					timestamp: '2026-05-11T10:04:30.000Z',
					payload: { type: 'function_call_output', output: 'passed', call_id: 'call-1' },
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-11T10:05:00.000Z',
					item: { type: 'agent_message', text: 'Legacy agent', id: 'agent-1' },
				},
				{
					type: 'item.completed',
					timestamp: '2026-05-11T10:06:00.000Z',
					item: { type: 'tool_result', output: [111, 107], id: 'tool-result-1' },
				}
			),
		});

		const allMessages = await storage.readSessionMessages(projectPath, sessionId, {
			offset: 0,
			limit: 10,
		});
		const result = await storage.readSessionMessages(projectPath, sessionId, {
			offset: 1,
			limit: 3,
		});

		expect(allMessages.messages.map((message) => message.content)).toEqual([
			'Legacy user',
			'Response assistant',
			'Tool: shell',
			'Legacy agent',
			'ok',
		]);
		expect(result.total).toBe(5);
		expect(result.hasMore).toBe(true);
		expect(result.messages.map((message) => message.content)).toEqual([
			'Response assistant',
			'Tool: shell',
			'Legacy agent',
		]);
		expect(result.messages[1].toolUse).toEqual([
			expect.objectContaining({
				tool: 'shell',
				args: '{"cmd":"npm test"}',
				state: expect.objectContaining({
					status: 'completed',
					output: 'passed',
				}),
			}),
		]);
	});

	it('reads message fallbacks for malformed arguments and missing optional fields', async () => {
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(
				sessionMeta(),
				{ type: 'message', role: 'assistant' },
				{
					type: 'response_item',
					payload: { type: 'message', role: 'user', id: 'empty-user' },
				},
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'text', text: 'Untimestamped direct message' }],
				},
				{
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text: 'Untimestamped response item' }],
					},
				},
				{
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'system',
						content: [{ type: 'text', text: 'Ignored response item' }],
					},
				},
				{
					type: 'response_item',
					payload: { type: 'function_call', name: 'empty-args' },
				},
				{
					type: 'response_item',
					payload: { type: 'function_call', name: 'shell', arguments: '{bad-json' },
				},
				{
					type: 'response_item',
					payload: { type: 'function_call_output', output: '' },
				},
				{
					type: 'item.completed',
					item: { type: 'agent_message' },
				},
				{
					type: 'item.completed',
					item: { type: 'tool_call', tool: 'shell', args: { cmd: 'pwd' } },
				},
				{
					type: 'item.completed',
					item: { type: 'tool_result' },
				},
				{
					type: 'item.completed',
					item: { type: 'tool_result', output: { ok: true } },
				}
			),
		});

		const result = await storage.readSessionMessages(projectPath, sessionId);

		expect(result.messages).toEqual([
			expect.objectContaining({
				type: 'assistant',
				content: 'Untimestamped direct message',
				timestamp: '',
				uuid: 'codex-msg-0',
			}),
			expect.objectContaining({
				type: 'assistant',
				content: 'Untimestamped response item',
				timestamp: '',
				uuid: 'codex-msg-1',
			}),
			expect.objectContaining({
				type: 'assistant',
				content: 'Tool: empty-args',
				timestamp: '',
				uuid: 'codex-msg-2',
				toolUse: [
					expect.objectContaining({
						tool: 'empty-args',
						args: undefined,
						state: expect.objectContaining({ input: {}, status: 'running' }),
					}),
				],
			}),
			expect.objectContaining({
				type: 'assistant',
				content: 'Tool: shell',
				timestamp: '',
				uuid: 'codex-msg-3',
				toolUse: [
					expect.objectContaining({
						tool: 'shell',
						args: '{bad-json',
						state: expect.objectContaining({ input: '{bad-json', status: 'running' }),
					}),
				],
			}),
			expect.objectContaining({
				content: '[Tool result]',
				timestamp: '',
				uuid: 'codex-msg-4',
			}),
			expect.objectContaining({
				content: '',
				timestamp: '',
				uuid: 'codex-msg-5',
			}),
			expect.objectContaining({
				content: 'Tool: shell',
				timestamp: '',
				uuid: 'codex-msg-6',
				toolUse: [{ tool: 'shell', args: { cmd: 'pwd' } }],
			}),
			expect.objectContaining({
				content: '[Tool result]',
				timestamp: '',
				uuid: 'codex-msg-7',
			}),
			expect.objectContaining({
				content: '[object Object]',
				timestamp: '',
				uuid: 'codex-msg-8',
			}),
		]);
		expect(result.total).toBe(9);
		expect(result.hasMore).toBe(false);
	});

	it('extracts searchable messages from local and remote files found by metadata id', async () => {
		const searchableStorage = new TestableCodexSessionStorage();
		const metadataSessionId = 'metadata-session-id';
		const metadataFileName = 'metadata-only-session.jsonl';
		const metadataFilePath = path.join(sessionsDir, '2026', '05', '11', metadataFileName);
		setupLocalSessionTree({
			[metadataFilePath]: jsonl(
				{ id: metadataSessionId, timestamp: '2026-05-11T10:00:00.000Z' },
				message('user', 'Search user'),
				responseMessage('assistant', 'Search assistant'),
				{ type: 'message', role: 'system', content: [{ type: 'text', text: 'ignored' }] },
				{ type: 'item.completed', item: { type: 'agent_message', text: 'Search agent' } },
				{ type: 'item.completed', item: { type: 'agent_message', text: '' } },
				'{malformed-json'
			),
		});

		await expect(
			searchableStorage.readSearchableMessagesForTest(metadataSessionId, projectPath)
		).resolves.toEqual([
			{ role: 'user', textContent: 'Search user' },
			{ role: 'assistant', textContent: 'Search assistant' },
			{ role: 'assistant', textContent: 'Search agent' },
		]);
		await expect(
			searchableStorage.readSearchableMessagesForTest('missing-session', projectPath)
		).resolves.toEqual([]);

		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionId = 'remote-metadata-session';
		const remoteFile = '~/.codex/sessions/2026/05/11/remote-metadata.jsonl';
		const remoteContent = jsonl(
			{ id: remoteSessionId, timestamp: '2026-05-11T11:00:00.000Z' },
			responseMessage('user', 'Remote search user'),
			{ type: 'item.completed', item: { type: 'agent_message', text: 'Remote search agent' } }
		);
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([{ name: 'remote-metadata.jsonl', isDirectory: false }]);
			}
			return { success: false };
		});
		mockReadFileRemote.mockResolvedValue({ success: true, data: remoteContent });

		await expect(
			searchableStorage.readSearchableMessagesForTest(remoteSessionId, projectPath, sshConfig)
		).resolves.toEqual([
			{ role: 'user', textContent: 'Remote search user' },
			{ role: 'assistant', textContent: 'Remote search agent' },
		]);
		expect(mockReadFileRemote).toHaveBeenCalledWith(remoteFile, sshConfig);
	});

	it('deletes a local message pair and associated tool result blocks', async () => {
		const content = jsonl(
			sessionMeta(),
			message('user', 'Delete me'),
			message('assistant', 'Assistant reply'),
			{
				type: 'item.completed',
				item: { type: 'tool_call', id: 'tool-1', tool: 'shell', args: { cmd: 'pwd' } },
			},
			{
				type: 'item.completed',
				item: { type: 'tool_result', tool_call_id: 'tool-1', output: 'ok' },
			},
			message('user', 'Keep me')
		);
		setupLocalSessionTree({ [sessionFilePath]: content });

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-0');

		expect(result).toEqual({ success: true, linesRemoved: 4 });
		const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
		expect(written).toContain('Keep me');
		expect(written).not.toContain('Delete me');
		expect(written).not.toContain('tool_result');
	});

	it('supports fallback-content deletion and reports missing messages', async () => {
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(
				sessionMeta(),
				message('user', 'Fallback target'),
				message('assistant', 'Reply')
			),
		});

		const deleted = await storage.deleteMessagePair(
			projectPath,
			sessionId,
			'codex-msg-99',
			'Fallback target'
		);
		expect(deleted.success).toBe(true);

		setupLocalSessionTree({
			[sessionFilePath]: jsonl(sessionMeta(), message('user', 'Only message')),
		});
		const missing = await storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-99');
		expect(missing).toEqual({ success: false, error: 'User message not found' });
	});

	it('handles metadata lookup misses and preserves unrelated tool results during deletion', async () => {
		const blankLookupFile = path.join(sessionsDir, '2026', '05', '11', 'blank-lookup.jsonl');
		const metadataMismatchFile = path.join(
			sessionsDir,
			'2026',
			'05',
			'11',
			'metadata-mismatch.jsonl'
		);
		setupLocalSessionTree({
			[blankLookupFile]: '\n',
			[metadataMismatchFile]: jsonl({ id: 'different-session' }),
			[sessionFilePath]: jsonl(
				sessionMeta(),
				message('user', 'Delete target'),
				{ type: 'item.completed', item: { type: 'tool_call', id: 'tool-1', tool: 'shell' } },
				message('user', 'Keep target'),
				{ type: 'item.completed', item: { type: 'tool_result', output: 'orphan keep' } },
				{
					type: 'item.completed',
					item: { type: 'tool_result', tool_call_id: 'other-tool', output: 'other keep' },
				}
			),
		});

		await expect(storage.readSessionMessages(projectPath, 'missing-session')).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-99', 'Different content')
		).resolves.toEqual({ success: false, error: 'User message not found' });

		const deleted = await storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-0');

		expect(deleted).toEqual({ success: true, linesRemoved: 2 });
		const written = vi.mocked(fs.writeFile).mock.calls.at(-1)?.[1] as string;
		expect(written).toContain('Keep target');
		expect(written).toContain('orphan keep');
		expect(written).toContain('other keep');
		expect(written).not.toContain('Delete target');
	});

	it('rejects remote deletion and returns null for synchronous session paths', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;

		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-0', undefined, sshConfig)
		).resolves.toEqual({ success: false, error: 'Delete not supported for remote sessions' });
		expect(storage.getSessionPath(projectPath, sessionId)).toBeNull();
	});

	it('lists and reads remote sessions through SSH utilities', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteFile = `~/.codex/sessions/2026/05/11/${sessionFileName}`;
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([{ name: sessionFileName, isDirectory: false }]);
			}
			return { success: false };
		});
		mockStatRemote.mockResolvedValue({
			success: true,
			data: { size: 100, mtime: new Date('2026-05-11T10:05:00.000Z').getTime() },
		});
		mockReadFileRemote.mockResolvedValue({
			success: true,
			data: jsonl(sessionMeta(sessionId, projectPath), responseMessage('user', 'Remote user')),
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);
		const messages = await storage.readSessionMessages(
			projectPath,
			sessionId,
			undefined,
			sshConfig
		);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ sessionId, projectPath, messageCount: 1 });
		expect(messages.messages.map((message) => message.content)).toEqual(['Remote user']);
		expect(mockReadFileRemote).toHaveBeenCalledWith(remoteFile, sshConfig);
	});

	it('logs when no remote sessions are discovered', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mockReadDirRemote.mockResolvedValue({ success: false });

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);

		expect(mockLogger.info).toHaveBeenCalledWith(
			'No Codex sessions found on remote',
			'[CodexSessionStorage]'
		);
	});

	it('parses rich remote session metadata, usage, timestamps, and fallback cwd', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionId = 'remote-rich-session';
		const remoteFile = '~/.codex/sessions/2026/05/11/remote-rich.jsonl';
		const newerRemoteSessionId = 'remote-newer-session';
		const newerRemoteFile = '~/.codex/sessions/2026/05/11/remote-newer.jsonl';
		const remoteContent = jsonl(
			{ id: remoteSessionId, timestamp: '2026-05-11T10:00:00.000Z' },
			message('user', `<cwd>${childProjectPath}</cwd>`, '2026-05-11T10:01:00.000Z'),
			message('assistant', 'Remote legacy assistant', '2026-05-11T10:02:00.000Z'),
			responseMessage('user', 'Remote response user'),
			responseMessage('assistant', 'Remote response assistant'),
			{
				type: 'item.completed',
				timestamp: '2026-05-11T10:05:00.000Z',
				item: { type: 'agent_message', text: 'Remote agent text' },
			},
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 13,
					output_tokens: 17,
					reasoning_output_tokens: 19,
					cached_input_tokens: 23,
				},
			},
			{
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {
							input_tokens: 29,
							output_tokens: 31,
							reasoning_output_tokens: 37,
							cached_input_tokens: 41,
						},
					},
				},
			}
		);
		const newerRemoteContent = jsonl(
			sessionMeta(newerRemoteSessionId, projectPath, '2026-05-11T12:00:00.000Z'),
			message('assistant', 'Newer remote assistant', '2026-05-11T12:01:00.000Z')
		);
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([
					{ name: 'remote-rich.jsonl', isDirectory: false },
					{ name: 'remote-newer.jsonl', isDirectory: false },
				]);
			}
			return { success: false };
		});
		mockStatRemote.mockImplementation(async (target: string) => {
			if (target === newerRemoteFile) {
				return {
					success: true,
					data: { size: Buffer.byteLength(newerRemoteContent), mtime: 1778498000000 },
				};
			}
			return {
				success: true,
				data: { size: Buffer.byteLength(remoteContent), mtime: 1778494000000 },
			};
		});
		mockReadFileRemote.mockImplementation(async (target: string) => {
			if (target === newerRemoteFile) return { success: true, data: newerRemoteContent };
			return { success: true, data: remoteContent };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions).toHaveLength(2);
		expect(sessions.map((session) => session.sessionId)).toEqual([
			newerRemoteSessionId,
			remoteSessionId,
		]);
		expect(sessions[0]).toMatchObject({
			sessionId: newerRemoteSessionId,
			projectPath,
			firstMessage: 'Newer remote assistant',
			messageCount: 1,
		});
		expect(sessions[1]).toMatchObject({
			sessionId: remoteSessionId,
			projectPath: childProjectPath,
			firstMessage: 'Remote legacy assistant',
			messageCount: 5,
			inputTokens: 42,
			outputTokens: 104,
			cacheReadTokens: 64,
			cacheCreationTokens: 0,
			durationSeconds: 300,
		});
	});

	it('parses remote sessions with metadata and token default fallbacks', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const topTimestampId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
		const mtimeTimestampId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
		const topTimestampFile = `rollout-20260511_131313_000-${topTimestampId}.jsonl`;
		const mtimeTimestampFile = `rollout-20260511_141414_000-${mtimeTimestampId}.jsonl`;
		const topTimestampPath = `~/.codex/sessions/2026/05/11/${topTimestampFile}`;
		const topTimestampContent = jsonl(
			{
				type: 'session_meta',
				timestamp: '2026-05-11T13:00:00.000Z',
				payload: { cwd: projectPath },
			},
			{
				type: 'message',
				role: 'user',
				timestamp: '2026-05-11T13:01:00.000Z',
				content: [{ type: 'text' }, { type: 'input_text', text: 'Remote fallback preview' }],
			},
			{ type: 'turn.completed', usage: {} },
			{
				type: 'event_msg',
				payload: { type: 'token_count', info: { total_token_usage: {} } },
			}
		);
		const mtimeTimestampContent = jsonl(
			{
				type: 'session_meta',
				payload: { cwd: projectPath },
			},
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Remote timestamp uses mtime' }],
			}
		);
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([
					{ name: topTimestampFile, isDirectory: false },
					{ name: mtimeTimestampFile, isDirectory: false },
				]);
			}
			return { success: false };
		});
		mockStatRemote.mockResolvedValue({
			success: true,
			data: { size: 100, mtime: new Date('2026-05-11T10:05:00.000Z').getTime() },
		});
		mockReadFileRemote.mockImplementation(async (target: string) => ({
			success: true,
			data: target === topTimestampPath ? topTimestampContent : mtimeTimestampContent,
		}));

		const sessions = await storage.listSessions(projectPath, sshConfig);
		const topTimestampSession = sessions.find((session) => session.sessionId === topTimestampId);
		const mtimeTimestampSession = sessions.find(
			(session) => session.sessionId === mtimeTimestampId
		);

		expect(topTimestampSession).toMatchObject({
			projectPath,
			firstMessage: 'Remote fallback preview',
			timestamp: '2026-05-11T13:00:00.000Z',
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
		});
		expect(mtimeTimestampSession).toMatchObject({
			projectPath,
			firstMessage: 'Remote timestamp uses mtime',
			timestamp: '2026-05-11T10:05:00.000Z',
		});
	});

	it('parses remote sessions with missing optional fields without listing sessions outside the project', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteFile = '~/.codex/sessions/2026/05/11/no-project.jsonl';
		const unrecognizedMetadataFile = '~/.codex/sessions/2026/05/11/unrecognized-metadata.jsonl';
		const remoteContent = jsonl(
			{ type: 'session_meta', payload: { id: 'remote-no-project' } },
			{ type: 'event_msg', payload: { type: 'token_count', info: {} } },
			{ type: 'message', role: 'user' },
			message('user', 'Remote user text without cwd'),
			{ type: 'message', role: 'system', content: [{ type: 'text', text: 'ignored' }] },
			{ type: 'message', role: 'assistant' },
			{ type: 'message', role: 'assistant', content: [{ type: 'text', text: '   ' }] },
			{ type: 'response_item', payload: { type: 'message', role: 'user' } },
			responseMessage('user', 'Remote response user without cwd', 'remote-response-user-no-cwd'),
			{
				type: 'response_item',
				payload: { type: 'message', role: 'system', content: [{ type: 'text', text: 'ignored' }] },
			},
			{ type: 'response_item', payload: { type: 'message', role: 'assistant' } },
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: '   ' }],
				},
			},
			{ type: 'item.completed', item: { type: 'tool_call', tool: 'shell' } },
			{ type: 'item.completed', item: { type: 'agent_message' } }
		);
		const unrecognizedMetadataContent = jsonl(
			{ type: 'other' },
			message('user', `<cwd>${projectPath}</cwd>`),
			message('assistant', 'Remote unrecognized metadata preview')
		);
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([
					{ name: 'no-project.jsonl', isDirectory: false },
					{ name: 'unrecognized-metadata.jsonl', isDirectory: false },
				]);
			}
			return { success: false };
		});
		mockStatRemote.mockImplementation(async (target: string) => ({
			success: true,
			data: {
				size: Buffer.byteLength(
					target === unrecognizedMetadataFile ? unrecognizedMetadataContent : remoteContent
				),
				mtime: 1778499000000,
			},
		}));
		mockReadFileRemote.mockImplementation(async (target: string) => {
			if (target === unrecognizedMetadataFile) {
				return { success: true, data: unrecognizedMetadataContent };
			}
			return { success: true, data: remoteContent };
		});

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toMatchObject([
			{
				sessionId: 'unrecognized-metadata',
				projectPath,
				firstMessage: 'Remote unrecognized metadata preview',
			},
		]);
	});

	it('skips remote traversal, stat, and parse failures without reporting sessions', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const statFailureFile = '~/.codex/sessions/2026/05/11/stat-failure.jsonl';
		const emptyFile = '~/.codex/sessions/2026/05/11/empty.jsonl';
		const oversizedFile = '~/.codex/sessions/2026/05/11/oversized.jsonl';
		const readFailureFile = '~/.codex/sessions/2026/05/11/read-failure.jsonl';
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') {
				return remoteDir([
					{ name: 'not-a-dir', isDirectory: false },
					{ name: 'bad', isDirectory: true },
					{ name: '2025', isDirectory: true },
					{ name: '2026', isDirectory: true },
				]);
			}
			if (target === '~/.codex/sessions/2025') return { success: false };
			if (target === '~/.codex/sessions/2026') {
				return remoteDir([
					{ name: 'xx', isDirectory: true },
					{ name: '05', isDirectory: true },
				]);
			}
			if (target === '~/.codex/sessions/2026/05') {
				return remoteDir([
					{ name: 'not-day', isDirectory: true },
					{ name: '11', isDirectory: true },
				]);
			}
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([
					{ name: 'folder.jsonl', isDirectory: true },
					{ name: 'stat-failure.jsonl', isDirectory: false },
					{ name: 'empty.jsonl', isDirectory: false },
					{ name: 'oversized.jsonl', isDirectory: false },
					{ name: 'read-failure.jsonl', isDirectory: false },
				]);
			}
			return { success: false };
		});
		mockStatRemote.mockImplementation(async (target: string) => {
			if (target === statFailureFile) return { success: false };
			if (target === emptyFile) return { success: true, data: { size: 0, mtime: 1 } };
			if (target === oversizedFile) {
				return { success: true, data: { size: 101 * 1024 * 1024, mtime: 2 } };
			}
			if (target === readFailureFile) return { success: true, data: { size: 100, mtime: 3 } };
			return { success: false };
		});
		mockReadFileRemote.mockResolvedValue({ success: false, error: 'permission denied' });

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);

		expect(mockLogger.error).toHaveBeenCalledWith(
			'Error stating remote Codex session file: stat-failure.jsonl',
			'[CodexSessionStorage]'
		);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Skipping oversized remote Codex session file',
			'[CodexSessionStorage]',
			expect.objectContaining({ filePath: oversizedFile, size: 101 * 1024 * 1024 })
		);
		expect(mockLogger.error).toHaveBeenCalledWith(
			`Failed to read remote Codex session file: ${readFailureFile} - permission denied`,
			'[CodexSessionStorage]'
		);
	});

	it('returns empty remote reads when the session file cannot be read after lookup', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteFile = `~/.codex/sessions/2026/05/11/${sessionFileName}`;
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([{ name: sessionFileName, isDirectory: false }]);
			}
			return { success: false };
		});
		mockReadFileRemote.mockResolvedValue({ success: false, error: 'read denied' });

		await expect(
			storage.readSessionMessages(projectPath, sessionId, undefined, sshConfig)
		).resolves.toEqual({ messages: [], total: 0, hasMore: false });

		expect(mockReadFileRemote).toHaveBeenCalledWith(remoteFile, sshConfig);
		expect(mockLogger.error).toHaveBeenCalledWith(
			`Failed to read remote Codex session: ${sessionId} - read denied`,
			'[CodexSessionStorage]'
		);
	});

	it('returns empty remote messages when metadata lookup cannot match a file', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const blankFile = '~/.codex/sessions/2026/05/11/blank-lookup.jsonl';
		const mismatchFile = '~/.codex/sessions/2026/05/11/metadata-mismatch.jsonl';
		const unreadableFile = '~/.codex/sessions/2026/05/11/unreadable.jsonl';
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([
					{ name: 'blank-lookup.jsonl', isDirectory: false },
					{ name: 'metadata-mismatch.jsonl', isDirectory: false },
					{ name: 'unreadable.jsonl', isDirectory: false },
				]);
			}
			return { success: false };
		});
		mockReadFileRemote.mockImplementation(async (target: string) => {
			if (target === blankFile) return { success: true, data: '\n' };
			if (target === mismatchFile) return { success: true, data: jsonl({ id: 'other-session' }) };
			if (target === unreadableFile) return { success: false, error: 'denied' };
			return { success: false };
		});

		await expect(
			storage.readSessionMessages(projectPath, 'missing-remote-session', undefined, sshConfig)
		).resolves.toEqual({ messages: [], total: 0, hasMore: false });
	});

	it('handles remote traversal failures, thrown reads, empty files, and preview fallbacks', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const files = {
			empty: '~/.codex/sessions/2026/05/11/empty-content.jsonl',
			throwRead: '~/.codex/sessions/2026/05/11/throw-read.jsonl',
			userOnly: '~/.codex/sessions/2026/05/11/user-only.jsonl',
			responseCwd: '~/.codex/sessions/2026/05/11/response-cwd.jsonl',
			agentOnly: '~/.codex/sessions/2026/05/11/agent-only.jsonl',
		};
		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') {
				return remoteDir([
					{ name: '2025', isDirectory: true },
					{ name: '2026', isDirectory: true },
				]);
			}
			if (target === '~/.codex/sessions/2025') return { success: false };
			if (target === '~/.codex/sessions/2026') {
				return remoteDir([
					{ name: '04', isDirectory: true },
					{ name: '05', isDirectory: true },
				]);
			}
			if (target === '~/.codex/sessions/2026/04') return { success: false };
			if (target === '~/.codex/sessions/2026/05') {
				return remoteDir([
					{ name: '11', isDirectory: true },
					{ name: '12', isDirectory: true },
				]);
			}
			if (target === '~/.codex/sessions/2026/05/12') return { success: false };
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([
					{ name: 'empty-content.jsonl', isDirectory: false },
					{ name: 'throw-read.jsonl', isDirectory: false },
					{ name: 'user-only.jsonl', isDirectory: false },
					{ name: 'response-cwd.jsonl', isDirectory: false },
					{ name: 'agent-only.jsonl', isDirectory: false },
				]);
			}
			return { success: false };
		});
		mockStatRemote.mockImplementation(async (target: string) => ({
			success: true,
			data: {
				size: target === files.empty ? 1 : 512,
				mtime: new Date(
					target === files.agentOnly ? '2026-05-11T12:00:00.000Z' : '2026-05-11T11:00:00.000Z'
				).getTime(),
			},
		}));
		mockReadFileRemote.mockImplementation(async (target: string) => {
			if (target === files.throwRead) throw new Error('remote read exploded');
			if (target === files.empty) return { success: true, data: '\n' };
			if (target === files.userOnly) {
				return {
					success: true,
					data: jsonl(
						sessionMeta('remote-user-only', projectPath),
						message('user', 'Remote user preview')
					),
				};
			}
			if (target === files.responseCwd) {
				return {
					success: true,
					data: jsonl(
						{ id: 'remote-response-cwd', timestamp: '2026-05-11T11:00:00.000Z' },
						responseMessage('user', `<cwd>${projectPath}</cwd>`, 'remote-cwd-user'),
						responseMessage('assistant', 'Remote response assistant', 'remote-cwd-assistant')
					),
				};
			}
			if (target === files.agentOnly) {
				return {
					success: true,
					data: jsonl(sessionMeta('remote-agent-only', projectPath), {
						type: 'item.completed',
						timestamp: '2026-05-11T09:59:00.000Z',
						item: { type: 'agent_message', text: 'Remote agent preview' },
					}),
				};
			}
			return { success: false };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions.map((session) => session.sessionId)).toEqual([
			'remote-agent-only',
			'remote-user-only',
			'remote-response-cwd',
		]);
		expect(sessions.map((session) => session.firstMessage)).toEqual([
			'Remote agent preview',
			'Remote user preview',
			'Remote response assistant',
		]);
		expect(sessions[0].timestamp).toBe('2026-05-11T09:59:00.000Z');
		expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'codexStorage:readRemoteSessionFile',
			filePath: files.throwRead,
		});
	});

	it('returns empty messages and searchable results for parser and read failures', async () => {
		const searchableStorage = new TestableCodexSessionStorage();
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(sessionMeta(), message('user', 'Search me')),
		});
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === cachePath) throw new Error('no cache');
			if (target === sessionFilePath) return null as unknown as string;
			throw new Error(`missing read ${target}`);
		});

		await expect(storage.readSessionMessages(projectPath, sessionId)).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
		expect(mockCaptureException).toHaveBeenCalledWith(expect.any(TypeError), {
			operation: 'codexStorage:readSessionMessages',
			sessionId,
		});

		vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('search read failed'));
		await expect(
			searchableStorage.readSearchableMessagesForTest(sessionId, projectPath)
		).resolves.toEqual([]);

		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mockReadDirRemote.mockResolvedValueOnce({ success: false });
		await expect(
			searchableStorage.readSearchableMessagesForTest(sessionId, projectPath, sshConfig)
		).resolves.toEqual([]);

		mockReadDirRemote.mockImplementation(async (target: string) => {
			if (target === '~/.codex/sessions') return remoteDir([{ name: '2026', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026')
				return remoteDir([{ name: '05', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05')
				return remoteDir([{ name: '11', isDirectory: true }]);
			if (target === '~/.codex/sessions/2026/05/11') {
				return remoteDir([{ name: sessionFileName, isDirectory: false }]);
			}
			return { success: false };
		});
		mockReadFileRemote.mockResolvedValue({ success: false, error: 'remote search read failed' });
		await expect(
			searchableStorage.readSearchableMessagesForTest(sessionId, projectPath, sshConfig)
		).resolves.toEqual([]);
	});

	it('returns delete errors when local session writes fail', async () => {
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(sessionMeta(), message('user', 'Delete me')),
		});
		vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('readonly filesystem'));

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-0');

		expect(result).toEqual({
			success: false,
			error: 'Error: readonly filesystem',
		});
		expect(mockLogger.error).toHaveBeenCalledWith(
			'Error deleting message pair from Codex session',
			'[CodexSessionStorage]',
			expect.objectContaining({
				sessionId,
				error: expect.any(Error),
			})
		);
		expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'codexStorage:deleteMessagePair',
			sessionId,
		});
	});

	it('preserves malformed lines and removes tool results that reference deleted tool-call ids', async () => {
		setupLocalSessionTree({
			[sessionFilePath]: jsonl(
				'{malformed',
				message('user', 'Delete malformed-adjacent turn'),
				{
					type: 'item.completed',
					item: { type: 'tool_call', id: 'tool-1', tool: 'shell', args: { cmd: 'pwd' } },
				},
				message('user', 'Keep next turn'),
				{
					type: 'item.completed',
					item: { type: 'tool_result', id: 'tool-1', output: 'orphaned result' },
				},
				message('assistant', 'Keep assistant')
			),
		});

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-0');
		const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;

		expect(result).toEqual({ success: true, linesRemoved: 3 });
		expect(written.trim().split('\n')).toEqual([
			'{malformed',
			JSON.stringify(message('user', 'Keep next turn')),
			JSON.stringify(message('assistant', 'Keep assistant')),
		]);
	});

	it('returns empty results for missing local or remote session files', async () => {
		setupLocalSessionTree({});
		mockReadDirRemote.mockResolvedValue({ success: false });

		await expect(storage.readSessionMessages(projectPath, sessionId)).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
		await expect(
			storage.readSessionMessages(projectPath, sessionId, undefined, {
				id: 'remote-1',
			} as SshRemoteConfig)
		).resolves.toEqual({ messages: [], total: 0, hasMore: false });
		await expect(storage.deleteMessagePair(projectPath, sessionId, 'codex-msg-1')).resolves.toEqual(
			{
				success: false,
				error: 'Session file not found',
			}
		);
	});
});
