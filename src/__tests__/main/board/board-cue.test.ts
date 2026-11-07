import { configureBoardFeatures } from '../../../main/board/board-feature';
import { snapshotSqlite } from '../../helpers/sqliteSnapshot';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { configureIsolatedBoardSourceHost } from '../../../main/board/board-source-host';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade, configureBoardCaptureHost } from '../../../main/board/board-storage';
import {
	registerBoardWorker,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';
import {
	BoardRuntime,
	type BoardRunHooks,
	type BoardRunService,
} from '../../../main/board/board-runtime';
import type { BoardClaimHostContext } from '../../../main/board/board-claims';
import type { CardSpawnResult } from '../../../main/board/board-dispatcher';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	startBoardRunPr,
	type CardPrRequest,
	type CardPrResult,
} from '../../../main/board/board-pr';
import { BoardCueHost, type BoardPreparedContext } from '../../../main/board/board-cue';
import type { BoardTransitionReceipt } from '../../../main/board/board-transitions';
import {
	readBoardRunArtifact,
	captureBoardCardFromHost,
	prepareBoardReviewHandoff,
} from '../../../main/board/board-review';
import {
	configureBoardRuntimeHost,
	executeBoardRuntimeCommand,
} from '../../../main/board/board-runtime-host';
import { configureBoardStorage } from '../../../main/board/board-storage';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

let dir: string;
let db: ReturnType<typeof openBoardDb>;
let storage: BoardStorageFacade;
let runtime: BoardRuntime;
let cue: BoardCueHost;
let waits: { cardId: string; reason: string }[];
let changed: string[][];
let transitions: BoardTransitionReceipt[];
let roots: string[];
let host: Omit<BoardClaimHostContext, 'owner'>;
let agents: { id: string; groupId: string }[];
let service: BoardRunService;
let hooks: BoardRunHooks;
let settle: (result: CardSpawnResult) => void;
let lockValid: boolean;
let createPr: ReturnType<typeof vi.fn<(request: CardPrRequest) => Promise<CardPrResult>>>;
let completionTasks: Promise<unknown>[];
let prepare: ReturnType<
	typeof vi.fn<
		(
			key: import('../../../main/board/board-workspace-storage').BoardCardKey
		) => Promise<BoardPreparedContext>
	>
>;
const fixture = createBoardIsolationFixture();
beforeAll(() => {
	fixture.install();
	configureIsolatedBoardSourceHost(fixture.contract);
});
afterAll(async () => fixture.cleanup());

const good: CardSpawnResult = {
	artifact: {
		worktreePath: fixture.sources.one,
		branch: 'fixture',
		commit: 'a'.repeat(40),
		diff: { baseCommit: 'b'.repeat(40), sha256: 'c'.repeat(64), stat: 'fixture' },
	},
	output: '<!-- maestro:card-complete | Fixture checks passed -->',
	exitCode: 0,
	executionStarted: true,
	terminationConfirmed: true,
};

function newRuntime(
	start = 1,
	liveness: 'alive' | 'dead' | 'unknown' = 'unknown',
	facade = storage
) {
	return new BoardRuntime(
		facade,
		{
			info: { pid: 101, mode: 'desktop', bootTime: 1, startedAt: new Date(start).toISOString() },
			verify: () => (lockValid ? { ok: true } : { ok: false, reason: 'lost' }),
		},
		() => host,
		service,
		() => liveness
	);
}
beforeEach(() => {
	configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
	dir = fs.mkdtempSync(path.join(fixture.contract.root, 'cue-'));
	db = openBoardDb(fixture.contract.db);
	storage = new BoardStorageFacade(db, (root) => [root]);
	roots = [path.join(dir, 'a'), path.join(dir, 'b')];
	agents = [{ id: 'worker', groupId: 'group' }];
	configureBoardCaptureHost(() => ({ agents, groups: [{ id: 'group' }] }));
	for (let i = 0; i < roots.length; i++) {
		fs.mkdirSync(roots[i], { recursive: true });
		const key = storage.workspace.createCollection({
			sourceKey: roots[i],
			collectionKey: `collection${i}`,
			legacyBoardId: 'board',
			expectedRevision: null,
			set: {
				name: 'Board',
				maxInProgress: 2,
			},
		});
		db.prepare(
			"UPDATE collections SET payload_json=json_set(payload_json, '$.defaultStartMode', 'direct') WHERE collection_key=?"
		).run(key.collectionKey);
		db.prepare('INSERT INTO repositories VALUES (?, ?)').run(
			`repo${i}`,
			canonicalJson({ id: `repo${i}`, workingDirectory: roots[i], validated: true })
		);
		storage.capture({
			projectRoot: roots[i],
			boardId: 'board',
			expectedRevision: 0,
			card: {
				id: 'same',
				title: 'Work',
				body: 'Do it',
				parents: [],
				status: 'todo',
				createdAt: '2026-10-31',
				updatedAt: '2026-10-31',
				repositoryId: `repo${i}`,
				workingDirectory: roots[i],
				executionScope: { kind: 'group', groupId: 'group' },
			},
		});
	}
	registerBoardWorker(db, 'worker');
	setBoardWorkerAccess(db, 'worker', [], ['repo0', 'repo1']);
	host = {
		dispatchEnabled: true,
		registryRevision: 1,
		agentStates: { worker: { live: true, busy: false, location: { kind: 'local' } } },
		repository: {
			id: 'repo0',
			workingDirectory: roots[0],
			record: { id: 'repo0', workingDirectory: roots[0], validated: true },
			location: { kind: 'local' },
			identity: 'git:fixture0',
		},
	};
	service = {
		spawn: vi.fn(async (_spec, callbacks) => {
			hooks = callbacks;
			if (!hooks.beforeLaunch()) return { output: '', exitCode: null, executionStarted: false };
			hooks.onStarted(202);
			return new Promise<CardSpawnResult>((resolve) => {
				settle = resolve;
			});
		}),
		stop: vi.fn(),
		probe: vi.fn<BoardRunService['probe']>(() => 'unknown'),
	};
	lockValid = true;
	runtime = newRuntime();
	expect(runtime.acquire()).toEqual({ ok: true });
	configureBoardStorage(storage);
	waits = [];
	createPr = vi.fn(async () => ({ success: true, prUrl: 'https://example.test/pr/1' }));
	completionTasks = [];
	changed = [];
	transitions = [];
	prepare = vi.fn(async () => ({
		repository: host.repository,
		reviewArtifact: host.reviewArtifact,
	}));
	cue = new BoardCueHost({
		storage: () => storage,
		lock: () => ({
			info: { pid: 101, mode: 'desktop', bootTime: 1, startedAt: new Date(1).toISOString() },
			verify: () => (lockValid ? { ok: true } : { ok: false, reason: 'lost' }),
		}),
		context: (key) => {
			const index = key.collectionKey === 'collection0' ? 0 : 1;
			return {
				...host,
				repository: {
					id: `repo${index}`,
					workingDirectory: roots[index],
					record: { id: `repo${index}`, workingDirectory: roots[index], validated: true },
					location: { kind: 'local' },
					identity: `git:fixture${index}`,
				},
			};
		},
		prepare,
		service,
		ownerLiveness: () => 'unknown',
		onChanged: () => changed.push(storage.query().collections.map((c) => c.board.cards[0].status)),
		onCompleted: (spec) => {
			completionTasks.push(startBoardRunPr(spec, { createPr }));
		},
		onTransitions: (receipts) => transitions.push(...receipts),
		onWait: (key, reason) => waits.push({ cardId: key.cardId, reason }),
	});
	configureBoardRuntimeHost(cue.runtimeFor);
});
afterEach(() => {
	configureBoardRuntimeHost(() => null);
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(fixture.contract.db + suffix, { force: true });
	vi.restoreAllMocks();
});

function edit(set: Record<string, unknown>, index = 0) {
	const row = storage.workspace.readCollection({
		sourceKey: roots[index],
		collectionKey: `collection${index}`,
	})!.cards[0];
	db.prepare('UPDATE cards SET payload_json=? WHERE collection_key=? AND id=?').run(
		canonicalJson({ ...row.payload, ...set }),
		`collection${index}`,
		'same'
	);
}
async function tick() {
	await cue.tick();
	await Promise.resolve();
}
function reserved() {
	return db.prepare('SELECT * FROM reservations').all();
}

it.each(['darwin', 'win32'] as const)(
	'reports missing %s owner identity at native intake without starting a run',
	async (platform) => {
		db.prepare('DELETE FROM runtime_owner').run();
		const info = {
			pid: 222,
			token: 'native',
			platform,
			hostIdentity: undefined as string | undefined,
			mode: 'desktop' as const,
			bootTime: 1,
			startedAt: new Date(1).toISOString(),
		};
		const native = new BoardCueHost({
			storage: () => storage,
			lock: () => ({ info, verify: () => ({ ok: true }) }),
			context: () => host,
			prepare,
			service,
			ownerLiveness: () => 'unknown',
			onWait: (key, reason) => waits.push({ cardId: key.cardId, reason }),
		});
		const entry = storage.query().collections[0];
		const key = { sourceKey: entry.sourceKey, collectionKey: entry.collectionKey, cardId: 'same' };
		const frozen = snapshotSqlite(db);
		await expect(native.runtimeFor(key)).rejects.toMatchObject({
			code: 'owner-identity-unavailable',
			message: expect.stringContaining('native host proof'),
		});
		expect(waits).toContainEqual({ cardId: 'same', reason: 'owner-identity-unavailable' });
		expect(snapshotSqlite(db)).toEqual(frozen);
		expect(service.spawn).not.toHaveBeenCalled();
		info.hostIdentity = 'os-machine-proof';
		const admitted = await native.runtimeFor(key);
		expect(admitted).not.toBeNull();
		expect(db.prepare('SELECT process_identity FROM runtime_owner').get()).toEqual({
			process_identity: admitted!.processIdentity,
		});
		expect(service.spawn).not.toHaveBeenCalled();
	}
);

describe('global Cue intake on the shared persistent runtime', () => {
	it('checks the current collection revision without projecting the workspace for every card', async () => {
		edit({ heldByUser: true });
		const entry = storage.query().collections[0];
		const reads = vi.spyOn(storage, 'query');
		await executeBoardRuntimeCommand({
			action: 'tick',
			operationId: 'bounded-read',
			target: {
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				expectedRevision: entry.revision,
			},
		});
		expect(service.spawn).not.toHaveBeenCalled();
		expect(reads).toHaveBeenCalledTimes(1);
	});

	it('enumerates both sources without open project agents, shares one worker and never double spawns on retry', async () => {
		await tick();
		expect(service.spawn).toHaveBeenCalledTimes(1);
		expect(reserved()).toHaveLength(1);
		expect(waits).toContainEqual({ cardId: 'same', reason: 'worker-busy' });
		await tick();
		expect(service.spawn).toHaveBeenCalledTimes(1);
		settle(good);
		await cue.settle();
		expect(storage.query().collections[0].board.cards[0].status).toBe('review');
		await vi.waitFor(() => expect(changed.some((statuses) => statuses[0] === 'review')).toBe(true));
		expect(changed.some((statuses) => statuses[0] === 'running')).toBe(true);
		await tick();
		expect(service.spawn).toHaveBeenCalledTimes(2);
		settle(good);
		await cue.settle();
		expect(reserved()).toHaveLength(0);
		expect(
			transitions.map((receipt) => [receipt.key.collectionKey, receipt.change.toStatus])
		).toEqual([
			['collection0', 'running'],
			['collection0', 'review'],
			['collection1', 'running'],
			['collection1', 'review'],
		]);
		expect(transitions.filter((receipt) => receipt.notification?.kind === 'done')).toEqual([]);
	});
	it('reports the busy authorized worker when a foreign registered worker is free', async () => {
		agents.push({ id: 'foreign', groupId: 'other' });
		registerBoardWorker(db, 'foreign');
		setBoardWorkerAccess(db, 'foreign', [], ['repo0', 'repo1']);
		host.agentStates = {
			worker: { ...host.agentStates.worker, busy: true },
			foreign: { live: true, busy: false, location: { kind: 'local' } },
		};
		await tick();
		expect(service.spawn).not.toHaveBeenCalled();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'worker-busy' });
		expect(reserved()).toHaveLength(0);
	});
	it('keeps an opted-in PR inert until the final human decision, even after native success or duplicate callbacks', async () => {
		edit({ prOnDone: {} });
		edit({ heldByUser: true }, 1);
		await tick();
		const spec = vi.mocked(service.spawn).mock.calls[0][0];
		const result = { ...good, worktreePath: roots[0], worktreeBranch: 'board/completed' };
		settle(result);
		await cue.settle();
		await Promise.all(completionTasks);
		expect(storage.query({ sourceKey: roots[0] }).collections[0].board.cards[0].status).toBe(
			'review'
		);
		expect(createPr).not.toHaveBeenCalled();
		expect(runtime.complete(spec.runToken, result)).toEqual({
			ok: false,
			reason: 'result-already-recorded',
		});
		await startBoardRunPr(spec, { createPr });
		expect(createPr).not.toHaveBeenCalled();
	});

	it.each([
		['paused', () => setBoardWorkerPaused(db, 'worker', true), 'worker-paused'],
		['disabled', () => db.prepare('UPDATE workers SET enabled=0').run(), 'worker-disabled'],
		[
			'group changed',
			() => {
				agents[0].groupId = 'other';
			},
			'worker-outside-scope',
		],
		['foreign pin', () => edit({ assigneeAgentId: 'foreign' }), 'target-missing'],
		['role', () => edit({ role: { namespace: 'missing', profileId: 'missing' } }), 'role-missing'],
		['repository', () => setBoardWorkerAccess(db, 'worker', [], []), 'worker-repository-mismatch'],
		['held', () => edit({ heldByUser: true }), 'held'],
		[
			'approval',
			() =>
				edit({
					capturePolicy: {
						effectiveStartMode: 'approval',
						dispatchApproval: 'required',
						specificationRevision: 0,
					},
				}),
			'approval-required',
		],
		['dependency', () => edit({ parents: ['missing'] }), 'dependency'],
	] as const)('%s waits with a concrete reason and no fallback', async (_name, change, reason) => {
		// Keep the second source held so it cannot hide an unintended fallback.
		edit({ heldByUser: true }, 1);
		change();
		await tick();
		expect(service.spawn).not.toHaveBeenCalled();
		expect(reserved()).toHaveLength(0);
		expect(waits).toContainEqual({ cardId: 'same', reason });
	});
	it('requires the namespaced role and honors its matching pin after intake resumes', async () => {
		edit({ heldByUser: true }, 1);
		const role = { namespace: 'local-role', profileId: 'review' };
		db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?)').run(
			role.namespace,
			role.profileId,
			canonicalJson({
				id: 'review',
				name: 'Review',
				baseAgentId: 'worker',
				model: 'review-model',
			}),
			roots[0]
		);
		edit({ role, assigneeAgentId: 'worker' });
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'worker-role-mismatch' });
		setBoardWorkerAccess(db, 'worker', [role], ['repo0', 'repo1']);
		setBoardWorkerPaused(db, 'worker', true);
		await tick();
		expect(service.spawn).not.toHaveBeenCalled();
		setBoardWorkerPaused(db, 'worker', false);
		await tick();
		expect(service.spawn).toHaveBeenCalledOnce();
		expect(vi.mocked(service.spawn).mock.calls[0][0]).toMatchObject({
			workerAgentId: 'worker',
			overrides: { customModel: 'review-model' },
		});
		settle(good);
		await cue.settle();
	});
	it('waits for native approval and then dispatches through the same global Cue runtime', async () => {
		edit({ heldByUser: true }, 1);
		const before = storage.query().collections[0];
		// Exercise the capture policy boundary, rather than injecting a grant requirement.
		const captured = storage.capture({
			projectRoot: roots[0],
			boardId: before.board.id,
			expectedRevision: before.revision,
			card: { ...before.board.cards[0], startModeOverride: 'approval' },
		});
		expect(captured.cards[0].capturePolicy?.dispatchApproval).toBe('required');
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'approval-required' });
		expect(service.spawn).not.toHaveBeenCalled();
		const entry = storage.query().collections[0];
		const command = {
			action: 'control' as const,
			operation: 'approve' as const,
			target: {
				projectRoot: roots[0],
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				expectedRevision: entry.revision,
			},
			cardId: 'same',
			cardRevision: entry.board.cards[0].storageRevision!,
		};
		await expect(executeBoardRuntimeCommand(command)).rejects.toMatchObject({
			code: 'protected-field',
		});
		await expect(
			executeBoardRuntimeCommand(
				{ ...command, cardRevision: command.cardRevision + 1 },
				'native-fixture-main-frame'
			)
		).rejects.toMatchObject({ code: 'stale-revision' });
		await expect(
			executeBoardRuntimeCommand(
				{
					...command,
					target: { ...command.target, expectedRevision: command.target.expectedRevision + 1 },
				},
				'native-fixture-main-frame'
			)
		).rejects.toMatchObject({ code: 'stale-revision' });
		expect(storage.query().collections[0].board.cards[0].capturePolicy?.dispatchApproval).toBe(
			'required'
		);
		expect(reserved()).toHaveLength(0);
		expect(await executeBoardRuntimeCommand(command, 'native-fixture-main-frame')).toMatchObject({
			ok: true,
		});
		expect(storage.query().collections[0].board.cards[0].capturePolicy?.dispatchApproval).toBe(
			'granted'
		);
		await tick();
		expect(service.spawn).toHaveBeenCalledOnce();
		settle(good);
		await cue.settle();
		expect(reserved()).toHaveLength(0);
		expect(storage.query().collections[0].board.cards[0].status).toBe('review');
	});
	it('rejects collection changes during asynchronous native preparation', async () => {
		const entry = storage.query().collections[0];
		const key = { sourceKey: entry.sourceKey, collectionKey: entry.collectionKey, cardId: 'same' };
		const ready = await cue.runtimeFor(key);
		configureBoardRuntimeHost(async () => {
			db.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?').run(
				key.collectionKey
			);
			return ready;
		});
		const result = await executeBoardRuntimeCommand({
			action: 'tick',
			operationId: 'mutation',
			target: { projectRoot: roots[0], ...key, expectedRevision: entry.revision },
		});
		expect(result).toMatchObject({ ok: true, value: [{ ok: false, reason: 'stale-revision' }] });
		expect(service.spawn).not.toHaveBeenCalled();
	});
	it('preserves migrated worker holds and leaves unresolved drafts waiting', async () => {
		edit({ heldByUser: true }, 1);
		db.prepare('INSERT INTO migration_worker_holds VALUES (?, ?)').run('worker', '[]');
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'worker-held' });
		db.prepare('DELETE FROM migration_worker_holds').run();
		edit({ repositoryId: undefined, workingDirectory: undefined });
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'repository-unresolved' });
		expect(service.spawn).not.toHaveBeenCalled();
	});
	it('retains unfinished migrated runs and worker holds through Cue tick and stop', async () => {
		edit({ heldByUser: true });
		edit({ heldByUser: true }, 1);
		const migration = applyBoardMigration(
			db,
			planBoardMigration({
				source: { location: { kind: 'local' }, path: dir },
				repository: null,
				boardBytes: Buffer.from(
					JSON.stringify({
						boards: [
							{
								id: 'legacy',
								name: 'Legacy',
								cards: [
									{
										id: 'unfinished',
										title: 'Uncertain legacy work',
										body: '',
										parents: [],
										status: 'running',
										runs: [{ attempt: 1, workerAgentId: 'legacy-worker', startedAt: 'then' }],
									},
								],
							},
						],
					})
				),
				profileBytes: null,
				workers: [],
			})
		);
		const runId = migration.mapping.boards[0].cards[0].runIds[0];
		const before = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
		const holds = db.prepare('SELECT * FROM migration_worker_holds').all();
		await expect(tick()).resolves.toBeUndefined();
		expect(() => cue.stop()).not.toThrow();
		expect(db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId)).toEqual(before);
		expect(db.prepare('SELECT * FROM migration_worker_holds').all()).toEqual(holds);
		expect(holds).toHaveLength(1);
		expect(service.spawn).not.toHaveBeenCalled();
		expect(service.stop).not.toHaveBeenCalled();
		expect(service.probe).not.toHaveBeenCalled();
	});
	it('preserves collection WIP', async () => {
		edit({ heldByUser: true }, 1);
		db.prepare(
			"UPDATE collections SET payload_json=json_set(payload_json, '$.maxInProgress', 0) WHERE collection_key='collection0'"
		).run();
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'collection-wip' });
		expect(service.spawn).not.toHaveBeenCalled();
	});
	it('honors pinned pause/disabled and an empty registry', async () => {
		edit({ assigneeAgentId: 'worker' });
		edit({ heldByUser: true }, 1);
		setBoardWorkerPaused(db, 'worker', true);
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'worker-paused' });
		setBoardWorkerPaused(db, 'worker', false);
		db.prepare('UPDATE workers SET enabled=0').run();
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'worker-disabled' });
		edit({ assigneeAgentId: undefined });
		db.prepare('DELETE FROM workers').run();
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'no-workers' });
		expect(service.spawn).not.toHaveBeenCalled();
	});
	it('avoids repository preparation only while the unpinned worker registry remains empty', async () => {
		db.prepare('DELETE FROM workers').run();
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'no-workers' });
		expect(prepare).not.toHaveBeenCalled();
		expect(reserved()).toHaveLength(0);

		// A worker registered across the async owner lookup must take the full
		// preparation and claim path, not the earlier empty-registry shortcut.
		configureBoardRuntimeHost(async (key, shouldPrepare) => {
			const result = await cue.runtimeFor(key, shouldPrepare);
			if (shouldPrepare === false && !db.prepare('SELECT 1 FROM workers').get()) {
				registerBoardWorker(db, 'worker');
				setBoardWorkerAccess(db, 'worker', [], ['repo0', 'repo1']);
			}
			return result;
		});
		await tick();
		expect(prepare).toHaveBeenCalled();
		expect(service.spawn).toHaveBeenCalled();
	});
	it.each([
		['registered agent', { assigneeAgentId: 'worker' }, 'worker-unregistered'],
		['missing agent', { assigneeAgentId: 'foreign' }, 'target-missing'],
		['held card', { assigneeAgentId: 'worker', heldByUser: true }, 'held'],
		['blocked dependency', { assigneeAgentId: 'worker', parents: ['missing'] }, 'dependency'],
		[
			'missing role',
			{ assigneeAgentId: 'worker', role: { namespace: 'missing', profileId: 'missing' } },
			'role-missing',
		],
	] as const)(
		'preserves the full claim reason for an empty registry and %s',
		async (_name, changes, reason) => {
			edit(changes);
			edit({ heldByUser: true }, 1);
			db.prepare('DELETE FROM workers').run();
			const entry = storage.query().collections[0];
			const card = storage.workspace.readCollection(entry)!.cards[0];
			const command = {
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				cardId: card.cardId,
				workerAgentId: changes.assigneeAgentId,
				requestId: 'empty-registry-differential',
				readRevision: {
					workspace: storage.workspace.readRevision(),
					collection: entry.revision,
					card: card.revision,
					registry: runtime.intakeRevision(),
				},
			};
			const normal = runtime.claim(command);
			expect(normal).toEqual({ ok: false, reason });
			expect(runtime.claim(command, true)).toEqual(normal);
			await tick();
			expect(waits).toContainEqual({ cardId: 'same', reason });
			expect(prepare).not.toHaveBeenCalled();
			expect(service.spawn).not.toHaveBeenCalled();
			expect(reserved()).toHaveLength(0);
			expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(0);
		}
	);
	it('uses full preparation if a separate SQLite connection registers the pinned worker during owner lookup', async () => {
		edit({ assigneeAgentId: 'worker' });
		edit({ heldByUser: true }, 1);
		db.prepare('DELETE FROM workers').run();
		const other = openBoardDb(fixture.contract.db);
		try {
			configureBoardRuntimeHost(async (key, shouldPrepare) => {
				const result = await cue.runtimeFor(key, shouldPrepare);
				if (shouldPrepare === false && !other.prepare('SELECT 1 FROM workers').get()) {
					registerBoardWorker(other, 'worker');
					setBoardWorkerAccess(other, 'worker', [], ['repo0', 'repo1']);
				}
				return result;
			});
			await tick();
			expect(prepare).toHaveBeenCalled();
			expect(service.spawn).toHaveBeenCalledOnce();
		} finally {
			other.close();
		}
	});
	it('does not allocate from the empty-registry probe when the worker has appeared', () => {
		const entry = storage.query().collections[0];
		const card = storage.workspace.readCollection(entry)!.cards[0];
		const result = runtime.claim(
			{
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				cardId: card.cardId,
				workerAgentId: 'worker',
				requestId: 'registry-appeared',
				readRevision: {
					workspace: storage.workspace.readRevision(),
					collection: entry.revision,
					card: card.revision,
					registry: runtime.intakeRevision(),
				},
			},
			true
		);
		expect(result).toEqual({ ok: false, reason: 'registry-changed' });
		expect(reserved()).toHaveLength(0);
		expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(0);
	});
	it('falls back to normal preparation for a previously used request id', () => {
		edit({ assigneeAgentId: 'worker' });
		db.prepare('DELETE FROM workers').run();
		const entry = storage.query().collections[0];
		const card = storage.workspace.readCollection(entry)!.cards[0];
		db.prepare(
			'INSERT INTO commands (request_id, principal, result_json, revision) VALUES (?, ?, ?, ?)'
		).run('previous-request', 'some-principal', '{}', 1);
		const result = runtime.claim(
			{
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				cardId: card.cardId,
				workerAgentId: 'worker',
				requestId: 'previous-request',
				readRevision: {
					workspace: storage.workspace.readRevision(),
					collection: entry.revision,
					card: card.revision,
					registry: runtime.intakeRevision(),
				},
			},
			true
		);
		expect(result).toEqual({ ok: false, reason: 'registry-changed' });
		expect(reserved()).toHaveLength(0);
	});
	it('rechecks the registry inside the probe after a separate process registers the pin', async () => {
		edit({ assigneeAgentId: 'worker' });
		edit({ heldByUser: true }, 1);
		db.prepare('DELETE FROM workers').run();
		const cueRuntime = await cue.runtimeFor(
			{ sourceKey: roots[0], collectionKey: 'collection0', cardId: 'same' },
			false
		);
		expect(cueRuntime).not.toBeNull();
		const originalRevision = cueRuntime!.intakeRevision.bind(cueRuntime);
		let changed = false;
		vi.spyOn(cueRuntime!, 'intakeRevision').mockImplementation(() => {
			const revision = originalRevision();
			if (!changed) {
				changed = true;
				execFileSync(process.execPath, [
					'-e',
					`
					const db = new (require('better-sqlite3'))(process.argv[1]);
					db.transaction(() => {
						db.prepare('INSERT INTO workers VALUES (?, 1, 0, ?)').run('worker', JSON.stringify({roleRefs: [], allowedRepositoryIds: ['repo0', 'repo1']}));
						db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
					}).immediate();
					db.close();
				`,
					fixture.contract.db,
				]);
			}
			return revision;
		});
		await tick();
		expect(changed).toBe(true);
		expect(prepare).toHaveBeenCalled();
		expect(service.spawn).toHaveBeenCalledOnce();
	});
	it('rejects a changed card revision during the empty-registry owner lookup', async () => {
		edit({ assigneeAgentId: 'worker' });
		edit({ heldByUser: true }, 1);
		db.prepare('DELETE FROM workers').run();
		let changed = false;
		configureBoardRuntimeHost(async (key, shouldPrepare) => {
			const result = await cue.runtimeFor(key, shouldPrepare);
			if (shouldPrepare === false && !changed) {
				changed = true;
				edit({ assigneeAgentId: 'foreign' });
				db.prepare('UPDATE cards SET revision=revision+1 WHERE collection_key=? AND id=?').run(
					'collection0',
					'same'
				);
				db.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?').run(
					'collection0'
				);
			}
			return result;
		});
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'stale-revision' });
		expect(service.spawn).not.toHaveBeenCalled();
		expect(reserved()).toHaveLength(0);
	});
	it('honors global WIP and lost ownership', async () => {
		db.prepare('UPDATE workspace SET global_wip_limit=0').run();
		await tick();
		expect(waits).toContainEqual({ cardId: 'same', reason: 'global-wip' });
		expect(reserved()).toHaveLength(0);
		lockValid = false;
		await tick();
		expect(waits.some((w) => w.reason === 'runtime-unavailable')).toBe(true);
	});
	it('rechecks membership after asynchronous preparation before launch', async () => {
		edit({ heldByUser: true }, 1);
		const original = service.spawn;
		service.spawn = vi.fn(async (spec, callbacks) => {
			agents[0].groupId = 'other';
			return original(spec, callbacks);
		});
		await tick();
		await cue.settle();
		expect(reserved()).toHaveLength(0);
		expect(storage.query().collections[0].board.cards[0].status).not.toBe('running');
	});
	it('CLI and Cue race on the same attempt and stopping preserves the reservation until termination', async () => {
		const entry = storage.query().collections[0];
		const cli = executeBoardRuntimeCommand({
			action: 'tick',
			operationId: 'cli',
			target: {
				projectRoot: roots[0],
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				expectedRevision: entry.revision,
			},
		});
		await Promise.all([cli, tick()]);
		expect(service.spawn).toHaveBeenCalledTimes(1);
		cue.stop();
		expect(service.stop).toHaveBeenCalledTimes(1);
		expect(reserved()).toHaveLength(1);
		settle({ ...good, output: '', exitCode: null });
		await cue.settle();
		expect(reserved()).toHaveLength(0);
		expect(storage.query().collections[0].board.cards[0].heldByUser).toBe(true);
	});
});

describe('attempt-owned native review preparation', () => {
	it.each([
		'claim',
		'launch',
		'dirty',
		'commit',
		'registry',
		'revision',
		'scope',
		'owner',
	] as const)('keeps the %s boundary fresh during overlapping preparations', async (boundary) => {
		const git = (...args: string[]) =>
			execFileSync('git', args, { cwd: roots[0], encoding: 'utf8' }).trim();
		git('init', '--quiet');
		fs.writeFileSync(path.join(roots[0], 'work.txt'), 'baseline');
		git('add', '.');
		git(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.test',
			'commit',
			'--quiet',
			'-m',
			'baseline'
		);
		const base = git('rev-parse', 'HEAD');
		fs.writeFileSync(path.join(roots[0], 'work.txt'), 'reviewed result');
		git('add', '.');
		git(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.test',
			'commit',
			'--quiet',
			'-m',
			'work'
		);
		const artifact = await readBoardRunArtifact(roots[0], base);
		expect(artifact?.diff?.sha256).toMatch(/^[a-f0-9]{64}$/);
		const collection = storage.workspace.readCollection({
			sourceKey: roots[0],
			collectionKey: 'collection0',
		})!;
		const claimed = runtime.claim({
			sourceKey: roots[0],
			collectionKey: 'collection0',
			cardId: 'same',
			workerAgentId: 'worker',
			requestId: 'work',
			readRevision: {
				workspace: storage.workspace.readRevision(),
				collection: collection.revision,
				card: collection.cards[0].revision,
				registry: host.registryRevision,
			},
		});
		if (!claimed.ok) throw Error(claimed.reason);
		const work = runtime.start(claimed.runToken);
		settle({
			...good,
			output: '<!-- maestro:card-complete | native checks passed -->',
			artifact: artifact!,
		});
		await work;
		const board = storage.read(roots[0], 'board');
		const captured = await captureBoardCardFromHost({
			projectRoot: roots[0],
			boardId: 'board',
			expectedRevision: board.storage!.expectedRevision!,
			reviewSource: { cardId: 'same', attempt: 1 },
			card: {
				id: 'review',
				title: 'Review result',
				body: '',
				kind: 'review',
				parents: ['same'],
				status: 'todo',
				createdAt: 'now',
				updatedAt: 'now',
				repositoryId: 'repo0',
				workingDirectory: roots[0],
				executionScope: { kind: 'group', groupId: 'group' },
				assigneeAgentId: 'worker',
			},
		});
		const handoff = captured.value.cards.find((c) => c.id === 'review')!.reviewHandoff!;
		let commonProof: string | null = null;
		let releasePrepare!: () => void, enteredPrepare!: () => void;
		const preparing = new Promise<void>((resolve) => {
			enteredPrepare = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releasePrepare = resolve;
		});
		let blockNext = false;
		let releaseLaunch!: () => void, enteredLaunch!: () => void;
		const launching = new Promise<void>((resolve) => {
			enteredLaunch = resolve;
		});
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const reviewService: BoardRunService = {
			...service,
			spawn: vi.fn(async (_spec, callbacks) => {
				if (!callbacks.canPrepare()) return { output: '', exitCode: null, executionStarted: false };
				enteredLaunch();
				await launchGate;
				if (!callbacks.beforeLaunch())
					return { output: '', exitCode: null, executionStarted: false };
				callbacks.onStarted(303);
				return {
					...good,
					output: '<!-- maestro:card-complete | Reviewed actual commit and diff; no findings -->',
					artifact: (await readBoardRunArtifact(roots[0], base))!,
				};
			}),
		};
		const reviewCue = new BoardCueHost({
			storage: () => storage,
			lock: () => ({
				info: { pid: 101, mode: 'desktop', bootTime: 1, startedAt: new Date(1).toISOString() },
				verify: () => (lockValid ? { ok: true } : { ok: false, reason: 'lost' }),
			}),
			context: (_key, prepared) => ({
				...host,
				reviewArtifact: prepared ? prepared.reviewArtifact : commonProof,
			}),
			prepare: async () => {
				commonProof = null;
				const shouldBlock = blockNext;
				blockNext = false;
				const proof = await prepareBoardReviewHandoff(storage, handoff);
				if (shouldBlock) {
					enteredPrepare();
					await blocked;
				}
				commonProof = proof;
				return { repository: host.repository, reviewArtifact: proof };
			},
			service: reviewService,
			ownerLiveness: () => 'unknown',
			onWait: () => {},
		});
		const key = { sourceKey: roots[0], collectionKey: 'collection0', cardId: 'review' };
		const first = (await reviewCue.runtimeFor(key))!;
		const claimReview = () => {
			const current = storage.workspace.readCollection(key)!;
			return first.claim({
				...key,
				workerAgentId: 'worker',
				requestId: 'review',
				readRevision: {
					workspace: storage.workspace.readRevision(),
					collection: current.revision,
					card: current.cards.find((c) => c.cardId === 'review')!.revision,
					registry: first.intakeRevision(),
				},
			});
		};
		if (boundary === 'claim') {
			blockNext = true;
			const overlapping = reviewCue.runtimeFor(key);
			await preparing;
			const claim = claimReview();
			releasePrepare();
			await overlapping;
			expect(claim).toMatchObject({ ok: true });
			if (!claim.ok) throw Error(claim.reason);
			releaseLaunch();
			await first.start(claim.runToken);
		} else {
			const claim = claimReview();
			if (!claim.ok) throw Error(claim.reason);
			if (boundary === 'dirty' || boundary === 'commit') {
				fs.writeFileSync(path.join(roots[0], 'work.txt'), 'changed artifact');
				if (boundary === 'commit') {
					git('add', '.');
					git(
						'-c',
						'user.name=Fixture',
						'-c',
						'user.email=fixture@example.test',
						'commit',
						'--quiet',
						'-m',
						'different diff'
					);
				}
				releaseLaunch();
				await first.start(claim.runToken);
				const outcome = db
					.prepare('SELECT outcome_json FROM runs WHERE card_id=?')
					.get('review') as { outcome_json: string };
				expect(JSON.parse(outcome.outcome_json).result).toMatchObject({
					executionStarted: false,
					error: 'review-artifact-unresolved',
				});
				expect(
					storage
						.read(roots[0], 'board')
						.cards.find((c) => c.id === 'review')!
						.runs?.at(-1)?.outcome
				).not.toBe('done');
				expect(db.prepare('SELECT count(*) AS n FROM reservations').get()).toEqual({ n: 0 });
				return;
			}
			const pending = first.start(claim.runToken);
			await launching;
			if (['registry', 'revision', 'scope', 'owner'].includes(boundary)) {
				if (boundary === 'registry') host.registryRevision++;
				if (boundary === 'revision')
					db.prepare('UPDATE cards SET revision=revision+1 WHERE id=?').run('review');
				if (boundary === 'scope') agents[0].groupId = 'removed';
				if (boundary === 'owner') lockValid = false;
				releaseLaunch();
				await pending;
				const run = db.prepare('SELECT lifecycle_json FROM runs WHERE card_id=?').get('review') as {
					lifecycle_json: string;
				};
				expect(JSON.parse(run.lifecycle_json).process).toBeUndefined();
				expect(storage.read(roots[0], 'board').cards.find((c) => c.id === 'same')!.status).toBe(
					'review'
				);
				return;
			}
			blockNext = true;
			const overlapping = reviewCue.runtimeFor(key);
			await preparing;
			releaseLaunch();
			await pending;
			releasePrepare();
			await overlapping;
		}
		expect(reviewService.spawn).toHaveBeenCalledTimes(1);
		expect(storage.read(roots[0], 'board').cards.find((c) => c.id === 'same')!.status).toBe(
			'ready-for-human'
		);
		expect(db.prepare('SELECT count(*) AS n FROM runs WHERE card_id=?').get('review')).toEqual({
			n: 1,
		});
		expect(db.prepare('SELECT count(*) AS n FROM reservations').get()).toEqual({ n: 0 });
	});
});

it.each(['owner-loss', 'gate-off'])(
	'preserves earlier per-card dispatch receipts after %s',
	async (failure) => {
		const entry = storage.query().collections[0];
		const first = db
			.prepare('SELECT payload_json FROM cards WHERE collection_key=?')
			.get(entry.collectionKey) as { payload_json: string };
		db.prepare('INSERT INTO cards(collection_key,id,payload_json,revision) VALUES(?,?,?,0)').run(
			entry.collectionKey,
			'later',
			JSON.stringify({ ...JSON.parse(first.payload_json), id: 'later', title: 'Later' })
		);
		let lookups = 0;
		configureBoardRuntimeHost((key, shouldPrepare) => {
			if (++lookups === 1) return cue.runtimeFor(key, shouldPrepare);
			if (failure === 'gate-off') {
				configureBoardFeatures({ get: () => ({ board: false, maestroCue: true }) });
				return cue.runtimeFor(key, shouldPrepare);
			}
			return null;
		});
		const result = await executeBoardRuntimeCommand({
			action: 'tick',
			operationId: 'partial-owner-loss',
			target: {
				sourceKey: entry.sourceKey,
				collectionKey: entry.collectionKey,
				expectedRevision: storage.workspace.readCollection(entry)!.revision,
			},
		});
		expect(result).toMatchObject({
			ok: true,
			value: [
				expect.objectContaining({
					ok: true,
					runToken: expect.objectContaining({ runId: expect.any(String) }),
				}),
				expect.objectContaining({ ok: false, reason: 'runtime-unavailable' }),
			],
		});
		settle(good);
		await cue.settle();
	}
);
