import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BoardRegistryRevision } from '../../../main/board/board-registry-revision';
import {
	readBoardRunArtifact,
	captureBoardCardFromHost,
	prepareBoardReviewHandoff,
	approveBoardWork,
	queueBoardReviews,
} from '../../../main/board/board-review';
import { configureBoardStorage, updateCardStatus } from '../../../main/board/board-storage';
import * as path from 'node:path';
import { openBoardDb } from '../../../main/board/board-db';
import {
	readBoardIsolationRegistries,
	requireBoardIsolation,
} from '../../../main/board/board-isolation';
import { BoardStorageFacade, configureBoardCaptureHost } from '../../../main/board/board-storage';
import {
	listBoardWorkers,
	setBoardWorkerOptions,
	registerBoardWorker,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';
import {
	BoardRuntime,
	type BoardRunHooks,
	type BoardRunService,
} from '../../../main/board/board-runtime';
import { boardWorkerCanStart } from '../../../main/board/board-claims';
import {
	configureAgentAdmission,
	issueAgentTurnAdmission,
	revokeAgentTurnAdmission,
	startAdmittedAgentTurn,
	getHeadlessAgentActivity,
	hasHeadlessAgentActivity,
} from '../../../main/utils/headless-agent-activity';
import * as binaryProber from '../../../shared/maestro-lib/launch/path-prober';
import * as agentDefinitions from '../../../shared/maestro-lib/providers/definitions';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { createPluginHeadlessAgentRunner } from '../../../main/plugins/plugin-headless-agent-runner';
import type { SessionInfo } from '../../../shared/types';
import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { pathToFileURL } from 'node:url';
import { FAKE_AGENT_PATH, fakeAgentSpec } from '../../shared/maestro-lib/run/fakeAgent';
import { isAgentBusy } from '../../../main/utils/agent-busy';
import { ProcessManager } from '../../../main/process-manager';
import type {
	BoardClaimHostContext,
	BoardRunSpecification,
} from '../../../main/board/board-claims';
import type { BoardCard } from '../../../shared/board/types';
import type { CardSpawnResult } from '../../../main/board/board-dispatcher';
import { canonicalJson } from '../../../shared/canonicalJson';
import { generateUUID } from '../../../shared/uuid';
import { runProcess, stopProcess } from '../../../main/cue/cue-process-lifecycle';
import type { BoardTransitionReceipt } from '../../../main/board/board-transitions';
import { createBoardNotificationHandlers } from '../../../main/board/board-notifications';
import type { PluginEvent } from '../../../shared/plugins/events';
import type { BoardCardToastPayload } from '../../../main/board/board-toast';

vi.mock('../../../cli/services/storage', () => ({
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSshRemotes: () => [],
	readSettings: () => ({}),
}));
vi.mock('../../../cli/services/wakatime', () => ({ buildCliWakaTimeHeartbeat: () => undefined }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const fixtureIsolation = createBoardIsolationFixture();
beforeAll(() => fixtureIsolation.install());
afterAll(async () => fixtureIsolation.cleanup());

let dir: string;
let providerScript: string;
let db: ReturnType<typeof openBoardDb>;
let storage: BoardStorageFacade;
let runtime: BoardRuntime;
let roots: string[];
let host: Omit<BoardClaimHostContext, 'owner' | 'agentStates'> & {
	agentStates: Record<string, BoardClaimHostContext['agentStates'][string]>;
};
let agents: { id: string; groupId: string }[];
let service: BoardRunService;
let hooks: BoardRunHooks;
let settle: (result: CardSpawnResult) => void;
let lockValid: boolean;
let databasePath: string;
let ownsDatabase = false;
let transitions: BoardTransitionReceipt[];
let events: PluginEvent[];
let toasts: BoardCardToastPayload[];
let notifications: ReturnType<typeof createBoardNotificationHandlers>;
let completed: ReturnType<typeof vi.fn<(spec: BoardRunSpecification) => void>>;
const good: CardSpawnResult = {
	// A trusted run-service fixture supplies complete host evidence. Real Git is
	// exercised by the workflow cases below, including deliberately missing evidence.
	output: '<!-- maestro:card-complete | Fixture checks passed -->',
	artifact: {
		worktreePath: path.resolve('isolated', 'host-artifact-fixture'),
		branch: 'fixture',
		commit: 'a'.repeat(40),
		diff: { baseCommit: 'b'.repeat(40), sha256: 'c'.repeat(64), stat: 'fixture' },
	},
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
		() => liveness,
		undefined,
		(spec) => completed(spec),
		(receipts) => {
			transitions.push(...receipts);
			notifications.onTransitions(receipts);
		}
	);
}
beforeEach(() => {
	transitions = [];
	events = [];
	toasts = [];
	notifications = createBoardNotificationHandlers(
		(event) => events.push(event),
		(toast) => toasts.push(toast)
	);
	completed = vi.fn();
	ownsDatabase = false;
	dir = '';
	// The fake agent consumes these inherited variables as file paths or a hold flag.
	// Never let an invoking shell redirect fixture output or mutate an unrelated file.
	for (const name of [
		'FAKE_AGENT_TICK_FILE',
		'FAKE_AGENT_ARGV_OUT',
		'FAKE_AGENT_STDIN_OUT',
		'FAKE_AGENT_ENV_OUT',
		'FAKE_AGENT_HOLD',
	])
		vi.stubEnv(name, '');
	const isolation = requireBoardIsolation();
	readBoardIsolationRegistries(isolation);
	databasePath = isolation.db;
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(databasePath + suffix)) throw new Error('Board test database must be fresh');
	}
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	dir = fs.mkdtempSync(path.join(isolation.root, 'board-lifecycle-'));
	providerScript = path.join(dir, 'provider fixture.mjs');
	fs.copyFileSync(FAKE_AGENT_PATH, providerScript);
	// A provider fixture is JavaScript input to Node, never an OS executable.
	fs.chmodSync(providerScript, 0o644);
	const getDefinition = agentDefinitions.getAgentDefinition;
	vi.spyOn(agentDefinitions, 'getAgentDefinition').mockImplementation((id) => {
		const definition = getDefinition(id);
		if (id !== 'codex' || !definition) return definition;
		return {
			...definition,
			// Put the script before Codex's real arguments so Node does not parse
			// provider flags. Admission, launch planning and the child remain real.
			workingDirArgs: (cwd: string) => [
				providerScript,
				...(definition.workingDirArgs?.(cwd) ?? []),
			],
		};
	});
	db = openBoardDb(databasePath);
	ownsDatabase = true;
	storage = new BoardStorageFacade(db, (root) => [root]);
	configureBoardStorage(storage);
	roots = [path.join(dir, 'a'), path.join(dir, 'b')];
	agents = [{ id: 'worker', groupId: 'group' }];
	configureBoardCaptureHost(() => ({ agents, groups: [{ id: 'group' }] }));
	for (let i = 0; i < roots.length; i++) {
		fs.mkdirSync(roots[i]);
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
});
afterEach(() => {
	try {
		configureAgentAdmission(() => true);
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
				try {
					if (dir) fs.rmSync(dir, { recursive: true, force: true });
				} finally {
					vi.unstubAllEnvs();
					vi.useRealTimers();
					vi.restoreAllMocks();
				}
			}
		}
	}
});
function command(index = 0) {
	const key = storage.workspace.listCollections(roots[index])[0];
	const collection = storage.workspace.readCollection(key)!;
	return {
		sourceKey: key.sourceKey,
		collectionKey: key.collectionKey,
		cardId: 'same',
		requestId: generateUUID(),
		workerAgentId: 'worker',
		readRevision: {
			workspace: storage.workspace.readWorkspace().revision,
			collection: collection.revision,
			card: collection.cards[0].revision,
			registry: host.registryRevision,
		},
	};
}
function claim() {
	const result = runtime.claim(command());
	if (!result.ok) throw new Error(result.reason);
	return result.runToken;
}
function card(index = 0) {
	return storage.workspace.readCollection(storage.workspace.listCollections(roots[index])[0])!
		.cards[0].payload as unknown as BoardCard;
}
function reservations() {
	return db.prepare('SELECT * FROM reservations').all();
}
function persisted() {
	return canonicalJson(
		['runtime_owner', 'runs', 'reservations', 'cards', 'collections', 'workspace'].map((table) =>
			db.prepare(`SELECT * FROM ${table}`).all()
		)
	);
}

describe('durable Board runtime over SQLite and the existing run-service seam', () => {
	it('publishes immutable attempt-bound receipts after commit and keeps invalidation/completion independent', async () => {
		const input = command();
		const first = runtime.claim(input);
		if (!first.ok) throw new Error(first.reason);
		expect(runtime.claim(input)).toEqual(first);
		await Promise.resolve();
		expect(transitions).toEqual([]); // A claim reserves capacity without changing public status.
		const pending = runtime.start(first.runToken);
		expect(transitions).toEqual([]);
		await Promise.resolve();
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			key: { sourceKey: input.sourceKey, collectionKey: 'collection0', cardId: 'same' },
			change: { fromStatus: 'todo', toStatus: 'running', attempt: 1, workerAgentId: 'worker' },
			runToken: first.runToken,
			cause: { runId: first.runToken.runId, phase: 'started' },
		});
		expect(Object.isFrozen(transitions[0])).toBe(true);
		expect(Object.isFrozen(transitions[0].change)).toBe(true);
		expect(Object.isFrozen(transitions[0].key)).toBe(true);
		const running = canonicalJson(transitions[0]);
		settle(good);
		await pending;
		await Promise.resolve();
		expect(transitions).toHaveLength(2);
		expect(transitions[1]).toMatchObject({
			change: { fromStatus: 'running', toStatus: 'review' },
			notification: { kind: 'review', detail: 'Fixture checks passed', workerAgentId: 'worker' },
		});
		expect(canonicalJson(transitions[0])).toBe(running);
		expect(completed).toHaveBeenCalledTimes(1);
		expect(events.map((event) => event.topic)).toEqual([
			'board.cardStatusChanged',
			'board.cardStatusChanged',
		]);
		expect(JSON.stringify(events)).not.toContain('Fixture checks passed');
		expect(toasts).toMatchObject([
			{
				message: 'Fixture checks passed',
				sessionId: 'worker',
				clickAction: { kind: 'jump-session', sessionId: 'worker' },
			},
		]);
		expect(runtime.complete(first.runToken, good)).toMatchObject({ ok: false });
		expect(runtime.complete({ ...first.runToken, generation: 99 }, good)).toMatchObject({
			ok: false,
		});
		await Promise.resolve();
		expect(transitions).toHaveLength(2);
		expect(events).toHaveLength(2);
		expect(toasts).toHaveLength(1);
		expect(completed).toHaveBeenCalledTimes(1);
	});
	it('suppresses nested rollback receipts and accepts a committed retry despite unrelated later writes', async () => {
		const token = claim();
		const pending = runtime.start(token);
		await Promise.resolve();
		transitions = [];
		events = [];
		toasts = [];
		expect(() =>
			db
				.transaction(() => {
					expect(runtime.complete(token, good)).toEqual({ ok: true });
					expect(transitions).toEqual([]);
					throw new Error('outer rollback');
				})
				.immediate()
		).toThrow('outer rollback');
		await Promise.resolve();
		expect(transitions).toEqual([]);
		expect(events).toEqual([]);
		expect(toasts).toEqual([]);
		expect(completed).not.toHaveBeenCalled();
		expect(card().status).toBe('running');
		db.transaction(() => {
			expect(runtime.complete(token, good)).toEqual({ ok: true });
			expect(transitions).toEqual([]);
		}).immediate();
		// Same collection and workspace revisions change, but this receipt's run/card still committed.
		db.prepare(
			"UPDATE collections SET revision=revision+1 WHERE collection_key='collection0'"
		).run();
		db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
		await Promise.resolve();
		expect(transitions).toHaveLength(1);
		expect(transitions[0].change.toStatus).toBe('review');
		expect(completed).toHaveBeenCalledTimes(1);
		settle(good);
		await pending;
	});
	it('distinguishes an identical rollback/retry before microtasks by its durable commit marker', async () => {
		const token = claim();
		const pending = runtime.start(token);
		await Promise.resolve();
		transitions = [];
		vi.useFakeTimers({ toFake: ['Date'] });
		expect(() =>
			db
				.transaction(() => {
					runtime.complete(token, good);
					throw new Error('rollback');
				})
				.immediate()
		).toThrow('rollback');
		db.transaction(() => runtime.complete(token, good)).immediate();
		await Promise.resolve();
		expect(transitions).toHaveLength(1);
		expect(completed).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
		settle(good);
		await pending;
	});
	it('binds a separate review to a real clean source commit and refuses dirty or forged handoffs', async () => {
		const git = (...args: string[]) =>
			execFileSync('git', args, { cwd: roots[0], encoding: 'utf8' });
		git('init', '--quiet');
		fs.writeFileSync(path.join(roots[0], 'work.txt'), 'source work');
		git('add', 'work.txt');
		git(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.test',
			'commit',
			'--quiet',
			'-m',
			'fixture'
		);
		const base = await readBoardRunArtifact(roots[0]);
		const artifact = await readBoardRunArtifact(roots[0], base!.commit);
		expect(artifact?.commit).toMatch(/^[a-f0-9]{40}$/);
		const token = claim();
		const pending = runtime.start(token);
		settle({
			...good,
			output: '<!-- maestro:card-complete | scoped checks passed -->',
			artifact: artifact!,
		});
		await pending;
		configureBoardStorage(storage);
		const board = storage.read(roots[0], 'board');
		const command = {
			projectRoot: roots[0],
			boardId: board.id,
			expectedRevision: board.storage!.expectedRevision!,
			reviewSource: { cardId: 'same', attempt: 1 },
			card: {
				id: 'review',
				assigneeAgentId: 'worker',
				title: 'Review work',
				body: '',
				kind: 'review' as const,
				parents: ['same'],
				status: 'todo' as const,
				createdAt: 'now',
				updatedAt: 'now',
				repositoryId: 'repo0',
				workingDirectory: roots[0],
				executionScope: { kind: 'group' as const, groupId: 'group' },
			},
		};
		fs.writeFileSync(path.join(roots[0], 'work.txt'), 'dirty source');
		await expect(captureBoardCardFromHost(command)).rejects.toThrow('changed');
		expect(storage.read(roots[0], 'board').cards).toHaveLength(1);
		git('checkout', '--', 'work.txt');
		const response = await captureBoardCardFromHost(command);
		const review = response.value.cards.find((card) => card.id === 'review')!;
		expect(review.reviewHandoff).toMatchObject({
			runId: token.runId,
			attempt: 1,
			artifact,
			checks: 'scoped checks passed',
		});
		expect(await prepareBoardReviewHandoff(storage, review.reviewHandoff!)).toBe(
			canonicalJson(review.reviewHandoff)
		);
		const changed = {
			...review,
			reviewHandoff: {
				...review.reviewHandoff!,
				artifact: { ...artifact!, commit: 'a'.repeat(40) },
			},
		};
		expect(() =>
			storage.capture({
				...command,
				reviewSource: undefined,
				expectedRevision: response.value.storage!.expectedRevision!,
				card: changed,
			})
		).toThrow(expect.objectContaining({ code: 'protected-field' }));
		fs.writeFileSync(path.join(roots[0], 'work.txt'), 'later dirt');
		expect(await prepareBoardReviewHandoff(storage, review.reviewHandoff!)).toBeNull();
	});
	it('will not dispatch an unbound review even with otherwise valid scope and direct policy', () => {
		const row = storage.workspace.readCollection(storage.workspace.listCollections(roots[0])[0])!
			.cards[0];
		db.prepare('UPDATE cards SET payload_json=? WHERE collection_key=? AND id=?').run(
			canonicalJson({ ...row.payload, kind: 'review' }),
			'collection0',
			'same'
		);
		expect(runtime.claim(command())).toMatchObject({
			ok: false,
			reason: 'review-artifact-unresolved',
		});
	});
	it.each(['codex', 'claude-code'] as const)(
		'fences the final real %s plugin/Relay start after async planning',
		async (toolType) => {
			configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
			const fake = fakeAgentSpec(dir, { chunks: [], close: { code: 0, signal: null } });
			const marker = path.join(dir, 'spawned.json');
			let prepared!: () => void;
			let continuePlanning!: () => void;
			const ready = new Promise<void>((resolve) => {
				prepared = resolve;
			});
			const planning = new Promise<void>((resolve) => {
				continuePlanning = resolve;
			});
			const run = createPluginHeadlessAgentRunner({
				getAgent: () =>
					({
						id: 'worker',
						name: 'Worker',
						projectRoot: dir,
						toolType,
						cwd: dir,
						customEnvVars: { ...fake.env, FAKE_AGENT_ARGV_OUT: marker },
					}) as SessionInfo,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => false,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: vi.fn(),
				revokeRunToken: vi.fn(),
				audit: vi.fn(),
				cliScriptPath: () => '/unused',
				spawn: spawnAgent,
			});
			vi.spyOn(binaryProber, 'checkBinaryExists').mockImplementationOnce(async () => {
				prepared();
				await planning;
				return { exists: true, path: fake.command };
			});
			const pending = run('worker', 'fixture', undefined, undefined, 'relay');
			await ready;
			const token = claim(); // proof issued BEFORE the durable Board reservation
			const denied = expect(pending).rejects.toThrow('reserved');
			continuePlanning();
			await denied;
			expect(fs.existsSync(marker)).toBe(false);
			expect(hasHeadlessAgentActivity('worker')).toBe(false);
			expect(reservations()).toHaveLength(1);
			expect(boardWorkerCanStart(db, 'worker', token.runId)).toBe(true);
		}
	);

	it.each(['auto', 'relay'] as const)(
		'keeps a real %s headless child exclusive before tab persistence and through abort',
		async (origin) => {
			configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
			const argvOut = path.join(dir, 'provider-argv.json');
			const fake = fakeAgentSpec(
				dir,
				{ chunks: [], close: { code: 0, signal: null } },
				{ hold: true, argvOut }
			);
			const controller = new AbortController();
			let pid: number | undefined;
			const run = createPluginHeadlessAgentRunner({
				getAgent: () =>
					({
						id: 'worker',
						toolType: 'codex',
						cwd: dir,
						customEnvVars: fake.env,
						customArgs: '--fixture-label "spaces and $literal"',
					}) as SessionInfo,
				detectAgent: async () => ({ available: true, path: fake.command }),
				hasPluginTools: () => false,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: vi.fn(),
				revokeRunToken: vi.fn(),
				audit: vi.fn(),
				cliScriptPath: () => '/unused',
				spawn: (...args) =>
					spawnAgent(
						...(args.slice(0, 4) as [SessionInfo['toolType'], string, string, string | undefined]),
						{
							...args[4],
							onProcessStarted: (value) => {
								pid = value;
							},
						}
					),
			});
			const pending = run('worker', 'fixture', undefined, controller.signal, origin);
			try {
				await vi.waitFor(() => expect(pid).toBeGreaterThan(0));
				await vi.waitFor(() => expect(fs.existsSync(argvOut)).toBe(true));
				const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
				expect(argv.slice(0, 3)).toEqual(['-C', dir, 'exec']);
				expect(argv).toContain('--json');
				expect(argv.slice(-4)).toEqual(['--fixture-label', 'spaces and $literal', '--', 'fixture']);
				expect(() => process.kill(pid!, 0)).not.toThrow();
				expect(isAgentBusy({ id: 'worker', aiTabs: [] }, null)).toBe(true);
				host.agentStates.worker.busy = isAgentBusy({ id: 'worker', aiTabs: [] }, null);
				expect(runtime.claim(command())).toMatchObject({ ok: false, reason: 'worker-busy' });
				controller.abort();
				expect(hasHeadlessAgentActivity('worker')).toBe(true);
				await pending;
				expect(() => process.kill(pid!, 0)).toThrow();
				expect(hasHeadlessAgentActivity('worker')).toBe(false);
				host.agentStates.worker.busy = false;
				expect(runtime.claim(command())).toMatchObject({ ok: true });
			} finally {
				controller.abort();
				await pending;
			}
		}
	);

	it('rejects missing, forged, mismatched, cancelled and revoked headless proofs without starting a child', async () => {
		const proof = issueAgentTurnAdmission('worker');
		const controller = new AbortController();
		const cancelled = issueAgentTurnAdmission('worker', controller.signal);
		controller.abort();
		for (const options of [
			{ originWorkerId: 'worker' },
			{ originWorkerId: 'worker', workerAdmission: { agentId: 'worker' } },
			{ originWorkerId: 'other', workerAdmission: proof },
			{ originWorkerId: 'worker', workerAdmission: cancelled },
		]) {
			await expect(
				spawnAgent('codex', dir, 'fixture', undefined, {
					...options,
					agentCommand: process.execPath,
					agentConfigValues: {},
				})
			).rejects.toThrow('admission proof');
		}
		revokeAgentTurnAdmission(proof);
		expect(() => startAdmittedAgentTurn(proof, 'worker')).toThrow('admission proof');
		expect(hasHeadlessAgentActivity('worker')).toBe(false);
	});

	it('releases successful/failed native attempts independently and admits a safe effort retry', async () => {
		configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
		const holding = fakeAgentSpec(
			dir,
			{ chunks: [], close: { code: 0, signal: null } },
			{ hold: true, argvOut: path.join(dir, 'sibling-argv.json') }
		);
		const rejected = fakeAgentSpec(dir, {
			chunks: [],
			stderr: `Unsupported value: 'minimal' is not supported with the 'fixture' model. reasoning.effort`,
			close: { code: 1, signal: null },
		});
		const completed = fakeAgentSpec(dir, {
			chunks: [
				JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }) +
					'\n',
				JSON.stringify({ type: 'turn.completed' }) + '\n',
			],
			close: { code: 0, signal: null },
		});
		const counter = path.join(dir, 'attempts');
		const attemptRecords = path.join(dir, 'attempt-records.jsonl');
		const shimDir = path.join(dir, 'retry provider');
		fs.mkdirSync(shimDir);
		const shim = path.join(shimDir, 'retry.cjs');
		fs.writeFileSync(
			shim,
			`const fs = require('node:fs');
const n = fs.existsSync(process.env.ATTEMPTS) ? Number(fs.readFileSync(process.env.ATTEMPTS, 'utf8')) : 0;
fs.writeFileSync(process.env.ATTEMPTS, String(n + 1));
fs.appendFileSync(process.env.ATTEMPT_RECORDS, JSON.stringify({ attempt: n + 1, pid: process.pid, execPath: process.execPath, argv: process.argv.slice(2) }) + '\\n');
process.env.FAKE_AGENT_RECORDING = n === 0 ? process.env.FIRST_RECORDING : process.env.SECOND_RECORDING;
import(${JSON.stringify(pathToFileURL(FAKE_AGENT_PATH).href)});
`,
			{ mode: 0o644 }
		);
		const siblingProof = issueAgentTurnAdmission('worker');
		const retryProof = issueAgentTurnAdmission('worker');
		const controller = new AbortController();
		let siblingPid: number | undefined;
		const sibling = spawnAgent('codex', dir, 'hold', undefined, {
			originWorkerId: 'worker',
			workerAdmission: siblingProof,
			agentCommand: holding.command,
			agentConfigValues: {},
			customEnvVars: holding.env as Record<string, string>,
			signal: controller.signal,
			onProcessStarted: (pid) => {
				siblingPid = pid;
			},
		});
		try {
			await vi.waitFor(() => expect(siblingPid).toBeGreaterThan(0));
			await vi.waitFor(() => expect(fs.existsSync(holding.env!.FAKE_AGENT_ARGV_OUT!)).toBe(true));
			providerScript = shim;
			const attempts: number[] = [];
			const attemptPids: number[] = [];
			const result = await spawnAgent('codex', dir, 'retry', undefined, {
				originWorkerId: 'worker',
				workerAdmission: retryProof,
				agentCommand: completed.command,
				agentConfigValues: {},
				customEffort: 'minimal',
				customEnvVars: {
					ATTEMPTS: counter,
					ATTEMPT_RECORDS: attemptRecords,
					FIRST_RECORDING: rejected.env.FAKE_AGENT_RECORDING!,
					SECOND_RECORDING: completed.env.FAKE_AGENT_RECORDING!,
				},
				onProcessStarted: (pid) => {
					expect(pid).toBeGreaterThan(0);
					expect(() => process.kill(pid!, 0)).not.toThrow();
					expect(() => process.kill(siblingPid!, 0)).not.toThrow();
					for (const previousPid of attemptPids) {
						expect(() => process.kill(previousPid, 0)).toThrow();
					}
					attemptPids.push(pid!);
					attempts.push(getHeadlessAgentActivity().counts.worker);
				},
			});
			expect(result).toMatchObject({ success: true, response: 'Done' });
			expect(fs.readFileSync(counter, 'utf8')).toBe('2');
			expect(attempts).toEqual([2, 2]); // no prior native child overlaps its retry
			const records = fs
				.readFileSync(attemptRecords, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			expect(records.map((record) => record.attempt)).toEqual([1, 2]);
			expect(records.map((record) => record.pid)).toEqual(attemptPids);
			expect(new Set(attemptPids).size).toBe(2);
			for (const record of records) {
				expect(record.execPath).toBe(process.execPath);
				expect(record.argv.slice(0, 3)).toEqual(['-C', dir, 'exec']);
				expect(record.argv).toContain('--json');
				expect(record.argv.slice(-2)).toEqual(['--', 'retry']);
				expect(() => process.kill(record.pid, 0)).toThrow();
			}
			expect(records[0].argv).toContain('model_reasoning_effort="minimal"');
			expect(records[1].argv).not.toContain('model_reasoning_effort="minimal"');
			expect(getHeadlessAgentActivity().counts.worker).toBe(1);
			const failed = await spawnAgent('codex', dir, 'missing binary', undefined, {
				originWorkerId: 'worker',
				workerAdmission: retryProof,
				agentCommand: path.join(dir, 'missing-executable'),
				agentConfigValues: {},
			});
			expect(failed.success).toBe(false);
			expect(getHeadlessAgentActivity().counts.worker).toBe(1);
			revokeAgentTurnAdmission(siblingProof);
			expect(getHeadlessAgentActivity().counts.worker).toBe(1); // revocation cannot free a running sibling
			expect(() => startAdmittedAgentTurn(siblingProof, 'worker')).toThrow('admission proof');
		} finally {
			controller.abort();
			await sibling;
			revokeAgentTurnAdmission(siblingProof);
			revokeAgentTurnAdmission(retryProof);
		}
		expect(hasHeadlessAgentActivity('worker')).toBe(false);
		expect(() => process.kill(siblingPid!, 0)).toThrow();
	});

	it('keeps occupancy through a throwing native start observer until the actual child exits', async () => {
		const proof = issueAgentTurnAdmission('worker');
		const fake = fakeAgentSpec(
			dir,
			{ chunks: [], close: { code: 0, signal: null } },
			{ hold: true }
		);
		let pid: number | undefined;
		await expect(
			spawnAgent('codex', dir, 'fixture', undefined, {
				originWorkerId: 'worker',
				workerAdmission: proof,
				agentCommand: fake.command,
				agentConfigValues: {},
				customEnvVars: fake.env as Record<string, string>,
				onProcessStarted: (value) => {
					pid = value;
					expect(pid).toBeGreaterThan(0);
					expect(() => process.kill(pid!, 0)).not.toThrow();
					throw new Error('observer failed');
				},
			})
		).rejects.toThrow('observer failed');
		revokeAgentTurnAdmission(proof);
		expect(hasHeadlessAgentActivity('worker')).toBe(true);
		await vi.waitFor(() => expect(hasHeadlessAgentActivity('worker')).toBe(false));
		expect(() => process.kill(pid!, 0)).toThrow();
	});
	it('preserves unsafe migration holds at the final real headless start', async () => {
		configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
		db.prepare(
			'INSERT INTO migration_worker_holds (worker_agent_id, claims_json) VALUES (?, ?)'
		).run('worker', '[]');
		const proof = issueAgentTurnAdmission('worker');
		await expect(
			spawnAgent('codex', dir, 'fixture', undefined, {
				originWorkerId: 'worker',
				workerAdmission: proof,
				agentCommand: process.execPath,
				agentConfigValues: {},
			})
		).rejects.toThrow('reserved');
		revokeAgentTurnAdmission(proof);
		expect(db.prepare('SELECT * FROM migration_worker_holds').all()).toHaveLength(1);
	});

	it('fences attributed Group Chat/Consult children in both orders without guessing from provider/CWD', async () => {
		configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
		const manager = new ProcessManager(() => false, { isCoworkingEnabled: () => false });
		const fake = fakeAgentSpec(
			dir,
			{ chunks: [], close: { code: 0, signal: null } },
			{ hold: true }
		);
		const spawn = (sessionId: string, originWorkerId?: string) =>
			spawnGroupChatAgent({
				sessionId,
				originWorkerId,
				agentId: 'codex',
				agent: { id: 'codex', command: fake.command, capabilities: {} } as never,
				command: fake.command,
				args: fake.args,
				cwd: fake.cwd,
				customEnvVars: fake.env as Record<string, string>,
				processManager: manager,
			});
		try {
			const token = claim();
			expect(await spawn('cross-agent-denied', 'worker')).toMatchObject({ success: false });
			expect(manager.getAll()).toHaveLength(0);
			// A standalone moderator is not this worker just because provider/CWD match.
			expect(await spawn('group-chat-moderator')).toMatchObject({ success: true });
			manager.kill('group-chat-moderator', { shutdown: true });
			expect(runtime.hold(token)).toEqual({ ok: true });
			expect(runtime.resume(token)).toEqual({ ok: true });
			for (const id of ['cross-agent-consult', 'group-chat-participant']) {
				expect(await spawn(id, 'worker')).toMatchObject({ success: true });
				host.agentStates.worker.busy = isAgentBusy({ id: 'worker', aiTabs: [] }, manager);
				expect(runtime.claim(command())).toMatchObject({ ok: false, reason: 'worker-busy' });
				manager.kill(id, { shutdown: true });
				expect(hasHeadlessAgentActivity('worker')).toBe(true);
				await vi.waitFor(() => expect(hasHeadlessAgentActivity('worker')).toBe(false));
			}
		} finally {
			manager.killAll({ shutdown: true });
			await vi.waitFor(() => expect(hasHeadlessAgentActivity('worker')).toBe(false));
		}
	});
	it('arbitrates a real desktop child and Board reservation in both start orders', async () => {
		configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
		const manager = new ProcessManager(() => false, { isCoworkingEnabled: () => false });
		const fake = fakeAgentSpec(
			dir,
			{ chunks: [], close: { code: 0, signal: null } },
			{ hold: true }
		);
		const config = {
			sessionId: 'worker-ai-fresh-tab',
			toolType: 'opencode',
			cwd: fake.cwd,
			command: fake.command,
			args: fake.args,
			customEnvVars: fake.env as Record<string, string>,
		};
		try {
			const token = claim();
			expect(manager.spawn(config)).toMatchObject({
				success: false,
				error: expect.stringContaining('reserved'),
			});
			expect(manager.getAll()).toHaveLength(0);
			expect(boardWorkerCanStart(db, 'worker', token.runId)).toBe(true);
			expect(boardWorkerCanStart(db, 'worker', 'unrelated-cue')).toBe(false);
			expect(runtime.hold(token)).toEqual({ ok: true });
			expect(runtime.resume(token)).toEqual({ ok: true });
			expect(manager.spawn(config)).toMatchObject({ success: true, pid: expect.any(Number) });
			host.agentStates = {
				worker: { ...host.agentStates.worker, busy: isAgentBusy({ id: 'worker' }, manager) },
			};
			expect(host.agentStates.worker.busy).toBe(true);
			expect(runtime.claim(command())).toMatchObject({ ok: false, reason: 'worker-busy' });
			manager.kill(config.sessionId, { shutdown: true });
			expect(manager.getAll()).toHaveLength(0);
			// Removing tab/process metadata is not a native termination receipt.
			expect(hasHeadlessAgentActivity('worker')).toBe(true);
			host.agentStates.worker.busy = isAgentBusy({ id: 'worker', aiTabs: [] }, manager);
			expect(runtime.claim(command())).toMatchObject({ ok: false, reason: 'worker-busy' });
			await vi.waitFor(() => expect(hasHeadlessAgentActivity('worker')).toBe(false));
			host.agentStates.worker.busy = isAgentBusy({ id: 'worker', aiTabs: [] }, manager);
			expect(runtime.claim(command())).toMatchObject({ ok: true });
		} finally {
			manager.killAll({ shutdown: true });
			await vi.waitFor(() => expect(manager.getAll()).toHaveLength(0));
			await vi.waitFor(() => expect(hasHeadlessAgentActivity('worker')).toBe(false));
		}
	});
	it('keeps a real non-Board Cue turn busy until its native process settles', async () => {
		const fake = fakeAgentSpec(
			dir,
			{ chunks: [], close: { code: 0, signal: null } },
			{ hold: true }
		);
		const pending = runProcess(
			'non-board-real',
			{ ...fake, env: fake.env as Record<string, string> },
			{
				agentId: 'worker',
				toolType: 'opencode',
				timeoutMs: 5000,
				onLog: vi.fn(),
			}
		);
		try {
			expect(hasHeadlessAgentActivity('worker')).toBe(true);
			host.agentStates = {
				worker: { ...host.agentStates.worker, busy: isAgentBusy({ id: 'worker' }, null) },
			};
			expect(runtime.claim(command())).toMatchObject({ ok: false, reason: 'worker-busy' });
		} finally {
			stopProcess('non-board-real');
			await pending;
		}
		expect(hasHeadlessAgentActivity('worker')).toBe(false);
	});
	it('fences unrelated native Cue starts while a Board reservation exists', async () => {
		configureAgentAdmission((id, runId) => boardWorkerCanStart(db, id, runId));
		const token = claim();
		const fake = fakeAgentSpec(dir, { chunks: [], close: { code: 0, signal: null } });
		const result = await runProcess(
			'unrelated-cue',
			{ ...fake, env: fake.env as Record<string, string> },
			{
				agentId: 'worker',
				toolType: 'opencode',
				timeoutMs: 5000,
				onLog: vi.fn(),
			}
		);
		expect(result.executionStarted).toBe(false);
		expect(reservations()).toHaveLength(1);
		expect(runtime.hold(token)).toEqual({ ok: true });
	});
	it('persists the real native Cue process identity and its completion in the same SQLite lifecycle', async () => {
		vi.mocked(service.spawn).mockImplementation(async (specification, callbacks) => {
			const spec = fakeAgentSpec(dir, {
				chunks: ['native fixture complete'],
				close: { code: 0, signal: null },
			});
			const result = await runProcess(
				specification.runToken.runId,
				{
					command: spec.command,
					args: spec.args,
					cwd: spec.cwd,
					env: spec.env as Record<string, string>,
				},
				{
					toolType: 'opencode',
					timeoutMs: 5000,
					onLog: vi.fn(),
					beforeLaunch: callbacks.beforeLaunch,
					onStarted: (pid) => {
						callbacks.onStarted(pid);
						expect(runtime.read(specification.runToken)!.life.process).toMatchObject({
							pid,
							cueRunId: specification.runToken.runId,
						});
						expect(card().status).toBe('running');
					},
				}
			);
			return {
				output: result.stdout,
				exitCode: result.exitCode,
				executionStarted: result.executionStarted,
				terminationConfirmed: result.terminationConfirmed,
			};
		});
		vi.mocked(service.stop).mockImplementation((spec) => {
			stopProcess(spec.runToken.runId);
		});
		const token = claim();
		expect(await runtime.start(token)).toEqual({ ok: true });
		expect(runtime.read(token)!.life.process!.pid).toBeGreaterThan(0);
		expect(card()).toMatchObject({
			status: 'blocked',
			workflow: { evidenceIncomplete: { runId: token.runId, missing: ['summary', 'artifact'] } },
		});
		expect(reservations()).toHaveLength(0);
	});
	it('keeps a prepared claim distinct from a process and starts exactly once, even across adapter instances', async () => {
		const token = claim();
		expect(card().status).toBe('todo');
		expect(card().runs ?? []).toEqual([]);
		const initial = runtime.read(token)!.spec;
		const pending = runtime.start(token);
		expect(runtime.read(token)!.life).toMatchObject({
			phase: 'running',
			process: { cueRunId: token.runId, pid: 202 },
		});
		expect(card().status).toBe('running');
		const other = newRuntime();
		expect(other.acquire()).toEqual({ ok: true });
		expect(await other.start(token)).toMatchObject({ ok: false, reason: 'already-started' });
		expect(service.spawn).toHaveBeenCalledTimes(1);
		expect(runtime.claim(command(1))).toMatchObject({ ok: false, reason: 'worker-busy' });
		hooks.onStarted(202);
		expect(card().runs as unknown[]).toHaveLength(1);
		settle(good);
		expect(await pending).toEqual({ ok: true });
		expect(reservations()).toEqual([]);
		expect(card().status).toBe('review');
		expect(runtime.read(token)!.spec).toEqual(initial);
		const before = persisted();
		expect(runtime.complete(token, good)).toEqual({ ok: false, reason: 'result-already-recorded' });
		expect(persisted()).toBe(before);
	});

	it('stamps PR receipts on the completed fenced run without changing its specification or result', async () => {
		const token = claim();
		const pending = runtime.start(token);
		settle(good);
		expect(await pending).toEqual({ ok: true });
		const before = runtime.read(token)!;
		const board = storage.read(roots[0], 'board');
		const run = board.cards[0].runs![0];
		const input = {
			...before.spec.key,
			expectedRevision: board.storage!.expectedRevision!,
			expectedCardRevision: board.cards[0].storageRevision!,
			run: { attempt: run.attempt, startedAt: run.startedAt },
			result: { prUrl: 'https://example.test/pull/1' },
			updatedAt: new Date().toISOString(),
		};
		const unchanged = persisted();
		expect(() =>
			storage.workspace.stampRunPr({ ...input, run: { ...input.run, startedAt: 'wrong' } })
		).toThrow();
		expect(persisted()).toBe(unchanged);
		storage.workspace.stampRunPr(input);
		expect(storage.read(roots[0], 'board').cards[0].runs![0].prUrl).toBe(input.result.prUrl);
		const after = runtime.read(token)!;
		expect(after.spec).toEqual(before.spec);
		expect(after.outcome).toEqual({
			...before.outcome,
			cardOutcome: {
				...(before.outcome!.cardOutcome as Record<string, unknown>),
				run: { ...run, prUrl: input.result.prUrl },
			},
		});
	});

	it.each(['alive', 'unknown'] as const)(
		'refuses owner takeover with %s proof despite an ancient heartbeat and the same PID',
		(proof) => {
			claim();
			db.prepare('UPDATE runtime_owner SET heartbeat=0').run();
			const before = persisted();
			expect(newRuntime(2, proof).acquire()).toEqual({ ok: false, reason: 'owner-conflict' });
			expect(persisted()).toBe(before);
		}
	);
	it('requires the native lock and full boot/start identity', () => {
		const incomplete = new BoardRuntime(
			storage,
			{
				info: { pid: 101, mode: 'desktop', startedAt: '2026-10-31' },
				verify: () => ({ ok: true }),
			},
			() => host,
			service,
			() => 'dead'
		);
		expect(incomplete.acquire()).toEqual({ ok: false, reason: 'owner-identity-unavailable' });
		lockValid = false;
		expect(runtime.acquire()).toEqual({ ok: false, reason: 'runtime-unavailable' });
		expect(runtime.claim(command())).toMatchObject({ ok: false, reason: 'owner-conflict' });
	});
	it('cannot manufacture a result before the native launch gate', () => {
		const token = claim();
		const before = persisted();
		expect(runtime.complete(token, good)).toEqual({ ok: false, reason: 'launch-proof-missing' });
		expect(persisted()).toBe(before);
	});
	it('passes persisted worker options through the real runtime run-service seam', async () => {
		const worker = listBoardWorkers(db)[0];
		const overrides = {
			customModel: 'configured',
			customEffort: 'high',
			appendSystemPrompt: 'role prompt',
			customArgs: '--quoted "value with spaces"',
		};
		setBoardWorkerOptions(db, worker.agentId, canonicalJson(worker.payload), overrides);
		const token = claim();
		const pending = runtime.start(token);
		expect(service.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				overrides,
				executionOptions: expect.objectContaining({
					worker: expect.objectContaining({
						agentId: worker.agentId,
						payload: expect.objectContaining({ executionOptions: overrides }),
					}),
				}),
			}),
			expect.anything()
		);
		settle(good);
		await pending;
		expect(card().status).toBe('review');
	});

	it('invalidates a prepared claim after fresh membership changes without launching', async () => {
		const token = claim();
		agents[0].groupId = 'elsewhere';
		expect(await runtime.start(token)).toMatchObject({ ok: false });
		expect(service.spawn).not.toHaveBeenCalled();
		expect(reservations()).toEqual([]);
		expect(runtime.read(token)!.life.phase).toBe('finished');
	});
	it('admits the assigned agent and rejects another registered group member at the host', async () => {
		agents.push({ id: 'other', groupId: 'group' });
		registerBoardWorker(db, 'other');
		setBoardWorkerAccess(db, 'other', [], ['repo0']);
		host.agentStates.other = { live: true, busy: false, location: { kind: 'local' } };
		const board = storage.read(roots[0], 'board');
		storage.capture({
			projectRoot: roots[0],
			boardId: 'board',
			expectedRevision: board.storage!.expectedRevision!,
			card: { ...board.cards[0], executionScope: { kind: 'agent', agentId: 'worker' } },
		});
		const before = persisted();
		expect(runtime.claim({ ...command(), workerAgentId: 'other' })).toMatchObject({ ok: false });
		expect(persisted()).toBe(before);
		expect(service.spawn).not.toHaveBeenCalled();
		const token = claim();
		const pending = runtime.start(token);
		expect(service.spawn).toHaveBeenCalledOnce();
		settle(good);
		await pending;
		expect(card().status).toBe('review');
	});
	it('rejects a registered group outsider without reserving or starting work', () => {
		agents.push({ id: 'outsider', groupId: 'elsewhere' });
		registerBoardWorker(db, 'outsider');
		setBoardWorkerAccess(db, 'outsider', [], ['repo0']);
		host.agentStates.outsider = { live: true, busy: false, location: { kind: 'local' } };
		const before = persisted();
		expect(runtime.claim({ ...command(), workerAgentId: 'outsider' })).toMatchObject({ ok: false });
		expect(persisted()).toBe(before);
		expect(reservations()).toEqual([]);
		expect(service.spawn).not.toHaveBeenCalled();
	});
	it('rejects reassignment while a prepared run owns the card', async () => {
		agents.push({ id: 'reviewer', groupId: 'group' });
		registerBoardWorker(db, 'reviewer');
		setBoardWorkerAccess(db, 'reviewer', [], ['repo0']);
		host.agentStates.reviewer = { live: true, busy: false, location: { kind: 'local' } };
		const token = claim();
		const board = storage.read(roots[0], 'board');
		expect(() =>
			storage.capture({
				projectRoot: roots[0],
				boardId: 'board',
				expectedRevision: board.storage!.expectedRevision!,
				card: { ...board.cards[0], executionScope: { kind: 'agent', agentId: 'reviewer' } },
			})
		).toThrow('Settle the active attempt before changing its execution specification');
		expect(card()).not.toMatchObject({ executionScope: { kind: 'agent', agentId: 'reviewer' } });
		const pending = runtime.start(token);
		settle(good);
		expect(await pending).toEqual({ ok: true });
	});
	it.each(['original', 'incremental'] as const)(
		'preserves %s registry and RunSpec fences across an external edit at the final launch gate',
		async (mode) => {
			const file = path.join(dir, 'launch-configs.json');
			fs.writeFileSync(file, JSON.stringify({ codex: { args: '--original' } }));
			const tracker = new BoardRegistryRevision();
			let fingerprint = '';
			let revision = 0;
			Object.defineProperty(host, 'registryRevision', {
				get: () => {
					const input = {
						catalog: storage.captureCatalog(),
						agents,
						groups: [{ id: 'group' }],
						workers: listBoardWorkers(db),
						agentConfigs: JSON.parse(fs.readFileSync(file, 'utf8')),
						sshRemotes: [],
					};
					if (mode === 'incremental') return tracker.observe(input);
					const current = canonicalJson(input);
					if (current !== fingerprint) {
						fingerprint = current;
						revision++;
					}
					return revision;
				},
			});
			const token = claim();
			const specification = runtime.read(token)!.spec;
			expect(specification.readRevision.registry).toBe(1);
			vi.mocked(service.spawn).mockImplementation(async (_spec, callbacks) => {
				await Promise.resolve();
				execFileSync(process.execPath, [
					'-e',
					`
					const fs = require('node:fs'); const file = process.argv[1];
					fs.writeFileSync(file, JSON.stringify({ codex: { args: '--external' } }));
				`,
					file,
				]);
				expect(callbacks.beforeLaunch()).toBe(false);
				return { output: '', exitCode: null, executionStarted: false };
			});
			await runtime.start(token);
			expect(reservations()).toEqual([]);
			expect(card().status).toBe('todo');
			expect(runtime.read(token)!.spec).toEqual(specification);
			expect(runtime.read(token)!.life.phase).toBe('finished');
		}
	);
	it.each([
		'pause',
		'membership',
		'busy',
		'registry',
		'repository',
		'disabled',
		'overrides',
		'worker-options',
		'approval',
		'removed',
		'pin',
	] as const)('rechecks %s after async preparation at the final native gate', async (change) => {
		vi.mocked(service.spawn).mockImplementation(async (_spec, callbacks) => {
			await Promise.resolve();
			if (change === 'pause') setBoardWorkerPaused(db, 'worker', true);
			if (change === 'membership') agents[0].groupId = 'elsewhere';
			if (change === 'busy') host.agentStates.worker.busy = true;
			if (change === 'registry') host.registryRevision++;
			if (change === 'repository') host.repository!.identity = 'different-repository';
			if (change === 'disabled') host.dispatchEnabled = false;
			if (change === 'removed') agents.splice(0, 1);
			if (change === 'pin')
				db.prepare(
					"UPDATE cards SET payload_json=json_set(payload_json, '$.assigneeAgentId', 'foreign') WHERE collection_key=?"
				).run(command().collectionKey);
			if (change === 'overrides') host.agentStates.worker.baseValues = { customModel: 'changed' };
			if (change === 'worker-options') {
				const worker = listBoardWorkers(db)[0];
				setBoardWorkerOptions(db, worker.agentId, canonicalJson(worker.payload), {
					customArgs: '--changed-after-prepare',
				});
			}
			if (change === 'approval')
				db.prepare(
					"UPDATE cards SET payload_json=json_set(payload_json, '$.capturePolicy.dispatchApproval', 'required') WHERE collection_key=?"
				).run(command().collectionKey);
			expect(callbacks.beforeLaunch()).toBe(false);
			return { output: '', exitCode: null, executionStarted: false };
		});
		const token = claim();
		await runtime.start(token);
		expect(reservations()).toEqual([]);
		expect(card().status).toBe('todo');
		expect((card().runs as { outcome: string }[])[0].outcome).toBe('reclaimed');
	});
	it('keeps a reserved worker row until the reservation is released', () => {
		claim();
		expect(() => db.prepare('DELETE FROM workers WHERE agent_id = ?').run('worker')).toThrow(
			/FOREIGN KEY constraint failed/
		);
		expect(reservations()).toHaveLength(1);
	});
	it('cannot authorize the launch twice', async () => {
		const token = claim();
		const pending = runtime.start(token);
		expect(hooks.beforeLaunch()).toBe(false);
		settle(good);
		await pending;
	});
	it('records nonstart failure and releases only that attempt, never accepting its success marker', async () => {
		vi.mocked(service.spawn).mockResolvedValue({
			...good,
			executionStarted: false,
			terminationConfirmed: false,
		});
		const token = claim();
		expect(await runtime.start(token)).toEqual({ ok: true });
		expect(card().status).toBe('ready');
		expect((card().runs as { outcome: string }[])[0].outcome).toBe('error');
		expect(reservations()).toEqual([]);
	});
	it('holds before requesting Stop, retains reservation until acknowledgement and preserves policy on Resume', async () => {
		const token = claim();
		const policy = card().capturePolicy;
		const pending = runtime.start(token);
		vi.mocked(service.stop).mockImplementation(() => {
			expect(card().heldByUser).toBe(true);
			expect(runtime.read(token)!.life.phase).toBe('stopping');
			expect(reservations()).toHaveLength(1);
		});
		expect(runtime.hold(token)).toEqual({ ok: true });
		expect(runtime.resume(token)).toMatchObject({ ok: false, reason: 'termination-unconfirmed' });
		settle(good); // A completion racing with Stop cannot override the hold.
		await pending;
		expect(card()).toMatchObject({ heldByUser: true, status: 'todo' });
		expect((card().runs as { outcome: string }[])[0].outcome).toBe('canceled');
		expect(runtime.resume(token)).toEqual({ ok: true });
		expect(card().heldByUser).toBe(false);
		expect(card().capturePolicy).toEqual(policy);
	});
	it('cancels a prepared claim without invoking Stop or a process', async () => {
		const token = claim();
		expect(runtime.hold(token)).toEqual({ ok: true });
		expect(service.stop).not.toHaveBeenCalled();
		expect(await runtime.start(token)).toMatchObject({ ok: false });
		expect(service.spawn).not.toHaveBeenCalled();
		expect(card()).toMatchObject({ heldByUser: true, status: 'todo' });
	});
	it('stops during pending launch without allowing its later launch gate', async () => {
		let gate!: BoardRunHooks;
		vi.mocked(service.spawn).mockImplementation(async (_spec, callbacks) => {
			gate = callbacks;
			await Promise.resolve();
			expect(gate.beforeLaunch()).toBe(false);
			return { output: '', exitCode: null, executionStarted: false };
		});
		const token = claim();
		const pending = runtime.start(token);
		runtime.hold(token);
		await pending;
		expect(reservations()).toEqual([]);
		expect(card().heldByUser).toBe(true);
	});
	it('keeps an exception at an uncertain start reserved instead of guessing nonstart', async () => {
		vi.mocked(service.spawn).mockRejectedValue(new Error('exception after syscall'));
		const token = claim();
		expect(await runtime.start(token)).toMatchObject({
			ok: false,
			reason: 'launch-or-result-uncertain',
		});
		expect(reservations()).toHaveLength(1);
		expect(runtime.read(token)!.outcome).toBeNull();
		expect(await runtime.start(token)).toMatchObject({ ok: false, reason: 'already-started' });
	});
	it.each(['alive', 'unknown'] as const)(
		'keeps a restarted uncertain launch reserved when native liveness is %s',
		async (proof) => {
			const token = claim();
			vi.mocked(service.spawn).mockRejectedValue(new Error('crash window'));
			await runtime.start(token);
			vi.mocked(service.probe).mockReturnValue(proof);
			const secondDb = openBoardDb(databasePath);
			try {
				const successor = newRuntime(2, 'dead', new BoardStorageFacade(secondDb, (root) => [root]));
				expect(successor.acquire()).toEqual({ ok: true });
				expect(successor.reconcile(token)).toMatchObject({
					ok: false,
					reason: 'reconciliation-required',
				});
				expect(reservations()).toHaveLength(1);
				expect(await successor.start(token)).toMatchObject({ ok: false, reason: 'owner-conflict' });
				expect(runtime.complete(token, good)).toMatchObject({
					ok: false,
					reason: 'owner-conflict',
				});
			} finally {
				secondDb.close();
			}
		}
	);
	it('recovers prepared work safely after proven owner death and rejects old-owner callbacks', () => {
		const token = claim();
		const successor = newRuntime(2, 'dead');
		expect(successor.acquire()).toEqual({ ok: true });
		expect(successor.reconcile(token)).toEqual({ ok: true });
		expect(service.probe).not.toHaveBeenCalled();
		expect(reservations()).toEqual([]);
		expect(runtime.complete(token, good)).toMatchObject({ ok: false, reason: 'owner-conflict' });
	});
	it.each(['starting', 'running', 'stopping'] as const)(
		'reopens persistent %s state conservatively and releases only on native termination proof',
		async (phase) => {
			if (phase === 'starting')
				vi.mocked(service.spawn).mockImplementation(
					() =>
						new Promise<CardSpawnResult>((resolve) => {
							settle = resolve;
						})
				);
			const token = claim();
			const pending = runtime.start(token);
			if (phase === 'stopping') runtime.hold(token);
			expect(runtime.read(token)!.life.phase).toBe(phase);
			const successorDb = openBoardDb(databasePath);
			try {
				const successor = newRuntime(
					2,
					'dead',
					new BoardStorageFacade(successorDb, (root) => [root])
				);
				expect(successor.acquire()).toEqual({ ok: true });
				expect(successor.reconcile(token)).toMatchObject({
					ok: false,
					reason: 'reconciliation-required',
				});
				expect(reservations()).toHaveLength(1);
				expect(successor.hold(token)).toEqual({ ok: true });
				expect(successor.resume(token)).toMatchObject({
					ok: false,
					reason: 'termination-unconfirmed',
				});
				vi.mocked(service.probe).mockReturnValue('terminated');
				expect(successor.reconcile(token)).toEqual({ ok: true });
				expect(card()).toMatchObject({ status: 'todo', heldByUser: true });
				const before = persisted();
				settle(good);
				expect(await pending).toMatchObject({ ok: false, reason: 'owner-conflict' });
				expect(persisted()).toBe(before);
			} finally {
				successorDb.close();
			}
		}
	);
	it('keeps agent review separate from human approval and records native result separately from card outcome', async () => {
		const token = claim();
		const pending = runtime.start(token);
		settle({ ...good, output: '<!-- maestro:card-review: Verify artifact -->' });
		await pending;
		expect(card().status).toBe('review');
		expect(runtime.read(token)!.outcome).toMatchObject({
			result: { exitCode: 0 },
			cardOutcome: { status: 'review', run: { outcome: 'review' } },
		});
		expect(runtime.resume(token)).toEqual({ ok: true });
		expect(card().status).toBe('review');
	});
	it('reclaims uncertain terminated work on native proof and fences late results after a newer attempt', async () => {
		const old = claim();
		vi.mocked(service.spawn).mockRejectedValueOnce(new Error('uncertain'));
		await runtime.start(old);
		vi.mocked(service.probe).mockReturnValue('terminated');
		expect(runtime.reconcile(old)).toEqual({ ok: true });
		const current = claim();
		expect(current.generation).toBe(2);
		const pending = runtime.start(current);
		const before = persisted();
		expect(runtime.complete(old, good)).toEqual({ ok: false, reason: 'result-already-recorded' });
		expect(runtime.hold(old)).toMatchObject({ ok: false, reason: 'attempt-conflict' });
		expect(runtime.resume(old)).toMatchObject({ ok: false, reason: 'attempt-conflict' });
		expect(persisted()).toBe(before);
		settle(good);
		await pending;
		expect(card().status).toBe('review');
	});
	it('does not overwrite a completed run when its result is delivered again with different output', async () => {
		const token = claim();
		const pending = runtime.start(token);
		settle(good);
		await pending;
		const before = persisted();
		expect(runtime.complete(token, { ...good, output: 'forged duplicate', exitCode: 1 })).toEqual({
			ok: false,
			reason: 'result-already-recorded',
		});
		expect(persisted()).toBe(before);
	});
	it.each(['membership', 'registration', 'repository-access'])(
		'rejects a result after %s is revoked',
		async (change) => {
			const token = claim();
			const pending = runtime.start(token);
			if (change === 'membership') agents[0].groupId = 'other';
			if (change === 'registration') agents = [];
			if (change === 'repository-access') setBoardWorkerAccess(db, 'worker', [], []);
			settle(good);
			expect(await pending).toMatchObject({ ok: false });
			expect(card().status).toBe('todo');
			expect(card().workflow?.workRunId).toBeUndefined();
		}
	);
	it('accepts the bound worker result while that worker is busy with its own run', async () => {
		const token = claim();
		const pending = runtime.start(token);
		host.agentStates.worker = { ...host.agentStates.worker, busy: true };
		settle(good);
		expect(await pending).toEqual({ ok: true });
		expect(card().status).toBe('review');
	});
	it('accepts an already-running result after intake is paused and rejects its duplicate', async () => {
		const token = claim();
		const pending = runtime.start(token);
		setBoardWorkerPaused(db, 'worker', true);
		settle({ ...good, output: 'preserved output' });
		expect(await pending).toEqual({ ok: true });
		expect(runtime.read(token)!.outcome).toMatchObject({ result: { output: 'preserved output' } });
		const before = persisted();
		expect(runtime.complete(token, good)).toMatchObject({
			ok: false,
			reason: 'result-already-recorded',
		});
		expect(persisted()).toBe(before);
	});
	it('still rejects a revoked worker result while intake is paused', async () => {
		const token = claim();
		const pending = runtime.start(token);
		setBoardWorkerPaused(db, 'worker', true);
		setBoardWorkerAccess(db, 'worker', [], []);
		settle(good);
		expect(await pending).toMatchObject({ ok: false });
		expect(card().status).toBe('todo');
	});
	it('rejects a result when the assigned namespaced role is revoked after start', async () => {
		db.prepare(
			'INSERT INTO profiles (profile_namespace, id, payload_json, source_key) VALUES (?, ?, ?, ?)'
		).run('fixture', 'role', canonicalJson({ id: 'role', name: 'Role' }), roots[0]);
		setBoardWorkerAccess(
			db,
			'worker',
			[{ namespace: 'fixture', profileId: 'role' }],
			['repo0', 'repo1']
		);
		const board = storage.read(roots[0], 'board');
		storage.capture({
			projectRoot: roots[0],
			boardId: 'board',
			expectedRevision: board.storage!.expectedRevision!,
			card: { ...board.cards[0], role: { namespace: 'fixture', profileId: 'role' } },
		});
		const token = claim();
		const pending = runtime.start(token);
		setBoardWorkerAccess(db, 'worker', [], ['repo0', 'repo1']);
		settle(good);
		expect(await pending).toMatchObject({ ok: false });
		expect(card().status).toBe('todo');
	});
	it('fences forged generation and epoch without partial writes', async () => {
		const token = claim();
		const before = persisted();
		for (const forged of [
			{ ...token, generation: 200 },
			{ ...token, ownerEpoch: 200 },
		]) {
			expect(await runtime.start(forged)).toMatchObject({ ok: false });
			expect(runtime.complete(forged, good)).toMatchObject({ ok: false });
			expect(runtime.hold(forged)).toMatchObject({ ok: false });
		}
		expect(persisted()).toBe(before);
	});
	it('rolls back card/outcome/release together when a storage write fails', async () => {
		const token = claim();
		const pending = runtime.start(token);
		db.exec(
			"CREATE TRIGGER fail_release BEFORE DELETE ON reservations BEGIN SELECT RAISE(ABORT, 'injected'); END"
		);
		const before = persisted();
		expect(() => runtime.complete(token, good)).toThrow('injected');
		expect(persisted()).toBe(before);
		db.exec('DROP TRIGGER fail_release');
		settle(good);
		await pending;
	});
	it('keeps an unconfirmed remote/local result reserved, regardless of success output', async () => {
		vi.mocked(service.spawn).mockResolvedValue({ ...good, terminationConfirmed: false });
		const token = claim();
		expect(await runtime.start(token)).toMatchObject({
			ok: false,
			reason: 'termination-unconfirmed',
		});
		expect(card().status).toBe('todo');
		expect(reservations()).toHaveLength(1);
	});
});

// Real SQLite, Git artifacts and the existing native Cue process lifecycle.
// This scoped contract test is not the final rendered-host acceptance.
describe('work, linked review and explicit final human decision', () => {
	it('publishes both human-approved statuses once, with one work completion notification', async () => {
		setupWorkflow();
		nativeService();
		const work = await runWork();
		const review = await runReview();
		await Promise.resolve();
		expect(transitions.filter((receipt) => receipt.notification?.kind === 'done')).toEqual([]);
		expect(transitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: expect.objectContaining({ cardId: 'same' }),
					change: expect.objectContaining({ fromStatus: 'review', toStatus: 'ready-for-human' }),
					cause: expect.objectContaining({ runId: review.runId }),
				}),
			])
		);
		transitions = [];
		events = [];
		toasts = [];
		const board = storage.read(roots[0], 'board');
		const accept = () =>
			runtime.acceptWork(
				command(),
				board.storage!.expectedRevision!,
				board.cards[0].storageRevision!,
				'native-desktop-main-frame'
			);
		expect(() =>
			db
				.transaction(() => {
					accept();
					expect(transitions).toEqual([]);
					throw new Error('approval rollback');
				})
				.immediate()
		).toThrow('approval rollback');
		// Identical approval retried before either deferred callback, at the same revisions.
		accept();
		expect(() => accept()).toThrow();
		db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
		await Promise.resolve();
		expect(transitions).toHaveLength(2);
		expect(events.filter((event) => event.topic === 'board.cardStatusChanged')).toHaveLength(2);
		expect(events.filter((event) => event.topic === 'board.cardCompleted')).toHaveLength(1);
		expect(toasts).toHaveLength(1);
		expect(transitions.map((receipt) => receipt.change.toStatus)).toEqual(['done', 'done']);
		const workReceipt = transitions.find((receipt) => receipt.key.cardId === 'same')!;
		expect(workReceipt).toMatchObject({
			runToken: work,
			notification: { kind: 'done' },
			cause: { phase: 'human' },
		});
		const reviewReceipt = transitions.find((receipt) => receipt.key.cardId !== 'same')!;
		expect(reviewReceipt.runToken).toEqual(review);
		expect(reviewReceipt.notification).toBeUndefined();
		expect(completed).toHaveBeenCalledTimes(2); // Native work and review only, no human PR replay.
	});
	it('publishes review-queue recovery only after its owning commit and never for a new card appearance', async () => {
		setupWorkflow();
		nativeService(undefined, '<!-- maestro:card-complete -->');
		const work = claimFor('same');
		if (!work.ok) throw new Error(work.reason);
		await runtime.start(work.runToken);
		db.prepare(
			"UPDATE cards SET payload_json=json_remove(json_set(payload_json, '$.status', 'review'), '$.workflow.evidenceIncomplete') WHERE collection_key='collection0' AND id='same'"
		).run();
		transitions = [];
		const outcome = runtime.read(work.runToken)!.outcome;
		const listener = (receipts: readonly BoardTransitionReceipt[]) => {
			transitions.push(...receipts);
			notifications.onTransitions(receipts);
		};
		events = [];
		toasts = [];
		expect(() =>
			db
				.transaction(() => {
					queueBoardReviews(storage, listener);
					throw new Error('queue rollback');
				})
				.immediate()
		).toThrow('queue rollback');
		await Promise.resolve();
		expect(transitions).toEqual([]);
		expect(card().status).toBe('review');
		expect(events).toEqual([]);
		expect(toasts).toEqual([]);
		db.transaction(() => queueBoardReviews(storage, listener)).immediate();
		queueBoardReviews(storage, listener);
		await Promise.resolve();
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			change: { fromStatus: 'review', toStatus: 'blocked' },
			cause: { phase: 'review-queue', runId: work.runToken.runId },
			notification: { kind: 'blocked' },
		});
		expect(events.map((event) => event.topic)).toEqual([
			'board.cardStatusChanged',
			'board.cardBlocked',
		]);
		expect(toasts).toHaveLength(1);
		expect(runtime.read(work.runToken)!.outcome).toEqual(outcome);
		expect(storage.read(roots[0], 'board').cards).toHaveLength(1);
	});
	function setupWorkflow() {
		agents.push({ id: 'reviewer', groupId: 'group' }, { id: 'foreign', groupId: 'other' });
		for (const id of ['reviewer', 'foreign']) {
			registerBoardWorker(db, id);
			setBoardWorkerAccess(db, id, [], ['repo0']);
			host.agentStates = {
				...host.agentStates,
				[id]: { live: true, busy: false, location: { kind: 'local' } },
			};
		}
		const board = storage.read(roots[0], 'board');
		storage.capture({
			projectRoot: roots[0],
			boardId: 'board',
			expectedRevision: board.storage!.expectedRevision!,
			card: { ...board.cards[0], reviewerAgentId: 'reviewer' },
		});
		const git = (...args: string[]) =>
			execFileSync('git', args, { cwd: roots[0], encoding: 'utf8' }).trim();
		git('init', '--quiet');
		git('config', 'user.name', 'Fixture');
		git('config', 'user.email', 'fixture@example.test');
		fs.writeFileSync(path.join(roots[0], 'work.txt'), 'initial');
		git('add', 'work.txt');
		git('commit', '--quiet', '-m', 'initial');
		return git;
	}
	function claimFor(cardId: string, workerAgentId = 'worker') {
		const input = command();
		const collection = storage.workspace.readCollection(input)!;
		return runtime.claim({
			...input,
			cardId,
			workerAgentId,
			readRevision: {
				...input.readRevision,
				card: collection.cards.find((card) => card.cardId === cardId)!.revision,
			},
		});
	}
	function nativeService(
		reviewOutput = '<!-- maestro:card-complete | Diff checked; fixture checks passed -->',
		workOutput = '<!-- maestro:card-complete | Work committed; fixture check passed -->',
		dirtyWork = false
	) {
		vi.mocked(service.spawn).mockImplementation(async (spec, callbacks) => {
			if (!callbacks.canPrepare()) return { output: '', exitCode: null, executionStarted: false };
			const before = await readBoardRunArtifact(roots[0]);
			const sourceCard = spec.card as unknown as import('../../../shared/board/types').BoardCard;
			const prior = sourceCard.runs?.find(
				(run) => run.runId === sourceCard.workflow?.evidenceIncomplete?.runId
			);
			const artifactBase = prior?.artifactBase ?? before!;
			const isReview = spec.card.kind === 'review';
			const handoff = spec.card.reviewHandoff as
				| import('../../../shared/board/types').BoardReviewHandoff
				| undefined;
			const script = isReview
				? `require('node:child_process').execFileSync('git', ['diff', '--check', ${JSON.stringify(handoff?.artifact.diff?.baseCommit)}, 'HEAD']); process.stdout.write(${JSON.stringify(reviewOutput)})`
				: `
				const fs = require('node:fs'); const cp = require('node:child_process');
				fs.writeFileSync('work.txt', ${JSON.stringify('corrected work: ')} + ${spec.attempt});
				require('node:assert/strict').equal(fs.readFileSync('work.txt', 'utf8'), ${JSON.stringify('corrected work: ')} + ${spec.attempt});
				cp.execFileSync('git', ['add', 'work.txt']); cp.execFileSync('git', ['commit', '--quiet', '-m', 'work']);
				${dirtyWork ? "fs.writeFileSync('pending.txt', 'uncommitted evidence');" : ''}
				process.stdout.write(${JSON.stringify(workOutput)});`;
			const result = await runProcess(
				spec.runToken.runId,
				{
					command: process.execPath,
					args: ['-e', script],
					cwd: roots[0],
					env: process.env as Record<string, string>,
				},
				{
					agentId: spec.workerAgentId,
					toolType: 'opencode',
					timeoutMs: 5000,
					onLog: () => {},
					beforeLaunch: callbacks.beforeLaunch,
					onStarted: callbacks.onStarted,
				}
			);
			return {
				artifactBase,
				output: result.stdout,
				exitCode: result.exitCode,
				executionStarted: result.executionStarted,
				terminationConfirmed: result.terminationConfirmed,
				artifact:
					(await readBoardRunArtifact(
						roots[0],
						handoff?.artifact.diff?.baseCommit ?? artifactBase.commit
					)) ?? undefined,
			};
		});
	}
	async function runWork() {
		const claim = claimFor('same');
		if (!claim.ok) throw new Error(claim.reason);
		expect(card().status).toBe('todo');
		expect(await runtime.start(claim.runToken)).toEqual({ ok: true });
		expect(card().status).toBe('review');
		return claim.runToken;
	}
	async function runReview() {
		const board = storage.read(roots[0], 'board');
		const work = board.cards.find((card) => card.id === 'same')!;
		const review = board.cards.find((card) => card.id === work.workflow!.reviewCardId)!;
		host.reviewArtifact = await prepareBoardReviewHandoff(storage, review.reviewHandoff!);
		expect(host.reviewArtifact).toBeTruthy();
		expect(claimFor(review.id, 'foreign')).toMatchObject({ ok: false });
		const claim = claimFor(review.id, 'reviewer');
		if (!claim.ok) throw new Error(claim.reason);
		expect(await runtime.start(claim.runToken)).toEqual({ ok: true });
		return claim.runToken;
	}
	it.each([
		['missing markers', 'Work finished', false, ['summary']],
		['missing summary', '<!-- maestro:card-complete -->', false, ['summary']],
		[
			'missing clean artifact',
			'<!-- maestro:card-complete | Checks passed -->',
			true,
			['artifact'],
		],
	] as const)(
		'recovers successful work with %s on the same card without bypassing review',
		async (_name, output, dirty, missing) => {
			setupWorkflow();
			nativeService(undefined, output, dirty);
			const claim = claimFor('same');
			if (!claim.ok) throw new Error(claim.reason);
			expect(await runtime.start(claim.runToken)).toEqual({ ok: true });
			const incomplete = storage.read(roots[0], 'board');
			expect(incomplete.cards[0]).toMatchObject({
				id: 'same',
				status: 'blocked',
				workflow: { evidenceIncomplete: { runId: claim.runToken.runId, missing } },
			});
			const history = incomplete.cards[0].runs;
			expect(incomplete.cards[0].workflow?.evidenceIncomplete?.missing).toEqual(missing);
			const stored = db
				.prepare('SELECT outcome_json FROM runs WHERE run_id=?')
				.get(claim.runToken.runId);
			expect(history).toMatchObject([{ runId: claim.runToken.runId, attempt: 1, outcome: 'done' }]);
			expect(reservations()).toHaveLength(0);
			expect(claimFor('same')).toMatchObject({ ok: false, reason: 'card-not-ready' });
			queueBoardReviews(storage);
			queueBoardReviews(storage);
			expect(storage.read(roots[0], 'board').cards).toHaveLength(1);
			for (const status of ['review', 'ready-for-human', 'done'] as const)
				expect(() =>
					updateCardStatus(roots[0], 'board', 'same', status, incomplete.storage!.expectedRevision!)
				).toThrow();
			expect(() =>
				storage.capture({
					projectRoot: roots[0],
					boardId: 'board',
					expectedRevision: incomplete.storage!.expectedRevision!,
					card: { ...incomplete.cards[0], workflow: { version: 1, corrections: 0 } },
				})
			).toThrow('workflow');
			// An explicit, revision-checked status request requeues the existing card.
			expect(() =>
				updateCardStatus(
					roots[0],
					'board',
					'same',
					'todo',
					incomplete.storage!.expectedRevision! - 1
				)
			).toThrow();
			updateCardStatus(roots[0], 'board', 'same', 'todo', incomplete.storage!.expectedRevision!);
			const retried = storage.read(roots[0], 'board');
			expect(retried.cards[0].runs).toEqual(history);
			expect(
				db.prepare('SELECT outcome_json FROM runs WHERE run_id=?').get(claim.runToken.runId)
			).toEqual(stored);
			expect(claimFor('same', 'foreign')).toMatchObject({ ok: false });
			if (dirty) fs.unlinkSync(path.join(roots[0], 'pending.txt'));
			nativeService();
			const retry = claimFor('same');
			if (!retry.ok) throw new Error(retry.reason);
			expect(retry.attempt).toBe(2);
			const before = persisted();
			expect(
				runtime.complete({ ...retry.runToken, generation: retry.runToken.generation + 1 }, good)
			).toMatchObject({ ok: false });
			expect(runtime.complete(claim.runToken, good)).toMatchObject({ ok: false });
			expect(persisted()).toBe(before);
			expect(await runtime.start(retry.runToken)).toEqual({ ok: true });
			expect(card()).toMatchObject({
				status: 'review',
				workflow: { workRunId: retry.runToken.runId },
			});
			expect(storage.read(roots[0], 'board').cards[0].workflow?.evidenceIncomplete).toBeUndefined();
			queueBoardReviews(storage);
			queueBoardReviews(storage);
			expect(storage.read(roots[0], 'board').cards).toHaveLength(2);
			const queued = storage.read(roots[0], 'board').cards[1];
			expect(queued.reviewHandoff?.artifact.diff?.baseCommit).toBe(
				history![0].artifactBase!.commit
			);
			expect(storage.read(roots[0], 'board').cards[0].runs![0]).toEqual(history![0]);
			await runReview();
			expect(card().status).toBe('ready-for-human');
			expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 3 });
		}
	);
	it.each([true, false])(
		'recovers already stranded successful work with reviewer present=%s without changing run history',
		async (reviewerPresent) => {
			setupWorkflow();
			nativeService(undefined, '<!-- maestro:card-complete -->');
			const token = claimFor('same');
			if (!token.ok) throw new Error(token.reason);
			expect(await runtime.start(token.runToken)).toEqual({ ok: true });
			// Reproduce the previous host's durable state, with no linked review task.
			db.prepare(
				"UPDATE cards SET payload_json=json_remove(json_set(payload_json, '$.status', 'review'), '$.workflow.evidenceIncomplete') WHERE collection_key=? AND id='same'"
			).run(command().collectionKey);
			if (!reviewerPresent)
				db.prepare(
					"UPDATE cards SET payload_json=json_remove(payload_json, '$.reviewerAgentId') WHERE collection_key=? AND id='same'"
				).run(command().collectionKey);
			const history = db.prepare('SELECT * FROM runs').all();
			queueBoardReviews(storage);
			expect(card()).toMatchObject({
				status: 'blocked',
				workflow: { evidenceIncomplete: { runId: token.runToken.runId, missing: ['summary'] } },
			});
			const after = persisted();
			queueBoardReviews(storage);
			expect(persisted()).toBe(after);
			expect(db.prepare('SELECT * FROM runs').all()).toEqual(history);
			expect(storage.read(roots[0], 'board').cards).toHaveLength(1);
		}
	);
	it('rejects a review result when reviewer membership is revoked after start', async () => {
		setupWorkflow();
		nativeService();
		await runWork();
		const work = card();
		const review = storage
			.read(roots[0], 'board')
			.cards.find((c) => c.id === work.workflow!.reviewCardId)!;
		host.reviewArtifact = await prepareBoardReviewHandoff(storage, review.reviewHandoff!);
		vi.mocked(service.spawn).mockImplementation(async (_spec, callbacks) => {
			if (!callbacks.beforeLaunch()) throw new Error('launch rejected');
			callbacks.onStarted(202);
			return new Promise<CardSpawnResult>((resolve) => {
				settle = resolve;
			});
		});
		const attempt = claimFor(review.id, 'reviewer');
		if (!attempt.ok) throw new Error(attempt.reason);
		const pending = runtime.start(attempt.runToken);
		agents.find((agent) => agent.id === 'reviewer')!.groupId = 'other';
		settle({ ...good, artifact: review.reviewHandoff!.artifact });
		expect(await pending).toMatchObject({ ok: false });
		expect(card().status).toBe('review');
		expect(card().workflow?.reviewResult).toBeUndefined();
	});
	it('uses native work and review run IDs, binds the actual diff and waits for a separate human decision', async () => {
		setupWorkflow();
		nativeService();
		const work = await runWork();
		expect((card().runs as { runId: string }[])[0].runId).toBe(work.runId);
		queueBoardReviews(storage);
		queueBoardReviews(storage);
		expect(storage.read(roots[0], 'board').cards).toHaveLength(2);
		const review = await runReview();
		expect(card().status).toBe('ready-for-human');
		expect(card().workflow).toMatchObject({
			reviewResult: { workRunId: work.runId, reviewRunId: review.runId, verdict: 'clean' },
		});
		let board = storage.read(roots[0], 'board');
		expect(() =>
			storage.save(
				roots[0],
				[{ ...board, cards: board.cards.map((card) => ({ ...card, status: 'done' })) }],
				true
			)
		).toThrow('workflow');
		const key = { ...command(), cardId: 'same' };
		expect(() =>
			approveBoardWork(
				storage,
				key,
				board.storage!.expectedRevision!,
				board.cards[0].storageRevision!,
				''
			)
		).toThrow('clean bound review');
		const proof = db
			.prepare('SELECT lifecycle_json FROM runs WHERE run_id=?')
			.get(review.runId) as { lifecycle_json: string };
		db.prepare('UPDATE runs SET lifecycle_json=NULL WHERE run_id=?').run(review.runId);
		expect(() =>
			approveBoardWork(
				storage,
				key,
				board.storage!.expectedRevision!,
				board.cards[0].storageRevision!,
				'native-desktop-main-frame'
			)
		).toThrow('native work and review evidence');
		db.prepare('UPDATE runs SET lifecycle_json=? WHERE run_id=?').run(
			proof.lifecycle_json,
			review.runId
		);
		board = storage.read(roots[0], 'board');
		approveBoardWork(
			storage,
			key,
			board.storage!.expectedRevision!,
			board.cards[0].storageRevision!,
			'native-desktop-main-frame'
		);
		expect(card().status).toBe('done');
		expect((card().workflow as { humanDecision: unknown }).humanDecision).toMatchObject({
			workRunId: work.runId,
			reviewRunId: review.runId,
		});
		expect(reservations()).toHaveLength(0);
	});
	it('bounds findings to one traceable correction and retains every work and review attempt', async () => {
		setupWorkflow();
		nativeService('<!-- maestro:card-findings: Incorrect fixture value; check failed -->');
		await runWork();
		await runReview();
		expect(card()).toMatchObject({
			status: 'todo',
			workflow: { corrections: 1, reviewResult: { verdict: 'findings' } },
		});
		await runWork();
		await runReview();
		expect(card()).toMatchObject({
			status: 'blocked',
			workflow: { corrections: 1, correctionLimitReached: true },
		});
		expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 4 });
		expect(claimFor('same')).toMatchObject({ ok: false, reason: 'card-not-ready' });
	});
	it('waits for a missing reviewer and prevents completion-status and forged-run bypasses', async () => {
		const board = storage.read(roots[0], 'board');
		for (const status of ['review', 'ready-for-human', 'done'] as const)
			expect(() =>
				storage.capture({
					projectRoot: roots[0],
					boardId: 'board',
					expectedRevision: board.storage!.expectedRevision!,
					card: { ...board.cards[0], status },
				})
			).toThrow();
		const token = claim();
		const pending = runtime.start(token);
		settle(good);
		await pending;
		expect(card().status).toBe('review');
		expect(storage.read(roots[0], 'board').cards).toHaveLength(1);
	});
	it('rejects reviewer membership and pause changes between prepare and native start', async () => {
		setupWorkflow();
		nativeService();
		await runWork();
		const board = storage.read(roots[0], 'board');
		const review = board.cards[1];
		host.reviewArtifact = await prepareBoardReviewHandoff(storage, review.reviewHandoff!);
		let result = claimFor(review.id, 'reviewer');
		if (!result.ok) throw new Error(result.reason);
		agents = agents.map((agent) =>
			agent.id === 'reviewer' ? { ...agent, groupId: 'other' } : agent
		);
		expect(await runtime.start(result.runToken)).toMatchObject({ ok: false });
		expect(card().status).toBe('review');
		agents = agents.map((agent) =>
			agent.id === 'reviewer' ? { ...agent, groupId: 'group' } : agent
		);
		result = claimFor(review.id, 'reviewer');
		if (!result.ok) throw new Error(result.reason);
		setBoardWorkerPaused(db, 'reviewer', true);
		expect(await runtime.start(result.runToken)).toMatchObject({
			ok: false,
			reason: 'worker-paused',
		});
		expect(reservations()).toHaveLength(0);
	});
});
