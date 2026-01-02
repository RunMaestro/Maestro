/**
 * iOS Assertion - Assert No Errors
 *
 * Verifies that no error patterns appear in system logs since a given point in time.
 * Useful for detecting runtime errors, API failures, and other issues that may not crash
 * the app but indicate problems.
 */

import path from 'path';
import { IOSResult, LogEntry } from '../types';
import { getBootedSimulators, getSimulator } from '../simulator';
import { getSystemLog } from '../logs';
import { screenshot } from '../capture';
import { getSnapshotDirectory } from '../artifacts';
import {
  AssertionBaseOptions,
  VerificationResult,
  VerificationAttempt,
  pollUntil,
  generateVerificationId,
  createPassedResult,
  createFailedResult,
  createTimeoutResult,
  mergePollingOptions,
} from '../verification';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[iOS-Assert-NoErrors]';

// =============================================================================
// Types
// =============================================================================

/**
 * Default error patterns to look for in logs.
 * These cover common iOS/Swift error indicators.
 */
export const DEFAULT_ERROR_PATTERNS = [
  /\berror\b/i,                           // Generic "error" keyword
  /\bfailed\b/i,                          // "failed" keyword
  /\bexception\b/i,                       // Exception mentions
  /\bcrash\b/i,                           // Crash mentions
  /\bfatal\b/i,                           // Fatal errors
  /\bassert(?:ion)?(?:\s+)?fail(?:ed|ure)?\b/i,  // Assertion failures
  /\bEXC_BAD_ACCESS\b/i,                  // Memory access errors
  /\bSIGABRT\b/i,                         // Signal abort
  /\bSIGSEGV\b/i,                         // Segmentation fault
  /\bNSException\b/i,                     // Objective-C exceptions
  /\bfatalError\b/i,                      // Swift fatal errors
  /\bpreconditionFailure\b/i,             // Swift precondition failures
  /\bunexpected(?:ly)?\s+(?:found\s+)?nil\b/i,  // Swift nil errors
  /\bforced\s+unwrap(?:ping)?\b/i,        // Force unwrap failures
  /HTTP\s+(?:error|status)?\s*[45]\d{2}/i, // HTTP 4xx/5xx errors
  /\bAPI\s+(?:error|failure)\b/i,         // API errors
  /\bnetwork\s+error\b/i,                 // Network errors
  /\btimeout\b/i,                         // Timeout errors
  /\bout\s+of\s+memory\b/i,               // Memory errors
];

/**
 * Default patterns to ignore (commonly noisy but not problematic).
 */
export const DEFAULT_IGNORE_PATTERNS = [
  /\berror\s*domain/i,                    // Domain descriptions (not actual errors)
  /\bno\s+error/i,                        // "No error" messages
  /\bif\s+error/i,                        // Conditional error checks
  /\berror\s*=\s*nil/i,                   // Swift error is nil
  /\berror\s*==\s*nil/i,                  // Error comparison to nil
  /\bhandled\s+error/i,                   // Handled errors (expected)
  /\bexpected\s+error/i,                  // Expected errors (tests)
  /\bsuppress(?:ed)?\s+error/i,           // Suppressed errors
  /\bignore(?:d)?\s+error/i,              // Ignored errors
  /\bdebug\b/i,                           // Debug log level (often noisy)
  /CoreData.*error/i,                     // CoreData setup messages
  /URLSession.*error/i,                   // URLSession debug info
];

/**
 * A matched error entry with context.
 */
export interface MatchedError {
  /** The log entry that matched */
  entry: LogEntry;
  /** The pattern that matched */
  matchedPattern: string;
  /** The specific text that matched */
  matchedText: string;
  /** Context lines before the match */
  contextBefore?: string[];
  /** Context lines after the match */
  contextAfter?: string[];
}

/**
 * Options for assertNoErrors
 */
export interface AssertNoErrorsOptions extends AssertionBaseOptions {
  /** App bundle identifier to filter logs (optional - if not provided, checks all logs) */
  bundleId?: string;
  /** Time from which to check for errors (default: 60 seconds ago) */
  since?: Date;
  /** Custom error patterns to search for (in addition to defaults) */
  patterns?: (string | RegExp)[];
  /** Patterns to ignore (in addition to defaults) */
  ignorePatterns?: (string | RegExp)[];
  /** If true, only use custom patterns (ignore defaults) */
  customPatternsOnly?: boolean;
  /** If true, only use custom ignore patterns (ignore defaults) */
  customIgnorePatternsOnly?: boolean;
  /** Maximum number of errors to return (default: 10) */
  maxErrors?: number;
  /** Log level to filter (default: 'error' and 'fault') */
  logLevel?: 'default' | 'info' | 'debug' | 'error' | 'fault';
  /** Include context lines around matched errors (default: 2) */
  contextLines?: number;
}

/**
 * Data specific to no-errors assertion results
 */
export interface NoErrorsAssertionData {
  /** The bundle ID being monitored (if specified) */
  bundleId?: string;
  /** Start time for error monitoring */
  sinceTime: Date;
  /** End time for error monitoring */
  untilTime: Date;
  /** Monitoring duration in ms */
  monitoringDuration: number;
  /** Whether any errors were found */
  errorsFound: boolean;
  /** Number of errors detected */
  errorCount: number;
  /** Total log entries scanned */
  totalLogsScanned: number;
  /** Matched errors with context */
  errors?: MatchedError[];
  /** Patterns that were used */
  patternsUsed: string[];
  /** Patterns that were ignored */
  ignorePatterns: string[];
}

// =============================================================================
// Pattern Utilities
// =============================================================================

/**
 * Convert string patterns to RegExp.
 */
function toRegExp(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  // Escape special regex characters for literal string matching
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

/**
 * Get effective error patterns based on options.
 */
function getEffectivePatterns(options: AssertNoErrorsOptions): RegExp[] {
  if (options.customPatternsOnly && options.patterns) {
    return options.patterns.map(toRegExp);
  }

  const patterns = [...DEFAULT_ERROR_PATTERNS];
  if (options.patterns) {
    patterns.push(...options.patterns.map(toRegExp));
  }
  return patterns;
}

/**
 * Get effective ignore patterns based on options.
 */
function getEffectiveIgnorePatterns(options: AssertNoErrorsOptions): RegExp[] {
  if (options.customIgnorePatternsOnly && options.ignorePatterns) {
    return options.ignorePatterns.map(toRegExp);
  }

  const patterns = [...DEFAULT_IGNORE_PATTERNS];
  if (options.ignorePatterns) {
    patterns.push(...options.ignorePatterns.map(toRegExp));
  }
  return patterns;
}

/**
 * Check if a log message matches any ignore pattern.
 */
function shouldIgnore(message: string, ignorePatterns: RegExp[]): boolean {
  return ignorePatterns.some(pattern => pattern.test(message));
}

/**
 * Find matching error pattern in a message.
 */
function findMatchingPattern(message: string, patterns: RegExp[]): { pattern: RegExp; match: RegExpMatchArray } | null {
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return { pattern, match };
    }
  }
  return null;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Assert that no error patterns appear in system logs.
 *
 * @param options - Assertion options
 * @returns Verification result indicating pass/fail
 */
export async function assertNoErrors(
  options: AssertNoErrorsOptions
): Promise<IOSResult<VerificationResult<NoErrorsAssertionData>>> {
  const {
    udid: providedUdid,
    sessionId,
    assertionId: providedId,
    bundleId,
    since: providedSince,
    polling,
    captureOnFailure = true,
    captureOnSuccess = false,
    maxErrors = 10,
    logLevel,
    contextLines = 2,
  } = options;

  const assertionId = providedId || generateVerificationId('no-errors');
  const startTime = new Date();
  // Default to 60 seconds ago if no since provided
  const sinceTime = providedSince || new Date(Date.now() - 60 * 1000);

  const effectivePatterns = getEffectivePatterns(options);
  const effectiveIgnorePatterns = getEffectiveIgnorePatterns(options);

  logger.info(
    `${LOG_CONTEXT} Asserting no errors${bundleId ? ` for ${bundleId}` : ''} since ${sinceTime.toISOString()} (session: ${sessionId})`
  );
  logger.debug(`${LOG_CONTEXT} Using ${effectivePatterns.length} error patterns, ${effectiveIgnorePatterns.length} ignore patterns`);

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

  // Check for errors in logs
  const checkNoErrors = async (): Promise<{
    passed: boolean;
    error?: string;
    data?: NoErrorsAssertionData;
  }> => {
    const endTime = new Date();

    // Get system logs
    const logsResult = await getSystemLog({
      udid,
      since: sinceTime,
      process: bundleId,
      level: logLevel || 'error', // Default to error level
      limit: 5000, // Reasonable limit
    });

    if (!logsResult.success) {
      return {
        passed: false,
        error: logsResult.error || 'Failed to get system logs',
      };
    }

    const logs = logsResult.data || [];
    const matchedErrors: MatchedError[] = [];

    // Scan logs for error patterns
    for (let i = 0; i < logs.length && matchedErrors.length < maxErrors; i++) {
      const entry = logs[i];
      const message = entry.message;

      // Skip if matches ignore pattern
      if (shouldIgnore(message, effectiveIgnorePatterns)) {
        continue;
      }

      // Check for error pattern match
      const matchResult = findMatchingPattern(message, effectivePatterns);
      if (matchResult) {
        const { pattern, match } = matchResult;

        // Collect context lines
        const contextBefore: string[] = [];
        const contextAfter: string[] = [];

        if (contextLines > 0) {
          // Get lines before
          for (let j = Math.max(0, i - contextLines); j < i; j++) {
            contextBefore.push(logs[j].message);
          }
          // Get lines after
          for (let j = i + 1; j < Math.min(logs.length, i + 1 + contextLines); j++) {
            contextAfter.push(logs[j].message);
          }
        }

        matchedErrors.push({
          entry,
          matchedPattern: pattern.toString(),
          matchedText: match[0],
          contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
          contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
        });
      }
    }

    const monitoringDuration = endTime.getTime() - sinceTime.getTime();

    const data: NoErrorsAssertionData = {
      bundleId,
      sinceTime,
      untilTime: endTime,
      monitoringDuration,
      errorsFound: matchedErrors.length > 0,
      errorCount: matchedErrors.length,
      totalLogsScanned: logs.length,
      errors: matchedErrors.length > 0 ? matchedErrors : undefined,
      patternsUsed: effectivePatterns.map(p => p.toString()),
      ignorePatterns: effectiveIgnorePatterns.map(p => p.toString()),
    };

    if (matchedErrors.length > 0) {
      const firstError = matchedErrors[0];
      const errorMsg = `Found ${matchedErrors.length} error(s) in logs. First: "${firstError.matchedText}" in "${firstError.entry.message.substring(0, 100)}..."`;

      return {
        passed: false,
        error: errorMsg,
        data,
      };
    }

    return {
      passed: true,
      data,
    };
  };

  let finalResult: {
    passed: boolean;
    duration: number;
    attempts: VerificationAttempt[];
    lastData?: NoErrorsAssertionData;
  };

  // For no-errors, polling is less common but supported
  // (useful for waiting for errors to clear after a fix)
  const pollingOpts = polling ? mergePollingOptions(polling) : undefined;

  if (pollingOpts) {
    pollingOpts.description = `no errors${bundleId ? ` for ${bundleId}` : ''}`;
    const pollResult = await pollUntil<NoErrorsAssertionData>(checkNoErrors, pollingOpts);

    if (!pollResult.success) {
      return {
        success: false,
        error: pollResult.error || 'Polling failed',
        errorCode: pollResult.errorCode || 'COMMAND_FAILED',
      };
    }

    finalResult = pollResult.data!;
  } else {
    // Single check (immediate)
    const singleCheck = await checkNoErrors();
    finalResult = {
      passed: singleCheck.passed,
      duration: Date.now() - startTime.getTime(),
      attempts: [{
        attempt: 1,
        timestamp: new Date(),
        success: singleCheck.passed,
        duration: Date.now() - startTime.getTime(),
        error: singleCheck.error,
      }],
      lastData: singleCheck.data,
    };
  }

  const { passed, attempts, lastData } = finalResult;

  // Prepare artifacts
  const artifacts: { screenshots?: string[]; logs?: string[] } = {};

  // Capture screenshot on failure
  if (!passed && captureOnFailure) {
    const screenshotPath = path.join(artifactDir, 'error-state.png');
    const screenshotResult = await screenshot({ udid, outputPath: screenshotPath });

    if (screenshotResult.success) {
      artifacts.screenshots = [screenshotPath];
    }
  }

  if (passed && captureOnSuccess) {
    const screenshotPath = path.join(artifactDir, 'success.png');
    const screenshotResult = await screenshot({ udid, outputPath: screenshotPath });

    if (screenshotResult.success) {
      artifacts.screenshots = [screenshotPath];
    }
  }

  // Build result
  const resultParams = {
    id: assertionId,
    type: 'no-errors',
    target: bundleId || 'all processes',
    startTime,
    attempts,
    simulator: simulatorInfo,
    artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
    data: lastData,
  };

  if (passed) {
    const scannedCount = lastData?.totalLogsScanned || 0;
    logger.info(`${LOG_CONTEXT} Assertion passed: no errors found (scanned ${scannedCount} log entries)`);
    return {
      success: true,
      data: createPassedResult({
        ...resultParams,
        message: `No errors found${bundleId ? ` for "${bundleId}"` : ''} since ${sinceTime.toISOString()} (scanned ${scannedCount} entries)`,
      }),
    };
  }

  // Determine if it was a timeout (only applicable when polling)
  if (pollingOpts) {
    const wasTimeout = finalResult.duration >= pollingOpts.timeout;

    if (wasTimeout) {
      logger.warn(`${LOG_CONTEXT} Assertion timeout waiting for errors to clear`);
      return {
        success: true,
        data: createTimeoutResult({
          ...resultParams,
          timeout: pollingOpts.timeout,
        }),
      };
    }
  }

  // Build failure message
  const errorCount = lastData?.errorCount || 0;
  const firstError = lastData?.errors?.[0];
  let failureMessage = `Found ${errorCount} error(s) in logs`;

  if (bundleId) {
    failureMessage += ` for "${bundleId}"`;
  }

  if (firstError) {
    const timestamp = firstError.entry.timestamp.toISOString();
    const preview = firstError.entry.message.length > 80
      ? firstError.entry.message.substring(0, 80) + '...'
      : firstError.entry.message;
    failureMessage += `. First at ${timestamp}: "${preview}"`;
  }

  logger.warn(`${LOG_CONTEXT} Assertion failed: ${failureMessage}`);
  return {
    success: true,
    data: createFailedResult({
      ...resultParams,
      message: failureMessage,
    }),
  };
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Quick check for errors in recent logs.
 * Returns just the count of errors found.
 */
export async function countErrors(
  udid: string,
  since: Date,
  bundleId?: string,
  patterns?: (string | RegExp)[]
): Promise<IOSResult<number>> {
  const logsResult = await getSystemLog({
    udid,
    since,
    process: bundleId,
    level: 'error',
    limit: 1000,
  });

  if (!logsResult.success) {
    return {
      success: false,
      error: logsResult.error,
      errorCode: logsResult.errorCode,
    };
  }

  const logs = logsResult.data || [];
  const effectivePatterns = patterns
    ? patterns.map(toRegExp)
    : DEFAULT_ERROR_PATTERNS;
  const ignorePatterns = DEFAULT_IGNORE_PATTERNS;

  let errorCount = 0;
  for (const entry of logs) {
    if (shouldIgnore(entry.message, ignorePatterns)) {
      continue;
    }
    if (findMatchingPattern(entry.message, effectivePatterns)) {
      errorCount++;
    }
  }

  return {
    success: true,
    data: errorCount,
  };
}

/**
 * Check for a specific error pattern in logs.
 */
export async function hasErrorPattern(
  udid: string,
  pattern: string | RegExp,
  since?: Date,
  bundleId?: string
): Promise<IOSResult<boolean>> {
  const sinceTime = since || new Date(Date.now() - 60 * 1000);

  const logsResult = await getSystemLog({
    udid,
    since: sinceTime,
    process: bundleId,
    level: 'error',
    limit: 1000,
  });

  if (!logsResult.success) {
    return {
      success: false,
      error: logsResult.error,
      errorCode: logsResult.errorCode,
    };
  }

  const logs = logsResult.data || [];
  const regex = toRegExp(pattern);

  for (const entry of logs) {
    if (regex.test(entry.message)) {
      return {
        success: true,
        data: true,
      };
    }
  }

  return {
    success: true,
    data: false,
  };
}

/**
 * Assert no errors for a specific bundle ID.
 */
export async function assertNoErrorsForApp(
  bundleId: string,
  options: Omit<AssertNoErrorsOptions, 'bundleId'>
): Promise<IOSResult<VerificationResult<NoErrorsAssertionData>>> {
  return assertNoErrors({
    ...options,
    bundleId,
  });
}

/**
 * Assert no HTTP errors in logs.
 */
export async function assertNoHttpErrors(
  options: Omit<AssertNoErrorsOptions, 'patterns' | 'customPatternsOnly'>
): Promise<IOSResult<VerificationResult<NoErrorsAssertionData>>> {
  return assertNoErrors({
    ...options,
    patterns: [
      /HTTP\s+(?:error|status)?\s*4\d{2}/i,  // 4xx errors
      /HTTP\s+(?:error|status)?\s*5\d{2}/i,  // 5xx errors
      /\bnetwork\s+error\b/i,
      /\bconnection\s+(?:refused|reset|timeout)\b/i,
      /\bNSURLError\b/i,
    ],
    customPatternsOnly: true,
  });
}

/**
 * Assert no crash-related errors in logs.
 */
export async function assertNoCrashIndicators(
  options: Omit<AssertNoErrorsOptions, 'patterns' | 'customPatternsOnly'>
): Promise<IOSResult<VerificationResult<NoErrorsAssertionData>>> {
  return assertNoErrors({
    ...options,
    patterns: [
      /\bcrash\b/i,
      /\bfatal\b/i,
      /\bEXC_BAD_ACCESS\b/i,
      /\bSIGABRT\b/i,
      /\bSIGSEGV\b/i,
      /\bNSException\b/i,
      /\bfatalError\b/i,
      /\bpreconditionFailure\b/i,
      /\bassert(?:ion)?(?:\s+)?fail/i,
    ],
    customPatternsOnly: true,
  });
}
