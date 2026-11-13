import * as boardStorage from '../../../main/board/board-storage';
import { configureBoardFeatures } from '../../../main/board/board-feature';
import {
	readBoardIsolationRegistries,
	requireBoardIsolation,
} from '../../../main/board/board-isolation';
import {
	refreshBoardSources,
	configureIsolatedBoardSourceHost,
} from '../../../main/board/board-source-host';
import { registerBoardHandlers } from '../../../main/ipc/handlers/board';
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({
	ipcMain: {
		handle: (name: string, callback: (...args: any[]) => any) => ipcHandlers.set(name, callback),
	},
}));
const liveSessions = vi.hoisted(() => [{ id: 'a' }, { id: 'foreign' }]);
vi.mock('../../../main/stores/getters', () => ({ getLiveSessions: () => liveSessions }));
import { BoardRuntime, type BoardRunService } from '../../../main/board/board-runtime';
import {
	configureBoardRuntimeHost,
	executeBoardRuntimeCommand,
	cancelBoardRuntimeCard,
} from '../../../main/board/board-runtime-host';
import {
	registerBoardWorker,
	listBoardWorkers,
	setBoardWorkerAccess,
} from '../../../main/board/board-workspace-storage';
import type { BoardRuntimeToken } from '../../../shared/board/commands';
import type { CardSpawnResult } from '../../../main/board/board-dispatcher';
// @vitest-environment node
import {
	afterAll,
	beforeAll,
	afterEach,
	onTestFailed,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { context, type BuildContext } from 'esbuild';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson';
import { execFile, type ChildProcess } from 'node:child_process';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';
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
import { BridgeConnection, type FixtureBridgeAdmission } from './fixtures/board-fixture-bridge';
import { requestBoardCommand } from '../../../shared/maestro-lib/client/board';
import type { BoardCommand, BoardCommandReply } from '../../../shared/board/commands';
import {
	BOARD_SOURCE_PROJECT_PREFIX,
	type Board,
	type BoardCard,
} from '../../../shared/board/types';
import { CLI_SECRET_HEADER } from '../../../shared/webLogin';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

let cliBuildDir: string;
let cliBuild: BuildContext | undefined;
let proof: FixtureBridgeAdmission;
const isolationFixture = createBoardIsolationFixture({ privateHome: true });
beforeAll(async () => {
	isolationFixture.install();
	const isolation = requireBoardIsolation();
	readBoardIsolationRegistries(isolation);
	if (process.env.BOARD_ISOLATION_CONTRACT !== canonicalJson(isolation))
		throw new Error('Board transport requires a canonical parent contract');
	configureIsolatedBoardSourceHost(isolation);
	cliBuildDir = fs.mkdtempSync(path.join(isolation.root, 'board-cli-build-'));
});
afterAll(async () => {
	await cliBuild?.dispose();
	if (cliBuildDir) fs.rmSync(cliBuildDir, { recursive: true, force: true });
	await isolationFixture.cleanup();
});
const inFlightCli = new Map<ChildProcess, Promise<unknown>>();
let cliTeardown = false;
let cliSignal: AbortSignal;
const hostRequests = new Set<Promise<unknown>>();
let cliTimings: { command: string; ms: number }[] = [];

async function cli(...args: string[]) {
	const signal = cliSignal;
	if (cliTeardown) throw new Error('CLI fixture teardown has begun');
	signal.throwIfAborted();
	const startedAt = performance.now();
	const isolation = requireBoardIsolation({ expected: proof.contract });
	const script = path.join(cliBuildDir, 'cli.cjs');
	try {
		const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
		for (const key of [
			'PATH',
			'TMPDIR',
			'HOME',
			'CODEX_HOME',
			'BOARD_ISOLATION_ID',
			'BOARD_ISOLATION_CONTRACT',
			'BOARD_ISOLATED_ROOT',
			'BOARD_DB_PATH',
			'BOARD_SYNC_PATH',
			'BOARD_AGENT_REGISTRY',
			'BOARD_SOURCE_REGISTRY',
			'BOARD_SOURCE_ROOT',
			'MAESTRO_USER_DATA',
			'MAESTRO_DEMO_DIR',
			'MAESTRO_E2E_TEST',
		]) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
		// Keep native Windows homedir lookup and Git reads inside the same owned
		// fixture as the parent; omitting HOME would fall back to the OS account.
		env.USERPROFILE = env.HOME;
		env.GIT_CONFIG_NOSYSTEM = '1';
		env.GIT_CONFIG_GLOBAL = path.join(env.HOME!, '.gitconfig');
		const execution = promisify(execFile)(process.execPath, [script, 'board', ...args], {
			cwd: isolation.worktree,
			env,
			timeout: 30000,
			maxBuffer: 1024 * 1024,
		});
		inFlightCli.set(execution.child, execution);
		const stopOnAbort = () =>
			stopProcess(
				{ child: execution.child },
				{ from: 'terminate', graceMs: 0, immediate: true, blocking: true }
			);
		signal.addEventListener('abort', stopOnAbort, { once: true });
		let output;
		try {
			output = await execution;
			signal.throwIfAborted();
		} finally {
			signal.removeEventListener('abort', stopOnAbort);
			inFlightCli.delete(execution.child);
			cliTimings.push({ command: args[0], ms: performance.now() - startedAt });
		}
		return { code: 0, value: JSON.parse(output.stdout) };
	} catch (error) {
		signal.throwIfAborted();
		const failure = error as { code: number; stdout: string; stderr: string };
		return {
			code: failure.code,
			value: failure.stdout
				? JSON.parse(failure.stdout)
				: { stderr: failure.stderr ?? String(error) },
		};
	}
}

let dir: string;
let databasePath: string;
let ownsDatabase = false;
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

beforeEach(async ({ signal }) => {
	cliSignal = signal;
	cliTimings = [];
	onTestFailed(() =>
		console.info(
			'[board-cli-fixture-lifecycle]',
			JSON.stringify({
				commands: cliTimings,
				inFlight: inFlightCli.size,
				hostRequests: hostRequests.size,
				dbOpen: db?.open,
			})
		)
	);
	cliTeardown = false;
	expect(inFlightCli.size).toBe(0);
	dir = '';
	ownsDatabase = false;
	connection = undefined as unknown as BridgeConnection;
	server = undefined as unknown as RuntimeServer;
	runtime = undefined as unknown as MaestroRuntime;
	const isolation = requireBoardIsolation();
	readBoardIsolationRegistries(isolation);
	databasePath = isolation.db;
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(databasePath + suffix)) throw new Error('Board test database must be fresh');
	}
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	dir = fs.mkdtempSync(path.join(isolation.root, 'board-transport-'));
	roots = (readBoardIsolationRegistries(isolation).sources as { root: string }[]).map(
		(source) => source.root
	);
	if (roots.length !== 2) throw new Error('Board transport requires two registered roots');
	db = openBoardDb(databasePath);
	ownsDatabase = true;
	namespaces = roots.map((root, i) => {
		fs.mkdirSync(root, { recursive: true });
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
		path.join(isolation.sync, 'maestro-settings.json'),
		JSON.stringify({ encoreFeatures: { board: true, maestroCue: true } })
	);
	fs.writeFileSync(
		path.join(isolation.sync, 'maestro-sessions.json'),
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
		cliSecret: 'parent-owned-fixture-secret',
		boardHost: async (command) => {
			const pending = executeBoardCommand(command);
			hostRequests.add(pending);
			try {
				return await pending;
			} finally {
				hostRequests.delete(pending);
			}
		},
		onStopRequested() {},
	});
	const manifestPath = path.join(dir, 'endpoint.json');
	const manifest = canonicalJson({
		version: 1,
		identity: isolation.identity,
		ownerPid: process.pid,
		url: `ws://127.0.0.1:${server.port}/fixture-token/ws`,
		cliSecret: 'parent-owned-fixture-secret',
	});
	fs.writeFileSync(manifestPath, manifest, { mode: 0o600 });
	proof = {
		contract: isolation,
		manifestPath,
		manifestSha256: createHash('sha256').update(manifest).digest('hex'),
		ownerPid: process.pid,
	};
	const fixture = path.resolve('src/__tests__/main/board/fixtures/board-fixture-bridge.ts');
	cliBuild ??= await context({
		entryPoints: ['src/cli/index.ts'],
		outfile: path.join(cliBuildDir, 'cli.cjs'),
		bundle: true,
		platform: 'node',
		packages: 'external',
		logLevel: 'silent',
		plugins: [
			{
				name: 'board-fixture-bridge',
				setup(builder) {
					builder.onResolve({ filter: /(?:^|\/)bridge-connection$/ }, (args) => {
						if (args.importer === fixture) return undefined;
						const resolved = path.resolve(args.resolveDir, args.path) + '.ts';
						return resolved === path.resolve('src/shared/maestro-lib/client/bridge-connection.ts')
							? { path: 'fixture', namespace: 'board-fixture' }
							: undefined;
					});
					builder.onLoad({ filter: /.*/, namespace: 'board-fixture' }, () => ({
						contents: `import { admitFixtureBridge } from ${JSON.stringify(fixture)}; admitFixtureBridge(${JSON.stringify(proof)}); export * from ${JSON.stringify(fixture)};`,
						loader: 'ts',
						resolveDir: isolation.worktree,
					}));
				},
			},
		],
	});
	await cliBuild.rebuild();
	connection = new BridgeConnection({ fixture: proof, strictReplies: true });
	await connection.connect();
});
afterEach(async () => {
	cliTeardown = true;
	for (const child of inFlightCli.keys())
		stopProcess({ child }, { from: 'terminate', graceMs: 0, immediate: true, blocking: true });
	await Promise.allSettled([...inFlightCli.values()]);
	expect(inFlightCli.size).toBe(0);
	try {
		configureBoardRuntimeHost(() => null);
		connection?.disconnect();
		await server?.close();
		await Promise.allSettled([...hostRequests]);
	} finally {
		try {
			await runtime?.connection.close();
		} finally {
			try {
				// Like the runtime fixture, leave the explicitly owned facade installed;
				// isolation deliberately rejects resetting to the machine default.
				configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
			} finally {
				try {
					if (ownsDatabase) db.close();
				} finally {
					try {
						if (ownsDatabase)
							for (const suffix of ['', '-wal', '-shm'])
								fs.rmSync(databasePath + suffix, { force: true });
					} finally {
						if (dir) fs.rmSync(dir, { recursive: true, force: true });
					}
				}
			}
		}
	}
});

describe('Board through native runtime/WebSocket and real SQLite', () => {
	// Each real CLI child has startup/connection overhead. Independent operations
	// get separate host/DB lifetimes and the unchanged per-test timeout.
	it('routes worker lifecycle: rejects an unknown agent without writes', async () => {
		const before = db.prepare('SELECT * FROM workers ORDER BY agent_id').all();
		expect((await cli('worker-register', '--agent', 'missing', '--json')).code).toBe(1);
		expect(db.prepare('SELECT * FROM workers ORDER BY agent_id').all()).toEqual(before);
	});

	it.each([
		['register', false, { agentId: 'a', enabled: true, paused: false }],
		['pause', false, { agentId: 'a', enabled: true, paused: true }],
		['resume', true, { agentId: 'a', enabled: true, paused: false }],
		['unregister', false, { agentId: 'a', enabled: false }],
	] as const)(
		'routes worker lifecycle: %s through the host',
		async (operation, paused, expected) => {
			if (operation !== 'register') {
				result(
					await send({
						action: 'worker-lifecycle',
						agentId: 'a',
						operation: 'register',
						expected: null,
					})
				);
				if (paused)
					result(
						await send({
							action: 'worker-lifecycle',
							agentId: 'a',
							operation: 'pause',
							expected: canonicalJson(listBoardWorkers(db)[0]),
						})
					);
			}
			expect(await cli(`worker-${operation}`, '--agent', 'a', '--json')).toMatchObject({
				code: 0,
				value: expected,
			});
			expect(listBoardWorkers(db)).toEqual([expect.objectContaining(expected)]);
		}
	);

	it('routes worker lifecycle: lists an unregistered worker through the CLI', async () => {
		result(
			await send({
				action: 'worker-lifecycle',
				agentId: 'a',
				operation: 'register',
				expected: null,
			})
		);
		result(
			await send({
				action: 'worker-lifecycle',
				agentId: 'a',
				operation: 'unregister',
				expected: canonicalJson(listBoardWorkers(db)[0]),
			})
		);
		expect((await cli('worker-list', '--json')).value).toEqual([
			expect.objectContaining({ agentId: 'a', enabled: false }),
		]);
	});

	describe('reads and patches one worker through the CLI, preserving other workers and profiles', () => {
		const options = {
			customModel: 'fixture-model',
			customEffort: 'high',
			appendSystemPrompt: 'fixture',
			customArgs: '--fixture',
		} as const;
		let otherBefore: unknown;
		let profilesBefore: unknown;
		beforeEach(() => {
			registerBoardWorker(db, 'a');
			registerBoardWorker(db, 'foreign');
			otherBefore = db.prepare('SELECT * FROM workers WHERE agent_id = ?').get('foreign');
			profilesBefore = db.prepare('SELECT * FROM profiles ORDER BY profile_namespace, id').all();
		});
		afterEach(() => {
			expect(db.prepare('SELECT * FROM workers WHERE agent_id = ?').get('foreign')).toEqual(
				otherBefore
			);
			expect(db.prepare('SELECT * FROM profiles ORDER BY profile_namespace, id').all()).toEqual(
				profilesBefore
			);
		});
		it('reads the registered worker', async () => {
			expect((await cli('worker-options', '--agent', 'a', '--json')).code).toBe(0);
		});
		it('patches options and rejects a stale host revision without writes', async () => {
			const changed = await cli(
				'worker-options',
				'--agent',
				'a',
				'--set',
				JSON.stringify(options),
				'--json'
			);
			expect(changed).toMatchObject({
				code: 0,
				value: { agentId: 'a', payload: { executionOptions: options } },
			});
			const before = db.prepare('SELECT * FROM workers ORDER BY agent_id').all();
			const stale = await send({
				action: 'set-worker-options',
				command: { agentId: 'a', expectedPayload: '{}', patch: { customModel: 'stale' } },
			});
			expect(stale).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
			expect(db.prepare('SELECT * FROM workers ORDER BY agent_id').all()).toEqual(before);
		});
		it('clears only the nullable effort and reads the persisted options', async () => {
			result(
				await send({
					action: 'set-worker-options',
					command: {
						agentId: 'a',
						expectedPayload: canonicalJson(
							listBoardWorkers(db).find((worker) => worker.agentId === 'a')!.payload
						),
						patch: options,
					},
				})
			);
			expect(
				(await cli('worker-options', '--agent', 'a', '--set', '{"customEffort":null}', '--json'))
					.code
			).toBe(0);
			expect(
				(await cli('worker-options', '--agent', 'a', '--json')).value.payload.executionOptions
			).toEqual({
				customModel: 'fixture-model',
				appendSystemPrompt: 'fixture',
				customArgs: '--fixture',
			});
		});
		it('rejects an empty model without writes', async () => {
			result(
				await send({
					action: 'set-worker-options',
					command: {
						agentId: 'a',
						expectedPayload: canonicalJson(
							listBoardWorkers(db).find((worker) => worker.agentId === 'a')!.payload
						),
						patch: { ...options, customEffort: null },
					},
				})
			);
			const before = db.prepare('SELECT * FROM workers ORDER BY agent_id').all();
			expect(
				(await cli('worker-options', '--agent', 'a', '--set', '{"customModel":""}', '--json')).code
			).toBe(1);
			expect(db.prepare('SELECT * FROM workers ORDER BY agent_id').all()).toEqual(before);
		});
	});
	it('initializes the global destination over the authenticated bridge and captures root-free through the same host', async () => {
		const original = facade.query();
		const board = result<Board>(await send({ action: 'initialize' }));
		const ref = board.storage!;
		const projectRoot = BOARD_SOURCE_PROJECT_PREFIX + ref.sourceKey;
		const reply = await send({
			action: 'capture',
			target: {
				projectRoot,
				sourceKey: ref.sourceKey,
				collectionKey: ref.collectionKey,
				expectedRevision: ref.expectedRevision!,
			},
			capture: {
				projectRoot,
				boardId: board.id,
				expectedRevision: ref.expectedRevision!,
				card: {
					id: 'first-global',
					title: 'Global draft',
					body: '',
					parents: [],
					status: 'todo',
					createdAt: '',
					updatedAt: '',
				},
			},
		});
		const saved = result<Board>(reply);
		expect(saved.cards[0].capturePolicy!.dispatchApproval).toBe('required');
		expect(reply).toMatchObject({
			readiness: { 'first-global': expect.arrayContaining(['repository-unresolved']) },
		});
		expect(result<Board>(await send({ action: 'initialize' }))).toEqual(saved);
		expect(facade.query().collections.filter((entry) => entry.sourceKey !== ref.sourceKey)).toEqual(
			original.collections
		);
		expect(
			db.prepare('SELECT * FROM board_source_locations WHERE source_key=?').all(ref.sourceKey)
		).toEqual([]);
	});

	it('keeps migrated physical source identities through the host and a real CLI child', async () => {
		for (const [index, root] of roots.entries()) {
			expect(await fs.promises.realpath(root)).toBe(root);
			const selected = target(index);
			expect(namespaces[index]).toBe(`legacy:${selected.sourceKey}`);
			expect(
				facade.query().sources.find((source) => source.sourceKey === selected.sourceKey)
			).toEqual({
				sourceKey: selected.sourceKey,
				projectRef: { sourceKey: selected.sourceKey },
				location: { location: { kind: 'local' }, path: root },
			});
			expect(await send({ action: 'query', query: { projectRoot: root } })).toMatchObject({
				ok: true,
				value: { collections: [{ sourceKey: selected.sourceKey }] },
			});
			const shown = await cli(
				'show',
				'b',
				'--project-root',
				root,
				'--source',
				selected.sourceKey,
				'--collection',
				selected.collectionKey,
				'--json'
			);
			expect(shown.code, JSON.stringify(shown.value)).toBe(0);
			expect(shown.value).toMatchObject({
				storage: { sourceKey: selected.sourceKey, collectionKey: selected.collectionKey },
			});
		}
	});

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
		const saved = result<Board>(await send(command));
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
		expect(
			await send({
				action: 'status',
				target: target(),
				cardId: 'c',
				cardRevision: saved.cards[0].storageRevision!,
				status: 'done',
			})
		).toMatchObject({ ok: false, error: { code: 'protected-field' } });
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
		fs.mkdirSync(root, { recursive: true });
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
		const otherDb = openBoardDb(databasePath);
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
	it('refuses removal using a stale card revision and preserves the persisted card', async () => {
		await send(capture());
		const before = facade.read(roots[0], 'b');
		const reply = await cli(
			'remove-card',
			'c',
			'--project-root',
			roots[0],
			'--source',
			target().sourceKey,
			'--card-revision',
			'999',
			'--force',
			'--json'
		);
		expect(reply.code).toBe(1);
		expect(reply.value.details.code).toBe('stale-revision');
		expect(facade.read(roots[0], 'b')).toEqual(before);
	});

	it('passes a native review source to host validation without accepting foreign authority', async () => {
		const selected = target();
		const contents = { mainFrame: {} };
		registerBoardHandlers({
			getCueEngine: () => null,
			getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }) as never,
		});
		const input = {
			projectRoot: selected.projectRoot,
			boardId: 'b',
			expectedRevision: selected.expectedRevision,
			card: card({ kind: 'review', parents: ['work'] }),
			reviewSource: { cardId: 'work', attempt: 0 },
		};
		const handler = ipcHandlers.get('board:captureCard')!;
		const native = { sender: contents, senderFrame: contents.mainFrame };
		expect(await handler(native, input)).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: 'Invalid review source attempt' },
		});
		expect(await handler(native, { ...input, unexpected: true })).toMatchObject({
			ok: false,
			error: { code: 'invalid-input', message: 'Invalid capture command' },
		});
		expect(await handler({ sender: {}, senderFrame: {} }, input)).toMatchObject({
			ok: false,
			error: { code: 'protected-field' },
		});
	});

	it('captures globally without a project and shares cards with the host', async () => {
		const added = await cli('add-card', '--title', 'CLI global', '--json');
		expect(added.code).toBe(0);
		const global = result<Board>(await send({ action: 'initialize' }));
		expect(global.cards.map((item) => item.id)).toContain(added.value.id);
		const identity = global.storage!;
		const projectRoot = BOARD_SOURCE_PROJECT_PREFIX + identity.sourceKey;
		const hostCard = card({
			id: 'host-card',
			title: 'Host global',
			executionScope: undefined,
			assigneeAgentId: undefined,
			repositoryId: undefined,
			workingDirectory: undefined,
		});
		const contents = { mainFrame: {} };
		registerBoardHandlers({
			getCueEngine: () => null,
			getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }) as never,
		});
		const hostCapture = await ipcHandlers.get('board:captureCard')!(
			{ sender: contents, senderFrame: contents.mainFrame },
			{
				projectRoot,
				boardId: global.id,
				expectedRevision: identity.expectedRevision!,
				card: hostCard,
			}
		);
		expect(hostCapture.ok).toBe(true);
		const shown = await cli('show', global.id, '--json');
		expect(shown.code).toBe(0);
		expect(shown.value.cards.map((item: BoardCard) => item.title)).toEqual([
			'CLI global',
			'Host global',
		]);
		const stale = await cli('add-card', '--title', 'Stale', '--revision', '0', '--json');
		expect(stale.code).toBe(1);
		expect(
			(await cli('add-card', '--title', 'Ambiguous', '--agent', 'creator', '--json')).code
		).toBe(1);
	});
	describe('unregistered creator CLI capture round-trips identity, revision, scope, role and repository', () => {
		let common: string[], id: string, saved: Board;
		// Capture setup is a real CLI call. Each independently asserted operation
		// has the unchanged 10s test budget and a fresh host/DB lifecycle.
		beforeEach(async () => {
			const selected = target();
			common = [
				'--agent',
				'creator',
				'--source',
				selected.sourceKey,
				'--collection',
				selected.collectionKey,
				'--json',
			];
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
			saved = facade.read(roots[0], 'b');
			id = saved.cards[0].id;
			expect(saved.cards[0]).toMatchObject({
				title: 'Captured',
				role: { namespace: namespaces[0], profileId: 'role' },
				executionScope: { kind: 'group', groupId: 'g' },
				capturePolicy: { dispatchApproval: 'required' },
			});
			expect(db.prepare('SELECT * FROM workers').all()).toEqual([]);
		});
		it('updates the captured card through the CLI', async () => {
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
		});
		it('renames and reads the captured collection through the CLI', async () => {
			expect((await cli('rename', 'b', 'Renamed', ...common)).code).toBe(0);
			expect((await cli('show', 'b', ...common)).value.name).toBe('Renamed');
		});
		it('removes the captured card through the CLI', async () => {
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
		});
	});

	it('creates and deletes a collection without touching a foreign source', async () => {
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
		// Repeated CLI children include Node startup and authenticated host queries.
		// Keep each child at 15s and the outer suite runner at 180s.
	}, 30000);

	describe('dependencies and priority through real CLI', () => {
		it('captures the original parent through the CLI', async () => {
			const selected = target();
			const foreign = facade.read(roots[1], 'b');
			expect(
				(
					await cli(
						'add-card',
						'b',
						'--title',
						'Parent',
						'--source',
						selected.sourceKey,
						'--collection',
						selected.collectionKey,
						'--json'
					)
				).code
			).toBe(0);
			expect(facade.read(roots[0], 'b').cards[0].title).toBe('Parent');
			expect(facade.read(roots[1], 'b')).toEqual(foreign);
		});
		it('captures the original child dependency and high priority through the CLI', async () => {
			result(await send(capture(card({ id: 'parent', title: 'Parent' }))));
			const parent = facade.read(roots[0], 'b').cards[0];
			const selected = target();
			const foreign = facade.read(roots[1], 'b');
			expect(
				(
					await cli(
						'add-card',
						'b',
						'--title',
						'Child',
						'--parents',
						parent.id,
						'--priority',
						'high',
						'--source',
						selected.sourceKey,
						'--collection',
						selected.collectionKey,
						'--json'
					)
				).code
			).toBe(0);
			expect(
				facade.read(roots[0], 'b').cards.find((entry) => entry.title === 'Child')
			).toMatchObject({ parents: [parent.id], priority: 'high' });
			expect(facade.read(roots[1], 'b')).toEqual(foreign);
		});
		describe('with host-captured dependency prerequisites', () => {
			let parent: BoardCard;
			let child: BoardCard;
			let common: string[];
			let foreign: Board;
			beforeEach(async () => {
				result(await send(capture(card({ id: 'parent', title: 'Parent' }))));
				parent = facade.read(roots[0], 'b').cards[0];
				result(
					await send(
						capture(card({ id: 'child', title: 'Child', parents: [parent.id], priority: 'high' }))
					)
				);
				child = facade.read(roots[0], 'b').cards.find((entry) => entry.id === 'child')!;
				const selected = target();
				common = ['--source', selected.sourceKey, '--collection', selected.collectionKey, '--json'];
				foreign = facade.read(roots[1], 'b');
			});
			it('filters the original high-priority child through the CLI', async () => {
				const filtered = await cli('show', 'b', '--priority', 'high', ...common);
				expect(filtered.code).toBe(0);
				expect(filtered.value.cards.map((entry: BoardCard) => entry.id)).toEqual([child.id]);
				expect(facade.read(roots[1], 'b')).toEqual(foreign);
			});
			it('rejects the original dependency cycle without writes through the CLI', async () => {
				const before = facade.read(roots[0], 'b');
				expect((await cli('update-card', parent.id, '--parents', child.id, ...common)).code).toBe(
					1
				);
				expect(facade.read(roots[0], 'b')).toEqual(before);
				expect(facade.read(roots[1], 'b')).toEqual(foreign);
			});
			it('clears original dependencies and lowers priority through the CLI', async () => {
				expect(
					(await cli('update-card', child.id, '--parents', '', '--priority', 'low', ...common)).code
				).toBe(0);
				expect(
					facade.read(roots[0], 'b').cards.find((entry) => entry.id === child.id)
				).toMatchObject({ parents: [], priority: 'low' });
				expect(facade.read(roots[1], 'b')).toEqual(foreign);
			});
		});
	});

	it('rejects conflicting role aliases without changing the captured card', async () => {
		const selected = target();
		const common = [
			'--source',
			selected.sourceKey,
			'--collection',
			selected.collectionKey,
			'--json',
		];
		expect((await cli('add-card', 'b', '--title', 'Preserved', ...common)).code).toBe(0);
		const before = facade.read(roots[0], 'b');
		const reply = await cli(
			'update-card',
			before.cards[0].id,
			'--role',
			'role',
			'--assignee',
			'other',
			'--role-namespace',
			namespaces[0],
			...common
		);
		expect(reply.code).toBe(1);
		expect(facade.read(roots[0], 'b')).toEqual(before);
	});

	it.each([
		['foreign pin', ['--assignee-agent', 'foreign']],
		['repository escape', ['--repository', 'repo0', '--working-directory', 'foreign-root']],
		['stale revision', ['--revision', '999']],
		['unauthorized direct capture', ['--start-mode', 'direct']],
		['conflicting scope', ['--scope-agent', 'a']],
		['negative revision', ['--revision', '-1']],
	] as const)(
		'rejects stale revisions, foreign pins and authority flags: %s without writes',
		async (_name, flags) => {
			const common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
			const before = facade.read(roots[0], 'b');
			const reply = await cli(
				'add-card',
				'b',
				'--title',
				'Invalid',
				'--scope-group',
				'g',
				...flags.map((flag) => (flag === 'foreign-root' ? roots[1] : flag)),
				...common
			);
			expect(reply.code).toBe(1);
			expect(reply.value.details).toMatchObject({ code: expect.any(String) });
			expect(facade.read(roots[0], 'b')).toEqual(before);
		}
	);

	it('rejects forged authority and changed group membership without writes', async () => {
		const common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
		const captureArgs = ['add-card', 'b', '--title', 'Invalid', '--scope-group', 'g'];
		for (const flag of ['--human', '--actor-authority'])
			expect((await cli(...captureArgs, flag, 'true', ...common)).code).toBe(1);
		expect(facade.read(roots[0], 'b').cards).toEqual([]);
		agents = agents.map((agent) => (agent.id === 'a' ? { ...agent, groupId: 'other' } : agent));
		expect(
			(await cli(...captureArgs, '--assignee-agent', 'a', ...common)).value.details.captureErrors
		).toContain('pin-outside-scope');
	});

	describe('preserves source/card collisions, current card revisions and approval', () => {
		let first: Board;
		let common: string[];
		let before: Board[];
		beforeEach(async () => {
			first = result<Board>(await send(capture()));
			result(await send(capture(card({ repositoryId: 'repo1', workingDirectory: roots[1] }), 1)));
			common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
			before = roots.map((root) => facade.read(root, 'b'));
		});
		it.each([
			[
				'ambiguous source',
				['update-card', 'c', '--title', 'Ambiguous', '--json'],
				false,
				'ambiguous',
			],
			[
				'stale card revision',
				['update-card', 'c', '--title', 'Stale', '--card-revision', '999'],
				true,
				'stale-revision',
			],
			[
				'stale collection revision',
				['rename', 'b', 'Stale', '--revision', '999'],
				true,
				'stale-revision',
			],
			['invalid ready status', ['set-status', 'c', 'ready'], true, 'invalid-input'],
			['unauthorized done status', ['set-status', 'c', 'done'], true, null],
		] as const)(
			'rejects %s without changing either source or approval',
			async (_name, args, scoped, error) => {
				const reply = await cli(...args, ...(scoped ? common : []));
				expect(reply.code).toBe(1);
				if (error === 'ambiguous') expect(reply.value.details.message).toContain('ambiguous');
				else if (error) expect(reply.value.details.code).toBe(error);
				expect(roots.map((root) => facade.read(root, 'b'))).toEqual(before);
				expect(facade.read(roots[0], 'b').cards[0].capturePolicy!.dispatchApproval).toBe(
					'required'
				);
				expect(facade.read(roots[1], 'b').cards[0].title).toBe('Work');
			}
		);
		it('allows authorized direct capture without changing the foreign card or existing approval', async () => {
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
			const saved = facade.read(roots[0], 'b');
			expect(saved.cards[1].capturePolicy!.dispatchApproval).toBe('not-required');
			expect(saved.cards[0]).toEqual(before[0].cards[0]);
			expect(facade.read(roots[1], 'b')).toEqual(before[1]);
		});
	});
});

it('reports an unavailable owning host as machine-readable CLI error without local DB fallback', async () => {
	await server.close();
	server = undefined as unknown as RuntimeServer;
	expect(await cli('list', '--json')).toMatchObject({
		code: 1,
		value: { details: { code: 'runtime-unavailable' } },
	});
});

describe('canonical roles and human approval through real CLI', () => {
	let saved: Board;
	let common: string[];
	beforeEach(async () => {
		saved = result<Board>(
			await send(capture(card({ role: { namespace: namespaces[0], profileId: 'role' } })))
		);
		common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
	});
	it('updates the original canonical role namespace without legacy aliases', async () => {
		const foreign = facade.read(roots[1], 'b');
		expect(
			(await cli('update-card', 'c', '--profile-namespace', namespaces[0], ...common)).code
		).toBe(0);
		expect(facade.read(roots[0], 'b').cards[0].role).toEqual(saved.cards[0].role);
		expect(facade.read(roots[1], 'b')).toEqual(foreign);
	});
	it('refuses the original manual review transition without writes', async () => {
		const before = roots.map((root) => facade.read(root, 'b'));
		expect((await cli('set-status', 'c', 'review', ...common)).code).toBe(1);
		expect(roots.map((root) => facade.read(root, 'b'))).toEqual(before);
	});
	describe('with the original trusted review fixture', () => {
		beforeEach(() => {
			// Trusted legacy/runtime fixture, outside caller authority.
			db.prepare(
				"UPDATE cards SET payload_json=json_set(payload_json, '$.status', 'review') WHERE id='c'"
			).run();
		});
		it.each(['done', 'todo', 'blocked', 'done'] as const)(
			'refuses original CLI human-review status %s without writes (case %#)',
			async (status) => {
				const before = roots.map((root) => facade.read(root, 'b'));
				expect((await cli('set-status', 'c', status, ...common)).value.details.code).toBe(
					'protected-field'
				);
				expect(facade.read(roots[0], 'b').cards[0].status).toBe('review');
				expect(roots.map((root) => facade.read(root, 'b'))).toEqual(before);
			}
		);
		it('refuses the original host capture bypass of human review without writes', async () => {
			const before = roots.map((root) => facade.read(root, 'b'));
			const reviewing = before[0].cards[0];
			expect(await send(capture({ ...reviewing, status: 'done' }))).toMatchObject({
				ok: false,
				error: { code: 'protected-field' },
			});
			expect(roots.map((root) => facade.read(root, 'b'))).toEqual(before);
		});
	});
});

function installBoardOwner(direct = true, captureProjectCard = true) {
	if (captureProjectCard) {
		const request = capture(card({ startModeOverride: direct ? 'direct' : 'approval' }));
		if (request.action !== 'capture') throw new Error('capture required');
		facade.capture(request.capture, true);
	}
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
		finish: (exitCode = 0) =>
			settle({
				output: exitCode === 0 ? '<!-- maestro:card-complete -->' : 'failed',
				exitCode,
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
	it('prepares only runnable cards in a tick with many finished and waiting cards', async () => {
		const fixture = installBoardOwner();
		const key = target().collectionKey;
		const original = db
			.prepare('SELECT payload_json FROM cards WHERE collection_key=? AND id=?')
			.get(key, 'c') as { payload_json: string };
		const payload = JSON.parse(original.payload_json);
		const insert = db.prepare(
			'INSERT INTO cards (collection_key, id, payload_json, revision) VALUES (?, ?, ?, 0)'
		);
		for (let i = 0; i < 40; i++) {
			const id = `waiting-${i}`;
			insert.run(key, id, JSON.stringify({ ...payload, id, status: i % 2 ? 'blocked' : 'done' }));
		}
		insert.run(
			key,
			'missing-scope',
			JSON.stringify({ ...payload, id: 'missing-scope', status: 'done', executionScope: undefined })
		);
		const prepared: string[] = [];
		const controlOnly: string[] = [];
		configureBoardRuntimeHost((cardKey, prepare = true) => {
			(prepare ? prepared : controlOnly).push(cardKey.cardId);
			return fixture.owner;
		});
		const response = await send(tick('many-waiting'));
		const rows = result<{ cardId: string; ok: boolean; reason?: string }[]>(response);
		expect(prepared).toEqual(['c']);
		expect(controlOnly).toHaveLength(41);
		expect(rows.find((row) => row.cardId === 'c')?.ok).toBe(true);
		expect(rows.find((row) => row.cardId === 'missing-scope')?.reason).toBe('missing-scope');
		expect(fixture.service.spawn).toHaveBeenCalledTimes(1);
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
		const next = result<{ cardId: string; reason?: string }[]>(await send(tick('waiting-again')));
		expect(next.find((row) => row.cardId === 'waiting-0')?.reason).toBe('card-not-ready');
		expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0);
	});
	it('retries evidence-incomplete work through real CLI and host revision checks without rewriting history or granting completion', async () => {
		// Provider execution is injected; Commander, authenticated bridge, host and SQLite are real.
		const fixture = installBoardOwner();
		const started = result<{ runToken: BoardRuntimeToken }[]>(await send(tick()))[0].runToken;
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
		const work = facade.read(roots[0], 'b').cards[0];
		expect(work).toMatchObject({
			status: 'blocked',
			workflow: { evidenceIncomplete: { runId: started.runId, missing: ['summary', 'artifact'] } },
		});
		const history = db.prepare('SELECT * FROM runs').all();
		const common = ['--project-root', roots[0], '--source', target().sourceKey, '--json'];
		const shown = await cli('show-card', 'c', ...common);
		expect(shown.code).toBe(0);
		expect(JSON.stringify(shown.value)).toContain('review-artifact-unresolved');
		const before = db.prepare('SELECT * FROM cards').all();
		expect((await cli('set-status', 'c', 'done', ...common)).code).toBe(1);
		expect(
			await raw({
				...control('resume', { ...started, generation: started.generation + 1 }),
				human: true,
			})
		).toMatchObject({ ok: false });
		expect(
			await send({
				action: 'status',
				target: { ...target(), expectedRevision: target().expectedRevision - 1 },
				cardId: 'c',
				cardRevision: work.storageRevision!,
				status: 'todo',
			})
		).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(db.prepare('SELECT * FROM cards').all()).toEqual(before);
		expect((await cli('set-status', 'c', 'todo', ...common)).code).toBe(0);
		const retried = facade.read(roots[0], 'b').cards[0];
		expect(retried.status).toBe('todo');
		expect(retried.runs).toEqual(work.runs);
		expect(retried.capturePolicy).toEqual(work.capturePolicy);
		expect(db.prepare('SELECT * FROM runs').all()).toEqual(history);
		const retryTick = await cli('tick', '--source', target().sourceKey, '--json');
		expect(retryTick).toMatchObject({
			code: 0,
			value: { boards: [{ results: [{ cardId: 'c', ok: true }] }] },
		});
		expect(fixture.service.spawn).toHaveBeenCalledTimes(2);
		expect(db.prepare('SELECT attempt FROM runs ORDER BY attempt').all()).toEqual([
			{ attempt: 1 },
			{ attempt: 2 },
		]);
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
	});
	it('races native IPC and real CLI against a globally captured card without an agent project', async () => {
		const fixture = installBoardOwner(true, false);
		const global = result<Board>(await send({ action: 'initialize' }));
		const identity = global.storage!;
		const projectRoot = BOARD_SOURCE_PROJECT_PREFIX + identity.sourceKey;
		let saved = facade.capture(
			{
				projectRoot,
				boardId: global.id,
				expectedRevision: identity.expectedRevision!,
				card: card({
					id: 'global-run',
					startModeOverride: 'direct',
					workingDirectory: undefined,
				}),
			},
			true
		);
		const missingCwd = await cli('tick', '--json');
		expect(missingCwd.code).toBe(0);
		expect(
			missingCwd.value.boards.find((entry: { boardId: string }) => entry.boardId === global.id)
				.results
		).toMatchObject([{ cardId: 'global-run', ok: false, reason: 'repository-unresolved' }]);
		expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(0);
		saved = facade.capture(
			{
				projectRoot,
				boardId: global.id,
				expectedRevision: saved.storage!.expectedRevision!,
				card: {
					...saved.cards[0],
					workingDirectory: roots[0],
					executionScope: { kind: 'group', groupId: 'other' },
					assigneeAgentId: undefined,
				},
			},
			true
		);
		const noWorker = result<{ collections: { readiness: Record<string, string[]> }[] }>(
			await send({ action: 'query', query: { sourceKey: identity.sourceKey } })
		);
		expect(noWorker.collections[0].readiness['global-run']).toContain('emptyEligibleWorkers');
		const wrongGroup = await cli('tick', '--source', identity.sourceKey, '--json');
		expect(wrongGroup.value.boards[0].results).toMatchObject([
			{ cardId: 'global-run', ok: false, reason: 'worker-outside-scope' },
		]);
		expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(0);
		saved = facade.capture(
			{
				projectRoot,
				boardId: global.id,
				expectedRevision: saved.storage!.expectedRevision!,
				card: {
					...saved.cards[0],
					executionScope: { kind: 'group', groupId: 'g' },
					assigneeAgentId: 'a',
				},
			},
			true
		);
		const target = {
			projectRoot,
			sourceKey: saved.storage!.sourceKey,
			collectionKey: saved.storage!.collectionKey,
			expectedRevision: saved.storage!.expectedRevision!,
		};
		const contents = { mainFrame: {} };
		registerBoardHandlers({
			getCueEngine: () => null,
			getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }) as never,
		});
		const [desktop, command] = await Promise.all([
			ipcHandlers.get('board:runtimeCommand')!(
				{ sender: contents, senderFrame: contents.mainFrame },
				{ action: 'tick', target, operationId: 'global-ipc' }
			),
			cli('tick', '--source', target.sourceKey, '--collection', target.collectionKey, '--json'),
		]);
		expect(desktop.ok || command.code === 0).toBe(true);
		expect(fixture.service.spawn).toHaveBeenCalledTimes(1);
		expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(1);
		const rows = db.prepare('SELECT specification_json FROM runs').all() as {
			specification_json: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].specification_json)).toMatchObject({
			key: {
				sourceKey: target.sourceKey,
				collectionKey: target.collectionKey,
				cardId: 'global-run',
			},
			workerAgentId: 'a',
			repository: { id: 'repo0', workingDirectory: roots[0] },
		});
		fixture.finish();
		await vi.waitFor(() => expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0));
	});
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
		const selected = target();
		const observed = facade.read(roots[0], 'b').cards[0];
		const read = {
			sourceKey: selected.sourceKey,
			collectionKey: selected.collectionKey,
			revision: selected.expectedRevision,
			cardRevision: observed.storageRevision!,
		};
		await expect(
			cancelBoardRuntimeCard(roots[0], 'b', 'c', 'hold', { ...read, revision: read.revision + 1 })
		).rejects.toThrow(/changed since read/);
		await expect(
			cancelBoardRuntimeCard(roots[0], 'b', 'c', 'hold', {
				...read,
				cardRevision: read.cardRevision + 1,
			})
		).rejects.toThrow(/changed since read/);
		expect(fixture.service.stop).not.toHaveBeenCalled();
		const stopped = await cancelBoardRuntimeCard(roots[0], 'b', 'c', 'hold', read);
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
	it.each([0, 1])(
		'holds and resumes after a finished attempt with exit code %i',
		async (exitCode) => {
			const fixture = installBoardOwner();
			await send(tick());
			fixture.finish(exitCode);
			await vi.waitFor(() =>
				expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0)
			);
			expect(db.prepare('SELECT outcome_json FROM runs').get()).toMatchObject({
				outcome_json: expect.any(String),
			});
			const held = await cancelBoardRuntimeCard(roots[0], 'b', 'c', 'hold');
			expect(held.cards[0].heldByUser).toBe(true);
			const resumed = await cancelBoardRuntimeCard(roots[0], 'b', 'c', 'resume');
			expect(resumed.cards[0].heldByUser).not.toBe(true);
			expect(facade.workspace.readCollection(target())!.cards[0].payload.heldByUser).toBe(false);
			expect(fixture.service.stop).not.toHaveBeenCalled();
		}
	);
	it.each([
		['hold', 'collection'],
		['hold', 'card'],
		['resume', 'collection'],
		['resume', 'card'],
	] as const)(
		'rejects %s when another SQLite connection changes the %s revision after host preparation',
		async (operation, changed) => {
			const fixture = installBoardOwner();
			const token = result<{ runToken: BoardRuntimeToken }[]>(await send(tick()))[0].runToken;
			if (operation === 'resume') {
				expect(await send(control('hold', token))).toMatchObject({ ok: true });
				fixture.finish();
				await vi.waitFor(() =>
					expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0)
				);
			}
			const request = control(operation, token);
			const beforeCard = facade.read(roots[0], 'b').cards[0];
			const beforeRuns = db.prepare('SELECT * FROM runs').all();
			const beforeReservations = db.prepare('SELECT * FROM reservations').all();
			const stopCount = vi.mocked(fixture.service.stop).mock.calls.length;
			const original = fixture.owner[operation].bind(fixture.owner);
			const other = openBoardDb(databasePath);
			const spy = vi
				.spyOn(fixture.owner, operation)
				.mockImplementationOnce((runToken, expected) => {
					if (changed === 'collection')
						other
							.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?')
							.run(request.target.collectionKey);
					else
						other
							.prepare('UPDATE cards SET revision=revision+1 WHERE collection_key=? AND id=?')
							.run(request.target.collectionKey, request.cardId);
					return original(runToken, expected);
				});
			try {
				expect(await send(request)).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
				expect(facade.read(roots[0], 'b').cards[0].heldByUser).toBe(beforeCard.heldByUser);
				expect(db.prepare('SELECT * FROM runs').all()).toEqual(beforeRuns);
				expect(db.prepare('SELECT * FROM reservations').all()).toEqual(beforeReservations);
				expect(fixture.service.stop).toHaveBeenCalledTimes(stopCount);
				expect(await send(control(operation, token))).toMatchObject({ ok: true });
				if (operation === 'hold') {
					fixture.finish();
					await vi.waitFor(() =>
						expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0)
					);
				}
			} finally {
				spy.mockRestore();
				other.close();
			}
		}
	);
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
		'%s list/get and subsequent CLI mutations keep the same source',
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
			const sessionsFile = path.join(requireBoardIsolation().sync, 'maestro-sessions.json');
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
		},
		30000
	);
	it.each(['canonical', 'trailingSlash', 'symlink', 'relative'])(
		'%s runtime control and tick keep the same source',
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
			result<Board>(await send(capture(card({ id: 'alias-work' }))));
			const id = 'alias-work';
			// Install the existing real owner without changing this captured card.
			const fixture = installBoardOwner(false);
			expect((await cli('hold', id, ...common)).code).toBe(0);
			expect((await cli('resume', id, ...common)).code).toBe(0);
			const sessionsFile = path.join(requireBoardIsolation().sync, 'maestro-sessions.json');
			const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
			sessions.sessions[0].projectRoot = root;
			sessions.sessions[0].cwd = root;
			fs.writeFileSync(sessionsFile, JSON.stringify(sessions));
			expect(await cli('tick', '--agent', 'creator', ...common.slice(2))).toMatchObject({
				code: 0,
			});
			expect(fixture.service.spawn).not.toHaveBeenCalled();
			expect(facade.read(roots[0], 'b').storage!.sourceKey).toBe(target().sourceKey);
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
		const identity = facade.sourceIdentity(selected.sourceKey);
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
			// Discovery also calls realpath. Pause only after host preparation has
			// observed the selected alias and captured its source identity.
			if (first && args[0] === selected.projectRoot) {
				first = false;
				expect(resolved).toBe(roots[0]);
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
			expect(facade.sourceIdentity(selected.sourceKey)).toBe(identity);
			expect(target().expectedRevision).toBe(selected.expectedRevision);
			if (change === 'alias') {
				fs.unlinkSync(link);
				fs.symlinkSync(roots[1], link, 'junction');
				expect(await realpath(selected.projectRoot)).toBe(roots[1]);
			} else if (change === 'source') {
				expect(
					db
						.prepare('UPDATE board_source_locations SET payload_json=? WHERE source_key=?')
						.run(
							JSON.stringify({ location: { kind: 'local' }, path: roots[1] }),
							selected.sourceKey
						).changes
				).toBe(1);
				expect(facade.sourceIdentity(selected.sourceKey)).not.toBe(identity);
			} else if (change === 'collection') {
				facade.save(roots[0], [{ ...saved, name: 'Concurrent writer' }]);
			} else {
				const concurrent = capture({ ...saved.cards[0], body: 'Concurrent writer' });
				if (concurrent.action !== 'capture') throw new Error('capture fixture');
				facade.capture(concurrent.capture);
			}
			if (change === 'collection' || change === 'card')
				expect(target().expectedRevision).toBeGreaterThan(selected.expectedRevision);
			const before = facade.read(roots[0], 'b');
			const changedIdentity = facade.sourceIdentity(selected.sourceKey);
			resume();
			expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
			expect(facade.sourceIdentity(selected.sourceKey)).toBe(changedIdentity);
			expect(facade.read(roots[0], 'b')).toEqual(before);
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
		const identity = facade.sourceIdentity(request.target.sourceKey);
		const pending = executeBoardCommand(request);
		await started;
		if (change === 'alias') {
			fs.unlinkSync(link);
			fs.symlinkSync(roots[1], link, 'junction');
		} else {
			expect(
				db
					.prepare('UPDATE board_source_locations SET payload_json=? WHERE source_key=?')
					.run(
						JSON.stringify({ location: { kind: 'local' }, path: roots[1] }),
						request.target.sourceKey
					).changes
			).toBe(1);
			expect(facade.sourceIdentity(request.target.sourceKey)).not.toBe(identity);
		}
		resume();
		expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(facade.read(roots[0], 'b').cards[0].heldByUser).not.toBe(true);
		expect(facade.read(roots[1], 'b')).toEqual(foreign);
		expect(fixture.service.spawn).not.toHaveBeenCalled();
		expect(fixture.service.stop).not.toHaveBeenCalled();
	}
);

it('requires the native main-frame operator for retained-result recovery and preserves all evidence', async () => {
	const fixture = installBoardOwner();
	const response = await send(tick('recovery-fixture'));
	const token = result<{ runToken: BoardRuntimeToken }[]>(response)[0].runToken!;
	setBoardWorkerAccess(db, 'a', [], []);
	fixture.finish();
	await vi.waitFor(() => expect(fixture.owner.read(token)!.life.pendingResult).toBeDefined());
	expect(await send(control('hold', token))).toMatchObject({ ok: true });
	const recovery = { ...control('resume', token), operation: 'recover' as const };
	const before = roots.map((root) => facade.read(root, 'b'));
	expect(await send(recovery)).toMatchObject({ ok: false, error: { code: 'protected-field' } });
	expect(roots.map((root) => facade.read(root, 'b'))).toEqual(before);
	const contents = { mainFrame: {} };
	registerBoardHandlers({
		getCueEngine: () => null,
		getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }) as never,
	});
	const handle = ipcHandlers.get('board:runtimeCommand')!;
	expect(await handle({ sender: {}, senderFrame: {} }, recovery)).toMatchObject({
		ok: false,
		error: { code: 'protected-field' },
	});
	expect(
		await handle(
			{ sender: contents, senderFrame: contents.mainFrame },
			{ ...recovery, human: true }
		)
	).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
	expect(roots.map((root) => facade.read(root, 'b'))).toEqual(before);
	// The UI need not possess the owner epoch: the host resolves the exact current attempt.
	const native = { ...recovery, runToken: undefined };
	delete native.runToken;
	expect(await handle({ sender: contents, senderFrame: contents.mainFrame }, native)).toMatchObject(
		{ ok: true }
	);
	expect(facade.read(roots[0], 'b').cards[0]).toMatchObject({ status: 'todo', heldByUser: true });
	expect(facade.read(roots[0], 'b').cards[0].workflow?.workRunId).toBeUndefined();
	expect(facade.read(roots[1], 'b')).toEqual(before[1]);
	expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
	expect(fixture.owner.read(token)!.outcome).toMatchObject({
		result: { output: '<!-- maestro:card-complete -->' },
		operatorRecovery: { principal: 'native-desktop-main-frame' },
	});
});

it('decouples an exact target mutation from unrelated pending real source discovery', async () => {
	expect(await send(capture())).toMatchObject({ ok: true });
	const created = facade.read(roots[0], 'b');
	await promisify(execFile)('git', ['init', '--quiet', roots[1]]);
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const gitEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const realpath = fs.promises.realpath.bind(fs.promises);
	const physical = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
		const result = await realpath(...args);
		if (args[0] === roots[1]) {
			entered();
			await barrier;
		}
		return result;
	});
	let discoveryDone = false;
	const discovery = refreshBoardSources().finally(() => {
		discoveryDone = true;
	});
	await gitEntered;
	let settled = false;
	const reply = send({
		action: 'delete-cards',
		target: target(),
		cards: [{ cardId: 'c', cardRevision: created.cards[0].storageRevision! }],
	}).then((r) => {
		settled = true;
		return r;
	});
	try {
		await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
		expect(discoveryDone).toBe(false);
		expect((await reply).ok).toBe(true);
		expect(physical).toHaveBeenCalledWith(roots[1]);
	} finally {
		release();
		await discovery;
		await reply;
		physical.mockRestore();
	}
});

it.each(['moved', 'alias'] as const)(
	'exact target admission refuses a %s physical root without writes',
	async (mode) => {
		expect(await send(capture())).toMatchObject({ ok: true });
		const board = facade.read(roots[0], 'b');
		const selected = target();
		const before = db.serialize();
		const moved = roots[0] + '.moved';
		fs.renameSync(roots[0], moved);
		if (mode === 'alias')
			fs.symlinkSync(roots[1], roots[0], process.platform === 'win32' ? 'junction' : 'dir');
		try {
			const command: BoardCommand = {
				action: 'delete-cards',
				target: selected,
				cards: [{ cardId: 'c', cardRevision: board.cards[0].storageRevision! }],
			};
			if (mode === 'alias')
				await expect(executeBoardCommand(command)).rejects.toThrow(/symlink|alias|identity/i);
			else
				expect(await executeBoardCommand(command)).toMatchObject({
					ok: false,
					error: { code: 'legacy-mapping-missing' },
				});
			expect(db.serialize()).toEqual(before);
		} finally {
			if (mode === 'alias') fs.unlinkSync(roots[0]);
			fs.renameSync(moved, roots[0]);
		}
	}
);
it.each(['unknown-source', 'wrong-collection', 'stale-revision'] as const)(
	'exact target admission refuses %s without writes',
	async (mode) => {
		expect(await send(capture())).toMatchObject({ ok: true });
		const board = facade.read(roots[0], 'b');
		const selected = target();
		if (mode === 'unknown-source') {
			selected.sourceKey = 'f'.repeat(64);
			selected.projectRoot = BOARD_SOURCE_PROJECT_PREFIX + selected.sourceKey;
		}
		if (mode === 'wrong-collection') selected.collectionKey = target(1).collectionKey;
		if (mode === 'stale-revision') selected.expectedRevision--;
		const before = db.serialize();
		const reply = await send({
			action: 'delete-cards',
			target: selected,
			cards: [{ cardId: 'c', cardRevision: board.cards[0].storageRevision! }],
		});
		expect(reply).toMatchObject({
			ok: false,
			error: {
				code:
					mode === 'stale-revision'
						? 'stale-revision'
						: mode === 'unknown-source'
							? 'legacy-mapping-missing'
							: 'not-found',
			},
		});
		expect(db.serialize()).toEqual(before);
	}
);
it.each(['source-row', 'revision', 'physical-root'] as const)(
	'exact target admission rechecks %s after the canonical writequeue',
	async (mode) => {
		expect(await send(capture())).toMatchObject({ ok: true });
		const board = facade.read(roots[0], 'b');
		const selected = target();
		let release!: () => void;
		const barrier = new Promise<void>((r) => {
			release = r;
		});
		let entered!: () => void;
		const blocked = new Promise<void>((r) => {
			entered = r;
		});
		const original = boardStorage.enqueueBoardWrite;
		const held = original(roots[0], async () => {
			entered();
			await barrier;
		});
		await blocked;
		let queued!: () => void;
		const enqueued = new Promise<void>((r) => {
			queued = r;
		});
		const spy = vi.spyOn(boardStorage, 'enqueueBoardWrite').mockImplementation((...args) => {
			const result = original(...args);
			queued();
			return result;
		});
		const reply = send({
			action: 'delete-cards',
			target: selected,
			cards: [{ cardId: 'c', cardRevision: board.cards[0].storageRevision! }],
		});
		try {
			await enqueued;
			if (mode === 'source-row')
				db.prepare(
					"UPDATE board_source_locations SET payload_json=payload_json || ' ' WHERE source_key=?"
				).run(selected.sourceKey);
			if (mode === 'revision')
				db.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?').run(
					selected.collectionKey
				);
			if (mode === 'physical-root') {
				fs.renameSync(roots[0], roots[0] + '.queued');
				fs.mkdirSync(roots[0]);
			}
			const before = db.serialize();
			release();
			await held;
			expect(await reply).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
			expect(db.serialize()).toEqual(before);
		} finally {
			release();
			await held;
			await reply;
			spy.mockRestore();
			if (mode === 'physical-root') {
				fs.rmdirSync(roots[0]);
				fs.renameSync(roots[0] + '.queued', roots[0]);
			}
		}
	}
);
it.each([
	{ board: false, maestroCue: false },
	{ board: false, maestroCue: true },
	{ board: true, maestroCue: false },
])('exact target admission stays inert with gates %j', async (flags) => {
	const selected = target();
	const before = db.serialize();
	configureBoardFeatures({ get: () => flags });
	try {
		await expect(
			executeBoardCommand({
				action: 'delete-cards',
				target: selected,
				cards: [{ cardId: 'c', cardRevision: 0 }],
			})
		).rejects.toThrow(flags.board ? 'CueDisabled' : 'BoardDisabled');
		expect(db.serialize()).toEqual(before);
	} finally {
		configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
	}
});

it('exact target admission refuses removed source registration without writes', async () => {
	expect(await send(capture())).toMatchObject({ ok: true });
	const board = facade.read(roots[0], 'b');
	const selected = target();
	const before = db.serialize();
	const file = isolationFixture.contract.sourceRegistry;
	const bytes = fs.readFileSync(file);
	const registry = JSON.parse(bytes.toString());
	registry.sources = registry.sources.filter((s: { root: string }) => s.root !== roots[0]);
	fs.writeFileSync(file, JSON.stringify(registry));
	try {
		await expect(
			executeBoardCommand({
				action: 'delete-cards',
				target: selected,
				cards: [{ cardId: 'c', cardRevision: board.cards[0].storageRevision! }],
			})
		).rejects.toThrow(/isolation.*(source|registr)/i);
		expect(db.serialize()).toEqual(before);
	} finally {
		fs.writeFileSync(file, bytes);
	}
});
