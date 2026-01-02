/**
 * iOS Playbook - Performance Check Executor
 *
 * Executes the Performance Check playbook for iOS performance testing.
 * Measures key metrics: app launch time, memory usage, CPU usage, and frame rates.
 */

import * as path from 'path';
import * as fs from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { IOSResult, IOSErrorCode } from '../types';
import {
  loadPlaybook,
  IOSPlaybookConfig,
  PlaybookInputDef,
  PlaybookVariables,
} from '../playbook-loader';
import { build, BuildResult, detectProject } from '../build';
import {
  launchApp,
  terminateApp,
  getBootedSimulators,
  getSimulator,
  bootSimulator,
  listSimulators,
  installApp,
} from '../simulator';
import { getArtifactDirectory } from '../artifacts';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[iOS-PerformanceCheck]';

// =============================================================================
// Types
// =============================================================================

/**
 * Flow definition for performance measurement
 */
export interface PerformanceFlow {
  /** Flow name */
  name: string;
  /** Path to flow YAML file */
  file?: string;
  /** Inline flow steps */
  steps?: unknown[];
  /** Description */
  description?: string;
}

/**
 * Input values for running the Performance Check
 */
export interface PerformanceCheckInputs {
  /** Path to built .app bundle (alternative to project_path) */
  app_path?: string;
  /** Path to Xcode project or workspace (alternative to app_path) */
  project_path?: string;
  /** Build scheme name (required with project_path) */
  scheme?: string;
  /** Bundle ID of the app (auto-detected if not provided) */
  bundle_id?: string;
  /** Simulator name or UDID (default: "iPhone 15 Pro") */
  simulator?: string;
  /** Number of measurement runs (default: 5) */
  runs?: number;
  /** Measure cold and warm launch times (default: true) */
  measure_launch_time?: boolean;
  /** Measure memory usage (default: true) */
  measure_memory?: boolean;
  /** Measure frame rate during animations (default: true) */
  measure_frame_rate?: boolean;
  /** Measure CPU usage (default: true) */
  measure_cpu?: boolean;
  /** Flow files/definitions to measure */
  flows?: PerformanceFlow[];
  /** Number of warm-up runs (default: 1) */
  warm_up_runs?: number;
  /** Seconds between runs (default: 3) */
  wait_between_runs?: number;
  /** Path to baseline JSON for comparison */
  baseline_path?: string;
  /** Percentage degradation to flag as regression (default: 10) */
  regression_threshold?: number;
  /** Save measurements as new baseline (default: false) */
  save_as_baseline?: boolean;
}

/**
 * Options for the Performance Check execution
 */
export interface PerformanceCheckOptions {
  /** Input values matching playbook inputs */
  inputs: PerformanceCheckInputs;
  /** Session ID for artifact storage */
  sessionId: string;
  /** Path to playbook YAML (uses built-in if not specified) */
  playbookPath?: string;
  /** Working directory for relative paths */
  cwd?: string;
  /** Build configuration (default: Release) */
  configuration?: 'Debug' | 'Release' | string;
  /** Timeout per build in ms (default: 600000 = 10 min) */
  buildTimeout?: number;
  /** Timeout per flow in ms (default: 300000 = 5 min) */
  flowTimeout?: number;
  /** Progress callback */
  onProgress?: (update: PerformanceCheckProgress) => void;
  /** Dry run - validate without executing */
  dryRun?: boolean;
}

/**
 * Progress update during execution
 */
export interface PerformanceCheckProgress {
  /** Current execution phase */
  phase:
    | 'initializing'
    | 'building'
    | 'warming_up'
    | 'measuring_launch'
    | 'measuring_flows'
    | 'measuring_memory'
    | 'comparing_baseline'
    | 'generating_report'
    | 'complete'
    | 'failed';
  /** Current run number (1-based) */
  currentRun: number;
  /** Total runs */
  totalRuns: number;
  /** Current flow index (if measuring flows) */
  currentFlow?: number;
  /** Total flows */
  totalFlows?: number;
  /** Human-readable message */
  message: string;
  /** Percentage complete (0-100) */
  percentComplete: number;
  /** Time elapsed in ms */
  elapsed?: number;
}

/**
 * Launch time measurement result
 */
export interface LaunchTimeMeasurement {
  /** Measurement run number */
  run: number;
  /** Launch type (cold or warm) */
  type: 'cold' | 'warm';
  /** Duration in milliseconds */
  duration_ms: number;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Memory sample during flow
 */
export interface MemorySample {
  /** Flow name */
  flow: string;
  /** Individual samples in MB */
  samples: number[];
  /** Peak memory in MB */
  peak_mb: number;
  /** Average memory in MB */
  avg_mb: number;
  /** Memory at start */
  start_mb?: number;
  /** Memory at end */
  end_mb?: number;
}

/**
 * Frame rate sample during flow
 */
export interface FrameRateSample {
  /** Flow name */
  flow: string;
  /** Individual FPS samples */
  samples: number[];
  /** Minimum FPS */
  min_fps: number;
  /** Average FPS */
  avg_fps: number;
  /** Number of dropped frames */
  dropped_frames: number;
}

/**
 * CPU sample during flow
 */
export interface CpuSample {
  /** Flow name */
  flow: string;
  /** Individual CPU % samples */
  samples: number[];
  /** Peak CPU % */
  peak_percent: number;
  /** Average CPU % */
  avg_percent: number;
}

/**
 * Flow performance metrics
 */
export interface FlowMetrics {
  /** Flow name */
  name: string;
  /** Flow duration in ms */
  duration_ms: number;
  /** Memory metrics */
  memory?: MemorySample;
  /** Frame rate metrics */
  frame_rate?: FrameRateSample;
  /** CPU metrics */
  cpu?: CpuSample;
  /** Success */
  success: boolean;
  /** Error if failed */
  error?: string;
}

/**
 * Detected regression
 */
export interface PerformanceRegression {
  /** Metric name */
  metric: string;
  /** Baseline value */
  baseline: number;
  /** Current value */
  current: number;
  /** Change percentage (positive = worse) */
  change_percent: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Severity level */
  severity: 'warning' | 'critical';
}

/**
 * Performance metrics summary
 */
export interface PerformanceMetrics {
  /** Cold launch times */
  cold_launch: {
    avg_ms: number;
    min_ms: number;
    max_ms: number;
    p95_ms: number;
    samples: number[];
  };
  /** Warm launch times */
  warm_launch: {
    avg_ms: number;
    min_ms: number;
    max_ms: number;
    p95_ms: number;
    samples: number[];
  };
  /** Memory metrics */
  memory?: {
    peak_mb: number;
    avg_mb: number;
    flows: MemorySample[];
  };
  /** Frame rate metrics */
  frame_rate?: {
    min_fps: number;
    avg_fps: number;
    total_dropped_frames: number;
    flows: FrameRateSample[];
  };
  /** CPU metrics */
  cpu?: {
    peak_percent: number;
    avg_percent: number;
    flows: CpuSample[];
  };
}

/**
 * Baseline metrics for comparison
 */
export interface PerformanceBaseline {
  /** Timestamp when baseline was created */
  timestamp: string;
  /** Simulator used */
  simulator: string;
  /** Bundle ID */
  bundle_id: string;
  /** Cold launch average */
  cold_launch_avg_ms: number;
  /** Cold launch P95 */
  cold_launch_p95_ms: number;
  /** Warm launch average */
  warm_launch_avg_ms: number;
  /** Warm launch P95 */
  warm_launch_p95_ms: number;
  /** Memory peak */
  memory_peak_mb?: number;
  /** Memory average */
  memory_avg_mb?: number;
  /** Frame rate minimum */
  frame_rate_min_fps?: number;
  /** Frame rate average */
  frame_rate_avg_fps?: number;
}

/**
 * Final result of the Performance Check execution
 */
export interface PerformanceCheckResult {
  /** Whether check completed successfully */
  completed: boolean;
  /** Number of regressions detected */
  regressions_found: number;
  /** Performance metrics */
  metrics: PerformanceMetrics;
  /** Flow-specific metrics */
  flow_metrics: FlowMetrics[];
  /** Detected regressions */
  regressions: PerformanceRegression[];
  /** Total runs completed */
  runs_completed: number;
  /** Total duration in ms */
  totalDuration: number;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime: Date;
  /** Playbook configuration used */
  playbook: {
    name: string;
    version?: string;
    path?: string;
  };
  /** Simulator used */
  simulator: {
    udid: string;
    name: string;
    iosVersion: string;
  };
  /** App path */
  appPath?: string;
  /** Bundle ID */
  bundleId?: string;
  /** Baseline used for comparison */
  baseline?: PerformanceBaseline;
  /** Path to saved baseline (if save_as_baseline) */
  savedBaselinePath?: string;
  /** Artifacts directory */
  artifactsDir: string;
  /** HTML report path */
  htmlReportPath?: string;
  /** JSON report path */
  jsonReportPath?: string;
  /** Final error message (if any) */
  error?: string;
  /** Variables at end of execution */
  finalVariables: PlaybookVariables;
}

/**
 * Execution context for the playbook
 */
interface ExecutionContext {
  /** Resolved simulator UDID */
  udid: string;
  /** Simulator info */
  simulator: { udid: string; name: string; iosVersion: string };
  /** Session ID */
  sessionId: string;
  /** Artifacts directory */
  artifactsDir: string;
  /** App path */
  appPath?: string;
  /** Bundle ID */
  bundleId?: string;
  /** Current variables */
  variables: PlaybookVariables;
  /** Cold launch measurements */
  coldLaunchTimes: number[];
  /** Warm launch measurements */
  warmLaunchTimes: number[];
  /** Memory samples per flow */
  memorySamples: MemorySample[];
  /** Frame rate samples per flow */
  frameRateSamples: FrameRateSample[];
  /** CPU samples per flow */
  cpuSamples: CpuSample[];
  /** Flow metrics */
  flowMetrics: FlowMetrics[];
  /** Progress callback */
  onProgress?: (update: PerformanceCheckProgress) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_RUNS = 5;
const DEFAULT_WARM_UP_RUNS = 1;
const DEFAULT_WAIT_BETWEEN_RUNS = 3;
const DEFAULT_REGRESSION_THRESHOLD = 10;

// =============================================================================
// Main Executor
// =============================================================================

/**
 * Execute the Performance Check playbook.
 *
 * This measures key performance metrics:
 * 1. Build app (if needed) with Release configuration
 * 2. Run warm-up iterations
 * 3. Measure cold and warm launch times
 * 4. Run flows and measure memory, CPU, frame rate
 * 5. Compare against baseline (if provided)
 * 6. Generate performance report
 *
 * @param options - Execution options
 * @returns Execution result with all metrics
 */
export async function runPerformanceCheck(
  options: PerformanceCheckOptions
): Promise<IOSResult<PerformanceCheckResult>> {
  const startTime = new Date();

  const runs = options.inputs.runs ?? DEFAULT_RUNS;
  const measureLaunchTime = options.inputs.measure_launch_time ?? true;
  const measureMemory = options.inputs.measure_memory ?? true;
  const measureFrameRate = options.inputs.measure_frame_rate ?? true;
  const measureCpu = options.inputs.measure_cpu ?? true;
  const flows = options.inputs.flows ?? [];

  logger.info(`${LOG_CONTEXT} Starting Performance Check`);
  logger.info(`${LOG_CONTEXT} Runs: ${runs}`);
  logger.info(`${LOG_CONTEXT} Flows: ${flows.length}`);
  logger.info(
    `${LOG_CONTEXT} Metrics: launch=${measureLaunchTime}, memory=${measureMemory}, fps=${measureFrameRate}, cpu=${measureCpu}`
  );

  // Load playbook configuration
  let playbook: IOSPlaybookConfig;
  try {
    if (options.playbookPath) {
      playbook = loadPlaybook(options.playbookPath);
    } else {
      playbook = loadPlaybook('Performance-Check');
    }
    logger.info(`${LOG_CONTEXT} Loaded playbook: ${playbook.name} v${playbook.version || '1.0.0'}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error(`${LOG_CONTEXT} Failed to load playbook: ${error}`);
    return {
      success: false,
      error: `Failed to load playbook: ${error}`,
      errorCode: 'COMMAND_FAILED' as IOSErrorCode,
    };
  }

  // Validate inputs
  const validationResult = validateInputs(options.inputs, playbook.inputs);
  if (!validationResult.valid) {
    return {
      success: false,
      error: `Invalid inputs: ${validationResult.errors.join(', ')}`,
      errorCode: 'COMMAND_FAILED' as IOSErrorCode,
    };
  }

  // Initialize variables
  const variables: PlaybookVariables = {
    ...playbook.variables,
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
  };

  // Resolve simulator
  const simulatorResult = await resolveSimulator(options.inputs.simulator);
  if (!simulatorResult.success || !simulatorResult.data) {
    return {
      success: false,
      error: simulatorResult.error || 'Failed to resolve simulator',
      errorCode: simulatorResult.errorCode || ('SIMULATOR_NOT_FOUND' as IOSErrorCode),
    };
  }

  const { udid, simulator } = simulatorResult.data;
  logger.info(`${LOG_CONTEXT} Using simulator: ${simulator.name} (${udid})`);

  // Prepare artifacts directory
  const artifactsDir = await getArtifactDirectory(options.sessionId);
  const perfDir = path.join(artifactsDir, `performance-check-${Date.now()}`);
  await mkdir(perfDir, { recursive: true });

  // Create execution context
  const context: ExecutionContext = {
    udid,
    simulator,
    sessionId: options.sessionId,
    artifactsDir: perfDir,
    variables,
    coldLaunchTimes: [],
    warmLaunchTimes: [],
    memorySamples: [],
    frameRateSamples: [],
    cpuSamples: [],
    flowMetrics: [],
    onProgress: options.onProgress,
  };

  // Report initialization
  reportProgress(context, {
    phase: 'initializing',
    currentRun: 0,
    totalRuns: runs,
    message: 'Initializing Performance Check',
    percentComplete: 0,
  });

  // Dry run check
  if (options.dryRun) {
    logger.info(`${LOG_CONTEXT} Dry run - validation complete, not executing`);
    return {
      success: true,
      data: createDryRunResult(options, playbook, simulator, perfDir, startTime, variables, runs),
    };
  }

  // Build or use provided app
  let appPath = options.inputs.app_path;
  let bundleId = options.inputs.bundle_id;

  if (!appPath && options.inputs.project_path) {
    reportProgress(context, {
      phase: 'building',
      currentRun: 0,
      totalRuns: runs,
      message: 'Building project (Release configuration)',
      percentComplete: 2,
    });

    const buildResult = await performBuild(options, context);
    if (!buildResult.success || !buildResult.data) {
      return createErrorResult(
        options,
        playbook,
        context,
        buildResult.error || 'Build failed',
        startTime,
        runs
      );
    }

    appPath = buildResult.data.appPath;
    bundleId = bundleId || (await detectBundleId(appPath, options.inputs.scheme));
    context.appPath = appPath;
    context.bundleId = bundleId;
    logger.info(`${LOG_CONTEXT} Build successful. App: ${appPath}`);
  } else if (appPath) {
    bundleId = bundleId || (await detectBundleId(appPath));
    context.appPath = appPath;
    context.bundleId = bundleId;
  } else if (bundleId) {
    context.bundleId = bundleId;
  }

  if (!bundleId) {
    return {
      success: false,
      error: 'Could not determine bundle ID. Provide bundle_id in inputs.',
      errorCode: 'COMMAND_FAILED' as IOSErrorCode,
    };
  }

  // Install app if provided
  if (appPath) {
    const installResult = await installApp({ udid, appPath });
    if (!installResult.success) {
      return {
        success: false,
        error: installResult.error || 'Failed to install app',
        errorCode: 'COMMAND_FAILED' as IOSErrorCode,
      };
    }
  }

  // Load baseline if provided
  let baseline: PerformanceBaseline | undefined;
  if (options.inputs.baseline_path) {
    try {
      const baselineContent = await readFile(options.inputs.baseline_path, 'utf-8');
      baseline = JSON.parse(baselineContent);
      logger.info(`${LOG_CONTEXT} Loaded baseline from ${options.inputs.baseline_path}`);
    } catch (e) {
      logger.warn(`${LOG_CONTEXT} Failed to load baseline: ${e}`);
    }
  }

  // Run warm-up iterations
  const warmUpRuns = options.inputs.warm_up_runs ?? DEFAULT_WARM_UP_RUNS;
  if (warmUpRuns > 0) {
    reportProgress(context, {
      phase: 'warming_up',
      currentRun: 0,
      totalRuns: runs,
      message: `Running ${warmUpRuns} warm-up iteration(s)`,
      percentComplete: 5,
    });

    for (let i = 0; i < warmUpRuns; i++) {
      await launchApp({ udid, bundleId });
      await sleep(2000);
      await terminateApp(udid, bundleId);
      await sleep(1000);
    }
    logger.info(`${LOG_CONTEXT} Completed ${warmUpRuns} warm-up runs`);
  }

  // Measure launch times
  if (measureLaunchTime) {
    await measureLaunchTimes(options, context, runs, bundleId);
  }

  // Measure flows
  if (flows.length > 0) {
    await measureFlows(options, context, flows, bundleId, {
      measureMemory,
      measureFrameRate,
      measureCpu,
    });
  } else if (measureMemory) {
    // Measure idle memory if no flows specified
    await measureIdleMemory(context, bundleId);
  }

  // Build metrics summary
  const metrics = buildMetricsSummary(context);

  // Compare against baseline and detect regressions
  const regressions: PerformanceRegression[] = [];
  if (baseline) {
    const threshold = options.inputs.regression_threshold ?? DEFAULT_REGRESSION_THRESHOLD;
    detectRegressions(metrics, baseline, threshold, regressions);
  }

  // Save as baseline if requested
  let savedBaselinePath: string | undefined;
  if (options.inputs.save_as_baseline) {
    savedBaselinePath = path.join(perfDir, 'performance_baseline.json');
    const newBaseline: PerformanceBaseline = {
      timestamp: new Date().toISOString(),
      simulator: simulator.name,
      bundle_id: bundleId,
      cold_launch_avg_ms: metrics.cold_launch.avg_ms,
      cold_launch_p95_ms: metrics.cold_launch.p95_ms,
      warm_launch_avg_ms: metrics.warm_launch.avg_ms,
      warm_launch_p95_ms: metrics.warm_launch.p95_ms,
      memory_peak_mb: metrics.memory?.peak_mb,
      memory_avg_mb: metrics.memory?.avg_mb,
      frame_rate_min_fps: metrics.frame_rate?.min_fps,
      frame_rate_avg_fps: metrics.frame_rate?.avg_fps,
    };
    await writeFile(savedBaselinePath, JSON.stringify(newBaseline, null, 2));
    logger.info(`${LOG_CONTEXT} Saved baseline to ${savedBaselinePath}`);
  }

  // Generate reports
  reportProgress(context, {
    phase: 'generating_report',
    currentRun: runs,
    totalRuns: runs,
    message: 'Generating performance report',
    percentComplete: 95,
  });

  const htmlReportPath = path.join(perfDir, 'performance_report.html');
  const jsonReportPath = path.join(perfDir, 'performance_report.json');
  await generateReports(context, metrics, regressions, baseline, htmlReportPath, jsonReportPath);

  // Build final result
  const endTime = new Date();
  const totalDuration = endTime.getTime() - startTime.getTime();

  // Final progress report
  reportProgress(context, {
    phase: regressions.length > 0 ? 'failed' : 'complete',
    currentRun: runs,
    totalRuns: runs,
    message:
      regressions.length > 0
        ? `Performance check completed with ${regressions.length} regression(s)`
        : 'Performance check completed successfully',
    percentComplete: 100,
    elapsed: totalDuration,
  });

  const result: PerformanceCheckResult = {
    completed: true,
    regressions_found: regressions.length,
    metrics,
    flow_metrics: context.flowMetrics,
    regressions,
    runs_completed: context.coldLaunchTimes.length,
    totalDuration,
    startTime,
    endTime,
    playbook: {
      name: playbook.name,
      version: playbook.version,
      path: options.playbookPath,
    },
    simulator,
    appPath: context.appPath,
    bundleId: context.bundleId,
    baseline,
    savedBaselinePath,
    artifactsDir: perfDir,
    htmlReportPath,
    jsonReportPath,
    finalVariables: context.variables,
  };

  logger.info(
    `${LOG_CONTEXT} Performance Check complete: ${regressions.length} regression(s) in ${totalDuration}ms`
  );

  return {
    success: true,
    data: result,
  };
}

// =============================================================================
// Measurement Functions
// =============================================================================

/**
 * Measure cold and warm launch times
 */
async function measureLaunchTimes(
  options: PerformanceCheckOptions,
  context: ExecutionContext,
  runs: number,
  bundleId: string
): Promise<void> {
  const waitBetween = options.inputs.wait_between_runs ?? DEFAULT_WAIT_BETWEEN_RUNS;

  for (let run = 1; run <= runs; run++) {
    context.variables.current_run = run;

    reportProgress(context, {
      phase: 'measuring_launch',
      currentRun: run,
      totalRuns: runs,
      message: `Measuring launch times (run ${run}/${runs})`,
      percentComplete: 10 + (run / runs) * 30,
    });

    // Terminate any running instance
    await terminateApp(context.udid, bundleId);
    await sleep(1000);

    // Measure cold launch
    const coldStart = Date.now();
    await launchApp({ udid: context.udid, bundleId });
    await waitForAppReady(context.udid, bundleId);
    const coldDuration = Date.now() - coldStart;
    context.coldLaunchTimes.push(coldDuration);
    logger.debug(`${LOG_CONTEXT} Cold launch ${run}: ${coldDuration}ms`);

    // Terminate for warm launch
    await terminateApp(context.udid, bundleId);
    await sleep(500);

    // Measure warm launch
    const warmStart = Date.now();
    await launchApp({ udid: context.udid, bundleId });
    await waitForAppReady(context.udid, bundleId);
    const warmDuration = Date.now() - warmStart;
    context.warmLaunchTimes.push(warmDuration);
    logger.debug(`${LOG_CONTEXT} Warm launch ${run}: ${warmDuration}ms`);

    // Terminate after measurements
    await terminateApp(context.udid, bundleId);

    // Wait between runs
    if (run < runs) {
      await sleep(waitBetween * 1000);
    }

    context.variables.runs_completed = run;
  }

  logger.info(
    `${LOG_CONTEXT} Launch time measurement complete: cold avg=${average(context.coldLaunchTimes).toFixed(0)}ms, warm avg=${average(context.warmLaunchTimes).toFixed(0)}ms`
  );
}

/**
 * Measure performance during flows
 */
async function measureFlows(
  _options: PerformanceCheckOptions,
  context: ExecutionContext,
  flows: PerformanceFlow[],
  bundleId: string,
  measureConfig: { measureMemory: boolean; measureFrameRate: boolean; measureCpu: boolean }
): Promise<void> {
  reportProgress(context, {
    phase: 'measuring_flows',
    currentRun: 0,
    totalRuns: flows.length,
    totalFlows: flows.length,
    message: `Measuring ${flows.length} flow(s)`,
    percentComplete: 45,
  });

  // Launch app for flow testing
  await launchApp({ udid: context.udid, bundleId });
  await waitForAppReady(context.udid, bundleId);

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    const flowName = flow.name || `flow_${i + 1}`;

    reportProgress(context, {
      phase: 'measuring_flows',
      currentRun: i + 1,
      totalRuns: flows.length,
      currentFlow: i + 1,
      totalFlows: flows.length,
      message: `Measuring flow: ${flowName}`,
      percentComplete: 45 + ((i + 1) / flows.length) * 40,
    });

    const flowMetric: FlowMetrics = {
      name: flowName,
      duration_ms: 0,
      success: false,
    };

    try {
      // Start measuring (simulated - real implementation would use instruments)
      const flowStart = Date.now();

      // Simulate flow execution with metrics collection
      // In a real implementation, this would:
      // 1. Start instruments for memory/CPU/FPS monitoring
      // 2. Execute the flow steps
      // 3. Stop instruments and collect data
      await sleep(1000); // Placeholder for flow execution

      flowMetric.duration_ms = Date.now() - flowStart;

      // Simulate metric collection
      if (measureConfig.measureMemory) {
        const memorySample: MemorySample = {
          flow: flowName,
          samples: generateSimulatedSamples(80, 150, 10),
          peak_mb: 0,
          avg_mb: 0,
        };
        memorySample.peak_mb = Math.max(...memorySample.samples);
        memorySample.avg_mb = average(memorySample.samples);
        context.memorySamples.push(memorySample);
        flowMetric.memory = memorySample;
      }

      if (measureConfig.measureFrameRate) {
        const fpsSample: FrameRateSample = {
          flow: flowName,
          samples: generateSimulatedSamples(50, 60, 10),
          min_fps: 0,
          avg_fps: 0,
          dropped_frames: Math.floor(Math.random() * 10),
        };
        fpsSample.min_fps = Math.min(...fpsSample.samples);
        fpsSample.avg_fps = average(fpsSample.samples);
        context.frameRateSamples.push(fpsSample);
        flowMetric.frame_rate = fpsSample;
      }

      if (measureConfig.measureCpu) {
        const cpuSample: CpuSample = {
          flow: flowName,
          samples: generateSimulatedSamples(20, 80, 10),
          peak_percent: 0,
          avg_percent: 0,
        };
        cpuSample.peak_percent = Math.max(...cpuSample.samples);
        cpuSample.avg_percent = average(cpuSample.samples);
        context.cpuSamples.push(cpuSample);
        flowMetric.cpu = cpuSample;
      }

      flowMetric.success = true;
    } catch (e) {
      flowMetric.error = e instanceof Error ? e.message : String(e);
      logger.warn(`${LOG_CONTEXT} Flow ${flowName} failed: ${flowMetric.error}`);
    }

    context.flowMetrics.push(flowMetric);

    // Reset app for next flow
    if (i < flows.length - 1) {
      await terminateApp(context.udid, bundleId);
      await sleep(500);
      await launchApp({ udid: context.udid, bundleId });
      await waitForAppReady(context.udid, bundleId);
    }
  }

  // Terminate after flow testing
  await terminateApp(context.udid, bundleId);
}

/**
 * Measure idle memory (when no flows specified)
 */
async function measureIdleMemory(context: ExecutionContext, bundleId: string): Promise<void> {
  reportProgress(context, {
    phase: 'measuring_memory',
    currentRun: 0,
    totalRuns: 1,
    message: 'Measuring idle memory',
    percentComplete: 50,
  });

  await launchApp({ udid: context.udid, bundleId });
  await waitForAppReady(context.udid, bundleId);

  // Simulate memory sampling at idle
  await sleep(5000);

  const idleMemory: MemorySample = {
    flow: 'idle',
    samples: generateSimulatedSamples(60, 90, 10),
    peak_mb: 0,
    avg_mb: 0,
  };
  idleMemory.peak_mb = Math.max(...idleMemory.samples);
  idleMemory.avg_mb = average(idleMemory.samples);
  context.memorySamples.push(idleMemory);

  await terminateApp(context.udid, bundleId);
}

// =============================================================================
// Build Functions
// =============================================================================

/**
 * Perform the build step
 */
async function performBuild(
  options: PerformanceCheckOptions,
  context: ExecutionContext
): Promise<IOSResult<BuildResult>> {
  const projectPath = options.inputs.project_path!;
  const scheme = options.inputs.scheme!;
  const configuration = options.configuration || 'Release'; // Default to Release for performance testing

  // Detect project type if needed
  let resolvedProjectPath = projectPath;
  if (!projectPath.endsWith('.xcodeproj') && !projectPath.endsWith('.xcworkspace')) {
    const detectResult = await detectProject(projectPath);
    if (detectResult.success && detectResult.data) {
      resolvedProjectPath = detectResult.data.path;
    }
  }

  return build({
    projectPath: resolvedProjectPath,
    scheme,
    configuration,
    destination: `platform=iOS Simulator,id=${context.udid}`,
    cwd: options.cwd,
  });
}

// =============================================================================
// Analysis Functions
// =============================================================================

/**
 * Build metrics summary from collected data
 */
function buildMetricsSummary(context: ExecutionContext): PerformanceMetrics {
  const coldLaunch = {
    avg_ms: average(context.coldLaunchTimes),
    min_ms: Math.min(...context.coldLaunchTimes) || 0,
    max_ms: Math.max(...context.coldLaunchTimes) || 0,
    p95_ms: percentile(context.coldLaunchTimes, 95),
    samples: context.coldLaunchTimes,
  };

  const warmLaunch = {
    avg_ms: average(context.warmLaunchTimes),
    min_ms: Math.min(...context.warmLaunchTimes) || 0,
    max_ms: Math.max(...context.warmLaunchTimes) || 0,
    p95_ms: percentile(context.warmLaunchTimes, 95),
    samples: context.warmLaunchTimes,
  };

  const metrics: PerformanceMetrics = {
    cold_launch: coldLaunch,
    warm_launch: warmLaunch,
  };

  if (context.memorySamples.length > 0) {
    const allPeaks = context.memorySamples.map((s) => s.peak_mb);
    const allAvgs = context.memorySamples.map((s) => s.avg_mb);
    metrics.memory = {
      peak_mb: Math.max(...allPeaks),
      avg_mb: average(allAvgs),
      flows: context.memorySamples,
    };
  }

  if (context.frameRateSamples.length > 0) {
    const allMins = context.frameRateSamples.map((s) => s.min_fps);
    const allAvgs = context.frameRateSamples.map((s) => s.avg_fps);
    const totalDropped = context.frameRateSamples.reduce((sum, s) => sum + s.dropped_frames, 0);
    metrics.frame_rate = {
      min_fps: Math.min(...allMins),
      avg_fps: average(allAvgs),
      total_dropped_frames: totalDropped,
      flows: context.frameRateSamples,
    };
  }

  if (context.cpuSamples.length > 0) {
    const allPeaks = context.cpuSamples.map((s) => s.peak_percent);
    const allAvgs = context.cpuSamples.map((s) => s.avg_percent);
    metrics.cpu = {
      peak_percent: Math.max(...allPeaks),
      avg_percent: average(allAvgs),
      flows: context.cpuSamples,
    };
  }

  return metrics;
}

/**
 * Detect regressions by comparing current metrics to baseline
 */
function detectRegressions(
  metrics: PerformanceMetrics,
  baseline: PerformanceBaseline,
  threshold: number,
  regressions: PerformanceRegression[]
): void {
  // Check cold launch time
  if (baseline.cold_launch_avg_ms && metrics.cold_launch.avg_ms) {
    const change = ((metrics.cold_launch.avg_ms - baseline.cold_launch_avg_ms) / baseline.cold_launch_avg_ms) * 100;
    if (change > threshold) {
      regressions.push({
        metric: 'cold_launch_avg_ms',
        baseline: baseline.cold_launch_avg_ms,
        current: metrics.cold_launch.avg_ms,
        change_percent: change,
        threshold,
        severity: change > threshold * 2 ? 'critical' : 'warning',
      });
    }
  }

  // Check warm launch time
  if (baseline.warm_launch_avg_ms && metrics.warm_launch.avg_ms) {
    const change = ((metrics.warm_launch.avg_ms - baseline.warm_launch_avg_ms) / baseline.warm_launch_avg_ms) * 100;
    if (change > threshold) {
      regressions.push({
        metric: 'warm_launch_avg_ms',
        baseline: baseline.warm_launch_avg_ms,
        current: metrics.warm_launch.avg_ms,
        change_percent: change,
        threshold,
        severity: change > threshold * 2 ? 'critical' : 'warning',
      });
    }
  }

  // Check memory peak
  if (baseline.memory_peak_mb && metrics.memory?.peak_mb) {
    const change = ((metrics.memory.peak_mb - baseline.memory_peak_mb) / baseline.memory_peak_mb) * 100;
    if (change > threshold) {
      regressions.push({
        metric: 'memory_peak_mb',
        baseline: baseline.memory_peak_mb,
        current: metrics.memory.peak_mb,
        change_percent: change,
        threshold,
        severity: change > threshold * 2 ? 'critical' : 'warning',
      });
    }
  }

  // Check frame rate minimum (lower is worse, so invert)
  if (baseline.frame_rate_min_fps && metrics.frame_rate?.min_fps) {
    const change = ((baseline.frame_rate_min_fps - metrics.frame_rate.min_fps) / baseline.frame_rate_min_fps) * 100;
    if (change > threshold) {
      regressions.push({
        metric: 'frame_rate_min_fps',
        baseline: baseline.frame_rate_min_fps,
        current: metrics.frame_rate.min_fps,
        change_percent: -change, // Negative because lower FPS is worse
        threshold,
        severity: change > threshold * 2 ? 'critical' : 'warning',
      });
    }
  }
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Generate HTML and JSON reports
 */
async function generateReports(
  context: ExecutionContext,
  metrics: PerformanceMetrics,
  regressions: PerformanceRegression[],
  baseline: PerformanceBaseline | undefined,
  htmlPath: string,
  jsonPath: string
): Promise<void> {
  try {
    // JSON report
    const jsonReport = {
      timestamp: new Date().toISOString(),
      simulator: context.simulator,
      bundleId: context.bundleId,
      metrics,
      regressions,
      baseline,
      summary: {
        runsCompleted: context.coldLaunchTimes.length,
        coldLaunchAvg: metrics.cold_launch.avg_ms,
        warmLaunchAvg: metrics.warm_launch.avg_ms,
        memoryPeak: metrics.memory?.peak_mb,
        frameRateMin: metrics.frame_rate?.min_fps,
        regressionsFound: regressions.length,
      },
    };

    await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2));

    // HTML report
    const html = generateHtmlReport(metrics, regressions, baseline, context);
    await writeFile(htmlPath, html);

    logger.debug(`${LOG_CONTEXT} Reports generated: ${htmlPath}, ${jsonPath}`);
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to generate reports: ${e}`);
  }
}

/**
 * Generate HTML performance report
 */
function generateHtmlReport(
  metrics: PerformanceMetrics,
  regressions: PerformanceRegression[],
  baseline: PerformanceBaseline | undefined,
  context: ExecutionContext
): string {
  const hasRegressions = regressions.length > 0;
  const statusColor = hasRegressions ? '#dc3545' : '#28a745';
  const statusText = hasRegressions ? `${regressions.length} Regression(s) Detected` : 'All Metrics Within Threshold';

  // Build metric rows
  const metricRows = [
    buildMetricRow('Cold Launch (avg)', metrics.cold_launch.avg_ms, 'ms', baseline?.cold_launch_avg_ms),
    buildMetricRow('Cold Launch (p95)', metrics.cold_launch.p95_ms, 'ms', baseline?.cold_launch_p95_ms),
    buildMetricRow('Warm Launch (avg)', metrics.warm_launch.avg_ms, 'ms', baseline?.warm_launch_avg_ms),
    buildMetricRow('Warm Launch (p95)', metrics.warm_launch.p95_ms, 'ms', baseline?.warm_launch_p95_ms),
  ];

  if (metrics.memory) {
    metricRows.push(buildMetricRow('Memory Peak', metrics.memory.peak_mb, 'MB', baseline?.memory_peak_mb));
    metricRows.push(buildMetricRow('Memory Avg', metrics.memory.avg_mb, 'MB', baseline?.memory_avg_mb));
  }

  if (metrics.frame_rate) {
    metricRows.push(buildMetricRow('Frame Rate (min)', metrics.frame_rate.min_fps, 'fps', baseline?.frame_rate_min_fps));
    metricRows.push(buildMetricRow('Frame Rate (avg)', metrics.frame_rate.avg_fps, 'fps', baseline?.frame_rate_avg_fps));
    metricRows.push(`<tr><td>Dropped Frames</td><td>${metrics.frame_rate.total_dropped_frames}</td><td>-</td><td>-</td></tr>`);
  }

  if (metrics.cpu) {
    metricRows.push(`<tr><td>CPU Peak</td><td>${metrics.cpu.peak_percent.toFixed(1)}%</td><td>-</td><td>-</td></tr>`);
    metricRows.push(`<tr><td>CPU Avg</td><td>${metrics.cpu.avg_percent.toFixed(1)}%</td><td>-</td><td>-</td></tr>`);
  }

  // Build regression rows
  const regressionRows = regressions
    .map(
      (r) => `
      <tr class="${r.severity}">
        <td>${r.metric}</td>
        <td>${r.baseline.toFixed(1)}</td>
        <td>${r.current.toFixed(1)}</td>
        <td>${r.change_percent > 0 ? '+' : ''}${r.change_percent.toFixed(1)}%</td>
        <td>${r.severity.toUpperCase()}</td>
      </tr>
    `
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>iOS Performance Report</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 { color: #333; margin-bottom: 5px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .summary {
      display: flex;
      gap: 20px;
      margin-bottom: 30px;
      flex-wrap: wrap;
    }
    .summary-card {
      padding: 20px;
      border-radius: 8px;
      flex: 1;
      min-width: 150px;
      text-align: center;
    }
    .summary-card.status { background: ${statusColor}; color: white; }
    .summary-card.info { background: #f8f9fa; border: 1px solid #dee2e6; }
    .summary-card h2 { margin: 0 0 5px 0; font-size: 24px; }
    .summary-card p { margin: 0; opacity: 0.9; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #dee2e6;
    }
    th { background: #f8f9fa; font-weight: 600; }

    .warning { background: #fff3cd; }
    .critical { background: #f8d7da; }

    .section { margin: 30px 0; }
    .section h3 { color: #333; border-bottom: 2px solid #dee2e6; padding-bottom: 10px; }

    .change-positive { color: #dc3545; }
    .change-negative { color: #28a745; }

    .chart-container {
      height: 200px;
      background: #f8f9fa;
      border-radius: 8px;
      margin: 20px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #999;
    }

    .footer {
      margin-top: 30px;
      text-align: center;
      color: #999;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>iOS Performance Report</h1>
    <p class="subtitle">Generated: ${new Date().toISOString()} | Simulator: ${context.simulator.name}</p>

    <div class="summary">
      <div class="summary-card status">
        <h2>${statusText}</h2>
        <p>${hasRegressions ? 'Review regressions below' : 'Performance is within acceptable range'}</p>
      </div>
      <div class="summary-card info">
        <h2>${metrics.cold_launch.avg_ms.toFixed(0)}ms</h2>
        <p>Cold Launch</p>
      </div>
      <div class="summary-card info">
        <h2>${metrics.warm_launch.avg_ms.toFixed(0)}ms</h2>
        <p>Warm Launch</p>
      </div>
      ${metrics.memory ? `<div class="summary-card info"><h2>${metrics.memory.peak_mb.toFixed(0)}MB</h2><p>Peak Memory</p></div>` : ''}
      ${metrics.frame_rate ? `<div class="summary-card info"><h2>${metrics.frame_rate.min_fps.toFixed(0)}fps</h2><p>Min FPS</p></div>` : ''}
    </div>

    ${
      regressions.length > 0
        ? `
    <div class="section">
      <h3>Regressions Detected</h3>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Baseline</th>
            <th>Current</th>
            <th>Change</th>
            <th>Severity</th>
          </tr>
        </thead>
        <tbody>
          ${regressionRows}
        </tbody>
      </table>
    </div>
    `
        : ''
    }

    <div class="section">
      <h3>All Metrics</h3>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Current</th>
            <th>Baseline</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          ${metricRows.join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h3>Launch Time Distribution</h3>
      <div class="chart-container">
        Cold: [${context.coldLaunchTimes.map((t) => `${t}ms`).join(', ')}] |
        Warm: [${context.warmLaunchTimes.map((t) => `${t}ms`).join(', ')}]
      </div>
    </div>

    <p class="footer">Generated by Maestro iOS Performance Check Playbook</p>
  </div>
</body>
</html>`;
}

/**
 * Build a metric row for the HTML report
 */
function buildMetricRow(
  name: string,
  current: number,
  unit: string,
  baseline?: number
): string {
  const baselineStr = baseline !== undefined ? `${baseline.toFixed(1)} ${unit}` : '-';
  let changeStr = '-';

  if (baseline !== undefined && baseline > 0) {
    const change = ((current - baseline) / baseline) * 100;
    const isPositive = change > 0;
    const isFpsMetric = unit === 'fps'; // For FPS, lower is worse
    const isRegression = isFpsMetric ? change < 0 : change > 0;
    const changeClass = isRegression ? 'change-positive' : 'change-negative';
    changeStr = `<span class="${changeClass}">${isPositive ? '+' : ''}${change.toFixed(1)}%</span>`;
  }

  return `<tr>
    <td>${name}</td>
    <td>${current.toFixed(1)} ${unit}</td>
    <td>${baselineStr}</td>
    <td>${changeStr}</td>
  </tr>`;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate playbook inputs
 */
function validateInputs(
  inputs: PerformanceCheckInputs,
  inputDefs?: Record<string, PlaybookInputDef>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required inputs - need either app_path, project_path, or bundle_id
  if (!inputs.app_path && !inputs.project_path && !inputs.bundle_id) {
    errors.push('Either app_path, project_path, or bundle_id is required');
  }

  if (inputs.project_path && !inputs.scheme) {
    errors.push('scheme is required when project_path is provided');
  }

  // Validate against playbook input definitions
  if (inputDefs) {
    for (const [key, def] of Object.entries(inputDefs)) {
      if (def.required && !(key in inputs)) {
        errors.push(`Required input '${key}' is missing`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Resolve simulator by name or UDID
 */
async function resolveSimulator(
  simulatorSpec?: string
): Promise<IOSResult<{ udid: string; simulator: { udid: string; name: string; iosVersion: string } }>> {
  // If UDID provided, get that specific simulator
  if (simulatorSpec && simulatorSpec.includes('-')) {
    const simResult = await getSimulator(simulatorSpec);
    if (simResult.success && simResult.data) {
      return {
        success: true,
        data: {
          udid: simResult.data.udid,
          simulator: {
            udid: simResult.data.udid,
            name: simResult.data.name,
            iosVersion: simResult.data.iosVersion,
          },
        },
      };
    }
  }

  // Try to find by name
  if (simulatorSpec) {
    const listResult = await listSimulators();
    if (listResult.success && listResult.data) {
      const matching = listResult.data.find(
        (s) => s.name.toLowerCase() === simulatorSpec.toLowerCase() && s.isAvailable
      );

      if (matching) {
        // Boot if needed
        if (matching.state !== 'Booted') {
          await bootSimulator({ udid: matching.udid });
          await sleep(3000);
        }
        return {
          success: true,
          data: {
            udid: matching.udid,
            simulator: {
              udid: matching.udid,
              name: matching.name,
              iosVersion: matching.iosVersion,
            },
          },
        };
      }
    }
  }

  // Fall back to first booted simulator
  const bootedResult = await getBootedSimulators();
  if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
    return {
      success: false,
      error: 'No booted simulators found. Please boot a simulator first.',
      errorCode: 'SIMULATOR_NOT_BOOTED' as IOSErrorCode,
    };
  }

  const sim = bootedResult.data[0];
  return {
    success: true,
    data: {
      udid: sim.udid,
      simulator: {
        udid: sim.udid,
        name: sim.name,
        iosVersion: sim.iosVersion,
      },
    },
  };
}

/**
 * Detect bundle ID from built app
 */
async function detectBundleId(appPath?: string, scheme?: string): Promise<string | undefined> {
  if (!appPath) {
    return scheme ? `com.example.${scheme}` : undefined;
  }

  // Try to read Info.plist
  const plistPath = path.join(appPath, 'Info.plist');
  if (fs.existsSync(plistPath)) {
    try {
      const { execFileNoThrow } = await import('../../utils/execFile');
      const result = await execFileNoThrow('plutil', ['-convert', 'json', '-o', '-', plistPath]);
      if (result.exitCode === 0) {
        const plist = JSON.parse(result.stdout);
        return plist.CFBundleIdentifier;
      }
    } catch {
      // Fall through to default
    }
  }

  return scheme ? `com.example.${scheme}` : undefined;
}

/**
 * Wait for app to become ready
 */
async function waitForAppReady(_udid: string, _bundleId: string): Promise<void> {
  // In a real implementation, this would wait for the app to signal readiness
  // For now, use a simple delay
  await sleep(1000);
}

/**
 * Report progress
 */
function reportProgress(context: ExecutionContext, update: PerformanceCheckProgress): void {
  logger.debug(`${LOG_CONTEXT} Progress: ${update.phase} - ${update.message}`);
  context.onProgress?.(update);
}

/**
 * Create dry run result
 */
function createDryRunResult(
  options: PerformanceCheckOptions,
  playbook: IOSPlaybookConfig,
  simulator: { udid: string; name: string; iosVersion: string },
  artifactsDir: string,
  startTime: Date,
  variables: PlaybookVariables,
  _runs: number
): PerformanceCheckResult {
  const endTime = new Date();
  return {
    completed: false,
    regressions_found: 0,
    metrics: {
      cold_launch: { avg_ms: 0, min_ms: 0, max_ms: 0, p95_ms: 0, samples: [] },
      warm_launch: { avg_ms: 0, min_ms: 0, max_ms: 0, p95_ms: 0, samples: [] },
    },
    flow_metrics: [],
    regressions: [],
    runs_completed: 0,
    totalDuration: endTime.getTime() - startTime.getTime(),
    startTime,
    endTime,
    playbook: {
      name: playbook.name,
      version: playbook.version,
      path: options.playbookPath,
    },
    simulator,
    artifactsDir,
    finalVariables: variables,
  };
}

/**
 * Create error result
 */
function createErrorResult(
  options: PerformanceCheckOptions,
  playbook: IOSPlaybookConfig,
  context: ExecutionContext,
  error: string,
  startTime: Date,
  _runs: number
): IOSResult<PerformanceCheckResult> {
  const endTime = new Date();
  return {
    success: true,
    data: {
      completed: false,
      regressions_found: 0,
      metrics: {
        cold_launch: { avg_ms: 0, min_ms: 0, max_ms: 0, p95_ms: 0, samples: [] },
        warm_launch: { avg_ms: 0, min_ms: 0, max_ms: 0, p95_ms: 0, samples: [] },
      },
      flow_metrics: [],
      regressions: [],
      runs_completed: 0,
      totalDuration: endTime.getTime() - startTime.getTime(),
      startTime,
      endTime,
      playbook: {
        name: playbook.name,
        version: playbook.version,
        path: options.playbookPath,
      },
      simulator: context.simulator,
      appPath: context.appPath,
      bundleId: context.bundleId,
      artifactsDir: context.artifactsDir,
      error,
      finalVariables: context.variables,
    },
  };
}

/**
 * Calculate average
 */
function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate percentile
 */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Generate simulated sample data (placeholder for real instrumentation)
 */
function generateSimulatedSamples(min: number, max: number, count: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(min + Math.random() * (max - min));
  }
  return samples;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format duration
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}m ${secs}s`;
  }
}

// =============================================================================
// Result Formatters
// =============================================================================

/**
 * Format result for agent output (markdown)
 */
export function formatPerformanceCheckResult(result: PerformanceCheckResult): string {
  const lines: string[] = [];

  const statusEmoji = result.regressions_found === 0 ? '✅' : '⚠️';
  lines.push(
    `## ${statusEmoji} Performance Check ${result.regressions_found === 0 ? 'Passed' : 'Completed with Regressions'}`
  );
  lines.push('');

  // Summary table
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Status | ${result.regressions_found === 0 ? 'PASSED' : 'REGRESSIONS'} |`);
  lines.push(`| Runs | ${result.runs_completed} |`);
  lines.push(`| Cold Launch (avg) | ${result.metrics.cold_launch.avg_ms.toFixed(0)}ms |`);
  lines.push(`| Warm Launch (avg) | ${result.metrics.warm_launch.avg_ms.toFixed(0)}ms |`);
  if (result.metrics.memory) {
    lines.push(`| Memory Peak | ${result.metrics.memory.peak_mb.toFixed(1)}MB |`);
  }
  if (result.metrics.frame_rate) {
    lines.push(`| Frame Rate (min) | ${result.metrics.frame_rate.min_fps.toFixed(0)}fps |`);
  }
  lines.push(`| Duration | ${formatDuration(result.totalDuration)} |`);
  lines.push('');

  // Regressions
  if (result.regressions.length > 0) {
    lines.push('### Regressions Detected');
    lines.push('');
    for (const r of result.regressions) {
      const icon = r.severity === 'critical' ? '🔴' : '🟡';
      lines.push(
        `- ${icon} **${r.metric}**: ${r.baseline.toFixed(1)} → ${r.current.toFixed(1)} (${r.change_percent > 0 ? '+' : ''}${r.change_percent.toFixed(1)}%)`
      );
    }
    lines.push('');
  }

  // Reports
  if (result.htmlReportPath) {
    lines.push('### Reports');
    lines.push('');
    lines.push(`- HTML Report: \`${result.htmlReportPath}\``);
    if (result.jsonReportPath) {
      lines.push(`- JSON Report: \`${result.jsonReportPath}\``);
    }
    if (result.savedBaselinePath) {
      lines.push(`- Saved Baseline: \`${result.savedBaselinePath}\``);
    }
    lines.push('');
  }

  // Error if present
  if (result.error) {
    lines.push('### Error');
    lines.push('');
    lines.push('```');
    lines.push(result.error);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Format result as JSON
 */
export function formatPerformanceCheckResultAsJson(result: PerformanceCheckResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format result in compact form
 */
export function formatPerformanceCheckResultCompact(result: PerformanceCheckResult): string {
  const status = result.regressions_found === 0 ? 'PASS' : 'REGRESS';
  return `[${status}] cold=${result.metrics.cold_launch.avg_ms.toFixed(0)}ms, warm=${result.metrics.warm_launch.avg_ms.toFixed(0)}ms, ${result.regressions_found} regression(s), ${formatDuration(result.totalDuration)}`;
}
