import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
	readBoardRunArtifact,
	captureBoardCardFromHost,
	prepareBoardReviewHandoff,
} from '../../../main/board/board-review';
import { configureBoardStorage } from '../../../main/board/board-storage';
import * as path from 'node:path';
import { openBoardDb } from '../../../main/board/board-db';
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
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { createPluginHeadlessAgentRunner } from '../../../main/plugins/plugin-headless-agent-runner';
import type { SessionInfo } from '../../../shared/types';
import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { pathToFileURL } from 'node:url';
import { FAKE_AGENT_PATH } from '../../shared/maestro-lib/run/fakeAgent';
import { isAgentBusy } from '../../../main/utils/agent-busy';
import { ProcessManager } from '../../../main/process-manager';
import type { BoardClaimHostContext } from '../../../main/board/board-claims';
import type { CardSpawnResult } from '../../../main/board/board-dispatcher';
import { canonicalJson } from '../../../shared/canonicalJson';
import { generateUUID } from '../../../shared/uuid';
import { runProcess, stopProcess } from '../../../main/cue/cue-process-lifecycle';
import { fakeAgentSpec } from '../../shared/maestro-lib/run/fakeAgent';

vi.mock('../../../cli/services/storage', () => ({
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSshRemotes: () => [],
	readSettings: () => ({}),
}));
vi.mock('../../../cli/services/wakatime', () => ({ buildCliWakaTimeHeartbeat: () => undefined }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

let dir: string;
let db: ReturnType<typeof openBoardDb>;
let storage: BoardStorageFacade;
let runtime: BoardRuntime;
let roots: string[];
let host: Omit<BoardClaimHostContext, 'owner'>;
let agents: { id: string; groupId: string }[];
let service: BoardRunService;
let hooks: BoardRunHooks;
let settle: (result: CardSpawnResult) => void;
let lockValid: boolean;
const good: CardSpawnResult = {
	output: '<!-- maestro:card-complete -->',
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
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/lifecycle-'));
	db = openBoardDb(path.join(dir, 'fixture.sqlite'));
	storage = new BoardStorageFacade(db, (root) => [root]);
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
	configureBoardStorage(null);
	configureAgentAdmission(() => true);
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
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
		.cards[0].payload;
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
		const artifact = await readBoardRunArtifact(roots[0]);
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
				return { exists: true, path: FAKE_AGENT_PATH };
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
			const fake = fakeAgentSpec(
				dir,
				{ chunks: [], close: { code: 0, signal: null } },
				{ hold: true }
			);
			const controller = new AbortController();
			let pid: number | undefined;
			const run = createPluginHeadlessAgentRunner({
				getAgent: () =>
					({ id: 'worker', toolType: 'codex', cwd: dir, customEnvVars: fake.env }) as SessionInfo,
				detectAgent: async () => ({ available: true, path: FAKE_AGENT_PATH }),
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
					agentCommand: FAKE_AGENT_PATH,
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
			{ hold: true }
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
		const shim = path.join(dir, 'retry.cjs');
		fs.writeFileSync(
			shim,
			`#!/usr/bin/env node
const fs = require('node:fs');
const n = fs.existsSync(process.env.ATTEMPTS) ? Number(fs.readFileSync(process.env.ATTEMPTS, 'utf8')) : 0;
fs.writeFileSync(process.env.ATTEMPTS, String(n + 1));
process.env.FAKE_AGENT_RECORDING = n === 0 ? process.env.FIRST_RECORDING : process.env.SECOND_RECORDING;
import(${JSON.stringify(pathToFileURL(FAKE_AGENT_PATH).href)});
`,
			{ mode: 0o755 }
		);
		const siblingProof = issueAgentTurnAdmission('worker');
		const retryProof = issueAgentTurnAdmission('worker');
		const controller = new AbortController();
		let started = false;
		const sibling = spawnAgent('codex', dir, 'hold', undefined, {
			originWorkerId: 'worker',
			workerAdmission: siblingProof,
			agentCommand: FAKE_AGENT_PATH,
			agentConfigValues: {},
			customEnvVars: holding.env as Record<string, string>,
			signal: controller.signal,
			onProcessStarted: () => {
				started = true;
			},
		});
		try {
			await vi.waitFor(() => expect(started).toBe(true));
			const attempts: number[] = [];
			const result = await spawnAgent('codex', dir, 'retry', undefined, {
				originWorkerId: 'worker',
				workerAdmission: retryProof,
				agentCommand: shim,
				agentConfigValues: {},
				customEffort: 'minimal',
				customEnvVars: {
					ATTEMPTS: counter,
					FIRST_RECORDING: rejected.env.FAKE_AGENT_RECORDING!,
					SECOND_RECORDING: completed.env.FAKE_AGENT_RECORDING!,
				},
				onProcessStarted: () => {
					attempts.push(getHeadlessAgentActivity().counts.worker);
				},
			});
			expect(result).toMatchObject({ success: true, response: 'Done' });
			expect(fs.readFileSync(counter, 'utf8')).toBe('2');
			expect(attempts).toEqual([2, 2]); // no prior native child overlaps its retry
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
				agentCommand: FAKE_AGENT_PATH,
				agentConfigValues: {},
				customEnvVars: fake.env as Record<string, string>,
				onProcessStarted: (value) => {
					pid = value;
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
				agentCommand: FAKE_AGENT_PATH,
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
		expect(card().status).toBe('done');
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
		expect(card().status).toBe('done');
		expect(runtime.read(token)!.spec).toEqual(initial);
		const before = persisted();
		expect(runtime.complete(token, good)).toEqual({ ok: true, duplicate: true });
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
	it('invalidates a prepared claim after fresh membership changes without launching', async () => {
		const token = claim();
		agents[0].groupId = 'elsewhere';
		expect(await runtime.start(token)).toMatchObject({ ok: false });
		expect(service.spawn).not.toHaveBeenCalled();
		expect(reservations()).toEqual([]);
		expect(runtime.read(token)!.life.phase).toBe('finished');
	});
	it.each([
		'pause',
		'membership',
		'busy',
		'registry',
		'repository',
		'disabled',
		'overrides',
		'approval',
	] as const)('rechecks %s after async preparation at the final native gate', async (change) => {
		vi.mocked(service.spawn).mockImplementation(async (_spec, callbacks) => {
			await Promise.resolve();
			if (change === 'pause') setBoardWorkerPaused(db, 'worker', true);
			if (change === 'membership') agents[0].groupId = 'elsewhere';
			if (change === 'busy') host.agentStates.worker.busy = true;
			if (change === 'registry') host.registryRevision++;
			if (change === 'repository') host.repository!.identity = 'different-repository';
			if (change === 'disabled') host.dispatchEnabled = false;
			if (change === 'overrides') host.agentStates.worker.baseValues = { customModel: 'changed' };
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
			const secondDb = openBoardDb(path.join(dir, 'fixture.sqlite'));
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
			const successorDb = openBoardDb(path.join(dir, 'fixture.sqlite'));
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
		expect(runtime.complete(old, good)).toEqual({ ok: true, duplicate: true });
		expect(runtime.hold(old)).toMatchObject({ ok: false, reason: 'attempt-conflict' });
		expect(runtime.resume(old)).toMatchObject({ ok: false, reason: 'attempt-conflict' });
		expect(persisted()).toBe(before);
		settle(good);
		await pending;
		expect(card().status).toBe('done');
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
