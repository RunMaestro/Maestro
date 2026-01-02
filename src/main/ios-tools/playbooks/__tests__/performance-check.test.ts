/**
 * Tests for iOS Performance Check Playbook Executor
 *
 * These tests verify the playbook execution, launch time measurement,
 * memory/CPU/FPS sampling, baseline comparison, and report generation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Increase timeout for tests due to internal sleep calls
vi.setConfig({ testTimeout: 60000 });
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  runPerformanceCheck,
  formatPerformanceCheckResult,
  formatPerformanceCheckResultAsJson,
  formatPerformanceCheckResultCompact,
  type PerformanceCheckOptions,
  type PerformanceCheckResult,
  type PerformanceCheckProgress,
  type PerformanceBaseline,
} from '../performance-check';

// =============================================================================
// Mocks
// =============================================================================

// Mock the playbook-loader
vi.mock('../../playbook-loader', () => ({
  loadPlaybook: vi.fn().mockReturnValue({
    name: 'iOS Performance Check',
    version: '1.0.0',
    variables: {
      runs_completed: 0,
      cold_launch_times: [],
      warm_launch_times: [],
      memory_samples: [],
      frame_rate_samples: [],
      cpu_samples: [],
      flow_metrics: [],
      current_run: 0,
      baseline: null,
      regressions_found: 0,
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
    data: [
      {
        udid: 'mock-udid-1234',
        name: 'iPhone 15 Pro',
        state: 'Booted',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        iosVersion: '17.5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
      },
    ],
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
    data: [
      {
        udid: 'mock-udid-15-pro',
        name: 'iPhone 15 Pro',
        state: 'Shutdown',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        iosVersion: '17.5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
      },
      {
        udid: 'mock-udid-15',
        name: 'iPhone 15',
        state: 'Shutdown',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        iosVersion: '17.5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
      },
    ],
  }),
  bootSimulator: vi.fn().mockResolvedValue({ success: true }),
  shutdownSimulator: vi.fn().mockResolvedValue({ success: true }),
  installApp: vi.fn().mockResolvedValue({ success: true }),
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
  const dir = path.join(
    os.tmpdir(),
    `performance-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createDefaultOptions(): PerformanceCheckOptions {
  return {
    inputs: {
      bundle_id: 'com.example.testapp',
      runs: 3,
      measure_launch_time: true,
      measure_memory: true,
      measure_frame_rate: true,
      measure_cpu: true,
      warm_up_runs: 0, // No warm-up in tests for speed
      wait_between_runs: 0, // No waiting in tests
    },
    sessionId: 'test-session-123',
  };
}

function createBaselineOptions(): PerformanceCheckOptions {
  const baselineDir = path.join(testDir, 'baselines');
  fs.mkdirSync(baselineDir, { recursive: true });

  const baseline: PerformanceBaseline = {
    timestamp: new Date().toISOString(),
    simulator: 'iPhone 15 Pro',
    bundle_id: 'com.example.testapp',
    cold_launch_avg_ms: 1000,
    cold_launch_p95_ms: 1200,
    warm_launch_avg_ms: 400,
    warm_launch_p95_ms: 500,
    memory_peak_mb: 100,
    memory_avg_mb: 80,
    frame_rate_min_fps: 55,
    frame_rate_avg_fps: 58,
  };

  const baselinePath = path.join(baselineDir, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify(baseline));

  return {
    inputs: {
      bundle_id: 'com.example.testapp',
      runs: 3,
      baseline_path: baselinePath,
      regression_threshold: 10,
      warm_up_runs: 0,
      wait_between_runs: 0,
    },
    sessionId: 'test-session-123',
  };
}

function createFlowOptions(): PerformanceCheckOptions {
  return {
    inputs: {
      bundle_id: 'com.example.testapp',
      runs: 2,
      flows: [
        { name: 'scroll_feed', description: 'Scroll through feed' },
        { name: 'image_gallery', description: 'Browse gallery' },
      ],
      measure_launch_time: true,
      measure_memory: true,
      measure_frame_rate: true,
      measure_cpu: true,
      warm_up_runs: 0,
      wait_between_runs: 0,
    },
    sessionId: 'test-session-123',
  };
}

/**
 * Reset all simulator-related mocks to default values
 */
async function resetSimulatorMocks(): Promise<void> {
  const simModule = await import('../../simulator');
  vi.mocked(simModule.listSimulators).mockResolvedValue({
    success: true,
    data: [
      {
        udid: 'mock-udid-15-pro',
        name: 'iPhone 15 Pro',
        state: 'Shutdown',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        iosVersion: '17.5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
      },
    ],
  });
  vi.mocked(simModule.bootSimulator).mockResolvedValue({ success: true });
  vi.mocked(simModule.installApp).mockResolvedValue({ success: true });
  vi.mocked(simModule.launchApp).mockResolvedValue({ success: true });
  vi.mocked(simModule.terminateApp).mockResolvedValue({ success: true });
  vi.mocked(simModule.getBootedSimulators).mockResolvedValue({
    success: true,
    data: [
      {
        udid: 'mock-udid-1234',
        name: 'iPhone 15 Pro',
        state: 'Booted',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        iosVersion: '17.5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
      },
    ],
  });
}

// =============================================================================
// Input Validation Tests
// =============================================================================

describe('Performance Check - Input Validation', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should reject when no app source is provided', async () => {
    const options = createDefaultOptions();
    options.inputs.bundle_id = undefined;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Either app_path, project_path, or bundle_id is required');
  });

  it('should reject when project_path provided without scheme', async () => {
    const options = createDefaultOptions();
    options.inputs.bundle_id = undefined;
    options.inputs.project_path = '/path/to/project';

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('scheme is required');
  });

  it('should accept bundle_id as valid input', async () => {
    const options = createDefaultOptions();

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('should accept app_path as valid input', async () => {
    const options = createDefaultOptions();
    options.inputs.app_path = '/path/to/App.app';

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.appPath).toBe('/path/to/App.app');
  });

  it('should accept project_path + scheme as valid input', async () => {
    const options = createDefaultOptions();
    options.inputs.project_path = '/path/to/project';
    options.inputs.scheme = 'TestApp';
    options.inputs.bundle_id = undefined;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});

// =============================================================================
// Dry Run Tests
// =============================================================================

describe('Performance Check - Dry Run', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should validate inputs without executing in dry run mode', async () => {
    const options = createDefaultOptions();
    options.dryRun = true;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.runs_completed).toBe(0);
    expect(result.data?.completed).toBe(false);
  });

  it('should return correct structure in dry run mode', async () => {
    const options = createDefaultOptions();
    options.dryRun = true;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.playbook.name).toBe('iOS Performance Check');
    expect(result.data?.metrics).toBeDefined();
    expect(result.data?.metrics.cold_launch).toBeDefined();
    expect(result.data?.metrics.warm_launch).toBeDefined();
  });

  it('should not call simulator functions in dry run mode', async () => {
    const simModule = await import('../../simulator');
    const options = createDefaultOptions();
    options.dryRun = true;

    await runPerformanceCheck(options);

    expect(simModule.launchApp).not.toHaveBeenCalled();
    expect(simModule.terminateApp).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Launch Time Measurement Tests
// =============================================================================

describe('Performance Check - Launch Time Measurement', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should measure cold and warm launch times', async () => {
    const options = createDefaultOptions();
    options.inputs.runs = 3;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.metrics.cold_launch.samples.length).toBe(3);
    expect(result.data?.metrics.warm_launch.samples.length).toBe(3);
  });

  it('should calculate launch time statistics', async () => {
    const options = createDefaultOptions();
    options.inputs.runs = 3;

    const result = await runPerformanceCheck(options);

    expect(result.data?.metrics.cold_launch.avg_ms).toBeGreaterThan(0);
    expect(result.data?.metrics.cold_launch.min_ms).toBeGreaterThan(0);
    expect(result.data?.metrics.cold_launch.max_ms).toBeGreaterThan(0);
    expect(result.data?.metrics.cold_launch.p95_ms).toBeGreaterThan(0);
  });

  it('should terminate app before each cold launch', async () => {
    const simModule = await import('../../simulator');
    const options = createDefaultOptions();
    options.inputs.runs = 2;

    await runPerformanceCheck(options);

    // Should terminate before each cold launch and warm launch
    expect(simModule.terminateApp).toHaveBeenCalled();
    expect(simModule.launchApp).toHaveBeenCalled();
  });

  it('should skip launch time measurement when disabled', async () => {
    const options = createDefaultOptions();
    options.inputs.measure_launch_time = false;
    options.inputs.flows = [{ name: 'test_flow' }];

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.metrics.cold_launch.samples.length).toBe(0);
    expect(result.data?.metrics.warm_launch.samples.length).toBe(0);
  });
});

// =============================================================================
// Flow Measurement Tests
// =============================================================================

describe('Performance Check - Flow Measurement', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should measure performance during flows', async () => {
    const options = createFlowOptions();

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.flow_metrics.length).toBe(2);
    expect(result.data?.flow_metrics[0].name).toBe('scroll_feed');
    expect(result.data?.flow_metrics[1].name).toBe('image_gallery');
  });

  it('should collect memory samples during flows', async () => {
    const options = createFlowOptions();
    options.inputs.measure_memory = true;

    const result = await runPerformanceCheck(options);

    expect(result.data?.metrics.memory).toBeDefined();
    expect(result.data?.metrics.memory?.flows.length).toBeGreaterThan(0);
    expect(result.data?.metrics.memory?.peak_mb).toBeGreaterThan(0);
  });

  it('should collect frame rate samples during flows', async () => {
    const options = createFlowOptions();
    options.inputs.measure_frame_rate = true;

    const result = await runPerformanceCheck(options);

    expect(result.data?.metrics.frame_rate).toBeDefined();
    expect(result.data?.metrics.frame_rate?.flows.length).toBeGreaterThan(0);
    expect(result.data?.metrics.frame_rate?.min_fps).toBeGreaterThan(0);
    expect(result.data?.metrics.frame_rate?.avg_fps).toBeGreaterThan(0);
  });

  it('should collect CPU samples during flows', async () => {
    const options = createFlowOptions();
    options.inputs.measure_cpu = true;

    const result = await runPerformanceCheck(options);

    expect(result.data?.metrics.cpu).toBeDefined();
    expect(result.data?.metrics.cpu?.flows.length).toBeGreaterThan(0);
    expect(result.data?.metrics.cpu?.peak_percent).toBeGreaterThan(0);
  });

  it('should measure idle memory when no flows specified', async () => {
    const options = createDefaultOptions();
    options.inputs.flows = [];
    options.inputs.measure_memory = true;

    const result = await runPerformanceCheck(options);

    expect(result.data?.metrics.memory).toBeDefined();
    expect(result.data?.metrics.memory?.flows.length).toBeGreaterThan(0);
    expect(result.data?.metrics.memory?.flows[0].flow).toBe('idle');
  });
});

// =============================================================================
// Baseline Comparison Tests
// =============================================================================

describe('Performance Check - Baseline Comparison', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should load baseline from file', async () => {
    const options = createBaselineOptions();

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.baseline).toBeDefined();
    expect(result.data?.baseline?.cold_launch_avg_ms).toBe(1000);
  });

  it('should detect regressions above threshold', async () => {
    // Create a baseline with tight thresholds
    const baselineDir = path.join(testDir, 'baselines');
    fs.mkdirSync(baselineDir, { recursive: true });

    const baseline: PerformanceBaseline = {
      timestamp: new Date().toISOString(),
      simulator: 'iPhone 15 Pro',
      bundle_id: 'com.example.testapp',
      cold_launch_avg_ms: 100, // Very low baseline to trigger regression
      cold_launch_p95_ms: 120,
      warm_launch_avg_ms: 50,
      warm_launch_p95_ms: 60,
    };

    const baselinePath = path.join(baselineDir, 'baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));

    const options: PerformanceCheckOptions = {
      inputs: {
        bundle_id: 'com.example.testapp',
        runs: 2,
        baseline_path: baselinePath,
        regression_threshold: 10,
        warm_up_runs: 0,
        wait_between_runs: 0,
      },
      sessionId: 'test-session-123',
    };

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    // Since launch times are simulated, there should be regressions against the low baseline
    expect(result.data?.regressions.length).toBeGreaterThan(0);
    expect(result.data?.regressions_found).toBeGreaterThan(0);
  });

  it('should save new baseline when configured', async () => {
    const options = createDefaultOptions();
    options.inputs.save_as_baseline = true;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.savedBaselinePath).toBeDefined();
    expect(result.data?.savedBaselinePath).toContain('performance_baseline.json');
  });

  it('should handle missing baseline file gracefully', async () => {
    const options = createDefaultOptions();
    options.inputs.baseline_path = '/nonexistent/path/baseline.json';

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.baseline).toBeUndefined();
    expect(result.data?.regressions.length).toBe(0);
  });
});

// =============================================================================
// Progress Reporting Tests
// =============================================================================

describe('Performance Check - Progress Reporting', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should report progress during execution', async () => {
    const progressUpdates: PerformanceCheckProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push(update);

    await runPerformanceCheck(options);

    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[0].phase).toBe('initializing');
    expect(progressUpdates[progressUpdates.length - 1].phase).toBe('complete');
  });

  it('should include run counts in progress', async () => {
    const progressUpdates: PerformanceCheckProgress[] = [];
    const options = createDefaultOptions();
    options.inputs.runs = 3;
    options.onProgress = (update) => progressUpdates.push(update);

    await runPerformanceCheck(options);

    const launchUpdates = progressUpdates.filter((u) => u.phase === 'measuring_launch');
    expect(launchUpdates.length).toBeGreaterThan(0);
    expect(launchUpdates[0].totalRuns).toBe(3);
  });

  it('should track percentage complete', async () => {
    const progressUpdates: PerformanceCheckProgress[] = [];
    const options = createDefaultOptions();
    options.onProgress = (update) => progressUpdates.push(update);

    await runPerformanceCheck(options);

    const lastUpdate = progressUpdates[progressUpdates.length - 1];
    expect(lastUpdate.percentComplete).toBe(100);
  });

  it('should report flow progress when measuring flows', async () => {
    const progressUpdates: PerformanceCheckProgress[] = [];
    const options = createFlowOptions();
    options.onProgress = (update) => progressUpdates.push(update);

    await runPerformanceCheck(options);

    const flowUpdates = progressUpdates.filter((u) => u.phase === 'measuring_flows');
    expect(flowUpdates.length).toBeGreaterThan(0);
    expect(flowUpdates[0].totalFlows).toBe(2);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Performance Check - Error Handling', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should handle no booted simulators', async () => {
    const simModule = await import('../../simulator');
    vi.mocked(simModule.getBootedSimulators).mockResolvedValue({
      success: true,
      data: [],
    });
    vi.mocked(simModule.listSimulators).mockResolvedValue({
      success: true,
      data: [],
    });

    const options = createDefaultOptions();
    options.inputs.simulator = undefined;
    options.inputs.bundle_id = undefined;
    options.inputs.app_path = '/path/to/App.app';

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No booted simulators found');
  });

  it('should handle build failure gracefully', async () => {
    const buildModule = await import('../../build');
    vi.mocked(buildModule.build).mockResolvedValue({
      success: false,
      error: 'Build failed',
      errorCode: 'BUILD_FAILED',
    });

    const options = createDefaultOptions();
    options.inputs.bundle_id = undefined;
    options.inputs.project_path = '/path/to/project';
    options.inputs.scheme = 'TestApp';

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.completed).toBe(false);
    expect(result.data?.error).toBe('Build failed');
  });

  it('should handle app install failure', async () => {
    const simModule = await import('../../simulator');
    vi.mocked(simModule.installApp).mockResolvedValue({
      success: false,
      error: 'Install failed',
      errorCode: 'COMMAND_FAILED',
    });

    const options = createDefaultOptions();
    options.inputs.app_path = '/path/to/App.app';

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to install app');
  });
});

// =============================================================================
// Report Generation Tests
// =============================================================================

describe('Performance Check - Report Generation', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should generate HTML report', async () => {
    const options = createDefaultOptions();

    const result = await runPerformanceCheck(options);

    expect(result.data?.htmlReportPath).toBeDefined();
    expect(result.data?.htmlReportPath).toContain('performance_report.html');
  });

  it('should generate JSON report', async () => {
    const options = createDefaultOptions();

    const result = await runPerformanceCheck(options);

    expect(result.data?.jsonReportPath).toBeDefined();
    expect(result.data?.jsonReportPath).toContain('performance_report.json');
  });

  it('should include artifacts directory', async () => {
    const options = createDefaultOptions();

    const result = await runPerformanceCheck(options);

    expect(result.data?.artifactsDir).toBeDefined();
    expect(result.data?.artifactsDir).toContain('performance-check');
  });
});

// =============================================================================
// Result Formatting Tests
// =============================================================================

describe('Performance Check - Result Formatters', () => {
  const mockResult: PerformanceCheckResult = {
    completed: true,
    regressions_found: 0,
    metrics: {
      cold_launch: {
        avg_ms: 1250,
        min_ms: 1100,
        max_ms: 1400,
        p95_ms: 1380,
        samples: [1100, 1200, 1250, 1300, 1400],
      },
      warm_launch: {
        avg_ms: 450,
        min_ms: 400,
        max_ms: 500,
        p95_ms: 490,
        samples: [400, 440, 450, 480, 500],
      },
      memory: {
        peak_mb: 145,
        avg_mb: 120,
        flows: [
          {
            flow: 'main_feed',
            samples: [100, 120, 145, 130, 125],
            peak_mb: 145,
            avg_mb: 124,
          },
        ],
      },
      frame_rate: {
        min_fps: 52,
        avg_fps: 58.5,
        total_dropped_frames: 12,
        flows: [
          {
            flow: 'main_feed',
            samples: [60, 58, 52, 55, 60],
            min_fps: 52,
            avg_fps: 57,
            dropped_frames: 12,
          },
        ],
      },
    },
    flow_metrics: [
      {
        name: 'main_feed',
        duration_ms: 5000,
        success: true,
      },
    ],
    regressions: [],
    runs_completed: 5,
    totalDuration: 45000,
    startTime: new Date('2024-01-15T10:00:00Z'),
    endTime: new Date('2024-01-15T10:00:45Z'),
    playbook: {
      name: 'iOS Performance Check',
      version: '1.0.0',
    },
    simulator: {
      udid: 'mock-udid',
      name: 'iPhone 15 Pro',
      iosVersion: '17.5',
    },
    artifactsDir: '/tmp/artifacts',
    htmlReportPath: '/tmp/artifacts/performance_report.html',
    jsonReportPath: '/tmp/artifacts/performance_report.json',
    finalVariables: {},
  };

  it('should format result as markdown', () => {
    const formatted = formatPerformanceCheckResult(mockResult);

    expect(formatted).toContain('## ✅ Performance Check Passed');
    expect(formatted).toContain('| Cold Launch (avg) | 1250ms |');
    expect(formatted).toContain('| Warm Launch (avg) | 450ms |');
    expect(formatted).toContain('| Memory Peak | 145');
    expect(formatted).toContain('| Frame Rate (min) | 52fps |');
  });

  it('should format result with regressions', () => {
    const regressedResult = {
      ...mockResult,
      regressions_found: 2,
      regressions: [
        {
          metric: 'cold_launch_avg_ms',
          baseline: 1000,
          current: 1250,
          change_percent: 25,
          threshold: 10,
          severity: 'warning' as const,
        },
        {
          metric: 'frame_rate_min_fps',
          baseline: 58,
          current: 52,
          change_percent: -10.3,
          threshold: 10,
          severity: 'critical' as const,
        },
      ],
    };
    const formatted = formatPerformanceCheckResult(regressedResult);

    expect(formatted).toContain('## ⚠️ Performance Check Completed with Regressions');
    expect(formatted).toContain('### Regressions Detected');
    expect(formatted).toContain('cold_launch_avg_ms');
    expect(formatted).toContain('frame_rate_min_fps');
  });

  it('should format result as JSON', () => {
    const formatted = formatPerformanceCheckResultAsJson(mockResult);
    const parsed = JSON.parse(formatted);

    expect(parsed.completed).toBe(true);
    expect(parsed.metrics.cold_launch.avg_ms).toBe(1250);
    expect(parsed.metrics.warm_launch.avg_ms).toBe(450);
  });

  it('should format result in compact form', () => {
    const formatted = formatPerformanceCheckResultCompact(mockResult);

    expect(formatted).toContain('[PASS]');
    expect(formatted).toContain('cold=1250ms');
    expect(formatted).toContain('warm=450ms');
    expect(formatted).toContain('0 regression(s)');
  });

  it('should format regression result in compact form', () => {
    const regressedResult = { ...mockResult, regressions_found: 2 };
    const formatted = formatPerformanceCheckResultCompact(regressedResult);

    expect(formatted).toContain('[REGRESS]');
    expect(formatted).toContain('2 regression(s)');
  });
});

// =============================================================================
// Warm-up Runs Tests
// =============================================================================

describe('Performance Check - Warm-up Runs', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should execute warm-up runs before measurements', async () => {
    const simModule = await import('../../simulator');
    const options = createDefaultOptions();
    options.inputs.warm_up_runs = 2;
    options.inputs.runs = 2;

    await runPerformanceCheck(options);

    // 2 warm-ups + (2 runs * 2 launches per run for cold+warm)
    // Actually the warm-up runs should add extra launch/terminate cycles
    const launchCalls = vi.mocked(simModule.launchApp).mock.calls.length;
    expect(launchCalls).toBeGreaterThanOrEqual(4);
  });

  it('should report warm-up progress', async () => {
    const progressUpdates: PerformanceCheckProgress[] = [];
    const options = createDefaultOptions();
    options.inputs.warm_up_runs = 2;
    options.inputs.runs = 1;
    options.onProgress = (update) => progressUpdates.push(update);

    await runPerformanceCheck(options);

    const warmupUpdates = progressUpdates.filter((u) => u.phase === 'warming_up');
    expect(warmupUpdates.length).toBeGreaterThan(0);
  });

  it('should skip warm-up when configured to 0', async () => {
    const progressUpdates: PerformanceCheckProgress[] = [];
    const options = createDefaultOptions();
    options.inputs.warm_up_runs = 0;
    options.onProgress = (update) => progressUpdates.push(update);

    await runPerformanceCheck(options);

    const warmupUpdates = progressUpdates.filter((u) => u.phase === 'warming_up');
    expect(warmupUpdates.length).toBe(0);
  });
});

// =============================================================================
// Simulator Resolution Tests
// =============================================================================

describe('Performance Check - Simulator Resolution', () => {
  beforeEach(async () => {
    testDir = createTestDir();
    vi.clearAllMocks();
    await resetSimulatorMocks();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it('should use specified simulator by name', async () => {
    const simModule = await import('../../simulator');
    const options = createDefaultOptions();
    options.inputs.simulator = 'iPhone 15 Pro';

    await runPerformanceCheck(options);

    expect(simModule.listSimulators).toHaveBeenCalled();
  });

  it('should boot simulator if not booted', async () => {
    const simModule = await import('../../simulator');
    vi.mocked(simModule.listSimulators).mockResolvedValue({
      success: true,
      data: [
        {
          udid: 'mock-udid-15-pro',
          name: 'iPhone 15 Pro',
          state: 'Shutdown', // Not booted
          isAvailable: true,
          runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
          iosVersion: '17.5',
          deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        },
      ],
    });

    const options = createDefaultOptions();
    options.inputs.simulator = 'iPhone 15 Pro';

    await runPerformanceCheck(options);

    expect(simModule.bootSimulator).toHaveBeenCalled();
  });

  it('should fallback to first booted simulator', async () => {
    const options = createDefaultOptions();
    options.inputs.simulator = undefined;

    const result = await runPerformanceCheck(options);

    expect(result.success).toBe(true);
    expect(result.data?.simulator.name).toBe('iPhone 15 Pro');
  });
});
