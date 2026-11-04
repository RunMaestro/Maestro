/** Real registry/checkpoint/decision storage composed with host proof ingress and
 * the actual supervisor. No live configuration, process or recipient is used. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }));
vi.mock('electron', () => ({ app: { getPath: () => process.env.MAESTRO_USER_DATA } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/fixture/cli.js',
}));
vi.mock('../../../shared/maestro-lib/control/termination', () => ({
	stopProcess: vi.fn(),
	BACKGROUND_STOP_GRACE_MS: 0,
}));
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import { PianolaSupervisor } from '../../../main/pianola/pianola-supervisor';
import { migratePianolaLegacyWatches } from '../../../main/pianola/pianola-legacy-migration';
import { hostCallerRuns } from '../../../main/agent-run/caller-identity';
import { runWatchIteration, initialWatchState } from '../../../shared/pianola/pianola-watcher';
import type { PianolaMessage } from '../../../shared/pianola/types';
import { CALLER_RUN_PROOF_FILE_ENV_VAR } from '../../../shared/agentDelegation';
import { resolvePianolaScopeOwnership } from '../../../shared/pianola/pianola-scope';
import {
	admitPianolaScopeReply,
	runPianolaScopeCycle,
	type PianolaScopeSnapshot,
	type PianolaScopeCycleDeps,
} from '../../../shared/pianola/pianola-scope-cycle';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';

const scopeId = '11111111-1111-4111-8111-111111111111';
let directory: string;
let supervisor: PianolaSupervisor;
let enabled: boolean;
let store: ReturnType<typeof createPianolaFsStore>;
let snapshot: PianolaScopeSnapshot;
let spawned: Array<{ args: readonly string[]; opts: SpawnOptions; child: ChildProcess }>;
const scope = (): PianolaSupervisedTarget => ({
	id: scopeId,
	kind: 'watch-scope',
	enabled: true,
	createdAt: 1,
	managerAgentId: 'manager',
	selection: {
		label: 'Agents',
		mode: 'agents-and-groups',
		agentIds: ['owner'],
		groupIds: [],
		excludedAgentIds: [],
	},
	delegationPolicy: {
		version: 1,
		revision: 1,
		enabled: true,
		managerAgentId: 'manager',
		coverage: 'selected-agents',
		ruleSetRevision: 'standing-rules',
	},
});
const legacy = (id = 'legacy', tabId = 'old', on = true): PianolaSupervisedTarget => ({
	id,
	kind: 'watch',
	enabled: on,
	createdAt: 0,
	agentId: 'owner',
	tabId,
});
const tab = (tabId: string, agentId = 'owner') => ({
	agentId,
	tabId,
	paused: false,
	consult: false,
	ephemeral: false,
	busy: false,
	createdAt: 1,
	cursorAvailable: true,
	cursor: { id: 'historical', count: 1, textLength: 34 },
});
const migrate = (target = scope(), fence = (id: string) => supervisor.canFenceLegacyWatch(id)) =>
	migratePianolaLegacyWatches(target, {
		store,
		snapshot: () => snapshot,
		canFence: fence,
		featureEnabled: () => enabled,
	});
function ownership(tabId: string, agentId = 'owner') {
	const targets = store.readSupervisorTargets();
	return resolvePianolaScopeOwnership(
		tab(tabId, agentId),
		snapshot.owners,
		targets
			.filter((t) => t.kind === 'watch-scope')
			.map((t) => ({ ...t, selection: t.selection!, managerAgentId: t.managerAgentId! })),
		targets.filter((t) => t.kind === 'watch')
	);
}

beforeEach(() => {
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	fs.mkdirSync(root, { recursive: true });
	directory = fs.mkdtempSync(path.join(root, 'legacy-migration-'));
	vi.stubEnv('MAESTRO_USER_DATA', directory);
	store = createPianolaFsStore({ resolveDir: () => directory, indent: 2, trailingNewline: true });
	enabled = true;
	spawned = [];
	supervisor = new PianolaSupervisor({
		isEnabled: () => enabled,
		getPianolaAgentId: () => 'manager',
		spawnChild: (_cmd, args, opts) => {
			const child = Object.assign(new EventEmitter(), {
				pid: 999999,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				exitCode: null,
				signalCode: null,
				kill: vi.fn(),
			}) as unknown as ChildProcess;
			spawned.push({ args, opts, child });
			return child;
		},
	});
	snapshot = {
		complete: true,
		capturedAt: 100,
		owners: [
			{ id: 'owner', cwd: '/project', groupId: null, remote: false, isPianola: false },
			{
				id: 'child',
				cwd: '/worktree',
				parentSessionId: 'owner',
				groupId: null,
				remote: false,
				isPianola: false,
			},
			{ id: 'manager', cwd: '/manager', groupId: null, remote: false, isPianola: true },
		],
		tabs: [tab('old'), tab('paused'), tab('sibling'), tab('child-tab', 'child')],
	};
	store.writeSupervisorTargets([legacy(), legacy('pause', 'paused', false)]);
});
afterEach(() => {
	supervisor.stopAll();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('atomic legacy handover', () => {
	it('fences a real active owner at host ingress before stop, preserves a concrete pause and covers siblings/worktrees with one scope', async () => {
		// The checkout's ancestors are group writable on this CI host. Simulate
		// private host ancestors only; all fixture files/proof bytes remain real.
		const lstat = fs.lstatSync;
		vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
			const stat = lstat(file, options as never);
			return directory.startsWith(String(file) + path.sep) && String(file) !== directory
				? Object.assign(Object.create(stat), { mode: stat.mode & ~0o022 })
				: stat;
		}) as typeof fs.lstatSync);
		supervisor.reconcile();
		const proofPath = spawned[0].opts.env![CALLER_RUN_PROOF_FILE_ENV_VAR]!;
		expect(proofPath).toBeTruthy();
		const proof = fs.readFileSync(proofPath, 'utf8');
		const client = { cliAuthenticated: true };
		hostCallerRuns.bind(client, proof);
		expect(hostCallerRuns.resolve(client)).toBeDefined();
		expect(await migrate()).toMatchObject({ status: 'migrated', watchIds: ['legacy'] });
		// No reconcile/kill has run: the same live child and connected client are denied.
		expect(spawned).toHaveLength(1);
		expect(hostCallerRuns.resolve(client)).toBeUndefined();
		expect(hostCallerRuns.isRunClient(client)).toBe(true);
		expect(ownership('old')).toEqual({ kind: 'scope', scopeId });
		expect(ownership('paused')).toEqual({ kind: 'excluded', reason: 'disabled watch' });
		expect(ownership('sibling')).toEqual({ kind: 'scope', scopeId });
		expect(ownership('child-tab', 'child')).toEqual({ kind: 'scope', scopeId });
		expect(ownership('new-chat')).toEqual({ kind: 'scope', scopeId });
		supervisor.reconcile();
		expect(spawned.filter((s) => s.args.includes('watch-scope'))).toHaveLength(1);
		expect(await migrate()).toMatchObject({ status: 'already-migrated' });
		supervisor.reconcile();
		expect(spawned).toHaveLength(2);
	});

	it.each(['policy', 'manager', 'proof', 'feature'] as const)(
		'leaves old rights intact when %s is missing',
		async (missing) => {
			const target = scope();
			if (missing === 'policy') delete target.delegationPolicy;
			if (missing === 'manager')
				snapshot.owners = snapshot.owners.filter((o) => o.id !== 'manager');
			if (missing === 'feature') enabled = false;
			const before = fs.readFileSync(store.supervisorFilePath(), 'utf8');
			expect(await migrate(target, () => missing !== 'proof')).toMatchObject({
				status: 'NeedsConfiguration',
			});
			expect(fs.readFileSync(store.supervisorFilePath(), 'utf8')).toBe(before);
		}
	);

	it('refuses an unbound legacy manager handoff even when the old child can be fenced', async () => {
		await runWatchIteration(
			[
				{
					id: 'ask',
					role: 'assistant',
					source: 'ai',
					content: 'Should I name it count or total?',
					timestamp: '2026-11-04T10:00:00.000Z',
				},
			],
			{ agentId: 'owner', tabId: 'old' },
			initialWatchState(),
			{
				readRules: () => [],
				recordDecision: store.appendDecision,
				now: () => '2026-11-04T10:01:00.000Z',
				genId: () => 'old-handoff',
				log: vi.fn(),
				dispatch: async () => ({ success: true }),
				resolveProfile: () => ({
					projectPath: '/project',
					profile: 'Choose short variable names.',
					updatedAt: 1,
				}),
				requestJudgment: async () => ({ success: true }),
			},
			{ dryRun: false }
		);
		const before = store.readSupervisorTargets();
		expect(await migrate(scope(), () => true)).toMatchObject({
			status: 'NeedsConfiguration',
			reason: expect.stringContaining('old-handoff'),
		});
		expect(store.readSupervisorTargets()).toEqual(before);
	});

	it('baselines busy historical questions and retains the baseline and receipt across restart', async () => {
		snapshot.tabs[0].busy = true;
		await migrate(scope(), () => true);
		const checkpoint = store.readScopeCheckpoint(scopeId)!;
		expect(checkpoint.tabs).toHaveLength(4);
		expect(checkpoint.tabs.every((t) => t.baselineBusy === false)).toBe(true);
		const restored = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		expect(restored.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
		expect(await migrate()).toMatchObject({ status: 'already-migrated' });
	});

	it('saves a migrated scope label without rearming, changing its receipt or rebaselining', async () => {
		await migrate(scope(), () => true);
		await store.updateSupervisorTargetsAsync((targets) =>
			targets.map((target) => (target.id === scopeId ? { ...target, enabled: false } : target))
		);
		const before = store.readSupervisorTargets();
		const checkpoint = store.readScopeCheckpoint(scopeId);
		const changed = scope();
		changed.selection = { ...changed.selection!, label: 'Renamed' };
		snapshot.capturedAt++;
		expect(await migrate(changed, () => true)).toMatchObject({ status: 'already-migrated' });
		expect(store.readSupervisorTargets()).toEqual(
			before.map((target) =>
				target.id === scopeId
					? { ...target, selection: { ...target.selection!, label: 'Renamed' } }
					: target
			)
		);
		expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
	});

	it('recovers a crash after checkpoint preparation but before registry publication', async () => {
		const original = store.writeScopeCheckpoint;
		const failure = vi.spyOn(store, 'writeScopeCheckpoint').mockImplementation((checkpoint) => {
			original(checkpoint);
			throw new Error('crash');
		});
		await expect(migrate(scope(), () => true)).rejects.toThrow('crash');
		expect(ownership('old')).toEqual({ kind: 'explicit-watch' });
		expect(store.readSupervisorTargets().some((t) => t.kind === 'watch-scope')).toBe(false);
		failure.mockRestore();
		snapshot.capturedAt++;
		expect(await migrate(scope(), () => true)).toMatchObject({ status: 'migrated' });
	});

	it('serializes concurrent mutations and prevents a stale writer from resurrecting an old owner', async () => {
		await Promise.all([
			migrate(scope(), () => true),
			store.upsertSupervisorTargetAsync(legacy('unrelated', 'other')),
		]);
		expect(store.readSupervisorTargets().find((t) => t.id === 'unrelated')).toBeDefined();
		await store.upsertSupervisorTargetAsync(legacy());
		expect(store.readSupervisorTargets().find((t) => t.id === 'legacy')).toMatchObject({
			enabled: false,
			migratedToScopeId: scopeId,
		});
	});

	it.each(['accepted', 'unknown', 'human'] as const)(
		'composes real decision storage and delivery admission without replaying a legacy %s answer',
		async (outcome) => {
			const question = (id: string): PianolaMessage => ({
				id,
				role: 'assistant',
				source: 'ai',
				content: 'Should I name it count or total?',
				timestamp: '2026-11-04T10:00:00.000Z',
			});
			const history: PianolaMessage[] = [question('historical')];
			store.writeRules([
				{
					id: 'rule',
					enabled: true,
					scope: 'global',
					priority: 1,
					match: { kinds: ['question'], maxRisk: 'low' },
					action: 'auto_answer',
					answer: 'Use count.',
					createdAt: 1,
					updatedAt: 1,
				},
			]);
			let sequence = 0;
			const watch = {
				readRules: store.readRules,
				recordDecision: store.appendDecision,
				now: () => '2026-11-04T10:01:00.000Z',
				genId: () => `decision-${++sequence}`,
				log: vi.fn(),
			};
			if (outcome !== 'human') {
				await runWatchIteration(
					history,
					{ agentId: 'owner', tabId: 'old' },
					initialWatchState(),
					{
						...watch,
						dispatch: async () => {
							if (outcome === 'unknown') throw new Error('receipt lost after send');
							return { success: true };
						},
					},
					{ dryRun: false }
				).catch(() => undefined);
			} else
				history.push({
					id: 'human',
					role: 'user',
					source: 'user',
					content: 'Use total.',
					timestamp: '2026-11-04T10:00:01.000Z',
				});
			const updateCursor = () => {
				const last = history.at(-1)!;
				snapshot.tabs[0].cursor = {
					id: last.id,
					count: history.length,
					textLength: last.content.length,
				};
			};
			updateCursor();
			await migrate(scope(), () => true);
			// A pre-handover cycle may persist a stale suspended checkpoint later.
			const stale = store.readScopeCheckpoint(scopeId)!;
			stale.tabs[0].status = 'suspended';
			stale.tabs[0].baselineBusy = true;
			store.writeScopeCheckpoint(stale);
			const recordsBefore = store.readDecisions();
			const dispatch = vi.fn<PianolaScopeCycleDeps['dispatch']>(async (_target, answer, guard) => {
				admitPianolaScopeReply(guard, answer, snapshot, store);
				return { status: 'unknown', error: 'receipt lost' };
			});
			const deps: PianolaScopeCycleDeps = {
				store,
				watch,
				readSnapshot: async () => ({ ...snapshot, capturedAt: ++snapshot.capturedAt }),
				readTranscript: async (target) => ({
					...target,
					messages: target.tabId === 'old' ? history : [],
				}),
				dispatch,
			};
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(dispatch).not.toHaveBeenCalled();
			expect(store.readDecisions()).toEqual(recordsBefore);
			history.push(question('fresh'));
			updateCursor();
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(dispatch).toHaveBeenCalledOnce();
			await runPianolaScopeCycle(scopeId, deps, { dryRun: false });
			expect(dispatch).toHaveBeenCalledOnce();
			expect(
				store.readScopeCheckpoint(scopeId)!.tabs.find((t) => t.tabId === 'old')!.unresolvedIntent
			).toMatchObject({ messageId: 'fresh', admitted: true });
		}
	);

	it('keeps an existing scope paused and resolves overlapping groups to one owner', async () => {
		const existing = scope();
		existing.enabled = false;
		store.upsertSupervisorTarget(existing);
		await migrate(scope(), () => true);
		expect(store.readSupervisorTargets().find((t) => t.id === scopeId)?.enabled).toBe(false);
		expect(ownership('new')).toMatchObject({ kind: 'excluded', reason: 'disabled scope' });
		await store.updateSupervisorTargetsAsync((targets) =>
			targets.map((t) => (t.id === scopeId ? { ...t, enabled: true } : t))
		);
		snapshot.owners[0].groupId = 'group';
		store.upsertSupervisorTarget({
			...scope(),
			id: '22222222-2222-4222-8222-222222222222',
			createdAt: 2,
			selection: {
				label: 'Group',
				mode: 'agents-and-groups',
				agentIds: [],
				groupIds: ['group'],
				excludedAgentIds: [],
			},
		});
		expect(ownership('old')).toEqual({ kind: 'scope', scopeId });
	});
});
