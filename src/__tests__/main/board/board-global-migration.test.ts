import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { openBoardDb } from '../../../main/board/board-db';
import {
	assertBoardIsolationPath,
	boardIsolationChildEnv,
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from '../../../main/board/board-isolation';
import {
	applyBoardMigration,
	planBoardMigration,
	type BoardMigrationInput,
} from '../../../main/board/board-migration';
import { BoardStorageFacade, configureBoardCaptureHost } from '../../../main/board/board-storage';
import { resolveBoardWorkerExecution } from '../../../main/board/board-worker-options';
import {
	listBoardWorkers,
	setBoardWorkerOptions,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';
import { compareSqliteSnapshots, snapshotSqlite } from '../../helpers/sqliteSnapshot';
import { canonicalJson } from '../../../shared/canonicalJson';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../../shared/board/types';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';

const fixture = createBoardIsolationFixture();
let scratch: { dir: string; cleanup: () => void };
let contract: BoardIsolation;
let db: ReturnType<typeof openBoardDb>;
let storage: BoardStorageFacade;
const time = '2026-11-01T00:00:00.000Z';
const card = {
	id: 'same',
	title: 'Work',
	body: '',
	status: 'todo',
	parents: [],
	assigneeAgentId: 'worker',
	assigneeProfileId: 'role',
	createdAt: time,
	updatedAt: time,
};

beforeAll(() => {
	fixture.install();
	contract = requireBoardIsolation();
	readBoardIsolationRegistries(contract);
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(contract.db + suffix)) throw new Error('Board test database must be fresh');
	}
	fs.mkdirSync(path.dirname(contract.db), { recursive: true });
});
afterAll(async () => {
	await fixture.cleanup();
});
beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(contract.root, 'global-migration-'));
	scratch = { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
	db = openBoardDb(contract.db);
	storage = new BoardStorageFacade(db);
	configureBoardCaptureHost(() => ({
		agents: [{ id: 'worker', groupId: 'group' }],
		groups: [{ id: 'group' }],
	}));
});
afterEach(() => {
	const evidence = process.env.BOARD_MIGRATION_EVIDENCE_DIR;
	if (evidence) {
		if (assertBoardIsolationPath(contract, evidence, 'directory') !== path.resolve(evidence))
			throw new Error('Evidence path must be inside the isolated root');
		const scenario = expect.getState().currentTestName!;
		const name = createHash('sha256').update(scenario).digest('hex').slice(0, 16);
		fs.mkdirSync(evidence, { recursive: true });
		db.pragma('wal_checkpoint(TRUNCATE)');
		const file = path.join(evidence, `${name}.sqlite`);
		fs.copyFileSync(contract.db, file);
		fs.writeFileSync(
			path.join(evidence, `${name}.json`),
			canonicalJson({
				scenario,
				file,
				temporaryDatabase: contract.db,
				sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
				snapshot: manifest(),
			})
		);
	}
	db.close();
	scratch.cleanup();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(contract.db + suffix, { force: true });
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
});

function input(name: string, cards: unknown[] = [card], boardFields = {}): BoardMigrationInput {
	const root = path.join(scratch.dir, name);
	return {
		source: { location: { kind: 'local' }, path: root },
		repository: { id: name, workingDirectory: root, validated: true },
		boardBytes: Buffer.from(
			JSON.stringify({ extra: 'root bytes', boards: [{ id: 'same', name, cards, ...boardFields }] })
		),
		profileBytes: Buffer.from(
			JSON.stringify({
				profiles: [
					{
						id: 'role',
						name: 'Role',
						model: name,
						effort: 'high',
						appendSystemPrompt: 'Keep instructions',
						customArgs: '--fixture',
						future: { retained: name },
					},
				],
			})
		),
		workers: [{ id: 'worker', dir: root, boardWorker: true, future: { retained: name } }],
	};
}

/** Stream raw SQL columns into bounded digests, including revision/owner/receipt state. */
function manifest() {
	return snapshotSqlite(db);
}

function claim(sourceKey: string, cardId = 'same') {
	const collection = storage.workspace
		.readWorkspace()
		.collections.find((entry) => entry.sourceKey === sourceKey)!;
	const selected = collection.cards.find((entry) => entry.cardId === cardId)!;
	const repository = db
		.prepare('SELECT payload_json FROM repositories WHERE id = ?')
		.get(selected.payload.repositoryId) as { payload_json: string };
	return storage.claim(
		{
			sourceKey,
			collectionKey: collection.collectionKey,
			cardId,
			workerAgentId: 'worker',
			requestId: `${sourceKey}:${cardId}:${selected.revision}`,
			readRevision: {
				workspace: storage.query().revision,
				collection: collection.revision,
				card: selected.revision,
				registry: 1,
			},
		},
		() => ({
			owner: { processIdentity: 'fixture-owner', epoch: 7 },
			registryRevision: 1,
			dispatchEnabled: true,
			agentStates: { worker: { live: true, busy: false, location: { kind: 'local' } } },
			repository: repository
				? {
						id: selected.payload.repositoryId as string,
						workingDirectory: selected.payload.workingDirectory as string,
						record: JSON.parse(repository.payload_json),
						location: { kind: 'local' },
						identity: 'isolated-fixture',
					}
				: null,
		})
	);
}

describe('legacy sources in the global Board', () => {
	it('migrates an empty source twice without adding repositories, profiles or grants to global capture', () => {
		const source = input('empty', []);
		source.boardBytes = null;
		source.profileBytes = null;
		source.repository = null;
		source.workers = [];
		const plan = planBoardMigration(source);
		expect(applyBoardMigration(db, plan).status).toBe('imported');
		const imported = manifest();
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(imported, manifest())).toEqual([]);
		const global = storage.ensureGlobalBoard();
		expect(global.cards).toEqual([]);
		expect(storage.captureContext(global).defaultStartMode).toBe('approval');
		for (const table of ['repositories', 'profiles', 'workers', 'runs', 'reservations'])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
	});

	it('keeps colliding IDs, DAG, all profile options, unknown metadata and raw snapshots separate on reload and replay', () => {
		const runs = [
			{
				attempt: 1,
				startedAt: time,
				endedAt: time,
				outcome: 'done',
				workerAgentId: 'worker',
				future: { retained: true },
			},
		];
		const sources = ['a', 'b'].map((name) =>
			input(name, [
				{ ...card, id: 'parent', status: 'done', runs },
				{ ...card, parents: ['parent'], heldByUser: true, future: { nested: [null, 42] } },
			])
		);
		const plans = sources.map(planBoardMigration);
		const mappings = plans.map((plan) => applyBoardMigration(db, plan).mapping);
		expect(new Set(mappings.map((mapping) => mapping.boards[0].collectionKey)).size).toBe(2);
		expect(new Set(mappings.map((mapping) => mapping.profileNamespace)).size).toBe(2);
		const legacy = manifest();
		storage.ensureGlobalBoard();
		for (const table of ['cards', 'collections', 'profiles', 'runs', 'migrations']) {
			if (table !== 'collections') expect(manifest()[table]).toEqual(legacy[table]);
		}
		const projection = storage.query();
		expect(projection.collections).toHaveLength(3);
		for (let index = 0; index < 2; index++) {
			const plan = plans[index];
			const collection = projection.collections.find(
				(entry) => entry.sourceKey === plan.sourceKey
			)!;
			expect(collection.board.id).toBe('same');
			expect(collection.board.cards.map((entry) => entry.id)).toEqual(['parent', 'same']);
			expect(collection.board.cards[1]).toMatchObject({
				parents: ['parent'],
				heldByUser: true,
				future: { nested: [null, 42] },
			});
			expect(
				resolveBoardWorkerExecution(
					db,
					'worker',
					collection.board.cards[1] as unknown as Record<string, unknown>
				)
			).toMatchObject({
				overrides: {
					customModel: sources[index].repository!.id,
					customEffort: 'high',
					appendSystemPrompt: 'Keep instructions',
					customArgs: '--fixture',
				},
				provenance: {
					legacyProfile: {
						namespace: plan.profileNamespace,
						sourceKey: plan.sourceKey,
						payload: { future: { retained: sources[index].repository!.id } },
					},
				},
			});
			const snapshot = db
				.prepare('SELECT snapshot FROM migrations WHERE source_key = ?')
				.get(plan.sourceKey) as { snapshot: Buffer };
			const saved = JSON.parse(snapshot.snapshot.toString());
			expect(Buffer.from(saved.snapshot.boardBase64, 'base64')).toEqual(sources[index].boardBytes);
			expect(Buffer.from(saved.snapshot.profileBase64, 'base64')).toEqual(
				sources[index].profileBytes
			);
			expect(saved.snapshot.workers).toEqual(sources[index].workers);
		}
		db.close();
		db = openBoardDb(contract.db);
		storage = new BoardStorageFacade(db);
		const beforeReplay = manifest();
		for (const [index, plan] of plans.entries()) {
			expect(applyBoardMigration(db, plan)).toEqual({
				status: 'already-imported',
				mapping: mappings[index],
			});
		}
		expect(compareSqliteSnapshots(beforeReplay, manifest())).toEqual([]);
		expect(storage.query()).toEqual(projection);
		expect(db.pragma('foreign_key_check')).toEqual([]);
	});

	it('does not rewrite revisions, approvals, active reservations, run specs, receipts or edited worker options on retry or changed source', () => {
		const source = input('active', [
			{
				...card,
				capturePolicy: {
					effectiveStartMode: 'approval',
					dispatchApproval: 'granted',
					specificationRevision: 0,
					grant: { principal: 'fixture-human', grantedAt: time, specificationRevision: 0 },
				},
			},
		]);
		const plan = planBoardMigration(source);
		applyBoardMigration(db, plan);
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
		const result = claim(plan.sourceKey);
		expect(result.ok).toBe(true);
		const worker = listBoardWorkers(db)[0];
		setBoardWorkerOptions(db, 'worker', canonicalJson(worker.payload), {
			customModel: 'edited',
		});
		setBoardWorkerPaused(db, 'worker', true);
		const frozen = manifest();
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		const changed = planBoardMigration({
			...source,
			boardBytes: Buffer.from('{"boards":[]}'),
			workers: [],
		});
		expect(applyBoardMigration(db, changed).status).toBe('source-changed');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(1);
		expect(db.prepare('SELECT * FROM commands').all()).toHaveLength(1);
	});

	it('preserves every status, Work/Review relationship, human decision and run identity across colliding sources', () => {
		const workflow = {
			version: 1,
			corrections: 1,
			workRunId: 'same-work-run',
			reviewCardId: 'review-task',
			reviewResult: {
				workRunId: 'same-work-run',
				reviewRunId: 'same-review-run',
				reviewCardId: 'review-task',
				verdict: 'clean',
				summary: 'Fixture checks',
			},
			humanDecision: {
				principal: 'fixture-human',
				decidedAt: time,
				workRunId: 'same-work-run',
				reviewRunId: 'same-review-run',
			},
		};
		const statuses = [
			'triage',
			'todo',
			'ready',
			'running',
			'review',
			'ready-for-human',
			'blocked',
			'done',
		];
		const sources = ['history-a', 'history-b'].map((name) =>
			input(name, [
				...statuses.map((status) => ({
					...card,
					id: status,
					status,
					...(status === 'triage'
						? {
								capturePolicy: {
									effectiveStartMode: 'approval',
									dispatchApproval: 'required',
									specificationRevision: 3,
								},
							}
						: {}),
					...(status === 'blocked' ? { heldByUser: true, blockedReason: 'Historical error' } : {}),
					runs:
						status === 'running' ? [{ attempt: 1, startedAt: time, workerAgentId: 'worker' }] : [],
				})),
				{
					...card,
					id: 'approved',
					status: 'done',
					workflow,
					runs: [
						{
							attempt: 1,
							runId: workflow.workRunId,
							startedAt: time,
							endedAt: time,
							outcome: 'done',
							summary: 'Fixture checks',
						},
					],
				},
				{
					...card,
					id: 'review-task',
					kind: 'review',
					status: 'done',
					parents: ['approved'],
					reviewHandoff: {
						cardId: 'approved',
						runId: workflow.workRunId,
						attempt: 1,
						artifact: { commit: 'fixture', branch: 'fixture' },
						checks: 'Fixture checks',
					},
					runs: [
						{
							attempt: 1,
							runId: workflow.reviewResult.reviewRunId,
							startedAt: time,
							endedAt: time,
							outcome: 'done',
						},
					],
				},
				{
					...card,
					id: 'failures',
					status: 'blocked',
					runs: ['error', 'canceled', 'reclaimed', 'review', 'blocked'].map((outcome, index) => ({
						attempt: index + 1,
						startedAt: time,
						endedAt: time,
						outcome,
						future: outcome,
					})),
				},
			])
		);
		const plans = sources.map(planBoardMigration);
		const mappings = plans.map((plan) => applyBoardMigration(db, plan).mapping);
		const rowIds = mappings.flatMap((mapping) =>
			mapping.boards[0].cards.flatMap((entry) => entry.runIds)
		);
		expect(new Set(rowIds).size).toBe(rowIds.length);
		for (const [index, plan] of plans.entries()) {
			const collection = storage
				.query()
				.collections.find((entry) => entry.sourceKey === plan.sourceKey)!;
			for (const original of plan.boards[0].cards) {
				const projected = collection.board.cards.find((entry) => entry.id === original.legacyId)!;
				expect(projected).toMatchObject(original.raw as Record<string, unknown>);
			}
			expect(collection.board.cards.find((entry) => entry.id === 'ready')!.status).toBe('ready');
			expect(
				collection.board.cards.find((entry) => entry.id === 'done')!.workflow?.humanDecision
			).toBeUndefined();
			expect(
				plan.boards[0].cards.find((entry) => entry.legacyId === 'ready-for-human')!.intent
			).toBe('human-review');
			const refs = mappings[index].boards[0].cards.find(
				(entry) => entry.id === 'approved'
			)!.runReferences!;
			expect(refs[0].legacyRunId).toBe(workflow.workRunId);
			expect(
				db.prepare('SELECT specification_json FROM runs WHERE run_id=?').get(refs[0].runId)
			).toMatchObject({
				specification_json: expect.stringContaining('same-work-run'),
			});
		}
		const frozen = manifest();
		db.close();
		db = openBoardDb(contract.db);
		storage = new BoardStorageFacade(db);
		for (const plan of plans) expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		expect(db.pragma('foreign_key_check')).toEqual([]);
	});

	it('edits worker A options without changing B, the shared legacy role, or imported run specifications', () => {
		const source = input('options', [
			{ ...card, runs: [{ attempt: 1, startedAt: time, endedAt: time, outcome: 'done' }] },
		]);
		source.workers.push({ id: 'worker-b', dir: source.source.path, boardWorker: true });
		const plan = planBoardMigration(source);
		applyBoardMigration(db, plan);
		const before = manifest();
		const worker = listBoardWorkers(db).find((entry) => entry.agentId === 'worker')!;
		const b = listBoardWorkers(db).find((entry) => entry.agentId === 'worker-b')!;
		setBoardWorkerOptions(db, 'worker', canonicalJson(worker.payload), {
			customModel: 'only-a',
			customEffort: 'low',
			appendSystemPrompt: 'Only A',
			customArgs: '--only-a',
		});
		expect(listBoardWorkers(db).find((entry) => entry.agentId === 'worker-b')).toEqual(b);
		const after = manifest();
		for (const table of ['profiles', 'runs', 'migrations', 'cards'])
			expect(after[table].sha256).toBe(before[table].sha256);
		const edited = manifest();
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(edited, manifest())).toEqual([]);
	});

	it('serializes two real-process replays without disturbing an active claim, approval or receipt', async () => {
		const source = input('concurrent');
		const plan = planBoardMigration(source);
		applyBoardMigration(db, plan);
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
		expect(claim(plan.sourceKey).ok).toBe(true);
		const frozen = manifest();
		// External packages must resolve from this checkout, as in the existing bootstrap fixture.
		const build = fs.mkdtempSync(path.join(contract.root, 'replay-build-'));
		const bundle = path.join(build, 'replay.cjs');
		buildSync({
			entryPoints: ['src/__tests__/main/board/fixtures/board-global-store-process.ts'],
			outfile: bundle,
			bundle: true,
			platform: 'node',
			packages: 'external',
			logLevel: 'silent',
		});
		const children = [
			fork(bundle, [], {
				cwd: contract.worktree,
				env: boardIsolationChildEnv(contract),
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			}),
			fork(bundle, [], {
				cwd: contract.worktree,
				env: boardIsolationChildEnv(contract),
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			}),
		];
		try {
			const ready = children.map((child) => once(child, 'message'));
			const exits = children.map((child) => once(child, 'exit'));
			for (const child of children) child.send({ file: contract.db, plan, contract });
			await Promise.all(ready);
			const replies = children.map((child) => once(child, 'message'));
			for (const child of children) child.send({ start: true });
			for (const [reply] of await Promise.all(replies))
				expect(reply.migration.status).toBe('already-imported');
			for (const [code] of await Promise.all(exits)) expect(code).toBe(0);
			expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill();
			fs.rmSync(build, { recursive: true, force: true });
		}
	});

	it('preserves explicit group scope, foreign namespaced references and execution metadata instead of substituting the source root', () => {
		const explicit = {
			...card,
			executionScope: { kind: 'group', groupId: 'group', future: 9 },
			profileNamespace: 'foreign',
			role: { namespace: 'foreign', profileId: 'role' },
			repositoryId: 'explicit-repo',
			workingDirectory: path.join(scratch.dir, 'explicit'),
		};
		const plan = planBoardMigration(input('explicit', [explicit]));
		expect(plan.boards[0].cards[0]).toMatchObject({
			executionScope: explicit.executionScope,
			profileNamespace: 'foreign',
			blockers: ['profile-unresolved'],
		});
		applyBoardMigration(db, plan);
		const projected = storage.query().collections[0].board.cards[0];
		expect(projected).toMatchObject(explicit);
		expect(
			resolveBoardWorkerExecution(db, 'worker', projected as unknown as Record<string, unknown>)
		).toBeNull();
		const frozen = manifest();
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
	});

	it.each([
		{ executionScope: null, repositoryId: null, workingDirectory: null, profileNamespace: null },
		{
			executionScope: { kind: 'future', id: 'unknown' },
			repositoryId: 42,
			workingDirectory: false,
		},
	])(
		'retains explicit unresolved or unknown fields without falling back to an execution target: %j',
		(fields) => {
			const raw = { ...card, ...fields };
			const plan = planBoardMigration(input('unknown', [raw]));
			applyBoardMigration(db, plan);
			expect(storage.query().collections[0].board.cards[0]).toMatchObject(raw);
			db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
			expect(claim(plan.sourceKey)).toEqual({ ok: false, reason: 'migration-blocked' });
			expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
		}
	);

	it('archives duplicate IDs and retains all uncertain legacy claims without reserving or restarting them', () => {
		const running = {
			...card,
			status: 'running',
			runs: [{ attempt: 2, startedAt: time, workerAgentId: 'worker' }],
		};
		const source = input('conflict', [running, running]);
		const plan = planBoardMigration(source);
		const result = applyBoardMigration(db, plan);
		expect(result.mapping.boards[0].collectionKey).toBeNull();
		expect(result.mapping.boards[0].cards.map((entry) => entry.id)).toEqual([null, null]);
		expect(storage.query().collections).toEqual([]);
		const holds = db.prepare('SELECT claims_json FROM migration_worker_holds').get() as {
			claims_json: string;
		};
		expect(JSON.parse(holds.claims_json)).toHaveLength(2);
		for (const table of ['reservations', 'runtime_owner', 'runs'])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
		const frozen = manifest();
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
	});

	it('keeps unfinished runs and unknown workers fenced even on otherwise valid collections', () => {
		const plan = planBoardMigration(
			input('uncertain', [
				{
					...card,
					id: 'running',
					status: 'running',
					runs: [{ attempt: 2, startedAt: time, workerAgentId: 'worker' }],
				},
				{ ...card, runs: [{ attempt: 3, startedAt: time }] },
			])
		);
		applyBoardMigration(db, plan);
		expect(storage.query().collections[0].board.cards.map((entry) => entry.status)).toEqual([
			'running',
			'todo',
		]);
		expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(2);
		expect(db.prepare('SELECT * FROM migration_worker_holds').all()).toHaveLength(1);
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
		expect(claim(plan.sourceKey)).toEqual({ ok: false, reason: 'migration-blocked' });
		expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
		const frozen = manifest();
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
	});

	it('rolls back every table on a late failure, then imports once; malformed input and repository conflicts preserve the first source', () => {
		const first = planBoardMigration(input('first'));
		applyBoardMigration(db, first);
		const second = planBoardMigration(input('second'));
		const frozen = manifest();
		expect(() =>
			applyBoardMigration(db, second, {
				beforeCommit: () => {
					throw new Error('late failure');
				},
			})
		).toThrow('late failure');
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		const conflict = input('second');
		conflict.repository!.id = 'first';
		expect(() => applyBoardMigration(db, planBoardMigration(conflict))).toThrow(
			'repository conflict'
		);
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		expect(() =>
			planBoardMigration({ ...input('broken'), boardBytes: Buffer.from('boards: [') })
		).toThrow();
		expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		expect(applyBoardMigration(db, second).status).toBe('imported');
		const imported = manifest();
		expect(applyBoardMigration(db, second).status).toBe('already-imported');
		expect(compareSqliteSnapshots(imported, manifest())).toEqual([]);
	});
});

describe('migration start intent', () => {
	it.each([
		{ board: { defaultStartMode: 'approval' }, fields: {} },
		{ board: { defaultStartMode: 'direct' }, fields: { startModeOverride: 'approval' } },
		{ board: { defaultStartMode: 'approval' }, fields: { capturePolicy: false } },
	])(
		'reads older misclassified import intent conservatively without changing the ledger: %j',
		({ board, fields }) => {
			const plan = planBoardMigration(input('old-policy', [{ ...card, ...fields }], board));
			// Reproduce a snapshot from the older planner which labeled every todo direct.
			plan.boards[0].cards[0].intent = 'legacy-direct';
			plan.boards[0].cards[0].blockers = [];
			applyBoardMigration(db, plan);
			db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
			const frozen = manifest();
			expect(claim(plan.sourceKey)).toEqual({ ok: false, reason: 'approval-required' });
			expect(applyBoardMigration(db, plan).status).toBe('already-imported');
			expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
			const projected = storage.query().collections[0].board;
			const edited = storage.save(BOARD_SOURCE_PROJECT_PREFIX + plan.sourceKey, [
				{
					...projected,
					cards: projected.cards.map((entry) => ({ ...entry, title: 'Edited title' })),
				},
			])[0];
			expect(edited.cards[0].capturePolicy).toMatchObject({
				effectiveStartMode: 'approval',
				dispatchApproval: 'required',
			});
			expect(claim(plan.sourceKey)).toEqual({ ok: false, reason: 'approval-required' });
		}
	);

	it('retains genuine old direct intent when only the default for future captures changes', () => {
		const plan = planBoardMigration(input('direct', [card], { defaultStartMode: 'direct' }));
		applyBoardMigration(db, plan);
		const collection = storage.workspace.readWorkspace().collections[0];
		storage.setStartPolicy(
			BOARD_SOURCE_PROJECT_PREFIX + plan.sourceKey,
			'same',
			collection.revision,
			'approval',
			true
		);
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
		expect(claim(plan.sourceKey).ok).toBe(true);
	});

	it.each([
		{
			board: { defaultStartMode: 'approval' },
			fields: {},
			intent: 'approval-required',
			claimable: false,
		},
		{
			board: { defaultStartMode: 'direct' },
			fields: { startModeOverride: 'approval' },
			intent: 'approval-required',
			claimable: false,
		},
		{
			board: { defaultStartMode: 'approval' },
			fields: { startModeOverride: 'direct' },
			intent: 'legacy-direct',
			claimable: true,
		},
		{ board: {}, fields: {}, intent: 'legacy-direct', claimable: true },
		{ board: {}, fields: { capturePolicy: false }, intent: 'approval-required', claimable: false },
		{
			board: {},
			fields: {
				capturePolicy: {
					effectiveStartMode: 'approval',
					dispatchApproval: 'required',
					specificationRevision: 0,
				},
			},
			intent: 'approval-required',
			claimable: false,
		},
		{
			board: {},
			fields: {
				capturePolicy: {
					effectiveStartMode: 'approval',
					dispatchApproval: 'granted',
					specificationRevision: 0,
					grant: { specificationRevision: 0, principal: 'fixture-human', grantedAt: time },
				},
			},
			intent: 'approval-required',
			claimable: true,
		},
	])(
		'preserves explicit policy and old direct intent: %j',
		({ board, fields, intent, claimable }) => {
			const plan = planBoardMigration(input('policy', [{ ...card, ...fields }], board));
			expect(plan.boards[0].cards[0].intent).toBe(intent);
			applyBoardMigration(db, plan);
			expect(storage.query().collections[0].board.cards[0]).toMatchObject(fields);
			db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 100)').run('fixture-owner');
			const result = claim(plan.sourceKey);
			if (claimable) expect(result.ok).toBe(true);
			else expect(result).toEqual({ ok: false, reason: 'approval-required' });
			const frozen = manifest();
			expect(applyBoardMigration(db, plan).status).toBe('already-imported');
			expect(compareSqliteSnapshots(frozen, manifest())).toEqual([]);
		}
	);
});
