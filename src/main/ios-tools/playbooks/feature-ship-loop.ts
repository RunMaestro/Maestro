/**
 * iOS Playbook - Feature Ship Loop Executor
 *
 * Executes the Feature Ship Loop playbook for iOS development.
 * Iterates through: build → launch → verify → snapshot → report
 * until all assertions pass or max iterations reached.
 */

import * as path from 'path';
import * as fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { IOSResult, IOSErrorCode } from '../types';
import {
  loadPlaybook,
  IOSPlaybookConfig,
  PlaybookInputDef,
  PlaybookVariables,
} from '../playbook-loader';
import { build, BuildResult, detectProject } from '../build';
import { launchApp, terminateApp, getBootedSimulators, getSimulator, bootSimulator, listSimulators } from '../simulator';
import { captureSnapshot, SnapshotResult } from '../snapshot';
import { assertVisible, assertNoCrash, AssertVisibleOptions } from '../assertions';
import type { FlowRunResult } from '../flow-runner';
import { VerificationResult, VerificationStatus } from '../verification';
import { getArtifactDirectory, generateSnapshotId } from '../artifacts';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[iOS-FeatureShipLoop]';

// =============================================================================
// Types
// =============================================================================

/**
 * Assertion definition for the playbook
 */
export interface PlaybookAssertion {
  /** Assertion type (visible, not_visible, no_crash, text_equals, etc.) */
  type: string;
  /** Target element (identifier, label, or text) */
  target?: string;
  /** How to find the target */
  targetType?: 'identifier' | 'label' | 'text';
  /** Expected value for text/value assertions */
  expected?: string;
  /** Bundle ID for crash assertions */
  bundleId?: string;
  /** Optional description */
  description?: string;
  /** Timeout for this specific assertion (ms) */
  timeout?: number;
}

/**
 * Input values for running the Feature Ship Loop
 */
export interface FeatureShipLoopInputs {
  /** Path to Xcode project or workspace */
  project_path: string;
  /** Build scheme name */
  scheme: string;
  /** Simulator name or UDID (default: "iPhone 15 Pro") */
  simulator?: string;
  /** Target screen to navigate to after launch */
  target_screen?: string;
  /** Navigation steps to reach target screen */
  navigation_steps?: unknown[];
  /** Launch screen element to wait for */
  launch_screen?: string;
  /** Assertions to verify */
  assertions: PlaybookAssertion[];
}

/**
 * Options for the Feature Ship Loop execution
 */
export interface FeatureShipLoopOptions {
  /** Input values matching playbook inputs */
  inputs: FeatureShipLoopInputs;
  /** Session ID for artifact storage */
  sessionId: string;
  /** Maximum iterations (overrides playbook default) */
  maxIterations?: number;
  /** Path to playbook YAML (uses built-in if not specified) */
  playbookPath?: string;
  /** Working directory for relative paths */
  cwd?: string;
  /** Build configuration (default: Debug) */
  configuration?: 'Debug' | 'Release' | string;
  /** Timeout per build in ms (default: 600000 = 10 min) */
  buildTimeout?: number;
  /** Timeout per flow in ms (default: 300000 = 5 min) */
  flowTimeout?: number;
  /** Timeout per assertion in ms (default: 10000) */
  assertionTimeout?: number;
  /** Delay between iterations in ms (default: 2000) */
  iterationDelay?: number;
  /** Whether to relaunch app each iteration (default: true) */
  relaunchOnIteration?: boolean;
  /** Whether to rebuild each iteration (default: false) */
  rebuildOnIteration?: boolean;
  /** Whether to collect snapshots (default: true) */
  collectSnapshots?: boolean;
  /** Whether to continue on assertion failure (default: false) */
  continueOnAssertionFailure?: boolean;
  /** Progress callback */
  onProgress?: (update: FeatureShipLoopProgress) => void;
  /** Dry run - validate without executing */
  dryRun?: boolean;
}

/**
 * Progress update during execution
 */
export interface FeatureShipLoopProgress {
  /** Current execution phase */
  phase:
    | 'initializing'
    | 'building'
    | 'launching'
    | 'navigating'
    | 'verifying'
    | 'capturing'
    | 'reporting'
    | 'complete'
    | 'failed';
  /** Current iteration (1-based) */
  iteration: number;
  /** Maximum iterations */
  maxIterations: number;
  /** Current step name */
  stepName?: string;
  /** Human-readable message */
  message: string;
  /** Percentage complete (0-100) */
  percentComplete: number;
  /** Current assertion being verified */
  currentAssertion?: number;
  /** Total assertions to verify */
  totalAssertions?: number;
  /** Time elapsed in ms */
  elapsed?: number;
}

/**
 * Result of a single iteration
 */
export interface FeatureShipLoopIterationResult {
  /** Iteration number (1-based) */
  iteration: number;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime: Date;
  /** Duration in ms */
  duration: number;
  /** Build result (if performed) */
  build?: {
    success: boolean;
    result?: BuildResult;
    error?: string;
  };
  /** Launch result */
  launch?: {
    success: boolean;
    error?: string;
  };
  /** Navigation result */
  navigation?: {
    success: boolean;
    result?: FlowRunResult;
    error?: string;
  };
  /** Individual assertion results */
  assertions: {
    assertion: PlaybookAssertion;
    result?: VerificationResult;
    passed: boolean;
    error?: string;
  }[];
  /** Snapshot captured */
  snapshot?: {
    result?: SnapshotResult;
    error?: string;
  };
  /** Whether all assertions passed */
  allAssertionsPassed: boolean;
  /** Whether this iteration should stop the loop */
  shouldStop: boolean;
  /** Reason for stopping */
  stopReason?: string;
}

/**
 * Final result of the Feature Ship Loop execution
 */
export interface FeatureShipLoopResult {
  /** Whether all assertions passed */
  passed: boolean;
  /** How the loop terminated */
  terminationReason: 'assertions_passed' | 'max_iterations' | 'build_failed' | 'error';
  /** Total iterations executed */
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
  iterations: FeatureShipLoopIterationResult[];
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
  /** Built app path (if successful) */
  appPath?: string;
  /** Bundle ID */
  bundleId?: string;
  /** Assertion summary */
  assertionsSummary: {
    total: number;
    passed: number;
    failed: number;
    assertions: {
      assertion: PlaybookAssertion;
      passedOn?: number;
      lastStatus: VerificationStatus | 'not_run';
    }[];
  };
  /** Artifacts directory */
  artifactsDir: string;
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
  /** Built app path */
  appPath?: string;
  /** Bundle ID */
  bundleId?: string;
  /** Current variables */
  variables: PlaybookVariables;
  /** Step outputs */
  outputs: Record<string, unknown>;
  /** All collected iterations */
  iterations: FeatureShipLoopIterationResult[];
  /** Progress callback */
  onProgress?: (update: FeatureShipLoopProgress) => void;
}

// =============================================================================
// Main Executor
// =============================================================================

/**
 * Execute the Feature Ship Loop playbook.
 *
 * This runs an iterative build-test loop:
 * 1. Build the Xcode project
 * 2. Launch the app on simulator
 * 3. Navigate to target screen (if specified)
 * 4. Run assertions to verify UI state
 * 5. Capture snapshot for evidence
 * 6. Report progress and iterate
 *
 * Loop continues until all assertions pass or max iterations reached.
 *
 * @param options - Execution options
 * @returns Execution result with all iteration details
 */
export async function runFeatureShipLoop(
  options: FeatureShipLoopOptions
): Promise<IOSResult<FeatureShipLoopResult>> {
  const startTime = new Date();

  logger.info(`${LOG_CONTEXT} Starting Feature Ship Loop`);
  logger.info(`${LOG_CONTEXT} Project: ${options.inputs.project_path}`);
  logger.info(`${LOG_CONTEXT} Scheme: ${options.inputs.scheme}`);
  logger.info(`${LOG_CONTEXT} Assertions: ${options.inputs.assertions.length}`);

  // Load playbook configuration
  let playbook: IOSPlaybookConfig;
  try {
    if (options.playbookPath) {
      playbook = loadPlaybook(options.playbookPath);
    } else {
      playbook = loadPlaybook('Feature-Ship-Loop');
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

  // Initialize variables from playbook and options
  const maxIterations = options.maxIterations || (playbook.variables?.max_iterations as number) || 10;
  const variables: PlaybookVariables = {
    ...playbook.variables,
    iteration: 0,
    max_iterations: maxIterations,
    build_success: false,
    assertions_passed: false,
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
  const loopDir = path.join(artifactsDir, `feature-ship-loop-${Date.now()}`);
  await mkdir(loopDir, { recursive: true });

  // Create execution context
  const context: ExecutionContext = {
    udid,
    simulator,
    sessionId: options.sessionId,
    artifactsDir: loopDir,
    variables,
    outputs: {},
    iterations: [],
    onProgress: options.onProgress,
  };

  // Report initialization
  reportProgress(context, {
    phase: 'initializing',
    iteration: 0,
    maxIterations,
    message: 'Initializing Feature Ship Loop',
    percentComplete: 0,
  });

  // Dry run check
  if (options.dryRun) {
    logger.info(`${LOG_CONTEXT} Dry run - validation complete, not executing`);
    return {
      success: true,
      data: createDryRunResult(options, playbook, simulator, loopDir, startTime, variables),
    };
  }

  // Track assertion status across iterations
  const assertionTracking = options.inputs.assertions.map((assertion) => ({
    assertion,
    passedOn: undefined as number | undefined,
    lastStatus: 'not_run' as VerificationStatus | 'not_run',
  }));

  let terminationReason: FeatureShipLoopResult['terminationReason'] = 'max_iterations';
  let finalError: string | undefined;

  // Initial build (always required)
  reportProgress(context, {
    phase: 'building',
    iteration: 0,
    maxIterations,
    message: 'Building project',
    percentComplete: 5,
  });

  const buildResult = await performBuild(options, context);
  if (!buildResult.success) {
    logger.error(`${LOG_CONTEXT} Initial build failed: ${buildResult.error}`);
    return createErrorResult(
      options,
      playbook,
      context,
      'build_failed',
      buildResult.error || 'Build failed',
      startTime
    );
  }

  context.appPath = buildResult.data?.appPath;
  context.bundleId = await detectBundleId(buildResult.data?.appPath, options.inputs.scheme);
  context.variables.build_success = true;
  context.outputs.build = buildResult.data;

  logger.info(`${LOG_CONTEXT} Build successful. App: ${context.appPath}`);
  logger.info(`${LOG_CONTEXT} Bundle ID: ${context.bundleId}`);

  // Main iteration loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    context.variables.iteration = iteration;
    const iterStartTime = new Date();

    logger.info(`${LOG_CONTEXT} === Iteration ${iteration}/${maxIterations} ===`);

    const iterationResult: FeatureShipLoopIterationResult = {
      iteration,
      startTime: iterStartTime,
      endTime: new Date(),
      duration: 0,
      assertions: [],
      allAssertionsPassed: false,
      shouldStop: false,
    };

    try {
      // Rebuild if configured (after first iteration)
      if (iteration > 1 && options.rebuildOnIteration) {
        reportProgress(context, {
          phase: 'building',
          iteration,
          maxIterations,
          stepName: 'Rebuild Project',
          message: `Rebuilding project (iteration ${iteration})`,
          percentComplete: calculateProgress(iteration, maxIterations, 'building'),
        });

        const rebuildResult = await performBuild(options, context);
        iterationResult.build = {
          success: rebuildResult.success,
          result: rebuildResult.data,
          error: rebuildResult.error,
        };

        if (!rebuildResult.success) {
          logger.error(`${LOG_CONTEXT} Rebuild failed: ${rebuildResult.error}`);
          terminationReason = 'build_failed';
          finalError = rebuildResult.error;
          iterationResult.shouldStop = true;
          iterationResult.stopReason = 'Build failed';
        }
      }

      // Launch app
      if (!iterationResult.shouldStop) {
        const launchResult = await performLaunch(options, context, iteration);
        iterationResult.launch = launchResult;

        if (!launchResult.success) {
          logger.warn(`${LOG_CONTEXT} Launch failed: ${launchResult.error}`);
          // Continue anyway - assertions will reveal the actual state
        }
      }

      // Navigate to target screen (if specified)
      if (!iterationResult.shouldStop && options.inputs.target_screen && options.inputs.navigation_steps) {
        const navResult = await performNavigation(options, context, iteration);
        iterationResult.navigation = navResult;

        if (!navResult.success) {
          logger.warn(`${LOG_CONTEXT} Navigation failed: ${navResult.error}`);
        }
      }

      // Run assertions
      if (!iterationResult.shouldStop) {
        const assertionsResult = await performAssertions(
          options,
          context,
          iteration,
          assertionTracking
        );
        iterationResult.assertions = assertionsResult.assertions;
        iterationResult.allAssertionsPassed = assertionsResult.allPassed;

        if (assertionsResult.allPassed) {
          logger.info(`${LOG_CONTEXT} All assertions passed!`);
          terminationReason = 'assertions_passed';
          iterationResult.shouldStop = true;
          iterationResult.stopReason = 'All assertions passed';
          context.variables.assertions_passed = true;
        }
      }

      // Capture snapshot
      if (options.collectSnapshots !== false && (!iterationResult.shouldStop || terminationReason === 'assertions_passed')) {
        const snapshotResult = await performSnapshot(context, iteration);
        iterationResult.snapshot = snapshotResult;
      }

      // Report progress
      reportProgress(context, {
        phase: iterationResult.allAssertionsPassed ? 'complete' : 'reporting',
        iteration,
        maxIterations,
        stepName: 'Report Progress',
        message: iterationResult.allAssertionsPassed
          ? `All assertions passed after ${iteration} iteration(s)`
          : `Iteration ${iteration} complete - ${iterationResult.assertions.filter((a) => a.passed).length}/${options.inputs.assertions.length} assertions passed`,
        percentComplete: calculateProgress(iteration, maxIterations, 'reporting'),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`${LOG_CONTEXT} Iteration ${iteration} error: ${error}`);
      terminationReason = 'error';
      finalError = error;
      iterationResult.shouldStop = true;
      iterationResult.stopReason = `Error: ${error}`;
    }

    // Complete iteration
    iterationResult.endTime = new Date();
    iterationResult.duration = iterationResult.endTime.getTime() - iterStartTime.getTime();
    context.iterations.push(iterationResult);

    // Check if we should stop
    if (iterationResult.shouldStop) {
      break;
    }

    // Wait before next iteration
    if (iteration < maxIterations) {
      const delay = options.iterationDelay ?? 2000;
      logger.debug(`${LOG_CONTEXT} Waiting ${delay}ms before next iteration`);
      await sleep(delay);
    }
  }

  // Build final result
  const endTime = new Date();
  const totalDuration = endTime.getTime() - startTime.getTime();
  const passed = terminationReason === 'assertions_passed';

  // Build assertion summary
  const assertionsSummary = {
    total: options.inputs.assertions.length,
    passed: assertionTracking.filter((t) => t.passedOn !== undefined).length,
    failed: assertionTracking.filter((t) => t.passedOn === undefined && t.lastStatus !== 'not_run').length,
    assertions: assertionTracking,
  };

  // Write summary files
  await writeSummaryFiles(loopDir, {
    passed,
    terminationReason,
    iterationsRun: context.iterations.length,
    maxIterations,
    totalDuration,
    assertionsSummary,
    simulator,
  });

  // Final progress report
  reportProgress(context, {
    phase: passed ? 'complete' : 'failed',
    iteration: context.iterations.length,
    maxIterations,
    message: passed
      ? `Feature Ship Loop passed after ${context.iterations.length} iteration(s)`
      : `Feature Ship Loop ${terminationReason}: ${finalError || 'See details'}`,
    percentComplete: 100,
    elapsed: totalDuration,
  });

  const result: FeatureShipLoopResult = {
    passed,
    terminationReason,
    iterationsRun: context.iterations.length,
    maxIterations,
    totalDuration,
    startTime,
    endTime,
    iterations: context.iterations,
    playbook: {
      name: playbook.name,
      version: playbook.version,
      path: options.playbookPath,
    },
    simulator,
    appPath: context.appPath,
    bundleId: context.bundleId,
    assertionsSummary,
    artifactsDir: loopDir,
    error: finalError,
    finalVariables: context.variables,
  };

  logger.info(
    `${LOG_CONTEXT} Feature Ship Loop complete: ${passed ? 'PASSED' : 'FAILED'} after ${context.iterations.length} iteration(s) in ${totalDuration}ms`
  );

  return {
    success: true,
    data: result,
  };
}

// =============================================================================
// Step Executors
// =============================================================================

/**
 * Perform the build step
 */
async function performBuild(
  options: FeatureShipLoopOptions,
  context: ExecutionContext
): Promise<IOSResult<BuildResult>> {
  const projectPath = options.inputs.project_path;
  const scheme = options.inputs.scheme;
  const configuration = options.configuration || 'Debug';

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

/**
 * Perform the launch step
 */
async function performLaunch(
  options: FeatureShipLoopOptions,
  context: ExecutionContext,
  iteration: number
): Promise<{ success: boolean; error?: string }> {
  const relaunch = options.relaunchOnIteration !== false;

  reportProgress(context, {
    phase: 'launching',
    iteration,
    maxIterations: context.variables.max_iterations as number,
    stepName: 'Launch App',
    message: `Launching app on ${context.simulator.name}`,
    percentComplete: calculateProgress(iteration, context.variables.max_iterations as number, 'launching'),
  });

  if (!context.bundleId) {
    return { success: false, error: 'Bundle ID not determined from build' };
  }

  // Terminate first for clean state (if relaunching)
  if (relaunch) {
    await terminateApp(context.udid, context.bundleId);
    await sleep(500);
  }

  const launchResult = await launchApp({
    udid: context.udid,
    bundleId: context.bundleId,
  });

  if (!launchResult.success) {
    return { success: false, error: launchResult.error };
  }

  // Wait for app to be ready
  // Note: launch_screen can be used in future for more sophisticated wait logic
  await sleep(1000); // Give app time to start

  return { success: true };
}

/**
 * Perform navigation to target screen
 */
async function performNavigation(
  options: FeatureShipLoopOptions,
  context: ExecutionContext,
  iteration: number
): Promise<{ success: boolean; result?: FlowRunResult; error?: string }> {
  if (!options.inputs.navigation_steps || options.inputs.navigation_steps.length === 0) {
    return { success: true };
  }

  reportProgress(context, {
    phase: 'navigating',
    iteration,
    maxIterations: context.variables.max_iterations as number,
    stepName: 'Navigate to Target',
    message: `Navigating to ${options.inputs.target_screen}`,
    percentComplete: calculateProgress(iteration, context.variables.max_iterations as number, 'navigating'),
  });

  // TODO: Convert navigation_steps to flow and run
  // For now, return success - navigation requires flow file support
  return { success: true };
}

/**
 * Perform assertions
 */
async function performAssertions(
  options: FeatureShipLoopOptions,
  context: ExecutionContext,
  iteration: number,
  tracking: Array<{ assertion: PlaybookAssertion; passedOn?: number; lastStatus: VerificationStatus | 'not_run' }>
): Promise<{
  assertions: FeatureShipLoopIterationResult['assertions'];
  allPassed: boolean;
}> {
  const assertions = options.inputs.assertions;
  const results: FeatureShipLoopIterationResult['assertions'] = [];
  const timeout = options.assertionTimeout ?? 10000;
  let allPassed = true;

  reportProgress(context, {
    phase: 'verifying',
    iteration,
    maxIterations: context.variables.max_iterations as number,
    stepName: 'Run Assertions',
    message: 'Running assertions',
    percentComplete: calculateProgress(iteration, context.variables.max_iterations as number, 'verifying'),
    currentAssertion: 0,
    totalAssertions: assertions.length,
  });

  for (let i = 0; i < assertions.length; i++) {
    const assertion = assertions[i];
    const trackingEntry = tracking[i];

    reportProgress(context, {
      phase: 'verifying',
      iteration,
      maxIterations: context.variables.max_iterations as number,
      stepName: 'Run Assertions',
      message: assertion.description || `Verifying ${assertion.type}: ${assertion.target || assertion.bundleId}`,
      percentComplete: calculateProgress(iteration, context.variables.max_iterations as number, 'verifying'),
      currentAssertion: i + 1,
      totalAssertions: assertions.length,
    });

    const assertResult = await runAssertion(assertion, {
      udid: context.udid,
      sessionId: context.sessionId,
      bundleId: context.bundleId || '',
      timeout: assertion.timeout || timeout,
    });

    const passed = assertResult.success && assertResult.data?.passed;
    trackingEntry.lastStatus = assertResult.data?.status || 'error';

    if (passed && trackingEntry.passedOn === undefined) {
      trackingEntry.passedOn = iteration;
    }

    results.push({
      assertion,
      result: assertResult.data,
      passed: !!passed,
      error: assertResult.error || (passed ? undefined : assertResult.data?.message),
    });

    if (!passed) {
      allPassed = false;
      logger.debug(`${LOG_CONTEXT} Assertion failed: ${assertion.description || assertion.type}`);

      if (!options.continueOnAssertionFailure) {
        break;
      }
    }
  }

  return { assertions: results, allPassed };
}

/**
 * Run a single assertion
 */
async function runAssertion(
  assertion: PlaybookAssertion,
  options: { udid: string; sessionId: string; bundleId: string; timeout: number }
): Promise<IOSResult<VerificationResult>> {
  const baseOptions = {
    udid: options.udid,
    sessionId: options.sessionId,
    polling: {
      timeout: options.timeout,
      pollInterval: 500,
      description: assertion.description || `${assertion.type} assertion`,
    },
  };

  try {
    switch (assertion.type) {
      case 'visible': {
        if (!assertion.target) {
          return {
            success: false,
            error: 'Visible assertion requires a target',
            errorCode: 'COMMAND_FAILED' as IOSErrorCode,
          };
        }

        const visibleOptions: AssertVisibleOptions = {
          ...baseOptions,
          target: {
            [assertion.targetType || 'text']: assertion.target,
          },
        };

        return assertVisible(visibleOptions);
      }

      case 'not_visible': {
        if (!assertion.target) {
          return {
            success: false,
            error: 'NotVisible assertion requires a target',
            errorCode: 'COMMAND_FAILED' as IOSErrorCode,
          };
        }

        const { assertNotVisible } = await import('../assertions');
        const notVisibleOptions: AssertVisibleOptions = {
          ...baseOptions,
          target: {
            [assertion.targetType || 'text']: assertion.target,
          },
        };

        return assertNotVisible(notVisibleOptions);
      }

      case 'no_crash': {
        const bundleId = assertion.bundleId || options.bundleId;
        if (!bundleId) {
          return {
            success: false,
            error: 'NoCrash assertion requires a bundleId',
            errorCode: 'COMMAND_FAILED' as IOSErrorCode,
          };
        }

        return assertNoCrash({
          ...baseOptions,
          bundleId,
        });
      }

      default:
        return {
          success: false,
          error: `Unknown assertion type: ${assertion.type}`,
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

/**
 * Capture a snapshot
 */
async function performSnapshot(
  context: ExecutionContext,
  iteration: number
): Promise<{ result?: SnapshotResult; error?: string }> {
  reportProgress(context, {
    phase: 'capturing',
    iteration,
    maxIterations: context.variables.max_iterations as number,
    stepName: 'Capture Evidence',
    message: 'Capturing snapshot',
    percentComplete: calculateProgress(iteration, context.variables.max_iterations as number, 'capturing'),
  });

  const snapshotId = `iter-${iteration}-${generateSnapshotId()}`;
  const snapshotResult = await captureSnapshot({
    udid: context.udid,
    bundleId: context.bundleId,
    sessionId: context.sessionId,
    snapshotId,
  });

  if (snapshotResult.success && snapshotResult.data) {
    return { result: snapshotResult.data };
  } else {
    return { error: snapshotResult.error };
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate playbook inputs
 */
function validateInputs(
  inputs: FeatureShipLoopInputs,
  inputDefs?: Record<string, PlaybookInputDef>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required inputs
  if (!inputs.project_path) {
    errors.push('project_path is required');
  }
  if (!inputs.scheme) {
    errors.push('scheme is required');
  }
  if (!inputs.assertions || inputs.assertions.length === 0) {
    errors.push('assertions are required');
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
        (s) => s.name.toLowerCase() === simulatorSpec.toLowerCase()
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
      // Use plutil to read the plist
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
 * Calculate progress percentage
 */
function calculateProgress(
  iteration: number,
  maxIterations: number,
  phase: string
): number {
  const iterProgress = ((iteration - 1) / maxIterations) * 100;
  const phaseWeights: Record<string, number> = {
    building: 0.1,
    launching: 0.2,
    navigating: 0.3,
    verifying: 0.6,
    capturing: 0.9,
    reporting: 1.0,
  };

  const phaseWeight = phaseWeights[phase] || 0.5;
  const iterContribution = (1 / maxIterations) * 100;

  return Math.min(99, iterProgress + iterContribution * phaseWeight);
}

/**
 * Report progress
 */
function reportProgress(context: ExecutionContext, update: FeatureShipLoopProgress): void {
  logger.debug(`${LOG_CONTEXT} Progress: ${update.phase} - ${update.message}`);
  context.onProgress?.(update);
}

/**
 * Create dry run result
 */
function createDryRunResult(
  options: FeatureShipLoopOptions,
  playbook: IOSPlaybookConfig,
  simulator: { udid: string; name: string; iosVersion: string },
  artifactsDir: string,
  startTime: Date,
  variables: PlaybookVariables
): FeatureShipLoopResult {
  const endTime = new Date();
  return {
    passed: false,
    terminationReason: 'max_iterations',
    iterationsRun: 0,
    maxIterations: options.maxIterations || 10,
    totalDuration: endTime.getTime() - startTime.getTime(),
    startTime,
    endTime,
    iterations: [],
    playbook: {
      name: playbook.name,
      version: playbook.version,
      path: options.playbookPath,
    },
    simulator,
    assertionsSummary: {
      total: options.inputs.assertions.length,
      passed: 0,
      failed: 0,
      assertions: options.inputs.assertions.map((assertion) => ({
        assertion,
        lastStatus: 'not_run' as const,
      })),
    },
    artifactsDir,
    finalVariables: variables,
  };
}

/**
 * Create error result
 */
function createErrorResult(
  options: FeatureShipLoopOptions,
  playbook: IOSPlaybookConfig,
  context: ExecutionContext,
  reason: FeatureShipLoopResult['terminationReason'],
  error: string,
  startTime: Date
): IOSResult<FeatureShipLoopResult> {
  const endTime = new Date();
  return {
    success: true,
    data: {
      passed: false,
      terminationReason: reason,
      iterationsRun: context.iterations.length,
      maxIterations: context.variables.max_iterations as number,
      totalDuration: endTime.getTime() - startTime.getTime(),
      startTime,
      endTime,
      iterations: context.iterations,
      playbook: {
        name: playbook.name,
        version: playbook.version,
        path: options.playbookPath,
      },
      simulator: context.simulator,
      appPath: context.appPath,
      bundleId: context.bundleId,
      assertionsSummary: {
        total: options.inputs.assertions.length,
        passed: 0,
        failed: 0,
        assertions: options.inputs.assertions.map((assertion) => ({
          assertion,
          lastStatus: 'not_run' as const,
        })),
      },
      artifactsDir: context.artifactsDir,
      error,
      finalVariables: context.variables,
    },
  };
}

/**
 * Write summary files to artifacts directory
 */
async function writeSummaryFiles(
  dir: string,
  summary: {
    passed: boolean;
    terminationReason: string;
    iterationsRun: number;
    maxIterations: number;
    totalDuration: number;
    assertionsSummary: FeatureShipLoopResult['assertionsSummary'];
    simulator: { udid: string; name: string; iosVersion: string };
  }
): Promise<void> {
  try {
    // Write text summary
    const textSummary = buildTextReport(summary);
    await writeFile(path.join(dir, 'summary.txt'), textSummary);

    // Write JSON result
    await writeFile(
      path.join(dir, 'result.json'),
      JSON.stringify(
        {
          passed: summary.passed,
          terminationReason: summary.terminationReason,
          iterationsRun: summary.iterationsRun,
          maxIterations: summary.maxIterations,
          totalDuration: summary.totalDuration,
          simulator: summary.simulator,
          assertionsSummary: summary.assertionsSummary,
        },
        null,
        2
      )
    );
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to write summary files: ${e}`);
  }
}

/**
 * Build text report
 */
function buildTextReport(summary: {
  passed: boolean;
  terminationReason: string;
  iterationsRun: number;
  maxIterations: number;
  totalDuration: number;
  assertionsSummary: FeatureShipLoopResult['assertionsSummary'];
  simulator: { udid: string; name: string; iosVersion: string };
}): string {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push('FEATURE SHIP LOOP REPORT');
  lines.push('='.repeat(60));
  lines.push('');

  lines.push(`Status: ${summary.passed ? '✓ PASSED' : '✗ FAILED'}`);
  lines.push(`Reason: ${formatTerminationReason(summary.terminationReason)}`);
  lines.push(`Iterations: ${summary.iterationsRun}/${summary.maxIterations}`);
  lines.push(`Duration: ${formatDuration(summary.totalDuration)}`);
  lines.push(`Simulator: ${summary.simulator.name} (iOS ${summary.simulator.iosVersion})`);
  lines.push('');

  lines.push('-'.repeat(40));
  lines.push('ASSERTIONS');
  lines.push('-'.repeat(40));

  for (const tracked of summary.assertionsSummary.assertions) {
    const { assertion, passedOn, lastStatus } = tracked;
    const statusIcon = passedOn !== undefined ? '✓' : lastStatus === 'not_run' ? '-' : '✗';
    const description = assertion.description || `${assertion.type}: ${assertion.target || assertion.bundleId}`;
    const passedInfo = passedOn !== undefined ? ` (passed on iteration ${passedOn})` : '';
    lines.push(`  ${statusIcon} ${description}${passedInfo}`);
  }

  lines.push('');
  lines.push('='.repeat(60));

  return lines.join('\n');
}

/**
 * Format termination reason
 */
function formatTerminationReason(reason: string): string {
  switch (reason) {
    case 'assertions_passed':
      return 'All assertions passed';
    case 'max_iterations':
      return 'Maximum iterations reached';
    case 'build_failed':
      return 'Build failed';
    case 'error':
      return 'Error occurred';
    default:
      return reason;
  }
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

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Result Formatters
// =============================================================================

/**
 * Format result for agent output (markdown)
 */
export function formatFeatureShipLoopResult(result: FeatureShipLoopResult): string {
  const lines: string[] = [];

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
  if (result.bundleId) {
    lines.push(`| Bundle ID | ${result.bundleId} |`);
  }
  lines.push('');

  // Assertions
  lines.push('### Assertions');
  lines.push('');

  for (const tracked of result.assertionsSummary.assertions) {
    const { assertion, passedOn, lastStatus } = tracked;
    const statusIcon = passedOn !== undefined ? '✅' : lastStatus === 'not_run' ? '⏭️' : '❌';
    const description = assertion.description || `${assertion.type}: ${assertion.target || assertion.bundleId}`;
    const passedInfo = passedOn !== undefined ? ` (iteration ${passedOn})` : '';
    lines.push(`- ${statusIcon} ${description}${passedInfo}`);
  }
  lines.push('');

  // Artifacts
  lines.push('### Artifacts');
  lines.push('');
  lines.push(`- Directory: \`${result.artifactsDir}\``);
  if (result.appPath) {
    lines.push(`- App: \`${result.appPath}\``);
  }
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
 * Format result as JSON
 */
export function formatFeatureShipLoopResultAsJson(result: FeatureShipLoopResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format result in compact form
 */
export function formatFeatureShipLoopResultCompact(result: FeatureShipLoopResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const assertions = `${result.assertionsSummary.passed}/${result.assertionsSummary.total}`;
  return `[${status}] ${result.iterationsRun} iter, ${assertions} assertions, ${formatDuration(result.totalDuration)}`;
}
