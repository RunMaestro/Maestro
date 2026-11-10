import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { openBoardDb } from '../../../main/board/board-db';
import { configureBoardFeatures } from '../../../main/board/board-feature';
import {
	BoardStorageFacade,
	configureBoardStorage,
	getBoardStorage,
	configureBoardCaptureHost,
	listBoardWorkerAccessOptions,
	enqueueBoardWrite,
} from '../../../main/board/board-storage';
import {
	registerBoardWorker,
	listBoardWorkers,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';
import { planBoardMigration, applyBoardMigration } from '../../../main/board/board-migration';
import { configureIsolatedBoardSourceHost } from '../../../main/board/board-source-host';
import {
	acquireCueEngineLock,
	readCueEngineLock,
	isCueEngineLockOwnedByThisProcess,
	releaseCueEngineLock,
} from '../../../main/cue/cue-engine-lock';
import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockSession } from '../../helpers/mockSession';
import { BoardCueHost } from '../../../main/board/board-cue';
import { configureBoardRuntimeHost } from '../../../main/board/board-runtime-host';
import { executeBoardCommand } from '../../../main/board/board-command-host';
import { readBoardRunArtifact } from '../../../main/board/board-review';
import { BoardRegistryRevision } from '../../../main/board/board-registry-revision';
import { createMaestroRuntime, type MaestroRuntime } from '../../../shared/maestro-lib/runtime';
import { startRuntimeServer } from '../../../shared/maestro-lib/runtime/server';
import { BridgeConnection } from './fixtures/board-fixture-bridge';
import { resolveBoardLocation } from '../../../main/board/board-location';
import {
	prepareBoardRepositoryAccess,
	type BoardRepositoryAgent,
} from '../../../main/board/board-repository-access';
import { createHash } from 'node:crypto';
import { requestBoardCommand } from '../../../shared/maestro-lib/client/board';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../../shared/board/types';
import {
	configureAgentAdmission,
	hasHeadlessAgentActivity,
} from '../../../main/utils/headless-agent-activity';
import { createBoardAgentAdmission } from '../../../main/board/board-claims';
import { runProcess } from '../../../main/cue/cue-process-lifecycle';
import { prepareBoardReviewHandoff } from '../../../main/board/board-review';
import { snapshotSqlite, compareSqliteSnapshots } from '../../helpers/sqliteSnapshot';
import {
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
	onTestFailed,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import * as sentry from '../../../main/utils/sentry';
import { build } from 'esbuild';
import { promisify } from 'node:util';
import { canonicalJson } from '../../../shared/canonicalJson';

const fixture = createBoardIsolationFixture({ syncInUserData: true, privateHome: true });
beforeAll(() => fixture.install());
afterAll(async () => fixture.cleanup());
let runSignal: AbortSignal;
const inFlightRuns = new Set<Promise<Record<string, unknown>>>();
beforeEach(({ signal }) => {
	runSignal = signal;
});
afterEach(async () => {
	// Vitest aborts timed-out test contexts, but does not await their bodies.
	// Join actual fixture finalizers before the next case reuses this DB/root.
	await Promise.allSettled([...inFlightRuns]);
	expect(inFlightRuns.size).toBe(0);
});
function run(mode: string, signal = runSignal): Promise<Record<string, unknown>> {
	signal.throwIfAborted();
	const pending = runOwned(mode, signal).then((value) => {
		signal.throwIfAborted();
		return value;
	});
	inFlightRuns.add(pending);
	void pending.then(
		() => inFlightRuns.delete(pending),
		() => inFlightRuns.delete(pending)
	);
	return pending;
}
async function runOwned(mode: string, signal: AbortSignal): Promise<Record<string, unknown>> {
	const c = fixture.contract;
	let engine: CueEngine | undefined;
	let cue: BoardCueHost | undefined;
	const hostRequests = new Set<Promise<unknown>>();
	const beganAt = performance.now();
	const stages: { setupMs?: number; reopenMs?: number; cleanupMs?: number; aborted?: boolean } = {};
	const timings: { action: string; ms: number }[] = [];
	onTestFailed(() =>
		console.info(
			'[board-owned-fixture-lifecycle]',
			JSON.stringify({
				mode,
				requests: timings,
				stages,
				hostRequests: hostRequests.size,
				dbOpen: db?.open,
			})
		)
	);
	let ownedRuntime: MaestroRuntime | undefined;
	let cueJobCalls = 0;
	const root = fixture.sources.one;
	const executionBoardId = mode === 'sixteen' ? 'maestro-global' : 'analysis';
	let db: ReturnType<typeof openBoardDb> | undefined,
		server: Awaited<ReturnType<typeof startRuntimeServer>> | undefined,
		client: Parameters<typeof requestBoardCommand>[0] | undefined;
	const disconnectOnAbort = () => client?.disconnect();
	signal.addEventListener('abort', disconnectOnAbort, { once: true });
	const request = async (command: Parameters<typeof requestBoardCommand>[1]) => {
		signal.throwIfAborted();
		const startedAt = performance.now();
		try {
			const reply = await requestBoardCommand(client!, command);
			signal.throwIfAborted();
			return reply;
		} catch (error) {
			signal.throwIfAborted();
			throw error;
		} finally {
			timings.push({ action: command.action, ms: performance.now() - startedAt });
		}
	};
	const gitEnvironment = Object.fromEntries(
		['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'].map((key) => [key, process.env[key]])
	);
	const evidence: Record<string, unknown> = {};
	let releaseBarrier = () => {};
	let restoreStat = () => {};
	let restoreFence = () => {};
	const reported: { error: unknown; context: unknown }[] = [];
	// Isolate only the external diagnostic sink; native authority/process guards stay real.
	const report = vi.spyOn(sentry, 'captureException').mockImplementation(async (error, context) => {
		reported.push({ error, context });
	});
	const fault = Object.assign(new Error('owned-native-fence-fault'), {
		code: mode.includes('missing')
			? 'ENOENT'
			: mode.includes('denied')
				? 'EACCES'
				: mode.includes('-io-')
					? 'EIO'
					: undefined,
	});
	const injectFenceFault = () => {
		const native = fs.realpathSync.native;
		fs.realpathSync.native = ((...args: Parameters<typeof native>) => {
			if (String(args[0]) === path.join(root, '.git', 'config')) throw fault;
			return native(...args);
		}) as typeof native;
		restoreFence = () => {
			fs.realpathSync.native = native;
		};
		evidence.injectedFault = fault;
	};
	let background: Promise<unknown> | undefined;
	let pendingCapture: Promise<unknown> | undefined;
	try {
		const git = (...args: string[]) =>
			execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
		fs.mkdirSync(root, { recursive: true });
		git('init', '--quiet');
		git('config', 'user.name', 'Owned Fixture');
		git('config', 'user.email', 'fixture@example.test');
		fs.writeFileSync(path.join(root, 'analysis.txt'), 'initial');
		git('add', 'analysis.txt');
		git('commit', '--quiet', '-m', 'initial');
		const features = { board: true, maestroCue: true };
		configureBoardFeatures({ get: () => features });
		db = openBoardDb(c.db);
		const storage = new BoardStorageFacade(db);
		configureAgentAdmission(
			createBoardAgentAdmission(
				{ get: () => features },
				() => db!,
				(error) => {
					evidence.admissionError = String(error);
				},
				() => (db?.open ? db : undefined)
			)
		);
		configureBoardStorage(storage);
		const agent: BoardRepositoryAgent & { cwd: string; dir: string; projectRoot: string } = {
			id: 'owned-worker',
			dir: root,
			cwd: root,
			projectRoot: root,
			groupId: 'owned-group',
		};
		const reviewer = { ...agent, id: 'owned-reviewer' };
		const agents = [agent, reviewer, { ...agent, id: 'ordinary-free' }];
		if (mode === 'git-environment') {
			const nested = path.join(root, 'nested');
			execFileSync('git', ['init', '--quiet', nested]);
			fs.writeFileSync(path.join(root, '.gitignore'), 'nested/\n');
			git('add', '.gitignore');
			git('commit', '--quiet', '-m', 'ignore nested fixture');
			agent.cwd = nested;
		}
		if (mode === 'missing-cwd') agent.cwd = '';
		if (mode === 'ssh') agent.sshRemoteId = 'owned-remote';
		if (mode === 'invalid-location') {
			agent.sshRemoteId = 'owned-remote';
			agent.sessionSshRemoteConfig = { enabled: true, remoteId: 'different-remote' };
		}
		if (mode === 'foreign' || mode === 'same-url' || mode === 'foreign-grant') {
			const other = fixture.sources.two;
			execFileSync('git', ['init', '--quiet', other]);
			agent.cwd = other;
			if (mode === 'same-url') {
				git('remote', 'add', 'origin', 'https://example.invalid/identical');
				execFileSync('git', [
					'-C',
					other,
					'remote',
					'add',
					'origin',
					'https://example.invalid/identical',
				]);
			}
		}

		if (mode === 'worktree') {
			fs.rmSync(fixture.sources.two, { recursive: true, force: true });
			git('worktree', 'add', '--quiet', '-b', 'owned-worktree', fixture.sources.two);
			agent.cwd = fixture.sources.two;
		}
		if (mode === 'alias' || mode === 'retarget-before-launch') {
			const alias = path.join(fixture.sources.two, 'alias');
			fs.mkdirSync(fixture.sources.two, { recursive: true });
			fs.symlinkSync(root, alias, 'junction');
			agent.cwd = alias;
		}
		configureBoardCaptureHost(() => ({ agents, groups: [{ id: 'owned-group' }] }));
		if (!sourceConfigured) {
			configureIsolatedBoardSourceHost(c);
			sourceConfigured = true;
		}
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: root },
			repository: { id: 'owned-repository', workingDirectory: root, validated: true },
			boardBytes: Buffer.from(
				JSON.stringify({
					boards: [
						{ id: 'analysis', name: 'Owned analysis', defaultStartMode: 'direct', cards: [] },
					],
				})
			),
			profileBytes: null,
			workers: [],
		});
		applyBoardMigration(db, plan);
		if (mode === 'worktree') {
			applyBoardMigration(
				db,
				planBoardMigration({
					source: { location: { kind: 'local' }, path: fixture.sources.two },
					repository: {
						id: 'worktree-repository',
						workingDirectory: fixture.sources.two,
						validated: true,
					},
					profileBytes: null,
					workers: [],
					boardBytes: Buffer.from(
						JSON.stringify({ boards: [{ id: 'worktree', name: 'Worktree Board', cards: [] }] })
					),
				})
			);
		}
		registerBoardWorker(db, agent.id);
		registerBoardWorker(db, reviewer.id);
		if (mode === 'worktree') {
			const options = await listBoardWorkerAccessOptions();
			expect(options.repositoryGroups).toEqual([
				expect.objectContaining({
					repositoryIds: ['owned-repository', 'worktree-repository'],
					ownWorkerIds: expect.arrayContaining([agent.id]),
				}),
			]);
		}

		const worker = listBoardWorkers(db).find((w) => w.agentId === agent.id)!;
		assert.deepEqual(worker.payload.allowedRepositoryIds, []);
		assert.equal(worker.payload.accessManaged, undefined);
		if (mode === 'own-engine') {
			engine = new CueEngine({
				getSessions: () =>
					agents.map((agent) =>
						createMockSession({
							id: agent.id,
							groupId: agent.groupId ?? undefined,
							toolType: 'opencode',
							cwd: agent.cwd,
							projectRoot: agent.projectRoot,
						})
					),
				onCueRun: async () => {
					cueJobCalls++;
					throw new Error('No Cue job or provider is admitted in this fixture');
				},
				onLog: () => {},
			});
			await engine.start('user-toggle');
			assert.equal(engine.isEnabled(), true);
			evidence.cueBootstrap = {
				enabled: engine.isEnabled(),
				nativeLockHeld:
					!!readCueEngineLock(c.userData) &&
					isCueEngineLockOwnedByThisProcess(readCueEngineLock(c.userData)!),
				providerOrCueJobCalls: cueJobCalls,
			};
		} else assert.equal(acquireCueEngineLock('desktop', c.userData).acquired, true);
		const lock = readCueEngineLock(c.userData)!;
		assert.equal(isCueEngineLockOwnedByThisProcess(lock), true);
		if (mode === 'paused') setBoardWorkerPaused(db, agent.id, true);
		if (mode === 'foreign-grant') setBoardWorkerAccess(db, agent.id, [], ['owned-repository']);
		const revision = new BoardRegistryRevision();
		let started = 0;
		const pids: number[] = [];
		if (mode === 'restricted')
			db.prepare('UPDATE workers SET payload_json=? WHERE agent_id=?').run(
				canonicalJson({ allowedRepositoryIds: [], roleRefs: [], accessManaged: true }),
				agent.id
			);
		cue = new BoardCueHost({
			storage: () => storage,
			lock: () => {
				const held = readCueEngineLock(c.userData);
				if (!held || !isCueEngineLockOwnedByThisProcess(held)) return null;
				return {
					// Cue token/PID/namespace are native. Other OS host-proof branches use an explicit trusted fixture, never a live desktop probe.
					info: {
						...lock,
						mode: 'desktop' as const,
						platform: process.platform,
						...(process.platform === 'win32' || process.platform === 'darwin'
							? { hostIdentity: 'isolated-fixture:' + c.identity }
							: {}),
					},
					verify: () => {
						const current = readCueEngineLock(c.userData);
						return current !== null &&
							current.token === lock.token &&
							isCueEngineLockOwnedByThisProcess(current)
							? { ok: true as const }
							: { ok: false as const, reason: 'owner-conflict' };
					},
				};
			},
			prepare: async (key) => ({
				repository: {
					id: 'owned-repository',
					workingDirectory: root,
					record: { id: 'owned-repository', workingDirectory: root, validated: true },
					location: { kind: 'local' },
					identity: canonicalJson(await readBoardRunArtifact(root)),
				},
				reviewArtifact: await (async () => {
					const card = storage.workspace
						.readCollection(key)
						?.cards.find((card) => card.cardId === key.cardId)?.payload;
					return card?.reviewHandoff
						? prepareBoardReviewHandoff(
								storage,
								card.reviewHandoff as import('../../../shared/board/types').BoardReviewHandoff
							)
						: null;
				})(),
			}),
			context: (_key, prepared) => ({
				...prepared,
				dispatchEnabled:
					features.board && features.maestroCue && (engine ? engine.isEnabled() : true),
				registryRevision: revision.observe({
					agents,
					workers: listBoardWorkers(db!),
					catalog: storage.captureCatalog(),
				}),
				agentStates: Object.fromEntries(
					agents.map((agent) => [
						agent.id,
						{
							live: true,
							busy: hasHeadlessAgentActivity(agent.id),
							location: resolveBoardLocation(agent),
							cwd: agent.cwd,
						},
					])
				),
			}),
			service: {
				spawn: async (spec, callbacks) => {
					if (!callbacks.canPrepare())
						return { output: '', exitCode: null, executionStarted: false };

					const ordinary = (id: string, agentId: string) =>
						runProcess(
							id,
							{
								command: process.execPath,
								args: ['-e', "process.stdout.write('owned ordinary control')"],
								cwd: root,
								env: process.env as Record<string, string>,
							},
							{ agentId, toolType: 'opencode', timeoutMs: 5000, onLog: () => {} }
						);
					const held = await ordinary('unrelated-run-id', spec.workerAgentId);
					expect(held.executionStarted).toBe(false);
					const free = await ordinary('ordinary-control', 'ordinary-free');
					expect(free.executionStarted).toBe(true);
					expect(free.terminationConfirmed).toBe(true);
					evidence.nativeCapacityControls = {
						heldWorkerRefused: held.executionStarted === false,
						freeOrdinaryStarted: free.executionStarted === true,
						freeOrdinaryTerminated: free.terminationConfirmed === true,
					};
					const artifactBase = await readBoardRunArtifact(root);
					assert.ok(artifactBase);
					const review = spec.card.kind === 'review';
					const handoff = spec.card.reviewHandoff as
						| import('../../../shared/board/types').BoardReviewHandoff
						| undefined;
					const code = review
						? `require('node:child_process').execFileSync('git',['diff','--check',${JSON.stringify(handoff?.artifact.diff?.baseCommit)},'HEAD']); process.stdout.write('<!-- maestro:card-complete | Bound diff reviewed; checks passed -->');`
						: `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('analysis.txt','Analysis complete; implementation requires a separate human decision.');cp.execFileSync('git',['add','analysis.txt']);cp.execFileSync('git',['commit','--quiet','-m','analysis']);process.stdout.write('<!-- maestro:card-complete | Analysis committed; fixture check passed -->');`;
					const result = await runProcess(
						spec.runToken.runId,
						{
							command: process.execPath,
							args: ['-e', code],
							cwd: root,
							env: process.env as Record<string, string>,
						},
						{
							agentId: spec.workerAgentId,
							toolType: 'opencode',
							timeoutMs: 5000,
							onLog: () => {},
							beforeLaunch: () => {
								if (mode === 'move-before-launch') agent.cwd = fixture.sources.two;
								if (mode === 'group-before-launch') agent.groupId = 'different-group';
								if (mode === 'git-retarget-before-launch') {
									fs.renameSync(path.join(root, '.git'), path.join(c.root, 'saved-git'));
									execFileSync('git', ['init', '--quiet', root]);
								}
								if (mode === 'unregistered-before-launch') agents.splice(0, 1);
								if (mode === 'retarget-before-launch') {
									fs.unlinkSync(agent.cwd);
									fs.symlinkSync(fixture.sources.two, agent.cwd, 'junction');
								}
								if (mode.startsWith('fence-') && mode.endsWith('-launch')) injectFenceFault();
								try {
									return callbacks.beforeLaunch();
								} catch (error) {
									evidence.launchFault = error;
									throw error;
								}
							},
							onStarted: (pid) => {
								started++;
								if (pid !== undefined) pids.push(pid);
								callbacks.onStarted(pid);
							},
						}
					);
					evidence.nativeCompletion = {
						pidReceipt: started,
						exitCode: result.exitCode,
						executionStarted: result.executionStarted,
						terminationConfirmed: result.terminationConfirmed,
					};
					if (mode === 'fence-unexpected-result') injectFenceFault();
					return {
						artifactBase,
						output: result.stdout,
						exitCode: result.exitCode,
						executionStarted: result.executionStarted,
						terminationConfirmed: result.terminationConfirmed,
						artifact:
							(await readBoardRunArtifact(
								root,
								handoff?.artifact.diff?.baseCommit ?? artifactBase.commit
							)) ?? undefined,
					};
				},
				stop() {},
				probe: () => 'unknown',
			},
			ownerLiveness: () => 'unknown',
			onWait: () => {},
		});
		configureBoardRuntimeHost(cue.runtimeFor);
		const runtime = await createMaestroRuntime({
			dataDir: c.userData,
			mode: 'host',
			deps: { watchDirectory: () => ({ close() {} }) },
		});
		if (!runtime.ok) throw Error(runtime.refusal.message);
		ownedRuntime = runtime.runtime;
		server = await startRuntimeServer({
			runtime: runtime.runtime,
			token: 'owned-repo',
			cliSecret: 'owned-fixture-secret',
			boardHost: async (command) => {
				const pending = executeBoardCommand(command);
				hostRequests.add(pending);
				try {
					return await pending;
				} catch (error) {
					evidence.hostFault = error;
					throw error;
				} finally {
					hostRequests.delete(pending);
				}
			},
			onStopRequested() {},
		});
		const manifestPath = path.join(c.userData, 'endpoint.json');
		const manifest = canonicalJson({
			version: 1,
			identity: c.identity,
			ownerPid: process.pid,
			url: `ws://127.0.0.1:${server.port}/owned-repo/ws`,
			cliSecret: 'owned-fixture-secret',
		});
		fs.writeFileSync(manifestPath, manifest, { mode: 0o600 });
		client = new BridgeConnection({
			fixture: {
				contract: c,
				manifestPath,
				manifestSha256: createHash('sha256').update(manifest).digest('hex'),
				ownerPid: process.pid,
			},
			strictReplies: true,
			// Parent-admitted fixture implements the canonical public connection surface.
		}) as unknown as Parameters<typeof requestBoardCommand>[0];
		signal.throwIfAborted();
		await client.connect();
		signal.throwIfAborted();
		stages.setupMs = performance.now() - beganAt;
		if (mode === 'sixteen') storage.ensureGlobalBoard();
		let collection = storage
			.query()
			.collections.find((entry) => entry.board.id === executionBoardId)!;
		const capture = await request({
			action: 'capture',
			target: {
				projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
				sourceKey: collection.sourceKey,
				collectionKey: collection.collectionKey,
				expectedRevision: collection.revision,
			},
			capture: {
				projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
				boardId: executionBoardId,
				expectedRevision: collection.revision,
				card: {
					id: 'owned-analysis',
					title: 'Synthetic analysis',
					body: 'Analyse; stop for a human decision.',
					status: 'todo',
					parents: [],
					createdAt: '2026-11-09',
					updatedAt: '2026-11-09',
					executionScope: { kind: 'group', groupId: 'owned-group' },
					assigneeAgentId: agent.id,
					reviewerAgentId: reviewer.id,
					repositoryId: 'owned-repository',
					workingDirectory: root,
				},
			},
		});
		assert.equal(capture.ok, true, JSON.stringify(capture));
		if (mode === 'proof-pause') {
			const before = snapshotSqlite(db);
			const nativeRealpath = fs.promises.realpath;
			const nativeStat = fs.promises.stat;
			let reached!: () => void;
			const waiting = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const barrier = new Promise<void>((resolve) => {
				releaseBarrier = resolve;
			});
			let afterPauseIO = 0;
			fs.promises.realpath = (async (...args: Parameters<typeof nativeRealpath>) => {
				if (!features.board) afterPauseIO++;
				const result = await nativeRealpath(...args);
				reached();
				await barrier;
				return result;
			}) as typeof nativeRealpath;
			fs.promises.stat = (async (...args: Parameters<typeof nativeStat>) => {
				if (!features.board) afterPauseIO++;
				return nativeStat(...args);
			}) as typeof nativeStat;
			restoreStat = () => {
				fs.promises.realpath = nativeRealpath;
				fs.promises.stat = nativeStat;
			};
			const proof = prepareBoardRepositoryAccess([agent], storage.captureCatalog().repositories);
			await waiting;
			features.board = false;
			releaseBarrier();
			await expect(proof).rejects.toThrow('BoardDisabled');
			expect(afterPauseIO).toBe(0);
			expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
			return { paused: true, noFurtherIO: true };
		}

		if (mode === 'crud-barrier') {
			const other = fixture.sources.two;
			fs.mkdirSync(other, { recursive: true });
			execFileSync('git', ['init', '--quiet', other]);
			applyBoardMigration(
				db,
				planBoardMigration({
					source: { location: { kind: 'local' }, path: other },
					repository: { id: 'other-repository', workingDirectory: other, validated: true },
					workers: [],
					profileBytes: null,
					boardBytes: Buffer.from(
						JSON.stringify({ boards: [{ id: 'other', name: 'Other board', cards: [] }] })
					),
				})
			);
			collection = storage
				.query()
				.collections.find((entry) => entry.board.id === executionBoardId)!;
			const target = () => {
				const current = storage.workspace.readCollection(collection)!;
				return {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + current.sourceKey,
					sourceKey: current.sourceKey,
					collectionKey: current.collectionKey,
					expectedRevision: current.revision,
				};
			};
			const original = storage.workspace.readCollection(collection)!.cards[0];
			const originalCard = {
				...original.payload,
				storageRevision: original.revision,
			} as unknown as import('../../../shared/board/types').BoardCard;
			const unrelated = await request({
				action: 'capture',
				target: target(),
				capture: {
					projectRoot: target().projectRoot,
					boardId: executionBoardId,
					expectedRevision: target().expectedRevision,
					card: {
						id: 'unrelated-analysis',
						title: 'Unrelated analysis',
						body: 'Independent analysis, with a human decision stop.',
						parents: [],
						createdAt: '2026-11-09',
						updatedAt: '2026-11-09',
						executionScope: { kind: 'group', groupId: 'owned-group' },
						repositoryId: 'other-repository',
						workingDirectory: other,
						status: 'triage',
					},
				},
			});
			expect(unrelated.ok, JSON.stringify(unrelated)).toBe(true);
			const nativeStat = fs.promises.stat;
			let targetProbe!: () => void;
			const targetWaiting = new Promise<'diagnostic-dependency'>((resolve) => {
				targetProbe = () => resolve('diagnostic-dependency');
			});
			let probes = 0;
			let reached!: () => void;
			const waiting = new Promise<void>((resolve) => {
				reached = resolve;
			});
			let released = false;
			const barrier = new Promise<void>((resolve) => {
				releaseBarrier = () => {
					released = true;
					resolve();
				};
			});
			fs.promises.stat = (async (...args: Parameters<typeof nativeStat>) => {
				const value = await nativeStat(...args);
				if (String(args[0]) === other) {
					probes++;
					if (probes > 1) targetProbe();
					reached();
					await barrier;
				}
				return value;
			}) as typeof nativeStat;
			restoreStat = () => {
				fs.promises.stat = nativeStat;
			};
			background = storage.queryAsync({
				projectRoot: target().projectRoot,
				sourceKey: collection.sourceKey,
			});
			await waiting;
			const saving = requestBoardCommand(client, {
				action: 'capture',
				target: target(),
				capture: {
					projectRoot: target().projectRoot,
					boardId: executionBoardId,
					expectedRevision: target().expectedRevision,
					card: {
						...originalCard,
						body: 'Updated exact target while unrelated diagnostics are pending.',
					},
				},
			});
			pendingCapture = saving;
			const winner = await Promise.race([
				saving.then((reply) => ({ kind: 'reply' as const, reply })),
				targetWaiting.then((kind) => ({ kind })),
			]);
			expect(winner.kind).toBe('reply');
			if (winner.kind !== 'reply') throw new Error('unreachable');
			expect(winner.reply.ok, JSON.stringify(winner.reply)).toBe(true);
			expect(released).toBe(false);
			expect(
				storage.workspace
					.readCollection(collection)!
					.cards.find((card) => card.cardId === 'owned-analysis')!.payload.body
			).toBe('Updated exact target while unrelated diagnostics are pending.');
			return { ackWhileUnrelatedDiagnosticPending: true };
		}

		if (mode === 'sixteen') {
			const initial = storage.workspace.readCollection(collection)!;
			const catalogue = await request({
				action: 'query',
				query: {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
					sourceKey: collection.sourceKey,
				},
			});
			expect(catalogue.ok).toBe(true);
			const protectedBefore = snapshotSqlite(db);
			const latencies: number[] = [];
			for (let i = 1; i < 16; i++) {
				collection = storage
					.query()
					.collections.find((entry) => entry.board.id === executionBoardId)!;
				const startedAt = performance.now();
				const result = await request({
					action: 'capture',
					target: {
						projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
						sourceKey: collection.sourceKey,
						collectionKey: collection.collectionKey,
						expectedRevision: collection.revision,
					},
					capture: {
						projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
						boardId: executionBoardId,
						expectedRevision: collection.revision,
						card: {
							id: `synthetic-issue-${i}`,
							title: `Synthetic issue ${i}`,
							body: 'Read the complete issue. Analyse current behavior and dependencies. Report evidence and choices. Stop for a human decision before implementation.',
							status: i < 3 ? 'todo' : 'triage',
							parents: [],
							createdAt: '2026-11-09',
							updatedAt: '2026-11-09',
							executionScope: { kind: 'group', groupId: 'owned-group' },
							assigneeAgentId: agent.id,
							reviewerAgentId: reviewer.id,
							repositoryId: 'owned-repository',
							workingDirectory: root,
						},
					},
				});
				expect(result.ok).toBe(true);
				latencies.push(performance.now() - startedAt);
			}
			const selected = storage
				.query()
				.collections.find((entry) => entry.board.id === executionBoardId)!;
			const refusal = await request({
				action: 'tick',
				operationId: 'synthetic-approval-stop',
				target: {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + selected.sourceKey,
					sourceKey: selected.sourceKey,
					collectionKey: selected.collectionKey,
					expectedRevision: selected.revision,
				},
			});
			expect(refusal).toMatchObject({
				ok: true,
				value: expect.arrayContaining([
					expect.objectContaining({ ok: false, reason: 'approval-required' }),
				]),
			});
			await cue.settle();
			expect(started).toBe(0);
			const before = snapshotSqlite(db);
			signal.throwIfAborted();
			const reopenAt = performance.now();
			db.close();
			db = openBoardDb(c.db);
			stages.reopenMs = performance.now() - reopenAt;
			expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
			const reopened = new BoardStorageFacade(db).workspace.readCollection(selected)!;
			expect(reopened.cards).toHaveLength(16);
			expect(reopened.sourceKey).toBe(initial.sourceKey);
			expect(reopened.collectionKey).toBe(initial.collectionKey);
			for (const name of ['repositories', 'workers', 'migrations', 'board_source_locations'])
				expect(before[name]).toEqual(protectedBefore[name]);
			return { cardCount: reopened.cards.length, latencies, started, reopenPreserved: true };
		}

		collection = storage.query().collections.find((entry) => entry.board.id === executionBoardId)!;

		if (mode.startsWith('off-')) {
			const before = snapshotSqlite(db);
			features.board = mode === 'off-cue';
			features.maestroCue = mode === 'off-board';
			const disabled = await request({
				action: 'tick',
				operationId: 'off-native-intake',
				target: {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					expectedRevision: collection.revision,
				},
			});
			expect(disabled).toMatchObject({
				type: 'error',
				success: false,
				error: expect.stringMatching(/BoardDisabled|CueDisabled/),
			});
			expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
			expect(started).toBe(0);
			return { off: true, unchanged: true };
		}
		if (mode === 'git-environment') {
			process.env.GIT_DIR = path.join(root, '.git');
			process.env.GIT_WORK_TREE = root;
		}
		if (mode === 'no-native-cue-lock') releaseCueEngineLock(c.userData);
		if (mode === 'unknown-owner')
			db.prepare('INSERT INTO runtime_owner VALUES (1,?,?,?)').run(
				'historical-unproven-owner',
				1,
				0
			);
		const cardsBeforeTick = canonicalJson(
			db.prepare('SELECT * FROM cards ORDER BY collection_key,id').all()
		);
		if (mode.startsWith('fence-') && mode.endsWith('-claim')) injectFenceFault();
		let reply: import('../../../shared/board/commands').BoardCommandReply | undefined;
		if (mode === 'own-cli') {
			const bundle = path.join(c.root, 'own-repository-cli.cjs');
			const fixtureBridge = path.resolve(
				'src/__tests__/main/board/fixtures/board-fixture-bridge.ts'
			);
			const admission = {
				contract: c,
				manifestPath,
				manifestSha256: createHash('sha256').update(manifest).digest('hex'),
				ownerPid: process.pid,
			};
			await build({
				entryPoints: ['src/cli/index.ts'],
				outfile: bundle,
				bundle: true,
				platform: 'node',
				format: 'cjs',
				packages: 'external',
				plugins: [
					{
						name: 'admitted-fixture-cli',
						setup(builder) {
							builder.onResolve({ filter: /(?:^|\/)bridge-connection$/ }, (args) => {
								if (args.importer === fixtureBridge) return;
								return path.resolve(args.resolveDir, args.path) + '.ts' ===
									path.resolve('src/shared/maestro-lib/client/bridge-connection.ts')
									? { path: 'fixture', namespace: 'owned-bridge' }
									: undefined;
							});
							builder.onLoad({ filter: /.*/, namespace: 'owned-bridge' }, () => ({
								contents: `import {admitFixtureBridge} from ${JSON.stringify(fixtureBridge)};admitFixtureBridge(${JSON.stringify(admission)});export * from ${JSON.stringify(fixtureBridge)};`,
								loader: 'ts',
								resolveDir: c.worktree,
							}));
						},
					},
				],
			});
			const execution = await promisify(execFile)(
				process.execPath,
				[
					bundle,
					'board',
					'tick',
					'--board',
					'analysis',
					'--source',
					collection.sourceKey,
					'--collection',
					collection.collectionKey,
					'--revision',
					String(collection.revision),
					'--json',
				],
				{ cwd: c.worktree, env: process.env, timeout: 10000 }
			);
			const summary = JSON.parse(execution.stdout);
			evidence.cli = { type: summary.type, boards: summary.boards };
			expect(summary.boards[0].accepted).toBe(1);
		} else {
			reply = await request({
				action: 'tick',
				operationId: 'owned-default-access',
				target: {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					expectedRevision: collection.revision,
				},
			});
		}
		await cue.settle();
		restoreFence();
		evidence.cardsUnchanged =
			cardsBeforeTick ===
			canonicalJson(db.prepare('SELECT * FROM cards ORDER BY collection_key,id').all());
		evidence.reportedFaults = reported;
		evidence.runRows = db.prepare('SELECT lifecycle_json,outcome_json FROM runs').all();
		if (['own', 'own-cli', 'own-engine', 'worktree', 'alias', 'foreign-grant'].includes(mode)) {
			collection = storage
				.query()
				.collections.find((entry) => entry.board.id === executionBoardId)!;
			const reviewReply = await request({
				action: 'tick',
				operationId: 'owned-review',
				target: {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					expectedRevision: collection.revision,
				},
			});
			evidence.reviewReply = reviewReply;
			await cue.settle();
		}
		evidence.card = storage
			.query()
			.collections.find((entry) => entry.board.id === executionBoardId)!.board?.cards;
		evidence.reply = reply;
		if (engine) {
			expect(cueJobCalls).toBe(0);
			console.info(
				'[board-owned-cue-bootstrap]',
				JSON.stringify({ ...(evidence.cueBootstrap as object), providerOrCueJobCalls: cueJobCalls })
			);
		}
		evidence.started = started;
		evidence.pids = pids;
		evidence.workerDefault = worker.payload;
		evidence.owner = db.prepare('SELECT * FROM runtime_owner').all();
		evidence.runs = db.prepare('SELECT count(*) AS n FROM runs').get();
		evidence.reservations = db.prepare('SELECT count(*) AS n FROM reservations').get();
		if (mode === 'own-cli') {
			const rows = db
				.prepare('SELECT run_id, lifecycle_json, outcome_json FROM runs ORDER BY run_id')
				.all() as { run_id: string; lifecycle_json: string; outcome_json: string | null }[];
			expect(rows).toHaveLength(2);
			expect(rows.every((row) => row.outcome_json !== null)).toBe(true);
			console.info(
				'[board-owned-native-receipts]',
				JSON.stringify({
					mode,
					pids,
					completedRuns: rows.map((row) => ({
						runId: row.run_id,
						phase: JSON.parse(row.lifecycle_json).phase,
						outcomeSha256: createHash('sha256').update(row.outcome_json!).digest('hex'),
					})),
					capacityControls: evidence.nativeCapacityControls,
					completion: evidence.nativeCompletion,
					remainingReservations: evidence.reservations,
					workState: (evidence.card as { id: string; status: string }[]).find(
						(card) => card.id === 'owned-analysis'
					)?.status,
				})
			);
		}
		evidence.nativeGit = {
			root: git('rev-parse', '--show-toplevel'),
			commonDir: git('rev-parse', '--git-common-dir'),
		};
		signal.throwIfAborted();
		return evidence;
	} finally {
		const cleanupAt = performance.now();
		stages.aborted = signal.aborted;
		releaseBarrier();
		await background;
		await pendingCapture;
		if (background && db?.open) await enqueueBoardWrite(root, () => {});
		for (const [key, value] of Object.entries(gitEnvironment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		signal.removeEventListener('abort', disconnectOnAbort);
		client?.disconnect();
		await server?.close();
		// Closing sockets alone does not join asynchronous command handlers.
		await Promise.allSettled([...hostRequests]);
		await cue?.settle();
		await ownedRuntime?.connection.close();
		engine?.stop();
		releaseCueEngineLock(c.userData);
		report.mockRestore();
		restoreFence();
		restoreStat();
		db?.close();
		for (const suffix of ['', '-wal', '-shm']) fs.rmSync(c.db + suffix, { force: true });
		for (const source of Object.values(fixture.sources))
			fs.rmSync(source, { recursive: true, force: true });
		stages.cleanupMs = performance.now() - cleanupAt;
	}
}
let sourceConfigured = false;
it.each(['own', 'own-cli', 'own-engine', 'worktree', 'alias', 'foreign-grant'])(
	'default %s Git repository crosses authenticated WS, claim, real native completion and review, then stops for a human',
	async (mode) => {
		const result = await run(mode);
		expect(result.started).toBe(2);
		expect(result.pids).toEqual([expect.any(Number), expect.any(Number)]);
		expect(result.reservations).toEqual({ n: 0 });
		expect(result.nativeCompletion).toMatchObject({
			executionStarted: true,
			terminationConfirmed: true,
			exitCode: 0,
		});
		expect(result.card).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'owned-analysis', status: 'ready-for-human' }),
			])
		);
	}
);
it.each([
	'foreign',
	'restricted',
	'same-url',
	'ssh',
	'invalid-location',
	'git-environment',
	'missing-cwd',
])('refuses %s without starting a native child', async (mode) => {
	const result = await run(mode);
	expect(result.started).toBe(0);
	expect(result.runs).toEqual({ n: 0 });
	expect(result.reservations).toEqual({ n: 0 });
	expect(result.reply).toMatchObject({
		value: [{ ok: false, reason: 'worker-repository-mismatch' }],
	});
});
it.each([
	'move-before-launch',
	'retarget-before-launch',
	'git-retarget-before-launch',
	'unregistered-before-launch',
	'group-before-launch',
])('revokes own-repository admission at %s before final launch', async (mode) => {
	const result = await run(mode);
	expect(result.started).toBe(0);
	expect(result.nativeCompletion).toMatchObject({ executionStarted: false });
});

it('reports the missing native Cue owner instead of attributing runtime refusal to repository access', async () => {
	const result = await run('no-native-cue-lock');
	expect(result.started).toBe(0);
	expect(result.reply).toMatchObject({
		ok: false,
		error: { code: 'runtime-unavailable', message: expect.stringContaining('native Cue') },
	});
});
it('reports an unproven existing Board owner without taking over or starting', async () => {
	const result = await run('unknown-owner');
	expect(result.started).toBe(0);
	expect(result.reply).toMatchObject({ ok: false, error: { code: 'owner-conflict' } });
	expect(result.owner).toEqual([
		{ id: 1, process_identity: 'historical-unproven-owner', epoch: 1, heartbeat: 0 },
	]);
});

it('captures sixteen complete synthetic analysis requests over WS, preserves approval stops and reopens without logical mutation', async () => {
	const evidence = await run('sixteen');
	expect(evidence).toMatchObject({ cardCount: 16, started: 0, reopenPreserved: true });
});

it('acknowledges durable exact-target capture while unrelated repository diagnostics remain pending', async () => {
	expect(await run('crud-barrier')).toMatchObject({ ackWhileUnrelatedDiagnosticPending: true });
});

it.each(['off-both', 'off-board', 'off-cue'])(
	'preserves SQLite and refuses new native intake with %s',
	async (mode) => {
		expect(await run(mode)).toMatchObject({ off: true, unchanged: true });
	}
);
it('keeps pause as an intake fence under the automatic own-repository policy', async () => {
	const result = await run('paused');
	expect(result.started).toBe(0);
	expect(result.reply).toMatchObject({ value: [{ ok: false, reason: 'worker-paused' }] });
	expect(result.reservations).toEqual({ n: 0 });
});

it('pauses a real native repository observation after an awaited read without further IO or SQLite mutation', async () => {
	expect(await run('proof-pause')).toMatchObject({ paused: true, noFurtherIO: true });
});

// Filesystem dependency faults pass through the actual WS/claim/final native fence.
it.each(['fence-missing-claim', 'fence-denied-claim'])(
	'refuses expected native fence absence at %s without a claim or mutation',
	async (mode) => {
		const result = await run(mode);
		expect(result.hostFault).toBeUndefined();
		expect(result.reportedFaults).toEqual([]);
		expect(result.started).toBe(0);
		expect(result.runs).toEqual({ n: 0 });
		expect(result.reservations).toEqual({ n: 0 });
		expect(result.cardsUnchanged).toBe(true);
		expect(result.reply).toMatchObject({
			value: [{ ok: false, reason: 'worker-repository-mismatch' }],
		});
	}
);
it.each(['fence-unexpected-claim', 'fence-io-claim'])(
	'reports unexpected native fence faults at %s without a claim or mutation',
	async (mode) => {
		const result = await run(mode);
		expect(result.reportedFaults).toContainEqual({
			error: result.injectedFault,
			context: { operation: 'board:repository-authority' },
		});
		expect(result.started).toBe(0);
		expect(result.runs).toEqual({ n: 0 });
		expect(result.reservations).toEqual({ n: 0 });
		expect(result.cardsUnchanged).toBe(true);
	}
);
it('reports an unexpected final native fence fault without authorizing a spawn', async () => {
	const result = await run('fence-unexpected-launch');
	expect(result.reportedFaults).toContainEqual({
		error: result.injectedFault,
		context: { operation: 'board:repository-authority' },
	});
	expect(result.started).toBe(0);
	expect(result.nativeCompletion).toMatchObject({ executionStarted: false });
	expect(result.reservations).toEqual({ n: 0 });
});
it('reports unexpected result-authority faults and retains the actual native completion behind its reservation', async () => {
	const result = await run('fence-unexpected-result');
	expect(result.reportedFaults).toContainEqual({
		error: result.injectedFault,
		context: { operation: 'board:repository-authority' },
	});
	expect(result.started).toBe(1);
	expect(result.nativeCompletion).toMatchObject({
		executionStarted: true,
		terminationConfirmed: true,
		exitCode: 0,
	});
	expect(result.reservations).toEqual({ n: 1 });
	const rows = result.runRows as { outcome_json: string | null; lifecycle_json: string }[];
	expect(rows).toHaveLength(1);
	expect(rows[0].outcome_json).toBeNull();
	const life = JSON.parse(rows[0].lifecycle_json);
	expect(life).toMatchObject({
		phase: 'uncertain',
		reason: 'worker-repository-mismatch',
		pendingResult: { executionStarted: true, terminationConfirmed: true, exitCode: 0 },
	});
	expect(life.pendingResult.output).toContain('Analysis committed; fixture check passed');
	expect(life.pendingResult.artifact).toEqual(
		expect.objectContaining({ commit: expect.any(String) })
	);
});
it('refuses expected missing identity at final native launch without starting', async () => {
	const result = await run('fence-missing-launch');
	expect(result.launchFault).toBeUndefined();
	expect(result.started).toBe(0);
	expect(result.nativeCompletion).toMatchObject({ executionStarted: false });
	expect(result.reservations).toEqual({ n: 0 });
});

describe.sequential('cancellation across fixture boundaries', () => {
	let controller: AbortController;
	let pending: Promise<unknown>;
	let settled = false;
	let cancelledAsExpected = false;
	let firstDb: ReturnType<typeof openBoardDb>;
	let release!: () => void;
	let restoreStat = () => {};
	it('cancels a real pending host read without awaiting the test body', async ({ signal }) => {
		controller = new AbortController();
		const combined = AbortSignal.any([controller.signal, signal]);
		const nativeStat = fs.promises.stat;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let blocked = false;
		fs.promises.stat = (async (...args: Parameters<typeof nativeStat>) => {
			const result = await nativeStat(...args);
			if (!blocked && String(args[0]) === fixture.sources.one) {
				blocked = true;
				entered();
				await barrier;
			}
			return result;
		}) as typeof nativeStat;
		restoreStat = () => {
			fs.promises.stat = nativeStat;
		};
		combined.addEventListener('abort', () => release(), { once: true });
		pending = Reflect.apply(run, undefined, ['sixteen', combined]).then(
			() => {
				settled = true;
			},
			(error) => {
				cancelledAsExpected = error === combined.reason;
				settled = true;
			}
		);
		await Promise.race([
			waiting,
			pending.then(() => {
				throw new Error('Fixture ended before read barrier');
			}),
		]);
		firstDb = getBoardStorage().db;
		expect(firstDb.open).toBe(true);
		controller.abort(new Error('owned fixture cancelled'));
		// Intentionally return with the body in flight: the real afterEach must join.
	});
	it('has joined the old handle before the next real fixture opens its database', async () => {
		const settledBeforeReuse = settled;
		const openBeforeReuse = firstDb.open;
		const next = await run('off-both').then(
			(value) => ({ ok: true, value }),
			(error) => ({ ok: false, error })
		);
		console.info(
			'[board-owned-fixture-cancel-reuse]',
			JSON.stringify({ settledBeforeReuse, openBeforeReuse, cancelledAsExpected })
		);
		expect(settledBeforeReuse).toBe(true);
		expect(cancelledAsExpected).toBe(true);
		expect(openBeforeReuse).toBe(false);
		expect(next).toMatchObject({ ok: true, value: { off: true, unchanged: true } });
	});
	afterAll(async () => {
		release?.();
		await pending;
		restoreStat();
	});
});
