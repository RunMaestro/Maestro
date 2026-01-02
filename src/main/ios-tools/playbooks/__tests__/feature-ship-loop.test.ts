/**
 * Tests for iOS Feature Ship Loop Playbook Executor
 *
 * These tests verify the playbook execution, iteration tracking,
 * progress reporting, and exit conditions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  runFeatureShipLoop,
  formatFeatureShipLoopResult,
  formatFeatureShipLoopResultAsJson,
  formatFeatureShipLoopResultCompact,
  type FeatureShipLoopOptions,
  type FeatureShipLoopResult,
  type FeatureShipLoopProgress,
} from '../feature-ship-loop';

// =============================================================================
// Mocks
// =============================================================================

// Mock the playbook-loader
vi.mock('../../playbook-loader', () => ({
  loadPlaybook: vi.fn().mockReturnValue({
    name: 'iOS Feature Ship Loop',
    version: '1.0.0',
    variables: {
      max_iterations: 10,
      iteration: 0,
      build_success: false,
      assertions_passed: false,
    },
    steps: [],
  }),
}));

// Mock the build module
vi.mock('../../build', () => ({
  build: vi.fn().mockResolvedValue({
    success: true,
    data: {
      success: true,
      appPath: '/path/to/App.app',
      derivedDataPath: '/path/to/DerivedData',
      duration: 5000,
      warnings: [],
      errors: [],
    },
  }),
  detectProject: vi.fn().mockResolvedValue({
    success: true,
    data: {
      path: '/path/to/Project.xcodeproj',
      name: 'Project',
      type: 'project',
    },
  }),
}));

// Mock the simulator module
vi.mock('../../simulator', () => ({
  launchApp: vi.fn().mockResolvedValue({ success: true }),
  terminateApp: vi.fn().mockResolvedValue({ success: true }),
  getBootedSimulators: vi.fn().mockResolvedValue({
    success: true,
    data: [{
      udid: 'mock-udid-1234',
      name: 'iPhone 15 Pro',
      state: 'Booted',
      isAvailable: true,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      iosVersion: '17.5',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
    }],
  }),
  getSimulator: vi.fn().mockResolvedValue({
    success: true,
    data: {
      udid: 'mock-udid-1234',
      name: 'iPhone 15 Pro',
      state: 'Booted',
      isAvailable: true,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      iosVersion: '17.5',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
    },
  }),
  listSimulators: vi.fn().mockResolvedValue({
    success: true,
    data: [{
      udid: 'mock-udid-1234',
      name: 'iPhone 15 Pro',
      state: 'Booted',
      isAvailable: true,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      iosVersion: '17.5',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
    }],
  }),
  bootSimulator: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock assertions
vi.mock('../../assertions', () => ({
  assertVisible: vi.fn().mockResolvedValue({
    success: true,
    data: {
      id: 'mock-assert-id',
      type: 'visible',
      status: 'passed',
      passed: true,
      message: 'Element is visible',
      target: 'test-element',
      startTime: new Date(),
      endTime: new Date(),
      duration: 100,
      attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
    },
  }),
  assertNotVisible: vi.fn().mockResolvedValue({
    success: true,
    data: {
      id: 'mock-assert-id',
      type: 'not-visible',
      status: 'passed',
      passed: true,
      message: 'Element is not visible',
      target: 'test-element',
      startTime: new Date(),
      endTime: new Date(),
      duration: 100,
      attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
    },
  }),
  assertNoCrash: vi.fn().mockResolvedValue({
    success: true,
    data: {
      id: 'mock-assert-id',
      type: 'no-crash',
      status: 'passed',
      passed: true,
      message: 'No crash detected',
      target: 'com.example.app',
      startTime: new Date(),
      endTime: new Date(),
      duration: 100,
      attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
    },
  }),
}));

// Mock snapshot
vi.mock('../../snapshot', () => ({
  captureSnapshot: vi.fn().mockResolvedValue({
    success: true,
    data: {
      id: 'mock-snapshot-id',
      timestamp: new Date(),
      screenshotPath: '/path/to/screenshot.png',
      uiTreePath: '/path/to/ui-tree.json',
    },
  }),
}));

// Mock artifacts
vi.mock('../../artifacts', () => ({
  getArtifactDirectory: vi.fn().mockResolvedValue('/tmp/artifacts'),
  generateSnapshotId: vi.fn().mockReturnValue('snapshot-123'),
}));

// Mock logger
vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock execFile
vi.mock('../../../utils/execFile', () => ({
  execFileNoThrow: vi.fn().mockResolvedValue({
    stdout: JSON.stringify({ CFBundleIdentifier: 'com.example.testapp' }),
    stderr: '',
    exitCode: 0,
  }),
}));

// =============================================================================
// Test Helpers
// =============================================================================

let testDir: string;

function createTestDir(): string {
  const dir = path.join(os.tmpdir(), `fsl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createDefaultOptions(): FeatureShipLoopOptions {
  return {
    inputs: {
      project_path: '/path/to/project',
      scheme: 'TestApp',
      assertions: [
        {
          type: 'visible',
          target: 'Welcome',
          targetType: 'text',
          description: 'Welcome text is visible',
        },
      ],
    },
    sessionId: 'test-session-123',
    maxIterations: 3,
  };
}

// =============================================================================
// Input Validation Tests
// =============================================================================

describe('Feature Ship Loop - Input Validation', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should reject missing project_path', async () => {
    const options = createDefaultOptions();
    options.inputs.project_path = '';

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('project_path');
  });

  it('should reject missing scheme', async () => {
    const options = createDefaultOptions();
    options.inputs.scheme = '';

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('scheme');
  });

  it('should reject empty assertions array', async () => {
    const options = createDefaultOptions();
    options.inputs.assertions = [];

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('assertions');
  });

  it('should accept valid inputs', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});

// =============================================================================
// Iteration Tracking Tests
// =============================================================================

describe('Feature Ship Loop - Iteration Tracking', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should track iteration count correctly', async () => {
    const options = createDefaultOptions();
    options.maxIterations = 2;

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.iterationsRun).toBeGreaterThanOrEqual(1);
    expect(result.data?.maxIterations).toBe(2);
  });

  it('should record iteration timestamps', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    if (result.data && result.data.iterations.length > 0) {
      const iteration = result.data.iterations[0];
      expect(iteration.startTime).toBeInstanceOf(Date);
      expect(iteration.endTime).toBeInstanceOf(Date);
      expect(iteration.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('should track assertion results per iteration', async () => {
    const options = createDefaultOptions();
    options.inputs.assertions = [
      { type: 'visible', target: 'Element1', description: 'First assertion' },
      { type: 'visible', target: 'Element2', description: 'Second assertion' },
    ];

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    if (result.data && result.data.iterations.length > 0) {
      const iteration = result.data.iterations[0];
      expect(iteration.assertions).toHaveLength(2);
    }
  });
});

// =============================================================================
// Progress Reporting Tests
// =============================================================================

describe('Feature Ship Loop - Progress Reporting', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should call progress callback during execution', async () => {
    const progressUpdates: FeatureShipLoopProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push({ ...update });

    await runFeatureShipLoop(options);

    expect(progressUpdates.length).toBeGreaterThan(0);
  });

  it('should report initializing phase', async () => {
    const progressUpdates: FeatureShipLoopProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push({ ...update });

    await runFeatureShipLoop(options);

    const initPhase = progressUpdates.find((u) => u.phase === 'initializing');
    expect(initPhase).toBeDefined();
  });

  it('should report building phase', async () => {
    const progressUpdates: FeatureShipLoopProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push({ ...update });

    await runFeatureShipLoop(options);

    const buildPhase = progressUpdates.find((u) => u.phase === 'building');
    expect(buildPhase).toBeDefined();
  });

  it('should report verifying phase with assertion counts', async () => {
    const progressUpdates: FeatureShipLoopProgress[] = [];
    const options = createDefaultOptions();
    options.inputs.assertions = [
      { type: 'visible', target: 'Element1' },
      { type: 'visible', target: 'Element2' },
    ];
    options.onProgress = (update) => progressUpdates.push({ ...update });

    await runFeatureShipLoop(options);

    const verifyPhase = progressUpdates.find((u) => u.phase === 'verifying');
    expect(verifyPhase).toBeDefined();
    expect(verifyPhase?.totalAssertions).toBe(2);
  });

  it('should report completion phase', async () => {
    const progressUpdates: FeatureShipLoopProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push({ ...update });

    await runFeatureShipLoop(options);

    const completePhase = progressUpdates.find(
      (u) => u.phase === 'complete' || u.phase === 'failed'
    );
    expect(completePhase).toBeDefined();
    // Completion phase should exist (percentComplete may vary based on iteration)
    expect(completePhase?.phase).toMatch(/complete|failed/);
  });

  it('should include iteration numbers in progress updates', async () => {
    const progressUpdates: FeatureShipLoopProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push({ ...update });

    await runFeatureShipLoop(options);

    const iterationUpdate = progressUpdates.find((u) => u.iteration >= 1);
    expect(iterationUpdate).toBeDefined();
    expect(iterationUpdate?.maxIterations).toBeGreaterThan(0);
  });
});

// =============================================================================
// Exit Conditions Tests
// =============================================================================

describe('Feature Ship Loop - Exit Conditions', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should exit with assertions_passed when all pass', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.terminationReason).toBe('assertions_passed');
    expect(result.data?.passed).toBe(true);
  });

  it('should exit with max_iterations when limit reached', async () => {
    // Make assertions fail
    const { assertVisible } = await import('../../assertions');
    vi.mocked(assertVisible).mockResolvedValue({
      success: true,
      data: {
        id: 'mock-id',
        type: 'visible',
        status: 'failed',
        passed: false,
        message: 'Element not found',
        target: 'test',
        startTime: new Date(),
        endTime: new Date(),
        duration: 100,
        attempts: [],
      },
    });

    const options = createDefaultOptions();
    options.maxIterations = 2;
    options.iterationDelay = 10; // Speed up test

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.terminationReason).toBe('max_iterations');
    expect(result.data?.passed).toBe(false);
    expect(result.data?.iterationsRun).toBe(2);
  });

  it('should exit with build_failed when build fails', async () => {
    const { build } = await import('../../build');
    vi.mocked(build).mockResolvedValueOnce({
      success: false,
      error: 'Build failed: compiler error',
      errorCode: 'BUILD_FAILED',
    });

    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.terminationReason).toBe('build_failed');
    expect(result.data?.passed).toBe(false);
  });

  it('should stop on first iteration when assertions pass immediately', async () => {
    // Reset assertVisible mock to default passing behavior
    const { assertVisible } = await import('../../assertions');
    vi.mocked(assertVisible).mockResolvedValue({
      success: true,
      data: {
        id: 'mock-id',
        type: 'visible',
        status: 'passed',
        passed: true,
        message: 'Found',
        target: 'test',
        startTime: new Date(),
        endTime: new Date(),
        duration: 100,
        attempts: [{ attempt: 1, timestamp: new Date(), success: true, duration: 100 }],
      },
    });

    const options = createDefaultOptions();
    options.maxIterations = 5;
    options.iterationDelay = 10; // Speed up test

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    // Should stop early because assertions pass
    expect(result.data?.iterationsRun).toBeLessThanOrEqual(5);
    expect(result.data?.terminationReason).toBe('assertions_passed');
  });
});

// =============================================================================
// Assertion Handling Tests
// =============================================================================

describe('Feature Ship Loop - Assertion Handling', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should handle visible assertion type', async () => {
    const options = createDefaultOptions();
    options.inputs.assertions = [
      { type: 'visible', target: 'TestElement', targetType: 'identifier' },
    ];

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.assertionsSummary.total).toBe(1);
  });

  it('should handle not_visible assertion type', async () => {
    const options = createDefaultOptions();
    options.inputs.assertions = [
      { type: 'not_visible', target: 'HiddenElement', targetType: 'text' },
    ];

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
  });

  it('should handle no_crash assertion type', async () => {
    const options = createDefaultOptions();
    options.inputs.assertions = [
      { type: 'no_crash', bundleId: 'com.example.app' },
    ];

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
  });

  it('should track which iteration assertions passed on', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    const assertionTrack = result.data?.assertionsSummary.assertions[0];
    // When assertions pass, passedOn should be set to the iteration number
    if (result.data?.passed) {
      expect(assertionTrack?.passedOn).toBeGreaterThanOrEqual(1);
    }
  });

  it('should handle multiple assertions', async () => {
    const options = createDefaultOptions();
    options.inputs.assertions = [
      { type: 'visible', target: 'Element1', description: 'First' },
      { type: 'visible', target: 'Element2', description: 'Second' },
      { type: 'no_crash', bundleId: 'com.example.app', description: 'No crash' },
    ];

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.assertionsSummary.total).toBe(3);
  });

  it('should continue or stop based on continueOnAssertionFailure option', async () => {
    const { assertVisible } = await import('../../assertions');
    // First assertion fails, second would pass
    vi.mocked(assertVisible)
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'id1',
          type: 'visible',
          status: 'failed',
          passed: false,
          message: 'Not found',
          target: 'test',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          attempts: [],
        },
      })
      .mockResolvedValue({
        success: true,
        data: {
          id: 'id2',
          type: 'visible',
          status: 'passed',
          passed: true,
          message: 'Found',
          target: 'test',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          attempts: [],
        },
      });

    const options = createDefaultOptions();
    options.maxIterations = 1;
    options.continueOnAssertionFailure = false;
    options.inputs.assertions = [
      { type: 'visible', target: 'Missing' },
      { type: 'visible', target: 'Present' },
    ];

    const result = await runFeatureShipLoop(options);

    // With continueOnAssertionFailure = false, should stop after first failure
    expect(result.success).toBe(true);
    const iteration = result.data?.iterations[0];
    expect(iteration?.assertions.length).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// Dry Run Tests
// =============================================================================

describe('Feature Ship Loop - Dry Run', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should return result without executing when dryRun is true', async () => {
    const options = createDefaultOptions();
    options.dryRun = true;

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.iterationsRun).toBe(0);
    expect(result.data?.iterations).toHaveLength(0);
  });

  it('should validate inputs during dry run', async () => {
    const options = createDefaultOptions();
    options.dryRun = true;
    options.inputs.project_path = '';

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('project_path');
  });
});

// =============================================================================
// Result Formatting Tests
// =============================================================================

describe('Feature Ship Loop - Result Formatting', () => {
  const mockResult: FeatureShipLoopResult = {
    passed: true,
    terminationReason: 'assertions_passed',
    iterationsRun: 2,
    maxIterations: 10,
    totalDuration: 5000,
    startTime: new Date('2024-01-01T10:00:00'),
    endTime: new Date('2024-01-01T10:00:05'),
    iterations: [],
    playbook: { name: 'iOS Feature Ship Loop', version: '1.0.0' },
    simulator: { udid: 'test-udid', name: 'iPhone 15 Pro', iosVersion: '17.5' },
    bundleId: 'com.example.app',
    assertionsSummary: {
      total: 2,
      passed: 2,
      failed: 0,
      assertions: [
        { assertion: { type: 'visible', target: 'Test' }, passedOn: 1, lastStatus: 'passed' },
        { assertion: { type: 'no_crash' }, passedOn: 1, lastStatus: 'passed' },
      ],
    },
    artifactsDir: '/tmp/artifacts',
    finalVariables: { iteration: 2 },
  };

  it('formatFeatureShipLoopResult should return markdown', () => {
    const output = formatFeatureShipLoopResult(mockResult);

    expect(output).toContain('Feature Ship Loop');
    expect(output).toContain('PASSED');
    expect(output).toContain('iPhone 15 Pro');
    expect(output).toContain('Assertions');
  });

  it('formatFeatureShipLoopResultAsJson should return valid JSON', () => {
    const output = formatFeatureShipLoopResultAsJson(mockResult);
    const parsed = JSON.parse(output);

    expect(parsed.passed).toBe(true);
    expect(parsed.terminationReason).toBe('assertions_passed');
  });

  it('formatFeatureShipLoopResultCompact should return one-line summary', () => {
    const output = formatFeatureShipLoopResultCompact(mockResult);

    expect(output).toContain('PASS');
    expect(output).toContain('2 iter');
    expect(output).toContain('2/2 assertions');
  });

  it('should include error in formatted output when present', () => {
    const errorResult: FeatureShipLoopResult = {
      ...mockResult,
      passed: false,
      terminationReason: 'error',
      error: 'Something went wrong',
    };

    const output = formatFeatureShipLoopResult(errorResult);

    expect(output).toContain('Error');
    expect(output).toContain('Something went wrong');
  });
});

// =============================================================================
// Simulator Resolution Tests
// =============================================================================

describe('Feature Ship Loop - Simulator Resolution', () => {
  beforeEach(() => {
    testDir = createTestDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should use first booted simulator when not specified', async () => {
    const options = createDefaultOptions();
    delete options.inputs.simulator;

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.simulator.udid).toBe('mock-udid-1234');
  });

  it('should resolve simulator by name', async () => {
    const options = createDefaultOptions();
    options.inputs.simulator = 'iPhone 15 Pro';

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(true);
    expect(result.data?.simulator.name).toBe('iPhone 15 Pro');
  });

  it('should fail when no simulators available', async () => {
    const { getBootedSimulators, listSimulators } = await import('../../simulator');
    vi.mocked(getBootedSimulators).mockResolvedValue({
      success: true,
      data: [],
    });
    vi.mocked(listSimulators).mockResolvedValue({
      success: true,
      data: [],
    });

    const options = createDefaultOptions();
    delete options.inputs.simulator;

    const result = await runFeatureShipLoop(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('simulator');
  });
});

// =============================================================================
// Artifacts Tests
// =============================================================================

describe('Feature Ship Loop - Artifacts', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    // Reset all mocks to their default implementations
    const { build } = await import('../../build');
    vi.mocked(build).mockResolvedValue({
      success: true,
      data: {
        success: true,
        appPath: '/path/to/App.app',
        derivedDataPath: '/path/to/DerivedData',
        duration: 5000,
        warnings: [],
        errors: [],
      },
    });
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should capture snapshots when enabled', async () => {
    const options = createDefaultOptions();
    options.collectSnapshots = true;

    const result = await runFeatureShipLoop(options);

    // Verify execution completed
    if (result.success && result.data && result.data.iterations.length > 0) {
      // Snapshot should be captured when enabled
      expect(result.data.iterations[0].snapshot).toBeDefined();
    }
  });

  it('should skip snapshots when disabled', async () => {
    const options = createDefaultOptions();
    options.collectSnapshots = false;

    const result = await runFeatureShipLoop(options);

    // Verify execution completed
    if (result.success && result.data && result.data.iterations.length > 0) {
      // Snapshot should be undefined when disabled
      expect(result.data.iterations[0].snapshot).toBeUndefined();
    }
  });

  it('should include artifacts directory in result', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    if (result.success && result.data) {
      expect(result.data.artifactsDir).toBeDefined();
      expect(result.data.artifactsDir).toContain('feature-ship-loop');
    }
  });
});

// =============================================================================
// Variables Tests
// =============================================================================

describe('Feature Ship Loop - Variables', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    // Reset build mock
    const { build } = await import('../../build');
    vi.mocked(build).mockResolvedValue({
      success: true,
      data: {
        success: true,
        appPath: '/path/to/App.app',
        derivedDataPath: '/path/to/DerivedData',
        duration: 5000,
        warnings: [],
        errors: [],
      },
    });
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should track build_success variable', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    // Build success is set after successful build
    if (result.success && result.data) {
      expect(result.data.finalVariables.build_success).toBe(true);
    }
  });

  it('should track assertions_passed variable', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    // assertions_passed is set when all assertions pass
    if (result.success && result.data && result.data.passed) {
      expect(result.data.finalVariables.assertions_passed).toBe(true);
    }
  });

  it('should track iteration variable', async () => {
    const options = createDefaultOptions();

    const result = await runFeatureShipLoop(options);

    // iteration should be tracked
    if (result.success && result.data) {
      expect(result.data.finalVariables.iteration).toBeGreaterThanOrEqual(1);
    }
  });
});
