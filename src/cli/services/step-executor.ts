/**
 * Step Executor - Execute parsed iOS steps via IPC handlers
 *
 * Provides execution of iOS assertion and action steps by invoking
 * the appropriate IPC handlers directly.
 */

import {
  IOSStep,
  StepResult,
  StepBatchResult,
  ElementTarget,
  AssertVisibleStep,
  AssertTextStep,
  AssertValueStep,
  AssertEnabledStep,
  AssertSelectedStep,
  AssertHittableStep,
  AssertLogContainsStep,
  AssertNoErrorsStep,
  AssertNoCrashStep,
  AssertScreenStep,
  WaitForStep,
  TapStep,
  TypeStep,
  ScrollStep,
  SwipeStep,
  SnapshotStep,
  InspectStep,
} from './step-types';
import * as iosTools from '../../main/ios-tools';
import type { IOSResult, VerificationResult } from '../../main/ios-tools';
import { logger } from '../../main/utils/logger';

// =============================================================================
// Types
// =============================================================================

/** Options for step execution */
export interface ExecutionOptions {
  /** Simulator UDID (auto-detected if not provided) */
  udid?: string;
  /** Default bundle ID for app assertions */
  bundleId?: string;
  /** Default timeout in milliseconds */
  timeout?: number;
  /** Session ID for artifact storage */
  sessionId?: string;
  /** Stop on first failure */
  stopOnFailure?: boolean;
  /** Capture screenshots on failure */
  captureOnFailure?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Main Executor
// =============================================================================

/**
 * Execute a single iOS step.
 *
 * @param step - The step to execute
 * @param options - Execution options
 * @returns StepResult with success/failure and details
 */
export async function executeStep(
  step: IOSStep,
  options: ExecutionOptions = {}
): Promise<StepResult> {
  const startTime = Date.now();

  // Get simulator UDID
  const udid = options.udid || await getDefaultSimulatorUdid();
  if (!udid) {
    return {
      success: false,
      step,
      durationMs: Date.now() - startTime,
      error: 'No booted simulator found',
      failureReason: 'SIMULATOR_NOT_FOUND',
      suggestions: ['Boot a simulator using `xcrun simctl boot <device>`'],
    };
  }

  try {
    const result = await executeStepInternal(step, { ...options, udid });
    return {
      success: result.success,
      step,
      durationMs: Date.now() - startTime,
      error: result.error,
      failureReason: result.failureReason,
      suggestions: result.suggestions,
      artifacts: result.artifacts,
      rawResult: result.rawResult,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      step,
      durationMs: Date.now() - startTime,
      error,
      failureReason: 'EXECUTION_ERROR',
    };
  }
}

/**
 * Execute multiple iOS steps.
 *
 * @param steps - The steps to execute
 * @param options - Execution options
 * @returns StepBatchResult with all results
 */
export async function executeSteps(
  steps: IOSStep[],
  options: ExecutionOptions = {}
): Promise<StepBatchResult> {
  const startTime = Date.now();
  const results: StepResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Get simulator UDID once for all steps
  const udid = options.udid || await getDefaultSimulatorUdid();
  if (!udid) {
    return {
      success: false,
      totalDurationMs: Date.now() - startTime,
      passed: 0,
      failed: steps.length,
      skipped: 0,
      results: steps.map(step => ({
        success: false,
        step,
        durationMs: 0,
        error: 'No booted simulator found',
        failureReason: 'SIMULATOR_NOT_FOUND',
      })),
    };
  }

  const execOptions = { ...options, udid };
  let shouldSkip = false;

  for (const step of steps) {
    if (shouldSkip) {
      results.push({
        success: false,
        step,
        durationMs: 0,
        error: 'Skipped due to previous failure',
        failureReason: 'SKIPPED',
      });
      skipped++;
      continue;
    }

    const result = await executeStep(step, execOptions);
    results.push(result);

    if (result.success) {
      passed++;
    } else {
      failed++;
      if (options.stopOnFailure) {
        shouldSkip = true;
      }
    }
  }

  return {
    success: failed === 0,
    totalDurationMs: Date.now() - startTime,
    passed,
    failed,
    skipped,
    results,
  };
}

// =============================================================================
// Internal Execution
// =============================================================================

interface InternalResult {
  success: boolean;
  error?: string;
  failureReason?: string;
  suggestions?: string[];
  artifacts?: {
    screenshot?: string;
    logs?: string;
  };
  rawResult?: unknown;
}

async function executeStepInternal(
  step: IOSStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  if (options.debug) {
    logger.debug(`[StepExecutor] Executing step: ${step.type}`);
  }

  switch (step.type) {
    case 'ios.assert_visible':
      return executeAssertVisible(step, options);
    case 'ios.assert_not_visible':
      return executeAssertNotVisible(step, options);
    case 'ios.assert_text':
      return executeAssertText(step, options);
    case 'ios.assert_value':
      return executeAssertValue(step, options);
    case 'ios.assert_enabled':
      return executeAssertEnabled(step, options);
    case 'ios.assert_disabled':
      return executeAssertDisabled(step, options);
    case 'ios.assert_selected':
      return executeAssertSelected(step, options);
    case 'ios.assert_not_selected':
      return executeAssertNotSelected(step, options);
    case 'ios.assert_hittable':
      return executeAssertHittable(step, options);
    case 'ios.assert_not_hittable':
      return executeAssertNotHittable(step, options);
    case 'ios.assert_log_contains':
      return executeAssertLogContains(step, options);
    case 'ios.assert_no_errors':
      return executeAssertNoErrors(step, options);
    case 'ios.assert_no_crash':
      return executeAssertNoCrash(step, options);
    case 'ios.assert_screen':
      return executeAssertScreen(step, options);
    case 'ios.wait_for':
      return executeWaitFor(step, options);
    case 'ios.tap':
      return executeTap(step, options);
    case 'ios.type':
      return executeType(step, options);
    case 'ios.scroll':
      return executeScroll(step, options);
    case 'ios.swipe':
      return executeSwipe(step, options);
    case 'ios.snapshot':
      return executeSnapshot(step, options);
    case 'ios.inspect':
      return executeInspect(step, options);
    default:
      return {
        success: false,
        error: `Unknown step type: ${(step as IOSStep).type}`,
        failureReason: 'UNKNOWN_STEP_TYPE',
      };
  }
}

// =============================================================================
// Step Executors
// =============================================================================

async function executeAssertVisible(
  step: AssertVisibleStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertVisible({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
    polling: step.timeout ? { timeout: step.timeout } : undefined,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertNotVisible(
  step: AssertVisibleStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertNotVisible({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
    polling: step.timeout ? { timeout: step.timeout } : undefined,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertText(
  step: AssertTextStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertText({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
    expected: step.expected,
    matchMode: step.matchMode || 'exact',
    caseSensitive: step.caseSensitive,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertValue(
  step: AssertValueStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertValue({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
    expected: step.expected,
    matchMode: step.matchMode || 'exact',
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertEnabled(
  step: AssertEnabledStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertEnabled({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertDisabled(
  step: AssertEnabledStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertDisabled({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertSelected(
  step: AssertSelectedStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertSelected({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertNotSelected(
  step: AssertSelectedStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertNotSelected({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertHittable(
  step: AssertHittableStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertHittable({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertNotHittable(
  step: AssertHittableStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const result = await iosTools.assertNotHittable({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertLogContains(
  step: AssertLogContainsStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  if (step.notContains) {
    const result = await iosTools.assertLogNotContains(step.pattern, {
      udid: options.udid,
      bundleId: step.bundleId || options.bundleId,
      sessionId: options.sessionId || 'step-executor',
      since: step.since ? new Date(step.since) : undefined,
      matchMode: step.matchMode,
      caseSensitive: step.caseSensitive,
    });
    return formatIOSVerificationResult(result);
  }

  const result = await iosTools.assertLogContains(step.pattern, {
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    since: step.since ? new Date(step.since) : undefined,
    matchMode: step.matchMode,
    caseSensitive: step.caseSensitive,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertNoErrors(
  step: AssertNoErrorsStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const result = await iosTools.assertNoErrors({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    since: step.since ? new Date(step.since) : undefined,
    patterns: step.patterns,
    ignorePatterns: step.ignorePatterns,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertNoCrash(
  step: AssertNoCrashStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const bundleId = step.bundleId || options.bundleId;
  if (!bundleId) {
    return {
      success: false,
      error: 'Bundle ID is required for ios.assert_no_crash',
      failureReason: 'MISSING_BUNDLE_ID',
    };
  }

  const result = await iosTools.assertNoCrash({
    udid: options.udid,
    bundleId,
    sessionId: options.sessionId || 'step-executor',
    since: step.since ? new Date(step.since) : undefined,
  });

  return formatIOSVerificationResult(result);
}

async function executeAssertScreen(
  step: AssertScreenStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  // Build screen definition from step
  const elements = step.elements?.map(normalizeTarget) || [];
  const notVisible = step.notVisible?.map(normalizeTarget);
  const enabled = step.enabled?.map(normalizeTarget);
  const disabled = step.disabled?.map(normalizeTarget);

  const result = await iosTools.assertScreen({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    screen: {
      name: step.screenName || 'screen',
      elements,
      notVisible,
      enabled,
      disabled,
    },
    polling: step.timeout ? { timeout: step.timeout } : undefined,
  });

  return formatIOSVerificationResult(result);
}

async function executeWaitFor(
  step: WaitForStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);

  if (step.not) {
    const result = await iosTools.waitForElementNot({
      udid: options.udid,
      bundleId: step.bundleId || options.bundleId,
      sessionId: options.sessionId || 'step-executor',
      target,
      polling: step.timeout ? { timeout: step.timeout } : undefined,
    });
    return formatIOSVerificationResult(result);
  }

  const result = await iosTools.waitForElement({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    target,
    polling: step.timeout ? { timeout: step.timeout } : undefined,
  });

  return formatIOSVerificationResult(result);
}

async function executeTap(
  step: TapStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const target = normalizeTarget(step.target);
  const bundleId = step.bundleId || options.bundleId;

  if (!bundleId) {
    return {
      success: false,
      error: 'Bundle ID is required for ios.tap',
      failureReason: 'MISSING_BUNDLE_ID',
    };
  }

  const driver = iosTools.createNativeDriver({
    bundleId,
    udid: options.udid,
    timeout: options.timeout,
  });

  const action = iosTools.nativeTap(target as iosTools.NativeActionTarget);
  const result = await driver.execute(action);

  return {
    success: result.success,
    error: result.error,
    rawResult: result,
  };
}

async function executeType(
  step: TypeStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const bundleId = step.bundleId || options.bundleId;

  if (!bundleId) {
    return {
      success: false,
      error: 'Bundle ID is required for ios.type',
      failureReason: 'MISSING_BUNDLE_ID',
    };
  }

  const driver = iosTools.createNativeDriver({
    bundleId,
    udid: options.udid,
    timeout: options.timeout,
  });

  const into = step.into ? normalizeTarget(step.into) : undefined;
  const action = iosTools.nativeTypeText(step.text, {
    target: into as iosTools.NativeActionTarget | undefined,
    clearFirst: step.clearFirst,
  });
  const result = await driver.execute(action);

  return {
    success: result.success,
    error: result.error,
    rawResult: result,
  };
}

async function executeScroll(
  step: ScrollStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const bundleId = step.bundleId || options.bundleId;

  if (!bundleId) {
    return {
      success: false,
      error: 'Bundle ID is required for ios.scroll',
      failureReason: 'MISSING_BUNDLE_ID',
    };
  }

  const driver = iosTools.createNativeDriver({
    bundleId,
    udid: options.udid,
    timeout: options.timeout,
  });

  let action: iosTools.NativeActionRequest;

  if (step.scrollTo) {
    const scrollToTarget = normalizeTarget(step.scrollTo);
    action = iosTools.nativeScrollTo(scrollToTarget as iosTools.NativeActionTarget, {
      direction: step.direction as iosTools.NativeSwipeDirection,
    });
  } else {
    const target = step.target ? normalizeTarget(step.target) : undefined;
    action = iosTools.nativeScroll(step.direction as iosTools.NativeSwipeDirection || 'down', {
      target: target as iosTools.NativeActionTarget | undefined,
    });
  }

  const result = await driver.execute(action);

  return {
    success: result.success,
    error: result.error,
    rawResult: result,
  };
}

async function executeSwipe(
  step: SwipeStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const bundleId = step.bundleId || options.bundleId;

  if (!bundleId) {
    return {
      success: false,
      error: 'Bundle ID is required for ios.swipe',
      failureReason: 'MISSING_BUNDLE_ID',
    };
  }

  const driver = iosTools.createNativeDriver({
    bundleId,
    udid: options.udid,
    timeout: options.timeout,
  });

  const target = step.target ? normalizeTarget(step.target) : undefined;
  const action = iosTools.nativeSwipe(step.direction as iosTools.NativeSwipeDirection, {
    target: target as iosTools.NativeActionTarget | undefined,
    velocity: step.velocity as iosTools.NativeSwipeVelocity | undefined,
  });
  const result = await driver.execute(action);

  return {
    success: result.success,
    error: result.error,
    rawResult: result,
  };
}

async function executeSnapshot(
  step: SnapshotStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const result = await iosTools.captureSnapshot({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
  });

  return {
    success: result.success,
    error: result.error,
    artifacts: result.data ? {
      screenshot: result.data.screenshot?.path,
    } : undefined,
    rawResult: result,
  };
}

async function executeInspect(
  step: InspectStep,
  options: ExecutionOptions & { udid: string }
): Promise<InternalResult> {
  const result = await iosTools.inspect({
    udid: options.udid,
    bundleId: step.bundleId || options.bundleId,
    sessionId: options.sessionId || 'step-executor',
    captureScreenshot: step.captureScreenshot,
  });

  return {
    success: result.success,
    error: result.error,
    artifacts: result.data?.screenshot ? {
      screenshot: result.data.screenshot.path,
    } : undefined,
    rawResult: result,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the UDID of the first booted simulator.
 */
async function getDefaultSimulatorUdid(): Promise<string | undefined> {
  const booted = await iosTools.getBootedSimulators();
  if (booted.success && booted.data && booted.data.length > 0) {
    return booted.data[0].udid;
  }
  return undefined;
}

/**
 * Normalize a target to an ElementTarget object.
 */
function normalizeTarget(target: ElementTarget | string): iosTools.ElementTarget {
  if (typeof target === 'string') {
    // Try to parse shorthand notations
    if (target.startsWith('#')) {
      return { identifier: target.slice(1) };
    }
    if (target.startsWith('@')) {
      return { label: target.slice(1) };
    }
    // Plain string is treated as text
    return { text: target };
  }

  // Already an object
  return target as iosTools.ElementTarget;
}

/**
 * Format an IOSResult<VerificationResult<T>> into an InternalResult.
 * Handles the double-wrapper pattern used by ios-tools assertions.
 */
function formatIOSVerificationResult<T>(result: IOSResult<VerificationResult<T>>): InternalResult {
  // First check if the outer IOSResult succeeded
  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Operation failed',
      failureReason: 'IOS_ERROR',
      rawResult: result,
    };
  }

  // Now check the inner VerificationResult
  const verification = result.data;
  if (!verification) {
    return {
      success: false,
      error: 'No verification data returned',
      failureReason: 'NO_DATA',
      rawResult: result,
    };
  }

  const passed = verification.status === 'passed';

  return {
    success: passed,
    error: passed ? undefined : verification.message,
    failureReason: passed ? undefined : verification.status.toUpperCase(),
    artifacts: verification.artifacts ? {
      screenshot: verification.artifacts.screenshots?.[0],
    } : undefined,
    rawResult: result,
  };
}

// =============================================================================
// Exports for Testing
// =============================================================================

export { normalizeTarget, formatIOSVerificationResult };
