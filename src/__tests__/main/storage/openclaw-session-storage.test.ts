import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

type OpenClawSessionStorageModule = typeof import('../../../main/storage/openclaw-session-storage');

const RAW_SESSION_ID = '1234-uuid';
const CANONICAL_SESSION_ID = `main:${RAW_SESSION_ID}`;
const PROJECT_PATH = '/tmp/openclaw-regression-project';

const SESSION_MESSAGE_FILE_CONTENT = `
${JSON.stringify({
	type: 'session',
	version: 3,
	id: RAW_SESSION_ID,
	timestamp: '2026-04-01T10:00:00.000Z',
	cwd: PROJECT_PATH,
})}
${JSON.stringify({
	type: 'message',
	id: 'msg-1',
	parentId: 'parent-1',
	timestamp: '2026-04-01T10:00:01.000Z',
	message: {
		role: 'user',
		content: [{ type: 'text', text: 'First message for OpenClaw' }],
	},
})}
${JSON.stringify({
	type: 'message',
	id: 'msg-2',
	parentId: 'msg-1',
	timestamp: '2026-04-01T10:00:02.000Z',
	message: {
		role: 'assistant',
		content: [{ type: 'text', text: 'Reply from OpenClaw' }],
	},
})}
`;

describe('OpenClawSessionStorage', () => {
	let StorageCtor: OpenClawSessionStorageModule['OpenClawSessionStorage'];
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-openclaw-storage-'));
		process.env.HOME = tempHome;

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
			firstMessage: 'First message for OpenClaw',
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
			content: 'First message for OpenClaw',
		});
		expect(result.messages[1]).toMatchObject({
			type: 'assistant',
			role: 'assistant',
			content: 'Reply from OpenClaw',
		});
	});
});
