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
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
}));

const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Mock runMaestroCliSend for Phase 3 CLI output delivery. We mock the
// executor-level helper (rather than the low-level execFileNoThrow or `spawn`)
// so the test stays at the same abstraction level as the run-manager which
// consumes `runMaestroCliSend` directly. Test assertions still inspect the
// target/message args the helper was called with.
interface RunMaestroCliSendResult {
	ok: boolean;
	exitCode: number | string;
	stdout: string;
	stderr: string;
	resolvedTarget: string;
}
const mockRunMaestroCliSend =
	vi.fn<
		(target: string, message: string, timeoutMs?: number) => Promise<RunMaestroCliSendResult>
	>();
mockRunMaestroCliSend.mockResolvedValue({
	ok: true,
	exitCode: 0,
	stdout: '{}',
	stderr: '',
	resolvedTarget: '',
});

vi.mock('../../../main/cue/cue-cli-executor', () => ({
	runMaestroCliSend: (...args: unknown[]) =>
		mockRunMaestroCliSend(...(args as Parameters<typeof mockRunMaestroCliSend>)),
}));

let uuidCounter = 0;
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `run-${++uuidCounter}`),
}));

import { updateCueEventStatus, safeUpdateCueEventStatus } from '../../../main/cue/cue-db';
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
				undefined,
				expect.any(String)
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
				undefined,
				expect.any(String)
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
				undefined,
				expect.any(String)
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
				3,
				expect.any(String)
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

		it('reset during active run: finalizes DB status when onCueRun resolves after stop', async () => {
			// Regression test for the activity-log-loss bug: without the fix,
			// a run completing after engine.stop()/reset() would leave its DB
			// row stuck at `running` because both onRunCompleted AND
			// updateCueEventStatus were skipped.
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
			manager.reset();

			resolveRun!(makeResult({ status: 'completed', stdout: 'hi' }));
			await vi.advanceTimersByTimeAsync(0);

			// DB status MUST be updated to the final result state so the
			// activity log doesn't show a phantom never-ending run.
			expect(safeUpdateCueEventStatus).toHaveBeenCalledWith(expect.any(String), 'completed');
			// And a log should explain the run was recorded post-stop AND
			// include the structured runFinished payload so the renderer
			// observes the transition identically to a normal completion.
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('completed after engine stop'),
				expect.objectContaining({ type: 'runFinished', status: 'completed' })
			);
		});

		it('reset during active run: preserves failed status when onCueRun resolves with failure after stop', async () => {
			// Variant of the above covering the failure path — make sure the
			// final status propagates to the DB regardless of outcome.
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
			manager.reset();

			resolveRun!(makeResult({ status: 'failed', stderr: 'boom' }));
			await vi.advanceTimersByTimeAsync(0);

			expect(safeUpdateCueEventStatus).toHaveBeenCalledWith(expect.any(String), 'failed');
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

		it('reset during output-prompt phase: finalizes parent run status', async () => {
			// Regression gate for the output-prompt analog of the
			// engine-stopped-mid-run bug: if reset() fires AFTER the main
			// task completed and DURING the output-prompt call, the outer
			// finally's cleanup is bypassed (activeRuns no longer has the
			// runId), so without the explicit finalize the PARENT runId DB
			// row stays at `running` forever. Mirrors the earlier guard for
			// the pre-output-prompt case.
			let onCueRunCallCount = 0;
			let resolveOutputRun: ((val: CueRunResult) => void) | undefined;
			const deps = createDeps({
				onCueRun: vi.fn(() => {
					onCueRunCallCount++;
					if (onCueRunCallCount === 1) {
						return Promise.resolve(makeResult({ status: 'completed' }));
					}
					return new Promise<CueRunResult>((resolve) => {
						resolveOutputRun = resolve;
					});
				}),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', 'output prompt');
			await vi.advanceTimersByTimeAsync(0);

			// Main task finished, output prompt is pending. Reset the engine
			// — this clears activeRuns before the output prompt resolves.
			manager.reset();

			// Output prompt now completes after reset. The inner finally
			// writes the output-prompt row; the new guard must also write
			// the PARENT row so the activity log doesn't strand it.
			vi.mocked(safeUpdateCueEventStatus).mockClear();
			resolveOutputRun!(makeResult({ status: 'completed' }));
			await vi.advanceTimersByTimeAsync(0);

			// Expect TWO finalization calls: one for the output run (in the
			// inner finally — technically via updateCueEventStatus, not the
			// safe variant, so it won't show here) and one for the PARENT
			// via safeUpdateCueEventStatus with the main task's status.
			// Only the parent-side safe call is asserted because that's the
			// regression we're guarding.
			expect(safeUpdateCueEventStatus).toHaveBeenCalledWith(expect.any(String), 'completed');
			// And the post-stop log MUST include the structured runFinished
			// payload so renderer listeners observe the transition.
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('output phase completed after engine stop'),
				expect.objectContaining({ type: 'runFinished', status: 'completed' })
			);
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

	describe('Phase 3: CLI Output delivery', () => {
		beforeEach(() => {
			mockRunMaestroCliSend.mockResolvedValue({
				ok: true,
				exitCode: 0,
				stdout: '{}',
				stderr: '',
				resolvedTarget: '',
			});
		});

		it('triggers runMaestroCliSend with correct arguments when run succeeds', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute(
				'session-1',
				'prompt',
				createEvent(),
				'test-sub',
				undefined, // outputPrompt
				undefined, // chainDepth
				{ target: 'agent-42' }
			);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockRunMaestroCliSend).toHaveBeenCalledTimes(1);
			expect(mockRunMaestroCliSend).toHaveBeenCalledWith('agent-42', 'output');
		});

		it('skips delivery when target resolves to empty string', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);
			const event = createEvent({ payload: {} });

			manager.execute('session-1', 'prompt', event, 'test-sub', undefined, undefined, {
				target: '{{CUE_SOURCE_AGENT_ID}}',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(mockRunMaestroCliSend).not.toHaveBeenCalled();
			expect(deps.onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('target resolved to empty string')
			);
		});

		it('is skipped when run fails', async () => {
			const deps = createDeps({
				onCueRun: vi.fn(async () => makeResult({ status: 'failed', exitCode: 1 })),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', undefined, undefined, {
				target: 'agent-42',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(mockRunMaestroCliSend).not.toHaveBeenCalled();
		});

		it('delivery failure does not change run status', async () => {
			mockRunMaestroCliSend.mockResolvedValue({
				ok: false,
				exitCode: 1,
				stdout: '',
				stderr: 'Connection refused',
				resolvedTarget: 'agent-42',
			});
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', undefined, undefined, {
				target: 'agent-42',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ status: 'completed' }),
				'test-sub',
				undefined,
				expect.any(String)
			);
			expect(deps.onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('CLI output delivery failed')
			);
		});

		it('substitutes template variables in target before execution', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);
			const event = createEvent({
				type: 'cli.trigger',
				payload: { sourceAgentId: 'resolved-agent-99' },
			});

			manager.execute('session-1', 'prompt', event, 'test-sub', undefined, undefined, {
				target: '{{CUE_SOURCE_AGENT_ID}}',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(mockRunMaestroCliSend).toHaveBeenCalledTimes(1);
			expect(mockRunMaestroCliSend).toHaveBeenCalledWith('resolved-agent-99', 'output');
		});

		it('is not called when cliOutput is not provided', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub');
			await vi.advanceTimersByTimeAsync(0);

			expect(mockRunMaestroCliSend).not.toHaveBeenCalled();
		});

		it('forwards the full stdout to runMaestroCliSend (truncation happens in the CLI helper)', async () => {
			// The run-manager no longer truncates inline — truncation is owned
			// by `runMaestroCliSend` in cue-cli-executor (capped at
			// CLI_SEND_OUTPUT_MAX_CHARS = 100_000). Validate the run-manager
			// forwards the raw output unchanged so the helper can cap it.
			const longOutput = 'x'.repeat(150_000);
			const deps = createDeps({
				onCueRun: vi.fn(async () => makeResult({ stdout: longOutput })),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', undefined, undefined, {
				target: 'agent-42',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(mockRunMaestroCliSend).toHaveBeenCalledTimes(1);
			expect(mockRunMaestroCliSend).toHaveBeenCalledWith('agent-42', longOutput);
		});

		it('logs success message on delivery', async () => {
			const deps = createDeps();
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', undefined, undefined, {
				target: 'agent-42',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('CLI output delivered to agent-42')
			);
		});

		it('logs Phase 3 skipped when run status is not completed', async () => {
			const deps = createDeps({
				onCueRun: vi.fn(async () => makeResult({ status: 'failed', exitCode: 1 })),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'test-sub', undefined, undefined, {
				target: 'agent-42',
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Phase 3 skipped'));
		});
	});

	// ─── Phase 15A additions ────────────────────────────────────────────────
	// Output-prompt second-phase scenarios that live in the run-manager (the
	// executor is a single-phase spawner; the chained "main task → output
	// prompt" phase is orchestrated here).

	describe('output prompt phase — failure and stop interactions', () => {
		it('preserves main-task stdout when the output prompt returns a non-completed status', async () => {
			const onCueRun = vi.fn<(req: { subscriptionName: string }) => Promise<CueRunResult>>();
			// Call 1 = main task (completes with real stdout). Call 2 = output
			// prompt phase, returns failed — run-manager must fall back to the
			// main task output and log a warning instead of overwriting the
			// result.stdout with the empty output-prompt stdout.
			onCueRun
				.mockResolvedValueOnce(makeResult({ status: 'completed', stdout: 'MAIN_TASK_OUTPUT' }))
				.mockResolvedValueOnce(
					makeResult({ status: 'failed', stdout: '', stderr: 'output prompt died' })
				);

			const deps = createDeps({ onCueRun });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'main-prompt', createEvent(), 'test-sub', 'output-prompt-body');
			await vi.advanceTimersByTimeAsync(0);

			expect(onCueRun).toHaveBeenCalledTimes(2);
			// The second call is the output-prompt phase. The run-manager
			// builds `contextPrompt = outputPrompt + "\n---\nContext from
			// completed task:\n" + mainStdout` and passes that as the
			// `prompt` field. It also stashes the main-task stdout on the
			// event payload under `sourceOutput` for downstream chain
			// consumers. Verify both channels carry MAIN_TASK_OUTPUT so a
			// refactor that drops either one fails fast.
			const outputPromptRequest = onCueRun.mock.calls[1][0] as {
				subscriptionName: string;
				prompt: string;
				event: { payload: { sourceOutput?: string; outputPromptPhase?: boolean } };
			};
			expect(outputPromptRequest.subscriptionName).toBe('test-sub:output');
			expect(outputPromptRequest.prompt).toContain('output-prompt-body');
			expect(outputPromptRequest.prompt).toContain('MAIN_TASK_OUTPUT');
			expect(outputPromptRequest.event.payload.sourceOutput).toBe('MAIN_TASK_OUTPUT');
			expect(outputPromptRequest.event.payload.outputPromptPhase).toBe(true);
			// onRunCompleted carries the MAIN task output — not the failed
			// output-prompt's empty string.
			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ stdout: 'MAIN_TASK_OUTPUT', status: 'completed' }),
				'test-sub',
				undefined,
				expect.any(String)
			);
			// Warning explaining the fallback was surfaced to the activity log.
			expect(
				(deps.onLog as ReturnType<typeof vi.fn>).mock.calls.some(
					(call) =>
						call[0] === 'cue' && typeof call[1] === 'string' && /output prompt failed/.test(call[1])
				)
			).toBe(true);
		});

		it('survives an output-prompt onCueRun that rejects (exception path)', async () => {
			const onCueRun = vi.fn<(req: { subscriptionName: string }) => Promise<CueRunResult>>();
			onCueRun
				.mockResolvedValueOnce(makeResult({ status: 'completed', stdout: 'MAIN_OK' }))
				.mockRejectedValueOnce(new Error('spawn ENOENT'));

			const deps = createDeps({ onCueRun });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'main', createEvent(), 'test-sub', 'out-prompt');
			await vi.advanceTimersByTimeAsync(0);

			// The outer catch treats the rejection as a run failure — main task
			// output is discarded because the `await outputResult` line threw
			// before the stdout reassignment could happen.
			expect(deps.onRunCompleted).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({
					status: 'failed',
					stderr: expect.stringContaining('spawn ENOENT'),
				}),
				'test-sub',
				undefined,
				expect.any(String)
			);
		});

		it('stopRun during output-prompt phase kills BOTH the parent and the output-prompt child process', async () => {
			const mainDeferred: { resolve?: (r: CueRunResult) => void } = {};
			const outputDeferred: { resolve?: (r: CueRunResult) => void } = {};

			const onCueRun = vi.fn((req: { runId: string; subscriptionName: string }) => {
				if (req.subscriptionName === 'test-sub') {
					return new Promise<CueRunResult>((res) => {
						mainDeferred.resolve = (r) => res({ ...r, runId: req.runId });
					});
				}
				return new Promise<CueRunResult>((res) => {
					outputDeferred.resolve = (r) => res({ ...r, runId: req.runId });
				});
			});

			const onStopCueRun = vi.fn(() => true);
			const deps = createDeps({ onCueRun, onStopCueRun });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'main', createEvent(), 'test-sub', 'out-prompt');
			// Let the main task complete; run-manager now dispatches the
			// output-prompt phase.
			mainDeferred.resolve!(makeResult({ status: 'completed', stdout: 'MAIN_OK' }));
			await vi.advanceTimersByTimeAsync(0);
			expect(onCueRun).toHaveBeenCalledTimes(2);

			// The output-prompt spawn is now in-flight. The active run carries
			// the output-prompt child's processRunId so stopRun can signal both.
			const parentRunId = manager.getActiveRuns()[0].runId;
			const run = manager.getActiveRunMap().get(parentRunId)!;
			expect(run.processRunId).toBeDefined();
			expect(run.processRunId).not.toBe(parentRunId);

			// User hits stop.
			const stopped = manager.stopRun(parentRunId);
			expect(stopped).toBe(true);
			expect(onStopCueRun).toHaveBeenCalledWith(parentRunId);
			expect(onStopCueRun).toHaveBeenCalledWith(run.processRunId!);

			expect(deps.onRunStopped).toHaveBeenCalledTimes(1);
			expect(deps.onRunStopped).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'stopped' })
			);

			// Output-prompt resolves late — the run-manager must skip
			// onRunCompleted because stopRun already cleaned up.
			outputDeferred.resolve!(makeResult({ status: 'completed', stdout: 'LATE' }));
			await vi.advanceTimersByTimeAsync(0);
			expect(deps.onRunCompleted).not.toHaveBeenCalled();
		});
	});

	// Phase 12A — queue persistence wiring
	describe('queue persistence (Phase 12A)', () => {
		function makeMockPersistence() {
			return {
				persist: vi.fn(),
				remove: vi.fn(),
				clearSession: vi.fn(),
				clearAll: vi.fn(),
				restoreAll: vi.fn(() => new Map()),
			};
		}

		it('calls queuePersistence.persist when an event is queued', () => {
			const persistence = makeMockPersistence();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 5,
				})),
				queuePersistence: persistence,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1'); // dispatched
			manager.execute('session-1', 'p2', createEvent(), 'sub-2'); // queued
			expect(persistence.persist).toHaveBeenCalledTimes(1);
			expect(persistence.persist).toHaveBeenCalledWith(
				'session-1',
				expect.any(String),
				expect.objectContaining({ subscriptionName: 'sub-2' })
			);
		});

		it('calls queuePersistence.remove when a queued event drains', async () => {
			const persistence = makeMockPersistence();
			let resolveFirst: ((r: CueRunResult) => void) | null = null;
			const deps = createDeps({
				onCueRun: vi
					.fn()
					.mockImplementationOnce(() => new Promise<CueRunResult>((r) => (resolveFirst = r)))
					.mockResolvedValue(makeResult()),
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 5,
				})),
				queuePersistence: persistence,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1'); // dispatched
			manager.execute('session-1', 'p2', createEvent(), 'sub-2'); // queued
			expect(persistence.remove).not.toHaveBeenCalled();
			// Finish the first run → slot opens → queued event drains
			resolveFirst!(makeResult());
			await vi.advanceTimersByTimeAsync(0);
			// The drain path removes the persisted row before dispatching
			expect(persistence.remove).toHaveBeenCalled();
		});

		it('calls queuePersistence.remove on overflow drop', () => {
			const persistence = makeMockPersistence();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 1,
				})),
				queuePersistence: persistence,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1'); // dispatched
			manager.execute('session-1', 'p2', createEvent(), 'sub-2'); // queued
			persistence.remove.mockClear();
			manager.execute('session-1', 'p3', createEvent(), 'sub-3'); // overflow → drops oldest
			expect(persistence.remove).toHaveBeenCalledTimes(1);
		});

		it('calls queuePersistence.clearAll on stopAll', () => {
			const persistence = makeMockPersistence();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				queuePersistence: persistence,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.stopAll();
			expect(persistence.clearAll).toHaveBeenCalled();
		});

		it('calls queuePersistence.clearAll on reset', () => {
			const persistence = makeMockPersistence();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				queuePersistence: persistence,
			});
			const manager = createCueRunManager(deps);
			manager.reset();
			expect(persistence.clearAll).toHaveBeenCalled();
		});

		it('works without queuePersistence dep (back-compat)', () => {
			const deps = createDeps({ onCueRun: vi.fn(() => new Promise(() => {})) });
			const manager = createCueRunManager(deps);
			expect(() => {
				manager.execute('session-1', 'p1', createEvent(), 'sub-1');
				manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			}).not.toThrow();
		});

		it('honors queuedAtOverride so restored entries keep their original timestamp', () => {
			const persistence = makeMockPersistence();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 5,
				})),
				queuePersistence: persistence,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1'); // dispatched
			// Queue with a timestamp from an hour ago (simulating restore).
			const anHourAgo = Date.now() - 60 * 60 * 1000;
			manager.execute(
				'session-1',
				'p2',
				createEvent(),
				'sub-2',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				anHourAgo
			);
			const persistCall = persistence.persist.mock.calls.at(-1);
			expect(persistCall?.[2].queuedAt).toBe(anHourAgo);
		});
	});

	// Phase 12B — onQueueOverflow wiring
	describe('queue overflow (Phase 12B)', () => {
		it('invokes onQueueOverflow when the queue saturates, before shifting', async () => {
			const onQueueOverflow = vi.fn();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})), // never resolves — stays active
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 2,
				})),
				onQueueOverflow,
			});
			const manager = createCueRunManager(deps);

			// Fill the slot (1 active) + fill the queue (2 queued) = 3 calls total.
			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			manager.execute('session-1', 'p3', createEvent(), 'sub-3');
			expect(onQueueOverflow).not.toHaveBeenCalled();

			// Fourth call exceeds queue_size — overflow fires.
			manager.execute('session-1', 'p4', createEvent(), 'sub-4');
			expect(onQueueOverflow).toHaveBeenCalledTimes(1);
			expect(onQueueOverflow).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: 'sub-2', // oldest queued
				})
			);
		});

		it('does NOT invoke onQueueOverflow when capacity is available', () => {
			const onQueueOverflow = vi.fn();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				onQueueOverflow,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			expect(onQueueOverflow).not.toHaveBeenCalled();
		});

		it('works without onQueueOverflow dep (back-compat)', () => {
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 1,
				})),
				// Intentionally no onQueueOverflow
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			// No throw, normal continuation.
			expect(() => manager.execute('session-1', 'p3', createEvent(), 'sub-3')).not.toThrow();
		});

		it('drops the incoming event (not queue[0]) when queue_size is 0', () => {
			const onQueueOverflow = vi.fn();
			const deps = createDeps({
				onCueRun: vi.fn(() => new Promise(() => {})),
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 0,
				})),
				onQueueOverflow,
			});
			const manager = createCueRunManager(deps);
			manager.execute('session-1', 'p1', createEvent(), 'sub-active'); // dispatched
			// Second call would crash pre-guard because queue[0] is undefined.
			expect(() => manager.execute('session-1', 'p2', createEvent(), 'sub-incoming')).not.toThrow();
			// Overflow fires for the INCOMING subscription, not a non-existent oldest.
			expect(onQueueOverflow).toHaveBeenCalledWith(
				expect.objectContaining({ subscriptionName: 'sub-incoming' })
			);
			expect(manager.getQueueStatus().size).toBe(0);
		});
	});
});
