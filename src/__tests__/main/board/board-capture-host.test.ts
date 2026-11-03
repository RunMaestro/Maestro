import { createScratchDir } from '../../shared/maestro-lib/run/fakeAgent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import {
	BoardStorageFacade,
	configureBoardStorage,
	configureBoardCaptureHost,
	configureBoardReadinessHost,
	addCard,
	updateCard,
	updateCardStatus,
} from '../../../main/board/board-storage';
import {
	registerBoardWorker,
	listBoardWorkers,
	setBoardWorkerOptions,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	BOARD_SOURCE_PROJECT_PREFIX,
	type BoardCaptureCommand,
	type BoardCard,
} from '../../../shared/board/types';

// Preserve real IO while making native ESM exports spyable at the diagnostic boundary.
vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
}));

const transport = vi.hoisted(() => ({
	handlers: new Map<string, (...args: any[]) => any>(),
	event: {} as any,
}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: (key: string, handler: (...args: any[]) => any) => transport.handlers.set(key, handler),
	},
	ipcRenderer: {
		invoke: async (key: string, ...args: unknown[]) =>
			JSON.parse(JSON.stringify(await transport.handlers.get(key)!(transport.event, ...args))),
	},
}));
vi.mock('../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging:
		(_: unknown, fn: (...args: any[]) => any) =>
		(_event: unknown, ...args: unknown[]) =>
			fn(...args),
}));
vi.mock('../../../main/stores/getters', () => ({ getLiveSessions: () => [] }));
vi.mock('../../../main/board/board-dispatcher', () => ({ applyCardCancel: vi.fn() }));
vi.mock('../../../main/board/board-pr', () => ({ startCardPr: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { registerBoardHandlers } from '../../../main/ipc/handlers/board';
import { createBoardApi } from '../../../main/preload/board';

let dir: string;
let db: ReturnType<typeof openBoardDb>;
let facade: BoardStorageFacade;
let agents: { id: string; groupId?: string }[];
let namespace: string;
const api = createBoardApi();
function card(extra: Partial<BoardCard> = {}): BoardCard {
	return {
		id: 'c',
		title: 'Work',
		body: 'Do work',
		parents: [],
		status: 'todo',
		createdAt: '',
		updatedAt: '',
		executionScope: { kind: 'group', groupId: 'g' },
		assigneeAgentId: 'a',
		role: { namespace, profileId: 'role' },
		repositoryId: 'repo',
		workingDirectory: dir,
		...extra,
	};
}
function command(value = card()): BoardCaptureCommand {
	const board = facade.read(dir, 'b');
	return {
		projectRoot: dir,
		boardId: 'b',
		expectedRevision: board.storage!.expectedRevision!,
		card: value,
	};
}
beforeEach(() => {
	dir = createScratchDir('maestro-board-capture', { canonical: true }).dir;
	db = openBoardDb(path.join(dir, 'board.sqlite'));
	const plan = planBoardMigration({
		source: { location: { kind: 'local' }, path: dir },
		repository: { id: 'repo', workingDirectory: dir, validated: true },
		profileBytes: Buffer.from(
			JSON.stringify({ profiles: [{ id: 'role', name: 'Role', baseAgentId: 'a' }] })
		),
		workers: [],
		boardBytes: Buffer.from(JSON.stringify({ boards: [{ id: 'b', name: 'Board', cards: [] }] })),
	});
	applyBoardMigration(db, plan);
	namespace = plan.profileNamespace;
	agents = [
		{ id: 'a', groupId: 'g' },
		{ id: 'foreign', groupId: 'other' },
	];
	configureBoardCaptureHost(() => ({ agents, groups: [{ id: 'g' }, { id: 'other' }] }));
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
	const mainFrame = {};
	const webContents = { mainFrame };
	registerBoardHandlers({
		getCueEngine: () => null,
		getMainWindow: () => ({ isDestroyed: () => false, webContents }) as any,
	});
	transport.event = { sender: webContents, senderFrame: mainFrame };
});
afterEach(() => {
	configureBoardStorage(null);
	configureBoardReadinessHost(() => null);
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('authoritative host capture over real SQLite and preload/IPC', () => {
	it('creates and assigns a root-free role through real IPC in an empty store and reloads it', async () => {
		db.close();
		const file = path.join(dir, 'empty.sqlite');
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		expect(facade.captureCatalog().profiles).toEqual([]);
		const response = await api.roleCommand({ action: 'create-role', name: ' Reviewer ' });
		expect(response).toMatchObject({ ok: true });
		if (!response.ok) throw new Error(response.error.message);
		const role = response.value as { namespace: string; profileId: string };
		expect(role.profileId).toMatch(/^[a-f0-9-]{36}$/);
		registerBoardWorker(db, 'a');
		registerBoardWorker(db, 'foreign');
		setBoardWorkerOptions(db, 'a', canonicalJson(listBoardWorkers(db)[0].payload), {
			customModel: 'worker-model',
		});
		expect(
			await api.roleCommand({ action: 'set-worker-role', agentId: 'a', role, enabled: true })
		).toMatchObject({ ok: true });
		const global = facade.ensureGlobalBoard();
		const root = BOARD_SOURCE_PROJECT_PREFIX + global.storage!.sourceKey;
		const saved = await api.captureCard({
			projectRoot: root,
			boardId: global.id,
			expectedRevision: global.storage!.expectedRevision!,
			card: card({
				id: 'fresh',
				role,
				assigneeAgentId: undefined,
				repositoryId: undefined,
				workingDirectory: undefined,
			}),
		});
		expect(saved).toMatchObject({
			ok: true,
			value: {
				cards: [
					{
						role,
						executionScope: { kind: 'group', groupId: 'g' },
						capturePolicy: { effectiveStartMode: 'approval' },
					},
				],
			},
		});
		for (const table of ['migrations', 'board_source_locations', 'repositories'])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
		db.close();
		db = openBoardDb(file);
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		expect((await api.captureCatalog()).profiles).toEqual([
			{ namespace: role.namespace, profile: { id: role.profileId, name: 'Reviewer' } },
		]);
		expect(facade.read(root, global.id).cards[0].role).toEqual(role);
		expect(listBoardWorkers(db)[0].payload).toMatchObject({
			roleRefs: [role],
			executionOptions: { customModel: 'worker-model' },
		});
		expect(listBoardWorkers(db)[1].payload.roleRefs).toEqual([]);
	});

	it('preserves legacy bytes, unknown references, other grants and worker options when changing one role', async () => {
		const profiles = db.prepare('SELECT * FROM profiles').all();
		const migrations = db.prepare('SELECT * FROM migrations').all();
		registerBoardWorker(db, 'a');
		const payload = {
			roleRefs: [{ namespace, profileId: 'role', future: 'keep' }],
			allowedRepositoryIds: ['repo'],
			executionOptions: { customModel: 'keep-model' },
			provenance: { keep: true },
		};
		db.prepare('UPDATE workers SET payload_json=? WHERE agent_id=?').run(
			canonicalJson(payload),
			'a'
		);
		const first = await api.roleCommand({ action: 'create-role', name: 'Reviewer' });
		if (!first.ok) throw new Error(first.error.message);
		const role = first.value as { namespace: string; profileId: string };
		// Another process updates options after the UI read. A single-role patch
		// must retain that newer payload instead of writing the old UI snapshot.
		const peer = openBoardDb(path.join(dir, 'board.sqlite'));
		try {
			payload.executionOptions.customModel = 'newer-model';
			peer
				.prepare('UPDATE workers SET payload_json=? WHERE agent_id=?')
				.run(canonicalJson(payload), 'a');
		} finally {
			peer.close();
		}
		await api.roleCommand({ action: 'set-worker-role', agentId: 'a', role, enabled: true });
		expect(listBoardWorkers(db)[0].payload).toEqual({
			...payload,
			roleRefs: [...payload.roleRefs, role],
			accessManaged: true,
		});
		const snapshot = canonicalJson(listBoardWorkers(db));
		expect(
			await api.roleCommand({
				action: 'set-worker-role',
				agentId: 'a',
				role: { ...role, namespace: 'wrong' },
				enabled: true,
			})
		).toMatchObject({ ok: false });
		expect(
			await api.roleCommand({ action: 'set-worker-role', agentId: 'gone', role, enabled: true })
		).toMatchObject({ ok: false });
		expect(canonicalJson(listBoardWorkers(db))).toBe(snapshot);
		await api.roleCommand({ action: 'set-worker-role', agentId: 'a', role, enabled: false });
		expect(listBoardWorkers(db)[0].payload).toEqual({ ...payload, accessManaged: true });
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual(migrations);
		expect(db.prepare('SELECT * FROM profiles WHERE profile_namespace=?').all(namespace)).toEqual(
			profiles
		);
	});

	it('rejects non-native role commands and malformed or authority-bearing inputs without writes', async () => {
		const before = db.prepare('SELECT * FROM profiles').all();
		transport.event = { ...transport.event, senderFrame: {} };
		expect(await api.roleCommand({ action: 'create-role', name: 'No' })).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
		transport.event.senderFrame = transport.event.sender.mainFrame;
		for (const input of [
			null,
			{ action: 'create-role', name: ' ' },
			{ action: 'create-role', name: 'No', human: true },
			{ action: 'initialize' },
		])
			expect(
				await transport.handlers.get('board:roleCommand')!(transport.event, input)
			).toMatchObject({ ok: false });
		expect(db.prepare('SELECT * FROM profiles').all()).toEqual(before);
	});
	it('explicitly replaces and clears role aliases across serialized IPC while omission preserves legacy references', async () => {
		const first = await api.captureCard(
			command({
				...card(),
				assigneeProfileId: 'role',
				profileNamespace: namespace,
			} as BoardCard)
		);
		expect(first.ok).toBe(true);
		const saved = facade.read(dir, 'b').cards[0];
		const { role: _originalRole, ...withoutRole } = saved;
		expect(await api.captureCard(command(withoutRole))).toMatchObject({
			ok: true,
		});
		expect(facade.read(dir, 'b').cards[0].role).toEqual(saved.role);
		const legacy = facade.read(dir, 'b').cards[0];
		const { profileNamespace: _oldNamespace, ...replacement } = legacy as BoardCard & {
			profileNamespace?: string;
		};
		expect(await api.captureCard({ ...command(replacement), replaceRole: true })).toMatchObject({
			ok: true,
		});
		const current = facade.read(dir, 'b').cards[0];
		expect(current).not.toHaveProperty('profileNamespace');
		expect(current.role).toEqual(saved.role);
		const {
			role: _role,
			assigneeProfileId: _id,
			profileNamespace: _namespace,
			...unassigned
		} = current as BoardCard & { profileNamespace?: string };
		const input = { ...command(unassigned), replaceRole: true as const };
		expect(
			await api.captureCard({
				...command({ ...unassigned, assigneeProfileId: 'role' }),
				replaceRole: true,
			})
		).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
		expect(await api.captureCard({ ...input, replaceRole: 'yes' } as any)).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(await api.captureCard(input)).toMatchObject({ ok: true });
		const cleared = new BoardStorageFacade(db).read(dir, 'b').cards[0];
		for (const field of ['role', 'assigneeProfileId', 'profileNamespace'])
			expect(cleared).not.toHaveProperty(field);
		expect(cleared.executionScope).toEqual(saved.executionScope);
		expect(cleared.capturePolicy?.dispatchApproval).toBe('required');
		expect(await api.captureCard(input)).toMatchObject({
			ok: false,
			error: { code: 'stale-revision' },
		});
	});

	it('explicitly initializes an empty global destination and captures without any project or agent', async () => {
		db.close();
		db = openBoardDb(path.join(dir, 'empty-global.sqlite'));
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
		expect(await api.queryWorkspace()).toMatchObject({ ok: true, value: { collections: [] } });
		const initialized = await api.initialize();
		if (!initialized.ok) throw new Error(initialized.error.message);
		const board = initialized.value;
		const input = {
			projectRoot: BOARD_SOURCE_PROJECT_PREFIX + board.storage!.sourceKey,
			boardId: board.id,
			expectedRevision: board.storage!.expectedRevision!,
			card: {
				id: 'first',
				title: 'First global task',
				body: '',
				parents: [],
				status: 'todo' as const,
				createdAt: '',
				updatedAt: '',
			},
		};
		const captured = await api.captureCard(input);
		expect(captured).toMatchObject({
			ok: true,
			value: { cards: [{ id: 'first', capturePolicy: { dispatchApproval: 'required' } }] },
			readiness: { first: expect.arrayContaining(['repository-unresolved', 'missing-scope']) },
		});
		for (const table of ['repositories', 'board_source_locations', 'migrations', 'runs'])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
		expect(await api.captureCard(input)).toMatchObject({
			ok: false,
			error: { code: 'stale-revision' },
		});
		db.close();
		db = openBoardDb(path.join(dir, 'empty-global.sqlite'));
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		expect(await api.initialize()).toEqual(captured);
	});

	it('persists a separate dependent review and leaves work and human review unchanged', async () => {
		const work = await api.captureCard(command(card({ kind: 'work' })));
		if (!work.ok) throw new Error(work.error.message);
		const review = await api.captureCard(
			command(
				card({
					id: 'review',
					kind: 'review',
					parents: ['c'],
					assigneeAgentId: undefined,
					body: 'Branch: topic\nCommit: ' + 'a'.repeat(40) + '\nChecks: passed',
				})
			)
		);
		if (!review.ok) throw new Error(review.error.message);
		const reopened = new BoardStorageFacade(db).read(dir, 'b');
		expect(reopened.cards).toHaveLength(2);
		expect(reopened.cards.find((entry) => entry.id === 'review')).toMatchObject({
			kind: 'review',
			parents: ['c'],
			status: 'todo',
		});
		expect(reopened.cards.find((entry) => entry.id === 'c')).toMatchObject({
			kind: 'work',
			status: 'todo',
		});
	});

	it('captures colliding legacy IDs in the explicitly selected source and adopts returned revisions', async () => {
		const first = await api.captureCard(command());
		if (!first.ok) throw new Error(first.error.message);
		const before = facade.read(dir, 'b');
		const other = path.join(dir, 'second-source');
		fs.mkdirSync(other);
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: other },
			repository: { id: 'second-repo', workingDirectory: other, validated: true },
			profileBytes: Buffer.from(
				JSON.stringify({
					profiles: [{ id: 'role', name: 'Same ID, another role', baseAgentId: 'a' }],
				})
			),
			workers: [],
			boardBytes: Buffer.from(
				JSON.stringify({
					boards: [
						{
							id: 'b',
							name: 'Second board',
							cards: [
								{
									...card(),
									role: undefined,
									repositoryId: undefined,
									workingDirectory: undefined,
									title: 'Second source card',
								},
							],
						},
					],
				})
			),
		});
		applyBoardMigration(db, plan);
		const selected = await api.queryWorkspace({ projectRoot: other });
		if (!selected.ok) throw new Error(selected.error.message);
		const collection = selected.value.collections[0];
		const current = collection.board.cards[0];
		const result = await api.captureCard({
			projectRoot: other,
			boardId: collection.board.id,
			expectedRevision: collection.revision,
			card: {
				...current,
				title: 'Edited second source',
				role: { namespace: plan.profileNamespace, profileId: 'role' },
				profileNamespace: plan.profileNamespace,
				assigneeProfileId: 'role',
				repositoryId: 'second-repo',
				workingDirectory: other,
				startModeOverride: 'approval',
			} as BoardCard,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.storage).toMatchObject({
			sourceKey: collection.sourceKey,
			collectionKey: collection.collectionKey,
			expectedRevision: collection.revision + 1,
		});
		expect(result.value.cards[0]).toMatchObject({
			id: 'c',
			title: 'Edited second source',
			role: { namespace: plan.profileNamespace, profileId: 'role' },
			storageRevision: current.storageRevision! + 1,
			capturePolicy: { dispatchApproval: 'required' },
		});
		expect(facade.read(dir, 'b')).toEqual(before);
		expect(result.readiness.c).toEqual([
			'approval-required',
			'emptyEligibleWorkers',
			'worker-unregistered',
			'runtime-unknown',
		]);
		expect(
			await api.captureCard({
				projectRoot: other,
				boardId: 'b',
				expectedRevision: collection.revision,
				card: current,
			})
		).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
	});

	it('accepts a full editor snapshot with retained host fields and explicit assignment unsets', async () => {
		const initial = await api.captureCard(command(card({ startModeOverride: 'direct' })));
		if (!initial.ok) throw new Error(initial.error.message);
		const saved = initial.value.cards[0];
		const captured = await api.captureCard(
			command({
				...saved,
				body: 'Edited body with unchanged policy',
				executionScope: { kind: 'agent', agentId: 'a' },
				role: undefined,
				assigneeProfileId: undefined,
				profileNamespace: undefined,
				assigneeAgentId: undefined,
			} as BoardCard)
		);
		expect(captured).toMatchObject({
			ok: true,
			readiness: { c: ['emptyEligibleWorkers', 'worker-unregistered', 'runtime-unknown'] },
			value: {
				cards: [
					expect.objectContaining({
						capturePolicy: expect.objectContaining({
							effectiveStartMode: 'direct',
							dispatchApproval: 'not-required',
						}),
					}),
				],
			},
		});
		const value = facade.read(dir, 'b').cards[0];
		expect(value.role).toBeUndefined();
		expect(value.assigneeAgentId).toBeUndefined();
		expect(value.storageRevision).toBe(saved.storageRevision! + 1);
	});

	it('reads current host/catalog data and persists direct intent with revisions across reopen', async () => {
		const catalog = await api.captureCatalog();
		expect(catalog.agents).toEqual(agents);
		expect(catalog.groups).toHaveLength(2);
		expect(catalog.profiles[0]).toMatchObject({
			namespace,
			profile: { id: 'role', baseAgentId: 'a' },
		});
		expect(catalog.repositories[0]).toMatchObject({
			id: 'repo',
			validated: true,
			workingDirectory: dir,
		});
		expect(catalog.defaultStartMode).toBe('approval');
		const response = await api.captureCard(
			command(card({ startModeOverride: 'direct', kind: 'review' }))
		);
		expect(response.ok).toBe(true);
		if (!response.ok) throw Error(response.error.message);
		expect(response.readiness.c).toEqual([
			'review-artifact-unresolved',
			'emptyEligibleWorkers',
			'worker-unregistered',
			'runtime-unknown',
		]);
		const saved = response.value.cards[0];
		expect(saved).toMatchObject({
			kind: 'review',
			role: { namespace, profileId: 'role' },
			capturePolicy: {
				effectiveStartMode: 'direct',
				dispatchApproval: 'not-required',
				specificationRevision: saved.storageRevision,
			},
		});
		expect((saved as any).humanReview).toBeUndefined();
		db.close();
		db = openBoardDb(path.join(dir, 'board.sqlite'));
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		expect(facade.read(dir, 'b').cards[0]).toEqual(saved);
	});
	it.each([
		['foreign pin', { assigneeAgentId: 'foreign' }, 'pin-role-conflict'],
		['foreign role pin', { role: undefined, assigneeAgentId: 'foreign' }, 'pin-outside-scope'],
		['agent scope', { executionScope: { kind: 'agent', agentId: 'foreign' } }, 'pin-outside-scope'],
		[
			'ambiguous profile',
			{ profileNamespace: 'elsewhere', assigneeProfileId: 'role' },
			'invalid-role',
		],
		[
			'repository conflict',
			{ workingDirectory: process.cwd() },
			'Repository and working directory conflict',
		],
	] as const)('rejects %s without writing', async (_, change, message) => {
		const before = facade.query();
		const result = await api.captureCard(command(card(change as any)));
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: expect.stringContaining(message) },
		});
		expect(facade.query()).toEqual(before);
	});
	it('preserves an existing scoped card and its revisions when an edit pins a foreign agent', async () => {
		const created = await api.captureCard(command());
		if (!created.ok) throw new Error(created.error.message);
		const before = facade.read(dir, 'b');
		const existing = before.cards[0];
		const result = await api.captureCard({
			projectRoot: dir,
			boardId: 'b',
			expectedRevision: before.storage!.expectedRevision!,
			card: { ...existing, assigneeAgentId: 'foreign', title: 'Rejected edit' },
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: expect.stringContaining('pin-role-conflict') },
		});
		db.close();
		db = openBoardDb(path.join(dir, 'board.sqlite'));
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		expect(facade.read(dir, 'b')).toEqual(before);
	});
	it('re-reads membership and profile pins rather than keeping an initial snapshot', async () => {
		agents = agents.map((agent) => ({ ...agent, groupId: 'other' }));
		expect(await api.captureCard(command())).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining('pin-outside-scope') },
		});
		agents = [{ id: 'a', groupId: 'g' }];
		db.prepare('UPDATE profiles SET payload_json = ?').run(
			JSON.stringify({ id: 'role', name: 'Role', baseAgentId: 'foreign' })
		);
		expect(await api.captureCard(command())).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining('pin-role-conflict') },
		});
	});
	it('captures missing references honestly and reports why they cannot run', async () => {
		const result = await api.captureCard(
			command(
				card({
					executionScope: { kind: 'group', groupId: 'deleted' },
					assigneeAgentId: 'gone',
					role: { namespace: 'deleted', profileId: 'role' },
					repositoryId: 'deleted',
				})
			)
		);
		expect(result).toMatchObject({
			ok: true,
			readiness: {
				c: expect.arrayContaining([
					'group-missing',
					'target-missing',
					'role-missing',
					'repository-unresolved',
				]),
			},
		});
	});
	it('rejects stale collection and card tokens while keeping policy intact', async () => {
		const old = command();
		expect((await api.captureCard(old)).ok).toBe(true);
		const saved = facade.read(dir, 'b').cards[0];
		expect(await api.captureCard(old)).toMatchObject({
			ok: false,
			error: { code: 'stale-revision' },
		});
		expect(
			await api.captureCard(command({ ...saved, storageRevision: saved.storageRevision! + 1 }))
		).toMatchObject({
			ok: false,
			error: { code: 'stale-revision' },
		});
	});
	it('rejects forged authority, remote senders and subframes; ordinary creators cannot relax policy', async () => {
		expect(await api.captureCard({ ...command(), actorAuthority: 'human' } as any)).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		transport.event = { sender: {}, senderFrame: {} };
		expect(await api.captureCard(command(card({ startModeOverride: 'direct' })))).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
		expect(() => addCard(dir, 'b', card({ startModeOverride: 'direct' }))).toThrow(
			/unauthorized-start-mode/
		);
		expect(() =>
			addCard(dir, 'b', { ...card(), capturePolicy: { effectiveStartMode: 'direct' } } as any)
		).toThrow(/Cannot edit Board field/);
	});
	it('keeps approval and human review separate, resets grants after a specification edit, and blocks forged grants', async () => {
		const first = await api.captureCard(command());
		expect(first.ok).toBe(true);
		let saved = facade.read(dir, 'b').cards[0];
		expect(saved).toMatchObject({
			capturePolicy: { effectiveStartMode: 'approval', dispatchApproval: 'required' },
		});
		// Host grant fixture, independent of CRUD; human review must survive policy recapture.
		const policy = { ...(saved as any).capturePolicy, dispatchApproval: 'granted' };
		db.prepare('UPDATE cards SET payload_json = ?').run(
			JSON.stringify({ ...saved, capturePolicy: policy, humanReview: { state: 'pending' } })
		);
		saved = facade.read(dir, 'b').cards[0];
		expect(() =>
			updateCard(dir, 'b', {
				...saved,
				capturePolicy: { ...policy, dispatchApproval: 'not-required' },
			} as any)
		).toThrow(/Cannot edit Board field/);
		updateCard(dir, 'b', { ...saved, body: 'New specification' });
		saved = facade.read(dir, 'b').cards[0];
		expect(saved).toMatchObject({
			capturePolicy: { dispatchApproval: 'required', specificationRevision: saved.storageRevision },
			humanReview: { state: 'pending' },
		});
		expect(() => updateCardStatus(dir, 'b', 'c', 'done')).toThrow('bound workflow');
		expect(facade.read(dir, 'b').cards[0]).toMatchObject({
			capturePolicy: { dispatchApproval: 'required' },
			humanReview: { state: 'pending' },
		});
	});

	it('rejects symlink escape and retains missing paths as non-executable drafts', async () => {
		fs.symlinkSync(process.cwd(), path.join(dir, 'escape'));
		expect(
			await api.captureCard(command(card({ workingDirectory: path.join(dir, 'escape') })))
		).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
		const result = await api.captureCard(
			command(card({ workingDirectory: path.join(dir, 'gone') }))
		);
		expect(result).toMatchObject({
			ok: true,
			readiness: {
				c: [
					'repository-unresolved',
					'approval-required',
					'emptyEligibleWorkers',
					'worker-unregistered',
					'runtime-unknown',
				],
			},
		});
	});
	it('reports a later membership conflict and deleted role pin from current host state', async () => {
		expect((await api.captureCard(command())).ok).toBe(true);
		agents = [{ id: 'a', groupId: 'other' }];
		expect((await facade.captureReadinessAsync(facade.read(dir, 'b'))).c).toContain(
			'scope-conflict'
		);
		agents = [];
		expect((await facade.captureReadinessAsync(facade.read(dir, 'b'))).c).toContain(
			'target-missing'
		);
	});
	it('keeps explicitly approved direct intent on ordinary edits but allows a human to tighten it', async () => {
		expect((await api.captureCard(command(card({ startModeOverride: 'direct' })))).ok).toBe(true);
		let saved = facade.read(dir, 'b').cards[0];
		updateCard(dir, 'b', { ...saved, body: 'Updated direct work' });
		saved = facade.read(dir, 'b').cards[0];
		expect(saved).toMatchObject({
			capturePolicy: { effectiveStartMode: 'direct', dispatchApproval: 'not-required' },
		});
		expect(
			await api.captureCard(command({ ...saved, startModeOverride: 'approval' }))
		).toMatchObject({
			ok: true,
			value: {
				cards: [
					expect.objectContaining({
						capturePolicy: expect.objectContaining({ dispatchApproval: 'required' }),
					}),
				],
			},
		});
	});

	it('rejects ambiguous host identities and validates legacy explicitly namespaced roles without guessing', async () => {
		const qualified = card({
			role: undefined,
			assigneeProfileId: 'role',
			profileNamespace: namespace,
		} as any);
		expect((await api.captureCard(command(qualified))).ok).toBe(true);
		agents = [
			{ id: 'a', groupId: 'g' },
			{ id: 'a', groupId: 'other' },
		];
		expect(
			await api.captureCard(command({ ...facade.read(dir, 'b').cards[0], body: 'Changed' }))
		).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: expect.stringContaining('ambiguous identities') },
		});
	});

	it('preserves imported direct intent on metadata edits without changing original migration data', () => {
		// A distinct explicit source for this fixture, never a guessed namespace.
		const other = path.join(dir, 'other');
		fs.mkdirSync(other);
		const imported = planBoardMigration({
			...{
				source: { location: { kind: 'local' as const }, path: other },
				repository: null,
				profileBytes: null,
				workers: [],
			},
			boardBytes: Buffer.from(
				JSON.stringify({
					boards: [
						{
							id: 'legacy',
							name: 'Legacy',
							cards: [
								{
									id: 'old',
									title: 'Old',
									body: '',
									status: 'todo',
									parents: [],
									createdAt: '2026-10-31',
									updatedAt: '2026-10-31',
								},
							],
						},
					],
				})
			),
		});
		applyBoardMigration(db, imported);
		const legacy = facade.read(other, 'legacy');
		const original = (legacy.cards[0] as any).migration;
		updateCard(other, 'legacy', { ...legacy.cards[0], body: 'Edited' });
		const saved = facade.read(other, 'legacy').cards[0];
		expect(saved).toMatchObject({
			capturePolicy: { effectiveStartMode: 'direct', dispatchApproval: 'not-required' },
			migration: original,
		});
	});
	it('rolls back the card and policy together if host policy persistence fails', async () => {
		const before = facade.query();
		db.exec(
			"CREATE TRIGGER fail_policy BEFORE UPDATE ON cards WHEN json_extract(NEW.payload_json, '$.capturePolicy') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'policy write failed'); END"
		);
		await expect(api.captureCard(command())).rejects.toThrow(/policy write failed/);
		expect(facade.query()).toEqual(before);
	});
});

it('changes only future capture policy through a revision-checked native action', async () => {
	expect((await api.captureCard(command())).ok).toBe(true);
	const before = facade.read(dir, 'b');
	const revision = before.storage!.expectedRevision!;
	expect(await api.setStartPolicy(dir, 'b', revision, 'direct')).toMatchObject({
		ok: true,
		value: { defaultStartMode: 'direct' },
	});
	expect(facade.read(dir, 'b').cards).toEqual(before.cards);
	expect(await api.setStartPolicy(dir, 'b', revision, 'approval')).toMatchObject({
		ok: false,
		error: { code: 'stale-revision' },
	});
	const created = addCard(dir, 'b', card({ id: 'new' }));
	expect(created.cards.find((c) => c.id === 'new')!.capturePolicy?.dispatchApproval).toBe(
		'not-required'
	);
	expect(created.cards.find((c) => c.id === 'c')!.capturePolicy?.dispatchApproval).toBe('required');
	expect(() =>
		facade.setStartPolicy(dir, 'b', created.storage!.expectedRevision!, 'approval')
	).toThrow('native human');
	transport.event = { sender: transport.event.sender, senderFrame: {} };
	expect(
		await api.setStartPolicy(dir, 'b', created.storage!.expectedRevision!, 'approval')
	).toMatchObject({ ok: false, error: { code: 'protected-field' } });
	expect(facade.read(dir, 'b').defaultStartMode).toBe('direct');
});

it('creates namespaced roles through native transport without touching legacy profiles', async () => {
	const role = await api.upsertRole(dir, { id: 'new-role', name: 'New central role' });
	expect(role).toEqual({ namespace, profileId: 'new-role' });
	expect(
		(await api.captureCatalog()).profiles.find(
			(p) => p.namespace === namespace && p.profile.id === 'new-role'
		)?.profile.name
	).toBe('New central role');
	expect(fs.existsSync(path.join(dir, '.maestro/profiles.yaml'))).toBe(false);
	transport.event = { sender: {}, senderFrame: {} };
	await expect(api.upsertRole(dir, { id: 'forged-role', name: 'Forged' })).rejects.toThrow(
		'desktop main frame'
	);
	expect((await api.captureCatalog()).profiles.some((p) => p.profile.id === 'forged-role')).toBe(
		false
	);
});

it('manages advanced roles through authorized central IPC with exact source namespace and reopen persistence', async () => {
	const sourceKey = facade.query().sources[0].sourceKey;
	const original = db.prepare('SELECT * FROM migrations').all();
	const profile = {
		id: 'advanced',
		name: 'Advanced',
		baseAgentId: 'a',
		model: 'model',
		effort: 'xhigh',
		appendSystemPrompt: '  prompt\n',
		customArgs: '--arg "two words"',
	};
	expect(await api.sourceCommand({ action: 'save-role', sourceKey, namespace, profile })).toEqual({
		ok: true,
	});
	expect(
		new BoardStorageFacade(db).captureCatalog().profiles.find((p) => p.profile.id === profile.id)
	).toEqual({ namespace, profile });
	expect(
		await api.sourceCommand({
			action: 'save-role',
			sourceKey,
			namespace: 'legacy:foreign',
			profile,
		})
	).toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
	transport.event.senderFrame = {};
	expect(
		await api.sourceCommand({
			action: 'save-role',
			sourceKey,
			namespace,
			profile: { ...profile, model: 'forged' },
		})
	).toMatchObject({ ok: false, error: { code: 'protected-field' } });
	expect(
		new BoardStorageFacade(db).captureCatalog().profiles.find((p) => p.profile.id === profile.id)
			?.profile.model
	).toBe('model');
	expect(db.prepare('SELECT * FROM migrations').all()).toEqual(original);
	db.close();
	db = openBoardDb(path.join(dir, 'board.sqlite'));
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
	expect(facade.captureCatalog().profiles.find((p) => p.profile.id === profile.id)).toEqual({
		namespace,
		profile,
	});
});

it('repairs capture references only after native source validation and explicit capture, preserving provenance', async () => {
	const sourceKey = facade.query().sources[0].sourceKey;
	db.prepare('DELETE FROM repositories').run();
	const input = command(card({ repositoryId: 'repo' }));
	expect(await api.captureCard(input)).toMatchObject({
		ok: true,
		readiness: { c: expect.arrayContaining(['repository-unresolved']) },
	});
	const frozen = db.prepare('SELECT * FROM migrations').all();
	expect(await api.sourceCommand({ action: 'revalidate', sourceKey })).toMatchObject({ ok: false });
	execFileSync('git', ['init', '--quiet', dir]);
	expect(await api.sourceCommand({ action: 'revalidate', sourceKey })).toEqual({ ok: true });
	expect(await api.captureCard(command(facade.read(dir, 'b').cards[0]))).toMatchObject({
		ok: true,
		readiness: { c: expect.not.arrayContaining(['repository-unresolved']) },
	});
	expect(facade.read(dir, 'b').cards[0].repositoryId).toBe('repo');
	expect(db.prepare('SELECT * FROM migrations').all()).toEqual(frozen);
	db.close();
	db = openBoardDb(path.join(dir, 'board.sqlite'));
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
	expect(facade.read(dir, 'b').cards[0].repositoryId).toBe('repo');
});

it('preserves imported role provenance on edit and refuses deletion of a referenced role', async () => {
	const sourceKey = facade.query().sources[0].sourceKey;
	db.prepare('UPDATE profiles SET payload_json=? WHERE id=?').run(
		JSON.stringify({ id: 'role', name: 'Role', model: 'old', futureField: { original: true } }),
		'role'
	);
	expect(
		await api.sourceCommand({
			action: 'save-role',
			sourceKey,
			namespace,
			profile: { id: 'role', name: 'Renamed', customArgs: '--new' },
		})
	).toEqual({ ok: true });
	expect(facade.captureCatalog().profiles[0].profile).toEqual({
		id: 'role',
		name: 'Renamed',
		customArgs: '--new',
		futureField: { original: true },
	});
	expect(await api.captureCard(command())).toMatchObject({ ok: true });
	expect(
		await api.sourceCommand({ action: 'delete-role', sourceKey, namespace, profileId: 'role' })
	).toMatchObject({ ok: false, error: { code: 'protected-field' } });
	expect(
		await api.sourceCommand({
			action: 'save-role',
			sourceKey,
			namespace,
			profile: { id: 'unused', name: 'Unused' },
		})
	).toEqual({ ok: true });
	expect(
		await api.sourceCommand({ action: 'delete-role', sourceKey, namespace, profileId: 'unused' })
	).toEqual({ ok: true });
	expect(facade.captureCatalog().profiles.map((p) => p.profile.id)).toEqual(['role']);
});

describe('read-only current host diagnosis across capture and global reload', () => {
	it('rechecks an empty group, registration, role/repository access and current membership without fallback', async () => {
		const captured = await api.captureCard(
			command(card({ assigneeAgentId: undefined, role: undefined }))
		);
		if (!captured.ok) throw new Error(captured.error.message);
		expect(captured.readiness.c).toEqual([
			'approval-required',
			'emptyEligibleWorkers',
			'worker-unregistered',
			'runtime-unknown',
		]);
		const diagnosis = async () => {
			const response = await api.queryWorkspace();
			if (!response.ok) throw new Error(response.error.message);
			const collection = response.value.collections.find((entry) => entry.board.id === 'b')!;
			expect(collection.sourceKey).toBe(captured.value.storage!.sourceKey);
			return collection.readiness!.c;
		};
		agents = [{ id: 'foreign', groupId: 'other' }];
		expect(await diagnosis()).toEqual([
			'approval-required',
			'emptyEligibleWorkers',
			'runtime-unknown',
		]);
		agents.push({ id: 'a', groupId: 'g' });
		// A worker outside the allowed group never substitutes for its empty scope.
		registerBoardWorker(db, 'foreign');
		setBoardWorkerAccess(db, 'foreign', [], ['repo']);
		expect(await diagnosis()).toContain('emptyEligibleWorkers');
		registerBoardWorker(db, 'a');
		expect(await diagnosis()).toContain('worker-repository-mismatch');
		setBoardWorkerAccess(db, 'a', [], ['repo']);
		expect(await diagnosis()).toEqual([
			'approval-required',
			'occupancy-unknown',
			'runtime-unknown',
		]);
		setBoardWorkerPaused(db, 'a', true);
		expect(await diagnosis()).toEqual([
			'approval-required',
			'emptyEligibleWorkers',
			'worker-paused',
			'runtime-unknown',
		]);
		setBoardWorkerPaused(db, 'a', false);
		const saved = facade.read(dir, 'b').cards[0];
		const roleCapture = await api.captureCard(
			command({ ...saved, role: { namespace, profileId: 'role' } })
		);
		if (!roleCapture.ok) throw new Error(roleCapture.error.message);
		expect(await diagnosis()).toContain('worker-role-mismatch');
		setBoardWorkerAccess(db, 'a', [{ namespace, profileId: 'role' }], ['repo']);
		expect(await diagnosis()).toEqual([
			'approval-required',
			'occupancy-unknown',
			'runtime-unknown',
		]);
		agents = agents.map((agent) => ({ ...agent, groupId: 'other' }));
		expect(await diagnosis()).toContain('scope-conflict');
		expect(await diagnosis()).toContain('emptyEligibleWorkers');
	});

	it('keeps missing native occupancy unknown and leaves final start checks to Cue', async () => {
		const captured = await api.captureCard(command(card({ startModeOverride: 'direct' })));
		if (!captured.ok) throw new Error(captured.error.message);
		registerBoardWorker(db, 'a');
		setBoardWorkerAccess(db, 'a', [{ namespace, profileId: 'role' }], ['repo']);
		configureBoardReadinessHost(() => ({ dispatchEnabled: true, agentStates: {} }));
		expect((await facade.captureReadinessAsync(facade.read(dir, 'b'))).c).toEqual([
			'occupancy-unknown',
		]);
		configureBoardReadinessHost(() => ({
			dispatchEnabled: true,
			agentStates: {
				a: { live: true, busy: false, location: { kind: 'ssh', remoteId: 'other-host' } },
			},
		}));
		expect((await facade.captureReadinessAsync(facade.read(dir, 'b'))).c).toEqual([
			'worker-location-mismatch',
		]);
		configureBoardReadinessHost(() => ({
			dispatchEnabled: true,
			agentStates: { a: { live: true, busy: false, location: { kind: 'local' } } },
		}));
		expect((await facade.captureReadinessAsync(facade.read(dir, 'b'))).c).toEqual(['awaiting-cue']);
		expect(db.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
	});

	it('reads native busy/dormant/Cue state, approval and Hold without acquiring runtime ownership or writing any SQLite row', async () => {
		const captured = await api.captureCard(command(card({ heldByUser: true })));
		if (!captured.ok) throw new Error(captured.error.message);
		registerBoardWorker(db, 'a');
		setBoardWorkerAccess(db, 'a', [{ namespace, profileId: 'role' }], ['repo']);
		let busy = true;
		let live = true;
		let dispatchEnabled = true;
		configureBoardReadinessHost(() => ({
			dispatchEnabled,
			agentStates: { a: { busy, live, location: { kind: 'local' } } },
		}));
		const snapshot = () =>
			canonicalJson(
				db
					.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
					.all()
					.map((row) => {
						const table = (row as { name: string }).name;
						return [
							table,
							db
								.prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
								.all()
								.map((record) =>
									Object.fromEntries(
										Object.entries(record as Record<string, unknown>).map(([key, value]) => [
											key,
											Buffer.isBuffer(value) ? { hex: value.toString('hex') } : value,
										])
									)
								),
						];
					})
			);
		const diagnosis = async () => {
			const before = snapshot();
			const response = await api.queryWorkspace();
			if (!response.ok) throw new Error(response.error.message);
			expect(snapshot()).toBe(before);
			return response.value.collections[0].readiness!.c;
		};
		expect(await diagnosis()).toEqual(['approval-required', 'held', 'worker-busy']);
		busy = false;
		expect(await diagnosis()).toEqual(['approval-required', 'held']);
		live = false;
		expect(await diagnosis()).toEqual(['approval-required', 'held', 'worker-dormant']);
		live = true;
		dispatchEnabled = false;
		expect(await diagnosis()).toEqual(['approval-required', 'held', 'runtime-unavailable']);
		const collection = captured.value.storage!.collectionKey;
		db.prepare(
			'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json) VALUES (?, ?, ?, ?, ?)'
		).run('uncertain-run', collection, 'c', 1, '{}');
		db.prepare(
			'INSERT INTO reservations (worker_agent_id, collection_key, card_id, run_id, owner_epoch, generation, phase) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('a', collection, 'c', 'uncertain-run', 7, 2, 'uncertain');
		// Durable reservation wins even if the native process currently looks idle.
		expect(await diagnosis()).toEqual([
			'approval-required',
			'held',
			'worker-busy',
			'runtime-unavailable',
		]);
		configureBoardReadinessHost(() => null);
		expect(await diagnosis()).toEqual([
			'approval-required',
			'held',
			'worker-busy',
			'runtime-unknown',
		]);
	});
});

describe('asynchronous revision-bound read diagnostics', () => {
	it.each(['card', 'collection', 'source', 'repository'])(
		'yields without holding a SQLite snapshot and rejects changed %s evidence during await',
		async (changed) => {
			await api.captureCard(command(card({ heldByUser: true })));
			const stat = fs.promises.stat.bind(fs.promises);
			const realpath = fs.promises.realpath.bind(fs.promises);
			const realpathSpy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
				expect(db.inTransaction).toBe(false);
				return realpath(...args);
			});
			let entered!: () => void;
			let resume!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const blocked = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const spy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args) => {
				expect(db.inTransaction).toBe(false);
				entered();
				await blocked;
				return stat(...args);
			});
			try {
				const reading = facade.queryAsync();
				await started;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(db.inTransaction).toBe(false);
				// Another real writer can commit while path IO is pending.
				const board = facade.read(dir, 'b');
				if (changed === 'card')
					updateCard(dir, 'b', { ...board.cards[0], body: 'Changed during IO' });
				else if (changed === 'collection')
					facade.save(dir, [{ ...board, name: 'Changed during IO' }]);
				else if (changed === 'source')
					db.prepare('UPDATE board_source_locations SET payload_json=? WHERE source_key=?').run(
						canonicalJson({ location: { kind: 'local' }, path: dir + '/other' }),
						board.storage!.sourceKey
					);
				else
					db.prepare('UPDATE repositories SET payload_json=? WHERE id=?').run(
						canonicalJson({ id: 'repo', workingDirectory: dir + '/other', validated: true }),
						'repo'
					);
				resume();
				const view = await reading;
				expect(view.collections[0].board.cards[0].heldByUser).toBe(true);
				expect(view.collections[0].readiness!.c).toEqual(
					expect.arrayContaining(['repository-unknown', 'held', 'approval-required'])
				);
				expect(view.collections[0].readiness!.c).not.toContain('awaiting-cue');
				expect(db.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
				expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
			} finally {
				resume();
				spy.mockRestore();
				realpathSpy.mockRestore();
			}
		}
	);

	it.each(['ENOENT', 'ENOTDIR', 'EACCES'])(
		'retains unresolved repository diagnostics for %s',
		async (code) => {
			await api.captureCard(command());
			const spy = vi
				.spyOn(fs.promises, 'stat')
				.mockRejectedValue(Object.assign(new Error(code), { code }));
			try {
				const result = await api.queryWorkspace();
				if (!result.ok) throw new Error(result.error.message);
				expect(result.value.collections[0].readiness!.c).toContain('repository-unresolved');
				expect(result.value.collections[0].readiness!.c).not.toContain('awaiting-cue');
			} finally {
				spy.mockRestore();
			}
		}
	);

	it('has no synchronous path fallback and keeps missing observations unknown', async () => {
		await api.captureCard(command());
		const stat = vi.spyOn(fs, 'statSync').mockImplementation(() => {
			throw new Error('sync stat');
		});
		const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
			throw new Error('sync realpath');
		});
		try {
			const view = facade.query({ projectRoot: dir });
			expect(view.collections[0].readiness!.c).toContain('repository-unknown');
			const asyncView = await facade.queryAsync({ projectRoot: dir });
			expect(asyncView.collections[0].readiness!.c).not.toContain('repository-unknown');
			expect(stat).not.toHaveBeenCalled();
			expect(realpath).not.toHaveBeenCalled();
		} finally {
			stat.mockRestore();
			realpath.mockRestore();
		}
	});

	it('refuses asynchronous preparation under a caller-owned transaction', async () => {
		await api.captureCard(command());
		const board = facade.read(dir, 'b');
		let result!: Promise<unknown>;
		db.transaction(() => {
			result = facade.prepareDiagnosticObservations([board]);
		})();
		await expect(result).rejects.toThrow('no open transaction');
	});
});

it('rejects final approval from foreign or child frames and refuses native Done status requests', async () => {
	await api.captureCard(command());
	const board = facade.read(dir, 'b');
	const target = {
		projectRoot: dir,
		sourceKey: board.storage!.sourceKey,
		collectionKey: board.storage!.collectionKey,
		expectedRevision: board.storage!.expectedRevision!,
	};
	const action = {
		action: 'control' as const,
		operation: 'accept' as const,
		target,
		cardId: 'c',
		cardRevision: board.cards[0].storageRevision!,
	};
	const native = transport.event;
	for (const event of [
		{ sender: {}, senderFrame: {} },
		{ sender: native.sender, senderFrame: {} },
	]) {
		transport.event = event;
		expect(await api.runtimeCommand(action)).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
	}
	transport.event = native;
	await expect(api.setCardStatus(dir, 'b', 'c', 'done')).rejects.toThrow('bound workflow');
	expect(facade.read(dir, 'b').cards[0].status).toBe('todo');
});

it('projects catalog identities without copying unrelated session drafts and logs', () => {
	const agent = { id: 'worker', groupId: 'g', inputValue: 'private draft', aiLogs: ['large log'] };
	const group = { id: 'g', name: 'Group', collapsed: false };
	configureBoardCaptureHost(() => ({ agents: [agent], groups: [group] }));
	const catalog = facade.captureCatalog();
	expect(catalog.agents).toEqual([{ id: 'worker', groupId: 'g' }]);
	expect(catalog.groups).toEqual([{ id: 'g' }]);
	agent.groupId = 'other';
	expect(facade.captureCatalog().agents[0].groupId).toBe('other');
});
