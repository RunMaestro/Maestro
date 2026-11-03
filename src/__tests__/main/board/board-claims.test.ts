import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { BoardRegistryRevision } from '../../../main/board/board-registry-revision';
import { build } from 'esbuild';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade, configureBoardCaptureHost } from '../../../main/board/board-storage';
import {
	listBoardWorkers,
	setBoardWorkerOptions,
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
import { claimBoardCard, type BoardRunSpecification } from '../../../main/board/board-claims';
import { resolveProfileSpawnOverrides } from '../../../shared/profiles/types';
import { canonicalJson } from '../../../shared/canonicalJson';
import { generateUUID } from '../../../shared/uuid';
import { BOARD_SOURCE_PROJECT_PREFIX, type BoardCard } from '../../../shared/board/types';

const fixtureRoot = os.tmpdir();
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

describe('fresh complete registry fence inside the real claim transaction', () => {
	it.each([
		'agent',
		'membership',
		'group',
		'registration',
		'worker-options',
		'pause',
		'pin',
		'claim',
		'revision',
		'permission',
		'approval',
		'disabled',
		'external-config',
		'external-membership',
		'external-worker',
	] as const)('matches the original refusal after an intervening %s change', (change) => {
		const registerFile = path.join(dir, 'live-registers.json');
		fs.writeFileSync(
			registerFile,
			JSON.stringify({ agents, groups: [{ id: 'group' }, { id: 'elsewhere' }], configs: {} })
		);
		const readRegisters = () =>
			JSON.parse(fs.readFileSync(registerFile, 'utf8')) as {
				agents: typeof agents;
				groups: { id: string }[];
				configs: Record<string, unknown>;
			};
		configureBoardCaptureHost(readRegisters);
		const inputs = () => {
			const registers = readRegisters();
			return {
				catalog: facade.captureCatalog(),
				agents: registers.agents,
				groups: registers.groups,
				workers: listBoardWorkers(db),
				agentConfigs: registers.configs,
				sshRemotes: [],
			};
		};
		const tracker = new BoardRegistryRevision();
		let oldFingerprint = '';
		let oldRevision = 0;
		const original = () => {
			const fingerprint = canonicalJson(inputs());
			if (fingerprint !== oldFingerprint) {
				oldFingerprint = fingerprint;
				oldRevision++;
			}
			return oldRevision;
		};
		const input = command();
		input.readRevision.registry = original();
		expect(tracker.observe(inputs())).toBe(input.readRevision.registry);
		if (change === 'agent' || change === 'membership' || change === 'group') {
			const registers = readRegisters();
			if (change === 'agent') registers.agents = registers.agents.filter((a) => a.id !== 'worker');
			if (change === 'membership') registers.agents[0].groupId = 'elsewhere';
			if (change === 'group') registers.groups = [{ id: 'elsewhere' }];
			fs.writeFileSync(registerFile, JSON.stringify(registers));
		}
		if (change === 'registration') db.prepare('DELETE FROM workers WHERE agent_id=?').run('worker');
		if (change === 'pause') setBoardWorkerPaused(db, 'worker', true);
		if (change === 'permission') setBoardWorkerAccess(db, 'worker', [], []);
		if (change === 'worker-options') {
			const worker = listBoardWorkers(db).find((w) => w.agentId === 'worker')!;
			setBoardWorkerOptions(db, 'worker', canonicalJson(worker.payload), {
				customArgs: '--changed',
			});
		}
		if (change === 'pin') patchCard({ assigneeAgentId: 'foreign' });
		if (change === 'approval')
			patchCard({
				capturePolicy: {
					effectiveStartMode: 'approval',
					dispatchApproval: 'required',
					specificationRevision: 1,
				},
			});
		if (change === 'disabled') host.dispatchEnabled = false;
		if (change === 'revision')
			db.prepare('UPDATE cards SET revision=revision+1 WHERE collection_key=?').run(
				input.collectionKey
			);
		if (change === 'claim') {
			expect(facade.claim({ ...input, requestId: 'competing-claim' }, () => host).ok).toBe(true);
		}
		if (change === 'external-config' || change === 'external-membership') {
			// A separate OS process commits the registry edit before claim enters IMMEDIATE.
			execFileSync(process.execPath, [
				'-e',
				`
				const fs = require('node:fs'); const file = process.argv[1];
				const value = JSON.parse(fs.readFileSync(file, 'utf8'));
				if (process.argv[2] === 'external-config') value.configs.codex = { customArgs: '--external' };
				else value.agents[0].groupId = 'elsewhere';
				fs.writeFileSync(file + '.next', JSON.stringify(value)); fs.renameSync(file + '.next', file);
			`,
				registerFile,
				change,
			]);
		}
		if (change === 'external-worker') {
			const sqliteModule =
				process.env.MAESTRO_TEST_SQLITE_MODULE ??
				createRequire(path.resolve('package.json')).resolve('better-sqlite3');
			execFileSync(process.execPath, [
				'-e',
				`
				const db = new (require(process.argv[1]))(process.argv[2]);
				db.prepare('UPDATE workers SET paused=1 WHERE agent_id=?').run('worker'); db.close();
			`,
				sqliteModule,
				file,
			]);
		}
		const before = state();
		const context = (registry: number) => {
			expect(db.inTransaction).toBe(true);
			return { ...host, registryRevision: registry };
		};
		const oldResult = facade.claim(input, () => context(original()));
		const newResult = facade.claim(input, () => context(tracker.observe(inputs())));
		expect(newResult).toEqual(oldResult);
		expect(newResult.ok).toBe(false);
		expect(state()).toBe(before);
	});

	it.each(['original', 'incremental'] as const)(
		'retains unchanged %s prepared RunSpecs on revalidation',
		(mode) => {
			const tracker = new BoardRegistryRevision();
			const inputs = () => ({
				catalog: facade.captureCatalog(),
				agents,
				groups: [{ id: 'group' }],
				workers: listBoardWorkers(db),
				agentConfigs: {},
				sshRemotes: [],
			});
			const fingerprint = canonicalJson(inputs());
			const observe = () =>
				mode === 'incremental'
					? tracker.observe(inputs())
					: canonicalJson(inputs()) === fingerprint
						? 1
						: 2;
			const input = command();
			input.readRevision.registry = observe();
			const result = facade.claim(input, () => ({ ...host, registryRevision: observe() }));
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('Expected claim');
			const row = db
				.prepare('SELECT specification_json FROM runs WHERE run_id=?')
				.get(result.runToken.runId) as { specification_json: string };
			const spec = JSON.parse(row.specification_json) as BoardRunSpecification;
			expect(spec.readRevision.registry).toBe(1);
			expect(
				claimBoardCard(
					db,
					input,
					() => ({ ...host, registryRevision: observe(), catalog: facade.captureCatalog() }),
					spec
				).ok
			).toBe(true);
			expect(
				db.prepare('SELECT specification_json FROM runs WHERE run_id=?').get(result.runToken.runId)
			).toEqual(row);
		}
	);
});

describe('persistent global Board claims over real SQLite', () => {
	it('uses a role created in an empty store, with approval, role, group and stale-read fences intact', () => {
		db.close();
		file = path.join(dir, 'fresh.sqlite');
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		expect(facade.captureCatalog().profiles).toEqual([]);
		const role = facade.createRole('Reviewer');
		const global = facade.ensureGlobalBoard();
		const root = BOARD_SOURCE_PROJECT_PREFIX + global.storage!.sourceKey;
		// Explicit host repository evidence is independent of role creation/capture.
		db.prepare('INSERT INTO repositories VALUES (?, ?)').run(
			'repo-0',
			canonicalJson({ id: 'repo-0', workingDirectory: projects[0], validated: true })
		);
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 0)').run('fixture-owner:boot:start');
		for (const agent of agents) {
			registerBoardWorker(db, agent.id);
			setBoardWorkerAccess(db, agent.id, [], ['repo-0']);
		}
		facade.setWorkerRole('worker', role, true);
		facade.setWorkerRole('foreign', role, true);
		const captured = facade.capture({
			projectRoot: root,
			boardId: global.id,
			expectedRevision: global.storage!.expectedRevision!,
			card: {
				id: 'fresh',
				title: 'Review',
				body: '',
				parents: [],
				status: 'todo',
				createdAt: '',
				updatedAt: '',
				executionScope: { kind: 'group', groupId: 'group' },
				role,
				repositoryId: 'repo-0',
				workingDirectory: projects[0],
			},
		});
		db.close();
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		host = hostFor(0);
		const input = (workerAgentId: string): BoardClaimCommand => {
			const collection = facade.workspace.readCollection(global.storage!)!;
			return {
				sourceKey: global.storage!.sourceKey,
				collectionKey: global.storage!.collectionKey,
				cardId: 'fresh',
				workerAgentId,
				requestId: generateUUID(),
				readRevision: {
					workspace: facade.workspace.readWorkspace().revision,
					collection: collection.revision,
					card: collection.cards[0].revision,
					registry: registryRevision,
				},
			};
		};
		expect(facade.read(root, global.id).cards[0].role).toEqual(role);
		expectWaiting('approval-required', input('worker'));
		facade.capture(
			{
				projectRoot: root,
				boardId: global.id,
				expectedRevision: captured.storage!.expectedRevision!,
				card: { ...facade.read(root, global.id).cards[0], startModeOverride: 'direct' },
			},
			true
		);
		expectWaiting('worker-role-mismatch', input('other'));
		expectWaiting('worker-outside-scope', input('foreign'));
		const stale = input('worker');
		facade.setWorkerRole('worker', role, false);
		expectWaiting('stale-revision', stale);
		expectWaiting('worker-role-mismatch', input('worker'));
		facade.setWorkerRole('worker', role, true);
		setBoardWorkerPaused(db, 'worker', true);
		expectWaiting('worker-paused', input('worker'));
		setBoardWorkerPaused(db, 'worker', false);
		expect(claim(input('worker')).ok).toBe(true);
		const spec = JSON.parse(
			(db.prepare('SELECT specification_json FROM runs').get() as { specification_json: string })
				.specification_json
		);
		expect(spec).toMatchObject({
			role,
			workerAgentId: 'worker',
			membership: { id: 'worker', groupId: 'group' },
		});
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual([]);
	});
	it('reloads a new global role requirement and claims only the exact role inside the current group', () => {
		const global = facade.ensureGlobalBoard();
		const root = BOARD_SOURCE_PROJECT_PREFIX + global.storage!.sourceKey;
		const role = { namespace: namespaces[1], profileId: 'role' };
		const profiles = db.prepare('SELECT * FROM profiles ORDER BY profile_namespace, id').all();
		facade.capture(
			{
				projectRoot: root,
				boardId: global.id,
				expectedRevision: global.storage!.expectedRevision!,
				card: {
					id: 'new-role-card',
					title: 'Role within group',
					body: '',
					parents: [],
					status: 'todo',
					createdAt: '',
					updatedAt: '',
					executionScope: { kind: 'group', groupId: 'group' },
					role,
					assigneeProfileId: role.profileId,
					repositoryId: 'repo-0',
					workingDirectory: projects[0],
					startModeOverride: 'direct',
				},
			},
			true
		);
		db.close();
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		expect(facade.read(root, global.id).cards[0]).toMatchObject({
			role,
			assigneeProfileId: 'role',
		});
		const key = global.storage!;
		const input = (workerAgentId: string): BoardClaimCommand => {
			const collection = facade.workspace.readCollection(key)!;
			return {
				sourceKey: key.sourceKey,
				collectionKey: key.collectionKey,
				cardId: 'new-role-card',
				workerAgentId,
				requestId: generateUUID(),
				readRevision: {
					workspace: facade.workspace.readWorkspace().revision,
					collection: collection.revision,
					card: collection.cards[0].revision,
					registry: registryRevision,
				},
			};
		};
		// Same legacy id from another source is not the requested role.
		setBoardWorkerAccess(
			db,
			'other',
			[{ namespace: namespaces[0], profileId: 'role' }],
			['repo-0']
		);
		expectWaiting('worker-role-mismatch', input('other'));
		expectWaiting('worker-outside-scope', input('foreign'));
		setBoardWorkerPaused(db, 'worker', true);
		expectWaiting('worker-paused', input('worker'));
		setBoardWorkerPaused(db, 'worker', false);
		agents = agents.map((agent) =>
			agent.id === 'worker' ? { ...agent, groupId: 'elsewhere' } : agent
		);
		expectWaiting('worker-outside-scope', input('worker'));
		agents = agents.map((agent) =>
			agent.id === 'worker' ? { ...agent, groupId: 'group' } : agent
		);
		expect(claim(input('worker')).ok).toBe(true);
		const spec = JSON.parse(
			(
				db
					.prepare('SELECT specification_json FROM runs WHERE card_id = ?')
					.get('new-role-card') as { specification_json: string }
			).specification_json
		);
		expect(spec).toMatchObject({
			role,
			workerAgentId: 'worker',
			membership: { id: 'worker', groupId: 'group' },
			executionOptions: { legacyProfile: { ...role, payload: { model: 'role-model' } } },
		});
		expect(db.prepare('SELECT * FROM profiles ORDER BY profile_namespace, id').all()).toEqual(
			profiles
		);
	});

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

	it('isolates worker edits from a shared profile, other workers, snapshots and historical runs; persists across reload', () => {
		const historical = claim();
		expect(historical.ok).toBe(true);
		const historyBefore = db.prepare('SELECT * FROM runs').all();
		const profilesBefore = db.prepare('SELECT * FROM profiles').all();
		const migrationsBefore = db.prepare('SELECT * FROM migrations').all();
		const bBefore = db.prepare('SELECT * FROM workers WHERE agent_id = ?').get('other');
		const a = listBoardWorkers(db).find((w) => w.agentId === 'worker')!;
		setBoardWorkerOptions(db, 'worker', canonicalJson(a.payload), {
			customModel: 'worker-A-model',
			customEffort: 'high',
			appendSystemPrompt: 'A role',
			customArgs: '--a "quoted value"',
		});
		expect(db.prepare('SELECT * FROM workers WHERE agent_id = ?').get('other')).toEqual(bBefore);
		expect(db.prepare('SELECT * FROM profiles').all()).toEqual(profilesBefore);
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual(migrationsBefore);
		expect(db.prepare('SELECT * FROM runs').all()).toEqual(historyBefore);
		const stored = listBoardWorkers(db).find((w) => w.agentId === 'worker')!;
		db.close();
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		expect(listBoardWorkers(db).find((w) => w.agentId === 'worker')).toEqual(stored);
		// A second card has no profile, and still receives all four worker options.
		db.prepare('DELETE FROM reservations').run();
		capture(1, 'no-profile', { role: undefined, assigneeProfileId: undefined });
		host = hostFor(1);
		const result = claim(command(1, 'worker', 'no-profile'));
		expect(result.ok).toBe(true);
		const spec = JSON.parse(
			(
				db
					.prepare('SELECT specification_json FROM runs WHERE run_id = ?')
					.get(result.ok ? result.runToken.runId : '') as { specification_json: string }
			).specification_json
		);
		expect(spec.overrides).toEqual(stored.payload.executionOptions);
		expect(spec.executionOptions.worker).toEqual(stored);
		expect(spec.executionOptions.legacyProfile).toBeUndefined();
	});

	it('resolves the exact namespaced legacy source and all fields without flattening multiple granted profiles', () => {
		const profile = {
			id: 'role',
			name: 'Work',
			model: 'legacy-model',
			effort: 'low',
			appendSystemPrompt: 'legacy role',
			customArgs: '--legacy',
			future: { keep: ['unknown', 1] },
		};
		db.prepare('UPDATE profiles SET payload_json = ? WHERE profile_namespace = ?').run(
			canonicalJson(profile),
			namespaces[0]
		);
		patchCard({ assigneeProfileId: 'role', profileNamespace: namespaces[0] });
		const worker = listBoardWorkers(db).find((entry) => entry.agentId === 'worker')!;
		setBoardWorkerOptions(db, 'worker', canonicalJson(worker.payload), {
			customModel: 'explicit-worker-model',
		});
		const result = claim();
		expect(result.ok).toBe(true);
		const spec = JSON.parse(
			(db.prepare('SELECT specification_json FROM runs').get() as { specification_json: string })
				.specification_json
		);
		expect(spec.overrides).toEqual({
			...resolveProfileSpawnOverrides(profile, host.agentStates.worker.baseValues),
			customModel: 'explicit-worker-model',
		});
		expect(spec.profile).toEqual(profile);
		expect(spec.executionOptions.legacyProfile).toMatchObject({
			namespace: namespaces[0],
			profileId: 'role',
			payload: profile,
			sourceKey: command().sourceKey,
		});
		expect(spec.executionOptions.worker.payload.roleRefs).toHaveLength(2);
	});

	it.each(['worker', 'profile', 'base', 'source'] as const)(
		'rejects changed %s provenance after Prepare even with the same registry revision',
		(changed) => {
			const result = claim();
			if (!result.ok) throw new Error('claim failed');
			const spec = JSON.parse(
				(db.prepare('SELECT specification_json FROM runs').get() as { specification_json: string })
					.specification_json
			) as BoardRunSpecification;
			if (changed === 'worker') {
				const worker = listBoardWorkers(db).find((w) => w.agentId === 'worker')!;
				setBoardWorkerOptions(db, 'worker', canonicalJson(worker.payload), {
					customArgs: '--changed',
				});
			}
			if (changed === 'profile')
				db.prepare(
					"UPDATE profiles SET payload_json=json_set(payload_json, '$.future', 'changed') WHERE profile_namespace=?"
				).run(namespaces[0]);
			if (changed === 'source')
				db.prepare('UPDATE profiles SET source_key=? WHERE profile_namespace=?').run(
					'changed-source',
					namespaces[0]
				);
			if (changed === 'base')
				host.agentStates.worker.baseValues = {
					customModel: 'shadowed-change',
					customEffort: 'medium',
				};
			const before = state();
			expect(
				claimBoardCard(
					db,
					{ ...command(), requestId: 'revalidate' },
					() => ({ ...host, catalog: facade.captureCatalog() }),
					spec
				)
			).toEqual({ ok: false, reason: 'stale-revision' });
			expect(state()).toBe(before);
		}
	);

	it.each([null, [], { customModel: 42 }, { customEffort: '' }, { customArgs: 'bad\0arg' }])(
		'rejects malformed stored worker options %j without partial claims',
		(executionOptions) => {
			db.prepare(
				"UPDATE workers SET payload_json=json_set(payload_json, '$.executionOptions', json(?)) WHERE agent_id=?"
			).run(JSON.stringify(executionOptions), 'worker');
			expectWaiting('invalid-specification');
		}
	);

	it('preserves current scope, pause and approval gates when worker options exist', () => {
		const a = listBoardWorkers(db).find((w) => w.agentId === 'worker')!;
		setBoardWorkerOptions(db, 'worker', canonicalJson(a.payload), { customModel: 'A' });
		expectWaiting('worker-outside-scope', command(0, 'foreign'));
		setBoardWorkerPaused(db, 'worker', true);
		expectWaiting('worker-paused');
		setBoardWorkerPaused(db, 'worker', false);
		patchCard({
			capturePolicy: {
				effectiveStartMode: 'approval',
				dispatchApproval: 'required',
				specificationRevision: command().readRevision.card,
			},
		});
		expectWaiting('approval-required');
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
