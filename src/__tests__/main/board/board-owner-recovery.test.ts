import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as os from 'node:os';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { snapshotSqlite } from '../../helpers/sqliteSnapshot';
import { openBoardDb } from '../../../main/board/board-db';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import { BoardOwnerRecovery } from '../../../main/board/board-owner-recovery';
import { configureBoardFeatures } from '../../../main/board/board-feature';
import {
	BoardRuntime,
	boardRuntimeProcessIdentity,
	type BoardRuntimeLock,
} from '../../../main/board/board-runtime';
import { canonicalJson } from '../../../shared/canonicalJson';

const fixture = createBoardIsolationFixture();
let storage: BoardStorageFacade;
let recovery: BoardOwnerRecovery;
let deadPid: number;
let valid = true;
let lock: BoardRuntimeLock;
let event: IpcMainInvokeEvent;
let window: BrowserWindow;
let readLock: () => Promise<BoardRuntimeLock | null>;
const boot = Date.now() - os.uptime() * 1000;
const legacyStartedAt = new Date(Date.now() - 120_000).toISOString();
const oldOwner = () => ({ pid: deadPid, bootTime: boot, startedAt: legacyStartedAt });

beforeAll(async () => {
	fixture.install();
	const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
	deadPid = child.pid!;
	await once(child, 'exit');
});
beforeEach(() => {
	configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
	valid = true;
	storage = new BoardStorageFacade(openBoardDb(fixture.env.BOARD_DB_PATH!));
	const board = storage.ensureGlobalBoard();
	for (let index = 0; index < 16; index++)
		storage.db.prepare('INSERT INTO cards VALUES (?,?,?,?)').run(
			board.storage!.collectionKey,
			`issue-${index}`,
			canonicalJson({
				id: `issue-${index}`,
				title: 'Synthetic analysis',
				description: 'Stop for human decision',
				status: index < 3 ? 'todo' : 'triage',
				parents: [],
				createdAt: legacyStartedAt,
				updatedAt: legacyStartedAt,
			}),
			40
		);
	storage.db
		.prepare('INSERT INTO runtime_owner VALUES (1,?,?,?)')
		.run(JSON.stringify(oldOwner()), 5, Date.now() - 60_000);
	lock = {
		info: {
			pid: process.pid,
			startedAt: new Date().toISOString(),
			bootTime: boot,
			token: 'trusted-current-native-fixture',
			pidNsInode: 123,
			platform: 'linux',
			mode: 'desktop',
		},
		verify: () => (valid ? { ok: true } : { ok: false, reason: 'owner-conflict' }),
	};
	const webContents = { id: 1, mainFrame: { processId: 2, routingId: 3 } };
	window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
	event = { sender: webContents, senderFrame: webContents.mainFrame } as IpcMainInvokeEvent;
	readLock = async () => lock;
	recovery = new BoardOwnerRecovery({
		storage: () => storage,
		lock: () => readLock(),
		getMainWindow: () => window,
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const table of [
		'commands',
		'runtime_owner',
		'cards',
		'collections',
		'migration_worker_holds',
		'migration_blockers',
		'migrations',
	])
		storage.db.prepare(`DELETE FROM ${table}`).run();
	storage.db.close();
});
afterAll(() => fixture.cleanup());

async function preview() {
	const result = await recovery.preview(event);
	expect(result.ok, JSON.stringify(result)).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value.previewId;
}
async function refused(id: unknown, sender = event) {
	const before = snapshotSqlite(storage.db);
	expect(await recovery.confirm(sender, id)).toMatchObject({
		ok: false,
		error: { code: 'owner-recovery-refused' },
	});
	expect(snapshotSqlite(storage.db)).toEqual(before);
}

describe('native idle legacy owner recovery', () => {
	it('keeps automatic unknown blocked, then changes only owner and an audit receipt after native confirmation', async () => {
		const runtime = new BoardRuntime(
			storage,
			lock,
			() => ({}) as never,
			{} as never,
			() => 'unknown'
		);
		expect(runtime.acquire()).toEqual({ ok: false, reason: 'owner-conflict' });
		const before = snapshotSqlite(storage.db);
		const id = await preview();
		expect(snapshotSqlite(storage.db)).toEqual(before);
		expect(runtime.acquire()).toEqual({ ok: false, reason: 'owner-conflict' });
		expect(await recovery.confirm(event, id)).toEqual({ ok: true, value: { epoch: 6 } });
		const after = snapshotSqlite(storage.db);
		for (const table of Object.keys(before))
			if (!['runtime_owner', 'commands'].includes(table))
				expect(after[table]).toEqual(before[table]);
		const owner = storage.db.prepare('SELECT * FROM runtime_owner').get();
		expect(owner).toMatchObject({ epoch: 6, process_identity: boardRuntimeProcessIdentity(lock) });
		const audit = storage.db.prepare('SELECT result_json, principal FROM commands').get() as {
			result_json: string;
			principal: string;
		};
		expect(audit.principal).toBe('native-desktop-main-frame');
		expect(JSON.parse(audit.result_json)).toMatchObject({
			oldOwner: { epoch: 5, process_identity: JSON.stringify(oldOwner()) },
			newEpoch: 6,
		});
		expect(audit.result_json).not.toContain(lock.info.token);
		expect(runtime.acquire()).toEqual({ ok: true });
		await refused(id);
	});

	it('does not request native proof when there is no stored owner', async () => {
		storage.db.prepare('DELETE FROM runtime_owner').run();
		const probe = vi.fn(async () => lock);
		readLock = probe;
		expect(await recovery.status(event)).toMatchObject({
			ok: true,
			value: { conflict: false, eligible: false },
		});
		expect(probe).not.toHaveBeenCalled();
	});
	it.each(['darwin', 'win32'] as const)(
		'keeps an already owned modern %s runtime usable without offering manual recovery',
		async (platform) => {
			lock.info.platform = platform;
			lock.info.hostIdentity = 'trusted-native-host-proof';
			storage.db
				.prepare('UPDATE runtime_owner SET process_identity=?')
				.run(boardRuntimeProcessIdentity(lock));
			expect(await recovery.status(event)).toMatchObject({
				ok: true,
				value: { conflict: false, eligible: false },
			});
			await refused('not-a-manual-platform');
		}
	);
	it.each(['secondary-frame', 'foreign-window', 'synthetic-principal'])(
		'refuses %s before consuming the native preview',
		async (kind) => {
			const id = await preview();
			const foreign =
				kind === 'secondary-frame'
					? { ...event, senderFrame: {} }
					: { sender: {}, senderFrame: {}, principal: 'native-desktop-main-frame' };
			await refused(id, foreign as IpcMainInvokeEvent);
			expect((await recovery.confirm(event, id)).ok).toBe(true);
		}
	);
	it.each([undefined, '', 'wrong-preview'])('refuses missing/wrong preview %s', async (id) => {
		await preview();
		await refused(id);
	});
	it('expires using monotonic time, and restarting the controller revokes previews', async () => {
		const id = await preview();
		vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_001);
		await refused(id);
		vi.restoreAllMocks();
		const next = await preview();
		recovery = new BoardOwnerRecovery({
			storage: () => storage,
			lock: () => readLock(),
			getMainWindow: () => window,
		});
		await refused(next);
	});

	it('revokes a preview after an off/on lifecycle transition, even when both gates are enabled again', async () => {
		const id = await preview();
		recovery.invalidatePreview();
		await refused(id);
	});
	it.each(['preview', 'confirm'])(
		'does not resurrect %s after lifecycle revocation during native proof',
		async (kind) => {
			const id = kind === 'confirm' ? await preview() : null;
			let resume!: (value: BoardRuntimeLock) => void;
			readLock = () =>
				new Promise((resolve) => {
					resume = resolve;
				});
			const pending = kind === 'confirm' ? recovery.confirm(event, id) : recovery.preview(event);
			recovery.invalidatePreview();
			const before = snapshotSqlite(storage.db);
			resume(lock);
			expect((await pending).ok).toBe(false);
			expect(snapshotSqlite(storage.db)).toEqual(before);
		}
	);
	it('consumes before await so a concurrent double click cannot authorize twice', async () => {
		const id = await preview();
		const results = await Promise.all([recovery.confirm(event, id), recovery.confirm(event, id)]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(storage.db.prepare('SELECT COUNT(*) AS n FROM commands').get()).toEqual({ n: 1 });
	});
	it.each(['owner', 'heartbeat', 'card', 'hold', 'lock', 'board', 'cue', 'identity'])(
		'rechecks %s drift after preview without partial writes',
		async (kind) => {
			const id = await preview();
			if (kind === 'owner') storage.db.prepare('UPDATE runtime_owner SET epoch=6').run();
			if (kind === 'heartbeat')
				storage.db.prepare('UPDATE runtime_owner SET heartbeat=heartbeat+1').run();
			if (kind === 'card') storage.db.prepare('UPDATE cards SET revision=revision+1').run();
			if (kind === 'hold')
				storage.db
					.prepare('INSERT INTO migration_worker_holds VALUES (?,?)')
					.run('held-worker', '[]');
			if (kind === 'lock') valid = false;
			if (kind === 'board' || kind === 'cue')
				configureBoardFeatures({
					get: () => ({ board: kind !== 'board', maestroCue: kind !== 'cue' }),
				});
			if (kind === 'identity') lock.info.token = 'another-current-token';
			await refused(id);
		}
	);
	it('rechecks a hold introduced while awaiting the current native lock', async () => {
		const id = await preview();
		let resume!: (value: BoardRuntimeLock) => void;
		readLock = () =>
			new Promise((resolve) => {
				resume = resolve;
			});
		const confirmation = recovery.confirm(event, id);
		storage.db.prepare('INSERT INTO migration_worker_holds VALUES (?,?)').run('held-worker', '[]');
		const before = snapshotSqlite(storage.db);
		resume(lock);
		expect((await confirmation).ok).toBe(false);
		expect(snapshotSqlite(storage.db)).toEqual(before);
	});
	it.each(['run', 'reservation'])('refuses a new %s introduced after preview', async (kind) => {
		const id = await preview();
		const key = storage.db.prepare('SELECT collection_key, id FROM cards LIMIT 1').get() as {
			collection_key: string;
			id: string;
		};
		storage.db
			.prepare(
				'INSERT INTO runs (run_id,collection_key,card_id,attempt,specification_json) VALUES (?,?,?,?,?)'
			)
			.run('uncertain-old-run', key.collection_key, key.id, 1, '{}');
		if (kind === 'reservation') {
			storage.db.prepare('INSERT INTO workers VALUES (?,1,0,?)').run('held-worker', '{}');
			storage.db
				.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?)')
				.run('held-worker', key.collection_key, key.id, 'uncertain-old-run', 5, 1, 'uncertain');
		}
		await refused(id);
		storage.db.prepare('DELETE FROM reservations').run();
		storage.db.prepare('DELETE FROM runs').run();
		storage.db.prepare('DELETE FROM workers').run();
	});

	it('binds the exact original identity bytes, even when a replacement parses to the same legacy fields', async () => {
		const id = await preview();
		storage.db
			.prepare('UPDATE runtime_owner SET process_identity=?')
			.run(JSON.stringify({ bootTime: boot, pid: deadPid, startedAt: legacyStartedAt }));
		const before = snapshotSqlite(storage.db);
		expect(await recovery.confirm(event, id)).toEqual({
			ok: false,
			error: {
				code: 'owner-recovery-refused',
				message: 'Owner or Board evidence changed since preview',
			},
		});
		expect(snapshotSqlite(storage.db)).toEqual(before);
	});
	it('rolls back the owner update if its durable human receipt cannot be stored', async () => {
		const id = await preview();
		storage.db.exec(
			"CREATE TRIGGER reject_receipt BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'owned receipt fault'); END"
		);
		const before = snapshotSqlite(storage.db);
		await expect(recovery.confirm(event, id)).rejects.toThrow('owned receipt fault');
		expect(snapshotSqlite(storage.db)).toEqual(before);
		storage.db.exec('DROP TRIGGER reject_receipt');
	});
	it('rejects a second preview after a different recovery controller wins the owner CAS', async () => {
		const other = new BoardOwnerRecovery({
			storage: () => storage,
			lock: () => readLock(),
			getMainWindow: () => window,
		});
		const id = await preview();
		const theirs = await other.preview(event);
		if (!theirs.ok) throw new Error(theirs.error.message);
		expect((await other.confirm(event, theirs.value.previewId)).ok).toBe(true);
		await refused(id);
		expect(storage.db.prepare('SELECT COUNT(*) AS n FROM commands').get()).toEqual({ n: 1 });
	});

	it('rolls back if the monotonic preview deadline expires before commit', async () => {
		const id = await preview();
		const now = performance.now();
		let checks = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (++checks < 3 ? now : now + 60_001));
		await refused(id);
	});
	it('rechecks the native lock inside the transaction and rolls back on loss before commit', async () => {
		const id = await preview();
		let verifications = 0;
		lock.verify = () =>
			++verifications < 3 ? { ok: true } : { ok: false, reason: 'owner-conflict' };
		await refused(id);
	});
	it.each([
		'modern',
		'corrupt',
		'alive',
		'other-boot',
		'future-start',
		'unknown-attempt',
		'migration-uncertainty',
	])('refuses %s owners/evidence at preview, preserving all tables', async (kind) => {
		let identity = JSON.stringify(oldOwner());
		if (kind === 'modern') identity = JSON.stringify({ ...oldOwner(), token: 'modern' });
		if (kind === 'corrupt') identity = '{';
		if (kind === 'alive') identity = JSON.stringify({ ...oldOwner(), pid: process.ppid });
		if (kind === 'other-boot')
			identity = JSON.stringify({ ...oldOwner(), bootTime: boot - 120_000 });
		if (kind === 'future-start')
			identity = JSON.stringify({
				...oldOwner(),
				startedAt: new Date(Date.now() + 60_000).toISOString(),
			});
		storage.db.prepare('UPDATE runtime_owner SET process_identity=?').run(identity);
		if (kind === 'unknown-attempt')
			storage.db
				.prepare(
					"UPDATE cards SET payload_json=json_set(payload_json,'$.runs',json('[{}]')) WHERE id='issue-0'"
				)
				.run();
		if (kind === 'migration-uncertainty')
			storage.db
				.prepare(
					"UPDATE cards SET payload_json=json_set(payload_json,'$.migration',json('{\"intent\":\"reconciliation-required\"}')) WHERE id='issue-0'"
				)
				.run();
		const before = snapshotSqlite(storage.db);
		expect((await recovery.preview(event)).ok).toBe(false);
		expect(snapshotSqlite(storage.db)).toEqual(before);
	});
	it('propagates unfamiliar OS errors instead of classifying absence, without mutation', async () => {
		const before = snapshotSqlite(storage.db);
		const sentinel = Object.assign(new Error('Unexpected PID probe failure'), { code: 'EIO' });
		vi.spyOn(process, 'kill').mockImplementationOnce(() => {
			throw sentinel;
		});
		await expect(recovery.preview(event)).rejects.toBe(sentinel);
		expect(snapshotSqlite(storage.db)).toEqual(before);
	});
	it.each([
		{ board: false, maestroCue: false },
		{ board: true, maestroCue: false },
		{ board: false, maestroCue: true },
	])('does no storage/lock work with off gates %j', async (gates) => {
		configureBoardFeatures({ get: () => gates });
		const storageRead = vi.fn(() => storage),
			lockRead = vi.fn(async () => lock);
		const off = new BoardOwnerRecovery({
			storage: storageRead,
			lock: lockRead,
			getMainWindow: () => window,
		});
		expect((await off.preview(event)).ok).toBe(false);
		expect((await off.status(event)).ok).toBe(false);
		expect(storageRead).not.toHaveBeenCalled();
		expect(lockRead).not.toHaveBeenCalled();
	});
});
