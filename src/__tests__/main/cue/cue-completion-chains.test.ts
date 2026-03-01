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
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
}));

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';

function createMockSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
		...overrides,
	};
}

function createMockConfig(overrides: Partial<CueConfig> = {}): CueConfig {
	return {
		subscriptions: [],
		settings: { timeout_minutes: 30, timeout_on_fail: 'break' },
		...overrides,
	};
}

function createMockDeps(overrides: Partial<CueEngineDeps> = {}): CueEngineDeps {
	return {
		getSessions: vi.fn(() => [createMockSession()]),
		onCueRun: vi.fn(async () => ({
			runId: 'run-1',
			sessionId: 'session-1',
			sessionName: 'Test Session',
			subscriptionName: 'test',
			event: {} as CueEvent,
			status: 'completed' as const,
			stdout: 'output',
			stderr: '',
			exitCode: 0,
			durationMs: 100,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		})),
		onLog: vi.fn(),
		...overrides,
	};
}

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
				'session-1',
				'follow up',
				expect.objectContaining({
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
				})
			);

			engine.stop();
		});

		it('truncates sourceOutput to 5000 chars', () => {
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

			const call = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0];
			const event = call[2] as CueEvent;
			expect((event.payload.sourceOutput as string).length).toBe(5000);

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
				'session-1',
				'follow up',
				expect.objectContaining({
					type: 'agent.completed',
					triggerName: 'on-alpha-done',
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
						event: 'time.interval',
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
				'session-1',
				'do work',
				expect.objectContaining({ type: 'time.interval' })
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				'session-2',
				'follow up',
				expect.objectContaining({ type: 'agent.completed', triggerName: 'chain' })
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
				'session-2',
				'deploy',
				expect.objectContaining({
					payload: expect.objectContaining({ fanOutSource: 'trigger-session', fanOutIndex: 0 }),
				})
			);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				'session-3',
				'deploy',
				expect.objectContaining({
					payload: expect.objectContaining({ fanOutSource: 'trigger-session', fanOutIndex: 1 }),
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
				'session-1',
				'aggregate',
				expect.objectContaining({
					payload: expect.objectContaining({
						sourceOutput: 'output-a\n---\noutput-b',
						sourceSession: 'Agent A, Agent B',
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
				settings: { timeout_minutes: 1, timeout_on_fail: 'break' },
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
				settings: { timeout_minutes: 1, timeout_on_fail: 'continue' },
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a', { stdout: 'partial-output' });

			vi.advanceTimersByTime(1 * 60 * 1000 + 100);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				'session-1',
				'aggregate',
				expect.objectContaining({
					payload: expect.objectContaining({
						partial: true,
						timedOutSessions: expect.arrayContaining(['agent-b']),
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
});
