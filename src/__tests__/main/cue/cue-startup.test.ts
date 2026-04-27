/**
 * Tests for the app.startup Cue event type.
 *
 * Tests cover:
 * - Fires on system startup (isSystemBoot=true)
 * - Does NOT fire on user feature toggle (isSystemBoot=false)
 * - Deduplication on YAML hot-reload (refreshSession)
 * - Does NOT re-fire on engine stop/start with user-toggle reason
 * - Re-fires after stop+start with system-boot reason (dedup cleared on stop)
 * - Fires via refreshSession for sessions discovered after system-boot start
 * - Dedup prevents re-fire via refreshSession for already-initialized sessions
 * - Does NOT fire via refreshSession when engine started with user-toggle
 * - Fires again on next system boot after removeSession
 * - enabled: false is respected
 * - agent_id binding is respected
 * - Filter matching
 * - Fan-out dispatch
 * - Chaining with agent.completed
 * - Multiple startup subs per session
 * - Multiple sessions each fire independently
 * - Event payload contains reason: 'system_startup'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => {
		const config = mockLoadCueConfig(args[0] as string);
		return config
			? { ok: true as const, config, warnings: [] as string[] }
			: { ok: false as const, reason: 'missing' as const };
	},
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
	findAncestorCueConfigRoot: () => null,
	findAncestorCueConfigRoots: () => [],
}));

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

// Mock the GitHub poller
const mockCreateCueGitHubPoller = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (...args: unknown[]) => mockCreateCueGitHubPoller(args[0]),
}));

// Mock the task scanner
const mockCreateCueTaskScanner = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: (...args: unknown[]) => mockCreateCueTaskScanner(args[0]),
}));

// Mock the database
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	pruneCueEvents: vi.fn(),
	isCueDbReady: () => true,
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
}));

// Mock reconciler
vi.mock('../../../main/cue/cue-reconciler', () => ({
	reconcileMissedTimeEvents: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

describe('CueEngine app.startup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatchCueYaml.mockReturnValue(vi.fn());
		mockCreateCueFileWatcher.mockReturnValue(vi.fn());
		mockCreateCueGitHubPoller.mockReturnValue(vi.fn());
		mockCreateCueTaskScanner.mockReturnValue(vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createStartupConfig(overrides: Partial<CueConfig['subscriptions'][0]> = {}): CueConfig {
		return createMockConfig({
			subscriptions: [
				{
					name: 'init-workspace',
					event: 'app.startup',
					enabled: true,
					prompt: 'Set up workspace',
					...overrides,
				},
			],
		});
	}

	it('fires on system startup (isSystemBoot=true)', async () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1',
				subscriptionName: 'init-workspace',
				prompt: 'Set up workspace',
				event: expect.objectContaining({
					type: 'app.startup',
					triggerName: 'init-workspace',
				}),
			})
		);

		engine.stop();
	});

	it('does NOT fire when start() is called with default user-toggle reason', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start(); // no argument — defaults to 'user-toggle'; app.startup does not fire

		expect(deps.onCueRun).not.toHaveBeenCalled();

		engine.stop();
	});

	it('fires on IPC-driven user toggle (cue:enable calls start with system-boot)', () => {
		// The cue:enable IPC handler calls requireEngine().start('system-boot'),
		// so enabling Cue from the UI should fire app.startup subscriptions just
		// like a real Electron launch.
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot'); // mirrors what cue:enable does via IPC

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1',
				subscriptionName: 'init-workspace',
				event: expect.objectContaining({ type: 'app.startup' }),
			})
		);

		engine.stop();
	});

	it('does not re-fire on refreshSession (YAML hot-reload)', async () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		// Simulate YAML hot-reload
		engine.refreshSession('session-1', '/projects/test');

		// Should still be only 1 call — deduplication prevents re-fire
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('does NOT re-fire when stop/start uses default user-toggle reason', async () => {
		// This validates direct engine.start() calls that omit the reason argument
		// (defaulting to 'user-toggle'). Note: the cue:enable IPC handler passes
		// 'system-boot' explicitly, so the IPC-driven path DOES re-fire — see the
		// 'fires on IPC-driven user toggle' test above.
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);

		engine.start('system-boot');
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
		engine.start(); // no argument — 'user-toggle' reason; app.startup check is skipped

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('fires again on next system boot after removeSession', async () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		// Wait for the first run to complete so concurrency slot is free
		await vi.advanceTimersByTimeAsync(100);

		// Remove session — clears startup fired keys for that session
		engine.removeSession('session-1');

		// Simulate a new system boot cycle
		engine.stop();
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(2);

		engine.stop();
	});

	it('respects enabled: false', () => {
		const config = createStartupConfig({ enabled: false });
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).not.toHaveBeenCalled();

		engine.stop();
	});

	it('respects agent_id binding — skips if agent_id does not match session', () => {
		const config = createStartupConfig({ agent_id: 'other-session' });
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).not.toHaveBeenCalled();

		engine.stop();
	});

	it('fires when agent_id matches session', () => {
		const config = createStartupConfig({ agent_id: 'session-1' });
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('respects filter — does not fire when filter does not match', () => {
		const config = createStartupConfig({
			filter: { reason: 'nonexistent_reason' },
		});
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).not.toHaveBeenCalled();
		expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		engine.stop();
	});

	it('fires when filter matches', () => {
		const config = createStartupConfig({
			filter: { reason: 'system_startup' },
		});
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('works with fan_out — dispatches to all targets', async () => {
		const session1 = createMockSession({ id: 'session-1', name: 'Main' });
		const session2 = createMockSession({ id: 'session-2', name: 'Worker-A' });
		const session3 = createMockSession({ id: 'session-3', name: 'Worker-B' });

		const config = createMockConfig({
			subscriptions: [
				{
					name: 'fan-out-init',
					event: 'app.startup',
					enabled: true,
					prompt: 'Initialize',
					fan_out: ['Worker-A', 'Worker-B'],
				},
			],
		});
		mockLoadCueConfig.mockImplementation((root) => {
			return root === '/projects/test' ? config : null;
		});

		const deps = createMockDeps({
			getSessions: vi.fn(() => [session1, session2, session3]),
		});
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		// Fan-out dispatches to both targets
		expect(deps.onCueRun).toHaveBeenCalledTimes(2);
		expect(deps.onCueRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2' }));
		expect(deps.onCueRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-3' }));

		engine.stop();
	});

	it('chains with agent.completed', async () => {
		const session1 = createMockSession({ id: 'session-1', name: 'Initializer' });
		const session2 = createMockSession({
			id: 'session-2',
			name: 'Post-Init',
			projectRoot: '/projects/test2',
		});

		const config1 = createMockConfig({
			subscriptions: [
				{
					name: 'startup-trigger',
					event: 'app.startup',
					enabled: true,
					prompt: 'Initialize workspace',
				},
			],
		});

		const config2 = createMockConfig({
			subscriptions: [
				{
					name: 'post-init',
					event: 'agent.completed',
					enabled: true,
					prompt: 'Run post-init tasks',
					source_session: 'Initializer',
				},
			],
		});

		mockLoadCueConfig.mockImplementation((root) => {
			if (root === '/projects/test') return config1;
			if (root === '/projects/test2') return config2;
			return null;
		});

		const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => ({
			runId: request.runId,
			sessionId: request.sessionId,
			sessionName: request.sessionId === 'session-1' ? 'Initializer' : 'Post-Init',
			subscriptionName: request.subscriptionName,
			event: request.event,
			status: 'completed' as const,
			stdout: 'done',
			stderr: '',
			exitCode: 0,
			durationMs: 50,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		}));

		const deps = createMockDeps({
			getSessions: vi.fn(() => [session1, session2]),
			onCueRun,
		});
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1',
				subscriptionName: 'startup-trigger',
			})
		);

		await vi.advanceTimersByTimeAsync(100);

		expect(onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-2',
				subscriptionName: 'post-init',
			})
		);

		engine.stop();
	});

	it('multiple startup subs per session each fire independently', async () => {
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'init-deps',
					event: 'app.startup',
					enabled: true,
					prompt: 'Install dependencies',
				},
				{
					name: 'init-env',
					event: 'app.startup',
					enabled: true,
					prompt: 'Check environment',
				},
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 2,
				queue_size: 10,
			},
		});
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		await vi.advanceTimersByTimeAsync(100);

		expect(deps.onCueRun).toHaveBeenCalledTimes(2);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({ subscriptionName: 'init-deps' })
		);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({ subscriptionName: 'init-env' })
		);

		engine.stop();
	});

	it('startup across multiple sessions fires independently', () => {
		const session1 = createMockSession({ id: 'session-1', name: 'Agent A', projectRoot: '/proj1' });
		const session2 = createMockSession({ id: 'session-2', name: 'Agent B', projectRoot: '/proj2' });

		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps({
			getSessions: vi.fn(() => [session1, session2]),
		});
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledTimes(2);
		expect(deps.onCueRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
		expect(deps.onCueRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2' }));

		engine.stop();
	});

	it('event payload contains reason: system_startup', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					type: 'app.startup',
					payload: expect.objectContaining({ reason: 'system_startup' }),
				}),
			})
		);

		engine.stop();
	});

	it('does not prevent system sleep via schedule reason', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const onPreventSleep = vi.fn();
		const deps = createMockDeps({ onPreventSleep });
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		const scheduleCalls = onPreventSleep.mock.calls.filter(
			(args: unknown[]) =>
				typeof args[0] === 'string' && (args[0] as string).startsWith('cue:schedule:')
		);
		expect(scheduleCalls).toHaveLength(0);

		engine.stop();
	});

	it('logs trigger message', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onLog).toHaveBeenCalledWith(
			'cue',
			expect.stringContaining('"init-workspace" triggered (app.startup)')
		);

		engine.stop();
	});

	it('does not fire when engine is not enabled', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		// Don't call start() — engine is disabled

		expect(deps.onCueRun).not.toHaveBeenCalled();
	});

	it('re-fires on second system-boot start after stop (startup dedup keys cleared on stop)', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);

		// First system boot
		engine.start('system-boot');
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		// stop() clears startup dedup keys; starting again as system-boot re-fires
		engine.stop();
		engine.start('system-boot');
		expect(deps.onCueRun).toHaveBeenCalledTimes(2);

		engine.stop();
	});

	// ── Late-discovery (boot scenario) regression tests ─────────────────────────
	// At real app startup getSessions() is empty when start('system-boot') fires,
	// because sessions are managed by the renderer and haven't synced yet.
	// Sessions arrive later via refreshSession(). These tests verify that startup
	// triggers still fire for those late-arriving sessions.

	it('fires via refreshSession for session discovered after system-boot start', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		// No sessions at boot time
		const session = createMockSession();
		const getSessions = vi.fn(() => [] as ReturnType<typeof createMockSession>[]);
		const deps = createMockDeps({ getSessions });
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		expect(deps.onCueRun).not.toHaveBeenCalled();

		// Session arrives via renderer discovery
		getSessions.mockReturnValue([session]);
		engine.refreshSession('session-1', '/projects/test');

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1',
				subscriptionName: 'init-workspace',
			})
		);

		engine.stop();
	});

	it('dedup prevents app.startup re-fire via refreshSession for already-initialized session', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const session = createMockSession();
		const getSessions = vi.fn(() => [] as ReturnType<typeof createMockSession>[]);
		const deps = createMockDeps({ getSessions });
		const engine = new CueEngine(deps);
		engine.start('system-boot');

		getSessions.mockReturnValue([session]);
		engine.refreshSession('session-1', '/projects/test');
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		// Second refresh (e.g. YAML hot-reload) must not re-fire via dedup
		engine.refreshSession('session-1', '/projects/test');
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('does not fire app.startup via refreshSession when engine started with user-toggle', () => {
		const config = createStartupConfig();
		mockLoadCueConfig.mockReturnValue(config);

		const session = createMockSession();
		const getSessions = vi.fn(() => [] as ReturnType<typeof createMockSession>[]);
		const deps = createMockDeps({ getSessions });
		const engine = new CueEngine(deps);
		engine.start(); // user-toggle default — no startReason set

		getSessions.mockReturnValue([session]);
		engine.refreshSession('session-1', '/projects/test');

		expect(deps.onCueRun).not.toHaveBeenCalled();

		engine.stop();
	});
});
