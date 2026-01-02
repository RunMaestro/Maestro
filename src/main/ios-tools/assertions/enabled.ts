/**
 * iOS Assertion - Assert Enabled
 *
 * Verifies that a UI element is enabled and interactable.
 * Uses polling to wait for the element to become enabled within a timeout.
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

const LOG_CONTEXT = '[iOS-Assert-Enabled]';

// =============================================================================
// Types
// =============================================================================

/**
 * Ways to identify an element for enabled check
 */
export interface EnabledElementTarget {
  /** Accessibility identifier (preferred) */
  identifier?: string;
  /** Accessibility label text */
  label?: string;
  /** Text content (for StaticText elements) */
  text?: string;
  /** Element type (e.g., "Button", "TextField") */
  type?: string;
  /** Custom query for complex matching */
  query?: ElementQuery;
}

/**
 * Options for assertEnabled
 */
export interface AssertEnabledOptions extends AssertionBaseOptions {
  /** Target element to find */
  target: EnabledElementTarget;
  /** Whether to also require visibility (default: true) */
  requireVisible?: boolean;
  /** App bundle ID (optional, for context in logs) */
  bundleId?: string;
}

/**
 * Data specific to enabled assertion results
 */
export interface EnabledAssertionData {
  /** The element that was found (if any) */
  element?: UIElement;
  /** How the element was identified */
  matchedBy?: 'identifier' | 'label' | 'text' | 'type' | 'query';
  /** Whether visibility was required */
  visibilityRequired: boolean;
  /** Whether element was visible (if found) */
  wasVisible?: boolean;
  /** Whether element was enabled (if found) */
  wasEnabled?: boolean;
  /** Total elements scanned */
  totalElementsScanned?: number;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Assert that an element is enabled and interactable.
 *
 * @param options - Assertion options
 * @returns Verification result indicating pass/fail
 */
export async function assertEnabled(
  options: AssertEnabledOptions
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  const {
    udid: providedUdid,
    sessionId,
    assertionId: providedId,
    target,
    polling,
    captureOnFailure = true,
    captureOnSuccess = false,
    requireVisible = true,
  } = options;

  const assertionId = providedId || generateVerificationId('enabled');
  const pollingOpts = mergePollingOptions(polling);
  const startTime = new Date();
  const targetDescription = describeTarget(target);

  logger.info(`${LOG_CONTEXT} Asserting enabled: ${targetDescription} (session: ${sessionId})`);

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
  const checkEnabled = async (): Promise<{
    passed: boolean;
    error?: string;
    data?: EnabledAssertionData;
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

    // Try to find the element
    const findResult = findTargetElement(tree, target);

    if (!findResult.element) {
      return {
        passed: false,
        error: `Element not found: ${targetDescription}`,
        data: {
          visibilityRequired: requireVisible,
          totalElementsScanned: totalElements,
        },
      };
    }

    const element = findResult.element;

    // Check visibility if required
    if (requireVisible && !element.visible) {
      return {
        passed: false,
        error: `Element found but not visible: ${targetDescription}`,
        data: {
          element,
          matchedBy: findResult.matchedBy,
          visibilityRequired: requireVisible,
          wasVisible: element.visible,
          wasEnabled: element.enabled,
          totalElementsScanned: totalElements,
        },
      };
    }

    // Check enabled state
    if (!element.enabled) {
      return {
        passed: false,
        error: `Element found but not enabled: ${targetDescription}`,
        data: {
          element,
          matchedBy: findResult.matchedBy,
          visibilityRequired: requireVisible,
          wasVisible: element.visible,
          wasEnabled: element.enabled,
          totalElementsScanned: totalElements,
        },
      };
    }

    // Success!
    return {
      passed: true,
      data: {
        element,
        matchedBy: findResult.matchedBy,
        visibilityRequired: requireVisible,
        wasVisible: element.visible,
        wasEnabled: element.enabled,
        totalElementsScanned: totalElements,
      },
    };
  };

  // Poll for the condition
  pollingOpts.description = `enabled state of ${targetDescription}`;
  const pollResult = await pollUntil<EnabledAssertionData>(checkEnabled, pollingOpts);

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
    type: 'enabled',
    target: targetDescription,
    startTime,
    attempts,
    simulator: simulatorInfo,
    artifacts,
    data: lastData,
  };

  if (passed) {
    logger.info(`${LOG_CONTEXT} Assertion passed: ${targetDescription} is enabled`);
    return {
      success: true,
      data: createPassedResult({
        ...resultParams,
        message: `Element "${targetDescription}" is enabled${requireVisible ? ' and visible' : ''}`,
      }),
    };
  }

  // Check if it was a timeout or actual failure
  const lastAttempt = attempts[attempts.length - 1];
  const wasTimeout = pollResult.data!.duration >= pollingOpts.timeout;

  if (wasTimeout) {
    logger.warn(`${LOG_CONTEXT} Assertion timeout: ${targetDescription} not enabled after ${pollingOpts.timeout}ms`);
    return {
      success: true,
      data: createTimeoutResult({
        ...resultParams,
        timeout: pollingOpts.timeout,
      }),
    };
  }

  logger.warn(`${LOG_CONTEXT} Assertion failed: ${targetDescription} - ${lastAttempt?.error || 'not enabled'}`);
  return {
    success: true,
    data: createFailedResult({
      ...resultParams,
      message: lastAttempt?.error || `Element "${targetDescription}" not enabled`,
    }),
  };
}

// =============================================================================
// Assert Disabled
// =============================================================================

/**
 * Assert that an element is disabled (not enabled).
 *
 * @param options - Assertion options
 * @returns Verification result indicating pass/fail
 */
export async function assertDisabled(
  options: AssertEnabledOptions
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  const {
    udid: providedUdid,
    sessionId,
    assertionId: providedId,
    target,
    polling,
    captureOnFailure = true,
    captureOnSuccess = false,
    requireVisible = true,
  } = options;

  const assertionId = providedId || generateVerificationId('disabled');
  const pollingOpts = mergePollingOptions(polling);
  const startTime = new Date();
  const targetDescription = describeTarget(target);

  logger.info(`${LOG_CONTEXT} Asserting disabled: ${targetDescription} (session: ${sessionId})`);

  // Get simulator
  let udid = providedUdid;
  if (!udid) {
    const bootedResult = await getBootedSimulators();
    if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
      return {
        success: false,
        error: 'No booted simulator found.',
        errorCode: 'SIMULATOR_NOT_BOOTED',
      };
    }
    udid = bootedResult.data[0].udid;
  }

  const simResult = await getSimulator(udid);
  if (!simResult.success || !simResult.data || simResult.data.state !== 'Booted') {
    return {
      success: false,
      error: simResult.error || 'Simulator not available',
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

  // Polling check function - passes when element is NOT enabled (but must exist)
  const checkDisabled = async (): Promise<{
    passed: boolean;
    error?: string;
    data?: EnabledAssertionData;
  }> => {
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
    const findResult = findTargetElement(tree, target);

    if (!findResult.element) {
      return {
        passed: false,
        error: `Element not found: ${targetDescription}`,
        data: {
          visibilityRequired: requireVisible,
          totalElementsScanned: totalElements,
        },
      };
    }

    const element = findResult.element;

    // Check visibility if required
    if (requireVisible && !element.visible) {
      return {
        passed: false,
        error: `Element found but not visible: ${targetDescription}`,
        data: {
          element,
          matchedBy: findResult.matchedBy,
          visibilityRequired: requireVisible,
          wasVisible: element.visible,
          wasEnabled: element.enabled,
          totalElementsScanned: totalElements,
        },
      };
    }

    // Check disabled state (opposite of enabled)
    if (element.enabled) {
      return {
        passed: false,
        error: `Element is still enabled: ${targetDescription}`,
        data: {
          element,
          matchedBy: findResult.matchedBy,
          visibilityRequired: requireVisible,
          wasVisible: element.visible,
          wasEnabled: element.enabled,
          totalElementsScanned: totalElements,
        },
      };
    }

    // Element is disabled = passes
    return {
      passed: true,
      data: {
        element,
        matchedBy: findResult.matchedBy,
        visibilityRequired: requireVisible,
        wasVisible: element.visible,
        wasEnabled: element.enabled,
        totalElementsScanned: totalElements,
      },
    };
  };

  pollingOpts.description = `disabled state of ${targetDescription}`;
  const pollResult = await pollUntil<EnabledAssertionData>(checkDisabled, pollingOpts);

  if (!pollResult.success) {
    return {
      success: false,
      error: pollResult.error || 'Polling failed',
      errorCode: pollResult.errorCode || 'COMMAND_FAILED',
    };
  }

  const { passed, attempts, lastData } = pollResult.data!;
  const artifacts: { screenshots?: string[] } = {};

  if ((passed && captureOnSuccess) || (!passed && captureOnFailure)) {
    const screenshotPath = path.join(artifactDir, passed ? 'success.png' : 'failure.png');
    const screenshotResult = await screenshot({ udid, outputPath: screenshotPath });

    if (screenshotResult.success) {
      artifacts.screenshots = [screenshotPath];
    }
  }

  const resultParams = {
    id: assertionId,
    type: 'disabled',
    target: targetDescription,
    startTime,
    attempts,
    simulator: simulatorInfo,
    artifacts,
    data: lastData,
  };

  if (passed) {
    logger.info(`${LOG_CONTEXT} Assertion passed: ${targetDescription} is disabled`);
    return {
      success: true,
      data: createPassedResult({
        ...resultParams,
        message: `Element "${targetDescription}" is disabled`,
      }),
    };
  }

  const wasTimeout = pollResult.data!.duration >= pollingOpts.timeout;

  if (wasTimeout) {
    logger.warn(`${LOG_CONTEXT} Assertion timeout: ${targetDescription} still enabled after ${pollingOpts.timeout}ms`);
    return {
      success: true,
      data: createTimeoutResult({
        ...resultParams,
        timeout: pollingOpts.timeout,
      }),
    };
  }

  const lastAttempt = attempts[attempts.length - 1];
  logger.warn(`${LOG_CONTEXT} Assertion failed: ${targetDescription} is still enabled`);
  return {
    success: true,
    data: createFailedResult({
      ...resultParams,
      message: lastAttempt?.error || `Element "${targetDescription}" is still enabled`,
    }),
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Find an element matching the target specification.
 */
function findTargetElement(
  tree: UIElement,
  target: EnabledElementTarget
): { element: UIElement | undefined; matchedBy?: 'identifier' | 'label' | 'text' | 'type' | 'query' } {
  // Priority order: identifier > label > text > type > query

  if (target.identifier) {
    const element = findByIdentifier(tree, target.identifier);
    if (element) {
      return { element, matchedBy: 'identifier' };
    }
  }

  if (target.label) {
    const element = findByLabel(tree, target.label);
    if (element) {
      return { element, matchedBy: 'label' };
    }
  }

  if (target.text) {
    const result = findByText(tree, target.text);
    if (result.elements.length > 0) {
      return { element: result.elements[0], matchedBy: 'text' };
    }
  }

  if (target.type) {
    const element = findElement(tree, { type: target.type });
    if (element) {
      return { element, matchedBy: 'type' };
    }
  }

  if (target.query) {
    const element = findElement(tree, target.query);
    if (element) {
      return { element, matchedBy: 'query' };
    }
  }

  return { element: undefined };
}

/**
 * Create a human-readable description of the target.
 */
function describeTarget(target: EnabledElementTarget): string {
  const parts: string[] = [];

  if (target.identifier) {
    parts.push(`identifier="${target.identifier}"`);
  }
  if (target.label) {
    parts.push(`label="${target.label}"`);
  }
  if (target.text) {
    parts.push(`text="${target.text}"`);
  }
  if (target.type) {
    parts.push(`type=${target.type}`);
  }
  if (target.query) {
    parts.push('custom query');
  }

  return parts.join(', ') || 'unknown element';
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Assert element with identifier is enabled.
 */
export async function assertEnabledById(
  identifier: string,
  options: Omit<AssertEnabledOptions, 'target'>
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  return assertEnabled({
    ...options,
    target: { identifier },
  });
}

/**
 * Assert element with label is enabled.
 */
export async function assertEnabledByLabel(
  label: string,
  options: Omit<AssertEnabledOptions, 'target'>
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  return assertEnabled({
    ...options,
    target: { label },
  });
}

/**
 * Assert element with text content is enabled.
 */
export async function assertEnabledByText(
  text: string,
  options: Omit<AssertEnabledOptions, 'target'>
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  return assertEnabled({
    ...options,
    target: { text },
  });
}

/**
 * Assert element with identifier is disabled.
 */
export async function assertDisabledById(
  identifier: string,
  options: Omit<AssertEnabledOptions, 'target'>
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  return assertDisabled({
    ...options,
    target: { identifier },
  });
}

/**
 * Assert element with label is disabled.
 */
export async function assertDisabledByLabel(
  label: string,
  options: Omit<AssertEnabledOptions, 'target'>
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  return assertDisabled({
    ...options,
    target: { label },
  });
}

/**
 * Assert element with text content is disabled.
 */
export async function assertDisabledByText(
  text: string,
  options: Omit<AssertEnabledOptions, 'target'>
): Promise<IOSResult<VerificationResult<EnabledAssertionData>>> {
  return assertDisabled({
    ...options,
    target: { text },
  });
}
