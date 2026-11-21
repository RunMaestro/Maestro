// Source: src/__tests__/main/cue/cue-electron-imports.test.ts
// Source: src/__tests__/main/cue/cue-gh-token.test.ts
// Source: src/__tests__/main/cue/cue-activity-entries.test.ts
// Source: src/__tests__/main/cue/cue-activity-log.test.ts
// Source: src/__tests__/main/cue/cue-autorun-executor.test.ts
// Source: src/__tests__/main/cue/cue-catch-up-once.test.ts
// Source: src/__tests__/main/cue/cue-cleanup-service.test.ts
// Source: src/__tests__/main/cue/cue-event-factory.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as os from 'os';
import { buildGhEnv } from '../../../main/cue/cue-gh-token';
import { redactGhTokens } from '../../../main/cue/cue-gh-token';
import { cueEventRecordToRunResult } from '../../../main/cue/cue-activity-entries';
import { cueEventRecordsToRunResults } from '../../../main/cue/cue-activity-entries';
import { toCueActivityEntries } from '../../../main/cue/cue-activity-entries';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import type { CueRunResult } from '../../../main/cue/cue-types';
import { createCueActivityLog } from '../../../main/cue/cue-activity-log';
import { vi } from 'vitest';
import type { CueEvent } from '../../../main/cue/cue-types';
import type { CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import { executeCueAutoRun } from '../../../main/cue/cue-autorun-executor';
import { createCueHeartbeatTriggerSource } from '../../../main/cue/triggers/cue-heartbeat-trigger-source';
import { createCueScheduledTriggerSource } from '../../../main/cue/triggers/cue-scheduled-trigger-source';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import type { CueSessionRegistry } from '../../../main/cue/cue-session-registry';
import { reconcileMissedTimeEvents } from '../../../main/cue/cue-reconciler';
import type { CueTriggerSource } from '../../../main/cue/triggers/cue-trigger-source';
import { createCueCleanupService } from '../../../main/cue/cue-cleanup-service';
import { CLEANUP_INTERVAL_TICKS } from '../../../main/cue/cue-cleanup-service';
import type { CueCleanupServiceDeps } from '../../../main/cue/cue-cleanup-service';
import type { CueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import { createCueEvent } from '../../../main/cue/cue-types';
describeSourceSuite('cue-electron-imports', () => {
	const CUE_DIR = path.join(__dirname, '../../../main/cue');

	/** Files that still reach for Electron, and why. Shrink this, never grow it. */
	const KNOWN_ELECTRON_IMPORTERS = [
		'backup/cue-backup-manager.ts', // app.getPath for the backup directory
		'cue-auth-detector.ts', // type-only: BrowserWindow for the re-auth prompt
		'cue-notify-bridge.ts', // BrowserWindow for toast delivery
		'cue-notify-executor.ts', // BrowserWindow for toast delivery
	];

	function walk(dir: string): string[] {
		return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) return walk(full);
			return entry.name.endsWith('.ts') ? [full] : [];
		});
	}

	describe('Cue engine Electron coupling', () => {
		// Covers both quote styles, `require`, and a dynamic `import()`, so the
		// ratchet cannot be stepped around by changing the syntax.
		// The trailing `(?:\/[^'"]*)?` catches subpath imports like `electron/main`,
		// which the bare form would let through.
		const ELECTRON_REF = /(?:from|require\(|import\()\s*['"]electron(?:\/[^'"]*)?['"]/;

		// `path.relative` emits native separators, so a nested entry reads
		// `backup\cue-backup-manager.ts` on Windows and matches nothing in the list
		// above. Normalize to forward slashes rather than spelling the list twice.
		const importers = walk(CUE_DIR)
			.filter((file) => ELECTRON_REF.test(fs.readFileSync(file, 'utf-8')))
			.map((file) => path.relative(CUE_DIR, file).split(path.sep).join('/'))
			.sort();

		it('has no Electron importer outside the known list', () => {
			expect(importers).toEqual([...KNOWN_ELECTRON_IMPORTERS].sort());
		});

		it('resolves its data directory without Electron', () => {
			for (const file of ['cue-db.ts', 'pipeline-layout-store.ts']) {
				const source = fs.readFileSync(path.join(CUE_DIR, file), 'utf-8');
				expect(source).not.toMatch(/app\.getPath\(/);
				expect(source).toMatch(/resolveUserDataDir/);
			}
		});
	});
});
describeSourceSuite('cue-gh-token', () => {
	describe('buildGhEnv', () => {
		let credentials: string;
		let runSecrets: string;

		beforeEach(() => {
			credentials = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-cred-')));
			runSecrets = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-run-')));
		});

		afterEach(() => {
			fs.rmSync(credentials, { recursive: true, force: true });
			fs.rmSync(runSecrets, { recursive: true, force: true });
		});

		it('prefers a systemd credential, then /run/secrets, then the environment', () => {
			const base = { CREDENTIALS_DIRECTORY: credentials, GH_TOKEN: 'env', PATH: '/bin' };

			expect(buildGhEnv(base, { runSecretsDir: runSecrets }).env.GH_TOKEN).toBe('env');

			fs.writeFileSync(path.join(runSecrets, 'GH_TOKEN'), 'docker\n');
			expect(buildGhEnv(base, { runSecretsDir: runSecrets }).env.GH_TOKEN).toBe('docker');

			fs.writeFileSync(path.join(credentials, 'GH_TOKEN'), 'systemd\n');
			const built = buildGhEnv(base, { runSecretsDir: runSecrets });
			expect(built.env.GH_TOKEN).toBe('systemd');
			expect(built.env.PATH).toBe('/bin');
			expect(built.tokens).toEqual(['systemd']);
			expect(base.GH_TOKEN).toBe('env');
		});

		it('resolves GITHUB_TOKEN too, leaving gh to rank the two names', () => {
			fs.writeFileSync(path.join(runSecrets, 'GITHUB_TOKEN'), 'docker');
			const built = buildGhEnv({ GH_TOKEN: 'env' }, { runSecretsDir: runSecrets });
			expect(built.env).toMatchObject({ GH_TOKEN: 'env', GITHUB_TOKEN: 'docker' });
			expect(built.problems).toEqual([]);
		});

		it('drops the variable and reports the file, not a value, when the file is unusable', () => {
			fs.writeFileSync(path.join(runSecrets, 'GH_TOKEN'), '');
			const built = buildGhEnv({ GH_TOKEN: 'stale' }, { runSecretsDir: runSecrets });
			expect(built.env.GH_TOKEN).toBeUndefined();
			expect(built.tokens).toEqual([]);
			expect(built.problems).toEqual([`GH_TOKEN (${path.join(runSecrets, 'GH_TOKEN')}) is empty`]);
			expect(built.problems.join()).not.toContain('stale');
		});

		it('leaves the environment alone when no token is set anywhere', () => {
			const built = buildGhEnv({ PATH: '/bin' }, { runSecretsDir: null });
			expect(built.env).toEqual({ PATH: '/bin' });
			expect(built.tokens).toEqual([]);
		});
	});

	describe('redactGhTokens', () => {
		it('replaces every occurrence of every token', () => {
			expect(redactGhTokens('a tok b tok c other', ['tok', 'other'])).toBe(
				'a [redacted] b [redacted] c [redacted]'
			);
			expect(redactGhTokens('unchanged', [])).toBe('unchanged');
		});
	});
});
describeSourceSuite('cue-activity-entries', () => {
	function run(overrides: Partial<CueRunResult> = {}): CueRunResult {
		return {
			runId: 'run-1',
			sessionId: 'agent-1',
			sessionName: 'Agent One',
			subscriptionName: 'Digest',
			pipelineName: 'Daily',
			event: { id: 'e1', type: 'time.scheduled', timestamp: '', triggerName: 't', payload: {} },
			status: 'completed',
			stdout: 'all good',
			stderr: '',
			exitCode: 0,
			durationMs: 1234,
			startedAt: '2026-05-11T07:00:00.000Z',
			endedAt: '2026-05-11T07:00:01.234Z',
			...overrides,
		};
	}

	function record(overrides: Partial<CueEventRecord> = {}): CueEventRecord {
		return {
			id: 'run-1',
			type: 'time.scheduled',
			triggerName: 't',
			sessionId: 'agent-1',
			subscriptionName: 'Digest',
			status: 'completed',
			createdAt: Date.parse('2026-05-11T07:00:00.000Z'),
			completedAt: Date.parse('2026-05-11T07:00:02.000Z'),
			payload: null,
			...overrides,
		} as CueEventRecord;
	}

	describe('toCueActivityEntries', () => {
		it('maps a run onto the activity entry shape', () => {
			expect(toCueActivityEntries([run()])).toEqual([
				{
					id: 'run-1',
					subscriptionId: 'agent-1::Daily::Digest',
					subscriptionName: 'Digest',
					eventType: 'time.scheduled',
					sessionId: 'agent-1',
					timestamp: Date.parse('2026-05-11T07:00:00.000Z'),
					status: 'completed',
					result: 'all good',
					duration: 1234,
				},
			]);
		});

		it('folds timeout and stopped into failed, and surfaces stderr as the result', () => {
			const entries = toCueActivityEntries([
				run({ runId: 'r1', status: 'timeout', stderr: 'took too long' }),
				run({ runId: 'r2', status: 'stopped', stderr: 'user kill' }),
				run({ runId: 'r3', status: 'failed', stderr: 'oops' }),
				run({ runId: 'r4', status: 'running', stdout: '' }),
			]);
			const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
			expect(byId.r1).toMatchObject({ status: 'failed', result: 'took too long' });
			expect(byId.r2).toMatchObject({ status: 'failed', result: 'user kill' });
			expect(byId.r3).toMatchObject({ status: 'failed', result: 'oops' });
			expect(byId.r4).toMatchObject({ status: 'running', result: undefined });
		});

		it('returns runs newest first from an oldest-first log', () => {
			const entries = toCueActivityEntries([
				run({ runId: 'old' }),
				run({ runId: 'mid' }),
				run({ runId: 'new' }),
			]);
			expect(entries.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
		});

		it('filters by agent before the limit, and the limit keeps the newest runs', () => {
			const entries = toCueActivityEntries(
				[
					run({ runId: 'a-old', sessionId: 'agent-1' }),
					run({ runId: 'b', sessionId: 'agent-2' }),
					run({ runId: 'a-mid', sessionId: 'agent-1' }),
					run({ runId: 'a-new', sessionId: 'agent-1' }),
					run({ runId: 'b-newest', sessionId: 'agent-2' }),
				],
				{ sessionId: 'agent-1', limit: 2 }
			);
			expect(entries.map((e) => e.id)).toEqual(['a-new', 'a-mid']);
		});

		it('treats an empty agent or a non-positive limit as no filter', () => {
			const runs = [run({ runId: 'a' }), run({ runId: 'b', sessionId: 'agent-2' })];
			expect(toCueActivityEntries(runs, { sessionId: '', limit: 0 })).toHaveLength(2);
		});

		it('falls back to base-name stripping for the id when the run has no pipeline', () => {
			const [entry] = toCueActivityEntries([
				run({ pipelineName: undefined, subscriptionName: 'LegacyPipe-chain-2' }),
			]);
			expect(entry.subscriptionId).toBe('agent-1::LegacyPipe::LegacyPipe-chain-2');
		});
	});

	describe('cueEventRecordToRunResult', () => {
		it('rebuilds a run without output, naming the agent from the map', () => {
			const result = cueEventRecordToRunResult(
				record({ payload: '{"file":"a.md"}' }),
				new Map([['agent-1', 'Agent One']])
			);
			expect(result).toMatchObject({
				runId: 'run-1',
				sessionName: 'Agent One',
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 2000,
				startedAt: '2026-05-11T07:00:00.000Z',
				endedAt: '2026-05-11T07:00:02.000Z',
			});
			expect(result.event.payload).toEqual({ file: 'a.md' });
		});

		it('reports an orphaned running row as failed, with no duration', () => {
			const result = cueEventRecordToRunResult(
				record({ status: 'running', completedAt: null, payload: 'not json' }),
				new Map()
			);
			expect(result).toMatchObject({
				status: 'failed',
				durationMs: 0,
				endedAt: '',
				sessionName: 'agent-1',
			});
			expect(result.event.payload).toEqual({});
		});

		it('keeps a running row running when a live engine owns the database', () => {
			const result = cueEventRecordToRunResult(
				record({ status: 'running', completedAt: null }),
				new Map(),
				{ keepRunning: true }
			);
			expect(result).toMatchObject({ status: 'running', durationMs: 0, endedAt: '' });
			const [entry] = toCueActivityEntries([result]);
			expect(entry.status).toBe('running');
			// No duration yet, rather than a finished-looking 0.
			expect(entry.duration).toBeUndefined();
			expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty('duration');
		});

		it('keepRunning: false is the default, and leaves finished rows alone', () => {
			const running = record({ status: 'running', completedAt: null });
			expect(cueEventRecordToRunResult(running, new Map(), { keepRunning: false }).status).toBe(
				'failed'
			);
			expect(cueEventRecordToRunResult(running, new Map()).status).toBe('failed');
			expect(cueEventRecordToRunResult(record({}), new Map(), { keepRunning: true })).toMatchObject(
				{
					status: 'completed',
					durationMs: 2000,
				}
			);
		});

		it('keeps timeout and stopped rows, which the entry mapping then folds into failed', () => {
			const runs = ['timeout', 'stopped'].map((status) =>
				cueEventRecordToRunResult(record({ status }), new Map())
			);
			expect(runs.map((r) => r.status)).toEqual(['timeout', 'stopped']);
			expect(toCueActivityEntries(runs).map((e) => e.status)).toEqual(['failed', 'failed']);
		});
	});

	describe('cueEventRecordsToRunResults', () => {
		it('turns newest-first rows into the oldest-first activity log order', () => {
			const runs = cueEventRecordsToRunResults(
				[record({ id: 'new' }), record({ id: 'old' })],
				new Map()
			);
			expect(runs.map((r) => r.runId)).toEqual(['old', 'new']);
			// Round trip: the activity view shows them newest first again.
			expect(toCueActivityEntries(runs).map((e) => e.id)).toEqual(['new', 'old']);
		});
	});
});
describeSourceSuite('cue-activity-log', () => {
	function makeResult(id: string): CueRunResult {
		return {
			runId: id,
			sessionId: 'session-1',
			sessionName: 'Test',
			subscriptionName: 'sub',
			event: { id: 'e1', type: 'time.heartbeat', timestamp: '', triggerName: 'sub', payload: {} },
			status: 'completed',
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 100,
			startedAt: '',
			endedAt: '',
		};
	}

	describe('createCueActivityLog', () => {
		it('stores and retrieves results', () => {
			const log = createCueActivityLog();
			log.push(makeResult('r1'));
			log.push(makeResult('r2'));
			expect(log.getAll()).toHaveLength(2);
			expect(log.getAll()[0].runId).toBe('r1');
		});

		it('respects limit parameter on getAll', () => {
			const log = createCueActivityLog();
			log.push(makeResult('r1'));
			log.push(makeResult('r2'));
			log.push(makeResult('r3'));
			const last2 = log.getAll(2);
			expect(last2).toHaveLength(2);
			expect(last2[0].runId).toBe('r2');
			expect(last2[1].runId).toBe('r3');
		});

		it('evicts oldest entries when exceeding maxSize', () => {
			const log = createCueActivityLog(3);
			log.push(makeResult('r1'));
			log.push(makeResult('r2'));
			log.push(makeResult('r3'));
			log.push(makeResult('r4'));
			const all = log.getAll();
			expect(all).toHaveLength(3);
			expect(all[0].runId).toBe('r2');
			expect(all[2].runId).toBe('r4');
		});

		it('clear empties the log', () => {
			const log = createCueActivityLog();
			log.push(makeResult('r1'));
			log.clear();
			expect(log.getAll()).toHaveLength(0);
		});

		it('returns a copy from getAll, not a reference', () => {
			const log = createCueActivityLog();
			log.push(makeResult('r1'));
			const snapshot = log.getAll();
			log.push(makeResult('r2'));
			expect(snapshot).toHaveLength(1);
		});

		it('seed replaces the log preserving order', () => {
			const log = createCueActivityLog();
			log.push(makeResult('old'));
			log.seed([makeResult('a'), makeResult('b'), makeResult('c')]);
			const all = log.getAll();
			expect(all).toHaveLength(3);
			expect(all.map((r) => r.runId)).toEqual(['a', 'b', 'c']);
		});

		it('seed truncates to maxSize keeping the newest entries', () => {
			const log = createCueActivityLog(2);
			log.seed([makeResult('a'), makeResult('b'), makeResult('c')]);
			const all = log.getAll();
			expect(all.map((r) => r.runId)).toEqual(['b', 'c']);
		});

		it('seed with empty array clears the log', () => {
			const log = createCueActivityLog();
			log.push(makeResult('r1'));
			log.seed([]);
			expect(log.getAll()).toHaveLength(0);
		});
	});
});
describeSourceSuite('cue-autorun-executor', () => {
	// The launcher is injected, so the executor is exercised with no Electron in
	// reach - which is the property the Cue engine's Electron ratchet protects.
	const launchCueAutoRunMock = vi.fn();

	function createSession(): SessionInfo {
		return {
			id: 'session-1',
			name: 'Nightly',
			toolType: 'claude-code',
			cwd: '/tmp/project',
			projectRoot: '/tmp/project',
		};
	}

	function createSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
		return {
			name: 'run-at-6am',
			event: 'time.once',
			enabled: true,
			prompt: '',
			action: 'autorun',
			agent_id: 'session-1',
			auto_run: { documents: ['/proj/Auto Run Docs/ship.md'] },
			...overrides,
		} as CueSubscription;
	}

	const event = { type: 'time.once', payload: {} } as unknown as CueEvent;

	describe('executeCueAutoRun', () => {
		beforeEach(() => {
			launchCueAutoRunMock.mockReset();
		});

		it('launches the documents captured on the subscription', async () => {
			launchCueAutoRunMock.mockResolvedValue({ success: true });

			const result = await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: {
					documents: ['/proj/Auto Run Docs/a.md', '/proj/Auto Run Docs/b.md'],
					reset_on_completion: [false, true],
					prompt: 'Work the tasks',
					loop_enabled: true,
					max_loops: 2,
				},
				launch: launchCueAutoRunMock,
				onLog: vi.fn(),
			});

			expect(launchCueAutoRunMock).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					documents: [
						{ filename: '/proj/Auto Run Docs/a.md', resetOnCompletion: false },
						{ filename: '/proj/Auto Run Docs/b.md', resetOnCompletion: true },
					],
					prompt: 'Work the tasks',
					loopEnabled: true,
					maxLoops: 2,
				})
			);
			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
		});

		it('hands the task selection mode and the model-hint opt-out to the launch', async () => {
			launchCueAutoRunMock.mockResolvedValue({ success: true });

			await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: {
					documents: ['/proj/a.md'],
					task_selection_mode: 'document',
					ignore_model_hints: true,
				},
				launch: launchCueAutoRunMock,
				onLog: vi.fn(),
			});

			expect(launchCueAutoRunMock.mock.calls[0][0]).toMatchObject({
				taskSelectionMode: 'document',
				ignoreModelHints: true,
			});
		});

		it('hands the auto-resume settings and the worktree target to the launch', async () => {
			launchCueAutoRunMock.mockResolvedValue({ success: true });

			await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: {
					documents: ['/proj/a.md'],
					auto_resume_on_error: false,
					auto_resume_after_min: 10,
					max_auto_resumes: 3,
					worktree: { mode: 'create-new', branch: 'nightly', base_branch: 'rc', create_pr: true },
				},
				launch: launchCueAutoRunMock,
				onLog: vi.fn(),
			});

			expect(launchCueAutoRunMock.mock.calls[0][0]).toMatchObject({
				autoResumeOnError: false,
				autoResumeAfterMin: 10,
				maxAutoResumes: 3,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'nightly',
					baseBranch: 'rc',
					createPROnCompletion: true,
				},
			});
		});

		it("names no worktree target for a run in the agent's own checkout", async () => {
			launchCueAutoRunMock.mockResolvedValue({ success: true });

			await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: { documents: ['/proj/a.md'] },
				launch: launchCueAutoRunMock,
				onLog: vi.fn(),
			});

			expect(launchCueAutoRunMock.mock.calls[0][0].worktreeTarget).toBeUndefined();
		});

		it('defaults resetOnCompletion to false when no flags were captured', async () => {
			launchCueAutoRunMock.mockResolvedValue({ success: true });

			await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: { documents: ['/proj/a.md'] },
				launch: launchCueAutoRunMock,
				onLog: vi.fn(),
			});

			expect(launchCueAutoRunMock.mock.calls[0][0].documents).toEqual([
				{ filename: '/proj/a.md', resetOnCompletion: false },
			]);
		});

		it('reports `failed` when the renderer does not accept the launch', async () => {
			// This is the case the status semantics exist for: paired with
			// `self_destruct_on_failure: false`, a `failed` status keeps the
			// subscription on disk instead of silently consuming the user's
			// scheduled run.
			launchCueAutoRunMock.mockResolvedValue({
				success: false,
				error: 'renderer webContents not available',
			});

			const result = await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: { documents: ['/proj/a.md'] },
				launch: launchCueAutoRunMock,
				onLog: vi.fn(),
			});

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('renderer webContents not available');
		});

		it('logs an explanation when the launch fails so the failure is triageable', async () => {
			launchCueAutoRunMock.mockResolvedValue({ success: false, error: 'boom' });
			const onLog = vi.fn();

			await executeCueAutoRun({
				runId: 'run-1',
				session: createSession(),
				subscription: createSubscription(),
				event,
				autoRun: { documents: ['/proj/a.md'] },
				launch: launchCueAutoRunMock,
				onLog,
			});

			const errorLogs = onLog.mock.calls.filter(([level]) => level === 'error');
			expect(errorLogs).toHaveLength(1);
			expect(errorLogs[0][1]).toContain('boom');
		});
	});
});
describeSourceSuite('cue-catch-up-once', () => {
	const SESSION: SessionInfo = {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};

	const RealDate = Date;
	let wallMs = 0;

	/** `Date` that reads `wallMs`, independent of the fake timer clock. */
	class WallDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(wallMs);
			else super(...(args as [string | number | Date]));
		}
		static now(): number {
			return wallMs;
		}
	}

	/** Both clocks run, as they do while the process is awake. */
	function elapse(ms: number): void {
		for (let left = ms; left > 0; ) {
			const step = Math.min(1000, left);
			wallMs += step;
			vi.advanceTimersByTime(step);
			left -= step;
		}
	}

	interface Harness {
		runs: Array<{ wallMs: number; reconciled: boolean }>;
		registry: CueSessionRegistry;
		source: CueTriggerSource;
		reconcile: (sleepStartMs: number) => void;
	}

	function setUp(sub: CueSubscription, create: typeof createCueHeartbeatTriggerSource): Harness {
		const runs: Harness['runs'] = [];
		const record = (event: CueEvent) =>
			runs.push({ wallMs, reconciled: event.payload.reconciled === true });
		const registry = createCueSessionRegistry();
		const source = create({
			session: SESSION,
			subscription: sub,
			registry,
			enabled: () => true,
			onLog: vi.fn(),
			emit: record,
		});
		if (!source) throw new Error('no trigger source');
		source.start();

		const reconcile = (sleepStartMs: number) =>
			reconcileMissedTimeEvents({
				sleepStartMs,
				wakeTimeMs: Date.now(),
				sessions: new Map([
					[
						SESSION.id,
						{ config: { subscriptions: [sub], settings: {} } as never, sessionName: 'Test' },
					],
				]),
				onDispatch: (_sessionId, _sub, event) => record(event),
				onLog: vi.fn(),
				firedRecord: registry,
			});

		return { runs, registry, source, reconcile };
	}

	const MIN = 60_000;

	describe('one run per missed window after a sleep or pause', () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
			vi.stubGlobal('Date', WallDate);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		});

		describe('time.heartbeat, 2-minute interval, paused 150s', () => {
			const sub: CueSubscription = {
				name: 'beat',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 2,
			};
			const T0 = new RealDate(2026, 9, 8, 10, 0, 0).getTime();

			let h: Harness;
			let lastHeartbeatMs: number;

			beforeEach(() => {
				wallMs = T0;
				h = setUp(sub, createCueHeartbeatTriggerSource);
				// Runs at start, the process is awake for a minute, then it pauses.
				elapse(1 * MIN);
				lastHeartbeatMs = wallMs;
				wallMs += 150_000;
			});

			afterEach(() => h.source.stop());

			/** After resume: one run every interval, and nothing in between. */
			function expectCadenceFrom(lastRunMs: number) {
				const before = h.runs.length;
				elapse(lastRunMs + 2 * MIN - 1000 - wallMs);
				expect(h.runs.length).toBe(before);
				elapse(1000);
				expect(h.runs.length).toBe(before + 1);
				expect(h.runs[before].wallMs).toBe(lastRunMs + 2 * MIN);
				elapse(2 * MIN);
				expect(h.runs.length).toBe(before + 2);
			}

			it('timer overdue on resume, catch-up first: runs once', () => {
				h.reconcile(lastHeartbeatMs);
				vi.advanceTimersToNextTimer(); // the overdue interval, 13 ms later in the live run

				expect(h.runs.map((r) => r.reconciled)).toEqual([false, true]);
				expectCadenceFrom(T0 + 3.5 * MIN);
			});

			it('timer overdue on resume, timer first: runs once', () => {
				vi.advanceTimersToNextTimer();
				h.reconcile(lastHeartbeatMs);

				expect(h.runs.map((r) => r.reconciled)).toEqual([false, false]);
				expectCadenceFrom(T0 + 3.5 * MIN);
			});

			it('timer not overdue on resume (suspend stopped the timer clock): runs once', () => {
				h.reconcile(lastHeartbeatMs);
				// The interval still had a minute to wait when the clock stopped.
				elapse(1 * MIN);

				expect(h.runs.map((r) => r.reconciled)).toEqual([false, true]);
				expectCadenceFrom(T0 + 3.5 * MIN);
			});

			it('timer not overdue on resume, timer first: runs once', () => {
				// A resume handler that runs later than the timer's remaining wait.
				elapse(1 * MIN);
				h.reconcile(lastHeartbeatMs);

				expect(h.runs.map((r) => r.reconciled)).toEqual([false, false]);
				expectCadenceFrom(T0 + 4.5 * MIN);
			});

			it('still catches up when the last run was more than an interval before the wake', () => {
				h.reconcile(lastHeartbeatMs);
				expect(h.runs.at(-1)).toEqual({ wallMs: T0 + 3.5 * MIN, reconciled: true });
			});
		});

		it('time.heartbeat with no sleep keeps its interval', () => {
			wallMs = new RealDate(2026, 9, 8, 10, 0, 0).getTime();
			const start = wallMs;
			const h = setUp(
				{ name: 'beat', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 2 },
				createCueHeartbeatTriggerSource
			);
			elapse(10 * MIN);
			expect(h.runs.map((r) => (r.wallMs - start) / MIN)).toEqual([0, 2, 4, 6, 8, 10]);
			h.source.stop();
		});

		describe('time.scheduled at 09:00, waking inside the 09:00 minute', () => {
			const sub: CueSubscription = {
				name: 'daily',
				event: 'time.scheduled',
				enabled: true,
				prompt: 'p',
				schedule_times: ['09:00'],
			};
			const at = (h: number, m: number, s: number) => new RealDate(2026, 9, 8, h, m, s).getTime();

			let h: Harness;

			afterEach(() => h.source.stop());

			it('timer overdue on resume, catch-up first: runs once', () => {
				wallMs = at(8, 58, 0);
				h = setUp(sub, createCueScheduledTriggerSource);
				elapse(10_000);
				wallMs = at(9, 0, 20);
				h.reconcile(at(8, 58, 10));
				vi.advanceTimersToNextTimer();

				expect(h.runs.map((r) => r.reconciled)).toEqual([true]);
			});

			it('timer overdue on resume, timer first: runs once', () => {
				wallMs = at(8, 58, 0);
				h = setUp(sub, createCueScheduledTriggerSource);
				elapse(10_000);
				wallMs = at(9, 0, 20);
				vi.advanceTimersToNextTimer();
				h.reconcile(at(8, 58, 10));

				expect(h.runs.map((r) => r.reconciled)).toEqual([false]);
			});

			it('timer not overdue on resume, timer first: runs once', () => {
				wallMs = at(8, 57, 35);
				h = setUp(sub, createCueScheduledTriggerSource);
				elapse(20_000);
				// Paused at 08:57:55 with the poll 40s away; resumes at 09:00:05.
				wallMs = at(9, 0, 5);
				elapse(40_000);
				h.reconcile(at(8, 57, 55));

				expect(h.runs.map((r) => r.reconciled)).toEqual([false]);
			});

			it('timer not overdue on resume, catch-up first: runs once', () => {
				wallMs = at(8, 57, 35);
				h = setUp(sub, createCueScheduledTriggerSource);
				elapse(20_000);
				wallMs = at(9, 0, 5);
				h.reconcile(at(8, 57, 55));
				elapse(MIN);

				expect(h.runs.map((r) => r.reconciled)).toEqual([true]);
			});

			it('a slot before the wake minute is caught up as before', () => {
				wallMs = at(8, 58, 0);
				h = setUp(sub, createCueScheduledTriggerSource);
				elapse(10_000);
				wallMs = at(9, 5, 0);
				h.reconcile(at(8, 58, 10));
				vi.advanceTimersToNextTimer();
				elapse(5 * MIN);

				expect(h.runs.map((r) => r.reconciled)).toEqual([true]);
			});
		});
	});
});
describeSourceSuite('cue-cleanup-service', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────

	function makeMockTracker(overrides: Partial<CueFanInTracker> = {}): CueFanInTracker {
		return {
			handleCompletion: vi.fn(),
			clearForSession: vi.fn(),
			reset: vi.fn(),
			getActiveTrackerKeys: vi.fn(() => []),
			getTrackerCreatedAt: vi.fn(() => undefined),
			expireTracker: vi.fn(),
			...overrides,
		};
	}

	function makeMockRegistry(overrides: Partial<CueSessionRegistry> = {}): CueSessionRegistry {
		return {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn(() => undefined),
			has: vi.fn(() => false),
			snapshot: vi.fn(() => new Map()),
			size: vi.fn(() => 0),
			markScheduledFired: vi.fn(() => true),
			evictStaleScheduledKeys: vi.fn(),
			clearScheduledForSession: vi.fn(),
			markStartupFired: vi.fn(() => true),
			clearStartupForSession: vi.fn(),
			clear: vi.fn(),
			sweepStaleScheduledKeys: vi.fn(() => 0),
			...overrides,
		};
	}

	function makeDeps(overrides: Partial<CueCleanupServiceDeps> = {}): CueCleanupServiceDeps {
		return {
			fanInTracker: makeMockTracker(),
			registry: makeMockRegistry(),
			getSessions: vi.fn(() => []),
			getSessionTimeoutMs: vi.fn(() => 30 * 60 * 1000),
			getCurrentMinute: vi.fn(() => '09:00'),
			onLog: vi.fn(),
			...overrides,
		};
	}

	// ─── Tests ───────────────────────────────────────────────────────────────────

	describe('createCueCleanupService', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		describe('sweep - no-op cases', () => {
			it('returns zero counts when no trackers or keys exist', () => {
				const deps = makeDeps();
				const service = createCueCleanupService(deps);
				const result = service.sweep();
				expect(result).toEqual({ fanInEvicted: 0, scheduledKeysEvicted: 0 });
			});

			it('does not evict a recent fan-in tracker', () => {
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['session-1:sub-a']),
					getTrackerCreatedAt: vi.fn(() => Date.now() - 1000), // 1 second old
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [{ id: 'session-1' }],
					getSessionTimeoutMs: () => 30 * 60 * 1000, // 30 min - 2× = 60 min
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();

				expect(tracker.expireTracker).not.toHaveBeenCalled();
				expect(result.fanInEvicted).toBe(0);
			});
		});

		describe('sweep - fan-in eviction', () => {
			it('evicts a fan-in tracker whose owner session is no longer active', () => {
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['removed-session:sub-a']),
					getTrackerCreatedAt: vi.fn(() => Date.now()),
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [], // removed-session is gone
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();

				expect(tracker.expireTracker).toHaveBeenCalledWith('removed-session:sub-a');
				expect(result.fanInEvicted).toBe(1);
				expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('removed session'));
			});

			it('evicts a fan-in tracker whose age exceeds 2× the session timeout', () => {
				const timeoutMs = 30 * 60 * 1000; // 30 minutes
				const createdAt = Date.now() - 3 * timeoutMs; // 90 minutes ago > 2× timeout
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['session-1:sub-a']),
					getTrackerCreatedAt: vi.fn(() => createdAt),
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [{ id: 'session-1' }],
					getSessionTimeoutMs: () => timeoutMs,
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();

				expect(tracker.expireTracker).toHaveBeenCalledWith('session-1:sub-a');
				expect(result.fanInEvicted).toBe(1);
				expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('2× timeout'));
			});

			it('handles a key without a colon (edge case) by treating the whole key as session ID', () => {
				const tracker = makeMockTracker({
					getActiveTrackerKeys: vi.fn(() => ['orphaned-key']),
					getTrackerCreatedAt: vi.fn(() => undefined),
					expireTracker: vi.fn(),
				});
				const deps = makeDeps({
					fanInTracker: tracker,
					getSessions: () => [], // no sessions
				});
				const service = createCueCleanupService(deps);
				const result = service.sweep();

				// Should be evicted because "orphaned-key" is not in active sessions
				expect(tracker.expireTracker).toHaveBeenCalledWith('orphaned-key');
				expect(result.fanInEvicted).toBe(1);
			});
		});

		describe('sweep - scheduled key eviction', () => {
			it('reports evicted scheduled key count from registry.sweepStaleScheduledKeys', () => {
				const registry = makeMockRegistry({
					sweepStaleScheduledKeys: vi.fn(() => 3),
				});
				const deps = makeDeps({ registry });
				const service = createCueCleanupService(deps);
				const result = service.sweep();

				expect(result.scheduledKeysEvicted).toBe(3);
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledWith('09:00');
				expect(deps.onLog).toHaveBeenCalledWith(
					'info',
					expect.stringContaining('3 stale scheduled key')
				);
			});

			it('passes the current minute from getCurrentMinute to the registry sweep', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const deps = makeDeps({
					registry,
					getCurrentMinute: () => '14:32',
				});
				const service = createCueCleanupService(deps);
				service.sweep();

				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledWith('14:32');
			});
		});

		describe('onTick cadence', () => {
			it('does not sweep before CLEANUP_INTERVAL_TICKS ticks', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);

				for (let i = 0; i < CLEANUP_INTERVAL_TICKS - 1; i++) {
					service.onTick();
				}

				expect(tracker.getActiveTrackerKeys).not.toHaveBeenCalled();
				expect(registry.sweepStaleScheduledKeys).not.toHaveBeenCalled();
			});

			it('triggers a sweep on exactly the Nth tick', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);

				for (let i = 0; i < CLEANUP_INTERVAL_TICKS; i++) {
					service.onTick();
				}

				expect(tracker.getActiveTrackerKeys).toHaveBeenCalledTimes(1);
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(1);
			});

			it('sweeps again after another full interval', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);

				for (let i = 0; i < CLEANUP_INTERVAL_TICKS * 2; i++) {
					service.onTick();
				}

				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(2);
			});
		});

		describe('sweep - direct invocation', () => {
			it('sweep() bypasses the tick counter and runs immediately', () => {
				const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
				const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
				const deps = makeDeps({ registry, fanInTracker: tracker });
				const service = createCueCleanupService(deps);

				// No ticks fired - sweep still runs when called directly
				service.sweep();

				expect(tracker.getActiveTrackerKeys).toHaveBeenCalledTimes(1);
				expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(1);
			});
		});
	});
});
describeSourceSuite('cue-event-factory', () => {
	describe('createCueEvent', () => {
		it('returns an object with all 5 CueEvent fields', () => {
			const event = createCueEvent('time.heartbeat', 'my-trigger', { foo: 'bar' });
			expect(event).toHaveProperty('id');
			expect(event).toHaveProperty('type');
			expect(event).toHaveProperty('timestamp');
			expect(event).toHaveProperty('triggerName');
			expect(event).toHaveProperty('payload');
		});

		it('generates a valid UUID for id', () => {
			const event = createCueEvent('file.changed', 'watcher');
			expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		});

		it('generates a valid ISO timestamp', () => {
			const event = createCueEvent('time.scheduled', 'daily-check');
			const parsed = new Date(event.timestamp).getTime();
			expect(Number.isNaN(parsed)).toBe(false);
			expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('sets type to the provided event type', () => {
			const event = createCueEvent('github.pull_request', 'pr-watcher');
			expect(event.type).toBe('github.pull_request');
		});

		it('sets triggerName to the provided value', () => {
			const event = createCueEvent('task.pending', 'task-scanner');
			expect(event.triggerName).toBe('task-scanner');
		});

		it('defaults payload to empty object when omitted', () => {
			const event = createCueEvent('time.heartbeat', 'heartbeat');
			expect(event.payload).toEqual({});
		});

		it('includes provided payload values', () => {
			const payload = { interval_minutes: 30, reconciled: true };
			const event = createCueEvent('time.heartbeat', 'heartbeat', payload);
			expect(event.payload).toEqual(payload);
		});

		it('generates a unique id on each call', () => {
			const event1 = createCueEvent('time.heartbeat', 'a');
			const event2 = createCueEvent('time.heartbeat', 'a');
			expect(event1.id).not.toBe(event2.id);
		});
	});
});
