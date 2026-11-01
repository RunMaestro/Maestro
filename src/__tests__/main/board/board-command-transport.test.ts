import { registerBoardHandlers } from '../../../main/ipc/handlers/board';
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({
	ipcMain: {
		handle: (name: string, callback: (...args: any[]) => any) => ipcHandlers.set(name, callback),
	},
}));
vi.mock('../../../main/stores/getters', () => ({ getLiveSessions: () => [] }));
import { BoardRuntime, type BoardRunService } from '../../../main/board/board-runtime';
import {
	configureBoardRuntimeHost,
	executeBoardRuntimeCommand,
	cancelBoardRuntimeCard,
} from '../../../main/board/board-runtime-host';
import {
	registerBoardWorker,
	setBoardWorkerAccess,
} from '../../../main/board/board-workspace-storage';
import type { BoardRuntimeToken } from '../../../shared/board/commands';
import type { CardSpawnResult } from '../../../main/board/board-dispatcher';
// @vitest-environment node
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { buildSync } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import {
	BoardStorageFacade,
	configureBoardStorage,
	configureBoardCaptureHost,
} from '../../../main/board/board-storage';
import { executeBoardCommand } from '../../../main/board/board-command-host';
import { handleBoardCommand } from '../../../main/web-server/handlers/messageHandlers/board';
import { startRuntimeServer, type RuntimeServer } from '../../../shared/maestro-lib/runtime/server';
import { createMaestroRuntime, type MaestroRuntime } from '../../../shared/maestro-lib/runtime';
import { BridgeConnection } from '../../../shared/maestro-lib/client/bridge-connection';
import { writeCliServerInfoTo } from '../../../shared/maestro-lib/client/discovery';
import { requestBoardCommand } from '../../../shared/maestro-lib/client/board';
import type { BoardCommand, BoardCommandReply } from '../../../shared/board/commands';
import type { Board, BoardCard } from '../../../shared/board/types';
import { CLI_SECRET_HEADER } from '../../../shared/webLogin';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

let cliBuildDir: string;
beforeAll(() => {
	cliBuildDir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/cli-build-'));
	buildSync({
		entryPoints: ['src/cli/index.ts'],
		outfile: path.join(cliBuildDir, 'cli.cjs'),
		bundle: true,
		platform: 'node',
		packages: 'external',
		logLevel: 'silent',
	});
});
afterAll(() => fs.rmSync(cliBuildDir, { recursive: true, force: true }));
async function cli(...args: string[]) {
	try {
		const output = await promisify(execFile)(
			'node',
			[path.join(cliBuildDir, 'cli.cjs'), 'board', ...args],
			{
				env: { ...process.env, MAESTRO_USER_DATA: dir },
				timeout: 15000,
			}
		);
		return { code: 0, value: JSON.parse(output.stdout) };
	} catch (error) {
		const failure = error as { code: number; stdout: string; stderr: string };
		return {
			code: failure.code,
			value: failure.stdout ? JSON.parse(failure.stdout) : { stderr: failure.stderr },
		};
	}
}

let dir: string;
let db: ReturnType<typeof openBoardDb>;
let facade: BoardStorageFacade;
let runtime: MaestroRuntime;
let server: RuntimeServer;
let connection: BridgeConnection;
let agents: { id: string; groupId?: string }[];
let roots: string[];
let namespaces: string[];
const result = <T>(reply: BoardCommandReply): T => {
	if (!reply.ok) throw new Error(reply.error.message);
	return reply.value as T;
};
function card(extra: Partial<BoardCard> = {}): BoardCard {
	return {
		id: 'c',
		title: 'Work',
		body: 'Work instructions',
		parents: [],
		status: 'todo',
		createdAt: '',
		updatedAt: '',
		executionScope: { kind: 'group', groupId: 'g' },
		assigneeAgentId: 'a',
		repositoryId: 'repo0',
		workingDirectory: roots[0],
		...extra,
	};
}
function target(index = 0) {
	const board = facade.read(roots[index], 'b');
	return {
		projectRoot: roots[index],
		sourceKey: board.storage!.sourceKey,
		collectionKey: board.storage!.collectionKey,
		expectedRevision: board.storage!.expectedRevision!,
	};
}
function capture(value = card(), index = 0): BoardCommand {
	const selected = target(index);
	return {
		action: 'capture',
		target: selected,
		capture: {
			projectRoot: selected.projectRoot,
			boardId: 'b',
			expectedRevision: selected.expectedRevision,
			card: value,
		},
	};
}
const send = (command: BoardCommand) => requestBoardCommand(connection, command);
const raw = (fields: Record<string, unknown>) =>
	connection.sendCommand<BoardCommandReply>(
		{ type: 'board_command', ...fields },
		'board_command_result'
	);

beforeEach(async () => {
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/transport-'));
	roots = [path.join(dir, 'one'), path.join(dir, 'two')];
	db = openBoardDb(path.join(dir, 'board.sqlite'));
	namespaces = roots.map((root, i) => {
		fs.mkdirSync(root);
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: root },
			repository: { id: `repo${i}`, workingDirectory: root, validated: true },
			profileBytes: Buffer.from(
				JSON.stringify({ profiles: [{ id: 'role', name: 'Role', baseAgentId: 'a' }] })
			),
			workers: [],
			boardBytes: Buffer.from(
				JSON.stringify({ boards: [{ id: 'b', name: `Board ${i}`, cards: [] }] })
			),
		});
		applyBoardMigration(db, plan);
		return plan.profileNamespace;
	});
	fs.writeFileSync(
		path.join(dir, 'maestro-settings.json'),
		JSON.stringify({ encoreFeatures: { board: true, maestroCue: true } })
	);
	fs.writeFileSync(
		path.join(dir, 'maestro-sessions.json'),
		JSON.stringify({
			sessions: [
				{ id: 'creator', name: 'Creator', toolType: 'codex', projectRoot: roots[0], cwd: roots[0] },
				{ id: 'a', name: 'A', toolType: 'codex', projectRoot: roots[0] },
				{ id: 'foreign', name: 'Foreign', toolType: 'codex', projectRoot: roots[1] },
			],
		})
	);
	agents = [{ id: 'creator' }, { id: 'a', groupId: 'g' }, { id: 'foreign', groupId: 'other' }];
	configureBoardCaptureHost(() => ({ agents, groups: [{ id: 'g' }, { id: 'other' }] }));
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
	const started = await createMaestroRuntime({
		dataDir: dir,
		mode: 'host',
		deps: { watchDirectory: () => ({ close() {} }) },
	});
	if (!started.ok) throw new Error(started.refusal.message);
	runtime = started.runtime;
	server = await startRuntimeServer({
		runtime,
		token: 'fixture-token',
		cliSecret: 'fixture-secret',
		boardHost: executeBoardCommand,
		onStopRequested() {},
	});
	writeCliServerInfoTo(dir, {
		port: server.port,
		token: 'fixture-token',
		cliSecret: 'fixture-secret',
		pid: process.pid,
		startedAt: Date.now(),
		hostKind: 'headless',
	});
	connection = new BridgeConnection({ userDataDir: dir, strictReplies: true });
	await connection.connect();
});
afterEach(async () => {
	configureBoardRuntimeHost(() => null);
	connection?.disconnect();
	await server?.close();
	await runtime?.connection.close();
	configureBoardStorage(null);
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	db?.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Board through native runtime/WebSocket and real SQLite', () => {
	it('uses central sources, current host register and explicit colliding legacy identities', async () => {
		const catalog = await send({ action: 'catalog' });
		expect(catalog).toMatchObject({
			ok: true,
			value: { agents: expect.arrayContaining([{ id: 'creator' }]) },
		});
		expect(db.prepare('SELECT * FROM workers').all()).toEqual([]);
		const first = result<Board>(await send(capture()));
		const second = result<Board>(
			await send(
				capture(
					card({ repositoryId: 'repo1', workingDirectory: roots[1], title: 'Second source' }),
					1
				)
			)
		);
		expect(first.cards[0].id).toBe(second.cards[0].id);
		expect(first.storage!.sourceKey).not.toBe(second.storage!.sourceKey);
		expect(await send({ action: 'query', query: {} })).toMatchObject({
			ok: true,
			value: { collections: [expect.anything(), expect.anything()] },
		});
		expect(
			await send({ action: 'query', query: { sourceKey: second.storage!.sourceKey } })
		).toMatchObject({
			ok: true,
			value: {
				collections: [
					expect.objectContaining({
						board: expect.objectContaining({
							cards: [expect.objectContaining({ title: 'Second source' })],
						}),
					}),
				],
			},
		});
		const edited = result<Board>(await send(capture({ ...second.cards[0], title: 'Edited' }, 1)));
		expect(edited.cards[0].storageRevision).toBe(second.cards[0].storageRevision! + 1);
		expect(facade.read(roots[0], 'b')).toEqual(first);
	});

	it('rejects source/collection mismatch, stale collection/card revisions and invalid query without writes', async () => {
		const old = capture();
		const saved = result<Board>(await send(old));
		const before = facade.query();
		expect(await send(old)).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(await send(capture({ ...saved.cards[0], storageRevision: 900 }))).toMatchObject({
			ok: false,
			error: { code: 'stale-revision' },
		});
		expect(
			await raw({
				...capture(saved.cards[0]),
				target: { ...target(), collectionKey: target(1).collectionKey },
			})
		).toMatchObject({ ok: false, error: { code: 'not-found' } });
		expect(await send({ action: 'query', query: { sourceKey: 'missing' } })).toMatchObject({
			ok: false,
			error: { code: 'legacy-mapping-missing' },
		});
		expect(await raw({ action: 'query', query: { surprise: true } })).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(facade.query()).toEqual(before);
	});

	it('re-reads membership and rejects foreign pins, incompatible roles and repository escape', async () => {
		for (const change of [
			{ assigneeAgentId: 'foreign' },
			{ role: { namespace: namespaces[0], profileId: 'role' }, assigneeAgentId: 'foreign' },
			{ workingDirectory: roots[1] },
		]) {
			expect(await send(capture(card(change)))).toMatchObject({
				ok: false,
				error: { code: 'invalid-input' },
			});
		}
		agents = agents.map((agent) => (agent.id === 'a' ? { ...agent, groupId: 'other' } : agent));
		expect(await send(capture())).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: expect.stringContaining('pin-outside-scope') },
		});
		expect(facade.read(roots[0], 'b').cards).toEqual([]);
	});

	it('refuses authority forgery at each envelope and never grants approval through status or capture', async () => {
		const command = capture();
		if (command.action !== 'capture') throw new Error('fixture');
		for (const forged of [
			{ ...command, human: true },
			{ ...command, actorAuthority: 'human' },
			{ ...command, capture: { ...command.capture, human: true } },
			{
				...command,
				capture: { ...command.capture, card: { ...command.capture.card, actorAuthority: 'human' } },
			},
		]) {
			expect(await raw(forged)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
		}
		expect(await send(capture(card({ startModeOverride: 'direct' })))).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: expect.stringContaining('unauthorized-start-mode') },
		});
		let saved = result<Board>(await send(command));
		expect(
			await send(
				capture({
					...saved.cards[0],
					capturePolicy: { ...saved.cards[0].capturePolicy!, dispatchApproval: 'granted' },
				})
			)
		).toMatchObject({ ok: false, error: { code: 'protected-field' } });
		expect(
			await raw({
				action: 'status',
				target: target(),
				cardId: 'c',
				cardRevision: saved.cards[0].storageRevision,
				status: 'ready',
			})
		).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
		saved = result<Board>(
			await send({
				action: 'status',
				target: target(),
				cardId: 'c',
				cardRevision: saved.cards[0].storageRevision!,
				status: 'done',
			})
		);
		expect(saved.cards[0].capturePolicy!.dispatchApproval).toBe('required');
	});

	it('preserves authorized direct collection intent for ordinary creators', async () => {
		const board = facade.read(roots[0], 'b');
		// Fixture of a collection whose owner already authorized direct planning.
		db.prepare(
			"UPDATE collections SET payload_json = json_set(payload_json, '$.defaultStartMode', 'direct') WHERE source_key = ? AND collection_key = ?"
		).run(board.storage!.sourceKey, board.storage!.collectionKey);
		const saved = result<Board>(await send(capture(card({ startModeOverride: 'direct' }))));
		expect(saved.cards[0].capturePolicy).toMatchObject({
			effectiveStartMode: 'direct',
			dispatchApproval: 'not-required',
		});
	});

	it('bootstraps the first collection over the real host and native IPC without a migration fixture', async () => {
		const root = path.join(dir, 'fresh');
		fs.mkdirSync(root);
		const [sourceKey] = facade.resolveSourceKeys(root);
		expect(
			db.prepare('SELECT 1 FROM board_sources WHERE source_key=?').get(sourceKey)
		).toBeUndefined();
		const first = result<Board>(
			await send({ action: 'create', projectRoot: root, sourceKey, name: 'First' })
		);
		expect(facade.read(root, first.id).name).toBe('First');
		const nativeRoot = path.join(dir, 'fresh-native');
		fs.mkdirSync(nativeRoot);
		registerBoardHandlers({ getCueEngine: () => null });
		const second = await ipcHandlers.get('board:create')!(
			{},
			{ projectRoot: nativeRoot, name: 'Native first' }
		);
		expect(facade.read(nativeRoot, second.id).name).toBe('Native first');
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 2 });
		expect(first.defaultStartMode ?? 'approval').toBe('approval');
		expect(second.defaultStartMode ?? 'approval').toBe('approval');
	});

	it('runs revision-bound CRUD on the same persisted facade and refuses wrong create sources', async () => {
		expect(
			await send({
				action: 'create',
				projectRoot: roots[0],
				sourceKey: target(1).sourceKey,
				name: 'Wrong',
			})
		).toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
		const created = result<Board>(
			await send({
				action: 'create',
				projectRoot: roots[0],
				sourceKey: target().sourceKey,
				name: 'New',
			})
		);
		expect(facade.read(roots[0], created.id).name).toBe('New');
		const saved = result<Board>(await send(capture()));
		const renamed = result<Board>(
			await send({ action: 'rename', target: target(), name: 'Renamed' })
		);
		expect(renamed.name).toBe('Renamed');
		expect(
			await send({ action: 'delete-card', target: target(), cardId: 'c', cardRevision: 999 })
		).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(
			result<Board>(
				await send({
					action: 'delete-card',
					target: target(),
					cardId: 'c',
					cardRevision: saved.cards[0].storageRevision!,
				})
			).cards
		).toEqual([]);
		expect((await send({ action: 'delete', target: target() })).ok).toBe(true);
	});

	it('preserves the caller revision if another SQLite connection writes between host query and CRUD', async () => {
		const selected = target();
		const otherDb = openBoardDb(path.join(dir, 'board.sqlite'));
		const query = facade.query.bind(facade);
		const spy = vi.spyOn(facade, 'query').mockImplementationOnce((filter) => {
			const snapshot = query(filter);
			const other = new BoardStorageFacade(otherDb);
			const board = other.read(roots[0], 'b');
			board.name = 'Concurrent writer';
			other.save(roots[0], [board]);
			return snapshot;
		});
		try {
			expect(
				await send({ action: 'rename', target: selected, name: 'Stale writer' })
			).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
			expect(facade.read(roots[0], 'b').name).toBe('Concurrent writer');
		} finally {
			spy.mockRestore();
			otherDb.close();
		}
	});

	it('rolls back capture and policy together on a real SQLite write failure', async () => {
		const before = facade.query();
		db.exec(
			"CREATE TRIGGER fail_transport_policy BEFORE UPDATE ON cards WHEN json_extract(NEW.payload_json, '$.capturePolicy') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture policy failure'); END"
		);
		expect(await send(capture())).toMatchObject({
			type: 'error',
			success: false,
			error: expect.stringContaining('fixture policy failure'),
		});
		expect(facade.query()).toEqual(before);
	});

	it('rejects unauthenticated native WebSocket upgrades', async () => {
		const status = await new Promise<number>((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/fixture-token/ws`, {
				headers: { [CLI_SECRET_HEADER]: 'wrong-secret' },
			});
			socket.on('unexpected-response', (_request, response) => {
				response.resume();
				socket.terminate();
				resolve(response.statusCode!);
			});
			socket.on('error', reject);
		});
		expect(status).toBe(401);
	});

	it('routes the desktop handler to the same host and rejects revoked sessions', async () => {
		const frames: Record<string, unknown>[] = [];
		const socket = {
			readyState: WebSocket.OPEN,
			send: (frame: string) => frames.push(JSON.parse(frame)),
		};
		const context = {
			send: (_client: unknown, frame: Record<string, unknown>) => frames.push(frame),
			reportHandlerError: vi.fn(),
		} as any;
		const client = { id: 'fixture', socket, isAuthorized: () => true } as any;
		await handleBoardCommand(context, client, {
			type: 'board_command',
			requestId: 'desktop-query',
			action: 'query',
			query: {},
		});
		await vi.waitFor(() =>
			expect(frames).toContainEqual(
				expect.objectContaining({
					type: 'board_command_result',
					requestId: 'desktop-query',
					ok: true,
				})
			)
		);
		client.isAuthorized = () => false;
		await handleBoardCommand(context, client, {
			type: 'board_command',
			requestId: 'revoked',
			...capture(),
		});
		expect(frames[1]).toMatchObject({
			requestId: 'revoked',
			ok: false,
			error: { code: 'protected-field' },
		});
		expect(facade.read(roots[0], 'b').cards).toEqual([]);
	});
});

describe('actual CLI parser, commands, authenticated host and SQLite', () => {
	it('captures as an unregistered creator and round-trips explicit identity, revision, scope, role and repository', async () => {
		const selected = target();
		const common = [
			'--agent',
			'creator',
			'--source',
			selected.sourceKey,
			'--collection',
			selected.collectionKey,
			'--json',
		];
		expect((await cli('list', '--json')).value).toHaveLength(2);
		expect((await cli('list', '--source', selected.sourceKey, '--json')).value).toHaveLength(1);
		expect(
			(await cli('list', '--collection', selected.collectionKey, '--json')).value
		).toHaveLength(1);
		expect((await cli('show', 'b', '--json')).value.details.message).toContain('ambiguous');
		expect(
			(
				await cli(
					'add-card',
					'b',
					'--title',
					'Captured',
					'--scope-group',
					'g',
					'--assignee-agent',
					'a',
					'--assignee',
					'role',
					'--profile-namespace',
					namespaces[0],
					'--repository',
					'repo0',
					'--working-directory',
					roots[0],
					'--start-mode',
					'approval',
					'--revision',
					String(selected.expectedRevision),
					...common
				)
			).code
		).toBe(0);
		let saved = facade.read(roots[0], 'b');
		const id = saved.cards[0].id;
		expect(saved.cards[0]).toMatchObject({
			title: 'Captured',
			role: { namespace: namespaces[0], profileId: 'role' },
			executionScope: { kind: 'group', groupId: 'g' },
			capturePolicy: { dispatchApproval: 'required' },
		});
		expect(db.prepare('SELECT * FROM workers').all()).toEqual([]);
		expect(
			(
				await cli(
					'update-card',
					id,
					'--title',
					'Edited',
					'--card-revision',
					String(saved.cards[0].storageRevision),
					...common
				)
			).code
		).toBe(0);
		saved = facade.read(roots[0], 'b');
		expect(saved.cards[0].title).toBe('Edited');
		expect((await cli('rename', 'b', 'Renamed', ...common)).code).toBe(0);
		expect((await cli('show', 'b', ...common)).value.name).toBe('Renamed');
		expect(
			(
				await cli(
					'remove-card',
					id,
					'--card-revision',
					String(saved.cards[0].storageRevision),
					...common
				)
			).code
		).toBe(0);
		expect(facade.read(roots[0], 'b').cards).toEqual([]);
		const created = await cli(
			'create',
			'Created',
			'--max-in-progress',
			'2',
			'--auto-decompose',
			...common
		);
		expect(created).toMatchObject({
			code: 0,
			value: { name: 'Created', maxInProgress: 2, autoDecompose: true },
		});
		expect((await cli('delete', 'b', ...common)).code).toBe(0);
		expect(facade.read(roots[1], 'b').name).toBe('Board 1');
	});

	it('rejects stale revisions, foreign pins, repository escapes, membership changes and authority flags without writes', async () => {
		const common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
		const captureArgs = ['add-card', 'b', '--title', 'Invalid', '--scope-group', 'g'];
		for (const flags of [
			['--assignee-agent', 'foreign'],
			['--repository', 'repo0', '--working-directory', roots[1]],
			['--revision', '999'],
			['--start-mode', 'direct'],
			['--scope-agent', 'a'],
			['--revision', '-1'],
		]) {
			const reply = await cli(...captureArgs, ...flags, ...common);
			expect(reply.code).toBe(1);
			expect(reply.value.details).toMatchObject({ code: expect.any(String) });
		}
		for (const flag of ['--human', '--actor-authority'])
			expect((await cli(...captureArgs, flag, 'true', ...common)).code).toBe(1);
		expect(facade.read(roots[0], 'b').cards).toEqual([]);
		agents = agents.map((agent) => (agent.id === 'a' ? { ...agent, groupId: 'other' } : agent));
		expect(
			(await cli(...captureArgs, '--assignee-agent', 'a', ...common)).value.details.captureErrors
		).toContain('pin-outside-scope');
	});

	it('preserves source/card collisions, current card revisions and approval on status patches while allowing authorized direct capture', async () => {
		const first = result<Board>(await send(capture()));
		await send(capture(card({ repositoryId: 'repo1', workingDirectory: roots[1] }), 1));
		expect(
			(await cli('update-card', 'c', '--title', 'Ambiguous', '--json')).value.details.message
		).toContain('ambiguous');
		const common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
		expect(
			(await cli('update-card', 'c', '--title', 'Stale', '--card-revision', '999', ...common)).value
				.details.code
		).toBe('stale-revision');
		expect(
			(await cli('rename', 'b', 'Stale', '--revision', '999', ...common)).value.details.code
		).toBe('stale-revision');
		expect((await cli('set-status', 'c', 'ready', ...common)).value.details.code).toBe(
			'invalid-input'
		);
		expect((await cli('set-status', 'c', 'done', ...common)).code).toBe(0);
		expect(facade.read(roots[0], 'b').cards[0].capturePolicy!.dispatchApproval).toBe('required');
		expect(facade.read(roots[1], 'b').cards[0].title).toBe('Work');
		db.prepare(
			"UPDATE collections SET payload_json = json_set(payload_json, '$.defaultStartMode', 'direct') WHERE source_key = ? AND collection_key = ?"
		).run(first.storage!.sourceKey, first.storage!.collectionKey);
		expect(
			(
				await cli(
					'add-card',
					'b',
					'--title',
					'Direct',
					'--scope-agent',
					'a',
					'--repository',
					'repo0',
					'--working-directory',
					roots[0],
					'--start-mode',
					'direct',
					...common
				)
			).code
		).toBe(0);
		expect(facade.read(roots[0], 'b').cards[1].capturePolicy!.dispatchApproval).toBe(
			'not-required'
		);
	});
});

it('reports an unavailable owning host as machine-readable CLI error without local DB fallback', async () => {
	fs.unlinkSync(path.join(dir, 'cli-server.json'));
	expect(await cli('list', '--json')).toMatchObject({
		code: 1,
		value: { details: { code: 'runtime-unavailable' } },
	});
});

it('updates canonical roles without legacy aliases and refuses CLI human review approval on the host', async () => {
	const saved = result<Board>(
		await send(capture(card({ role: { namespace: namespaces[0], profileId: 'role' } })))
	);
	const common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
	expect(
		(await cli('update-card', 'c', '--profile-namespace', namespaces[0], ...common)).code
	).toBe(0);
	expect(facade.read(roots[0], 'b').cards[0].role).toEqual(saved.cards[0].role);
	await cli('set-status', 'c', 'review', ...common);
	expect((await cli('set-status', 'c', 'done', ...common)).value.details.code).toBe(
		'protected-field'
	);
	expect(facade.read(roots[0], 'b').cards[0].status).toBe('review');
	for (const status of ['todo', 'blocked', 'done'])
		expect((await cli('set-status', 'c', status, ...common)).value.details.code).toBe(
			'protected-field'
		);
	const reviewing = facade.read(roots[0], 'b').cards[0];
	expect(await send(capture({ ...reviewing, status: 'done' }))).toMatchObject({
		ok: false,
		error: { code: 'protected-field' },
	});
});

function installBoardOwner(direct = true) {
	const request = capture(card({ startModeOverride: direct ? 'direct' : 'approval' }));
	if (request.action !== 'capture') throw new Error('capture required');
	facade.capture(request.capture, true);
	registerBoardWorker(db, 'a');
	setBoardWorkerAccess(db, 'a', [], ['repo0', 'repo1']);
	let settle!: (result: CardSpawnResult) => void;
	const service: BoardRunService = {
		spawn: vi.fn(async (_spec, hooks) => {
			if (!hooks.beforeLaunch()) return { output: '', exitCode: null, executionStarted: false };
			hooks.onStarted(12345);
			return new Promise<CardSpawnResult>((resolve) => {
				settle = resolve;
			});
		}),
		stop: vi.fn(),
		probe: () => 'unknown',
	};
	const owner = new BoardRuntime(
		facade,
		{
			info: { pid: 101, mode: 'host', bootTime: 1, startedAt: new Date(1).toISOString() },
			verify: () => ({ ok: true }),
		},
		() => ({
			registryRevision: 1,
			dispatchEnabled: true,
			agentStates: { a: { live: true, busy: false, location: { kind: 'local' } } },
			repository: {
				id: 'repo0',
				workingDirectory: roots[0],
				record: { id: 'repo0', workingDirectory: roots[0], validated: true },
				identity: 'fixture-git',
				location: { kind: 'local' },
			},
		}),
		service,
		() => 'unknown'
	);
	expect(owner.acquire()).toEqual({ ok: true });
	configureBoardRuntimeHost(() => owner);
	return {
		owner,
		service,
		finish: () =>
			settle({
				output: '<!-- maestro:card-complete -->',
				exitCode: 0,
				executionStarted: true,
				terminationConfirmed: true,
			}),
	};
}
const tick = (operationId = 'fixture-operation'): BoardCommand => ({
	action: 'tick',
	target: target(),
	operationId,
});
function control(operation: 'hold' | 'resume' | 'approve', runToken?: BoardRuntimeToken) {
	return {
		action: 'control' as const,
		target: target(),
		cardId: 'c',
		cardRevision: facade.read(roots[0], 'b').cards[0].storageRevision!,
		operation,
		...(runToken ? { runToken } : {}),
	};
}

describe('fenced host intake shared by desktop and real CLI', () => {
	it('holds and resumes an unstarted card through the same host without inventing a token or approval', async () => {
		installBoardOwner();
		const before = facade.read(roots[0], 'b').cards[0].capturePolicy;
		expect(await send(control('hold'))).toMatchObject({ ok: true });
		expect(facade.read(roots[0], 'b').cards[0].heldByUser).toBe(true);
		expect(await send(control('resume'))).toMatchObject({ ok: true });
		expect(facade.workspace.readCollection(target())!.cards[0].payload.heldByUser).toBe(false);
		expect(facade.read(roots[0], 'b').cards[0].capturePolicy).toEqual(before);
		expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM runs').all()).toEqual([]);
	});

	it('never resumes or releases a legacy attempt whose termination is unknown', async () => {
		installBoardOwner(false);
		const key = target();
		db.prepare(
			'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json) VALUES (?, ?, ?, ?, ?)'
		).run(
			'legacy-uncertain',
			key.collectionKey,
			'c',
			1,
			JSON.stringify({ raw: { workerAgentId: 'a' } })
		);
		expect(await send(control('hold'))).toMatchObject({ ok: true });
		expect(await send(control('resume'))).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
		expect(facade.read(roots[0], 'b').cards[0].heldByUser).toBe(true);
		expect(facade.read(roots[0], 'b').cards[0].capturePolicy!.dispatchApproval).toBe('required');
		expect(
			db.prepare('SELECT outcome_json FROM runs WHERE run_id=?').get('legacy-uncertain')
		).toEqual({ outcome_json: null });
	});
	it('returns runtime-unavailable offline without creating an owner or reservation', async () => {
		await send(capture());
		expect(await send(tick())).toMatchObject({ ok: false, error: { code: 'runtime-unavailable' } });
		const reply = await cli('tick', '--agent', 'creator', '--json');
		expect(reply).toMatchObject({ code: 1, value: { details: { code: 'runtime-unavailable' } } });
		expect(db.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
	});
	it('races desktop and actual Commander/WebSocket tick at one attempt and native service', async () => {
		const fixture = installBoardOwner();
		const request = tick();
		const [desktop, actualCli] = await Promise.all([
			executeBoardRuntimeCommand(request as Extract<BoardCommand, { action: 'tick' }>),
			cli('tick', '--agent', 'creator', '--json'),
		]);
		expect(desktop.ok).toBe(true);
		expect(actualCli.code).toBe(0);
		expect(fixture.service.spawn).toHaveBeenCalledTimes(1);
		expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(1);
		expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(1);
		expect(await send(request)).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		await send(tick('retry'));
		expect(fixture.service.spawn).toHaveBeenCalledTimes(1);
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
	});
	it('keeps a Stop reserved until matching termination and Resume clears only hold', async () => {
		const fixture = installBoardOwner();
		const reply = await send(tick());
		const token = result<{ runToken: BoardRuntimeToken }[]>(reply)[0].runToken;
		const stopped = await cancelBoardRuntimeCard(roots[0], 'b', 'c');
		expect(stopped.cards[0].heldByUser).toBe(true);
		expect(fixture.service.stop).toHaveBeenCalledWith(expect.objectContaining({ runToken: token }));
		expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(1);
		expect(await send(control('resume', token))).toMatchObject({
			ok: false,
			error: { reason: 'termination-unconfirmed' },
		});
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
		expect(await send(control('resume', token))).toMatchObject({ ok: true });
		expect(facade.read(roots[0], 'b').cards[0].heldByUser).not.toBe(true);
	});
	it('rejects authority forgery and required approval across native host/CLI/status', async () => {
		const fixture = installBoardOwner(false);
		expect(await send(tick())).toMatchObject({
			ok: true,
			value: [{ ok: false, reason: 'approval-required' }],
		});
		expect(await send(control('approve'))).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
		expect(await raw({ ...control('approve'), human: true })).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(await raw({ ...control('approve'), actorAuthority: 'human' })).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(
			await send({
				action: 'status',
				target: target(),
				cardId: 'c',
				cardRevision: facade.read(roots[0], 'b').cards[0].storageRevision!,
				status: 'todo',
			})
		).toMatchObject({ ok: true });
		expect(await send(tick('after-status'))).toMatchObject({
			ok: true,
			value: [{ reason: 'approval-required' }],
		});
		expect(fixture.service.spawn).not.toHaveBeenCalled();
		const approved = await executeBoardRuntimeCommand(
			control('approve'),
			'native-fixture-main-frame'
		);
		expect(approved).toMatchObject({ ok: true });
		expect(await send(tick('after-human-grant'))).toMatchObject({
			ok: true,
			value: [{ ok: true }],
		});
		expect(fixture.service.spawn).toHaveBeenCalledTimes(1);
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
	});
	it('rejects wrong attempt, source and unknown token without Stop or partial writes', async () => {
		const fixture = installBoardOwner();
		const reply = await send(tick());
		const token = result<{ runToken: BoardRuntimeToken }[]>(reply)[0].runToken;
		expect(
			await send(control('hold', { ...token, generation: token.generation + 1 }))
		).toMatchObject({ ok: false, error: { reason: 'attempt-conflict' } });
		const wrong = control('hold', token);
		wrong.target = target(1);
		expect(await send(wrong)).toMatchObject({ ok: false });
		expect(fixture.service.stop).not.toHaveBeenCalled();
		expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(1);
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
	});
});

it('uses the real desktop IPC handler and derives approval only from its main-frame sender', async () => {
	const fixture = installBoardOwner(false);
	const contents = { mainFrame: {} };
	registerBoardHandlers({
		getCueEngine: () => null,
		getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }) as never,
	});
	const handle = ipcHandlers.get('board:runtimeCommand')!;
	expect(
		await handle({ sender: {}, senderFrame: contents.mainFrame }, control('approve'))
	).toMatchObject({ ok: false, error: { code: 'protected-field' } });
	expect(await handle({ sender: contents, senderFrame: {} }, control('approve'))).toMatchObject({
		ok: false,
		error: { code: 'protected-field' },
	});
	expect(
		await handle(
			{ sender: contents, senderFrame: contents.mainFrame },
			{ ...control('approve'), human: true }
		)
	).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
	expect(
		await handle({ sender: contents, senderFrame: contents.mainFrame }, control('approve'))
	).toMatchObject({ ok: true });
	expect(await handle({ sender: contents, senderFrame: contents.mainFrame }, tick())).toMatchObject(
		{ ok: true, value: [{ ok: true }] }
	);
	expect(fixture.service.spawn).toHaveBeenCalledTimes(1);
	const token = db.prepare('SELECT specification_json FROM runs').get() as {
		specification_json: string;
	};
	const actualToken = JSON.parse(token.specification_json).runToken;
	expect(
		await cli(
			'hold',
			'c',
			'--agent',
			'creator',
			'--json',
			'--run-id',
			actualToken.runId,
			'--owner-epoch',
			String(actualToken.ownerEpoch),
			'--generation',
			String(actualToken.generation)
		)
	).toMatchObject({ code: 0, value: { accepted: true } });
	expect(fixture.service.stop).toHaveBeenCalledTimes(1);
	fixture.finish();
	await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
	expect(
		await cli(
			'resume',
			'c',
			'--agent',
			'creator',
			'--json',
			'--run-id',
			actualToken.runId,
			'--owner-epoch',
			String(actualToken.ownerEpoch),
			'--generation',
			String(actualToken.generation)
		)
	).toMatchObject({ code: 0, value: { accepted: true } });
});

it('invalidates native grants on specification edits and rejects stale approvals without starting', async () => {
	const fixture = installBoardOwner(false);
	const old = control('approve');
	expect(await executeBoardRuntimeCommand(old, 'native-main-frame')).toMatchObject({ ok: true });
	const saved = facade.read(roots[0], 'b');
	expect(
		await send(capture({ ...saved.cards[0], body: 'Changed after human approval' }))
	).toMatchObject({ ok: true });
	expect(await send(tick())).toMatchObject({ ok: true, value: [{ reason: 'approval-required' }] });
	await expect(executeBoardRuntimeCommand(old, 'native-main-frame')).rejects.toThrow(
		'changed since read'
	);
	expect(fixture.service.spawn).not.toHaveBeenCalled();
	expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
});

describe('source-owned canonical alias compatibility', () => {
	it.each(['canonical', 'trailingSlash', 'symlink', 'relative'])(
		'%s list/get and subsequent CLI mutations/control/tick keep the same source',
		async (kind) => {
			const foreign = facade.read(roots[1], 'b');
			const link = path.join(dir, 'alias');
			fs.symlinkSync(roots[0], link, 'junction');
			const root =
				kind === 'canonical'
					? roots[0]
					: kind === 'trailingSlash'
						? roots[0] + path.sep
						: kind === 'symlink'
							? link
							: path.relative(process.cwd(), roots[0]);
			const common = [
				'--project-root',
				root,
				'--source',
				target().sourceKey,
				'--collection',
				target().collectionKey,
				'--json',
			];
			expect((await cli('list', ...common)).code).toBe(0);
			expect((await cli('show', 'b', ...common)).code).toBe(0);
			expect(
				(
					await cli(
						'add-card',
						'b',
						'--title',
						'Alias work',
						'--scope-agent',
						'a',
						'--repository',
						'repo0',
						'--working-directory',
						roots[0],
						...common
					)
				).code
			).toBe(0);
			let board = facade.read(roots[0], 'b');
			const id = board.cards[0].id;
			expect(board.storage!.sourceKey).toBe(target().sourceKey);
			expect((await cli('update-card', id, '--title', 'Updated alias', ...common)).code).toBe(0);
			expect((await cli('rename', 'b', 'Alias board', ...common)).code).toBe(0);
			expect((await cli('set-status', id, 'todo', ...common)).code).toBe(0);
			// Install the existing real owner without changing this captured card.
			const fixture = installBoardOwner(false);
			expect((await cli('hold', id, ...common)).code).toBe(0);
			expect((await cli('resume', id, ...common)).code).toBe(0);
			const sessionsFile = path.join(dir, 'maestro-sessions.json');
			const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
			sessions.sessions[0].projectRoot = root;
			sessions.sessions[0].cwd = root;
			fs.writeFileSync(sessionsFile, JSON.stringify(sessions));
			expect(await cli('tick', '--agent', 'creator', ...common.slice(2))).toMatchObject({
				code: 0,
			});
			expect(fixture.service.spawn).not.toHaveBeenCalled();
			board = facade.read(roots[0], 'b');
			expect(board.name).toBe('Alias board');
			expect(board.cards.find((c) => c.id === id)).toMatchObject({
				title: 'Updated alias',
				capturePolicy: { dispatchApproval: 'required' },
			});
			expect(facade.read(roots[1], 'b')).toEqual(foreign);
			expect(
				await send({
					action: 'rename',
					target: { ...target(), projectRoot: roots[1] },
					name: 'Wrong',
				})
			).toMatchObject({ ok: false });
			expect(facade.read(roots[1], 'b')).toEqual(foreign);
		}
	);
});

it.each(['alias', 'source', 'collection', 'card'])(
	'rejects changed %s evidence during host canonical await without touching a foreign source',
	async (change) => {
		const saved = result<Board>(await send(capture()));
		const foreign = facade.read(roots[1], 'b');
		const link = path.join(dir, 'changing-alias');
		fs.symlinkSync(roots[0], link, 'junction');
		const selected = { ...target(), projectRoot: link };
		const realpath = fs.promises.realpath.bind(fs.promises);
		let entered!: () => void;
		let resume!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let first = true;
		const spy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
			expect(db.inTransaction).toBe(false);
			const resolved = await realpath(...args);
			if (first) {
				first = false;
				entered();
				await blocked;
			}
			return resolved;
		});
		try {
			const pending = executeBoardCommand({
				action: 'rename',
				target: selected,
				name: 'Must not land',
			});
			await started;
			if (change === 'alias') {
				fs.unlinkSync(link);
				fs.symlinkSync(roots[1], link, 'junction');
			} else if (change === 'source') {
				db.prepare('UPDATE board_source_locations SET payload_json=? WHERE source_key=?').run(
					JSON.stringify({ location: { kind: 'local' }, path: roots[1] }),
					selected.sourceKey
				);
			} else if (change === 'collection') {
				facade.save(roots[0], [{ ...saved, name: 'Concurrent writer' }]);
			} else {
				const concurrent = capture({ ...saved.cards[0], body: 'Concurrent writer' });
				if (concurrent.action !== 'capture') throw new Error('capture fixture');
				facade.capture(concurrent.capture);
			}
			resume();
			expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
			expect(facade.read(roots[1], 'b')).toEqual(foreign);
			expect(facade.read(roots[0], 'b').name).not.toBe('Must not land');
		} finally {
			resume();
			spy.mockRestore();
		}
	}
);

it.each(['alias', 'source'])(
	'rejects changed %s during runtime provider await before hold or dispatch',
	async (change) => {
		const fixture = installBoardOwner(false);
		const foreign = facade.read(roots[1], 'b');
		const link = path.join(dir, 'runtime-alias');
		fs.symlinkSync(roots[0], link, 'junction');
		let entered!: () => void;
		let resume!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			resume = resolve;
		});
		configureBoardRuntimeHost(async () => {
			entered();
			await blocked;
			return fixture.owner;
		});
		const request = control('hold');
		request.target.projectRoot = link;
		const pending = executeBoardCommand(request);
		await started;
		if (change === 'alias') {
			fs.unlinkSync(link);
			fs.symlinkSync(roots[1], link, 'junction');
		} else {
			db.prepare('UPDATE board_source_locations SET payload_json=? WHERE source_key=?').run(
				JSON.stringify({ location: { kind: 'local' }, path: roots[1] }),
				request.target.sourceKey
			);
		}
		resume();
		expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(facade.read(roots[0], 'b').cards[0].heldByUser).not.toBe(true);
		expect(facade.read(roots[1], 'b')).toEqual(foreign);
		expect(fixture.service.spawn).not.toHaveBeenCalled();
		expect(fixture.service.stop).not.toHaveBeenCalled();
	}
);
