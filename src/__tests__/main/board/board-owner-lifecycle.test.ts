import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { snapshotSqlite } from '../../helpers/sqliteSnapshot';
import {
	BoardRuntime,
	boardRuntimeProcessIdentity,
	type BoardRuntimeLock,
} from '../../../main/board/board-runtime';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import { openBoardDb } from '../../../main/board/board-db';
import { configureBoardFeatures } from '../../../main/board/board-feature';
import { boardOwnerLiveness } from '../../../main/board/board-owner-liveness';
import {
	acquireCueEngineLock,
	readCueEngineLock,
	isCueEngineLockOwnedByThisProcess,
	releaseCueEngineLock,
	__setCueEngineLockTestHook,
} from '../../../main/cue/cue-engine-lock';
import { canonicalJson } from '../../../shared/canonicalJson';
const fixture = createBoardIsolationFixture();
let storage: BoardStorageFacade, lock: BoardRuntimeLock, deadPid: number, old: string;
const runtime = () =>
	new BoardRuntime(
		storage,
		lock,
		() => ({}) as never,
		{} as never,
		(identity) => boardOwnerLiveness(identity)
	);
beforeAll(async () => {
	fixture.install();
	const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
	deadPid = child.pid!;
	await once(child, 'exit');
});
beforeEach(() => {
	configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
	storage = new BoardStorageFacade(openBoardDb(fixture.env.BOARD_DB_PATH!));
	expect(acquireCueEngineLock('desktop').acquired).toBe(true);
	const held = readCueEngineLock()!;
	lock = {
		info: {
			...held,
			mode: 'desktop',
			platform: process.platform,
			...(process.platform === 'linux' ? {} : { hostIdentity: 'trusted-native-host-fixture' }),
		},
		verify: () => {
			const current = readCueEngineLock();
			return current && isCueEngineLockOwnedByThisProcess(current) && current.token === held.token
				? { ok: true }
				: { ok: false, reason: 'owner-conflict' };
		},
	};
	const startedAt = new Date(Date.parse(held.startedAt) - 250).toISOString();
	old = JSON.stringify({ bootTime: held.bootTime, pid: deadPid, startedAt });
	storage.db
		.prepare('INSERT INTO runtime_owner VALUES (1,?,?,?)')
		.run(old, 5, Date.parse(startedAt) + 1);
	const board = storage.ensureGlobalBoard();
	for (let i = 0; i < 16; i++)
		storage.db.prepare('INSERT INTO cards VALUES (?,?,?,?)').run(
			board.storage!.collectionKey,
			`issue-${i}`,
			canonicalJson({
				id: `issue-${i}`,
				title: 'Owned analysis',
				description: 'Stop for human decision',
				status: i < 3 ? 'todo' : 'triage',
				parents: [],
				createdAt: startedAt,
				updatedAt: startedAt,
			}),
			40
		);
});
afterEach(() => {
	__setCueEngineLockTestHook(undefined);
	vi.restoreAllMocks();
	releaseCueEngineLock();
	storage.db.close();
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(fixture.contract.db + suffix, { force: true });
});
afterAll(() => fixture.cleanup());
it('automatically fences the idle legacy generation with the real native Cue lease, not a death or Human verdict', () => {
	expect(boardOwnerLiveness(old)).toBe('unknown');
	const before = snapshotSqlite(storage.db);
	expect(runtime().acquire()).toEqual({ ok: true });
	const after = snapshotSqlite(storage.db);
	for (const table of Object.keys(before))
		if (!['runtime_owner', 'commands'].includes(table)) expect(after[table]).toEqual(before[table]);
	expect(storage.db.prepare('SELECT epoch,process_identity FROM runtime_owner').get()).toEqual({
		epoch: 6,
		process_identity: boardRuntimeProcessIdentity(lock),
	});
	const receipt = storage.db.prepare('SELECT principal,result_json FROM commands').get() as {
		principal: string;
		result_json: string;
	};
	expect(receipt.principal).toBe('native-cue-host');
	expect(JSON.parse(receipt.result_json)).toMatchObject({
		oldOwner: { process_identity: old, epoch: 5 },
		newEpoch: 6,
	});
	expect(runtime().acquire()).toEqual({ ok: true });
	expect(storage.db.prepare('SELECT count(*) AS n FROM commands').get()).toEqual({ n: 1 });
});
it('acquires a fresh owner normally and requires no extra permission', () => {
	storage.db.prepare('DELETE FROM runtime_owner').run();
	expect(runtime().acquire()).toEqual({ ok: true });
	expect(storage.db.prepare('SELECT epoch FROM runtime_owner').get()).toEqual({ epoch: 1 });
});
it.each([
	'modern-unknown',
	'alive-legacy',
	'foreign-namespace',
	'corrupt',
	'other-boot',
	'unknown-card-attempt',
	'migration-hold',
	'running-card',
])('refuses %s without changing any table', (kind) => {
	let identity = JSON.parse(old);
	if (kind === 'modern-unknown') identity.token = 'different-modern-token';
	if (kind === 'alive-legacy') identity.pid = process.ppid;
	if (kind === 'foreign-namespace')
		identity = { ...identity, token: 'foreign-token', pidNsInode: (lock.info.pidNsInode ?? 0) + 1 };
	if (kind === 'other-boot') identity.bootTime -= 120000;
	storage.db
		.prepare('UPDATE runtime_owner SET process_identity=?')
		.run(kind === 'corrupt' ? '{' : JSON.stringify(identity));
	if (kind === 'unknown-card-attempt')
		storage.db
			.prepare(
				"UPDATE cards SET payload_json=json_set(payload_json,'$.runs',json('[{}]')) WHERE id='issue-0'"
			)
			.run();
	if (kind === 'migration-hold')
		storage.db.prepare('INSERT INTO migration_worker_holds VALUES (?,?)').run('uncertain', '[]');
	if (kind === 'running-card')
		storage.db
			.prepare(
				"UPDATE cards SET payload_json=json_set(payload_json,'$.status','running') WHERE id='issue-0'"
			)
			.run();
	const before = snapshotSqlite(storage.db);
	expect(runtime().acquire().ok).toBe(false);
	expect(snapshotSqlite(storage.db)).toEqual(before);
});
it.each(['run', 'reservation'])(
	'retains a real persisted %s instead of granting idle handover',
	(kind) => {
		const key = storage.db.prepare('SELECT collection_key,id FROM cards LIMIT 1').get() as {
			collection_key: string;
			id: string;
		};
		storage.db
			.prepare(
				'INSERT INTO runs (run_id,collection_key,card_id,attempt,specification_json) VALUES (?,?,?,?,?)'
			)
			.run('old-attempt', key.collection_key, key.id, 1, '{}');
		if (kind === 'reservation') {
			storage.db.prepare('INSERT INTO workers VALUES (?,1,0,?)').run('held', '{}');
			storage.db
				.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?)')
				.run('held', key.collection_key, key.id, 'old-attempt', 5, 1, 'uncertain');
		}
		const before = snapshotSqlite(storage.db);
		expect(runtime().acquire().ok).toBe(false);
		expect(snapshotSqlite(storage.db)).toEqual(before);
	}
);
it('rechecks an epoch/capacity change at the real native generation boundary', () => {
	__setCueEngineLockTestHook((point) => {
		if (point === 'afterClaim')
			storage.db
				.prepare('INSERT INTO migration_worker_holds VALUES (?,?)')
				.run('racing-hold', '[]');
	});
	const before = snapshotSqlite(storage.db);
	expect(runtime().acquire().ok).toBe(false);
	const after = snapshotSqlite(storage.db);
	expect(after.runtime_owner).toEqual(before.runtime_owner);
	expect(after.commands).toEqual(before.commands);
	expect(after.migration_worker_holds.count).toBe(1);
});
it('rolls back owner handover when the durable handover receipt fails', () => {
	storage.db.exec(
		"CREATE TRIGGER refuse_receipt BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'owned receipt error'); END"
	);
	const before = snapshotSqlite(storage.db);
	expect(() => runtime().acquire()).toThrow('owned receipt error');
	expect(snapshotSqlite(storage.db)).toEqual(before);
});
it('does not infer native ownership after the Cue lock is released', () => {
	releaseCueEngineLock();
	const before = snapshotSqlite(storage.db);
	expect(runtime().acquire().ok).toBe(false);
	expect(snapshotSqlite(storage.db)).toEqual(before);
});
it.each([
	{ board: false, maestroCue: false },
	{ board: false, maestroCue: true },
	{ board: true, maestroCue: false },
])('does no owner work while gates are off %j', (gates) => {
	configureBoardFeatures({ get: () => gates });
	const before = snapshotSqlite(storage.db);
	expect(runtime().acquire()).toEqual({ ok: false, reason: 'runtime-unavailable' });
	expect(snapshotSqlite(storage.db)).toEqual(before);
});
