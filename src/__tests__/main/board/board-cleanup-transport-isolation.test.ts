import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { openBoardDb } from '../../../main/board/board-db';
import {
	readBoardIsolationRegistries,
	requireBoardIsolation,
} from '../../../main/board/board-isolation';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade, configureBoardStorage } from '../../../main/board/board-storage';
import { handleBoardCommand } from '../../../main/web-server/handlers/messageHandlers/board';

vi.mock('../../../main/stores/getters', () => ({ getLiveSessions: () => [] }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const fixture = createBoardIsolationFixture();
const contract = fixture.contract;
let db: ReturnType<typeof openBoardDb>;
let scratch: string;
let sourceKey: string;

beforeAll(() => {
	fixture.install();
	requireBoardIsolation({ expected: contract });
	readBoardIsolationRegistries(contract);
});
afterAll(() => fixture.cleanup());
beforeEach(() => {
	for (const suffix of ['', '-wal', '-shm'])
		if (fs.existsSync(contract.db + suffix)) throw new Error('Fixture database must be fresh');
	fs.mkdirSync(path.dirname(contract.db), { recursive: true });
	scratch = fs.mkdtempSync(path.join(contract.root, 'cleanup-transport-'));
	db = openBoardDb(contract.db);
	configureBoardStorage(new BoardStorageFacade(db));
	const plan = planBoardMigration({
		source: { location: { kind: 'local' }, path: scratch },
		repository: null,
		boardBytes: Buffer.from(JSON.stringify({ boards: [{ id: 'b', name: 'Fixture', cards: [] }] })),
		profileBytes: null,
		workers: [],
	});
	applyBoardMigration(db, plan);
	sourceKey = plan.sourceKey;
});
afterEach(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(contract.db + suffix, { force: true });
	fs.rmSync(scratch, { recursive: true, force: true });
});

async function request(
	message: Record<string, unknown>,
	authorized = true,
	cli = true
): Promise<any> {
	let reply: any;
	const ctx = {
		send: (_client: unknown, value: unknown) => {
			reply = value;
		},
		reportHandlerError: () => {
			throw new Error('unexpected handler failure');
		},
	};
	await handleBoardCommand(
		ctx as never,
		{ isAuthorized: () => authorized, cli } as never,
		{ type: 'board_command', requestId: 'fixture', ...message } as never
	);
	return reply;
}

describe('isolated source cleanup host transport', () => {
	it('rejects unauthorized, non-CLI and malformed requests before mutation', async () => {
		const command = { action: 'source-preview', sourceKey };
		expect(await request(command, false)).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
		expect(await request(command, true, false)).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
		expect(await request({ ...command, human: true })).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(await request({ ...command, sourceKey: 'bad' })).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(db.prepare('SELECT * FROM board_source_suppressions').all()).toEqual([]);
	});
	it('routes exact preview, export, guarded suppression and restore through the host', async () => {
		const preview = await request({ action: 'source-preview', sourceKey });
		expect(preview.ok).toBe(true);
		const backupPath = path.join(scratch, 'backup.json');
		const revision = preview.value.revision;
		expect(
			await request({
				action: 'source-export',
				sourceKey,
				backupPath,
				expectedRevision: revision + 1,
			})
		).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(fs.existsSync(backupPath)).toBe(false);
		const exported = await request({
			action: 'source-export',
			sourceKey,
			backupPath,
			expectedRevision: revision,
		});
		expect(exported.ok).toBe(true);
		expect(
			await request({
				action: 'source-suppress',
				sourceKey,
				backupPath,
				expectedRevision: revision,
				backupSha256: '0'.repeat(64),
			})
		).toMatchObject({ ok: false });
		const suppressed = await request({
			action: 'source-suppress',
			sourceKey,
			backupPath,
			expectedRevision: revision,
			backupSha256: exported.value.sha256,
		});
		expect(suppressed.ok).toBe(true);
		expect((await request({ action: 'source-preview', sourceKey })).value.suppressed).toBe(true);
		expect(
			await request({ action: 'source-restore', backupPath, receipt: suppressed.value })
		).toMatchObject({ ok: true });
		expect((await request({ action: 'source-preview', sourceKey })).value.suppressed).toBe(false);
	});
});
