/**
 * Tests for iOS No-Errors Assertions
 *
 * Tests the assertNoErrors function for verifying
 * that no error patterns appear in system logs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../../../../main/ios-tools/simulator', () => ({
  getBootedSimulators: vi.fn(),
  getSimulator: vi.fn(),
}));

vi.mock('../../../../main/ios-tools/capture', () => ({
  screenshot: vi.fn(),
}));

vi.mock('../../../../main/ios-tools/logs', () => ({
  getSystemLog: vi.fn(),
}));

vi.mock('../../../../main/ios-tools/artifacts', () => ({
  getSnapshotDirectory: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  assertNoErrors,
  countErrors,
  hasErrorPattern,
  assertNoErrorsForApp,
  assertNoHttpErrors,
  assertNoCrashIndicators,
  DEFAULT_ERROR_PATTERNS,
  DEFAULT_IGNORE_PATTERNS,
} from '../../../../main/ios-tools/assertions/no-errors';
import { getBootedSimulators, getSimulator } from '../../../../main/ios-tools/simulator';
import { screenshot } from '../../../../main/ios-tools/capture';
import { getSystemLog } from '../../../../main/ios-tools/logs';
import { getSnapshotDirectory } from '../../../../main/ios-tools/artifacts';

describe('no-errors assertions', () => {
  const mockUdid = 'test-udid-12345';
  const mockSessionId = 'test-session';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for booted simulators
    vi.mocked(getBootedSimulators).mockResolvedValue({
      success: true,
      data: [{ udid: mockUdid, name: 'iPhone 15', state: 'Booted' }],
    });

    // Default mock for simulator info
    vi.mocked(getSimulator).mockResolvedValue({
      success: true,
      data: {
        udid: mockUdid,
        name: 'iPhone 15',
        state: 'Booted',
        iosVersion: '17.0',
      },
    });

    // Default mock for artifact directory
    vi.mocked(getSnapshotDirectory).mockResolvedValue('/tmp/artifacts/test');

    // Default mock for screenshot
    vi.mocked(screenshot).mockResolvedValue({
      success: true,
      data: { path: '/tmp/artifacts/test/screenshot.png' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DEFAULT_ERROR_PATTERNS', () => {
    it('should have common error patterns', () => {
      expect(DEFAULT_ERROR_PATTERNS.length).toBeGreaterThan(0);

      // Test some patterns match expected strings
      const errorPattern = DEFAULT_ERROR_PATTERNS.find(p => p.test('Error occurred'));
      expect(errorPattern).toBeDefined();

      const crashPattern = DEFAULT_ERROR_PATTERNS.find(p => p.test('crash detected'));
      expect(crashPattern).toBeDefined();

      const httpPattern = DEFAULT_ERROR_PATTERNS.find(p => p.test('HTTP status 500'));
      expect(httpPattern).toBeDefined();
    });
  });

  describe('DEFAULT_IGNORE_PATTERNS', () => {
    it('should have patterns to ignore common false positives', () => {
      expect(DEFAULT_IGNORE_PATTERNS.length).toBeGreaterThan(0);

      // Test some ignore patterns
      const noErrorPattern = DEFAULT_IGNORE_PATTERNS.find(p => p.test('no error'));
      expect(noErrorPattern).toBeDefined();

      const errorNilPattern = DEFAULT_IGNORE_PATTERNS.find(p => p.test('error = nil'));
      expect(errorNilPattern).toBeDefined();
    });
  });

  describe('assertNoErrors', () => {
    it('should pass when no errors are found in logs', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'App launched successfully',
          },
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'User logged in',
          },
        ],
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.errorsFound).toBe(false);
      expect(result.data?.data?.errorCount).toBe(0);
      expect(result.data?.data?.totalLogsScanned).toBe(2);
    });

    it('should fail when error pattern is found', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'error',
            message: 'Error: Failed to connect to server',
          },
        ],
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('failed');
      expect(result.data?.data?.errorsFound).toBe(true);
      expect(result.data?.data?.errorCount).toBe(1);
      expect(result.data?.data?.errors).toHaveLength(1);
      expect(result.data?.data?.errors![0].matchedText).toBe('Error');
    });

    it('should ignore patterns in the ignore list', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'debug',
            message: 'error = nil, request successful',
          },
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'No error occurred',
          },
        ],
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.errorsFound).toBe(false);
    });

    it('should use custom patterns when provided', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'warning',
            message: 'Custom problem detected',
          },
        ],
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
        patterns: [/custom problem/i],
        customPatternsOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('failed');
      expect(result.data?.data?.errorsFound).toBe(true);
      expect(result.data?.data?.errors![0].matchedText).toBe('Custom problem');
    });

    it('should filter by bundleId when provided', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [],
      });

      await assertNoErrors({
        sessionId: mockSessionId,
        bundleId: 'com.example.app',
      });

      expect(getSystemLog).toHaveBeenCalledWith(
        expect.objectContaining({
          process: 'com.example.app',
        })
      );
    });

    it('should limit errors to maxErrors', async () => {
      const errors = Array(20).fill(null).map((_, i) => ({
        timestamp: new Date(),
        process: 'TestApp',
        pid: 1234,
        level: 'error' as const,
        message: `Error ${i}: Something failed`,
      }));

      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: errors,
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
        maxErrors: 5,
      });

      expect(result.success).toBe(true);
      expect(result.data?.data?.errorCount).toBe(5);
      expect(result.data?.data?.errors).toHaveLength(5);
    });

    it('should return error when no simulator is booted', async () => {
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [],
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });

    it('should capture screenshot on failure', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'error',
            message: 'Fatal error occurred',
          },
        ],
      });

      await assertNoErrors({
        sessionId: mockSessionId,
        captureOnFailure: true,
      });

      expect(screenshot).toHaveBeenCalled();
    });

    it('should not capture screenshot on success when captureOnSuccess is false', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [],
      });

      await assertNoErrors({
        sessionId: mockSessionId,
        captureOnSuccess: false,
        captureOnFailure: false,
      });

      expect(screenshot).not.toHaveBeenCalled();
    });

    it('should include context lines when specified', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'Before context 1',
          },
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'Before context 2',
          },
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'error',
            message: 'Error: The actual error',
          },
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'After context 1',
          },
          {
            timestamp: new Date(),
            process: 'TestApp',
            pid: 1234,
            level: 'info',
            message: 'After context 2',
          },
        ],
      });

      const result = await assertNoErrors({
        sessionId: mockSessionId,
        contextLines: 2,
      });

      expect(result.data?.data?.errors![0].contextBefore).toHaveLength(2);
      expect(result.data?.data?.errors![0].contextAfter).toHaveLength(2);
    });
  });

  describe('countErrors', () => {
    it('should return count of errors', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'Error 1' },
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'Error 2' },
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'info', message: 'Normal log' },
        ],
      });

      const result = await countErrors(mockUdid, new Date(Date.now() - 60000));

      expect(result.success).toBe(true);
      expect(result.data).toBe(2);
    });

    it('should return 0 when no errors found', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'info', message: 'Normal log' },
        ],
      });

      const result = await countErrors(mockUdid, new Date(Date.now() - 60000));

      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
    });
  });

  describe('hasErrorPattern', () => {
    it('should return true when pattern is found', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'CustomError: Something went wrong' },
        ],
      });

      const result = await hasErrorPattern(mockUdid, 'CustomError');

      expect(result.success).toBe(true);
      expect(result.data).toBe(true);
    });

    it('should return false when pattern is not found', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'info', message: 'Everything is fine' },
        ],
      });

      const result = await hasErrorPattern(mockUdid, 'CustomError');

      expect(result.success).toBe(true);
      expect(result.data).toBe(false);
    });

    it('should support regex patterns', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'HTTP 500 Internal Server Error' },
        ],
      });

      const result = await hasErrorPattern(mockUdid, /HTTP\s+5\d{2}/);

      expect(result.success).toBe(true);
      expect(result.data).toBe(true);
    });
  });

  describe('assertNoErrorsForApp', () => {
    it('should call assertNoErrors with bundleId', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [],
      });

      await assertNoErrorsForApp('com.example.app', {
        sessionId: mockSessionId,
      });

      expect(getSystemLog).toHaveBeenCalledWith(
        expect.objectContaining({
          process: 'com.example.app',
        })
      );
    });
  });

  describe('assertNoHttpErrors', () => {
    it('should detect HTTP errors', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'HTTP status 404 Not Found' },
        ],
      });

      const result = await assertNoHttpErrors({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('failed');
      expect(result.data?.data?.errorsFound).toBe(true);
    });

    it('should pass when no HTTP errors', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'info', message: 'HTTP status 200 OK' },
        ],
      });

      const result = await assertNoHttpErrors({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
    });
  });

  describe('assertNoCrashIndicators', () => {
    it('should detect crash indicators', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'SIGABRT received' },
        ],
      });

      const result = await assertNoCrashIndicators({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('failed');
      expect(result.data?.data?.errorsFound).toBe(true);
    });

    it('should detect fatal errors', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'error', message: 'fatalError: Index out of bounds' },
        ],
      });

      const result = await assertNoCrashIndicators({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('failed');
    });

    it('should pass when no crash indicators', async () => {
      vi.mocked(getSystemLog).mockResolvedValue({
        success: true,
        data: [
          { timestamp: new Date(), process: 'TestApp', pid: 1234, level: 'info', message: 'App running normally' },
        ],
      });

      const result = await assertNoCrashIndicators({
        sessionId: mockSessionId,
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
    });
  });
});
