/**
 * Tests for src/main/agents/claude-interactive-replay.ts
 *
 * Covers MAESTRO-P-03 task 1: when a maestro-p (interactive Claude) run exits
 * with code 2 — the limit-hit signal defined by phase 1 — the replay watcher
 * must:
 *   - refresh the usage snapshot via sampleUsage(),
 *   - flip session.claudeInteractive to { mode: 'api', modeReason: 'limit' },
 *   - emit process:claude-mode-resolved so the renderer mirrors the flip,
 *   - and respawn the same turn under api mode by handing the api-mode
 *     ProcessConfig back to processManager.spawn().
 *
 * Other exit codes must NOT trigger a respawn. Cleanup must run in all paths.
 *
 * The replay module is intentionally decoupled from electron / electron-store
 * / ProcessManager: the test injects a plain EventEmitter as the processManager
 * stand-in and a fake-in-memory sessions store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type Store from 'electron-store';
import type { BrowserWindow } from 'electron';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn((win: unknown) => !!win),
}));

// electron-store import path is pulled in transitively by claudeUsageStore.
vi.mock('electron-store', () => {
	class MockStore<T extends Record<string, unknown>> {
		private state: Record<string, unknown>;
		constructor(options: { defaults?: T } = {}) {
			this.state = { ...(options.defaults ?? {}) };
		}
		get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K] {
			const value = this.state[key as string];
			return (value === undefined ? defaultValue : value) as T[K];
		}
		set<K extends keyof T>(key: K, value: T[K]): void {
			this.state[key as string] = value;
		}
	}
	return { default: MockStore };
});

import {
	registerInteractiveReplay,
	clearInteractiveReplay,
	MAESTRO_P_LIMIT_EXIT_CODE,
	__resetReplayStateForTests,
	__peekReplayContextForTests,
	type ClaudeReplayContext,
	type ClaudeReplayDeps,
} from '../../../main/agents/claude-interactive-replay';
import type { ProcessConfig, SpawnResult } from '../../../main/process-manager/types';
import type { UsageSnapshot } from '../../../main/agents/claude-mode-selector';
import type { SessionsData } from '../../../main/stores/types';

// ── Test harness ───────────────────────────────────────────────────────────

interface SentEvent {
	channel: string;
	args: unknown[];
}

function createFakeMainWindow(): { window: BrowserWindow; sent: SentEvent[] } {
	const sent: SentEvent[] = [];
	const window = {
		webContents: {
			send: (channel: string, ...args: unknown[]) => {
				sent.push({ channel, args });
			},
		},
	} as unknown as BrowserWindow;
	return { window, sent };
}

function createFakeSessionsStore(initial: SessionsData = { sessions: [] }): Store<SessionsData> {
	let state: SessionsData = JSON.parse(JSON.stringify(initial));
	return {
		get: ((key: keyof SessionsData, defaultValue?: SessionsData[keyof SessionsData]) => {
			const value = state[key];
			return (value === undefined ? defaultValue : value) as never;
		}) as Store<SessionsData>['get'],
		set: ((key: keyof SessionsData, value: SessionsData[keyof SessionsData]) => {
			state = { ...state, [key]: value };
		}) as Store<SessionsData>['set'],
	} as unknown as Store<SessionsData>;
}

function buildApiSpawnConfigStub(overrides: Partial<ProcessConfig> = {}): () => ProcessConfig {
	return () => ({
		sessionId: 'tab-1',
		toolType: 'claude-code',
		cwd: '/work',
		command: '/usr/local/bin/claude',
		args: [
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
			'--resume',
			'claude-session-abc',
		],
		prompt: 'do the thing',
		...overrides,
	});
}

function buildSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sampledAt: '2026-05-13T12:00:00Z',
		configDirKey: '/Users/test/.claude',
		session: { percent: 99, resetsAt: '2026-05-13T17:00:00Z' },
		weekAllModels: { percent: 50, resetsAt: '2026-05-20T00:00:00Z' },
		weekSonnetOnly: { percent: 40, resetsAt: '2026-05-20T00:00:00Z' },
		...overrides,
	};
}

interface FakeProcessHarness {
	processManager: EventEmitter;
	spawn: ReturnType<typeof vi.fn<(config: ProcessConfig) => SpawnResult>>;
	sessionsStore: Store<SessionsData>;
	mainWindow: BrowserWindow;
	sentEvents: SentEvent[];
	sampleUsageFn: ReturnType<typeof vi.fn>;
	setSnapshotFn: ReturnType<typeof vi.fn>;
	deps: ClaudeReplayDeps;
}

function createHarness(
	opts: {
		initialSessions?: SessionsData;
		sampleResult?: UsageSnapshot | null;
	} = {}
): FakeProcessHarness {
	const processManager = new EventEmitter();
	const spawn = vi.fn((_: ProcessConfig) => ({ pid: 999, success: true }));
	const sessionsStore = createFakeSessionsStore(
		opts.initialSessions ?? {
			sessions: [
				{
					id: 'tab-1',
					groupId: undefined,
					name: 'Claude',
					toolType: 'claude-code',
					cwd: '/work',
					projectRoot: '/work',
					claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
				},
			],
		}
	);
	const { window, sent } = createFakeMainWindow();
	const sampleUsageFn = vi.fn(async () =>
		'sampleResult' in opts ? (opts.sampleResult ?? null) : buildSnapshot()
	);
	const setSnapshotFn = vi.fn((_snap: UsageSnapshot) => {});

	const deps: ClaudeReplayDeps = {
		processManager,
		spawn,
		sessionsStore,
		getMainWindow: () => window,
		sampleUsageFn,
		setSnapshotFn,
	};

	return {
		processManager,
		spawn,
		sessionsStore,
		mainWindow: window,
		sentEvents: sent,
		sampleUsageFn,
		setSnapshotFn,
		deps,
	};
}

function buildContext(overrides: Partial<ClaudeReplayContext> = {}): ClaudeReplayContext {
	return {
		buildApiSpawnConfig: buildApiSpawnConfigStub(),
		configDir: '/Users/test/.claude',
		configDirKey: '/Users/test/.claude',
		cwd: '/work',
		envForSample: {
			CLAUDE_CONFIG_DIR: '/Users/test/.claude',
			MAESTRO_CLAUDE_BIN: '/usr/local/bin/claude',
		},
		maestroPBinPath: '/opt/maestro/maestro-p.js',
		...overrides,
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('claude-interactive-replay', () => {
	beforeEach(() => {
		__resetReplayStateForTests();
	});

	afterEach(() => {
		__resetReplayStateForTests();
	});

	describe('exit code === 2 (limit-hit)', () => {
		it('refreshes usage, flips session state, emits mode event, and respawns under api', async () => {
			const harness = createHarness();
			const onCleanup = vi.fn();

			registerInteractiveReplay('tab-1', buildContext({ onCleanup }), harness.deps);

			// Sanity check: context was registered
			expect(__peekReplayContextForTests('tab-1')).toBeDefined();

			// Emit limit-hit exit
			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			// Let the awaited sampleUsage + downstream side effects settle.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// (a) sampleUsage called with the captured refresh inputs
			expect(harness.sampleUsageFn).toHaveBeenCalledTimes(1);
			const [sampleArgs] = harness.sampleUsageFn.mock.calls[0];
			expect(sampleArgs).toMatchObject({
				binPath: '/opt/maestro/maestro-p.js',
				configDir: '/Users/test/.claude',
				cwd: '/work',
				customEnvVars: {
					CLAUDE_CONFIG_DIR: '/Users/test/.claude',
					MAESTRO_CLAUDE_BIN: '/usr/local/bin/claude',
				},
			});
			expect(harness.setSnapshotFn).toHaveBeenCalledTimes(1);

			// (b) session.claudeInteractive flipped to api/limit
			const sessions = (harness.sessionsStore.get('sessions') ?? []) as Array<{
				id: string;
				claudeInteractive?: { mode: string; modeReason: string };
			}>;
			const updated = sessions.find((s) => s.id === 'tab-1');
			expect(updated?.claudeInteractive).toEqual({ mode: 'api', modeReason: 'limit' });

			// (c) process:claude-mode-resolved emitted with the new state
			const modeEvents = harness.sentEvents.filter(
				(e) => e.channel === 'process:claude-mode-resolved'
			);
			expect(modeEvents).toHaveLength(1);
			expect(modeEvents[0].args).toEqual([
				'tab-1',
				{ mode: 'api', reason: 'limit', configDirKey: '/Users/test/.claude' },
			]);

			// (d) processManager.spawn re-invoked with the api-mode config + original prompt + --resume
			expect(harness.spawn).toHaveBeenCalledTimes(1);
			const apiSpawnArg = harness.spawn.mock.calls[0][0];
			expect(apiSpawnArg.command).toBe('/usr/local/bin/claude');
			expect(apiSpawnArg.prompt).toBe('do the thing');
			expect(apiSpawnArg.args).toContain('--resume');
			expect(apiSpawnArg.args).toContain('claude-session-abc');

			// Cleanup callback invoked exactly once
			expect(onCleanup).toHaveBeenCalledTimes(1);

			// Context map is drained
			expect(__peekReplayContextForTests('tab-1')).toBeUndefined();
		});

		it('still attempts respawn when sampleUsage fails', async () => {
			const harness = createHarness({ sampleResult: null });

			registerInteractiveReplay('tab-1', buildContext(), harness.deps);

			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(harness.sampleUsageFn).toHaveBeenCalledTimes(1);
			// Null result = no snapshot to persist
			expect(harness.setSnapshotFn).not.toHaveBeenCalled();
			// Replay still happens (limit-hit handling must not depend on a fresh sample)
			expect(harness.spawn).toHaveBeenCalledTimes(1);
		});

		it('still attempts respawn when sampleUsage throws', async () => {
			const harness = createHarness();
			harness.sampleUsageFn.mockRejectedValueOnce(new Error('boom'));

			registerInteractiveReplay('tab-1', buildContext(), harness.deps);

			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(harness.setSnapshotFn).not.toHaveBeenCalled();
			expect(harness.spawn).toHaveBeenCalledTimes(1);
		});

		it('calls buildApiSpawnConfig at replay time (picks up latest captured agentSessionId)', async () => {
			const harness = createHarness();
			let latestSessionId = 'initial-claude-id';
			const builder = vi.fn(() => ({
				sessionId: 'tab-1',
				toolType: 'claude-code',
				cwd: '/work',
				command: '/usr/local/bin/claude',
				args: ['--print', '--resume', latestSessionId],
				prompt: 'do the thing',
			}));

			registerInteractiveReplay(
				'tab-1',
				buildContext({ buildApiSpawnConfig: builder }),
				harness.deps
			);

			// Simulate a mid-turn agentSessionId discovery before the limit-hit
			latestSessionId = 'discovered-mid-turn';

			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(builder).toHaveBeenCalledTimes(1);
			const apiSpawnArg = harness.spawn.mock.calls[0][0];
			expect(apiSpawnArg.args).toContain('discovered-mid-turn');
		});

		it('emits api/limit mode event even if sessionsStore write fails', async () => {
			const harness = createHarness({ initialSessions: { sessions: [] } });

			registerInteractiveReplay('tab-1', buildContext(), harness.deps);

			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// Session not found → no write, but the event still fires + spawn still happens.
			const modeEvents = harness.sentEvents.filter(
				(e) => e.channel === 'process:claude-mode-resolved'
			);
			expect(modeEvents).toHaveLength(1);
			expect(harness.spawn).toHaveBeenCalledTimes(1);
		});
	});

	describe('non-limit exit codes', () => {
		it('does NOT respawn or refresh on exit code 0', async () => {
			const harness = createHarness();
			const onCleanup = vi.fn();

			registerInteractiveReplay('tab-1', buildContext({ onCleanup }), harness.deps);

			harness.processManager.emit('exit', 'tab-1', 0);
			await new Promise((r) => setImmediate(r));

			expect(harness.sampleUsageFn).not.toHaveBeenCalled();
			expect(harness.setSnapshotFn).not.toHaveBeenCalled();
			expect(harness.spawn).not.toHaveBeenCalled();
			expect(harness.sentEvents).toHaveLength(0);

			// Session state is untouched
			const sessions = (harness.sessionsStore.get('sessions') ?? []) as Array<{
				id: string;
				claudeInteractive?: { mode: string; modeReason: string };
			}>;
			expect(sessions.find((s) => s.id === 'tab-1')?.claudeInteractive).toEqual({
				mode: 'interactive',
				modeReason: 'auto',
			});

			// Cleanup still runs (one-shot listener removed)
			expect(onCleanup).toHaveBeenCalledTimes(1);
			expect(__peekReplayContextForTests('tab-1')).toBeUndefined();
		});

		it('does NOT respawn on exit code 1', async () => {
			const harness = createHarness();
			registerInteractiveReplay('tab-1', buildContext(), harness.deps);
			harness.processManager.emit('exit', 'tab-1', 1);
			await new Promise((r) => setImmediate(r));
			expect(harness.spawn).not.toHaveBeenCalled();
		});

		it('does NOT respawn on exit code 3 (maestro-p timeout)', async () => {
			const harness = createHarness();
			registerInteractiveReplay('tab-1', buildContext(), harness.deps);
			harness.processManager.emit('exit', 'tab-1', 3);
			await new Promise((r) => setImmediate(r));
			expect(harness.spawn).not.toHaveBeenCalled();
		});
	});

	describe('sessionId scoping', () => {
		it('ignores exit events for other sessions', async () => {
			const harness = createHarness();
			registerInteractiveReplay('tab-1', buildContext(), harness.deps);

			// Different session also exits with code 2 — must not trigger
			harness.processManager.emit('exit', 'tab-2', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			expect(harness.spawn).not.toHaveBeenCalled();
			expect(__peekReplayContextForTests('tab-1')).toBeDefined();

			// Our session exits cleanly → cleanup runs
			harness.processManager.emit('exit', 'tab-1', 0);
			await new Promise((r) => setImmediate(r));
			expect(__peekReplayContextForTests('tab-1')).toBeUndefined();
		});

		it('only fires once even if multiple exits arrive for the same session', async () => {
			const harness = createHarness();
			registerInteractiveReplay('tab-1', buildContext(), harness.deps);

			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(harness.spawn).toHaveBeenCalledTimes(1);
		});
	});

	describe('clearInteractiveReplay', () => {
		it('drops context and removes the listener without firing the replay', async () => {
			const harness = createHarness();
			const onCleanup = vi.fn();
			registerInteractiveReplay('tab-1', buildContext({ onCleanup }), harness.deps);

			clearInteractiveReplay('tab-1', { processManager: harness.processManager });
			expect(onCleanup).toHaveBeenCalledTimes(1);
			expect(__peekReplayContextForTests('tab-1')).toBeUndefined();

			// Subsequent exit code 2 must NOT trigger replay
			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			expect(harness.spawn).not.toHaveBeenCalled();
		});
	});

	describe('re-registration', () => {
		it('replaces the prior listener and context when registered twice', async () => {
			const harness = createHarness();
			const onCleanupA = vi.fn();
			const onCleanupB = vi.fn();
			const builderA = vi.fn(buildApiSpawnConfigStub({ prompt: 'first' }));
			const builderB = vi.fn(buildApiSpawnConfigStub({ prompt: 'second' }));

			registerInteractiveReplay(
				'tab-1',
				buildContext({ buildApiSpawnConfig: builderA, onCleanup: onCleanupA }),
				harness.deps
			);
			registerInteractiveReplay(
				'tab-1',
				buildContext({ buildApiSpawnConfig: builderB, onCleanup: onCleanupB }),
				harness.deps
			);

			harness.processManager.emit('exit', 'tab-1', MAESTRO_P_LIMIT_EXIT_CODE);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// Only the most recent builder/cleanup fires.
			expect(builderA).not.toHaveBeenCalled();
			expect(builderB).toHaveBeenCalledTimes(1);
			expect(onCleanupB).toHaveBeenCalledTimes(1);
			expect(harness.spawn).toHaveBeenCalledTimes(1);
			expect(harness.spawn.mock.calls[0][0].prompt).toBe('second');
		});
	});
});
