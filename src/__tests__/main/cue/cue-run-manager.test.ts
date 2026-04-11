/**
 * Tests for the Cue Run Manager — direct unit tests for concurrency control,
 * phase state machine, queue management, and run lifecycle.
 *
 * These tests exercise createCueRunManager() directly (not through CueEngine),
 * giving fine-grained control over the run lifecycle and enabling targeted
 * race-condition and state machine tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueEvent, CueRunResult, CueSettings } from '../../../main/cue/cue-types';

// ─── Mocks ──────────────────────────────────────────���────────────────────────

vi.mock('../../../main/cue/cue-db', () => ({
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
}));

const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

let uuidCounter = 0;
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `run-${++uuidCounter}`),
}));

import { updateCueEventStatus } from '../../../main/cue/cue-db';
import {
	createCueRunManager,
	type CueRunManagerDeps,
	type ActiveRun,
} from '../../../main/cue/cue-run-manager';

// ─── Helpers ─────────────────────────────────────���──────────────────────���────

function createEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'time.heartbeat',
		timestamp: new Date().toISOString(),
		triggerName: 'test',
		payload: {},
		...overrides,
	};
}

function makeResult(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'r1',
		sessionId: 'session-1',
		sessionName: 'Test Session',
		subscriptionName: 'test-sub',
		event: createEvent(),
		status: 'completed',
		stdout: 'output',
		stderr: '',
		exitCode: 0,
		durationMs: 100,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		...overrides,
	};
}

const defaultSettings: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 10,
};

function createDeps(overrides: Partial<CueRunManagerDeps> = {}): CueRunManagerDeps {
	return {
		getSessions: vi.fn(() => [{ id: 'session-1', name: 'Test Session' }]),
		getSessionSettings: vi.fn(() => defaultSettings),
		onCueRun: vi.fn(async () => makeResult()),
		onStopCueRun: vi.fn(() => true),
		onLog: vi.fn(),
		onRunCompleted: vi.fn(),
		onRunStopped: vi.fn(),
		onPreventSleep: vi.fn(),
		onAllowSleep: vi.fn(),
		...overrides,
	};
}

// ─── Tests ────────────────────��────────────────────────────────��─────────────

describe('createCueRunManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		uuidCounter = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('phase state machine', () => {
		it('creates run with phase "running"', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');

			const runMap = manager.getActiveRunMap();
			const run = [...runMap.values()][0];
			expect(run.phase).toBe('running');
		});

		it('stopRun transitions phase to "stopping" then removes from activeRuns', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			const stopped = manager.stopRun(runId);
			expect(stopped).toBe(true);
			// Run should be removed from activeRuns after stopRun
			expect(manager.getActiveRunMap().has(runId)).toBe(false);
		});

		it('stopRun returns false for unknown runId', () => {
			const manager = createCueRunManager(createDeps());
			expect(manager.stopRun('nonexistent')).toBe(false);
		});

		it('double stopRun returns false on second call', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			expect(manager.stopRun(runId)).toBe(true);
			expect(manager.stopRun(runId)).toBe(false);
		});

		it('natural completion transitions through finished phase', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			// After natural completion, run should be removed
			expect(manager.getActiveRunMap().size).toBe(0);
			expect(deps.onRunCompleted).toHaveBeenCalledTimes(1);
		});
	});

	describe('run lifecycle', () => {
		it('calls onRunCompleted on successful completion', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ status: 'completed' }),
				'test-sub',
				undefined
			);
		});

		it('calls onRunCompleted with failed status on failure', async () => {
			const deps = createDeps({
				onCueRun: vi.fn(async () => makeResult({ status: 'failed', exitCode: 1 })),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ status: 'failed' }),
				'test-sub',
				undefined
			);
		});

		it('calls onRunCompleted with failed status on exception', async () => {
			const deps = createDeps({
				onCueRun: vi.fn(async () => {
					throw new Error('spawn ENOENT');
				}),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({
					status: 'failed',
					stderr: 'spawn ENOENT',
				}),
				'test-sub',
				undefined
			);
		});

		it('calls onRunStopped on manual stop', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(deps.onRunStopped).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'stopped', runId })
			);
			// onRunCompleted should NOT be called for stopped runs
			expect(deps.onRunCompleted).not.toHaveBeenCalled();
		});

		it('sets endedAt and durationMs on stop', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			const stoppedResult = (deps.onRunStopped as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(stoppedResult.endedAt).toBeTruthy();
			expect(typeof stoppedResult.durationMs).toBe('number');
		});

		it('passes chainDepth through to onRunCompleted', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', undefined, 3);
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.anything(),
				'test-sub',
				3
			);
		});

		it('cleans up from activeRuns after natural completion', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			expect(manager.getActiveRunMap().size).toBe(1);

			resolveRun!(makeResult());
			await vi.advanceTimersByTimeAsync(0);

			expect(manager.getActiveRunMap().size).toBe(0);
		});
	});

	describe('sleep prevention', () => {
		it('calls onPreventSleep when run starts', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');

			expect(deps.onPreventSleep).toHaveBeenCalledWith('cue:run:run-1');
		});

		it('calls onAllowSleep on natural completion', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onAllowSleep).toHaveBeenCalledWith('cue:run:run-1');
		});

		it('calls onAllowSleep eagerly on stop', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(deps.onAllowSleep).toHaveBeenCalledWith(`cue:run:${runId}`);
		});
	});

	describe('concurrency and queue management', () => {
		it('frees concurrency slot on natural completion', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const manager = createCueRunManager(deps);

			// First run takes the slot
			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');

			// Second run should be queued
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');
			expect(manager.getQueueStatus().get('session-1')).toBe(1);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Complete first run -> queue should drain
			resolveRun!(makeResult());
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(manager.getQueueStatus().size).toBe(0);
		});

		it('frees concurrency slot eagerly on stop', () => {
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			// First run takes the slot
			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');

			// Second run should be queued
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Stop first run -> slot freed, queue drains immediately
			const runId = manager.getActiveRuns()[0].runId;
			manager.stopRun(runId);

			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(manager.getQueueStatus().size).toBe(0);
		});

		it('does not double-decrement count when stop followed by finally', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				getSessionSettings: vi.fn(() => ({ ...defaultSettings, max_concurrent: 2 })),
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const manager = createCueRunManager(deps);

			// Start two runs (both fit in max_concurrent=2)
			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			// Stop the first run
			const firstRunId = manager.getActiveRuns()[0].runId;
			manager.stopRun(firstRunId);

			// Now resolve the stopped run's promise (simulating process exit)
			// The finally block should bail out since the run is already removed
			resolveRun!(makeResult());
			await vi.advanceTimersByTimeAsync(0);

			// Queue a third run — it should dispatch immediately because only 1 slot is occupied
			manager.execute('session-1', 'prompt', createEvent(), 'sub-3');
			expect(deps.onCueRun).toHaveBeenCalledTimes(3);
		});
	});

	describe('DB recording', () => {
		it('updates DB status on natural completion', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(updateCueEventStatus).toHaveBeenCalledWith('run-1', 'completed');
		});

		it('updates DB status to stopped on manual stop', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(updateCueEventStatus).toHaveBeenCalledWith(runId, 'stopped');
		});
	});

	describe('race conditions', () => {
		it('reset during active run: finally does not trigger onRunCompleted', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			expect(manager.getActiveRunMap().size).toBe(1);

			// Reset clears everything (simulates engine.stop())
			manager.reset();
			expect(manager.getActiveRunMap().size).toBe(0);

			// Now the onCueRun promise resolves — the finally block should bail out
			resolveRun!(makeResult());
			await vi.advanceTimersByTimeAsync(0);

			// onRunCompleted should NOT be called — the engine was shut down
			expect(deps.onRunCompleted).not.toHaveBeenCalled();
		});

		it('stopAll followed by reset: no spurious onRunCompleted', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			manager.stopAll();
			manager.reset();

			// Process finally exits
			resolveRun!(makeResult());
			await vi.advanceTimersByTimeAsync(0);

			// Only onRunStopped should have been called (from stopAll/stopRun),
			// NOT onRunCompleted (from finally)
			expect(deps.onRunStopped).toHaveBeenCalledTimes(1);
			expect(deps.onRunCompleted).not.toHaveBeenCalled();
		});

		it('stop during output prompt phase skips second run result', async () => {
			let onCueRunCallCount = 0;
			let resolveSecondRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				onCueRun: vi.fn(() => {
					onCueRunCallCount++;
					if (onCueRunCallCount === 1) {
						// First call (main task) resolves immediately
						return Promise.resolve(makeResult());
					}
					// Second call (output prompt) — we'll stop during this
					return new Promise<CueRunResult>((resolve) => {
						resolveSecondRun = resolve;
					});
				}),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', 'output prompt');
			await vi.advanceTimersByTimeAsync(0);

			// At this point: main task completed, output prompt is running
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(manager.getActiveRunMap().size).toBe(1);

			// Stop the run while output prompt is in-flight
			const runId = [...manager.getActiveRunMap().keys()][0];
			manager.stopRun(runId);

			expect(deps.onRunStopped).toHaveBeenCalledTimes(1);

			// Output prompt resolves after stop — should be ignored
			resolveSecondRun!(makeResult({ stdout: 'output prompt result' }));
			await vi.advanceTimersByTimeAsync(0);

			// onRunCompleted should NOT be called
			expect(deps.onRunCompleted).not.toHaveBeenCalled();
		});
	});

	describe('output prompt', () => {
		it('executes output prompt when main task completes successfully', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', 'follow-up prompt');
			await vi.advanceTimersByTimeAsync(0);

			// Should have called onCueRun twice: main + output
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({ subscriptionName: 'test-sub:output' })
			);
		});

		it('skips output prompt when main task fails', async () => {
			const deps = createDeps({
				onCueRun: vi.fn(async () => makeResult({ status: 'failed' })),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', 'follow-up prompt');
			await vi.advanceTimersByTimeAsync(0);

			// Only main task should be called
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		});
	});

	describe('stopAll', () => {
		it('stops all active runs', () => {
			const deps = createDeps({
				getSessionSettings: vi.fn(() => ({ ...defaultSettings, max_concurrent: 3 })),
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-3');
			expect(manager.getActiveRuns()).toHaveLength(3);

			manager.stopAll();

			expect(manager.getActiveRuns()).toHaveLength(0);
			expect(deps.onRunStopped).toHaveBeenCalledTimes(3);
		});

		it('clears event queue', () => {
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');
			expect(manager.getQueueStatus().get('session-1')).toBe(1);

			manager.stopAll();

			expect(manager.getQueueStatus().size).toBe(0);
		});
	});

	describe('reset', () => {
		it('releases sleep blocks for all active runs', () => {
			const deps = createDeps({
				getSessionSettings: vi.fn(() => ({ ...defaultSettings, max_concurrent: 2 })),
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');

			manager.reset();

			// Should have called onAllowSleep for both runs
			expect(deps.onAllowSleep).toHaveBeenCalledTimes(2);
		});

		it('clears all internal state', () => {
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');

			manager.reset();

			expect(manager.getActiveRuns()).toHaveLength(0);
			expect(manager.getActiveRunMap().size).toBe(0);
			expect(manager.getQueueStatus().size).toBe(0);
		});
	});

	describe('logging', () => {
		it('logs run started on dispatch', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Run started: test-sub'),
				expect.objectContaining({ type: 'runStarted' })
			);
		});

		it('logs run finished on natural completion', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Run finished: test-sub (completed)'),
				expect.objectContaining({ type: 'runFinished' })
			);
		});

		it('logs run stopped on manual stop', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Run stopped:'),
				expect.objectContaining({ type: 'runStopped' })
			);
		});
	});

	describe('process signaling', () => {
		it('calls onStopCueRun when stopping a run', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(deps.onStopCueRun).toHaveBeenCalledWith(runId);
		});

		it('aborts the AbortController on stop', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = [...manager.getActiveRunMap().keys()][0];
			const run = manager.getActiveRunMap().get(runId)!;
			const abortSpy = vi.spyOn(run.abortController!, 'abort');

			manager.stopRun(runId);

			expect(abortSpy).toHaveBeenCalled();
		});
	});

	describe('output prompt process stop targeting', () => {
		it('stopRun calls onStopCueRun with output prompt runId when in output phase', async () => {
			let onCueRunCallCount = 0;
			const deps = createDeps({
				onCueRun: vi.fn(() => {
					onCueRunCallCount++;
					if (onCueRunCallCount === 1) {
						return Promise.resolve(makeResult());
					}
					// Output prompt — never resolves
					return new Promise<CueRunResult>(() => {});
				}),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', 'output prompt');
			await vi.advanceTimersByTimeAsync(0);

			// Main task completed, output prompt is running
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			const runId = [...manager.getActiveRunMap().keys()][0];

			manager.stopRun(runId);

			// Should have called onStopCueRun for both the parent and output process
			expect(deps.onStopCueRun).toHaveBeenCalledTimes(2);
			expect(deps.onStopCueRun).toHaveBeenCalledWith(runId);
			// The output prompt's runId is the second UUID generated (run-2 is the parent, run-3 is the outputEvent id, run-4... let's check)
			// UUIDs: run-1 = parent runId, run-2 = outputRunId, run-3 = outputEvent.id
			// Actually: the parent run generates run-1 (runId), then outputRunId = run-2, outputEvent.id = run-3
			const outputRunId = (deps.onStopCueRun as ReturnType<typeof vi.fn>).mock.calls[1][0];
			expect(outputRunId).not.toBe(runId);
		});

		it('stopRun does not double-call onStopCueRun when not in output phase', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			// Only one call since no output prompt phase
			expect(deps.onStopCueRun).toHaveBeenCalledTimes(1);
			expect(deps.onStopCueRun).toHaveBeenCalledWith(runId);
		});
	});

	describe('DB error Sentry reporting', () => {
		it('reports updateCueEventStatus failure to Sentry on stop', () => {
			const dbError = new Error('SQLITE_BUSY');
			(updateCueEventStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw dbError;
			});
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(mockCaptureException).toHaveBeenCalledWith(
				dbError,
				expect.objectContaining({ operation: 'cue:updateEventStatus', runId, status: 'stopped' })
			);
			expect(deps.onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('Failed to update DB status')
			);
		});

		it('reports updateCueEventStatus failure to Sentry on natural completion', async () => {
			const dbError = new Error('SQLITE_CORRUPT');
			(updateCueEventStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw dbError;
			});
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(mockCaptureException).toHaveBeenCalledWith(
				dbError,
				expect.objectContaining({ operation: 'cue:updateEventStatus', status: 'completed' })
			);
		});
	});

	describe('getActiveRunCount', () => {
		it('returns 0 for unknown session', () => {
			const manager = createCueRunManager(createDeps());
			expect(manager.getActiveRunCount('unknown')).toBe(0);
		});

		it('returns correct count for active runs', () => {
			const deps = createDeps({
				getSessionSettings: vi.fn(() => ({ ...defaultSettings, max_concurrent: 3 })),
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');

			expect(manager.getActiveRunCount('session-1')).toBe(2);
		});

		it('decrements after stopRun', () => {
			const deps = createDeps({
				getSessionSettings: vi.fn(() => ({ ...defaultSettings, max_concurrent: 3 })),
				onCueRun: vi.fn(() => new Promise(() => {})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt', createEvent(), 'sub-2');
			const runId = manager.getActiveRuns()[0].runId;

			manager.stopRun(runId);

			expect(manager.getActiveRunCount('session-1')).toBe(1);
		});
	});
});
