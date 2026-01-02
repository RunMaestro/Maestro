/**
 * iOS Tools - Snapshot Formatter
 *
 * Formats snapshot results into agent-friendly output.
 * Produces structured, readable text that AI agents can understand.
 */

import { SnapshotResult } from './snapshot';
import { LogEntry, CrashReport } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Formatted snapshot output for agents
 */
export interface FormattedSnapshot {
  /** Human-readable summary */
  summary: string;
  /** Detailed sections */
  sections: {
    status: string;
    screenshot: string;
    logs: string;
    crashes: string;
  };
  /** Full formatted output */
  fullOutput: string;
}

// =============================================================================
// Main Formatter
// =============================================================================

/**
 * Format a snapshot result for agent consumption.
 * Creates a structured, readable output.
 *
 * @param result - Snapshot result to format
 * @returns Formatted output
 */
export function formatSnapshotForAgent(result: SnapshotResult): FormattedSnapshot {
  const sections = {
    status: formatStatus(result),
    screenshot: formatScreenshot(result),
    logs: formatLogs(result),
    crashes: formatCrashes(result),
  };

  const summary = createSummary(result);

  const fullOutput = `
## iOS Snapshot: ${result.id}

${summary}

---

### Status
${sections.status}

### Screenshot
${sections.screenshot}

### Logs (last ${result.logs.entries.length} entries)
${sections.logs}

### Crash Detection
${sections.crashes}

---
Artifacts saved to: ${result.artifactDir}
`.trim();

  return {
    summary,
    sections,
    fullOutput,
  };
}

// =============================================================================
// Section Formatters
// =============================================================================

/**
 * Create a brief summary line
 */
function createSummary(result: SnapshotResult): string {
  const parts: string[] = [];

  // Screenshot status
  parts.push('Screenshot captured');

  // Log summary
  const errorCount = result.logs.counts.error + result.logs.counts.fault;
  if (errorCount > 0) {
    parts.push(`${errorCount} error(s) in logs`);
  } else {
    parts.push('No errors in logs');
  }

  // Crash status
  if (result.crashes.hasCrashes) {
    parts.push(`**${result.crashes.reports.length} CRASH(ES) DETECTED**`);
  } else {
    parts.push('No crashes detected');
  }

  return parts.join(' | ');
}

/**
 * Format status section
 */
function formatStatus(result: SnapshotResult): string {
  return `
- **Simulator**: ${result.simulator.name} (iOS ${result.simulator.iosVersion})
- **UDID**: \`${result.simulator.udid}\`
- **Captured at**: ${result.timestamp.toISOString()}
`.trim();
}

/**
 * Format screenshot section
 */
function formatScreenshot(result: SnapshotResult): string {
  const sizeKB = Math.round(result.screenshot.size / 1024);
  return `
- **Path**: \`${result.screenshot.path}\`
- **Size**: ${sizeKB} KB
`.trim();
}

/**
 * Format logs section
 */
function formatLogs(result: SnapshotResult): string {
  const { entries, counts } = result.logs;

  if (entries.length === 0) {
    return 'No log entries captured.';
  }

  let output = `
**Summary**: ${entries.length} entries
- Errors: ${counts.error}
- Faults: ${counts.fault}
- Info: ${counts.info}
- Debug: ${counts.debug}
`.trim();

  // Add error/fault entries (most important)
  const importantLogs = entries.filter((e) => e.level === 'error' || e.level === 'fault');

  if (importantLogs.length > 0) {
    output += '\n\n**Errors/Faults**:\n';
    for (const entry of importantLogs.slice(0, 10)) {
      output += `- [${entry.level.toUpperCase()}] ${entry.process}: ${truncate(entry.message, 100)}\n`;
    }
    if (importantLogs.length > 10) {
      output += `\n... and ${importantLogs.length - 10} more errors/faults`;
    }
  }

  // Log file reference
  if (result.logs.filePath) {
    output += `\n\n**Full logs saved to**: \`${result.logs.filePath}\``;
  }

  return output;
}

/**
 * Format crashes section
 */
function formatCrashes(result: SnapshotResult): string {
  if (!result.crashes.hasCrashes) {
    return 'No crashes detected.';
  }

  let output = `**${result.crashes.reports.length} crash(es) found!**\n`;

  for (const crash of result.crashes.reports) {
    output += `
#### Crash: ${crash.process}
- **Bundle ID**: ${crash.bundleId || 'Unknown'}
- **Time**: ${crash.timestamp.toISOString()}
- **Exception**: ${crash.exceptionType || 'Unknown'}
- **Message**: ${crash.exceptionMessage || 'No message'}
- **Report**: \`${crash.path}\`
`;
  }

  return output.trim();
}

// =============================================================================
// Log Summary
// =============================================================================

/**
 * Summarize log content by extracting errors and warnings.
 * Useful for giving agents a quick overview.
 *
 * @param entries - Log entries to summarize
 * @param maxItems - Maximum items per category
 * @returns Summary object
 */
export function summarizeLog(
  entries: LogEntry[],
  maxItems: number = 5
): {
  errorCount: number;
  warningCount: number;
  topErrors: string[];
  topWarnings: string[];
  hasIssues: boolean;
} {
  const errors = entries.filter((e) => e.level === 'error' || e.level === 'fault');
  const warnings = entries.filter((e) =>
    e.message.toLowerCase().includes('warning') || e.message.toLowerCase().includes('warn')
  );

  // Extract unique error messages
  const uniqueErrors = [...new Set(errors.map((e) => e.message))];
  const uniqueWarnings = [...new Set(warnings.map((e) => e.message))];

  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    topErrors: uniqueErrors.slice(0, maxItems).map((m) => truncate(m, 80)),
    topWarnings: uniqueWarnings.slice(0, maxItems).map((m) => truncate(m, 80)),
    hasIssues: errors.length > 0 || warnings.length > 0,
  };
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Truncate a string to a maximum length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format a snapshot result as JSON for structured output.
 *
 * @param result - Snapshot result
 * @returns JSON-formatted string
 */
export function formatSnapshotAsJson(result: SnapshotResult): string {
  // Create a serializable version (dates to ISO strings)
  const serializable = {
    id: result.id,
    timestamp: result.timestamp.toISOString(),
    simulator: result.simulator,
    screenshot: result.screenshot,
    logs: {
      entryCount: result.logs.entries.length,
      counts: result.logs.counts,
      filePath: result.logs.filePath,
      // Only include first few entries in JSON
      recentEntries: result.logs.entries.slice(0, 10).map((e) => ({
        timestamp: e.timestamp.toISOString(),
        level: e.level,
        process: e.process,
        message: truncate(e.message, 200),
      })),
    },
    crashes: {
      hasCrashes: result.crashes.hasCrashes,
      count: result.crashes.reports.length,
      reports: result.crashes.reports.map((r) => ({
        process: r.process,
        bundleId: r.bundleId,
        timestamp: r.timestamp.toISOString(),
        exceptionType: r.exceptionType,
        exceptionMessage: r.exceptionMessage,
        path: r.path,
      })),
    },
    artifactDir: result.artifactDir,
  };

  return JSON.stringify(serializable, null, 2);
}
