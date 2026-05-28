import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FactoryDroidSessionStorage } from '../../main/storage/factory-droid-session-storage';
import type { SshRemoteConfig } from '../../shared/types';

const mocks = vi.hoisted(() => ({
	homeDir: '',
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
	captureException: vi.fn(),
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	statRemote: vi.fn(),
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => mocks.homeDir),
	},
	homedir: vi.fn(() => mocks.homeDir),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: mocks.captureException,
}));

vi.mock('../../main/utils/remote-fs', () => ({
	readDirRemote: mocks.readDirRemote,
	readFileRemote: mocks.readFileRemote,
	statRemote: mocks.statRemote,
}));

const projectPath = '/repo/project';
const encodedProjectPath = '-repo-project';
const sessionId = 'factory-1';

function factoryMessage(
	id: string,
	role: 'user' | 'assistant',
	timestamp: string,
	content: unknown
) {
	return {
		type: 'message',
		id,
		timestamp,
		message: {
			role,
			content,
		},
	};
}

function jsonl(...entries: Array<Record<string, unknown> | string>): string {
	return entries
		.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
		.join('\n');
}

describe('FactoryDroidSessionStorage integration', () => {
	let tempRoot: string;
	let storage: FactoryDroidSessionStorage;

	function projectDir() {
		return path.join(mocks.homeDir, '.factory', 'sessions', encodedProjectPath);
	}

	function sessionPath(id = sessionId) {
		return path.join(projectDir(), `${id}.jsonl`);
	}

	async function writeFile(filePath: string, content: string) {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, 'utf-8');
	}

	async function writeJson(filePath: string, value: unknown) {
		await writeFile(filePath, JSON.stringify(value), 'utf-8');
	}

	beforeEach(() => {
		vi.clearAllMocks();
		tempRoot = fsSync.mkdtempSync(
			path.join(process.env.TMPDIR || '/tmp', 'maestro-factory-droid-integration-')
		);
		mocks.homeDir = path.join(tempRoot, 'home');
		fsSync.mkdirSync(mocks.homeDir, { recursive: true });
		storage = new FactoryDroidSessionStorage();
	});

	afterEach(() => {
		fsSync.rmSync(tempRoot, { recursive: true, force: true });
	});

	it('lists local Factory Droid sessions with real JSONL files, settings, fallbacks, and pagination', async () => {
		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			`No Factory Droid sessions directory for project: ${projectPath}`,
			'[FactoryDroidSessionStorage]'
		);

		await writeFile(
			sessionPath(),
			jsonl(
				factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', [
					{ type: 'thinking', thinking: 'internal' },
					{ type: 'text', text: 'Build the Factory flow' },
				]),
				'{bad-json',
				factoryMessage('a-1', 'assistant', '2026-05-11T10:03:00.000Z', [
					{ type: 'text', text: 'Factory flow is ready' },
				])
			)
		);
		await writeJson(path.join(projectDir(), `${sessionId}.settings.json`), {
			assistantActiveTimeMs: 1250,
			tokenUsage: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 3,
				cacheCreationTokens: 4,
			},
		});
		await writeFile(
			sessionPath('factory-older'),
			jsonl(
				factoryMessage('u-old', 'user', '2026-05-10T09:00:00.000Z', 'Older prompt'),
				factoryMessage('a-old', 'assistant', '2026-05-10T09:02:30.000Z', 'Older reply')
			)
		);
		await writeFile(path.join(projectDir(), 'notes.txt'), 'not a session');

		const sessions = await storage.listSessions(projectPath);
		const page = await storage.listSessionsPaginated(projectPath, { limit: 1 });

		expect(sessions.map((session) => session.sessionId)).toEqual([sessionId, 'factory-older']);
		expect(sessions[0]).toMatchObject({
			projectPath,
			firstMessage: 'Build the Factory flow',
			messageCount: 2,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 3,
			cacheCreationTokens: 4,
			durationSeconds: 1,
			timestamp: '2026-05-11T10:01:00.000Z',
			modifiedAt: '2026-05-11T10:03:00.000Z',
		});
		expect(sessions[1]).toMatchObject({
			firstMessage: 'Older prompt',
			messageCount: 2,
			durationSeconds: 150,
		});
		expect(page).toMatchObject({
			sessions: [expect.objectContaining({ sessionId })],
			hasMore: true,
			totalCount: 2,
			nextCursor: sessionId,
		});
	});

	it('reads, searches, paths, and deletes local message pairs from real JSONL files', async () => {
		await writeFile(
			sessionPath(),
			jsonl(
				factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', 'Delete this prompt'),
				factoryMessage('a-1', 'assistant', '2026-05-11T10:02:00.000Z', [
					{ type: 'text', text: 'Added focused tests' },
					{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { cmd: 'npm test' } },
					{ type: 'tool_result', tool_use_id: 'tool-1', content: 'passed' },
				]),
				'{bad-json',
				factoryMessage('u-2', 'user', '2026-05-11T10:04:00.000Z', 'Keep this prompt'),
				factoryMessage('a-2', 'assistant', '2026-05-11T10:05:00.000Z', 'Keep this reply')
			)
		);

		const messages = await storage.readSessionMessages(projectPath, sessionId, { limit: 1 });
		const searchResults = await storage.searchSessions(projectPath, 'focused tests', 'assistant');
		const deleteResult = await storage.deleteMessagePair(projectPath, sessionId, 'u-1');
		const remaining = await fs.readFile(sessionPath(), 'utf-8');

		expect(storage.getSessionPath(projectPath, sessionId)).toBe(sessionPath());
		expect(messages).toMatchObject({
			total: 4,
			hasMore: true,
			messages: [
				expect.objectContaining({
					type: 'assistant',
					role: 'assistant',
					content: 'Keep this reply',
					uuid: 'a-2',
				}),
			],
		});
		expect(searchResults).toEqual([
			expect.objectContaining({
				sessionId,
				matchType: 'assistant',
				matchCount: 1,
				matchPreview: 'Added focused tests',
			}),
		]);
		expect(deleteResult).toEqual({ success: true, linesRemoved: 2 });
		expect(remaining).not.toContain('Delete this prompt');
		expect(remaining).not.toContain('Added focused tests');
		expect(remaining).toContain('{bad-json');
		expect(remaining).toContain('Keep this prompt');
	});

	it('uses mocked remote filesystem boundaries for SSH listing, reads, paths, and unsupported deletes', async () => {
		const sshConfig: SshRemoteConfig = {
			host: 'remote.example.com',
			username: 'octavia',
		};
		const remoteProjectPath = '/remote/repo';
		const remoteDir = '~/.factory/sessions/-remote-repo';
		const remoteSessionPath = `${remoteDir}/${sessionId}.jsonl`;
		const remoteSettingsPath = `${remoteDir}/${sessionId}.settings.json`;
		const remoteJsonl = jsonl(
			factoryMessage('ru-1', 'user', '2026-05-12T10:00:00.000Z', 'Remote prompt'),
			factoryMessage('ra-1', 'assistant', '2026-05-12T10:01:00.000Z', [
				{ type: 'text', text: 'Remote answer' },
			])
		);

		mocks.readDirRemote.mockResolvedValue({
			success: true,
			data: [
				{ name: `${sessionId}.jsonl`, isDirectory: false },
				{ name: `${sessionId}.settings.json`, isDirectory: false },
				{ name: 'nested', isDirectory: true },
			],
		});
		mocks.statRemote.mockResolvedValue({
			success: true,
			data: {
				size: remoteJsonl.length,
				mtime: new Date('2026-05-12T10:02:00.000Z').getTime(),
			},
		});
		mocks.readFileRemote.mockImplementation(async (filePath: string) => {
			if (filePath === remoteSessionPath) {
				return { success: true, data: remoteJsonl };
			}
			if (filePath === remoteSettingsPath) {
				return {
					success: true,
					data: JSON.stringify({
						tokenUsage: {
							inputTokens: 7,
							outputTokens: 9,
						},
					}),
				};
			}
			return { success: false, error: `missing ${filePath}` };
		});

		const sessions = await storage.listSessions(remoteProjectPath, sshConfig);
		const messages = await storage.readSessionMessages(remoteProjectPath, sessionId, {}, sshConfig);
		const deleteResult = await storage.deleteMessagePair(
			remoteProjectPath,
			sessionId,
			'ru-1',
			undefined,
			sshConfig
		);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				projectPath: remoteProjectPath,
				firstMessage: 'Remote prompt',
				messageCount: 2,
				inputTokens: 7,
				outputTokens: 9,
			}),
		]);
		expect(messages.messages.map((message) => message.content)).toEqual([
			'Remote prompt',
			'Remote answer',
		]);
		expect(storage.getSessionPath(remoteProjectPath, sessionId, sshConfig)).toBe(remoteSessionPath);
		expect(deleteResult).toEqual({
			success: false,
			error: 'Delete not supported for remote sessions',
		});
	});
});
