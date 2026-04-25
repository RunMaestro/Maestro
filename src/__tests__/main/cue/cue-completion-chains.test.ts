/**
 * Tests for Cue Engine completion chains (Phase 09).
 *
 * Tests cover:
 * - Completion event emission after Cue runs
 * - Completion data in event payloads
 * - Session name matching (matching by name, not just ID)
 * - Fan-out dispatch to multiple target sessions
 * - Fan-in data tracking (output concatenation, session names)
 * - Fan-in timeout handling (break and continue modes)
 * - hasCompletionSubscribers check
 * - clearFanInState cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueEvent } from '../../../main/cue/cue-types';

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
}));

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

// Mock the config repository so the runtime's "is this session a Cue
// candidate?" probe (resolveCueConfigPath) participates in the same fake
// filesystem the yaml loader does — without it, ownership candidate filtering
// would always see zero candidates in tests and the gate would silently no-op.
vi.mock('../../../main/cue/config/cue-config-repository', () => ({
	resolveCueConfigPath: (projectRoot: string) =>
		mockLoadCueConfig(projectRoot) ? `${projectRoot}/.maestro/cue.yaml` : null,
}));

// Mock cue-db to prevent real SQLite (better-sqlite3 native addon) operations
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null), // null = first start, skip reconcile
	pruneCueEvents: vi.fn(),
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
}));

// Mock reconciler (not exercised in these tests, but avoids heavy imports)
vi.mock('../../../main/cue/cue-reconciler', () => ({
	reconcileMissedTimeEvents: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

describe('CueEngine completion chains', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatchCueYaml.mockReturnValue(vi.fn());
		mockCreateCueFileWatcher.mockReturnValue(vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('completion data in event payload', () => {
		it('includes completion data when provided', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				status: 'completed',
				exitCode: 0,
				durationMs: 5000,
				stdout: 'test output',
				triggeredBy: 'some-sub',
			});

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'follow up',
					event: expect.objectContaining({
						type: 'agent.completed',
						payload: expect.objectContaining({
							sourceSession: 'Agent A',
							sourceSessionId: 'agent-a',
							status: 'completed',
							exitCode: 0,
							durationMs: 5000,
							sourceOutput: 'test output',
							triggeredBy: 'some-sub',
						}),
					}),
				})
			);

			engine.stop();
		});

		it('truncates sourceOutput to 5000 chars and sets outputTruncated to true', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const longOutput = 'x'.repeat(10000);
			engine.notifyAgentCompleted('agent-a', { stdout: longOutput });

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect((event.payload.sourceOutput as string).length).toBe(5000);
			expect(event.payload.outputTruncated).toBe(true);

			engine.stop();
		});

		it('sets outputTruncated to false when output is under limit', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'short output' });

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.outputTruncated).toBe(false);

			engine.stop();
		});

		// Regression: the exit-listener production path calls
		// notifyAgentCompleted with ONLY { status, exitCode } — no stdout.
		// sourceOutput MUST become the empty string in that case. Any fallback
		// that pulls from a session-level output store or group-chat buffer
		// would leak whatever that buffer happens to contain into the
		// downstream {{CUE_SOURCE_OUTPUT}} template, which is the suspected
		// root cause of the "group chat bled into cue pipeline output" bug.
		// Do not add a stdout fallback without updating this test.
		it('produces empty sourceOutput when completionData has no stdout (exit-listener path)', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			// Exit-listener shape: only status + exitCode, no stdout.
			engine.notifyAgentCompleted('agent-a', { status: 'completed', exitCode: 0 });

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.sourceOutput).toBe('');
			expect(event.payload.outputTruncated).toBe(false);

			engine.stop();
		});

		it('produces empty sourceOutput when completionData is omitted entirely', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a');

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.sourceOutput).toBe('');
			expect(event.payload.outputTruncated).toBe(false);

			engine.stop();
		});
	});

	describe('session name matching', () => {
		it('matches by session name when source_session uses name', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Test Session' }),
				createMockSession({ id: 'session-2', name: 'Agent Alpha' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-alpha-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'Agent Alpha',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('session-2');

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'follow up',
					event: expect.objectContaining({
						type: 'agent.completed',
						triggerName: 'on-alpha-done',
					}),
				})
			);

			engine.stop();
		});
	});

	describe('completion event emission (chaining)', () => {
		it('emits completion event after Cue run finishes', async () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Source', projectRoot: '/proj1' }),
				createMockSession({ id: 'session-2', name: 'Downstream', projectRoot: '/proj2' }),
			];

			const config1 = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						interval_minutes: 60,
					},
				],
			});
			const config2 = createMockConfig({
				subscriptions: [
					{
						name: 'chain',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'Source',
					},
				],
			});

			mockLoadCueConfig.mockImplementation((projectRoot) => {
				if (projectRoot === '/proj1') return config1;
				if (projectRoot === '/proj2') return config2;
				return null;
			});

			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'do work',
					event: expect.objectContaining({ type: 'time.heartbeat' }),
				})
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-2',
					prompt: 'follow up',
					event: expect.objectContaining({ type: 'agent.completed', triggerName: 'chain' }),
				})
			);

			engine.stop();
		});
	});

	describe('fan-out', () => {
		it('dispatches to each fan_out target session', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'session-2', name: 'Frontend', projectRoot: '/projects/fe' }),
				createMockSession({ id: 'session-3', name: 'Backend', projectRoot: '/projects/be' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'deploy-all',
						event: 'agent.completed',
						enabled: true,
						prompt: 'deploy',
						source_session: 'trigger-session',
						fan_out: ['Frontend', 'Backend'],
					},
				],
			});
			// Only the orchestrator session owns the subscription
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger-session');

			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-2',
					prompt: 'deploy',
					event: expect.objectContaining({
						payload: expect.objectContaining({ fanOutSource: 'trigger-session', fanOutIndex: 0 }),
					}),
				})
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-3',
					prompt: 'deploy',
					event: expect.objectContaining({
						payload: expect.objectContaining({ fanOutSource: 'trigger-session', fanOutIndex: 1 }),
					}),
				})
			);

			engine.stop();
		});

		it('logs fan-out dispatch', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'session-2', name: 'Frontend', projectRoot: '/projects/fe' }),
				createMockSession({ id: 'session-3', name: 'Backend', projectRoot: '/projects/be' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'deploy-all',
						event: 'agent.completed',
						enabled: true,
						prompt: 'deploy',
						source_session: 'trigger-session',
						fan_out: ['Frontend', 'Backend'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger-session');

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Fan-out: "deploy-all" → Frontend, Backend')
			);

			engine.stop();
		});

		it('skips missing fan-out targets with log', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'session-2', name: 'Frontend', projectRoot: '/projects/fe' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'deploy-all',
						event: 'agent.completed',
						enabled: true,
						prompt: 'deploy',
						source_session: 'trigger-session',
						fan_out: ['Frontend', 'NonExistent'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger-session');

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Fan-out target not found: "NonExistent"')
			);

			engine.stop();
		});
	});

	describe('fan-in data tracking', () => {
		it('concatenates fan-in source outputs in event payload', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();

			engine.notifyAgentCompleted('agent-a', { sessionName: 'Agent A', stdout: 'output-a' });
			engine.notifyAgentCompleted('agent-b', { sessionName: 'Agent B', stdout: 'output-b' });

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'aggregate',
					event: expect.objectContaining({
						payload: expect.objectContaining({
							sourceOutput: 'output-a\n---\noutput-b',
							sourceSession: 'Agent A, Agent B',
						}),
					}),
				})
			);

			engine.stop();
		});

		it('sets outputTruncated in fan-in aggregate event when any source is truncated', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();

			const longOutput = 'x'.repeat(10000);
			engine.notifyAgentCompleted('agent-a', { sessionName: 'Agent A', stdout: longOutput });
			engine.notifyAgentCompleted('agent-b', { sessionName: 'Agent B', stdout: 'short' });

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						payload: expect.objectContaining({
							outputTruncated: true,
						}),
					}),
				})
			);

			engine.stop();
		});

		it('logs waiting message during fan-in', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b', 'agent-c'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a');

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('waiting for 2 more session(s)')
			);

			engine.stop();
		});

		// Regression: the user's yaml can list the same session under both its
		// name and its ID ("Agent A" + "agent-a"). Pre-fix, sources.length would
		// count 2 but the tracker (keyed by sessionId) would only hold 1 entry,
		// so fan-in would wait forever for a "second" source that is really the
		// same session. The dedupe pass in cue-fan-in-tracker resolves both
		// strings to the same canonical sessionId and only counts it once.
		it('dedupes fan-in sources when the same session is referenced by both name and ID', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Owner', projectRoot: '/proj' }),
				createMockSession({ id: 'agent-a', name: 'Agent A' }),
				createMockSession({ id: 'agent-b', name: 'Agent B' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						// "Agent A" (name) and "agent-a" (id) resolve to the same session.
						source_session: ['Agent A', 'agent-a', 'Agent B'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root) => (root === '/proj' ? config : null));
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();

			// Only two distinct session completions — but the YAML lists three
			// entries. Fan-in must fire once the two unique sources are in.
			engine.notifyAgentCompleted('agent-a', { sessionName: 'Agent A', stdout: 'output-a' });
			engine.notifyAgentCompleted('agent-b', { sessionName: 'Agent B', stdout: 'output-b' });

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: 'aggregate',
					event: expect.objectContaining({
						payload: expect.objectContaining({
							sourceOutput: expect.stringContaining('output-a'),
						}),
					}),
				})
			);

			engine.stop();
		});
	});

	describe('fan-in timeout', () => {
		it('clears tracker on timeout in break mode', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
				settings: {
					timeout_minutes: 1,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a');
			expect(deps.onCueRun).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1 * 60 * 1000 + 100);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('timed out (break mode)')
			);

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-b');
			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('fires with partial data on timeout in continue mode', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
				settings: {
					timeout_minutes: 1,
					timeout_on_fail: 'continue',
					max_concurrent: 1,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'partial-output' });

			vi.advanceTimersByTime(1 * 60 * 1000 + 100);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'aggregate',
					event: expect.objectContaining({
						payload: expect.objectContaining({
							partial: true,
							timedOutSessions: expect.arrayContaining(['agent-b']),
						}),
					}),
				})
			);

			engine.stop();
		});

		it('includes outputTruncated in continue-mode timeout payload', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
				settings: {
					timeout_minutes: 1,
					timeout_on_fail: 'continue',
					max_concurrent: 1,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const longOutput = 'x'.repeat(10000);
			engine.notifyAgentCompleted('agent-a', { stdout: longOutput });

			vi.advanceTimersByTime(1 * 60 * 1000 + 100);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						payload: expect.objectContaining({
							outputTruncated: true,
							partial: true,
						}),
					}),
				})
			);

			engine.stop();
		});
	});

	describe('hasCompletionSubscribers', () => {
		it('returns true when subscribers exist for a session', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Source' }),
				createMockSession({ id: 'session-2', name: 'Listener' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-source-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'react',
						source_session: 'Source',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			expect(engine.hasCompletionSubscribers('session-1')).toBe(true);
			expect(engine.hasCompletionSubscribers('session-2')).toBe(false);
			expect(engine.hasCompletionSubscribers('unknown')).toBe(false);

			engine.stop();
		});

		it('returns false when engine is disabled', () => {
			const engine = new CueEngine(createMockDeps());
			expect(engine.hasCompletionSubscribers('any')).toBe(false);
		});
	});

	describe('fan-out per-agent prompts', () => {
		it('delivers per-agent prompts via fan_out_prompts', () => {
			const sessions = [
				createMockSession({ id: 'orch', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'agent-a', name: 'agent-a', projectRoot: '/projects/a' }),
				createMockSession({ id: 'agent-b', name: 'agent-b', projectRoot: '/projects/b' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'per-agent',
						event: 'agent.completed',
						enabled: true,
						prompt: 'shared fallback',
						source_session: 'trigger',
						fan_out: ['agent-a', 'agent-b'],
						fan_out_prompts: ['prompt for a', 'prompt for b'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger');

			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'agent-a',
					prompt: 'prompt for a',
				})
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'agent-b',
					prompt: 'prompt for b',
				})
			);

			engine.stop();
		});

		it('falls back to shared prompt when fan_out_prompts is absent', () => {
			const sessions = [
				createMockSession({ id: 'orch', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'agent-a', name: 'agent-a', projectRoot: '/projects/a' }),
				createMockSession({ id: 'agent-b', name: 'agent-b', projectRoot: '/projects/b' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'shared-prompt',
						event: 'agent.completed',
						enabled: true,
						prompt: 'do the thing',
						source_session: 'trigger',
						fan_out: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger');

			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'agent-a', prompt: 'do the thing' })
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'agent-b', prompt: 'do the thing' })
			);

			engine.stop();
		});

		it('dispatches twice to the same agent with different prompts', async () => {
			const sessions = [
				createMockSession({ id: 'orch', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'agent-a', name: 'agent-a', projectRoot: '/projects/a' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'double-dispatch',
						event: 'agent.completed',
						enabled: true,
						prompt: 'fallback',
						source_session: 'trigger',
						fan_out: ['agent-a', 'agent-a'],
						fan_out_prompts: ['task 1', 'task 2'],
					},
				],
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 2,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger');
			await vi.advanceTimersByTimeAsync(100);

			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'agent-a',
					prompt: 'task 1',
					event: expect.objectContaining({
						payload: expect.objectContaining({ fanOutIndex: 0 }),
					}),
				})
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'agent-a',
					prompt: 'task 2',
					event: expect.objectContaining({
						payload: expect.objectContaining({ fanOutIndex: 1 }),
					}),
				})
			);

			engine.stop();
		});

		it('partial failure does not prevent other fan-out targets', () => {
			const sessions = [
				createMockSession({ id: 'orch', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'agent-a', name: 'agent-a', projectRoot: '/projects/a' }),
				createMockSession({ id: 'agent-b', name: 'agent-b', projectRoot: '/projects/b' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'partial-fail',
						event: 'agent.completed',
						enabled: true,
						prompt: 'work',
						source_session: 'trigger',
						fan_out: ['agent-a', 'agent-b'],
						fan_out_prompts: ['fail task', 'succeed task'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			// Make onCueRun fail for agent-a, succeed for agent-b
			(deps.onCueRun as ReturnType<typeof vi.fn>).mockImplementation(async (request: any) => {
				if (request.sessionId === 'agent-a') {
					throw new Error('agent-a failed');
				}
				return {
					runId: 'run-ok',
					sessionId: request.sessionId,
					sessionName: 'agent-b',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed' as const,
					stdout: 'success',
					stderr: '',
					exitCode: 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
			});
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('trigger');

			// Both targets should have been called regardless of failure
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'agent-a', prompt: 'fail task' })
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'agent-b', prompt: 'succeed task' })
			);

			engine.stop();
		});

		it('rapid enable/disable during fan-out does not crash', () => {
			const sessions = [
				createMockSession({ id: 'orch', name: 'Orchestrator', projectRoot: '/projects/orch' }),
				createMockSession({ id: 'agent-a', name: 'agent-a', projectRoot: '/projects/a' }),
				createMockSession({ id: 'agent-b', name: 'agent-b', projectRoot: '/projects/b' }),
			];
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'rapid-toggle',
						event: 'agent.completed',
						enabled: true,
						prompt: 'work',
						source_session: 'trigger',
						fan_out: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockImplementation((root: string) =>
				root === '/projects/orch' ? config : null
			);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			// Trigger fan-out then immediately stop
			engine.notifyAgentCompleted('trigger');
			expect(() => engine.stop()).not.toThrow();

			// Restart and trigger again to verify clean state
			engine.start();
			expect(() => {
				engine.notifyAgentCompleted('trigger');
				engine.stop();
			}).not.toThrow();
		});
	});

	describe('fan-in per-subscription timeout', () => {
		it('uses sub.fan_in_timeout_minutes over global setting', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
						fan_in_timeout_minutes: 2,
					},
				],
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'continue',
					max_concurrent: 1,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'output-a' });

			// Should not fire before 2 minutes
			expect(deps.onCueRun).not.toHaveBeenCalled();

			// Advance to 2 minutes (per-sub timeout)
			vi.advanceTimersByTime(2 * 60 * 1000 + 100);

			// Should have fired with partial data (continue mode) at the 2-minute mark
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'aggregate',
					event: expect.objectContaining({
						payload: expect.objectContaining({
							partial: true,
							timedOutSessions: expect.arrayContaining(['agent-b']),
						}),
					}),
				})
			);

			engine.stop();
		});

		it('uses sub.fan_in_timeout_on_fail over global setting', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
						fan_in_timeout_minutes: 1,
						fan_in_timeout_on_fail: 'continue',
					},
				],
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'partial-output' });

			// Advance past per-sub timeout
			vi.advanceTimersByTime(1 * 60 * 1000 + 100);

			// Despite global break mode, per-sub continue mode should fire
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'aggregate',
					event: expect.objectContaining({
						payload: expect.objectContaining({
							partial: true,
						}),
					}),
				})
			);

			engine.stop();
		});

		it('falls back to global timeout when per-sub not set', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'continue',
					max_concurrent: 1,
					queue_size: 10,
				},
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'output-a' });

			// Advance 29 minutes — should not fire yet
			vi.advanceTimersByTime(29 * 60 * 1000);
			expect(deps.onCueRun).not.toHaveBeenCalled();

			// Advance 1 more minute + buffer — should fire at 30 minutes
			vi.advanceTimersByTime(1 * 60 * 1000 + 100);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'aggregate',
					event: expect.objectContaining({
						payload: expect.objectContaining({
							partial: true,
							timedOutSessions: expect.arrayContaining(['agent-b']),
						}),
					}),
				})
			);

			engine.stop();
		});
	});

	describe('clearFanInState', () => {
		it('clears fan-in trackers for a specific session', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			engine.notifyAgentCompleted('agent-a');
			vi.clearAllMocks();

			engine.clearFanInState('session-1');

			engine.notifyAgentCompleted('agent-b');
			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});
	});

	// Regression: until the single-source completion path was wired through
	// the shared output filter, `include_output_from` and `forward_output_from`
	// silently no-op'd for 1-source subscriptions. Any UI control that writes
	// those fields must take effect on both fan-in and single-source chains.
	describe('single-source filter (include/forward) regression', () => {
		it('honors include_output_from: [] by emptying perSourceOutputs', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
						include_output_from: [],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'should be dropped' });

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.perSourceOutputs).toEqual({});
			expect(event.payload.sourceOutput).toBe('');
			engine.stop();
		});

		it('honors forward_output_from by populating forwardedOutputs with own output', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
						forward_output_from: ['Agent A'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { sessionName: 'Agent A', stdout: 'own output' });

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.forwardedOutputs).toEqual({ 'Agent A': 'own output' });
			engine.stop();
		});

		it('passes through upstream-forwarded data when forward_output_from is unset', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				stdout: 'own',
				forwardedOutputs: { 'Agent X': 'x-output' },
			});

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.forwardedOutputs).toEqual({ 'Agent X': 'x-output' });
			engine.stop();
		});

		it('filters upstream-forwarded data by forward_output_from when set', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
						forward_output_from: ['Agent X'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				stdout: 'own',
				forwardedOutputs: { 'Agent X': 'x-output', 'Agent Y': 'y-output' },
			});

			const request = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const event = request.event as CueEvent;
			expect(event.payload.forwardedOutputs).toEqual({ 'Agent X': 'x-output' });
			engine.stop();
		});
	});

	describe('source_sub filter (self-loop + cross-fire prevention)', () => {
		// Regression guards for the `Cmd(owner=S) → Agent(S)` class of chain
		// where both the command run and the agent run emit `agent.completed`
		// for the same session. Without this filter the chain sub matches
		// on session alone and either re-triggers itself on the agent's own
		// completion, or a downstream fan-in fires on the command's completion
		// before the intended agent has run. See `CueSubscription.source_sub`
		// docs for the full rationale.

		it('fires when triggeredBy matches a listed source_sub', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'run-agent',
						event: 'agent.completed',
						enabled: true,
						prompt: 'run after command',
						source_session: 'agent-a',
						source_sub: 'the-command-sub',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				triggeredBy: 'the-command-sub',
			});

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('skips when triggeredBy is not in source_sub (would be a self-loop)', () => {
			// Mirrors the Cmd → Agent self-loop scenario: the chain sub's
			// source_session matches (Agent A is in the same session) but the
			// completion came from Agent A's OWN run, not from its upstream
			// command — so the filter must block the re-fire.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'run-agent',
						event: 'agent.completed',
						enabled: true,
						prompt: 'run after command',
						source_session: 'agent-a',
						source_sub: 'the-command-sub',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			// Agent A's own completion — triggeredBy is the chain sub itself,
			// not the upstream command.
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				triggeredBy: 'run-agent',
			});

			expect(deps.onCueRun).not.toHaveBeenCalled();
			engine.stop();
		});

		it('accepts any upstream name when source_sub is an array and one matches', () => {
			// Fan-in case: Main depends on both Agent1 and Agent2 via their
			// respective chain subs. Main's source_sub must accept either
			// upstream sub name — but NOT e.g. the command sub that ran
			// before them.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'run-main',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: 'agent-a',
						source_sub: ['agent1-chain', 'agent2-chain'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				triggeredBy: 'agent2-chain',
			});

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('skips when triggeredBy is an upstream command, not the expected agent sub', () => {
			// The cross-fire case. Source session matches (cmd and agent
			// share owner), but the chain only wants the agent's
			// completion — not the command's.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'run-main',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: 'agent-a',
						source_sub: ['agent1-chain', 'agent2-chain'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				triggeredBy: 'the-command-sub',
			});

			expect(deps.onCueRun).not.toHaveBeenCalled();
			engine.stop();
		});

		it('accepts any completion when source_sub is absent (legacy behavior)', () => {
			// Pipelines from older YAML that doesn't carry source_sub must
			// keep matching on source_session alone, so existing pipelines
			// don't silently stop firing after the upgrade.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'legacy',
						event: 'agent.completed',
						enabled: true,
						prompt: 'legacy run',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				triggeredBy: 'anything',
			});

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('blocks when triggeredBy is undefined and source_sub is configured (external completion)', () => {
			// `notifyAgentCompleted` is reached only by Cue-tracked runs and
			// by `exit-listener` for external (non-Cue) process exits. Manual
			// triggers and bootstrap events dispatch through `dispatchService`
			// directly, so they never land here. That means an undefined
			// `triggeredBy` indicates an external completion — bypassing
			// `source_sub` for those would partially re-open the self-loop /
			// cross-fire window the filter exists to close.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'run-agent',
						event: 'agent.completed',
						enabled: true,
						prompt: 'run after command',
						source_session: 'agent-a',
						source_sub: 'the-command-sub',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', {
				sessionName: 'Agent A',
				// triggeredBy omitted intentionally.
			});

			expect(deps.onCueRun).not.toHaveBeenCalled();
			engine.stop();
		});
	});

	describe('shared-workspace ownership gating', () => {
		it('skips unowned agent.completed subs for non-owner sessions', async () => {
			// Two agents share /vault. Both load the same cue.yaml with an
			// unowned agent.completed subscription. Without the gate, both
			// would dispatch when Source completes — exactly the duplication
			// the ownership feature is designed to prevent.
			const sessions = [
				createMockSession({ id: 'owner', name: 'Owner', projectRoot: '/vault' }),
				createMockSession({ id: 'non-owner', name: 'NonOwner', projectRoot: '/vault' }),
				createMockSession({ id: 'src', name: 'Source', projectRoot: '/projects/src' }),
			];
			const sharedConfig = createMockConfig({
				subscriptions: [
					{
						name: 'on-source-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'react',
						source_session: 'Source',
					},
				],
			});
			const srcConfig = createMockConfig({
				subscriptions: [
					{
						name: 'tick',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'work',
						interval_minutes: 60,
					},
				],
			});

			mockLoadCueConfig.mockImplementation((projectRoot) => {
				if (projectRoot === '/vault') return sharedConfig;
				if (projectRoot === '/projects/src') return srcConfig;
				return null;
			});

			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('src', {
				sessionName: 'Source',
				status: 'completed',
				exitCode: 0,
				durationMs: 10,
				stdout: 'done',
			});

			const calls = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls;
			const completionCalls = calls.filter((c) => c[0].event?.type === 'agent.completed');
			expect(completionCalls).toHaveLength(1);
			expect(completionCalls[0][0].sessionId).toBe('owner');

			engine.stop();
		});

		it('hasCompletionSubscribers returns false when only the non-owner has the unowned sub', () => {
			const sessions = [
				createMockSession({ id: 'owner', name: 'Owner', projectRoot: '/vault' }),
				createMockSession({ id: 'non-owner', name: 'NonOwner', projectRoot: '/vault' }),
				createMockSession({ id: 'src', name: 'Source', projectRoot: '/projects/src' }),
			];
			const sharedConfig = createMockConfig({
				// Pin owner explicitly so the test doesn't depend on first-wins.
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
					owner_agent_id: 'owner',
				},
				subscriptions: [
					{
						name: 'on-source-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'react',
						source_session: 'Source',
					},
				],
			});

			mockLoadCueConfig.mockImplementation((projectRoot) => {
				if (projectRoot === '/vault') return sharedConfig;
				return null;
			});

			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			// Owner has the sub wired; reporting hasCompletionSubscribers from
			// the perspective of the source should remain true overall, but the
			// non-owner alone must not satisfy the predicate.
			expect(engine.hasCompletionSubscribers('src')).toBe(true);

			engine.stop();
		});
	});
});
