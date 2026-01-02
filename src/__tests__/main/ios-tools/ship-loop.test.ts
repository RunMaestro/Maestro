/**
 * Tests for src/main/ios-tools/ship-loop.ts
 *
 * Tests cover the Feature Ship Loop including:
 * - Loop execution with multiple iterations
 * - Assertion handling
 * - Progress callbacks
 * - Result formatting
 * - Termination conditions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before imports
vi.mock('../../../main/ios-tools/simulator', () => ({
  getBootedSimulators: vi.fn(),
  getSimulator: vi.fn(),
  launchApp: vi.fn(),
  terminateApp: vi.fn(),
}));

vi.mock('../../../main/ios-tools/flow-runner', () => ({
  runFlow: vi.fn(),
}));

vi.mock('../../../main/ios-tools/snapshot', () => ({
  captureSnapshot: vi.fn(),
}));

vi.mock('../../../main/ios-tools/assertions', () => ({
  assertVisible: vi.fn(),
  assertNotVisible: vi.fn(),
  assertNoCrash: vi.fn(),
}));

vi.mock('../../../main/ios-tools/artifacts', () => ({
  getArtifactDirectory: vi.fn().mockResolvedValue('/tmp/artifacts/test-session'),
  generateSnapshotId: vi.fn().mockReturnValue('snap-123'),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ship-loop.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('runShipLoop', () => {
    it('should return error when no booted simulators', async () => {
      const { getBootedSimulators } = await import('../../../main/ios-tools/simulator');
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [],
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const resultPromise = runShipLoop({
        flowPath: '/path/to/flow.yaml',
        assertions: [{ type: 'visible', target: 'login-btn' }],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('No booted simulators');
    });

    it('should return error when simulator not found', async () => {
      const { getBootedSimulators, getSimulator } = await import(
        '../../../main/ios-tools/simulator'
      );
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [{ udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' }],
      });
      vi.mocked(getSimulator).mockResolvedValue({
        success: false,
        error: 'Simulator not found',
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const resultPromise = runShipLoop({
        flowPath: '/path/to/flow.yaml',
        assertions: [{ type: 'visible', target: 'login-btn' }],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulator not found');
    });

    it('should pass on first iteration when all assertions pass', async () => {
      const { getBootedSimulators, getSimulator, launchApp, terminateApp } = await import(
        '../../../main/ios-tools/simulator'
      );
      const { runFlow } = await import('../../../main/ios-tools/flow-runner');
      const { assertVisible, assertNoCrash } = await import(
        '../../../main/ios-tools/assertions'
      );
      const { captureSnapshot } = await import('../../../main/ios-tools/snapshot');

      // Setup mocks
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [{ udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' }],
      });
      vi.mocked(getSimulator).mockResolvedValue({
        success: true,
        data: { udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' },
      });
      vi.mocked(terminateApp).mockResolvedValue({ success: true });
      vi.mocked(launchApp).mockResolvedValue({ success: true });
      vi.mocked(runFlow).mockResolvedValue({
        success: true,
        data: {
          passed: true,
          duration: 1000,
          flowPath: '/path/to/flow.yaml',
          udid: 'sim-123',
          totalSteps: 5,
          passedSteps: 5,
          failedSteps: 0,
          skippedSteps: 0,
          steps: [],
          rawOutput: '',
          exitCode: 0,
        },
      });
      vi.mocked(assertVisible).mockResolvedValue({
        success: true,
        data: {
          id: 'vis-1',
          type: 'visible',
          status: 'passed',
          passed: true,
          message: 'Element visible',
          target: 'login-btn',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
        },
      });
      vi.mocked(assertNoCrash).mockResolvedValue({
        success: true,
        data: {
          id: 'nc-1',
          type: 'no-crash',
          status: 'passed',
          passed: true,
          message: 'No crashes',
          target: 'com.test.app',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
        },
      });
      vi.mocked(captureSnapshot).mockResolvedValue({
        success: true,
        data: {
          id: 'snap-123',
          timestamp: new Date(),
          simulator: { udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0' },
          screenshot: { path: '/path/screenshot.png', size: 10000 },
          logs: { entries: [], counts: { error: 0, fault: 0, warning: 0, info: 0, debug: 0 } },
          crashes: { hasCrashes: false, reports: [] },
          artifactDir: '/tmp/artifacts',
        },
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const progressUpdates: unknown[] = [];

      const resultPromise = runShipLoop({
        flowPath: '/path/to/flow.yaml',
        assertions: [
          { type: 'visible', target: 'login-btn', targetType: 'identifier' },
          { type: 'noCrash' },
        ],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
        maxIterations: 3,
        iterationDelay: 100,
        onProgress: (update) => progressUpdates.push(update),
      });

      // Advance through all async operations
      await vi.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
      expect(result.data?.terminationReason).toBe('assertions_passed');
      expect(result.data?.iterationsRun).toBe(1);
      expect(result.data?.assertionsSummary.passed).toBe(2);
      expect(progressUpdates.length).toBeGreaterThan(0);
    });

    it('should iterate until assertions pass', async () => {
      const { getBootedSimulators, getSimulator, launchApp, terminateApp } = await import(
        '../../../main/ios-tools/simulator'
      );
      const { runFlow } = await import('../../../main/ios-tools/flow-runner');
      const { assertVisible } = await import('../../../main/ios-tools/assertions');
      const { captureSnapshot } = await import('../../../main/ios-tools/snapshot');

      // Setup mocks
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [{ udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' }],
      });
      vi.mocked(getSimulator).mockResolvedValue({
        success: true,
        data: { udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' },
      });
      vi.mocked(terminateApp).mockResolvedValue({ success: true });
      vi.mocked(launchApp).mockResolvedValue({ success: true });
      vi.mocked(runFlow).mockResolvedValue({
        success: true,
        data: {
          passed: true,
          duration: 1000,
          flowPath: '/path/to/flow.yaml',
          udid: 'sim-123',
          totalSteps: 5,
          passedSteps: 5,
          failedSteps: 0,
          skippedSteps: 0,
          steps: [],
          rawOutput: '',
          exitCode: 0,
        },
      });
      vi.mocked(captureSnapshot).mockResolvedValue({
        success: true,
        data: {
          id: 'snap-123',
          timestamp: new Date(),
          simulator: { udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0' },
          screenshot: { path: '/path/screenshot.png', size: 10000 },
          logs: { entries: [], counts: { error: 0, fault: 0, warning: 0, info: 0, debug: 0 } },
          crashes: { hasCrashes: false, reports: [] },
          artifactDir: '/tmp/artifacts',
        },
      });

      // Fail first 2 times, pass on 3rd
      let callCount = 0;
      vi.mocked(assertVisible).mockImplementation(async () => {
        callCount++;
        const passed = callCount >= 3;
        return {
          success: true,
          data: {
            id: `vis-${callCount}`,
            type: 'visible',
            status: passed ? 'passed' : 'failed',
            passed,
            message: passed ? 'Element visible' : 'Element not found',
            target: 'login-btn',
            startTime: new Date(),
            endTime: new Date(),
            duration: 100,
            attempts: [{ attempt: 1, timestamp: new Date(), success: passed, duration: 100 }],
          },
        };
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const resultPromise = runShipLoop({
        flowPath: '/path/to/flow.yaml',
        assertions: [{ type: 'visible', target: 'login-btn' }],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
        maxIterations: 5,
        iterationDelay: 100,
        relaunchOnIteration: false, // Disable to speed up test
        collectSnapshots: false, // Disable to speed up test
      });

      // Advance through iterations
      await vi.advanceTimersByTimeAsync(20000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
      expect(result.data?.terminationReason).toBe('assertions_passed');
      expect(result.data?.iterationsRun).toBe(3);
      expect(result.data?.assertionsSummary.specs[0].passedOn).toBe(3);
    });

    it('should stop at max iterations', async () => {
      const { getBootedSimulators, getSimulator, launchApp, terminateApp } = await import(
        '../../../main/ios-tools/simulator'
      );
      const { runFlow } = await import('../../../main/ios-tools/flow-runner');
      const { assertVisible } = await import('../../../main/ios-tools/assertions');

      // Setup mocks
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [{ udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' }],
      });
      vi.mocked(getSimulator).mockResolvedValue({
        success: true,
        data: { udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' },
      });
      vi.mocked(terminateApp).mockResolvedValue({ success: true });
      vi.mocked(launchApp).mockResolvedValue({ success: true });
      vi.mocked(runFlow).mockResolvedValue({
        success: true,
        data: {
          passed: true,
          duration: 1000,
          flowPath: '/path/to/flow.yaml',
          udid: 'sim-123',
          totalSteps: 5,
          passedSteps: 5,
          failedSteps: 0,
          skippedSteps: 0,
          steps: [],
          rawOutput: '',
          exitCode: 0,
        },
      });

      // Always fail
      vi.mocked(assertVisible).mockResolvedValue({
        success: true,
        data: {
          id: 'vis-1',
          type: 'visible',
          status: 'failed',
          passed: false,
          message: 'Element not found',
          target: 'login-btn',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          attempts: [{ attempt: 1, timestamp: new Date(), success: false, duration: 100 }],
        },
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const resultPromise = runShipLoop({
        flowPath: '/path/to/flow.yaml',
        assertions: [{ type: 'visible', target: 'login-btn' }],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
        maxIterations: 3,
        iterationDelay: 100,
        relaunchOnIteration: false,
        collectSnapshots: false,
      });

      await vi.advanceTimersByTimeAsync(20000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
      expect(result.data?.terminationReason).toBe('max_iterations');
      expect(result.data?.iterationsRun).toBe(3);
    });

    it('should stop when flow fails', async () => {
      const { getBootedSimulators, getSimulator, launchApp, terminateApp } = await import(
        '../../../main/ios-tools/simulator'
      );
      const { runFlow } = await import('../../../main/ios-tools/flow-runner');

      // Setup mocks
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [{ udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' }],
      });
      vi.mocked(getSimulator).mockResolvedValue({
        success: true,
        data: { udid: 'sim-123', name: 'iPhone 15', iosVersion: '17.0', state: 'Booted' },
      });
      vi.mocked(terminateApp).mockResolvedValue({ success: true });
      vi.mocked(launchApp).mockResolvedValue({ success: true });
      vi.mocked(runFlow).mockResolvedValue({
        success: false,
        error: 'Flow execution failed: file not found',
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const resultPromise = runShipLoop({
        flowPath: '/path/to/nonexistent.yaml',
        assertions: [{ type: 'visible', target: 'login-btn' }],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
        maxIterations: 3,
        relaunchOnIteration: false,
      });

      await vi.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
      expect(result.data?.terminationReason).toBe('flow_failed');
      expect(result.data?.iterationsRun).toBe(1);
      expect(result.data?.error).toContain('file not found');
    });

    it('should use explicit simulator UDID when provided', async () => {
      const { getBootedSimulators, getSimulator, launchApp, terminateApp } = await import(
        '../../../main/ios-tools/simulator'
      );
      const { runFlow } = await import('../../../main/ios-tools/flow-runner');
      const { assertVisible } = await import('../../../main/ios-tools/assertions');

      // Setup mocks - getBootedSimulators should NOT be called
      vi.mocked(getSimulator).mockResolvedValue({
        success: true,
        data: { udid: 'explicit-sim', name: 'iPhone 14', iosVersion: '16.0', state: 'Booted' },
      });
      vi.mocked(terminateApp).mockResolvedValue({ success: true });
      vi.mocked(launchApp).mockResolvedValue({ success: true });
      vi.mocked(runFlow).mockResolvedValue({
        success: true,
        data: {
          passed: true,
          duration: 1000,
          flowPath: '/path/to/flow.yaml',
          udid: 'explicit-sim',
          totalSteps: 1,
          passedSteps: 1,
          failedSteps: 0,
          skippedSteps: 0,
          steps: [],
          rawOutput: '',
          exitCode: 0,
        },
      });
      vi.mocked(assertVisible).mockResolvedValue({
        success: true,
        data: {
          id: 'vis-1',
          type: 'visible',
          status: 'passed',
          passed: true,
          message: 'Element visible',
          target: 'btn',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
        },
      });

      const { runShipLoop } = await import('../../../main/ios-tools/ship-loop');

      const resultPromise = runShipLoop({
        flowPath: '/path/to/flow.yaml',
        assertions: [{ type: 'visible', target: 'btn' }],
        bundleId: 'com.test.app',
        sessionId: 'test-session',
        udid: 'explicit-sim',
        maxIterations: 1,
        relaunchOnIteration: false,
        collectSnapshots: false,
      });

      await vi.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.simulator.udid).toBe('explicit-sim');
      expect(getBootedSimulators).not.toHaveBeenCalled();
    });
  });

  describe('formatShipLoopResult', () => {
    it('should format passed result as markdown', async () => {
      const { formatShipLoopResult } = await import('../../../main/ios-tools/ship-loop');

      const result = {
        passed: true,
        terminationReason: 'assertions_passed' as const,
        iterationsRun: 2,
        maxIterations: 5,
        totalDuration: 10000,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:00:10Z'),
        iterations: [],
        simulator: { udid: 'sim-1', name: 'iPhone 15', iosVersion: '17.0' },
        assertionsSummary: {
          total: 2,
          passed: 2,
          failed: 0,
          specs: [
            { spec: { type: 'visible' as const, target: 'btn' }, passedOn: 1, lastStatus: 'passed' as const },
            { spec: { type: 'noCrash' as const }, passedOn: 1, lastStatus: 'passed' as const },
          ],
        },
        artifactsDir: '/tmp/artifacts',
      };

      const formatted = formatShipLoopResult(result);

      expect(formatted).toContain('Feature Ship Loop Passed');
      expect(formatted).toContain('PASSED');
      expect(formatted).toContain('2/5');
      expect(formatted).toContain('iPhone 15');
    });

    it('should format failed result as markdown', async () => {
      const { formatShipLoopResult } = await import('../../../main/ios-tools/ship-loop');

      const result = {
        passed: false,
        terminationReason: 'max_iterations' as const,
        iterationsRun: 5,
        maxIterations: 5,
        totalDuration: 30000,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:00:30Z'),
        iterations: [],
        simulator: { udid: 'sim-1', name: 'iPhone 15', iosVersion: '17.0' },
        assertionsSummary: {
          total: 1,
          passed: 0,
          failed: 1,
          specs: [
            { spec: { type: 'visible' as const, target: 'missing-btn' }, passedOn: undefined, lastStatus: 'failed' as const },
          ],
        },
        artifactsDir: '/tmp/artifacts',
        error: 'Element never appeared',
      };

      const formatted = formatShipLoopResult(result);

      expect(formatted).toContain('Feature Ship Loop Failed');
      expect(formatted).toContain('FAILED');
      expect(formatted).toContain('Maximum iterations reached');
      expect(formatted).toContain('Element never appeared');
    });
  });

  describe('formatShipLoopResultAsJson', () => {
    it('should format as valid JSON', async () => {
      const { formatShipLoopResultAsJson } = await import('../../../main/ios-tools/ship-loop');

      const result = {
        passed: true,
        terminationReason: 'assertions_passed' as const,
        iterationsRun: 1,
        maxIterations: 3,
        totalDuration: 5000,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:00:05Z'),
        iterations: [],
        simulator: { udid: 'sim-1', name: 'iPhone 15', iosVersion: '17.0' },
        assertionsSummary: { total: 1, passed: 1, failed: 0, specs: [] },
        artifactsDir: '/tmp/artifacts',
      };

      const json = formatShipLoopResultAsJson(result);
      const parsed = JSON.parse(json);

      expect(parsed.passed).toBe(true);
      expect(parsed.terminationReason).toBe('assertions_passed');
    });
  });

  describe('formatShipLoopResultCompact', () => {
    it('should format passed result compactly', async () => {
      const { formatShipLoopResultCompact } = await import('../../../main/ios-tools/ship-loop');

      const result = {
        passed: true,
        terminationReason: 'assertions_passed' as const,
        iterationsRun: 2,
        maxIterations: 5,
        totalDuration: 10000,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:00:10Z'),
        iterations: [],
        simulator: { udid: 'sim-1', name: 'iPhone 15', iosVersion: '17.0' },
        assertionsSummary: { total: 2, passed: 2, failed: 0, specs: [] },
        artifactsDir: '/tmp/artifacts',
      };

      const compact = formatShipLoopResultCompact(result);

      expect(compact).toContain('[PASS]');
      expect(compact).toContain('2 iter');
      expect(compact).toContain('2/2 assertions');
    });

    it('should format failed result compactly', async () => {
      const { formatShipLoopResultCompact } = await import('../../../main/ios-tools/ship-loop');

      const result = {
        passed: false,
        terminationReason: 'max_iterations' as const,
        iterationsRun: 5,
        maxIterations: 5,
        totalDuration: 60000,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:01:00Z'),
        iterations: [],
        simulator: { udid: 'sim-1', name: 'iPhone 15', iosVersion: '17.0' },
        assertionsSummary: { total: 2, passed: 1, failed: 1, specs: [] },
        artifactsDir: '/tmp/artifacts',
      };

      const compact = formatShipLoopResultCompact(result);

      expect(compact).toContain('[FAIL]');
      expect(compact).toContain('5 iter');
      expect(compact).toContain('1/2 assertions');
    });
  });
});
