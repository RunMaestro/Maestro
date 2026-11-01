import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fork, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade, configureBoardCaptureHost } from '../../../main/board/board-storage';
import {
	registerBoardWorker,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
	setBoardWorkerEnabled,
} from '../../../main/board/board-workspace-storage';
import type {
	BoardClaimCommand,
	BoardClaimHostContext,
	BoardClaimResult,
} from '../../../main/board/board-claims';
import { canonicalJson } from '../../../shared/canonicalJson';
import { generateUUID } from '../../../shared/uuid';
import type { BoardCard } from '../../../shared/board/types';

const fixtureRoot = path.resolve('.maestro/board-global-workers-20261031');
let bundleDir: string;
let bundle: string;
let dir: string;
let file: string;
let db: ReturnType<typeof openBoardDb>;
let facade: BoardStorageFacade;
let projects: string[];
let namespaces: string[];
let agents: { id: string; groupId: string }[];
let registryRevision: number;
let host: BoardClaimHostContext;

beforeAll(async () => {
	fs.mkdirSync(fixtureRoot, { recursive: true });
	bundleDir = fs.mkdtempSync(path.join(fixtureRoot, 'claims-bundle-'));
	bundle = path.join(bundleDir, 'claim-process.cjs');
	const sqliteModule =
		process.env.MAESTRO_TEST_SQLITE_MODULE ??
		createRequire(path.resolve('package.json')).resolve('better-sqlite3');
	await build({
		entryPoints: [path.resolve('src/__tests__/main/board/fixtures/board-claim-process.ts')],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
		plugins: [
			{
				name: 'fixture-sqlite',
				setup(builder) {
					builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
						path: sqliteModule,
						external: true,
					}));
				},
			},
		],
	});
});
afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot, 'claims-'));
	file = path.join(dir, 'board.sqlite');
	db = openBoardDb(file);
	facade = new BoardStorageFacade(db);
	projects = ['a', 'b'].map((name) => path.join(dir, name));
	namespaces = projects.map((project, index) => {
		fs.mkdirSync(project);
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: project },
			repository: { id: `repo-${index}`, workingDirectory: project, validated: true },
			profileBytes: Buffer.from(
				JSON.stringify({ profiles: [{ id: 'role', name: 'Work', model: 'role-model' }] })
			),
			workers: [],
			boardBytes: Buffer.from(
				JSON.stringify({
					boards: [
						{ id: 'board', name: 'Board', defaultStartMode: 'direct', maxInProgress: 2, cards: [] },
					],
				})
			),
		});
		applyBoardMigration(db, plan);
		return plan.profileNamespace;
	});
	agents = [
		{ id: 'worker', groupId: 'group' },
		{ id: 'other', groupId: 'group' },
		{ id: 'foreign', groupId: 'elsewhere' },
	];
	registryRevision = 1;
	configureBoardCaptureHost(() => ({ agents, groups: [{ id: 'group' }, { id: 'elsewhere' }] }));
	for (const agent of agents) {
		registerBoardWorker(db, agent.id);
		setBoardWorkerAccess(
			db,
			agent.id,
			namespaces.map((namespace) => ({ namespace, profileId: 'role' })),
			['repo-0', 'repo-1']
		);
	}
	for (let i = 0; i < 2; i++) capture(i, 'same');
	db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 0)').run('fixture-owner:boot:start');
	host = hostFor(0);
});
afterEach(() => {
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

function capture(index: number, id: string, extra: Partial<BoardCard> = {}) {
	const board = facade.read(projects[index], 'board');
	return facade.capture({
		projectRoot: projects[index],
		boardId: board.id,
		expectedRevision: board.storage!.expectedRevision!,
		card: {
			id,
			title: 'Work',
			body: 'Do work',
			parents: [],
			status: 'todo',
			createdAt: '2026-10-31T00:00:00Z',
			updatedAt: '2026-10-31T00:00:00Z',
			executionScope: { kind: 'group', groupId: 'group' },
			role: { namespace: namespaces[index], profileId: 'role' },
			repositoryId: `repo-${index}`,
			workingDirectory: projects[index],
			...extra,
		},
	});
}
function command(index = 0, workerAgentId = 'worker', cardId = 'same'): BoardClaimCommand {
	const board = facade.read(projects[index], 'board');
	const key = facade.workspace.resolveLegacyCollection(
		facade.resolveSourceKeys(projects[index]),
		board.id
	);
	const collection = facade.workspace.readCollection(key)!;
	return {
		...key,
		cardId,
		workerAgentId,
		requestId: generateUUID(),
		readRevision: {
			workspace: facade.workspace.readWorkspace().revision,
			collection: collection.revision,
			card: collection.cards.find((card) => card.cardId === cardId)!.revision,
			registry: registryRevision,
		},
	};
}
function hostFor(index: number): BoardClaimHostContext {
	const id = `repo-${index}`;
	const record = JSON.parse(
		(
			db.prepare('SELECT payload_json FROM repositories WHERE id = ?').get(id) as {
				payload_json: string;
			}
		).payload_json
	);
	return {
		owner: { processIdentity: 'fixture-owner:boot:start', epoch: 7 },
		registryRevision,
		dispatchEnabled: true,
		agentStates: Object.fromEntries(
			agents.map((agent) => [
				agent.id,
				{
					live: true,
					busy: false,
					location: { kind: 'local' },
					baseValues: { customModel: 'base-model', customEffort: 'medium' },
				},
			])
		),
		repository: {
			id,
			record,
			workingDirectory: projects[index],
			location: { kind: 'local' },
			identity: `git-common-dir:${projects[index]}`,
		},
	};
}
function claim(input = command()) {
	return facade.claim(input, () => host);
}
function state() {
	return canonicalJson(
		['workspace', 'collections', 'cards', 'workers', 'runs', 'reservations', 'commands'].map(
			(table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
		)
	);
}
function expectWaiting(reason: string, input = command()) {
	const before = state();
	expect(claim(input)).toEqual({ ok: false, reason });
	expect(state()).toBe(before);
}
function patchCard(patch: Record<string, unknown>) {
	const key = command();
	const card = facade.workspace.readCard(key)!;
	db.prepare('UPDATE cards SET payload_json = ? WHERE collection_key = ? AND id = ?').run(
		canonicalJson({ ...card.payload, ...patch }),
		key.collectionKey,
		key.cardId
	);
}

describe('persistent global Board claims over real SQLite', () => {
	it('commits a prepared run, immutable specification, token and exclusive worker together; replay is idempotent', () => {
		const input = command();
		const result = claim(input);
		expect(result).toMatchObject({
			ok: true,
			attempt: 1,
			runToken: { ownerEpoch: 7, generation: 1 },
		});
		expect(claim(input)).toEqual(result);
		expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
		const reservation = db.prepare('SELECT * FROM reservations').get();
		if (!result.ok) throw new Error('claim failed');
		expect(reservation).toMatchObject({
			run_id: result.runToken.runId,
			collection_key: input.collectionKey,
			worker_agent_id: 'worker',
			phase: 'prepared',
			generation: 1,
		});
		const row = db.prepare('SELECT specification_json, outcome_json FROM runs').get() as {
			specification_json: string;
			outcome_json: null;
		};
		const specification = JSON.parse(row.specification_json);
		expect(specification).toMatchObject({
			key: {
				...facade.workspace.resolveLegacyCollection(facade.resolveSourceKeys(projects[0]), 'board'),
				cardId: 'same',
			},
			card: {
				executionScope: { kind: 'group', groupId: 'group' },
				role: { namespace: namespaces[0], profileId: 'role' },
			},
			membership: { id: 'worker', groupId: 'group' },
			readRevision: input.readRevision,
			runToken: result.runToken,
			overrides: { customModel: 'role-model', customEffort: 'medium' },
			repository: { id: 'repo-0' },
		});
		expect(row.outcome_json).toBeNull();
		expect(facade.read(projects[0], 'board').cards[0]).toMatchObject({ status: 'todo' });
		expect(facade.read(projects[0], 'board').cards[0].runs).toBeUndefined();
		expectWaiting('request-conflict', { ...input, workerAgentId: 'other' });
		expectWaiting('card-claimed', { ...input, requestId: generateUUID(), workerAgentId: 'other' });
		host = hostFor(1);
		expectWaiting('worker-busy', command(1));
	});

	it.each(['workspace', 'collection', 'card', 'registry'] as const)(
		'rejects stale %s read revisions without partial writes',
		(field) => {
			const input = command();
			input.readRevision[field]++;
			expectWaiting('stale-revision', input);
		}
	);
	it('reads membership and availability again inside the writer transaction without fallback', () => {
		const input = command();
		agents[0].groupId = 'elsewhere'; // same supplied revision cannot authorize a departed member
		expectWaiting('worker-outside-scope', input);
		agents[0].groupId = 'group';
		host.agentStates.worker.busy = true;
		expectWaiting('worker-busy');
		host.agentStates.worker.busy = false;
		host.agentStates.worker.live = false;
		expectWaiting('worker-dormant');
	});
	it.each(['disabled', 'paused', 'role', 'repository', 'unregistered'] as const)(
		'enforces Board-owned worker %s constraints, even when pinned',
		(kind) => {
			patchCard({ assigneeAgentId: 'worker' });
			if (kind === 'disabled') setBoardWorkerEnabled(db, 'worker', false);
			if (kind === 'paused') setBoardWorkerPaused(db, 'worker', true);
			if (kind === 'role') setBoardWorkerAccess(db, 'worker', [], ['repo-0']);
			if (kind === 'repository')
				setBoardWorkerAccess(
					db,
					'worker',
					[{ namespace: namespaces[0], profileId: 'role' }],
					['repo-1']
				);
			if (kind === 'unregistered')
				db.prepare('DELETE FROM workers WHERE agent_id = ?').run('worker');
			expectWaiting(
				{
					disabled: 'worker-disabled',
					paused: 'worker-paused',
					role: 'worker-role-mismatch',
					repository: 'worker-repository-mismatch',
					unregistered: 'worker-unregistered',
				}[kind]
			);
		}
	);
	it('does not borrow an agent or namespaced role from another scope/source', () => {
		expectWaiting('worker-outside-scope', command(0, 'foreign'));
		patchCard({ executionScope: { kind: 'agent', agentId: 'other' } });
		expectWaiting('worker-outside-scope');
		patchCard({ executionScope: { kind: 'group', groupId: 'group' }, assigneeAgentId: 'foreign' });
		expectWaiting('scope-conflict');
		patchCard({ assigneeAgentId: undefined, role: { namespace: 'absent', profileId: 'role' } });
		expectWaiting('role-missing');
	});
	it('rejects stale repository preparation and mismatched execution location', () => {
		host.repository!.workingDirectory = projects[1];
		expectWaiting('repository-unresolved');
		host = hostFor(0);
		db.prepare('UPDATE repositories SET payload_json = ? WHERE id = ?').run(
			canonicalJson({ ...host.repository!.record, changed: true }),
			'repo-0'
		);
		expectWaiting('repository-unresolved');
		host = hostFor(0);
		host.agentStates.worker.location = { kind: 'ssh', remoteId: 'remote' };
		expectWaiting('worker-location-mismatch');
	});
	it('keeps migration blockers and global worker holds authoritative', () => {
		const input = command();
		db.prepare('UPDATE migration_blockers SET payload_json = ? WHERE source_key = ?').run(
			'[{"reasons":["uncertain"]}]',
			input.sourceKey
		);
		expectWaiting('migration-blocked');
		db.prepare('DELETE FROM migration_blockers WHERE source_key = ?').run(input.sourceKey);
		db.prepare('INSERT INTO migration_worker_holds VALUES (?, ?)').run(
			'worker',
			'[{"uncertain":true}]'
		);
		expectWaiting('worker-held');
	});
	it('requires the persisted specification-bound human grant; status alone never grants approval', () => {
		const policy = {
			effectiveStartMode: 'approval',
			specificationRevision: command().readRevision.card,
			dispatchApproval: 'required',
		};
		patchCard({ status: 'ready', capturePolicy: policy });
		expectWaiting('approval-required');
		patchCard({
			capturePolicy: {
				...policy,
				dispatchApproval: 'granted',
				grant: { specificationRevision: 999, principal: 'human', grantedAt: '2026-10-31' },
			},
		});
		expectWaiting('approval-required');
		patchCard({
			capturePolicy: {
				...policy,
				dispatchApproval: 'granted',
				grant: {
					specificationRevision: policy.specificationRevision,
					principal: 'human',
					grantedAt: '2026-10-31',
				},
			},
		});
		expect(claim()).toMatchObject({ ok: true });
	});
	it('holds, dependency state, triage and human review block even authorized direct cards', () => {
		patchCard({ heldByUser: true });
		expectWaiting('held');
		patchCard({ heldByUser: false, parents: ['absent'] });
		expectWaiting('dependency');
		patchCard({ parents: [], status: 'triage' });
		expectWaiting('card-not-ready');
		patchCard({ status: 'review' });
		expectWaiting('card-not-ready');
		patchCard({ status: 'todo' });
		expect(claim()).toMatchObject({ ok: true });
	});
	it('does not acquire or steal an owner, including a stale heartbeat', () => {
		host.owner.epoch++;
		expectWaiting('owner-conflict');
		host = hostFor(0);
		host.owner.processIdentity = 'another-process';
		expectWaiting('owner-conflict');
		host = hostFor(0);
		host.dispatchEnabled = false;
		expectWaiting('runtime-unavailable');
		host = hostFor(0);
		db.prepare('DELETE FROM runtime_owner').run();
		expectWaiting('owner-conflict');
	});
	it('rolls back every write on an actual SQLite failure after inserting the run and reservation', () => {
		const before = state();
		db.exec(
			"CREATE TRIGGER fail_claim BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END"
		);
		expect(() => claim()).toThrow('injected claim failure');
		expect(state()).toBe(before);
		db.exec('DROP TRIGGER fail_claim');
		expect(claim()).toMatchObject({ ok: true, attempt: 1 });
		expect(db.pragma('foreign_key_check')).toEqual([]);
	});
	it('returns retryable SQLite busy without any partial claim', () => {
		const lock = openBoardDb(file);
		const before = state();
		db.pragma('busy_timeout = 10');
		try {
			lock.exec('BEGIN IMMEDIATE');
			expectWaiting('storage-busy');
			expect(state()).toBe(before);
		} finally {
			lock.exec('ROLLBACK');
			lock.close();
		}
	});
	it.each(['prepared', 'starting', 'running', 'stopping', 'uncertain'])(
		'counts %s reservations toward global WIP across projects',
		(phase) => {
			db.prepare('UPDATE workspace SET global_wip_limit = 1').run();
			expect(claim()).toMatchObject({ ok: true });
			db.prepare('UPDATE reservations SET phase = ?').run(phase);
			host = hostFor(1);
			expectWaiting('global-wip', command(1, 'other'));
		}
	);
	it('enforces the collection WIP cap with distinct free workers', () => {
		capture(0, 'second');
		const key = command();
		db.prepare(
			"UPDATE collections SET payload_json = json_set(payload_json, '$.maxInProgress', 1) WHERE collection_key = ?"
		).run(key.collectionKey);
		expect(claim()).toMatchObject({ ok: true });
		expectWaiting('collection-wip', command(0, 'other', 'second'));
	});
	it('allows independent claims in two projects with colliding legacy card IDs and free capacity', async () => {
		const results = await race([command(), command(1, 'other')], [hostFor(0), hostFor(1)]);
		expect(results.every((entry) => entry.result.ok)).toBe(true);
		const reservations = db
			.prepare('SELECT collection_key, card_id, worker_agent_id FROM reservations')
			.all() as { collection_key: string; card_id: string; worker_agent_id: string }[];
		expect(new Set(reservations.map((entry) => entry.collection_key)).size).toBe(2);
		expect(reservations.map((entry) => entry.card_id)).toEqual(['same', 'same']);
		expect(new Set(reservations.map((entry) => entry.worker_agent_id)).size).toBe(2);
	});
	it('allocates the next attempt from durable history and survives reopening the database', () => {
		const input = command();
		db.prepare(
			'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json, outcome_json) VALUES (?, ?, ?, 4, ?, ?)'
		).run(
			'historical-completed-run',
			input.collectionKey,
			input.cardId,
			'{}',
			'{"outcome":"done"}'
		);
		const result = claim(input);
		expect(result).toMatchObject({ ok: true, attempt: 5, runToken: { generation: 5 } });
		db.close();
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		expect(claim(input)).toEqual(result);
		expectWaiting('card-claimed', command(0, 'other'));
	});
	it('rejects a foreign source/collection pair without resolving a colliding bare card ID', () => {
		const input = { ...command(), sourceKey: command(1).sourceKey };
		const before = state();
		expect(() => claim(input)).toThrow('Collection belongs to another source');
		expect(state()).toBe(before);
	});
	it('preserves actual migrated direct intent without inventing a new approval gate', () => {
		const project = path.join(dir, 'legacy');
		fs.mkdirSync(project);
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: project },
			repository: { id: 'legacy-repo', workingDirectory: project, validated: true },
			boardBytes: Buffer.from(
				JSON.stringify({
					boards: [
						{
							id: 'board',
							name: 'Legacy',
							cards: [
								{
									id: 'same',
									title: 'Existing direct work',
									body: '',
									parents: [],
									status: 'todo',
									assigneeAgentId: 'worker',
									createdAt: '2026-10-31',
									updatedAt: '2026-10-31',
								},
							],
						},
					],
				})
			),
			profileBytes: Buffer.from('{"profiles":[]}'),
			workers: [],
		});
		applyBoardMigration(db, plan);
		const key = facade.workspace.resolveLegacyCollection([plan.sourceKey], 'board');
		const collection = facade.workspace.readCollection(key)!;
		setBoardWorkerAccess(db, 'worker', [], ['legacy-repo']);
		host.repository = {
			id: 'legacy-repo',
			workingDirectory: project,
			record: plan.repository!,
			location: { kind: 'local' },
			identity: 'legacy-git-common-dir',
		};
		const input: BoardClaimCommand = {
			...key,
			cardId: 'same',
			workerAgentId: 'worker',
			requestId: generateUUID(),
			readRevision: {
				workspace: facade.workspace.readWorkspace().revision,
				card: collection.cards[0].revision,
				collection: collection.revision,
				registry: registryRevision,
			},
		};
		expect(claim(input)).toMatchObject({ ok: true, attempt: 1 });
	});
	it('invalidates an approval after a real specification edit through the capture facade', () => {
		const revision = command().readRevision.card;
		patchCard({
			capturePolicy: {
				effectiveStartMode: 'approval',
				specificationRevision: revision,
				dispatchApproval: 'granted',
				grant: { specificationRevision: revision, principal: 'human', grantedAt: '2026-10-31' },
			},
		});
		const board = facade.read(projects[0], 'board');
		capture(0, 'same', { ...board.cards[0], body: 'Changed scope of work' });
		expect(facade.read(projects[0], 'board').cards[0].capturePolicy).toMatchObject({
			dispatchApproval: 'required',
		});
		expectWaiting('approval-required');
	});
	it.each(['same-card', 'same-worker', 'global-wip', 'collection-wip'] as const)(
		'two separate processes compete atomically: %s',
		async (kind) => {
			capture(0, 'second');
			if (kind === 'global-wip') db.prepare('UPDATE workspace SET global_wip_limit = 1').run();
			if (kind === 'collection-wip')
				db.prepare(
					"UPDATE collections SET payload_json = json_set(payload_json, '$.maxInProgress', 1)"
				).run();
			const first = command();
			const second =
				kind === 'same-card'
					? command(0, 'other')
					: kind === 'collection-wip'
						? command(0, 'other', 'second')
						: command(1, kind === 'same-worker' ? 'worker' : 'other');
			const results = await race(
				[first, second],
				[hostFor(0), hostFor(kind === 'same-card' || kind === 'collection-wip' ? 0 : 1)]
			);
			expect(new Set(results.map((entry) => entry.pid)).size).toBe(2);
			expect(results.filter((entry) => entry.result.ok)).toHaveLength(1);
			expect(results.find((entry) => !entry.result.ok)!.result).toEqual({
				ok: false,
				reason: {
					'same-card': 'card-claimed',
					'same-worker': 'worker-busy',
					'global-wip': 'global-wip',
					'collection-wip': 'collection-wip',
				}[kind],
			});
			expect(db.prepare('SELECT count(*) AS n FROM reservations').get()).toEqual({ n: 1 });
			expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
			expect(db.prepare('SELECT count(*) AS n FROM commands').get()).toEqual({ n: 1 });
			expect(db.pragma('foreign_key_check')).toEqual([]);
		}
	);
});

async function race(commands: BoardClaimCommand[], hosts: BoardClaimHostContext[]) {
	const children: ChildProcess[] = [];
	try {
		const pending = commands.map((input, index) => {
			const child = fork(bundle, [], {
				execPath: process.execPath,
				execArgv: [],
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			});
			children.push(child);
			let stderr = '';
			child.stderr!.on('data', (chunk) => {
				stderr += chunk;
			});
			let readyResolve: () => void;
			const ready = new Promise<void>((resolve) => {
				readyResolve = resolve;
			});
			const result = new Promise<{ pid: number; result: BoardClaimResult }>((resolve, reject) => {
				let output: { pid: number; result: BoardClaimResult } | undefined;
				child.on('error', reject);
				child.on(
					'message',
					(message: { ready?: boolean; error?: string; pid: number; result: BoardClaimResult }) => {
						if (message.ready) readyResolve();
						else if (message.error) reject(new Error(message.error));
						else output = message;
					}
				);
				child.once('exit', (code) => {
					if (code === 0 && output) resolve(output);
					else reject(new Error(`Claim subprocess exited ${code}: ${stderr}`));
				});
			});
			child.send({
				file,
				command: input,
				host: { ...hosts[index], catalog: facade.captureCatalog() },
			});
			return { ready, result };
		});
		await Promise.race([
			Promise.all(pending.map((entry) => entry.ready)),
			Promise.all(pending.map((entry) => entry.result)),
		]);
		children.forEach((child) => child.send('claim'));
		return await Promise.all(pending.map((entry) => entry.result));
	} finally {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

it('re-evaluates ordinary imported policy/holds without freezing unrelated direct cards', () => {
	const project = path.join(dir, 'legacy');
	fs.mkdirSync(project);
	const legacy = (id: string, status: string, extra = {}) => ({
		id,
		title: id,
		body: '',
		parents: [],
		status,
		assigneeAgentId: 'worker',
		...extra,
	});
	const plan = planBoardMigration({
		source: { location: { kind: 'local' }, path: project },
		repository: { id: 'repo-0', workingDirectory: projects[0], validated: true },
		profileBytes: null,
		workers: [],
		boardBytes: Buffer.from(
			JSON.stringify({
				boards: [
					{
						id: 'board',
						name: 'Imported',
						maxInProgress: 3,
						cards: [
							legacy('clean', 'todo'),
							legacy('held', 'todo', { heldByUser: true, assigneeAgentId: 'other' }),
							legacy('done', 'done'),
							legacy('triage', 'triage'),
							legacy('review', 'review'),
						],
					},
				],
			})
		),
	});
	applyBoardMigration(db, plan);
	projects.push(project);
	const ledger = db
		.prepare('SELECT payload_json FROM migration_blockers WHERE source_key=?')
		.get(plan.sourceKey);
	expect(facade.claim(command(2, 'other', 'held'), () => host)).toMatchObject({
		ok: false,
		reason: 'held',
	});
	const held = command(2, 'other', 'held');
	facade.setIdleHold(held, held.readRevision.collection, held.readRevision.card, false);
	expect(facade.claim(command(2, 'other', 'held'), () => host).ok).toBe(true);
	expect(facade.claim(command(2, 'worker', 'clean'), () => host).ok).toBe(true);
	expect(facade.claim(command(2, 'foreign', 'triage'), () => host).ok).toBe(false);
	expect(facade.claim(command(2, 'foreign', 'review'), () => host).ok).toBe(false);
	expect(
		db.prepare('SELECT payload_json FROM migration_blockers WHERE source_key=?').get(plan.sourceKey)
	).toEqual(ledger);
	expect(
		db.prepare('SELECT snapshot FROM migrations WHERE source_key=?').get(plan.sourceKey)
	).toEqual({ snapshot: Buffer.from(canonicalJson(plan)) });
});

it.each([
	'invalid-card',
	'duplicate-card-id',
	'running-worker-unknown',
	'reconciliation-required',
	'future-unknown-reason',
])('retains source safety fence %s', (reason) => {
	const key = command();
	db.prepare('UPDATE migration_blockers SET payload_json=? WHERE source_key=?').run(
		JSON.stringify([{ board: 0, card: 1, reasons: [reason] }]),
		key.sourceKey
	);
	expect(facade.claim(command(), () => host)).toMatchObject({
		ok: false,
		reason: 'migration-blocked',
	});
	expect(db.prepare('SELECT count(*) AS n FROM reservations').get()).toEqual({ n: 0 });
});
