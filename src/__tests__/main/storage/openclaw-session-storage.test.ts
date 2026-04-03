import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readDirRemote, readFileRemote, statRemote } from '../../../main/utils/remote-fs';
import type { SshRemoteConfig } from '../../../shared/types';
import {
	createOpenClawSessionJsonl,
	OPENCLAW_FIXTURE_AGENT_NAME,
	OPENCLAW_FIXTURE_ASSISTANT_MESSAGE,
	OPENCLAW_FIXTURE_CANONICAL_SESSION_ID,
	OPENCLAW_FIXTURE_PROJECT_PATH,
	OPENCLAW_FIXTURE_RAW_SESSION_ID,
	OPENCLAW_FIXTURE_USER_MESSAGE,
} from '../../fixtures/openclaw';

type OpenClawSessionStorageModule = typeof import('../../../main/storage/openclaw-session-storage');

vi.mock('../../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	statRemote: vi.fn(),
}));

const RAW_SESSION_ID = OPENCLAW_FIXTURE_RAW_SESSION_ID;
const CANONICAL_SESSION_ID = OPENCLAW_FIXTURE_CANONICAL_SESSION_ID;
const PROJECT_PATH = OPENCLAW_FIXTURE_PROJECT_PATH;
const SESSION_MESSAGE_FILE_CONTENT = createOpenClawSessionJsonl();
const REMOTE_SSH_CONFIG: SshRemoteConfig = {
	enabled: true,
	remoteId: 'openclaw-remote',
	host: 'dev.example.com',
	user: 'hayashi',
};

describe('OpenClawSessionStorage', () => {
	let StorageCtor: OpenClawSessionStorageModule['OpenClawSessionStorage'];
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-openclaw-storage-'));
		process.env.HOME = tempHome;
		vi.clearAllMocks();

		vi.resetModules();
		({ OpenClawSessionStorage: StorageCtor } =
			await import('../../../main/storage/openclaw-session-storage'));

		await fs.mkdir(path.join(tempHome, '.openclaw', '.openclaw', 'agents', 'main', 'sessions'), {
			recursive: true,
		});

		await fs.writeFile(
			path.join(
				tempHome,
				'.openclaw',
				'.openclaw',
				'agents',
				'main',
				'sessions',
				`${RAW_SESSION_ID}.jsonl`
			),
			SESSION_MESSAGE_FILE_CONTENT
		);
	});

	afterEach(async () => {
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		} else {
			delete process.env.HOME;
		}

		await fs.rm(tempHome, { recursive: true, force: true });
		vi.resetModules();
	});

	it('resolves canonical composite IDs to a local session path', () => {
		const storage = new StorageCtor();
		const sessionPath = storage.getSessionPath(PROJECT_PATH, CANONICAL_SESSION_ID);

		expect(sessionPath).toContain(
			path.join(
				tempHome,
				'.openclaw',
				'.openclaw',
				'agents',
				'main',
				'sessions',
				`${RAW_SESSION_ID}.jsonl`
			)
		);
	});

	it('rejects raw non-canonical IDs for filesystem lookup', () => {
		const storage = new StorageCtor();
		const sessionPath = storage.getSessionPath(PROJECT_PATH, RAW_SESSION_ID);

		expect(sessionPath).toBeNull();
	});

	it('lists OpenClaw sessions using canonical session IDs', async () => {
		const storage = new StorageCtor();
		const sessions = await storage.listSessions(PROJECT_PATH);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: CANONICAL_SESSION_ID,
			projectPath: PROJECT_PATH,
			messageCount: 2,
			firstMessage: OPENCLAW_FIXTURE_USER_MESSAGE,
		});
	});

	it('accepts already canonical init IDs when listing sessions', async () => {
		await fs.writeFile(
			path.join(
				tempHome,
				'.openclaw',
				'.openclaw',
				'agents',
				'main',
				'sessions',
				`${RAW_SESSION_ID}.jsonl`
			),
			SESSION_MESSAGE_FILE_CONTENT.replace(
				`"id":"${RAW_SESSION_ID}"`,
				`"id":"${CANONICAL_SESSION_ID}"`
			)
		);

		const storage = new StorageCtor();
		const sessions = await storage.listSessions(PROJECT_PATH);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sessionId).toBe(CANONICAL_SESSION_ID);
	});

	it('falls back to the filename when the session init ID is blank', async () => {
		await fs.writeFile(
			path.join(tempHome, '.openclaw', '.openclaw', 'agents', 'main', 'sessions', 'blank-id.jsonl'),
			createOpenClawSessionJsonl({ initSessionId: '   ' })
		);

		const storage = new StorageCtor();
		const sessions = await storage.listSessions(PROJECT_PATH);
		const blankSession = sessions.find((session) => session.sessionId === 'main:blank-id');

		expect(blankSession).toBeDefined();
	});

	it('matches Windows-style OpenClaw project paths without local path resolution', async () => {
		const windowsProjectPath = 'C:\\Users\\shunsukehayashi\\dev\\Maestro';
		const windowsRawSessionId = 'windows-uuid';
		await fs.writeFile(
			path.join(
				tempHome,
				'.openclaw',
				'.openclaw',
				'agents',
				'main',
				'sessions',
				`${windowsRawSessionId}.jsonl`
			),
			createOpenClawSessionJsonl({
				rawSessionId: windowsRawSessionId,
				initSessionId: windowsRawSessionId,
				projectPath: windowsProjectPath,
			})
		);

		const storage = new StorageCtor();
		const sessions = await storage.listSessions(windowsProjectPath);
		const windowsSession = sessions.find(
			(session) => session.sessionId === `main:${windowsRawSessionId}`
		);

		expect(windowsSession).toMatchObject({
			projectPath: 'c:/users/shunsukehayashi/dev/maestro',
			sessionId: `main:${windowsRawSessionId}`,
		});
	});

	it('reads OpenClaw session messages from canonical session IDs', async () => {
		const storage = new StorageCtor();
		const result = await storage.readSessionMessages(PROJECT_PATH, CANONICAL_SESSION_ID);

		expect(result.total).toBe(2);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toMatchObject({
			type: 'user',
			role: 'user',
			content: OPENCLAW_FIXTURE_USER_MESSAGE,
		});
		expect(result.messages[1]).toMatchObject({
			type: 'assistant',
			role: 'assistant',
			content: OPENCLAW_FIXTURE_ASSISTANT_MESSAGE,
		});
	});

	it('lists OpenClaw sessions via SSH using remote storage paths', async () => {
		vi.mocked(readDirRemote)
			.mockResolvedValueOnce({
				success: true,
				data: [{ name: 'main', isDirectory: true }],
			})
			.mockResolvedValueOnce({
				success: true,
				data: [{ name: `${RAW_SESSION_ID}.jsonl`, isDirectory: false }],
			});
		vi.mocked(statRemote).mockResolvedValue({
			success: true,
			data: {
				size: SESSION_MESSAGE_FILE_CONTENT.length,
				mtime: new Date('2026-04-01T10:00:02.000Z').getTime(),
				isDirectory: false,
			},
		});
		vi.mocked(readFileRemote).mockResolvedValue({
			success: true,
			data: SESSION_MESSAGE_FILE_CONTENT,
		});

		const storage = new StorageCtor();
		const sessions = await storage.listSessions(PROJECT_PATH, REMOTE_SSH_CONFIG);

		expect(readDirRemote).toHaveBeenNthCalledWith(
			1,
			'~/.openclaw/.openclaw/agents',
			REMOTE_SSH_CONFIG
		);
		expect(readDirRemote).toHaveBeenNthCalledWith(
			2,
			'~/.openclaw/.openclaw/agents/main/sessions',
			REMOTE_SSH_CONFIG
		);
		expect(statRemote).toHaveBeenCalledWith(
			'~/.openclaw/.openclaw/agents/main/sessions/1234-uuid.jsonl',
			REMOTE_SSH_CONFIG
		);
		expect(readFileRemote).toHaveBeenCalledWith(
			'~/.openclaw/.openclaw/agents/main/sessions/1234-uuid.jsonl',
			REMOTE_SSH_CONFIG
		);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: CANONICAL_SESSION_ID,
			projectPath: PROJECT_PATH,
			firstMessage: OPENCLAW_FIXTURE_USER_MESSAGE,
		});
	});

	it('reads OpenClaw session messages over SSH from canonical session IDs', async () => {
		vi.mocked(readFileRemote).mockResolvedValue({
			success: true,
			data: SESSION_MESSAGE_FILE_CONTENT,
		});

		const storage = new StorageCtor();
		const result = await storage.readSessionMessages(
			PROJECT_PATH,
			CANONICAL_SESSION_ID,
			undefined,
			REMOTE_SSH_CONFIG
		);

		expect(readFileRemote).toHaveBeenCalledWith(
			'~/.openclaw/.openclaw/agents/main/sessions/1234-uuid.jsonl',
			REMOTE_SSH_CONFIG
		);
		expect(result.total).toBe(2);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toMatchObject({
			type: 'user',
			content: OPENCLAW_FIXTURE_USER_MESSAGE,
		});
		expect(storage.getSessionPath(PROJECT_PATH, CANONICAL_SESSION_ID, REMOTE_SSH_CONFIG)).toBe(
			'~/.openclaw/.openclaw/agents/main/sessions/1234-uuid.jsonl'
		);
	});

	it('supports alternate agent names through the shared fixture builder', async () => {
		const agentName = 'planner';
		const rawSessionId = 'planner-uuid';
		await fs.mkdir(path.join(tempHome, '.openclaw', '.openclaw', 'agents', agentName, 'sessions'), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(
				tempHome,
				'.openclaw',
				'.openclaw',
				'agents',
				agentName,
				'sessions',
				`${rawSessionId}.jsonl`
			),
			createOpenClawSessionJsonl({
				agentName,
				rawSessionId,
				initSessionId: rawSessionId,
			})
		);

		const storage = new StorageCtor();
		const sessions = await storage.listSessions(PROJECT_PATH);

		expect(sessions.some((session) => session.sessionId === `${agentName}:${rawSessionId}`)).toBe(
			true
		);
		expect(OPENCLAW_FIXTURE_AGENT_NAME).toBe('main');
	});
});
