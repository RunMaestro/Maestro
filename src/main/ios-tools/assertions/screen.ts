/**
 * iOS Assertion - Assert Screen
 *
 * Compound assertion that verifies a "screen" state by checking multiple conditions.
 * Allows defining screens with required visible elements, not-visible elements, and
 * optional additional state checks.
 */

import path from 'path';
import { IOSResult } from '../types';
import { getBootedSimulators, getSimulator } from '../simulator';
import { screenshot } from '../capture';
import { inspect, UIElement } from '../inspect-simple';
import { findByIdentifier, findByLabel, findByText, findElement, ElementQuery } from '../ui-analyzer';
import { getSnapshotDirectory } from '../artifacts';
import {
  AssertionBaseOptions,
  VerificationResult,
  pollUntil,
  generateVerificationId,
  createPassedResult,
  createFailedResult,
  createTimeoutResult,
  mergePollingOptions,
} from '../verification';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[iOS-Assert-Screen]';

// =============================================================================
// Types
// =============================================================================

/**
 * Element specification for screen definition
 */
export interface ElementSpec {
  /** Accessibility identifier */
  identifier?: string;
  /** Accessibility label */
  label?: string;
  /** Text content */
  text?: string;
  /** Element type */
  type?: string;
  /** Custom query */
  query?: ElementQuery;
}

/**
 * Screen definition - what makes up a "screen"
 */
export interface ScreenDefinition {
  /** Unique name for the screen */
  name: string;
  /** Optional description */
  description?: string;
  /** Elements that must be visible for this screen */
  elements: ElementSpec[];
  /** Elements that must NOT be visible for this screen */
  notVisible?: ElementSpec[];
  /** Elements that must be enabled */
  enabled?: ElementSpec[];
  /** Elements that must be disabled */
  disabled?: ElementSpec[];
}

/**
 * Options for assertScreen
 */
export interface AssertScreenOptions extends AssertionBaseOptions {
  /** Screen definition to verify */
  screen: ScreenDefinition;
  /** App bundle ID (optional, for context) */
  bundleId?: string;
  /** Whether to require all elements (default: true), false means at least one from each category */
  requireAll?: boolean;
}

/**
 * Result of checking a single element condition
 */
export interface ElementCheckResult {
  /** The element specification checked */
  spec: ElementSpec;
  /** Whether the check passed */
  passed: boolean;
  /** The element if found */
  element?: UIElement;
  /** Reason for failure */
  reason?: string;
  /** Type of check (visible, notVisible, enabled, disabled) */
  checkType: 'visible' | 'notVisible' | 'enabled' | 'disabled';
}

/**
 * Data specific to screen assertion results
 */
export interface ScreenAssertionData {
  /** Screen name that was checked */
  screenName: string;
  /** Screen description */
  screenDescription?: string;
  /** Results for each element check */
  elementChecks: ElementCheckResult[];
  /** Total elements checked */
  totalChecks: number;
  /** Checks that passed */
  passedChecks: number;
  /** Checks that failed */
  failedChecks: number;
  /** Total elements scanned in UI tree */
  totalElementsScanned?: number;
  /** Summary of the screen state */
  summary: string;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Assert that a screen matches its definition.
 * Checks multiple conditions: visible elements, not-visible elements, enabled/disabled states.
 *
 * @param options - Assertion options
 * @returns Verification result indicating pass/fail
 */
export async function assertScreen(
  options: AssertScreenOptions
): Promise<IOSResult<VerificationResult<ScreenAssertionData>>> {
  const {
    udid: providedUdid,
    sessionId,
    assertionId: providedId,
    screen,
    polling,
    captureOnFailure = true,
    captureOnSuccess = false,
    requireAll = true,
  } = options;

  const assertionId = providedId || generateVerificationId('screen');
  const pollingOpts = mergePollingOptions(polling);
  const startTime = new Date();

  logger.info(`${LOG_CONTEXT} Asserting screen: ${screen.name} (session: ${sessionId})`);

  // Get simulator
  let udid = providedUdid;
  if (!udid) {
    const bootedResult = await getBootedSimulators();
    if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
      return {
        success: false,
        error: 'No booted simulator found. Please specify --simulator or boot a simulator.',
        errorCode: 'SIMULATOR_NOT_BOOTED',
      };
    }
    udid = bootedResult.data[0].udid;
    logger.info(`${LOG_CONTEXT} Using first booted simulator: ${udid}`);
  }

  const simResult = await getSimulator(udid);
  if (!simResult.success || !simResult.data) {
    return {
      success: false,
      error: simResult.error || 'Failed to get simulator info',
      errorCode: simResult.errorCode || 'SIMULATOR_NOT_FOUND',
    };
  }

  if (simResult.data.state !== 'Booted') {
    return {
      success: false,
      error: `Simulator is not booted (state: ${simResult.data.state})`,
      errorCode: 'SIMULATOR_NOT_BOOTED',
    };
  }

  const simulatorInfo = {
    udid,
    name: simResult.data.name,
    iosVersion: simResult.data.iosVersion,
  };

  // Create artifact directory
  let artifactDir: string;
  try {
    artifactDir = await getSnapshotDirectory(sessionId, assertionId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to create artifact directory: ${error}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Polling check function
  const checkScreen = async (): Promise<{
    passed: boolean;
    error?: string;
    data?: ScreenAssertionData;
  }> => {
    // Capture current UI state
    const inspectResult = await inspect({
      udid,
      sessionId,
      captureScreenshot: false,
      snapshotId: `${assertionId}-inspect-${Date.now()}`,
    });

    if (!inspectResult.success || !inspectResult.data) {
      return {
        passed: false,
        error: inspectResult.error || 'Failed to inspect UI',
      };
    }

    const tree = inspectResult.data.tree;
    const totalElements = inspectResult.data.stats.totalElements;

    // Check all conditions
    const elementChecks: ElementCheckResult[] = [];

    // Check visible elements
    for (const spec of screen.elements) {
      const result = checkElementVisible(tree, spec, true);
      elementChecks.push(result);
    }

    // Check not-visible elements
    if (screen.notVisible) {
      for (const spec of screen.notVisible) {
        const result = checkElementVisible(tree, spec, false);
        elementChecks.push(result);
      }
    }

    // Check enabled elements
    if (screen.enabled) {
      for (const spec of screen.enabled) {
        const result = checkElementEnabled(tree, spec, true);
        elementChecks.push(result);
      }
    }

    // Check disabled elements
    if (screen.disabled) {
      for (const spec of screen.disabled) {
        const result = checkElementEnabled(tree, spec, false);
        elementChecks.push(result);
      }
    }

    // Aggregate results
    const passedChecks = elementChecks.filter((c) => c.passed).length;
    const failedChecks = elementChecks.filter((c) => !c.passed).length;
    const totalChecks = elementChecks.length;

    // Determine if screen assertion passed
    let passed: boolean;
    if (requireAll) {
      passed = failedChecks === 0;
    } else {
      // At least one from each category must pass
      const visiblePassed = elementChecks.filter((c) => c.checkType === 'visible' && c.passed).length > 0;
      const notVisiblePassed = !screen.notVisible || elementChecks.filter((c) => c.checkType === 'notVisible' && c.passed).length > 0;
      const enabledPassed = !screen.enabled || elementChecks.filter((c) => c.checkType === 'enabled' && c.passed).length > 0;
      const disabledPassed = !screen.disabled || elementChecks.filter((c) => c.checkType === 'disabled' && c.passed).length > 0;
      passed = visiblePassed && notVisiblePassed && enabledPassed && disabledPassed;
    }

    // Build summary
    const failedElements = elementChecks.filter((c) => !c.passed);
    const summary = passed
      ? `Screen "${screen.name}" verified: ${passedChecks}/${totalChecks} checks passed`
      : `Screen "${screen.name}" failed: ${failedElements.map((e) => describeSpec(e.spec)).join(', ')}`;

    const data: ScreenAssertionData = {
      screenName: screen.name,
      screenDescription: screen.description,
      elementChecks,
      totalChecks,
      passedChecks,
      failedChecks,
      totalElementsScanned: totalElements,
      summary,
    };

    if (!passed) {
      // Build a helpful error message
      const failureReasons = failedElements.map((e) => `${describeSpec(e.spec)}: ${e.reason}`).join('; ');
      return {
        passed: false,
        error: failureReasons,
        data,
      };
    }

    return {
      passed: true,
      data,
    };
  };

  // Poll for the condition
  pollingOpts.description = `screen "${screen.name}"`;
  const pollResult = await pollUntil<ScreenAssertionData>(checkScreen, pollingOpts);

  if (!pollResult.success) {
    return {
      success: false,
      error: pollResult.error || 'Polling failed',
      errorCode: pollResult.errorCode || 'COMMAND_FAILED',
    };
  }

  const { passed, attempts, lastData } = pollResult.data!;

  // Prepare artifacts
  const artifacts: { screenshots?: string[] } = {};

  // Capture screenshot based on result and options
  if ((passed && captureOnSuccess) || (!passed && captureOnFailure)) {
    const screenshotPath = path.join(artifactDir, passed ? 'success.png' : 'failure.png');
    const screenshotResult = await screenshot({ udid, outputPath: screenshotPath });

    if (screenshotResult.success) {
      artifacts.screenshots = [screenshotPath];
    }
  }

  // Build result
  const resultParams = {
    id: assertionId,
    type: 'screen',
    target: screen.name,
    startTime,
    attempts,
    simulator: simulatorInfo,
    artifacts,
    data: lastData,
  };

  if (passed) {
    logger.info(`${LOG_CONTEXT} Assertion passed: screen "${screen.name}" verified`);
    return {
      success: true,
      data: createPassedResult({
        ...resultParams,
        message: lastData?.summary || `Screen "${screen.name}" verified`,
      }),
    };
  }

  // Check if it was a timeout or actual failure
  const wasTimeout = pollResult.data!.duration >= pollingOpts.timeout;
  const lastAttempt = attempts[attempts.length - 1];

  if (wasTimeout) {
    logger.warn(`${LOG_CONTEXT} Assertion timeout: screen "${screen.name}" not verified after ${pollingOpts.timeout}ms`);
    return {
      success: true,
      data: createTimeoutResult({
        ...resultParams,
        timeout: pollingOpts.timeout,
      }),
    };
  }

  logger.warn(`${LOG_CONTEXT} Assertion failed: screen "${screen.name}" - ${lastAttempt?.error || 'conditions not met'}`);
  return {
    success: true,
    data: createFailedResult({
      ...resultParams,
      message: lastData?.summary || `Screen "${screen.name}" not verified`,
    }),
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if an element is visible (or not visible if expectVisible is false)
 */
function checkElementVisible(tree: UIElement, spec: ElementSpec, expectVisible: boolean): ElementCheckResult {
  const element = findElementBySpec(tree, spec);

  if (expectVisible) {
    if (!element) {
      return {
        spec,
        passed: false,
        reason: 'Element not found',
        checkType: 'visible',
      };
    }

    if (!element.visible) {
      return {
        spec,
        passed: false,
        element,
        reason: 'Element exists but is not visible',
        checkType: 'visible',
      };
    }

    return {
      spec,
      passed: true,
      element,
      checkType: 'visible',
    };
  } else {
    // Expect NOT visible
    if (!element) {
      return {
        spec,
        passed: true,
        checkType: 'notVisible',
      };
    }

    if (!element.visible) {
      return {
        spec,
        passed: true,
        element,
        checkType: 'notVisible',
      };
    }

    return {
      spec,
      passed: false,
      element,
      reason: 'Element is visible when it should not be',
      checkType: 'notVisible',
    };
  }
}

/**
 * Check if an element is enabled (or disabled if expectEnabled is false)
 */
function checkElementEnabled(tree: UIElement, spec: ElementSpec, expectEnabled: boolean): ElementCheckResult {
  const element = findElementBySpec(tree, spec);

  if (!element) {
    return {
      spec,
      passed: false,
      reason: 'Element not found',
      checkType: expectEnabled ? 'enabled' : 'disabled',
    };
  }

  if (!element.visible) {
    return {
      spec,
      passed: false,
      element,
      reason: 'Element is not visible',
      checkType: expectEnabled ? 'enabled' : 'disabled',
    };
  }

  const isEnabled = element.enabled !== false; // Default to enabled if undefined

  if (expectEnabled) {
    if (!isEnabled) {
      return {
        spec,
        passed: false,
        element,
        reason: 'Element is disabled',
        checkType: 'enabled',
      };
    }

    return {
      spec,
      passed: true,
      element,
      checkType: 'enabled',
    };
  } else {
    // Expect disabled
    if (isEnabled) {
      return {
        spec,
        passed: false,
        element,
        reason: 'Element is enabled when it should be disabled',
        checkType: 'disabled',
      };
    }

    return {
      spec,
      passed: true,
      element,
      checkType: 'disabled',
    };
  }
}

/**
 * Find an element by specification
 */
function findElementBySpec(tree: UIElement, spec: ElementSpec): UIElement | undefined {
  if (spec.identifier) {
    return findByIdentifier(tree, spec.identifier) ?? undefined;
  }

  if (spec.label) {
    return findByLabel(tree, spec.label) ?? undefined;
  }

  if (spec.text) {
    const result = findByText(tree, spec.text);
    return result.elements.length > 0 ? result.elements[0] : undefined;
  }

  if (spec.type) {
    return findElement(tree, { type: spec.type }) ?? undefined;
  }

  if (spec.query) {
    return findElement(tree, spec.query) ?? undefined;
  }

  return undefined;
}

/**
 * Create a human-readable description of an element spec
 */
function describeSpec(spec: ElementSpec): string {
  if (spec.identifier) {
    return `#${spec.identifier}`;
  }
  if (spec.label) {
    return `label="${spec.label}"`;
  }
  if (spec.text) {
    return `text="${spec.text}"`;
  }
  if (spec.type) {
    return `type=${spec.type}`;
  }
  if (spec.query) {
    return 'custom query';
  }
  return 'unknown element';
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Assert a screen using a pre-defined screen registry lookup.
 */
export async function assertScreenByName(
  screenName: string,
  screenRegistry: Record<string, ScreenDefinition>,
  options: Omit<AssertScreenOptions, 'screen'>
): Promise<IOSResult<VerificationResult<ScreenAssertionData>>> {
  const screen = screenRegistry[screenName];
  if (!screen) {
    return {
      success: false,
      error: `Screen "${screenName}" not found in registry. Available screens: ${Object.keys(screenRegistry).join(', ')}`,
      errorCode: 'INVALID_ARGUMENT',
    };
  }

  return assertScreen({
    ...options,
    screen,
  });
}

/**
 * Create a simple screen definition with just visible elements.
 */
export function createScreenDefinition(
  name: string,
  elements: (string | ElementSpec)[],
  notVisible?: (string | ElementSpec)[]
): ScreenDefinition {
  const normalizeSpecs = (specs: (string | ElementSpec)[]): ElementSpec[] => {
    return specs.map((s) => {
      if (typeof s === 'string') {
        // If starts with #, treat as identifier; otherwise as text
        if (s.startsWith('#')) {
          return { identifier: s.slice(1) };
        }
        return { text: s };
      }
      return s;
    });
  };

  return {
    name,
    elements: normalizeSpecs(elements),
    notVisible: notVisible ? normalizeSpecs(notVisible) : undefined,
  };
}

/**
 * Parse a screen definition from YAML-style configuration.
 * Example:
 * ```yaml
 * name: login
 * elements:
 *   - "#email_field"
 *   - "#password_field"
 *   - "#login_button"
 * not_visible:
 *   - "#loading_spinner"
 * ```
 */
export function parseScreenDefinition(config: {
  name: string;
  description?: string;
  elements?: (string | Record<string, string>)[];
  not_visible?: (string | Record<string, string>)[];
  enabled?: (string | Record<string, string>)[];
  disabled?: (string | Record<string, string>)[];
}): ScreenDefinition {
  const parseSpecs = (items?: (string | Record<string, string>)[]): ElementSpec[] => {
    if (!items) return [];
    return items.map((item) => {
      if (typeof item === 'string') {
        if (item.startsWith('#')) {
          return { identifier: item.slice(1) };
        }
        if (item.startsWith('@')) {
          return { label: item.slice(1) };
        }
        return { text: item };
      }
      return item as ElementSpec;
    });
  };

  return {
    name: config.name,
    description: config.description,
    elements: parseSpecs(config.elements),
    notVisible: parseSpecs(config.not_visible),
    enabled: parseSpecs(config.enabled),
    disabled: parseSpecs(config.disabled),
  };
}
