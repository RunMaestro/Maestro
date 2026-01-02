/**
 * iOS Tools - Snapshot Capture
 *
 * Main snapshot function that combines screenshot, logs, and crash detection
 * into a single unified capture for agent feedback.
 */

import path from 'path';
import fs from 'fs/promises';
import { IOSResult, ScreenshotResult, LogEntry, CrashReport } from './types';
import { screenshot } from './capture';
import { getSystemLog, getCrashLogs } from './logs';
import { getSimulator } from './simulator';
import { getSnapshotDirectory, generateSnapshotId } from './artifacts';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[iOS-Snapshot]';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for capturing a snapshot
 */
export interface SnapshotOptions {
  /** Simulator UDID (required if not using default booted) */
  udid?: string;
  /** App bundle ID to filter logs/crashes */
  bundleId?: string;
  /** Session ID for artifact storage */
  sessionId: string;
  /** How many seconds of logs to capture (default: 60) */
  logDuration?: number;
  /** Include full crash log content (default: false) */
  includeCrashContent?: boolean;
  /** Custom snapshot ID (auto-generated if not provided) */
  snapshotId?: string;
}

/**
 * Result of a snapshot capture
 */
export interface SnapshotResult {
  /** Unique identifier for this snapshot */
  id: string;
  /** Timestamp of capture */
  timestamp: Date;
  /** Simulator info */
  simulator: {
    udid: string;
    name: string;
    iosVersion: string;
  };
  /** Screenshot information */
  screenshot: {
    path: string;
    size: number;
  };
  /** Captured log entries */
  logs: {
    /** All log entries */
    entries: LogEntry[];
    /** Count of entries by level */
    counts: {
      error: number;
      fault: number;
      warning: number;
      info: number;
      debug: number;
    };
    /** Path to log file if saved */
    filePath?: string;
  };
  /** Crash information */
  crashes: {
    /** Whether any crashes were detected */
    hasCrashes: boolean;
    /** Crash reports found */
    reports: CrashReport[];
  };
  /** Directory containing all artifacts */
  artifactDir: string;
}

// =============================================================================
// Main Snapshot Function
// =============================================================================

/**
 * Capture a complete snapshot of the simulator state.
 * Combines screenshot, recent logs, and crash detection.
 *
 * @param options - Snapshot options
 * @returns Complete snapshot result or error
 */
export async function captureSnapshot(options: SnapshotOptions): Promise<IOSResult<SnapshotResult>> {
  const {
    udid: providedUdid,
    bundleId,
    sessionId,
    logDuration = 60,
    includeCrashContent = false,
    snapshotId: providedSnapshotId,
  } = options;

  const snapshotId = providedSnapshotId || generateSnapshotId();
  const startTime = new Date();

  logger.info(`${LOG_CONTEXT} Capturing snapshot ${snapshotId} for session ${sessionId}`);

  // Get UDID (use provided or find first booted)
  let udid = providedUdid;
  if (!udid) {
    const bootedResult = await import('./simulator').then((m) => m.getBootedSimulators());
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

  // Get simulator info
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

  // Create artifact directory
  let artifactDir: string;
  try {
    artifactDir = await getSnapshotDirectory(sessionId, snapshotId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to create artifact directory: ${error}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Capture screenshot
  const screenshotPath = path.join(artifactDir, 'screenshot.png');
  const screenshotResult = await screenshot({
    udid,
    outputPath: screenshotPath,
  });

  if (!screenshotResult.success) {
    return {
      success: false,
      error: screenshotResult.error || 'Failed to capture screenshot',
      errorCode: screenshotResult.errorCode || 'SCREENSHOT_FAILED',
    };
  }

  // Capture logs (last N seconds)
  const logSince = new Date(Date.now() - logDuration * 1000);
  const logsResult = await getSystemLog({
    udid,
    since: logSince,
    limit: 500,
  });

  let logEntries: LogEntry[] = [];
  if (logsResult.success && logsResult.data) {
    logEntries = logsResult.data;

    // Filter by bundle ID if specified
    if (bundleId) {
      logEntries = logEntries.filter(
        (entry) =>
          entry.process.toLowerCase().includes(bundleId.toLowerCase()) ||
          entry.subsystem?.toLowerCase().includes(bundleId.toLowerCase())
      );
    }
  } else {
    logger.warn(`${LOG_CONTEXT} Failed to get logs: ${logsResult.error}`);
  }

  // Count log entries by level
  const logCounts = {
    error: 0,
    fault: 0,
    warning: 0,
    info: 0,
    debug: 0,
  };

  for (const entry of logEntries) {
    switch (entry.level) {
      case 'error':
        logCounts.error++;
        break;
      case 'fault':
        logCounts.fault++;
        break;
      case 'info':
        logCounts.info++;
        break;
      case 'debug':
        logCounts.debug++;
        break;
      default:
        logCounts.info++;
    }
  }

  // Save logs to file
  let logFilePath: string | undefined;
  if (logEntries.length > 0) {
    logFilePath = path.join(artifactDir, 'logs.json');
    try {
      await fs.writeFile(logFilePath, JSON.stringify(logEntries, null, 2));
    } catch (error) {
      logger.warn(`${LOG_CONTEXT} Failed to save log file: ${error}`);
      logFilePath = undefined;
    }
  }

  // Check for crash logs
  const crashResult = await getCrashLogs({
    udid,
    bundleId,
    since: logSince,
    limit: 10,
    includeContent: includeCrashContent,
  });

  const crashReports: CrashReport[] = crashResult.success && crashResult.data ? crashResult.data : [];
  const hasCrashes = crashReports.length > 0;

  if (hasCrashes) {
    logger.warn(`${LOG_CONTEXT} Found ${crashReports.length} crash(es) in snapshot`);
  }

  // Build result
  const result: SnapshotResult = {
    id: snapshotId,
    timestamp: startTime,
    simulator: {
      udid,
      name: simResult.data.name,
      iosVersion: simResult.data.iosVersion,
    },
    screenshot: {
      path: screenshotPath,
      size: screenshotResult.data!.size,
    },
    logs: {
      entries: logEntries,
      counts: logCounts,
      filePath: logFilePath,
    },
    crashes: {
      hasCrashes,
      reports: crashReports,
    },
    artifactDir,
  };

  logger.info(
    `${LOG_CONTEXT} Snapshot complete: ${logEntries.length} logs, ${crashReports.length} crashes`
  );

  return {
    success: true,
    data: result,
  };
}
