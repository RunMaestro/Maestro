/**
 * iOS Tools - Utility Functions
 *
 * Shared utilities for iOS tooling operations including:
 * - Safe command execution wrappers for xcrun simctl
 * - JSON parsing for simctl output
 * - Polling/wait helpers
 */

import { execFileNoThrow, ExecResult } from '../utils/execFile';
import { logger } from '../utils/logger';
import { RawSimctlListOutput, IOSResult, IOSError, IOSErrorCode } from './types';

const LOG_CONTEXT = '[iOS-Tools]';

// =============================================================================
// Command Execution Wrappers
// =============================================================================

/**
 * Run an xcrun simctl command safely.
 * Wraps execFileNoThrow to provide consistent error handling.
 *
 * @param args - Arguments to pass to simctl
 * @param cwd - Optional working directory
 * @returns ExecResult with stdout, stderr, and exitCode
 */
export async function runSimctl(args: string[], cwd?: string): Promise<ExecResult> {
  logger.debug(`${LOG_CONTEXT} Running: xcrun simctl ${args.join(' ')}`, LOG_CONTEXT);

  const result = await execFileNoThrow('xcrun', ['simctl', ...args], cwd);

  if (result.exitCode !== 0) {
    logger.warn(
      `${LOG_CONTEXT} simctl command failed: xcrun simctl ${args.join(' ')} (exit: ${result.exitCode})`,
      LOG_CONTEXT
    );
    if (result.stderr) {
      logger.debug(`${LOG_CONTEXT} stderr: ${result.stderr}`, LOG_CONTEXT);
    }
  }

  return result;
}

/**
 * Run an xcrun command (not simctl).
 *
 * @param args - Arguments to pass to xcrun
 * @param cwd - Optional working directory
 * @returns ExecResult with stdout, stderr, and exitCode
 */
export async function runXcrun(args: string[], cwd?: string): Promise<ExecResult> {
  logger.debug(`${LOG_CONTEXT} Running: xcrun ${args.join(' ')}`, LOG_CONTEXT);

  const result = await execFileNoThrow('xcrun', args, cwd);

  if (result.exitCode !== 0) {
    logger.warn(
      `${LOG_CONTEXT} xcrun command failed: xcrun ${args.join(' ')} (exit: ${result.exitCode})`,
      LOG_CONTEXT
    );
  }

  return result;
}

/**
 * Run the xcode-select command.
 *
 * @param args - Arguments to pass to xcode-select
 * @returns ExecResult with stdout, stderr, and exitCode
 */
export async function runXcodeSelect(args: string[]): Promise<ExecResult> {
  logger.debug(`${LOG_CONTEXT} Running: xcode-select ${args.join(' ')}`, LOG_CONTEXT);

  const result = await execFileNoThrow('xcode-select', args);

  if (result.exitCode !== 0) {
    logger.warn(
      `${LOG_CONTEXT} xcode-select command failed: ${args.join(' ')} (exit: ${result.exitCode})`,
      LOG_CONTEXT
    );
  }

  return result;
}

/**
 * Run xcodebuild command.
 *
 * @param args - Arguments to pass to xcodebuild
 * @param cwd - Optional working directory
 * @returns ExecResult with stdout, stderr, and exitCode
 */
export async function runXcodebuild(args: string[], cwd?: string): Promise<ExecResult> {
  logger.debug(`${LOG_CONTEXT} Running: xcodebuild ${args.join(' ')}`, LOG_CONTEXT);

  const result = await execFileNoThrow('xcodebuild', args, cwd);

  if (result.exitCode !== 0) {
    logger.warn(
      `${LOG_CONTEXT} xcodebuild command failed (exit: ${result.exitCode})`,
      LOG_CONTEXT
    );
  }

  return result;
}

// =============================================================================
// JSON Parsing
// =============================================================================

/**
 * Parse simctl JSON output safely.
 * Handles common parsing errors and returns typed result.
 *
 * @param output - Raw JSON string from simctl command
 * @returns Parsed RawSimctlListOutput or error
 */
export function parseSimctlJson(output: string): IOSResult<RawSimctlListOutput> {
  try {
    // simctl sometimes includes non-JSON output before the JSON
    // Find the first '{' and parse from there
    const jsonStart = output.indexOf('{');
    if (jsonStart === -1) {
      return {
        success: false,
        error: 'No JSON object found in simctl output',
        errorCode: 'PARSE_ERROR',
      };
    }

    const jsonString = output.slice(jsonStart);
    const parsed = JSON.parse(jsonString) as RawSimctlListOutput;

    // Validate expected structure
    if (!parsed.devices || typeof parsed.devices !== 'object') {
      return {
        success: false,
        error: 'Invalid simctl output: missing devices object',
        errorCode: 'PARSE_ERROR',
      };
    }

    return {
      success: true,
      data: parsed,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown parse error';
    return {
      success: false,
      error: `Failed to parse simctl JSON: ${message}`,
      errorCode: 'PARSE_ERROR',
    };
  }
}

/**
 * Parse a generic JSON output safely.
 *
 * @param output - Raw JSON string
 * @returns Parsed object or error
 */
export function parseJson<T>(output: string): IOSResult<T> {
  try {
    const jsonStart = output.indexOf('{');
    const jsonArrayStart = output.indexOf('[');

    let startIndex = -1;
    if (jsonStart === -1 && jsonArrayStart === -1) {
      return {
        success: false,
        error: 'No JSON found in output',
        errorCode: 'PARSE_ERROR',
      };
    } else if (jsonStart === -1) {
      startIndex = jsonArrayStart;
    } else if (jsonArrayStart === -1) {
      startIndex = jsonStart;
    } else {
      startIndex = Math.min(jsonStart, jsonArrayStart);
    }

    const jsonString = output.slice(startIndex);
    const parsed = JSON.parse(jsonString) as T;

    return {
      success: true,
      data: parsed,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown parse error';
    return {
      success: false,
      error: `Failed to parse JSON: ${message}`,
      errorCode: 'PARSE_ERROR',
    };
  }
}

// =============================================================================
// Polling Helpers
// =============================================================================

/**
 * Wait for a condition to be true with timeout.
 *
 * @param condition - Async function that returns true when condition is met
 * @param timeout - Maximum time to wait in milliseconds
 * @param interval - Polling interval in milliseconds (default: 500)
 * @returns IOSResult indicating success or timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number,
  interval: number = 500
): Promise<IOSResult<void>> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      if (result) {
        return { success: true };
      }
    } catch (e) {
      // Condition threw an error, continue waiting
      logger.debug(`${LOG_CONTEXT} waitFor condition threw: ${e}`, LOG_CONTEXT);
    }

    // Wait before next check
    await sleep(interval);
  }

  return {
    success: false,
    error: `Timeout after ${timeout}ms`,
    errorCode: 'TIMEOUT',
  };
}

/**
 * Sleep for specified milliseconds.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Error Helpers
// =============================================================================

/**
 * Create an IOSError from an ExecResult.
 *
 * @param result - ExecResult from command execution
 * @param code - Error code to use
 * @param message - Human-readable message
 * @param command - Command that was executed
 */
export function createError(
  result: ExecResult,
  code: IOSErrorCode,
  message: string,
  command?: string
): IOSError {
  return {
    code,
    message,
    details: result.stderr || result.stdout,
    command,
    exitCode: result.exitCode,
  };
}

/**
 * Create an IOSResult failure from an ExecResult.
 *
 * @param result - ExecResult from command execution
 * @param code - Error code to use
 * @param message - Human-readable message
 */
export function createFailure<T>(
  result: ExecResult,
  code: IOSErrorCode,
  message: string
): IOSResult<T> {
  return {
    success: false,
    error: message,
    errorCode: code,
  };
}

// =============================================================================
// Version Parsing
// =============================================================================

/**
 * Parse iOS version from runtime identifier.
 * E.g., "com.apple.CoreSimulator.SimRuntime.iOS-17-5" -> "17.5"
 *
 * @param runtimeId - Full runtime identifier
 * @returns iOS version string or "unknown"
 */
export function parseIOSVersionFromRuntime(runtimeId: string): string {
  // Match patterns like:
  // - com.apple.CoreSimulator.SimRuntime.iOS-17-5
  // - com.apple.CoreSimulator.SimRuntime.iOS-16-4
  const match = runtimeId.match(/iOS-(\d+)-(\d+)/i);
  if (match) {
    return `${match[1]}.${match[2]}`;
  }

  // Try alternate pattern for older runtimes
  const altMatch = runtimeId.match(/iOS (\d+\.\d+)/i);
  if (altMatch) {
    return altMatch[1];
  }

  return 'unknown';
}

/**
 * Parse device type name from identifier.
 * E.g., "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro" -> "iPhone 15 Pro"
 *
 * @param deviceTypeId - Full device type identifier
 * @returns Human-readable device name or the original identifier
 */
export function parseDeviceTypeName(deviceTypeId: string): string {
  // Extract the device part from identifiers like:
  // - com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro
  const match = deviceTypeId.match(/SimDeviceType\.(.+)$/);
  if (match) {
    // Replace hyphens with spaces
    return match[1].replace(/-/g, ' ');
  }
  return deviceTypeId;
}

// =============================================================================
// Xcodebuild Output Parsing
// =============================================================================

/**
 * Build diagnostic message (warning or error) with location info
 */
export interface BuildDiagnostic {
  /** Diagnostic type */
  type: 'warning' | 'error' | 'note';
  /** The diagnostic message */
  message: string;
  /** Source file path (if available) */
  file?: string;
  /** Line number (if available) */
  line?: number;
  /** Column number (if available) */
  column?: number;
  /** Category (e.g., "-Wunused-variable") */
  category?: string;
}

/**
 * Build phase information
 */
export interface BuildPhase {
  /** Phase name (e.g., "CompileC", "Ld", "CpResource") */
  name: string;
  /** Target being built */
  target?: string;
  /** File being processed */
  file?: string;
  /** Timestamp when phase started (if available) */
  timestamp?: string;
}

/**
 * Compilation step information
 */
export interface CompilationStep {
  /** Source file being compiled */
  sourceFile: string;
  /** Target name */
  target?: string;
  /** Whether compilation succeeded */
  success: boolean;
  /** Duration in seconds (if available) */
  duration?: number;
}

/**
 * Linker step information
 */
export interface LinkerStep {
  /** Output file path */
  outputFile: string;
  /** Target name */
  target?: string;
  /** Whether linking succeeded */
  success: boolean;
}

/**
 * Parsed xcodebuild output
 */
export interface ParsedXcodebuildOutput {
  /** Whether the build succeeded */
  success: boolean;
  /** All warnings found in the output */
  warnings: BuildDiagnostic[];
  /** All errors found in the output */
  errors: BuildDiagnostic[];
  /** All notes found in the output */
  notes: BuildDiagnostic[];
  /** Build phases executed */
  phases: BuildPhase[];
  /** Individual compilation steps */
  compilations: CompilationStep[];
  /** Linker steps */
  linkSteps: LinkerStep[];
  /** Targets that were built */
  targets: string[];
  /** Build action (e.g., "build", "clean", "test") */
  action?: string;
  /** Total warning count */
  warningCount: number;
  /** Total error count */
  errorCount: number;
  /** Raw build result line (e.g., "BUILD SUCCEEDED" or "BUILD FAILED") */
  resultLine?: string;
}

/**
 * Parse xcodebuild output into structured data.
 * Extracts warnings, errors, build phases, compilation steps, and overall status.
 *
 * @param output - Raw xcodebuild stdout/stderr output
 * @returns Parsed build output structure
 */
export function parseXcodebuildOutput(output: string): ParsedXcodebuildOutput {
  const lines = output.split('\n');

  const result: ParsedXcodebuildOutput = {
    success: true,
    warnings: [],
    errors: [],
    notes: [],
    phases: [],
    compilations: [],
    linkSteps: [],
    targets: [],
    warningCount: 0,
    errorCount: 0,
  };

  const seenTargets = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Skip empty lines
    if (!trimmedLine) continue;

    // Check for build result
    if (trimmedLine === 'BUILD SUCCEEDED' || trimmedLine.includes('** BUILD SUCCEEDED **')) {
      result.success = true;
      result.resultLine = trimmedLine;
    } else if (trimmedLine === 'BUILD FAILED' || trimmedLine.includes('** BUILD FAILED **')) {
      result.success = false;
      result.resultLine = trimmedLine;
    } else if (trimmedLine.includes('** TEST SUCCEEDED **')) {
      result.success = true;
      result.resultLine = trimmedLine;
      result.action = 'test';
    } else if (trimmedLine.includes('** TEST FAILED **')) {
      result.success = false;
      result.resultLine = trimmedLine;
      result.action = 'test';
    } else if (trimmedLine.includes('** CLEAN SUCCEEDED **')) {
      result.success = true;
      result.resultLine = trimmedLine;
      result.action = 'clean';
    }

    // Parse warnings
    const warningMatch = line.match(/^(.+?):(\d+):(\d+):\s*warning:\s*(.+?)(?:\s*\[([^\]]+)\])?$/);
    if (warningMatch) {
      result.warnings.push({
        type: 'warning',
        file: warningMatch[1],
        line: parseInt(warningMatch[2], 10),
        column: parseInt(warningMatch[3], 10),
        message: warningMatch[4].trim(),
        category: warningMatch[5],
      });
      result.warningCount++;
      continue;
    }

    // Alternative warning format (no column)
    const warningMatch2 = line.match(/^(.+?):(\d+):\s*warning:\s*(.+?)(?:\s*\[([^\]]+)\])?$/);
    if (warningMatch2) {
      result.warnings.push({
        type: 'warning',
        file: warningMatch2[1],
        line: parseInt(warningMatch2[2], 10),
        message: warningMatch2[3].trim(),
        category: warningMatch2[4],
      });
      result.warningCount++;
      continue;
    }

    // Simple warning format (standalone "warning:" at start or with colon prefix)
    const simpleWarningMatch = line.match(/^(?:.*:\s*)?warning:\s*(.+)/i);
    if (simpleWarningMatch && !result.warnings.some(w => w.message === simpleWarningMatch[1].trim())) {
      result.warnings.push({
        type: 'warning',
        message: simpleWarningMatch[1].trim(),
      });
      result.warningCount++;
      continue;
    }

    // Emoji warning format
    if (line.includes('⚠️')) {
      const emojiMatch = line.match(/⚠️\s*(?:warning:\s*)?(.+)/i);
      if (emojiMatch && !result.warnings.some(w => w.message === emojiMatch[1].trim())) {
        result.warnings.push({
          type: 'warning',
          message: emojiMatch[1].trim(),
        });
        result.warningCount++;
      }
      continue;
    }

    // Parse errors
    const errorMatch = line.match(/^(.+?):(\d+):(\d+):\s*error:\s*(.+)$/);
    if (errorMatch) {
      result.errors.push({
        type: 'error',
        file: errorMatch[1],
        line: parseInt(errorMatch[2], 10),
        column: parseInt(errorMatch[3], 10),
        message: errorMatch[4].trim(),
      });
      result.errorCount++;
      result.success = false;
      continue;
    }

    // Alternative error format (no column)
    const errorMatch2 = line.match(/^(.+?):(\d+):\s*error:\s*(.+)$/);
    if (errorMatch2) {
      result.errors.push({
        type: 'error',
        file: errorMatch2[1],
        line: parseInt(errorMatch2[2], 10),
        message: errorMatch2[3].trim(),
      });
      result.errorCount++;
      result.success = false;
      continue;
    }

    // Simple error format (standalone "error:" at start or with colon prefix)
    const simpleErrorMatch = line.match(/^(?:.*:\s*)?error:\s*(.+)/i);
    if (simpleErrorMatch && !result.errors.some(e => e.message === simpleErrorMatch[1].trim())) {
      result.errors.push({
        type: 'error',
        message: simpleErrorMatch[1].trim(),
      });
      result.errorCount++;
      result.success = false;
      continue;
    }

    // Emoji error format
    if (line.includes('❌')) {
      const emojiMatch = line.match(/❌\s*(?:error:\s*)?(.+)/i);
      if (emojiMatch && !result.errors.some(e => e.message === emojiMatch[1].trim())) {
        result.errors.push({
          type: 'error',
          message: emojiMatch[1].trim(),
        });
        result.errorCount++;
        result.success = false;
      }
      continue;
    }

    // Parse notes
    const noteMatch = line.match(/^(.+?):(\d+):(\d+):\s*note:\s*(.+)$/);
    if (noteMatch) {
      result.notes.push({
        type: 'note',
        file: noteMatch[1],
        line: parseInt(noteMatch[2], 10),
        column: parseInt(noteMatch[3], 10),
        message: noteMatch[4].trim(),
      });
      continue;
    }

    // Parse build phases (CompileC, CompileSwift, Ld, etc.)
    const phaseMatch = line.match(/^(CompileC|CompileSwift|CompileSwiftSources|Ld|Libtool|CpResource|CopySwiftLibs|ProcessInfoPlistFile|CodeSign|Touch|CreateUniversalBinary|PhaseScriptExecution|ProcessProductPackaging)\s+(.+)/);
    if (phaseMatch) {
      const phase: BuildPhase = {
        name: phaseMatch[1],
        file: phaseMatch[2].trim(),
      };

      // Extract target if present (often in format "target: TargetName")
      const targetInLine = line.match(/\(in target '([^']+)'/);
      if (targetInLine) {
        phase.target = targetInLine[1];
        if (!seenTargets.has(targetInLine[1])) {
          seenTargets.add(targetInLine[1]);
          result.targets.push(targetInLine[1]);
        }
      }

      result.phases.push(phase);

      // Track compilation steps
      if (phaseMatch[1] === 'CompileC' || phaseMatch[1] === 'CompileSwift') {
        result.compilations.push({
          sourceFile: phaseMatch[2].trim(),
          target: phase.target,
          success: true, // Assume success unless we see an error later
        });
      }

      // Track linker steps
      if (phaseMatch[1] === 'Ld') {
        result.linkSteps.push({
          outputFile: phaseMatch[2].trim(),
          target: phase.target,
          success: true,
        });
      }

      continue;
    }

    // Parse target-based lines (e.g., "=== BUILD TARGET TargetName" or "=== CLEAN TARGET TargetName")
    const targetActionMatch = line.match(/===\s*(BUILD|CLEAN|TEST)\s+(?:AGGREGATE\s+)?TARGET\s+(\S+)/);
    if (targetActionMatch) {
      // Set action if not already set
      if (!result.action) {
        result.action = targetActionMatch[1].toLowerCase();
      }
      // Add target
      if (!seenTargets.has(targetActionMatch[2])) {
        seenTargets.add(targetActionMatch[2]);
        result.targets.push(targetActionMatch[2]);
      }
      continue;
    }

    // Parse action-only lines (e.g., "=== BUILD AGGREGATE TARGET" without target name)
    const actionOnlyMatch = line.match(/===\s*(BUILD|CLEAN|TEST)\s+(?:TARGET|AGGREGATE)/);
    if (actionOnlyMatch && !result.action) {
      result.action = actionOnlyMatch[1].toLowerCase();
    }
  }

  // Mark compilations as failed if we have errors
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      if (error.file) {
        // Find the compilation step for this file
        const compilation = result.compilations.find(c =>
          c.sourceFile.includes(error.file!) || error.file!.includes(c.sourceFile)
        );
        if (compilation) {
          compilation.success = false;
        }
      }
    }
  }

  return result;
}
