/**
 * Tests for src/main/ios-tools/snapshot.ts
 *
 * Tests cover the snapshot orchestration service that combines
 * screenshot, logs, and crash detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user-data'),
  },
}));

// Mock capture module
const mockScreenshot = vi.fn();
vi.mock('../../../main/ios-tools/capture', () => ({
  screenshot: (...args: unknown[]) => mockScreenshot(...args),
}));

// Mock logs module
const mockGetSystemLog = vi.fn();
const mockGetCrashLogs = vi.fn();
vi.mock('../../../main/ios-tools/logs', () => ({
  getSystemLog: (...args: unknown[]) => mockGetSystemLog(...args),
  getCrashLogs: (...args: unknown[]) => mockGetCrashLogs(...args),
}));

// Mock simulator module
const mockGetSimulator = vi.fn();
const mockGetBootedSimulators = vi.fn();
vi.mock('../../../main/ios-tools/simulator', () => ({
  getSimulator: (...args: unknown[]) => mockGetSimulator(...args),
  getBootedSimulators: (...args: unknown[]) => mockGetBootedSimulators(...args),
}));

// Mock artifacts module
const mockGetSnapshotDirectory = vi.fn();
const mockGenerateSnapshotId = vi.fn();
vi.mock('../../../main/ios-tools/artifacts', () => ({
  getSnapshotDirectory: (...args: unknown[]) => mockGetSnapshotDirectory(...args),
  generateSnapshotId: (...args: unknown[]) => mockGenerateSnapshotId(...args),
}));

import { captureSnapshot, SnapshotOptions, SnapshotResult } from '../../../main/ios-tools/snapshot';

describe('snapshot.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for successful scenario
    mockGetSimulator.mockResolvedValue({
      success: true,
      data: {
        udid: 'test-udid',
        name: 'iPhone 15 Pro',
        state: 'Booted',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        iosVersion: '17.5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
      },
    });

    mockGetBootedSimulators.mockResolvedValue({
      success: true,
      data: [
        {
          udid: 'test-udid',
          name: 'iPhone 15 Pro',
          state: 'Booted',
          isAvailable: true,
          runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
          iosVersion: '17.5',
          deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        },
      ],
    });

    mockGetSnapshotDirectory.mockResolvedValue('/mock/artifacts/session-123/snapshot-001');
    mockGenerateSnapshotId.mockReturnValue('snapshot-001');

    mockScreenshot.mockResolvedValue({
      success: true,
      data: {
        path: '/mock/artifacts/session-123/snapshot-001/screenshot.png',
        size: 123456,
        timestamp: new Date(),
      },
    });

    mockGetSystemLog.mockResolvedValue({
      success: true,
      data: [
        {
          timestamp: new Date(),
          process: 'MyApp',
          level: 'info',
          message: 'App started',
        },
        {
          timestamp: new Date(),
          process: 'MyApp',
          level: 'error',
          message: 'Failed to load resource',
        },
      ],
    });

    mockGetCrashLogs.mockResolvedValue({
      success: true,
      data: [],
    });
  });

  // =============================================================================
  // captureSnapshot - Basic Functionality
  // =============================================================================

  describe('captureSnapshot', () => {
    it('captures a complete snapshot successfully', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBe('snapshot-001');
      expect(result.data!.simulator.udid).toBe('test-udid');
      expect(result.data!.simulator.name).toBe('iPhone 15 Pro');
      expect(result.data!.simulator.iosVersion).toBe('17.5');
      expect(result.data!.screenshot.path).toContain('screenshot.png');
      expect(result.data!.screenshot.size).toBe(123456);
      expect(result.data!.logs.entries).toHaveLength(2);
      expect(result.data!.crashes.hasCrashes).toBe(false);
    });

    it('uses provided snapshot ID', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
        snapshotId: 'custom-snapshot-id',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.id).toBe('custom-snapshot-id');
    });

    it('auto-selects first booted simulator when udid not provided', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.simulator.udid).toBe('test-udid');
    });

    it('uses custom log duration', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
        logDuration: 120,
      };

      await captureSnapshot(options);

      expect(mockGetSystemLog).toHaveBeenCalledWith(
        expect.objectContaining({
          udid: 'test-udid',
        })
      );

      // Verify the since date is approximately 120 seconds ago
      const call = mockGetSystemLog.mock.calls[0][0];
      const sinceDelta = Date.now() - call.since.getTime();
      expect(sinceDelta).toBeGreaterThanOrEqual(119000);
      expect(sinceDelta).toBeLessThanOrEqual(121000);
    });
  });

  // =============================================================================
  // captureSnapshot - Bundle ID Filtering
  // =============================================================================

  describe('captureSnapshot with bundleId filter', () => {
    it('filters logs by bundleId', async () => {
      mockGetSystemLog.mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'com.example.myapp', level: 'info', message: 'Test' },
          { timestamp: new Date(), process: 'SpringBoard', level: 'info', message: 'Other' },
          { timestamp: new Date(), process: 'MyApp', level: 'error', message: 'Error', subsystem: 'com.example.myapp' },
        ],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
        bundleId: 'com.example.myapp',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      // Should filter to entries matching bundleId in process or subsystem
      expect(result.data!.logs.entries).toHaveLength(2);
    });

    it('passes bundleId to crash log collection', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
        bundleId: 'com.example.myapp',
      };

      await captureSnapshot(options);

      expect(mockGetCrashLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleId: 'com.example.myapp',
        })
      );
    });
  });

  // =============================================================================
  // captureSnapshot - Log Counting
  // =============================================================================

  describe('captureSnapshot log counting', () => {
    it('counts log entries by level correctly', async () => {
      mockGetSystemLog.mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'App', level: 'error', message: 'Error 1' },
          { timestamp: new Date(), process: 'App', level: 'error', message: 'Error 2' },
          { timestamp: new Date(), process: 'App', level: 'fault', message: 'Fault 1' },
          { timestamp: new Date(), process: 'App', level: 'info', message: 'Info 1' },
          { timestamp: new Date(), process: 'App', level: 'debug', message: 'Debug 1' },
          { timestamp: new Date(), process: 'App', level: 'debug', message: 'Debug 2' },
          { timestamp: new Date(), process: 'App', level: 'default', message: 'Default 1' },
        ],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.logs.counts).toEqual({
        error: 2,
        fault: 1,
        warning: 0,
        info: 2, // info(1) + default(1) both count as info
        debug: 2,
      });
    });

    it('handles empty logs', async () => {
      mockGetSystemLog.mockResolvedValue({
        success: true,
        data: [],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.logs.entries).toHaveLength(0);
      expect(result.data!.logs.counts).toEqual({
        error: 0,
        fault: 0,
        warning: 0,
        info: 0,
        debug: 0,
      });
      expect(result.data!.logs.filePath).toBeUndefined();
    });
  });

  // =============================================================================
  // captureSnapshot - Crash Detection
  // =============================================================================

  describe('captureSnapshot crash detection', () => {
    it('detects crashes when present', async () => {
      mockGetCrashLogs.mockResolvedValue({
        success: true,
        data: [
          {
            id: 'crash-001',
            process: 'MyApp',
            bundleId: 'com.example.myapp',
            timestamp: new Date(),
            exceptionType: 'EXC_CRASH',
            exceptionMessage: 'Segmentation fault',
            path: '/path/to/crash.log',
          },
        ],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.crashes.hasCrashes).toBe(true);
      expect(result.data!.crashes.reports).toHaveLength(1);
      expect(result.data!.crashes.reports[0].process).toBe('MyApp');
    });

    it('reports no crashes when none found', async () => {
      mockGetCrashLogs.mockResolvedValue({
        success: true,
        data: [],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.crashes.hasCrashes).toBe(false);
      expect(result.data!.crashes.reports).toHaveLength(0);
    });

    it('includes crash content when requested', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
        includeCrashContent: true,
      };

      await captureSnapshot(options);

      expect(mockGetCrashLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          includeContent: true,
        })
      );
    });
  });

  // =============================================================================
  // captureSnapshot - Error Handling
  // =============================================================================

  describe('captureSnapshot error handling', () => {
    it('returns error when no booted simulator found', async () => {
      mockGetBootedSimulators.mockResolvedValue({
        success: true,
        data: [],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
      expect(result.error).toContain('No booted simulator');
    });

    it('returns error when simulator lookup fails', async () => {
      mockGetSimulator.mockResolvedValue({
        success: false,
        error: 'Simulator not found',
        errorCode: 'SIMULATOR_NOT_FOUND',
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'nonexistent-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_FOUND');
    });

    it('returns error when simulator is not booted', async () => {
      mockGetSimulator.mockResolvedValue({
        success: true,
        data: {
          udid: 'test-udid',
          name: 'iPhone 15 Pro',
          state: 'Shutdown',
          isAvailable: true,
          runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
          iosVersion: '17.5',
          deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        },
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
      expect(result.error).toContain('not booted');
    });

    it('returns error when artifact directory creation fails', async () => {
      mockGetSnapshotDirectory.mockRejectedValue(new Error('Permission denied'));

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('COMMAND_FAILED');
      expect(result.error).toContain('artifact directory');
    });

    it('returns error when screenshot fails', async () => {
      mockScreenshot.mockResolvedValue({
        success: false,
        error: 'Screenshot failed: timeout',
        errorCode: 'SCREENSHOT_FAILED',
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SCREENSHOT_FAILED');
    });

    it('continues when log collection fails', async () => {
      mockGetSystemLog.mockResolvedValue({
        success: false,
        error: 'Log collection failed',
        errorCode: 'LOG_COLLECTION_FAILED',
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      // Should still succeed - logs are optional
      expect(result.success).toBe(true);
      expect(result.data!.logs.entries).toHaveLength(0);
    });

    it('handles log file save failure gracefully', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('Write failed'));

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.logs.filePath).toBeUndefined();
    });
  });

  // =============================================================================
  // captureSnapshot - File Output
  // =============================================================================

  describe('captureSnapshot file output', () => {
    it('saves logs to file when entries exist', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('logs.json'),
        expect.any(String)
      );
      expect(result.data!.logs.filePath).toContain('logs.json');
    });

    it('does not save log file when no entries', async () => {
      mockGetSystemLog.mockResolvedValue({
        success: true,
        data: [],
      });

      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('includes artifact directory in result', async () => {
      const options: SnapshotOptions = {
        sessionId: 'session-123',
        udid: 'test-udid',
      };

      const result = await captureSnapshot(options);

      expect(result.success).toBe(true);
      expect(result.data!.artifactDir).toBe('/mock/artifacts/session-123/snapshot-001');
    });
  });
});
