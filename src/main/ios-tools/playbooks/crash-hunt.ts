/**
 * iOS Playbook - Crash Hunt Executor
 *
 * Executes the Crash Hunt playbook for iOS stability testing.
 * Performs semi-random UI navigation to discover crashes, hangs, and errors.
 */

import * as path from 'path';
import * as fs from 'fs';
import { mkdir, writeFile, copyFile } from 'fs/promises';
import { IOSResult, IOSErrorCode, LogEntry, CrashReport } from '../types';
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
import { screenshot } from '../capture';
import { getCrashLogs, hasRecentCrashes, streamLog, stopLogStream, LogStreamHandle } from '../logs';
import { inspectUI, InspectResult, XCUITestInspectResult } from '../inspect';
import { getArtifactDirectory } from '../artifacts';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[iOS-CrashHunt]';

// =============================================================================
// Types
// =============================================================================

/**
 * Action weights for random selection
 */
export interface ActionWeights {
  /** Weight for tap actions (default: 60) */
  tap: number;
  /** Weight for scroll actions (default: 20) */
  scroll: number;
  /** Weight for swipe actions (default: 10) */
  swipe: number;
  /** Weight for back/navigation actions (default: 10) */
  back: number;
}

/**
 * Input values for running the Crash Hunt
 */
export interface CrashHuntInputs {
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
  /** How long to run in seconds (default: 300) */
  duration?: number;
  /** Seconds between interactions (default: 2) */
  interaction_interval?: number;
  /** Max navigation depth before reset (default: 5) */
  max_depth?: number;
  /** Random seed for reproducibility */
  seed?: number;
  /** Weights for action selection */
  action_weights?: ActionWeights;
  /** Element identifiers to exclude from interaction */
  excluded_elements?: string[];
  /** Capture screenshot and logs when crash detected (default: true) */
  capture_on_crash?: boolean;
  /** Reset and continue hunting after crash (default: true) */
  reset_on_crash?: boolean;
}

/**
 * Options for the Crash Hunt execution
 */
export interface CrashHuntOptions {
  /** Input values matching playbook inputs */
  inputs: CrashHuntInputs;
  /** Session ID for artifact storage */
  sessionId: string;
  /** Path to playbook YAML (uses built-in if not specified) */
  playbookPath?: string;
  /** Working directory for relative paths */
  cwd?: string;
  /** Build configuration (default: Debug) */
  configuration?: 'Debug' | 'Release' | string;
  /** Timeout per build in ms (default: 600000 = 10 min) */
  buildTimeout?: number;
  /** Progress callback */
  onProgress?: (update: CrashHuntProgress) => void;
  /** Callback when crash is detected */
  onCrash?: (crash: CrashDetection) => void;
  /** Callback for each action performed */
  onAction?: (action: RecordedAction) => void;
  /** Dry run - validate without executing */
  dryRun?: boolean;
}

/**
 * Progress update during execution
 */
export interface CrashHuntProgress {
  /** Current execution phase */
  phase:
    | 'initializing'
    | 'building'
    | 'installing'
    | 'hunting'
    | 'recovering'
    | 'generating_report'
    | 'complete'
    | 'failed';
  /** Human-readable message */
  message: string;
  /** Percentage complete (0-100) based on elapsed time */
  percentComplete: number;
  /** Current navigation depth */
  currentDepth: number;
  /** Maximum configured depth */
  maxDepth: number;
  /** Actions performed so far */
  actionsPerformed: number;
  /** Crashes found so far */
  crashesFound: number;
  /** Elapsed time in seconds */
  elapsedSeconds: number;
  /** Configured duration in seconds */
  totalDuration: number;
}

/**
 * A recorded UI action
 */
export interface RecordedAction {
  /** Action number (1-based) */
  actionNumber: number;
  /** Timestamp when action was performed */
  timestamp: Date;
  /** Type of action performed */
  type: 'tap' | 'scroll' | 'swipe' | 'back';
  /** Target element information */
  target?: {
    type: string;
    identifier?: string;
    label?: string;
    frame?: { x: number; y: number; width: number; height: number };
  };
  /** Additional action parameters */
  params?: Record<string, unknown>;
  /** Whether the action succeeded */
  success: boolean;
  /** Whether navigation occurred (new screen appeared) */
  navigationOccurred?: boolean;
  /** Error message if action failed */
  error?: string;
  /** Current navigation depth after action */
  depthAfterAction: number;
}

/**
 * Detected crash information
 */
export interface CrashDetection {
  /** Crash number (1-based) */
  crashNumber: number;
  /** Timestamp when crash was detected */
  timestamp: Date;
  /** Crash type/signal if known */
  crashType?: string;
  /** Bundle ID of crashed app */
  bundleId: string;
  /** Last N actions before crash (for reproduction) */
  actionsBefore: RecordedAction[];
  /** Screenshot path at crash time */
  screenshotPath?: string;
  /** Console log excerpt around crash */
  consoleLog?: string;
  /** UI tree at time of crash (if captured) */
  uiTreePath?: string;
  /** Crash report if available */
  crashReport?: CrashReport;
  /** Directory containing crash evidence */
  evidenceDir: string;
}

/**
 * Final result of the Crash Hunt execution
 */
export interface CrashHuntResult {
  /** Whether hunt completed without errors (crashes may have been found) */
  completed: boolean;
  /** Number of crashes detected */
  crashesFound: number;
  /** Total duration in seconds */
  totalDuration: number;
  /** Total actions performed */
  actionsPerformed: number;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime: Date;
  /** All detected crashes */
  crashes: CrashDetection[];
  /** All recorded actions */
  actions: RecordedAction[];
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
  /** Artifacts directory */
  artifactsDir: string;
  /** HTML report path */
  htmlReportPath?: string;
  /** JSON report path */
  jsonReportPath?: string;
  /** How the hunt ended */
  terminationReason: 'duration_reached' | 'crash_no_reset' | 'error';
  /** Seed used (for reproducibility) */
  seed?: number;
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
  /** All recorded actions */
  actions: RecordedAction[];
  /** All detected crashes */
  crashes: CrashDetection[];
  /** Current navigation depth */
  currentDepth: number;
  /** Random number generator */
  rng: SeededRandom;
  /** Action weights */
  actionWeights: ActionWeights;
  /** Excluded elements */
  excludedElements: Set<string>;
  /** Log stream handle */
  logStream?: LogStreamHandle;
  /** Detected log patterns */
  detectedPatterns: string[];
  /** Progress callback */
  onProgress?: (update: CrashHuntProgress) => void;
  /** Crash callback */
  onCrash?: (crash: CrashDetection) => void;
  /** Action callback */
  onAction?: (action: RecordedAction) => void;
}

// =============================================================================
// Seeded Random Number Generator
// =============================================================================

/**
 * Simple seeded random number generator for reproducibility
 */
class SeededRandom {
  private originalSeed: number;
  private currentSeed: number;

  constructor(seed?: number) {
    this.originalSeed = seed ?? Date.now();
    this.currentSeed = this.originalSeed;
  }

  /** Get the original seed (for reproducibility) */
  getSeed(): number {
    return this.originalSeed;
  }

  /** Generate a random number between 0 and 1 */
  random(): number {
    // Simple LCG (Linear Congruential Generator)
    this.currentSeed = (this.currentSeed * 1103515245 + 12345) & 0x7fffffff;
    return this.currentSeed / 0x7fffffff;
  }

  /** Generate a random integer between min and max (inclusive) */
  randomInt(min: number, max: number): number {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  /** Pick a random item from an array */
  randomChoice<T>(arr: T[]): T {
    return arr[this.randomInt(0, arr.length - 1)];
  }

  /** Pick a weighted random choice */
  weightedChoice<T>(items: T[], weights: number[]): T {
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = this.random() * totalWeight;

    for (let i = 0; i < items.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return items[i];
      }
    }

    return items[items.length - 1];
  }
}

// =============================================================================
// Main Executor
// =============================================================================

/**
 * Execute the Crash Hunt playbook.
 *
 * This performs exploratory stability testing:
 * 1. Build/install app (if needed)
 * 2. Launch app and start log monitoring
 * 3. Randomly navigate and interact with UI
 * 4. Detect crashes via log patterns and app state
 * 5. Record steps to reproduce
 * 6. Generate crash report
 *
 * @param options - Execution options
 * @returns Execution result with all crash details
 */
export async function runCrashHunt(
  options: CrashHuntOptions
): Promise<IOSResult<CrashHuntResult>> {
  const startTime = new Date();

  const duration = options.inputs.duration ?? 300;
  const interactionInterval = options.inputs.interaction_interval ?? 2;
  const maxDepth = options.inputs.max_depth ?? 5;

  logger.info(`${LOG_CONTEXT} Starting Crash Hunt`);
  logger.info(`${LOG_CONTEXT} Duration: ${duration}s`);
  logger.info(`${LOG_CONTEXT} Interaction interval: ${interactionInterval}s`);
  logger.info(`${LOG_CONTEXT} Max depth: ${maxDepth}`);

  // Load playbook configuration
  let playbook: IOSPlaybookConfig;
  try {
    if (options.playbookPath) {
      playbook = loadPlaybook(options.playbookPath);
    } else {
      playbook = loadPlaybook('Crash-Hunt');
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

  // Initialize random number generator
  const rng = new SeededRandom(options.inputs.seed);
  logger.info(`${LOG_CONTEXT} Using seed: ${rng.getSeed()}`);

  // Initialize variables from playbook
  const variables: PlaybookVariables = {
    ...playbook.variables,
    crashes_found: 0,
    actions_performed: 0,
    current_depth: 0,
    start_time: startTime.toISOString(),
    elapsed_seconds: 0,
    crash_detected: false,
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
  const artifactDir = await getArtifactDirectory(options.sessionId);
  const huntDir = path.join(artifactDir, `crash-hunt-${Date.now()}`);
  await mkdir(huntDir, { recursive: true });
  await mkdir(path.join(huntDir, 'crashes'), { recursive: true });
  await mkdir(path.join(huntDir, 'screenshots'), { recursive: true });

  // Initialize action weights
  const actionWeights: ActionWeights = {
    tap: options.inputs.action_weights?.tap ?? 60,
    scroll: options.inputs.action_weights?.scroll ?? 20,
    swipe: options.inputs.action_weights?.swipe ?? 10,
    back: options.inputs.action_weights?.back ?? 10,
  };

  // Create execution context
  const context: ExecutionContext = {
    udid,
    simulator,
    sessionId: options.sessionId,
    artifactsDir: huntDir,
    variables,
    actions: [],
    crashes: [],
    currentDepth: 0,
    rng,
    actionWeights,
    excludedElements: new Set(options.inputs.excluded_elements || []),
    detectedPatterns: [],
    onProgress: options.onProgress,
    onCrash: options.onCrash,
    onAction: options.onAction,
  };

  // Report initialization
  reportProgress(context, {
    phase: 'initializing',
    message: 'Initializing Crash Hunt',
    percentComplete: 0,
    currentDepth: 0,
    maxDepth,
    actionsPerformed: 0,
    crashesFound: 0,
    elapsedSeconds: 0,
    totalDuration: duration,
  });

  // Dry run check
  if (options.dryRun) {
    logger.info(`${LOG_CONTEXT} Dry run - validation complete, not executing`);
    return {
      success: true,
      data: createDryRunResult(options, playbook, simulator, huntDir, startTime, variables, rng.getSeed()),
    };
  }

  // Build or use provided app
  let appPath = options.inputs.app_path;
  let bundleId = options.inputs.bundle_id;

  if (!appPath && options.inputs.project_path) {
    reportProgress(context, {
      phase: 'building',
      message: 'Building project',
      percentComplete: 2,
      currentDepth: 0,
      maxDepth,
      actionsPerformed: 0,
      crashesFound: 0,
      elapsedSeconds: 0,
      totalDuration: duration,
    });

    const buildResult = await performBuild(options, context);
    if (!buildResult.success || !buildResult.data) {
      return createErrorResult(
        options,
        playbook,
        context,
        buildResult.error || 'Build failed',
        startTime,
        rng.getSeed()
      );
    }

    appPath = buildResult.data.appPath;
    bundleId = bundleId || await detectBundleId(appPath, options.inputs.scheme);
    context.appPath = appPath;
    context.bundleId = bundleId;
    logger.info(`${LOG_CONTEXT} Build successful. App: ${appPath}`);
  } else if (appPath) {
    bundleId = bundleId || await detectBundleId(appPath);
    context.appPath = appPath;
    context.bundleId = bundleId;
  }

  if (!bundleId) {
    return {
      success: false,
      error: 'Bundle ID could not be determined. Please provide bundle_id input.',
      errorCode: 'COMMAND_FAILED' as IOSErrorCode,
    };
  }

  // Install app if path provided
  if (appPath) {
    reportProgress(context, {
      phase: 'installing',
      message: 'Installing app',
      percentComplete: 5,
      currentDepth: 0,
      maxDepth,
      actionsPerformed: 0,
      crashesFound: 0,
      elapsedSeconds: 0,
      totalDuration: duration,
    });

    const installResult = await installApp({ udid, appPath });
    if (!installResult.success) {
      logger.warn(`${LOG_CONTEXT} Install warning: ${installResult.error}`);
    }
  }

  // Launch app
  const launchResult = await launchApp({ udid, bundleId });
  if (!launchResult.success) {
    logger.warn(`${LOG_CONTEXT} Launch warning: ${launchResult.error}`);
  }
  await sleep(1000);

  // Start log monitoring for crash patterns
  const crashPatterns = [
    'CRASH',
    'SIGABRT',
    'SIGSEGV',
    'SIGBUS',
    'EXC_BAD_ACCESS',
    'EXC_CRASH',
    'assertion failed',
    'fatal error',
    'precondition failed',
    'Terminating app due to uncaught exception',
  ];

  const logStreamResult = await streamLog(
    {
      udid,
      predicate: crashPatterns.map(p => `eventMessage CONTAINS "${p}"`).join(' OR '),
    },
    (entry) => {
      // Check if this entry matches crash patterns
      for (const pattern of crashPatterns) {
        if (entry.message.includes(pattern)) {
          context.detectedPatterns.push(`${entry.timestamp.toISOString()}: ${entry.message.substring(0, 200)}`);
          context.variables.crash_detected = true;
          logger.warn(`${LOG_CONTEXT} Crash pattern detected: ${pattern}`);
        }
      }
    },
    (error) => {
      logger.warn(`${LOG_CONTEXT} Log stream error: ${error}`);
    }
  );

  if (logStreamResult.success && logStreamResult.data) {
    context.logStream = logStreamResult.data;
  }

  // Main hunting loop
  const captureOnCrash = options.inputs.capture_on_crash !== false;
  const resetOnCrash = options.inputs.reset_on_crash !== false;
  let terminationReason: CrashHuntResult['terminationReason'] = 'duration_reached';
  let finalError: string | undefined;

  const endTimeMs = startTime.getTime() + (duration * 1000);

  try {
    while (Date.now() < endTimeMs) {
      const elapsedSeconds = Math.floor((Date.now() - startTime.getTime()) / 1000);
      context.variables.elapsed_seconds = elapsedSeconds;

      // Check for crash
      const crashCheckResult = await checkForCrash(context, bundleId);
      if (crashCheckResult.crashed) {
        logger.warn(`${LOG_CONTEXT} Crash detected!`);

        if (captureOnCrash) {
          await captureCrashEvidence(context, bundleId, crashCheckResult);
        }

        if (!resetOnCrash) {
          terminationReason = 'crash_no_reset';
          break;
        }

        // Reset app and continue
        await recoverFromCrash(context, bundleId);
        context.currentDepth = 0;
        context.variables.crash_detected = false;
        context.detectedPatterns = [];
      }

      // Check max depth - reset to root if exceeded
      if (context.currentDepth >= maxDepth) {
        logger.info(`${LOG_CONTEXT} Max depth reached, resetting to root`);
        await navigateToRoot(context, bundleId);
        context.currentDepth = 0;
      }

      // Perform random action
      const action = await performRandomAction(context, bundleId, maxDepth);
      context.actions.push(action);
      context.variables.actions_performed = context.actions.length;
      context.onAction?.(action);

      if (action.navigationOccurred) {
        context.currentDepth++;
      }
      context.variables.current_depth = context.currentDepth;

      // Report progress
      const percentComplete = Math.min(99, Math.floor((elapsedSeconds / duration) * 100));
      reportProgress(context, {
        phase: 'hunting',
        message: `Action ${context.actions.length}: ${action.type}${action.success ? '' : ' (failed)'}`,
        percentComplete,
        currentDepth: context.currentDepth,
        maxDepth,
        actionsPerformed: context.actions.length,
        crashesFound: context.crashes.length,
        elapsedSeconds,
        totalDuration: duration,
      });

      // Wait before next action
      await sleep(interactionInterval * 1000);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error(`${LOG_CONTEXT} Hunt error: ${error}`);
    terminationReason = 'error';
    finalError = error;
  }

  // Stop log monitoring
  if (context.logStream) {
    context.logStream.stop();
  }

  // Generate reports
  reportProgress(context, {
    phase: 'generating_report',
    message: 'Generating crash hunt report',
    percentComplete: 95,
    currentDepth: context.currentDepth,
    maxDepth,
    actionsPerformed: context.actions.length,
    crashesFound: context.crashes.length,
    elapsedSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
    totalDuration: duration,
  });

  const htmlReportPath = path.join(huntDir, 'crash_report.html');
  const jsonReportPath = path.join(huntDir, 'crash_report.json');

  await generateReports(context, htmlReportPath, jsonReportPath);

  // Build final result
  const endTime = new Date();
  const totalDurationSec = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

  // Final progress report
  reportProgress(context, {
    phase: context.crashes.length > 0 ? 'complete' : 'complete',
    message: context.crashes.length > 0
      ? `Found ${context.crashes.length} crash(es) in ${totalDurationSec}s`
      : `No crashes found in ${totalDurationSec}s (${context.actions.length} actions)`,
    percentComplete: 100,
    currentDepth: context.currentDepth,
    maxDepth,
    actionsPerformed: context.actions.length,
    crashesFound: context.crashes.length,
    elapsedSeconds: totalDurationSec,
    totalDuration: duration,
  });

  const result: CrashHuntResult = {
    completed: terminationReason !== 'error',
    crashesFound: context.crashes.length,
    totalDuration: totalDurationSec,
    actionsPerformed: context.actions.length,
    startTime,
    endTime,
    crashes: context.crashes,
    actions: context.actions,
    playbook: {
      name: playbook.name,
      version: playbook.version,
      path: options.playbookPath,
    },
    simulator,
    appPath: context.appPath,
    bundleId: context.bundleId,
    artifactsDir: huntDir,
    htmlReportPath,
    jsonReportPath,
    terminationReason,
    seed: rng.getSeed(),
    error: finalError,
    finalVariables: context.variables,
  };

  logger.info(
    `${LOG_CONTEXT} Crash Hunt complete: ${context.crashes.length} crash(es) found, ${context.actions.length} actions in ${totalDurationSec}s`
  );

  return {
    success: true,
    data: result,
  };
}

// =============================================================================
// Action Executors
// =============================================================================

/**
 * Perform a random UI action
 */
async function performRandomAction(
  context: ExecutionContext,
  bundleId: string,
  maxDepth: number
): Promise<RecordedAction> {
  const actionNumber = context.actions.length + 1;
  const timestamp = new Date();

  // Get current UI state
  let uiTree: XCUITestInspectResult | undefined;
  try {
    const inspectResult = await inspectUI({
      simulatorUdid: context.udid,
      bundleId,
      sessionId: context.sessionId,
      includeHidden: false,
      captureScreenshot: false,
    });
    if (inspectResult.success && inspectResult.data) {
      uiTree = inspectResult.data;
    }
  } catch (e) {
    logger.debug(`${LOG_CONTEXT} UI inspection failed: ${e}`);
  }

  // Choose action type based on weights
  const actionTypes: Array<'tap' | 'scroll' | 'swipe' | 'back'> = ['tap', 'scroll', 'swipe', 'back'];
  const weights = [
    context.actionWeights.tap,
    context.actionWeights.scroll,
    context.actionWeights.swipe,
    context.actionWeights.back,
  ];
  const actionType = context.rng.weightedChoice(actionTypes, weights);

  const action: RecordedAction = {
    actionNumber,
    timestamp,
    type: actionType,
    success: false,
    depthAfterAction: context.currentDepth,
  };

  try {
    switch (actionType) {
      case 'tap':
        await performTapAction(context, action, uiTree);
        break;
      case 'scroll':
        await performScrollAction(context, action);
        break;
      case 'swipe':
        await performSwipeAction(context, action);
        break;
      case 'back':
        await performBackAction(context, action);
        break;
    }
  } catch (e) {
    action.error = e instanceof Error ? e.message : String(e);
    logger.debug(`${LOG_CONTEXT} Action ${actionType} failed: ${action.error}`);
  }

  return action;
}

/**
 * Perform a tap action on a random interactable element
 */
async function performTapAction(
  context: ExecutionContext,
  action: RecordedAction,
  uiTree?: XCUITestInspectResult
): Promise<void> {
  if (!uiTree?.rootElement) {
    // Fallback: tap at random screen location
    const x = context.rng.randomInt(50, 350);
    const y = context.rng.randomInt(100, 700);
    action.params = { x, y, fallback: true };

    // Use simctl tap
    const { execFileNoThrow } = await import('../../utils/execFile');
    await execFileNoThrow('xcrun', ['simctl', 'io', context.udid, 'tap', String(x), String(y)]);
    action.success = true;
    return;
  }

  // Find interactable elements
  const interactable = findInteractableElements(uiTree.rootElement);
  const filtered = interactable.filter(el => {
    const id = el.identifier || el.label || '';
    return !context.excludedElements.has(id);
  });

  if (filtered.length === 0) {
    action.error = 'No interactable elements found';
    return;
  }

  // Pick random element
  const target = context.rng.randomChoice(filtered);
  action.target = {
    type: target.type,
    identifier: target.identifier,
    label: target.label,
    frame: target.frame,
  };

  // Calculate tap coordinates
  const x = target.frame.x + target.frame.width / 2;
  const y = target.frame.y + target.frame.height / 2;
  action.params = { x, y };

  // Execute tap
  const { execFileNoThrow } = await import('../../utils/execFile');
  await execFileNoThrow('xcrun', ['simctl', 'io', context.udid, 'tap', String(x), String(y)]);
  action.success = true;

  // Check if navigation occurred (simple heuristic: wait and check if UI changed)
  await sleep(500);
  action.navigationOccurred = true; // Assume navigation for now
}

/**
 * Find all interactable elements in the UI tree
 */
function findInteractableElements(element: ElementNode | InspectResult['rootElement']): ElementNode[] {
  const results: ElementNode[] = [];

  function traverse(el: ElementNode) {
    if (el.isEnabled && el.isHittable && el.isVisible) {
      // Check if it's an interactable type
      const interactableTypes = ['button', 'cell', 'link', 'image', 'switch', 'slider', 'textField', 'secureTextField'];
      if (interactableTypes.some(t => el.type.toLowerCase().includes(t))) {
        results.push(el);
      }
    }

    if (el.children) {
      for (const child of el.children) {
        traverse(child as ElementNode);
      }
    }
  }

  traverse(element as ElementNode);
  return results;
}

/**
 * Perform a scroll action
 */
async function performScrollAction(
  context: ExecutionContext,
  action: RecordedAction
): Promise<void> {
  const direction = context.rng.randomChoice(['up', 'down']);
  const centerX = 195;
  const startY = direction === 'up' ? 600 : 200;
  const endY = direction === 'up' ? 200 : 600;

  action.params = { direction, startY, endY };

  const { execFileNoThrow } = await import('../../utils/execFile');
  await execFileNoThrow('xcrun', [
    'simctl', 'io', context.udid, 'swipe',
    String(centerX), String(startY),
    String(centerX), String(endY),
  ]);

  action.success = true;
}

/**
 * Perform a swipe action
 */
async function performSwipeAction(
  context: ExecutionContext,
  action: RecordedAction
): Promise<void> {
  const direction = context.rng.randomChoice(['left', 'right']);
  const centerY = 400;
  const startX = direction === 'left' ? 350 : 50;
  const endX = direction === 'left' ? 50 : 350;

  action.params = { direction, startX, endX };

  const { execFileNoThrow } = await import('../../utils/execFile');
  await execFileNoThrow('xcrun', [
    'simctl', 'io', context.udid, 'swipe',
    String(startX), String(centerY),
    String(endX), String(centerY),
  ]);

  action.success = true;
}

/**
 * Perform a back/navigation action
 */
async function performBackAction(
  context: ExecutionContext,
  action: RecordedAction
): Promise<void> {
  // Try to tap a back button or use swipe from left edge
  const backSwipeX = 10;
  const centerY = 400;
  const endX = 200;

  action.params = { gesture: 'swipe_from_edge' };

  const { execFileNoThrow } = await import('../../utils/execFile');
  await execFileNoThrow('xcrun', [
    'simctl', 'io', context.udid, 'swipe',
    String(backSwipeX), String(centerY),
    String(endX), String(centerY),
  ]);

  action.success = true;
  action.depthAfterAction = Math.max(0, context.currentDepth - 1);
}

/**
 * Navigate back to app root
 */
async function navigateToRoot(
  context: ExecutionContext,
  bundleId: string
): Promise<void> {
  // Relaunch app to reset to root
  await terminateApp(context.udid, bundleId);
  await sleep(500);
  await launchApp({ udid: context.udid, bundleId });
  await sleep(1000);
}

// =============================================================================
// Crash Detection
// =============================================================================

/**
 * Check if the app has crashed
 */
async function checkForCrash(
  context: ExecutionContext,
  bundleId: string
): Promise<{ crashed: boolean; crashInfo?: string }> {
  // Check if we detected crash patterns in logs
  if (context.variables.crash_detected) {
    return {
      crashed: true,
      crashInfo: context.detectedPatterns[context.detectedPatterns.length - 1],
    };
  }

  // Check for recent crash logs
  const since = new Date(Date.now() - 30000); // Last 30 seconds
  const hasRecentResult = await hasRecentCrashes(context.udid, bundleId, since);
  if (hasRecentResult.success && hasRecentResult.data) {
    return { crashed: true, crashInfo: 'Crash log detected' };
  }

  // Check if app is still running (simple check via simctl)
  // For now, assume app is running if no crash detected
  return { crashed: false };
}

/**
 * Capture crash evidence
 */
async function captureCrashEvidence(
  context: ExecutionContext,
  bundleId: string,
  crashCheck: { crashed: boolean; crashInfo?: string }
): Promise<void> {
  const crashNumber = context.crashes.length + 1;
  const evidenceDir = path.join(context.artifactsDir, 'crashes', `crash_${crashNumber}`);
  await mkdir(evidenceDir, { recursive: true });

  const crash: CrashDetection = {
    crashNumber,
    timestamp: new Date(),
    crashType: crashCheck.crashInfo,
    bundleId,
    actionsBefore: context.actions.slice(-10),
    evidenceDir,
  };

  // Capture screenshot
  try {
    const screenshotPath = path.join(evidenceDir, 'screenshot.png');
    const screenshotResult = await screenshot({
      udid: context.udid,
      outputPath: screenshotPath,
    });
    if (screenshotResult.success) {
      crash.screenshotPath = screenshotPath;
    }
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to capture crash screenshot: ${e}`);
  }

  // Get crash logs
  try {
    const crashLogsResult = await getCrashLogs({
      udid: context.udid,
      bundleId,
      since: new Date(Date.now() - 60000),
      limit: 1,
      includeContent: true,
    });
    if (crashLogsResult.success && crashLogsResult.data && crashLogsResult.data.length > 0) {
      crash.crashReport = crashLogsResult.data[0];
    }
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to get crash logs: ${e}`);
  }

  // Save console log excerpt
  if (context.detectedPatterns.length > 0) {
    crash.consoleLog = context.detectedPatterns.slice(-20).join('\n');
    try {
      await writeFile(path.join(evidenceDir, 'console.log'), crash.consoleLog);
    } catch (e) {
      logger.warn(`${LOG_CONTEXT} Failed to write console log: ${e}`);
    }
  }

  // Save steps to reproduce
  try {
    await writeFile(
      path.join(evidenceDir, 'steps.json'),
      JSON.stringify(crash.actionsBefore, null, 2)
    );
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to write steps: ${e}`);
  }

  context.crashes.push(crash);
  context.variables.crashes_found = context.crashes.length;
  context.onCrash?.(crash);

  logger.info(`${LOG_CONTEXT} Captured evidence for crash #${crashNumber}`);
}

/**
 * Recover from a crash by relaunching the app
 */
async function recoverFromCrash(
  context: ExecutionContext,
  bundleId: string
): Promise<void> {
  logger.info(`${LOG_CONTEXT} Recovering from crash...`);

  reportProgress(context, {
    phase: 'recovering',
    message: 'Recovering from crash...',
    percentComplete: -1,
    currentDepth: 0,
    maxDepth: context.variables.max_depth as number || 5,
    actionsPerformed: context.actions.length,
    crashesFound: context.crashes.length,
    elapsedSeconds: context.variables.elapsed_seconds as number || 0,
    totalDuration: context.variables.duration as number || 300,
  });

  // Terminate any lingering process
  await terminateApp(context.udid, bundleId);
  await sleep(1000);

  // Relaunch
  await launchApp({ udid: context.udid, bundleId });
  await sleep(2000);

  logger.info(`${LOG_CONTEXT} App relaunched after crash`);
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Generate HTML and JSON reports
 */
async function generateReports(
  context: ExecutionContext,
  htmlPath: string,
  jsonPath: string
): Promise<void> {
  try {
    // JSON report
    const jsonReport = {
      timestamp: new Date().toISOString(),
      simulator: context.simulator,
      seed: context.rng.getSeed(),
      duration: context.variables.elapsed_seconds,
      actionsPerformed: context.actions.length,
      crashesFound: context.crashes.length,
      crashes: context.crashes.map(c => ({
        crashNumber: c.crashNumber,
        timestamp: c.timestamp.toISOString(),
        crashType: c.crashType,
        bundleId: c.bundleId,
        stepsToReproduce: c.actionsBefore.map(a => ({
          action: a.type,
          target: a.target,
          params: a.params,
        })),
        evidenceDir: c.evidenceDir,
      })),
      actionsSummary: summarizeActions(context.actions),
    };

    await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2));

    // HTML report
    const html = generateHtmlReport(context);
    await writeFile(htmlPath, html);

    logger.debug(`${LOG_CONTEXT} Reports generated: ${htmlPath}, ${jsonPath}`);
  } catch (e) {
    logger.warn(`${LOG_CONTEXT} Failed to generate reports: ${e}`);
  }
}

/**
 * Summarize actions for the report
 */
function summarizeActions(actions: RecordedAction[]): Record<string, number> {
  const summary: Record<string, number> = {
    total: actions.length,
    tap: 0,
    scroll: 0,
    swipe: 0,
    back: 0,
    successful: 0,
    failed: 0,
  };

  for (const action of actions) {
    summary[action.type]++;
    if (action.success) {
      summary.successful++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}

/**
 * Generate HTML crash hunt report
 */
function generateHtmlReport(context: ExecutionContext): string {
  const crashRows = context.crashes
    .map((c) => {
      const steps = c.actionsBefore
        .map((a, i) => `${i + 1}. ${a.type}${a.target ? ` on ${a.target.type}` : ''}`)
        .join('<br>');
      return `
        <tr class="crash-row">
          <td>#${c.crashNumber}</td>
          <td>${c.timestamp.toISOString()}</td>
          <td>${c.crashType || 'Unknown'}</td>
          <td><small>${steps}</small></td>
          <td>
            ${c.screenshotPath ? `<a href="${c.screenshotPath}">Screenshot</a>` : '-'}
          </td>
        </tr>
      `;
    })
    .join('');

  const statusColor = context.crashes.length === 0 ? '#28a745' : '#dc3545';
  const statusText = context.crashes.length === 0
    ? 'No Crashes Found'
    : `${context.crashes.length} Crash${context.crashes.length > 1 ? 'es' : ''} Found`;

  return `<!DOCTYPE html>
<html>
<head>
  <title>iOS Crash Hunt Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 5px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .summary { display: flex; gap: 20px; margin-bottom: 30px; flex-wrap: wrap; }
    .summary-card { padding: 20px; border-radius: 8px; flex: 1; min-width: 150px; text-align: center; }
    .summary-card.status { background: ${statusColor}; color: white; }
    .summary-card.info { background: #f8f9fa; border: 1px solid #dee2e6; }
    .summary-card h2 { margin: 0 0 5px 0; font-size: 24px; }
    .summary-card p { margin: 0; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #dee2e6; }
    th { background: #f8f9fa; font-weight: 600; }
    tr.crash-row { background: #fff5f5; }
    tr:hover { background: #f0f0f0; }
    .footer { margin-top: 30px; text-align: center; color: #999; font-size: 12px; }
    .seed-info { font-family: monospace; background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>iOS Crash Hunt Report</h1>
    <p class="subtitle">
      Generated: ${new Date().toISOString()} |
      Simulator: ${context.simulator.name} (iOS ${context.simulator.iosVersion}) |
      Seed: <span class="seed-info">${context.rng.getSeed()}</span>
    </p>

    <div class="summary">
      <div class="summary-card status">
        <h2>${statusText}</h2>
        <p>${context.variables.elapsed_seconds}s hunt</p>
      </div>
      <div class="summary-card info">
        <h2>${context.actions.length}</h2>
        <p>Actions</p>
      </div>
      <div class="summary-card info">
        <h2>${summarizeActions(context.actions).tap}</h2>
        <p>Taps</p>
      </div>
      <div class="summary-card info">
        <h2>${summarizeActions(context.actions).scroll + summarizeActions(context.actions).swipe}</h2>
        <p>Scrolls/Swipes</p>
      </div>
    </div>

    ${context.crashes.length > 0 ? `
    <h2>Crashes Detected</h2>
    <table>
      <thead>
        <tr>
          <th>Crash #</th>
          <th>Time</th>
          <th>Type</th>
          <th>Steps to Reproduce</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        ${crashRows}
      </tbody>
    </table>
    ` : `
    <div style="text-align: center; padding: 40px; background: #f5fff5; border-radius: 8px;">
      <h2 style="color: #28a745; margin: 0;">No crashes detected during this hunt.</h2>
      <p style="color: #666; margin: 10px 0 0 0;">The app remained stable through ${context.actions.length} interactions over ${context.variables.elapsed_seconds} seconds.</p>
    </div>
    `}

    <p class="footer">
      Generated by Maestro iOS Crash Hunt Playbook |
      Re-run with seed <span class="seed-info">${context.rng.getSeed()}</span> to reproduce
    </p>
  </div>
</body>
</html>`;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Perform the build step
 */
async function performBuild(
  options: CrashHuntOptions,
  context: ExecutionContext
): Promise<IOSResult<BuildResult>> {
  const projectPath = options.inputs.project_path!;
  const scheme = options.inputs.scheme!;
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
 * Validate playbook inputs
 */
function validateInputs(
  inputs: CrashHuntInputs,
  inputDefs?: Record<string, PlaybookInputDef>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required inputs - need either app_path or project_path+scheme
  if (!inputs.app_path && !inputs.project_path) {
    // Also check for bundle_id as a fallback
    if (!inputs.bundle_id) {
      errors.push('Either app_path, project_path, or bundle_id is required');
    }
  }

  if (inputs.project_path && !inputs.scheme) {
    errors.push('scheme is required when project_path is provided');
  }

  // Validate duration
  if (inputs.duration !== undefined && (inputs.duration < 1 || inputs.duration > 86400)) {
    errors.push('duration must be between 1 and 86400 seconds');
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
 * Report progress
 */
function reportProgress(context: ExecutionContext, update: CrashHuntProgress): void {
  logger.debug(`${LOG_CONTEXT} Progress: ${update.phase} - ${update.message}`);
  context.onProgress?.(update);
}

/**
 * Create dry run result
 */
function createDryRunResult(
  options: CrashHuntOptions,
  playbook: IOSPlaybookConfig,
  simulator: { udid: string; name: string; iosVersion: string },
  artifactsDir: string,
  startTime: Date,
  variables: PlaybookVariables,
  seed: number
): CrashHuntResult {
  const endTime = new Date();
  return {
    completed: false,
    crashesFound: 0,
    totalDuration: 0,
    actionsPerformed: 0,
    startTime,
    endTime,
    crashes: [],
    actions: [],
    playbook: {
      name: playbook.name,
      version: playbook.version,
      path: options.playbookPath,
    },
    simulator,
    artifactsDir,
    terminationReason: 'duration_reached',
    seed,
    finalVariables: variables,
  };
}

/**
 * Create error result
 */
function createErrorResult(
  options: CrashHuntOptions,
  playbook: IOSPlaybookConfig,
  context: ExecutionContext,
  error: string,
  startTime: Date,
  seed: number
): IOSResult<CrashHuntResult> {
  const endTime = new Date();
  return {
    success: true,
    data: {
      completed: false,
      crashesFound: context.crashes.length,
      totalDuration: Math.floor((endTime.getTime() - startTime.getTime()) / 1000),
      actionsPerformed: context.actions.length,
      startTime,
      endTime,
      crashes: context.crashes,
      actions: context.actions,
      playbook: {
        name: playbook.name,
        version: playbook.version,
        path: options.playbookPath,
      },
      simulator: context.simulator,
      appPath: context.appPath,
      bundleId: context.bundleId,
      artifactsDir: context.artifactsDir,
      terminationReason: 'error',
      seed,
      error,
      finalVariables: context.variables,
    },
  };
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
export function formatCrashHuntResult(result: CrashHuntResult): string {
  const lines: string[] = [];

  const statusEmoji = result.crashesFound === 0 ? '✅' : '🔴';
  lines.push(`## ${statusEmoji} Crash Hunt ${result.crashesFound === 0 ? 'Clean' : `Found ${result.crashesFound} Crash${result.crashesFound > 1 ? 'es' : ''}`}`);
  lines.push('');

  // Summary table
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Duration | ${result.totalDuration}s |`);
  lines.push(`| Actions | ${result.actionsPerformed} |`);
  lines.push(`| Crashes | ${result.crashesFound} |`);
  lines.push(`| Simulator | ${result.simulator.name} |`);
  lines.push(`| Seed | \`${result.seed}\` |`);
  lines.push('');

  // Crashes
  if (result.crashes.length > 0) {
    lines.push('### Crashes Detected');
    lines.push('');

    for (const crash of result.crashes) {
      lines.push(`#### Crash #${crash.crashNumber}`);
      lines.push(`- **Time**: ${crash.timestamp.toISOString()}`);
      lines.push(`- **Type**: ${crash.crashType || 'Unknown'}`);
      lines.push('');
      lines.push('**Steps to Reproduce:**');
      for (let i = 0; i < crash.actionsBefore.length; i++) {
        const action = crash.actionsBefore[i];
        lines.push(`${i + 1}. ${action.type}${action.target ? ` on ${action.target.type}` : ''}`);
      }
      lines.push('');
    }
  }

  // Reports
  if (result.htmlReportPath || result.jsonReportPath) {
    lines.push('### Reports');
    lines.push('');
    if (result.htmlReportPath) {
      lines.push(`- HTML: \`${result.htmlReportPath}\``);
    }
    if (result.jsonReportPath) {
      lines.push(`- JSON: \`${result.jsonReportPath}\``);
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
export function formatCrashHuntResultAsJson(result: CrashHuntResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format result in compact form
 */
export function formatCrashHuntResultCompact(result: CrashHuntResult): string {
  const status = result.crashesFound === 0 ? 'CLEAN' : 'CRASH';
  return `[${status}] ${result.totalDuration}s, ${result.actionsPerformed} actions, ${result.crashesFound} crashes (seed: ${result.seed})`;
}
