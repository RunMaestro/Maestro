/**
 * iOS Tools - Feature Ship Loop
 *
 * Simplified hardcoded loop for feature development:
 * launch → flow → verify → snapshot → report
 *
 * Runs the loop until assertions pass or max iterations reached.
 */

import * as path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { IOSResult, IOSErrorCode } from './types';
import { launchApp, terminateApp, getBootedSimulators, getSimulator } from './simulator';
import { runFlow, FlowRunResult } from './flow-runner';
import { captureSnapshot, SnapshotResult } from './snapshot';
import { assertVisible, assertNoCrash, AssertVisibleOptions } from './assertions';
import { VerificationResult, VerificationStatus } from './verification';
import { getArtifactDirectory, generateSnapshotId } from './artifacts';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[iOS-ShipLoop]';

// =============================================================================
// Types
// =============================================================================

/**
 * Type of assertion to run
 */
export type AssertionType = 'visible' | 'notVisible' | 'noCrash';

/**
 * Assertion specification for the ship loop
 */
export interface AssertionSpec {
  /** Type of assertion */
  type: AssertionType;
  /** Target for visibility assertions (identifier, label, or text) */
  target?: string;
  /** How to find the target for visibility assertions */
  targetType?: 'identifier' | 'label' | 'text';
  /** Bundle ID for crash assertions */
  bundleId?: string;
  /** Optional description for display */
  description?: string;
  /** Timeout for this specific assertion (ms) */
  timeout?: number;
}

/**
 * Options for the Feature Ship Loop
 */
export interface ShipLoopOptions {
  /** Path to the Maestro flow file to execute */
  flowPath: string;
  /** Assertions to verify after running the flow */
  assertions: AssertionSpec[];
  /** Bundle ID of the app under test */
  bundleId: string;
  /** Session ID for artifact storage */
  sessionId: string;
  /** Simulator UDID (auto-detects if not provided) */
  udid?: string;
  /** Maximum number of iterations (default: 5) */
  maxIterations?: number;
  /** Whether to relaunch the app at the start of each iteration (default: true) */
  relaunchOnIteration?: boolean;
  /** Delay between iterations in ms (default: 2000) */
  iterationDelay?: number;
  /** Timeout per flow run in ms (default: 300000 = 5 min) */
  flowTimeout?: number;
  /** Timeout per assertion in ms (default: 10000) */
  assertionTimeout?: number;
  /** Environment variables for the flow */
  env?: Record<string, string>;
  /** Working directory for relative flow paths */
  cwd?: string;
  /** Whether to collect snapshots on each iteration (default: true) */
  collectSnapshots?: boolean;
  /** Whether to continue to next assertion if one fails (default: false) */
  continueOnAssertionFailure?: boolean;
  /** Callback for progress updates */
  onProgress?: (update: ShipLoopProgress) => void;
}

/**
 * Result of a single iteration
 */
export interface IterationResult {
  /** Iteration number (1-based) */
  iteration: number;
  /** Timestamp when this iteration started */
  startTime: Date;
  /** Timestamp when this iteration ended */
  endTime: Date;
  /** Duration in ms */
  duration: number;
  /** App launch result (if relaunch was requested) */
  launch?: {
    success: boolean;
    error?: string;
  };
  /** Flow execution result */
  flow: {
    passed: boolean;
    result?: FlowRunResult;
    error?: string;
  };
  /** Individual assertion results */
  assertions: {
    spec: AssertionSpec;
    result?: VerificationResult;
    passed: boolean;
    error?: string;
  }[];
  /** Snapshot captured at end of iteration */
  snapshot?: {
    result?: SnapshotResult;
    error?: string;
  };
  /** Whether all assertions passed */
  allAssertionsPassed: boolean;
  /** Whether the iteration should stop the loop */
  shouldStop: boolean;
}

/**
 * Progress update during ship loop execution
 */
export interface ShipLoopProgress {
  /** Current phase */
  phase: 'starting' | 'launching' | 'running_flow' | 'verifying' | 'snapshot' | 'complete' | 'failed';
  /** Current iteration (1-based) */
  iteration: number;
  /** Total iterations limit */
  maxIterations: number;
  /** Message describing current activity */
  message: string;
  /** Percentage complete (0-100) */
  percentComplete: number;
  /** Current assertion being checked (if verifying) */
  currentAssertion?: number;
  /** Total assertions to check */
  totalAssertions?: number;
}

/**
 * Final result of the Feature Ship Loop
 */
export interface ShipLoopResult {
  /** Whether all assertions passed */
  passed: boolean;
  /** How the loop terminated */
  terminationReason: 'assertions_passed' | 'max_iterations' | 'flow_failed' | 'error';
  /** Total number of iterations run */
  iterationsRun: number;
  /** Maximum iterations configured */
  maxIterations: number;
  /** Total duration in ms */
  totalDuration: number;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime: Date;
  /** Results from each iteration */
  iterations: IterationResult[];
  /** Simulator used */
  simulator: {
    udid: string;
    name: string;
    iosVersion: string;
  };
  /** Summary of assertions */
  assertionsSummary: {
    total: number;
    passed: number;
    failed: number;
    specs: {
      spec: AssertionSpec;
      passedOn?: number; // Iteration where it first passed
      lastStatus: VerificationStatus | 'not_run';
    }[];
  };
  /** Path to artifacts directory */
  artifactsDir: string;
  /** Final error message if terminated with error */
  error?: string;
}

// =============================================================================
// Main Ship Loop
// =============================================================================

/**
 * Run the Feature Ship Loop.
 *
 * Executes a hardcoded loop: launch → flow → verify → snapshot → report
 * Continues until all assertions pass or max iterations reached.
 *
 * @param options - Ship loop configuration
 * @returns Final result with all iteration details
 */
export async function runShipLoop(options: ShipLoopOptions): Promise<IOSResult<ShipLoopResult>> {
  const {
    flowPath,
    assertions,
    bundleId,
    sessionId,
    maxIterations = 5,
    relaunchOnIteration = true,
    iterationDelay = 2000,
    flowTimeout = 300000,
    assertionTimeout = 10000,
    env = {},
    cwd,
    collectSnapshots = true,
    continueOnAssertionFailure = false,
    onProgress,
  } = options;

  const startTime = new Date();
  const iterations: IterationResult[] = [];

  logger.info(`${LOG_CONTEXT} Starting Feature Ship Loop`);
  logger.info(`${LOG_CONTEXT} Flow: ${flowPath}`);
  logger.info(`${LOG_CONTEXT} Assertions: ${assertions.length}`);
  logger.info(`${LOG_CONTEXT} Max iterations: ${maxIterations}`);

  // Report progress
  const reportProgress = (update: ShipLoopProgress) => {
    logger.debug(`${LOG_CONTEXT} Progress: ${update.phase} - ${update.message}`);
    onProgress?.(update);
  };

  reportProgress({
    phase: 'starting',
    iteration: 0,
    maxIterations,
    message: 'Initializing Feature Ship Loop',
    percentComplete: 0,
  });

  // Determine simulator UDID
  let udid = options.udid;
  if (!udid) {
    const bootedResult = await getBootedSimulators();
    if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
      return {
        success: false,
        error: 'No booted simulators found. Please boot a simulator first.',
        errorCode: 'SIMULATOR_NOT_BOOTED' as IOSErrorCode,
      };
    }
    udid = bootedResult.data[0].udid;
    logger.debug(`${LOG_CONTEXT} Auto-selected simulator: ${udid}`);
  }

  // Get simulator info
  const simResult = await getSimulator(udid);
  if (!simResult.success || !simResult.data) {
    return {
      success: false,
      error: simResult.error || 'Failed to get simulator info',
      errorCode: simResult.errorCode || ('SIMULATOR_NOT_FOUND' as IOSErrorCode),
    };
  }

  const simulator = {
    udid,
    name: simResult.data.name,
    iosVersion: simResult.data.iosVersion,
  };

  // Prepare artifacts directory
  const artifactsDir = await getArtifactDirectory(sessionId);
  const shipLoopDir = path.join(artifactsDir, `ship-loop-${Date.now()}`);
  await mkdir(shipLoopDir, { recursive: true });

  // Track assertion status across iterations
  const assertionTracking = assertions.map((spec) => ({
    spec,
    passedOn: undefined as number | undefined,
    lastStatus: 'not_run' as VerificationStatus | 'not_run',
  }));

  let terminationReason: ShipLoopResult['terminationReason'] = 'max_iterations';
  let finalError: string | undefined;

  // Main loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const iterStartTime = new Date();
    logger.info(`${LOG_CONTEXT} === Iteration ${iteration}/${maxIterations} ===`);

    const iterationResult: IterationResult = {
      iteration,
      startTime: iterStartTime,
      endTime: new Date(),
      duration: 0,
      flow: { passed: false },
      assertions: [],
      allAssertionsPassed: false,
      shouldStop: false,
    };

    try {
      // Step 1: Launch app (if configured)
      if (relaunchOnIteration) {
        reportProgress({
          phase: 'launching',
          iteration,
          maxIterations,
          message: `Launching ${bundleId}`,
          percentComplete: Math.round(((iteration - 1) / maxIterations) * 100),
        });

        // Terminate first to ensure clean state
        await terminateApp(udid, bundleId);
        await sleep(500);

        const launchResult = await launchApp({ udid, bundleId });
        iterationResult.launch = {
          success: launchResult.success,
          error: launchResult.error,
        };

        if (!launchResult.success) {
          logger.warn(`${LOG_CONTEXT} App launch failed: ${launchResult.error}`);
          // Continue anyway - the flow might launch the app
        }

        await sleep(1000); // Give app time to start
      }

      // Step 2: Run flow
      reportProgress({
        phase: 'running_flow',
        iteration,
        maxIterations,
        message: `Running flow: ${path.basename(flowPath)}`,
        percentComplete: Math.round(((iteration - 0.7) / maxIterations) * 100),
      });

      const flowResult = await runFlow({
        flowPath,
        udid,
        bundleId,
        sessionId,
        env,
        timeout: flowTimeout,
        cwd,
        captureOnFailure: true,
      });

      if (!flowResult.success) {
        iterationResult.flow = {
          passed: false,
          error: flowResult.error,
        };
        logger.error(`${LOG_CONTEXT} Flow execution failed: ${flowResult.error}`);
        terminationReason = 'flow_failed';
        finalError = flowResult.error;
        iterationResult.shouldStop = true;
      } else {
        iterationResult.flow = {
          passed: flowResult.data!.passed,
          result: flowResult.data,
          error: flowResult.data!.passed ? undefined : flowResult.data!.error,
        };

        if (!flowResult.data!.passed) {
          logger.warn(`${LOG_CONTEXT} Flow did not pass, but continuing to verify`);
        }
      }

      // Step 3: Run assertions (even if flow failed, to see current state)
      if (!iterationResult.shouldStop) {
        reportProgress({
          phase: 'verifying',
          iteration,
          maxIterations,
          message: 'Running assertions',
          percentComplete: Math.round(((iteration - 0.4) / maxIterations) * 100),
          currentAssertion: 0,
          totalAssertions: assertions.length,
        });

        let allPassed = true;

        for (let i = 0; i < assertions.length; i++) {
          const spec = assertions[i];
          const tracking = assertionTracking[i];

          reportProgress({
            phase: 'verifying',
            iteration,
            maxIterations,
            message: spec.description || `Verifying ${spec.type}: ${spec.target || spec.bundleId}`,
            percentComplete: Math.round(((iteration - 0.4 + (i / assertions.length) * 0.3) / maxIterations) * 100),
            currentAssertion: i + 1,
            totalAssertions: assertions.length,
          });

          const assertResult = await runAssertion(spec, {
            udid,
            sessionId,
            bundleId,
            timeout: spec.timeout || assertionTimeout,
          });

          const passed = assertResult.success && assertResult.data?.passed;
          tracking.lastStatus = assertResult.data?.status || 'error';

          if (passed && tracking.passedOn === undefined) {
            tracking.passedOn = iteration;
          }

          iterationResult.assertions.push({
            spec,
            result: assertResult.data,
            passed: !!passed,
            error: assertResult.error || (assertResult.data?.passed ? undefined : assertResult.data?.message),
          });

          if (!passed) {
            allPassed = false;
            logger.debug(`${LOG_CONTEXT} Assertion failed: ${spec.description || spec.type}`);
            if (!continueOnAssertionFailure) {
              // Skip remaining assertions for this iteration
              break;
            }
          }
        }

        iterationResult.allAssertionsPassed = allPassed;

        if (allPassed) {
          logger.info(`${LOG_CONTEXT} All assertions passed!`);
          terminationReason = 'assertions_passed';
          iterationResult.shouldStop = true;
        }
      }

      // Step 4: Capture snapshot
      if (collectSnapshots && !iterationResult.shouldStop || (iterationResult.shouldStop && terminationReason === 'assertions_passed')) {
        reportProgress({
          phase: 'snapshot',
          iteration,
          maxIterations,
          message: 'Capturing snapshot',
          percentComplete: Math.round(((iteration - 0.1) / maxIterations) * 100),
        });

        const snapshotId = `iter-${iteration}-${generateSnapshotId()}`;
        const snapshotResult = await captureSnapshot({
          udid,
          bundleId,
          sessionId,
          snapshotId,
        });

        if (snapshotResult.success && snapshotResult.data) {
          iterationResult.snapshot = { result: snapshotResult.data };
        } else {
          iterationResult.snapshot = { error: snapshotResult.error };
          logger.warn(`${LOG_CONTEXT} Snapshot capture failed: ${snapshotResult.error}`);
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`${LOG_CONTEXT} Iteration ${iteration} error: ${error}`);
      terminationReason = 'error';
      finalError = error;
      iterationResult.shouldStop = true;
    }

    // Complete iteration
    iterationResult.endTime = new Date();
    iterationResult.duration = iterationResult.endTime.getTime() - iterStartTime.getTime();
    iterations.push(iterationResult);

    // Check if we should stop
    if (iterationResult.shouldStop) {
      break;
    }

    // Wait before next iteration
    if (iteration < maxIterations) {
      logger.debug(`${LOG_CONTEXT} Waiting ${iterationDelay}ms before next iteration`);
      await sleep(iterationDelay);
    }
  }

  // Build final result
  const endTime = new Date();
  const totalDuration = endTime.getTime() - startTime.getTime();

  const passed = terminationReason === 'assertions_passed';
  const iterationsRun = iterations.length;

  // Build assertion summary
  const assertionsSummary = {
    total: assertions.length,
    passed: assertionTracking.filter((t) => t.passedOn !== undefined).length,
    failed: assertionTracking.filter((t) => t.passedOn === undefined && t.lastStatus !== 'not_run').length,
    specs: assertionTracking,
  };

  // Write summary to file
  const summary = buildTextReport({
    passed,
    terminationReason,
    iterationsRun,
    maxIterations,
    totalDuration,
    startTime,
    endTime,
    iterations,
    simulator,
    assertionsSummary,
    artifactsDir: shipLoopDir,
  });

  try {
    await writeFile(path.join(shipLoopDir, 'summary.txt'), summary);
    await writeFile(
      path.join(shipLoopDir, 'result.json'),
      JSON.stringify(
        {
          passed,
          terminationReason,
          iterationsRun,
          maxIterations,
          totalDuration,
          startTime,
          endTime,
          simulator,
          assertionsSummary,
        },
        null,
        2
      )
    );
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to write summary files: ${e}`);
  }

  reportProgress({
    phase: passed ? 'complete' : 'failed',
    iteration: iterationsRun,
    maxIterations,
    message: passed
      ? `All assertions passed after ${iterationsRun} iteration(s)`
      : `Loop ended: ${terminationReason}`,
    percentComplete: 100,
  });

  const result: ShipLoopResult = {
    passed,
    terminationReason,
    iterationsRun,
    maxIterations,
    totalDuration,
    startTime,
    endTime,
    iterations,
    simulator,
    assertionsSummary,
    artifactsDir: shipLoopDir,
    error: finalError,
  };

  logger.info(
    `${LOG_CONTEXT} Ship Loop complete: ${passed ? 'PASSED' : 'FAILED'} after ${iterationsRun} iteration(s) in ${totalDuration}ms`
  );

  return {
    success: true,
    data: result,
  };
}

// =============================================================================
// Assertion Runner
// =============================================================================

/**
 * Run a single assertion based on its specification.
 */
async function runAssertion(
  spec: AssertionSpec,
  options: {
    udid: string;
    sessionId: string;
    bundleId: string;
    timeout: number;
  }
): Promise<IOSResult<VerificationResult>> {
  const { udid, sessionId, bundleId, timeout } = options;

  const baseOptions = {
    udid,
    sessionId,
    polling: {
      timeout,
      pollInterval: 500,
      description: spec.description || `${spec.type} assertion`,
    },
  };

  try {
    switch (spec.type) {
      case 'visible': {
        if (!spec.target) {
          return {
            success: false,
            error: 'Visible assertion requires a target',
            errorCode: 'COMMAND_FAILED' as IOSErrorCode,
          };
        }

        const visibleOptions: AssertVisibleOptions = {
          ...baseOptions,
          target: {
            [spec.targetType || 'text']: spec.target,
          },
        };

        return assertVisible(visibleOptions);
      }

      case 'notVisible': {
        if (!spec.target) {
          return {
            success: false,
            error: 'NotVisible assertion requires a target',
            errorCode: 'COMMAND_FAILED' as IOSErrorCode,
          };
        }

        const { assertNotVisible } = await import('./assertions');
        const notVisibleOptions: AssertVisibleOptions = {
          ...baseOptions,
          target: {
            [spec.targetType || 'text']: spec.target,
          },
        };

        return assertNotVisible(notVisibleOptions);
      }

      case 'noCrash': {
        const noCrashBundleId = spec.bundleId || bundleId;
        if (!noCrashBundleId) {
          return {
            success: false,
            error: 'NoCrash assertion requires a bundleId',
            errorCode: 'COMMAND_FAILED' as IOSErrorCode,
          };
        }

        return assertNoCrash({
          ...baseOptions,
          bundleId: noCrashBundleId,
        });
      }

      default:
        return {
          success: false,
          error: `Unknown assertion type: ${spec.type}`,
          errorCode: 'COMMAND_FAILED' as IOSErrorCode,
        };
    }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      errorCode: 'COMMAND_FAILED' as IOSErrorCode,
    };
  }
}

// =============================================================================
// Report Formatting
// =============================================================================

/**
 * Build a text report of the ship loop results.
 */
function buildTextReport(result: ShipLoopResult): string {
  const lines: string[] = [];

  lines.push('=' .repeat(60));
  lines.push('FEATURE SHIP LOOP REPORT');
  lines.push('=' .repeat(60));
  lines.push('');

  // Summary
  lines.push(`Status: ${result.passed ? '✓ PASSED' : '✗ FAILED'}`);
  lines.push(`Reason: ${formatTerminationReason(result.terminationReason)}`);
  lines.push(`Iterations: ${result.iterationsRun}/${result.maxIterations}`);
  lines.push(`Duration: ${formatDuration(result.totalDuration)}`);
  lines.push(`Simulator: ${result.simulator.name} (iOS ${result.simulator.iosVersion})`);
  lines.push('');

  // Assertion Summary
  lines.push('-'.repeat(40));
  lines.push('ASSERTIONS');
  lines.push('-'.repeat(40));

  for (const tracked of result.assertionsSummary.specs) {
    const { spec, passedOn, lastStatus } = tracked;
    const statusIcon = passedOn !== undefined ? '✓' : lastStatus === 'not_run' ? '-' : '✗';
    const description = spec.description || `${spec.type}: ${spec.target || spec.bundleId}`;
    const passedInfo = passedOn !== undefined ? ` (passed on iteration ${passedOn})` : '';
    lines.push(`  ${statusIcon} ${description}${passedInfo}`);
  }
  lines.push('');

  // Iteration Details
  lines.push('-'.repeat(40));
  lines.push('ITERATIONS');
  lines.push('-'.repeat(40));

  for (const iter of result.iterations) {
    lines.push('');
    lines.push(`Iteration ${iter.iteration}:`);
    lines.push(`  Duration: ${formatDuration(iter.duration)}`);

    if (iter.launch) {
      lines.push(`  Launch: ${iter.launch.success ? 'success' : `failed - ${iter.launch.error}`}`);
    }

    lines.push(`  Flow: ${iter.flow.passed ? 'passed' : `failed - ${iter.flow.error || 'unknown'}`}`);

    if (iter.assertions.length > 0) {
      lines.push('  Assertions:');
      for (const a of iter.assertions) {
        const icon = a.passed ? '✓' : '✗';
        const desc = a.spec.description || `${a.spec.type}: ${a.spec.target || a.spec.bundleId}`;
        lines.push(`    ${icon} ${desc}`);
      }
    }

    if (iter.snapshot?.result) {
      lines.push(`  Snapshot: ${iter.snapshot.result.id}`);
    }
  }

  lines.push('');
  lines.push('=' .repeat(60));

  return lines.join('\n');
}

/**
 * Format termination reason for display.
 */
function formatTerminationReason(reason: ShipLoopResult['terminationReason']): string {
  switch (reason) {
    case 'assertions_passed':
      return 'All assertions passed';
    case 'max_iterations':
      return 'Maximum iterations reached';
    case 'flow_failed':
      return 'Flow execution failed';
    case 'error':
      return 'Error occurred';
    default:
      return reason;
  }
}

/**
 * Format duration for display.
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

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Result Formatters
// =============================================================================

/**
 * Format ship loop result for agent output (markdown).
 */
export function formatShipLoopResult(result: ShipLoopResult): string {
  const lines: string[] = [];

  // Header with status
  const statusEmoji = result.passed ? '✅' : '❌';
  lines.push(`## ${statusEmoji} Feature Ship Loop ${result.passed ? 'Passed' : 'Failed'}`);
  lines.push('');

  // Summary table
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Status | ${result.passed ? 'PASSED' : 'FAILED'} |`);
  lines.push(`| Reason | ${formatTerminationReason(result.terminationReason)} |`);
  lines.push(`| Iterations | ${result.iterationsRun}/${result.maxIterations} |`);
  lines.push(`| Duration | ${formatDuration(result.totalDuration)} |`);
  lines.push(`| Simulator | ${result.simulator.name} |`);
  lines.push('');

  // Assertions
  lines.push('### Assertions');
  lines.push('');

  for (const tracked of result.assertionsSummary.specs) {
    const { spec, passedOn, lastStatus } = tracked;
    const statusIcon = passedOn !== undefined ? '✅' : lastStatus === 'not_run' ? '⏭️' : '❌';
    const description = spec.description || `${spec.type}: ${spec.target || spec.bundleId}`;
    const passedInfo = passedOn !== undefined ? ` (iteration ${passedOn})` : '';
    lines.push(`- ${statusIcon} ${description}${passedInfo}`);
  }
  lines.push('');

  // Artifacts
  lines.push('### Artifacts');
  lines.push('');
  lines.push(`- Directory: \`${result.artifactsDir}\``);
  lines.push('');

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
 * Format ship loop result as JSON.
 */
export function formatShipLoopResultAsJson(result: ShipLoopResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format ship loop result in compact form.
 */
export function formatShipLoopResultCompact(result: ShipLoopResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const assertions = `${result.assertionsSummary.passed}/${result.assertionsSummary.total}`;
  return `[${status}] ${result.iterationsRun} iter, ${assertions} assertions, ${formatDuration(result.totalDuration)}`;
}
