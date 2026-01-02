/**
 * Tests for src/main/ios-tools/snapshot-formatter.ts
 *
 * Tests cover formatting snapshot results for agent consumption.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  formatSnapshotForAgent,
  summarizeLog,
  formatSnapshotAsJson,
} from '../../../main/ios-tools/snapshot-formatter';
import type { SnapshotResult } from '../../../main/ios-tools/snapshot';
import type { LogEntry, CrashReport } from '../../../main/ios-tools/types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockSnapshotResult(overrides: Partial<SnapshotResult> = {}): SnapshotResult {
  return {
    id: 'snapshot-001',
    timestamp: new Date('2024-01-15T10:30:00Z'),
    simulator: {
      udid: 'test-udid-1234',
      name: 'iPhone 15 Pro',
      iosVersion: '17.5',
    },
    screenshot: {
      path: '/path/to/screenshot.png',
      size: 123456,
    },
    logs: {
      entries: [],
      counts: {
        error: 0,
        fault: 0,
        warning: 0,
        info: 0,
        debug: 0,
      },
    },
    crashes: {
      hasCrashes: false,
      reports: [],
    },
    artifactDir: '/path/to/artifacts',
    ...overrides,
  };
}

function createMockLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date('2024-01-15T10:30:00Z'),
    process: 'TestProcess',
    level: 'info',
    message: 'Test message',
    ...overrides,
  };
}

function createMockCrashReport(overrides: Partial<CrashReport> = {}): CrashReport {
  return {
    id: 'crash-001',
    process: 'MyApp',
    timestamp: new Date('2024-01-15T10:30:00Z'),
    path: '/path/to/crash.log',
    ...overrides,
  };
}

// =============================================================================
// formatSnapshotForAgent
// =============================================================================

describe('formatSnapshotForAgent', () => {
  it('formats basic snapshot with no logs or crashes', () => {
    const result = createMockSnapshotResult();
    const formatted = formatSnapshotForAgent(result);

    expect(formatted.summary).toContain('Screenshot captured');
    expect(formatted.summary).toContain('No errors in logs');
    expect(formatted.summary).toContain('No crashes detected');
    expect(formatted.sections.status).toContain('iPhone 15 Pro');
    expect(formatted.sections.status).toContain('iOS 17.5');
    expect(formatted.sections.screenshot).toContain('/path/to/screenshot.png');
    expect(formatted.sections.logs).toBe('No log entries captured.');
    expect(formatted.sections.crashes).toBe('No crashes detected.');
    expect(formatted.fullOutput).toContain('## iOS Snapshot: snapshot-001');
  });

  it('includes error count in summary when errors present', () => {
    const result = createMockSnapshotResult({
      logs: {
        entries: [
          createMockLogEntry({ level: 'error', message: 'Error 1' }),
          createMockLogEntry({ level: 'fault', message: 'Fault 1' }),
        ],
        counts: {
          error: 3,
          fault: 2,
          warning: 0,
          info: 5,
          debug: 10,
        },
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.summary).toContain('5 error(s) in logs');
  });

  it('highlights crashes in summary', () => {
    const result = createMockSnapshotResult({
      crashes: {
        hasCrashes: true,
        reports: [createMockCrashReport()],
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.summary).toContain('**1 CRASH(ES) DETECTED**');
  });

  it('formats log section with entry counts', () => {
    const result = createMockSnapshotResult({
      logs: {
        entries: [
          createMockLogEntry({ level: 'info', message: 'Info message' }),
          createMockLogEntry({ level: 'error', message: 'Error message' }),
        ],
        counts: {
          error: 1,
          fault: 0,
          warning: 0,
          info: 1,
          debug: 0,
        },
        filePath: '/path/to/logs.json',
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.sections.logs).toContain('**Summary**: 2 entries');
    expect(formatted.sections.logs).toContain('Errors: 1');
    expect(formatted.sections.logs).toContain('Info: 1');
    expect(formatted.sections.logs).toContain('**Errors/Faults**:');
    expect(formatted.sections.logs).toContain('[ERROR] TestProcess: Error message');
    expect(formatted.sections.logs).toContain('**Full logs saved to**: `/path/to/logs.json`');
  });

  it('limits displayed errors to 10', () => {
    const errorEntries = Array.from({ length: 15 }, (_, i) =>
      createMockLogEntry({ level: 'error', message: `Error ${i + 1}` })
    );

    const result = createMockSnapshotResult({
      logs: {
        entries: errorEntries,
        counts: {
          error: 15,
          fault: 0,
          warning: 0,
          info: 0,
          debug: 0,
        },
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.sections.logs).toContain('... and 5 more errors/faults');
  });

  it('formats crash section with multiple crashes', () => {
    const result = createMockSnapshotResult({
      crashes: {
        hasCrashes: true,
        reports: [
          createMockCrashReport({
            process: 'MyApp',
            bundleId: 'com.example.myapp',
            exceptionType: 'EXC_CRASH',
            exceptionMessage: 'Segmentation fault',
          }),
          createMockCrashReport({
            id: 'crash-002',
            process: 'OtherApp',
            bundleId: 'com.example.other',
            exceptionType: 'EXC_BAD_ACCESS',
            exceptionMessage: 'Bad memory access',
          }),
        ],
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.sections.crashes).toContain('**2 crash(es) found!**');
    expect(formatted.sections.crashes).toContain('#### Crash: MyApp');
    expect(formatted.sections.crashes).toContain('com.example.myapp');
    expect(formatted.sections.crashes).toContain('EXC_CRASH');
    expect(formatted.sections.crashes).toContain('Segmentation fault');
    expect(formatted.sections.crashes).toContain('#### Crash: OtherApp');
  });

  it('includes screenshot size in KB', () => {
    const result = createMockSnapshotResult({
      screenshot: {
        path: '/path/to/screenshot.png',
        size: 512000, // 500 KB
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.sections.screenshot).toContain('**Size**: 500 KB');
  });

  it('includes UDID in status section', () => {
    const result = createMockSnapshotResult();
    const formatted = formatSnapshotForAgent(result);

    expect(formatted.sections.status).toContain('`test-udid-1234`');
  });

  it('includes artifact directory in full output', () => {
    const result = createMockSnapshotResult();
    const formatted = formatSnapshotForAgent(result);

    expect(formatted.fullOutput).toContain('Artifacts saved to: /path/to/artifacts');
  });

  it('truncates long error messages', () => {
    const longMessage = 'A'.repeat(200);
    const result = createMockSnapshotResult({
      logs: {
        entries: [createMockLogEntry({ level: 'error', message: longMessage })],
        counts: {
          error: 1,
          fault: 0,
          warning: 0,
          info: 0,
          debug: 0,
        },
      },
    });

    const formatted = formatSnapshotForAgent(result);

    expect(formatted.sections.logs).toContain('...');
    expect(formatted.sections.logs.length).toBeLessThan(longMessage.length + 100);
  });
});

// =============================================================================
// summarizeLog
// =============================================================================

describe('summarizeLog', () => {
  it('returns correct counts for mixed log entries', () => {
    const entries: LogEntry[] = [
      createMockLogEntry({ level: 'error', message: 'Error 1' }),
      createMockLogEntry({ level: 'error', message: 'Error 2' }),
      createMockLogEntry({ level: 'fault', message: 'Fault 1' }),
      createMockLogEntry({ level: 'info', message: 'Warning in message' }),
      createMockLogEntry({ level: 'info', message: 'Info message' }),
    ];

    const summary = summarizeLog(entries);

    expect(summary.errorCount).toBe(3); // 2 errors + 1 fault
    expect(summary.warningCount).toBe(1); // "Warning in message"
    expect(summary.hasIssues).toBe(true);
  });

  it('returns unique error messages', () => {
    const entries: LogEntry[] = [
      createMockLogEntry({ level: 'error', message: 'Same error' }),
      createMockLogEntry({ level: 'error', message: 'Same error' }),
      createMockLogEntry({ level: 'error', message: 'Different error' }),
    ];

    const summary = summarizeLog(entries);

    expect(summary.topErrors).toHaveLength(2);
    expect(summary.topErrors).toContain('Same error');
    expect(summary.topErrors).toContain('Different error');
  });

  it('limits top errors to maxItems', () => {
    const entries: LogEntry[] = Array.from({ length: 10 }, (_, i) =>
      createMockLogEntry({ level: 'error', message: `Error ${i + 1}` })
    );

    const summary = summarizeLog(entries, 3);

    expect(summary.topErrors).toHaveLength(3);
  });

  it('detects warnings from message content', () => {
    const entries: LogEntry[] = [
      createMockLogEntry({ level: 'info', message: 'This is a warning about memory' }),
      createMockLogEntry({ level: 'info', message: 'WARN: Deprecated function' }),
      createMockLogEntry({ level: 'info', message: 'Normal message' }),
    ];

    const summary = summarizeLog(entries);

    expect(summary.warningCount).toBe(2);
    expect(summary.topWarnings).toHaveLength(2);
  });

  it('returns hasIssues=false when no errors or warnings', () => {
    const entries: LogEntry[] = [
      createMockLogEntry({ level: 'info', message: 'Info 1' }),
      createMockLogEntry({ level: 'debug', message: 'Debug 1' }),
    ];

    const summary = summarizeLog(entries);

    expect(summary.hasIssues).toBe(false);
    expect(summary.errorCount).toBe(0);
    expect(summary.warningCount).toBe(0);
  });

  it('handles empty log entries', () => {
    const summary = summarizeLog([]);

    expect(summary.errorCount).toBe(0);
    expect(summary.warningCount).toBe(0);
    expect(summary.topErrors).toHaveLength(0);
    expect(summary.topWarnings).toHaveLength(0);
    expect(summary.hasIssues).toBe(false);
  });

  it('truncates long messages in summary', () => {
    const longMessage = 'A'.repeat(200);
    const entries: LogEntry[] = [
      createMockLogEntry({ level: 'error', message: longMessage }),
    ];

    const summary = summarizeLog(entries);

    expect(summary.topErrors[0].length).toBeLessThanOrEqual(80);
    expect(summary.topErrors[0]).toContain('...');
  });
});

// =============================================================================
// formatSnapshotAsJson
// =============================================================================

describe('formatSnapshotAsJson', () => {
  it('returns valid JSON string', () => {
    const result = createMockSnapshotResult();
    const json = formatSnapshotAsJson(result);

    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('converts dates to ISO strings', () => {
    const result = createMockSnapshotResult();
    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.timestamp).toBe('2024-01-15T10:30:00.000Z');
  });

  it('includes simulator info', () => {
    const result = createMockSnapshotResult();
    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.simulator.udid).toBe('test-udid-1234');
    expect(parsed.simulator.name).toBe('iPhone 15 Pro');
    expect(parsed.simulator.iosVersion).toBe('17.5');
  });

  it('includes screenshot info', () => {
    const result = createMockSnapshotResult();
    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.screenshot.path).toBe('/path/to/screenshot.png');
    expect(parsed.screenshot.size).toBe(123456);
  });

  it('includes log entry count and counts', () => {
    const result = createMockSnapshotResult({
      logs: {
        entries: [
          createMockLogEntry({ level: 'error', message: 'Error 1' }),
          createMockLogEntry({ level: 'info', message: 'Info 1' }),
        ],
        counts: {
          error: 1,
          fault: 0,
          warning: 0,
          info: 1,
          debug: 0,
        },
        filePath: '/path/to/logs.json',
      },
    });

    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.logs.entryCount).toBe(2);
    expect(parsed.logs.counts.error).toBe(1);
    expect(parsed.logs.counts.info).toBe(1);
    expect(parsed.logs.filePath).toBe('/path/to/logs.json');
  });

  it('limits recent log entries to 10', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      createMockLogEntry({ message: `Log ${i + 1}` })
    );

    const result = createMockSnapshotResult({
      logs: {
        entries,
        counts: { error: 0, fault: 0, warning: 0, info: 20, debug: 0 },
      },
    });

    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.logs.recentEntries).toHaveLength(10);
  });

  it('includes crash information', () => {
    const result = createMockSnapshotResult({
      crashes: {
        hasCrashes: true,
        reports: [
          createMockCrashReport({
            process: 'MyApp',
            bundleId: 'com.example.myapp',
            exceptionType: 'EXC_CRASH',
            exceptionMessage: 'Fatal error',
          }),
        ],
      },
    });

    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.crashes.hasCrashes).toBe(true);
    expect(parsed.crashes.count).toBe(1);
    expect(parsed.crashes.reports[0].process).toBe('MyApp');
    expect(parsed.crashes.reports[0].bundleId).toBe('com.example.myapp');
    expect(parsed.crashes.reports[0].exceptionType).toBe('EXC_CRASH');
  });

  it('truncates long messages in JSON output', () => {
    const longMessage = 'A'.repeat(300);
    const result = createMockSnapshotResult({
      logs: {
        entries: [createMockLogEntry({ message: longMessage })],
        counts: { error: 0, fault: 0, warning: 0, info: 1, debug: 0 },
      },
    });

    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.logs.recentEntries[0].message.length).toBeLessThanOrEqual(200);
    expect(parsed.logs.recentEntries[0].message).toContain('...');
  });

  it('includes artifact directory', () => {
    const result = createMockSnapshotResult();
    const json = formatSnapshotAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.artifactDir).toBe('/path/to/artifacts');
  });
});
