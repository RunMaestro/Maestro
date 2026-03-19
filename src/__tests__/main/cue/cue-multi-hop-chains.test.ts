/**
 * Tests for CueEngine multi-hop completion chains and circular chain detection.
 *
 * Tests cover:
 * - Multi-hop chains (A -> B -> C)
 * - Stdout propagation through chains
 * - Failed middle step with filters
 * - Circular chain detection (A -> B -> A)
 * - Self-referencing subscription detection
 * - Fan-in -> fan-out combination
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

// Mock cue-db
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	pruneCueEvents: vi.fn(),
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
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
		settings: { timeout_minutes: 30, timeout_on_fail: 'break', max_concurrent: 1, queue_size: 10 },
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
		})) as CueEngineDeps['onCueRun'],
		onLog: vi.fn(),
		...overrides,
	};
}

describe('CueEngine multi-hop completion chains', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatchCueYaml.mockReturnValue(vi.fn());
		mockCreateCueFileWatcher.mockReturnValue(vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('A -> B -> C chain executes all 3 with correct payloads', async () => {
		const sessions = [
			createMockSession({
				id: 'source',
				name: 'Source',
				cwd: '/proj/source',
				projectRoot: '/proj/source',
			}),
			createMockSession({
				id: 'middle',
				name: 'Middle',
				cwd: '/proj/middle',
				projectRoot: '/proj/middle',
			}),
			createMockSession({
				id: 'downstream',
				name: 'Downstream',
				cwd: '/proj/downstream',
				projectRoot: '/proj/downstream',
			}),
		];

		const configSource = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat-source',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do source work',
					interval_minutes: 60,
				},
			],
		});
		const configMiddle = createMockConfig({
			subscriptions: [
				{
					name: 'on-source-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'do middle work',
					source_session: 'Source',
				},
			],
		});
		const configDownstream = createMockConfig({
			subscriptions: [
				{
					name: 'on-middle-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'do downstream work',
					source_session: 'Middle',
				},
			],
		});

		mockLoadCueConfig.mockImplementation((projectRoot) => {
			if (projectRoot === '/proj/source') return configSource;
			if (projectRoot === '/proj/middle') return configMiddle;
			if (projectRoot === '/proj/downstream') return configDownstream;
			return null;
		});

		const onCueRun = vi.fn(
			async (request: {
				runId: string;
				sessionId: string;
				prompt: string;
				subscriptionName: string;
				event: CueEvent;
				timeoutMs: number;
			}) => {
				const session = sessions.find((s) => s.id === request.sessionId);
				const result: CueRunResult = {
					runId: request.runId,
					sessionId: request.sessionId,
					sessionName: session?.name ?? 'Unknown',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed',
					stdout: `output-${request.sessionId}`,
					stderr: '',
					exitCode: 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
				return result;
			}
		);

		const deps = createMockDeps({
			getSessions: vi.fn(() => sessions),
			onCueRun: onCueRun as CueEngineDeps['onCueRun'],
		});
		const engine = new CueEngine(deps);
		engine.start();

		// Flush all async work (heartbeat fires immediately, then chains through)
		await vi.advanceTimersByTimeAsync(0);

		expect(onCueRun).toHaveBeenCalledTimes(3);

		// First call: heartbeat fires Source
		expect(onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'source',
				prompt: 'do source work',
				event: expect.objectContaining({ type: 'time.heartbeat' }),
			})
		);

		// Second call: Source completion triggers Middle
		expect(onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'middle',
				prompt: 'do middle work',
				event: expect.objectContaining({ type: 'agent.completed', triggerName: 'on-source-done' }),
			})
		);

		// Third call: Middle completion triggers Downstream
		expect(onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'downstream',
				prompt: 'do downstream work',
				event: expect.objectContaining({ type: 'agent.completed', triggerName: 'on-middle-done' }),
			})
		);

		engine.stop();
	});

	it('stdout carries through chain', async () => {
		const sessions = [
			createMockSession({
				id: 'source',
				name: 'Source',
				cwd: '/proj/source',
				projectRoot: '/proj/source',
			}),
			createMockSession({
				id: 'middle',
				name: 'Middle',
				cwd: '/proj/middle',
				projectRoot: '/proj/middle',
			}),
			createMockSession({
				id: 'downstream',
				name: 'Downstream',
				cwd: '/proj/downstream',
				projectRoot: '/proj/downstream',
			}),
		];

		const configSource = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat-source',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do source work',
					interval_minutes: 60,
				},
			],
		});
		const configMiddle = createMockConfig({
			subscriptions: [
				{
					name: 'on-source-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'do middle work',
					source_session: 'Source',
				},
			],
		});
		const configDownstream = createMockConfig({
			subscriptions: [
				{
					name: 'on-middle-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'do downstream work',
					source_session: 'Middle',
				},
			],
		});

		mockLoadCueConfig.mockImplementation((projectRoot) => {
			if (projectRoot === '/proj/source') return configSource;
			if (projectRoot === '/proj/middle') return configMiddle;
			if (projectRoot === '/proj/downstream') return configDownstream;
			return null;
		});

		const onCueRun = vi.fn(
			async (request: {
				runId: string;
				sessionId: string;
				prompt: string;
				subscriptionName: string;
				event: CueEvent;
				timeoutMs: number;
			}) => {
				const session = sessions.find((s) => s.id === request.sessionId);
				const result: CueRunResult = {
					runId: request.runId,
					sessionId: request.sessionId,
					sessionName: session?.name ?? 'Unknown',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed',
					stdout: `output-${request.sessionId}`,
					stderr: '',
					exitCode: 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
				return result;
			}
		);

		const deps = createMockDeps({
			getSessions: vi.fn(() => sessions),
			onCueRun: onCueRun as CueEngineDeps['onCueRun'],
		});
		const engine = new CueEngine(deps);
		engine.start();

		await vi.advanceTimersByTimeAsync(0);

		// Middle's event payload should contain Source's stdout
		const middleCall = onCueRun.mock.calls.find((call) => call[0].sessionId === 'middle');
		expect(middleCall).toBeDefined();
		expect(middleCall![0].event.payload).toEqual(
			expect.objectContaining({
				sourceOutput: 'output-source',
			})
		);

		// Downstream's event payload should contain Middle's stdout
		const downstreamCall = onCueRun.mock.calls.find((call) => call[0].sessionId === 'downstream');
		expect(downstreamCall).toBeDefined();
		expect(downstreamCall![0].event.payload).toEqual(
			expect.objectContaining({
				sourceOutput: 'output-middle',
			})
		);

		engine.stop();
	});

	it('failed middle step stops chain when downstream has status filter', async () => {
		const sessions = [
			createMockSession({
				id: 'source',
				name: 'Source',
				cwd: '/proj/source',
				projectRoot: '/proj/source',
			}),
			createMockSession({
				id: 'middle',
				name: 'Middle',
				cwd: '/proj/middle',
				projectRoot: '/proj/middle',
			}),
			createMockSession({
				id: 'downstream',
				name: 'Downstream',
				cwd: '/proj/downstream',
				projectRoot: '/proj/downstream',
			}),
		];

		const configSource = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat-source',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do source work',
					interval_minutes: 60,
				},
			],
		});
		const configMiddle = createMockConfig({
			subscriptions: [
				{
					name: 'on-source-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'do middle work',
					source_session: 'Source',
				},
			],
		});
		const configDownstream = createMockConfig({
			subscriptions: [
				{
					name: 'on-middle-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'do downstream work',
					source_session: 'Middle',
					filter: { status: 'completed' },
				},
			],
		});

		mockLoadCueConfig.mockImplementation((projectRoot) => {
			if (projectRoot === '/proj/source') return configSource;
			if (projectRoot === '/proj/middle') return configMiddle;
			if (projectRoot === '/proj/downstream') return configDownstream;
			return null;
		});

		const onCueRun = vi.fn(
			async (request: {
				runId: string;
				sessionId: string;
				prompt: string;
				subscriptionName: string;
				event: CueEvent;
				timeoutMs: number;
			}) => {
				const session = sessions.find((s) => s.id === request.sessionId);
				// Middle fails, everything else succeeds
				const isFailed = request.sessionId === 'middle';
				const result: CueRunResult = {
					runId: request.runId,
					sessionId: request.sessionId,
					sessionName: session?.name ?? 'Unknown',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: isFailed ? 'failed' : 'completed',
					stdout: `output-${request.sessionId}`,
					stderr: isFailed ? 'error occurred' : '',
					exitCode: isFailed ? 1 : 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
				return result;
			}
		);

		const deps = createMockDeps({
			getSessions: vi.fn(() => sessions),
			onCueRun: onCueRun as CueEngineDeps['onCueRun'],
		});
		const engine = new CueEngine(deps);
		engine.start();

		await vi.advanceTimersByTimeAsync(0);

		// Source heartbeat fires, then Middle fires (triggered by Source completion),
		// but Downstream should NOT fire because Middle failed and filter requires 'completed'
		expect(onCueRun).toHaveBeenCalledTimes(2);

		// Verify the two calls are Source and Middle only
		const calledSessionIds = onCueRun.mock.calls.map((call) => call[0].sessionId);
		expect(calledSessionIds).toContain('source');
		expect(calledSessionIds).toContain('middle');
		expect(calledSessionIds).not.toContain('downstream');

		engine.stop();
	});

	it('circular chain A -> B -> A is bounded by MAX_CHAIN_DEPTH', async () => {
		// The chain depth guard (MAX_CHAIN_DEPTH=10) is propagated through AgentCompletionData
		// across async hops. When depth reaches the limit, notifyAgentCompleted aborts and logs.
		const sessions = [
			createMockSession({ id: 'a', name: 'A', cwd: '/proj/a', projectRoot: '/proj/a' }),
			createMockSession({ id: 'b', name: 'B', cwd: '/proj/b', projectRoot: '/proj/b' }),
		];

		const configA = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat-a',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do a work',
					interval_minutes: 60,
				},
				{
					name: 'on-b-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'react to b',
					source_session: 'B',
				},
			],
		});
		const configB = createMockConfig({
			subscriptions: [
				{
					name: 'on-a-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'react to a',
					source_session: 'A',
				},
			],
		});

		mockLoadCueConfig.mockImplementation((projectRoot) => {
			if (projectRoot === '/proj/a') return configA;
			if (projectRoot === '/proj/b') return configB;
			return null;
		});

		const onCueRun = vi.fn(
			async (request: {
				runId: string;
				sessionId: string;
				prompt: string;
				subscriptionName: string;
				event: CueEvent;
				timeoutMs: number;
			}) => {
				const session = sessions.find((s) => s.id === request.sessionId);
				const result: CueRunResult = {
					runId: request.runId,
					sessionId: request.sessionId,
					sessionName: session?.name ?? 'Unknown',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed',
					stdout: `output-${request.sessionId}`,
					stderr: '',
					exitCode: 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
				return result;
			}
		);

		const onLog = vi.fn();

		const deps = createMockDeps({
			getSessions: vi.fn(() => sessions),
			onCueRun: onCueRun as CueEngineDeps['onCueRun'],
			onLog,
		});
		const engine = new CueEngine(deps);
		engine.start();

		// Flush all async hops until the chain depth guard fires
		for (let i = 0; i < 15; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}

		// The chain ran but was stopped by MAX_CHAIN_DEPTH
		expect(onCueRun).toHaveBeenCalled();
		const callCount = onCueRun.mock.calls.length;
		// Should be bounded — heartbeat(1) + chain hops limited by depth 10
		expect(callCount).toBeLessThanOrEqual(12);

		// Verify the chain alternated between A and B sessions
		const sessionIds = onCueRun.mock.calls.map((call) => call[0].sessionId);
		expect(sessionIds[0]).toBe('a');
		if (callCount > 1) expect(sessionIds[1]).toBe('b');

		// The depth-exceeded error was logged
		const errorLogs = onLog.mock.calls.filter(
			(call) => call[0] === 'error' && (call[1] as string).includes('Max chain depth')
		);
		expect(errorLogs.length).toBeGreaterThan(0);

		engine.stop();
	});

	it('self-referencing subscription is bounded by MAX_CHAIN_DEPTH', async () => {
		// A session watching its own completion creates a loop.
		// The chain depth propagated via AgentCompletionData stops it.
		const sessions = [
			createMockSession({ id: 'self', name: 'Self', cwd: '/proj/self', projectRoot: '/proj/self' }),
		];

		const configSelf = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat-self',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do self work',
					interval_minutes: 60,
				},
				{
					name: 'on-self-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'react to self',
					source_session: 'Self',
				},
			],
		});

		mockLoadCueConfig.mockReturnValue(configSelf);

		let callCount = 0;
		const onCueRun = vi.fn(
			async (request: {
				runId: string;
				sessionId: string;
				prompt: string;
				subscriptionName: string;
				event: CueEvent;
				timeoutMs: number;
			}) => {
				callCount++;
				const result: CueRunResult = {
					runId: request.runId,
					sessionId: request.sessionId,
					sessionName: 'Self',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed',
					stdout: `output-${callCount}`,
					stderr: '',
					exitCode: 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
				return result;
			}
		);

		const onLog = vi.fn();

		const deps = createMockDeps({
			getSessions: vi.fn(() => sessions),
			onCueRun: onCueRun as CueEngineDeps['onCueRun'],
			onLog,
		});
		const engine = new CueEngine(deps);
		engine.start();

		// Flush all async hops until the chain depth guard fires
		for (let i = 0; i < 15; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}

		// All calls target the same session
		const sessionIds = onCueRun.mock.calls.map((call) => call[0].sessionId);
		expect(sessionIds.every((id) => id === 'self')).toBe(true);

		// First call is the heartbeat, subsequent calls are self-triggered completions
		expect(onCueRun.mock.calls[0][0].subscriptionName).toBe('heartbeat-self');
		if (callCount > 1) {
			expect(onCueRun.mock.calls[1][0].subscriptionName).toBe('on-self-done');
		}

		// The depth-exceeded error was logged
		const errorLogs = onLog.mock.calls.filter(
			(call) => call[0] === 'error' && (call[1] as string).includes('Max chain depth')
		);
		expect(errorLogs.length).toBeGreaterThan(0);

		engine.stop();
	});

	it('fan-in -> fan-out combination dispatches to all targets after all sources complete', async () => {
		const sessions = [
			createMockSession({
				id: 'source-a',
				name: 'SourceA',
				cwd: '/proj/source-a',
				projectRoot: '/proj/source-a',
			}),
			createMockSession({
				id: 'source-b',
				name: 'SourceB',
				cwd: '/proj/source-b',
				projectRoot: '/proj/source-b',
			}),
			createMockSession({
				id: 'orchestrator',
				name: 'Orchestrator',
				cwd: '/proj/orch',
				projectRoot: '/proj/orch',
			}),
			createMockSession({
				id: 'target-x',
				name: 'TargetX',
				cwd: '/proj/target-x',
				projectRoot: '/proj/target-x',
			}),
			createMockSession({
				id: 'target-y',
				name: 'TargetY',
				cwd: '/proj/target-y',
				projectRoot: '/proj/target-y',
			}),
		];

		const configOrch = createMockConfig({
			subscriptions: [
				{
					name: 'fan-in-out',
					event: 'agent.completed',
					enabled: true,
					prompt: 'orchestrate',
					source_session: ['SourceA', 'SourceB'],
					fan_out: ['TargetX', 'TargetY'],
				},
			],
		});

		mockLoadCueConfig.mockImplementation((projectRoot) => {
			if (projectRoot === '/proj/orch') return configOrch;
			return null;
		});

		const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
		const engine = new CueEngine(deps);
		engine.start();

		vi.clearAllMocks();

		// First source completes — fan-in should wait
		engine.notifyAgentCompleted('source-a', { sessionName: 'SourceA', stdout: 'output-a' });
		expect(deps.onCueRun).not.toHaveBeenCalled();

		// Second source completes — fan-in should fire, then fan-out dispatches
		engine.notifyAgentCompleted('source-b', { sessionName: 'SourceB', stdout: 'output-b' });
		await vi.advanceTimersByTimeAsync(0);

		// Fan-out should dispatch to both TargetX and TargetY
		expect(deps.onCueRun).toHaveBeenCalledTimes(2);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'target-x',
				prompt: 'orchestrate',
				event: expect.objectContaining({
					type: 'agent.completed',
					triggerName: 'fan-in-out',
					payload: expect.objectContaining({
						fanOutIndex: 0,
					}),
				}),
			})
		);
		expect(deps.onCueRun).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'target-y',
				prompt: 'orchestrate',
				event: expect.objectContaining({
					type: 'agent.completed',
					triggerName: 'fan-in-out',
					payload: expect.objectContaining({
						fanOutIndex: 1,
					}),
				}),
			})
		);

		engine.stop();
	});
});
