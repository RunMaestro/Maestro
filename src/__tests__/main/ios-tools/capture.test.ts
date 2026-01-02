/**
 * Tests for src/main/ios-tools/capture.ts
 *
 * Tests cover screenshot and video recording operations.
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

// Mock execFileNoThrow
const mockExecFileNoThrow = vi.fn();
vi.mock('../../../main/utils/execFile', () => ({
  execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 12345 }),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.alloc(24)),
  unlink: vi.fn().mockResolvedValue(undefined),
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 12345 }),
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.alloc(24)),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock simulator.getSimulator
vi.mock('../../../main/ios-tools/simulator', () => ({
  getSimulator: vi.fn().mockResolvedValue({
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
  }),
}));

import {
  screenshot,
  captureScreenshot,
  startRecording,
  stopRecording,
  isRecording,
  getScreenSize,
} from '../../../main/ios-tools/capture';
import * as simulator from '../../../main/ios-tools/simulator';
import fs from 'fs/promises';

describe('capture.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations to defaults
    vi.mocked(simulator.getSimulator).mockResolvedValue({
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
  });

  // =============================================================================
  // screenshot
  // =============================================================================

  describe('screenshot', () => {
    it('captures screenshot with default options', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await screenshot({
        udid: 'test-udid',
        outputPath: '/tmp/screenshot.png',
      });

      expect(result.success).toBe(true);
      expect(result.data!.path).toBe('/tmp/screenshot.png');
      expect(result.data!.size).toBe(12345);
      expect(result.data!.timestamp).toBeInstanceOf(Date);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcrun',
        expect.arrayContaining([
          'simctl', 'io', 'test-udid', 'screenshot',
          '--display', 'internal',
          '--mask', 'ignored',
          '--type', 'display',
          '/tmp/screenshot.png',
        ]),
        undefined
      );
    });

    it('captures screenshot with custom options', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await screenshot({
        udid: 'test-udid',
        outputPath: '/tmp/screenshot.png',
        type: 'window',
        display: 'external',
        mask: 'black',
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcrun',
        expect.arrayContaining([
          '--display', 'external',
          '--mask', 'black',
          '--type', 'window',
        ]),
        undefined
      );
    });

    it('returns error when simulator not booted', async () => {
      vi.mocked(simulator.getSimulator).mockResolvedValueOnce({
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

      const result = await screenshot({
        udid: 'test-udid',
        outputPath: '/tmp/screenshot.png',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });

    it('returns error when simulator not found', async () => {
      vi.mocked(simulator.getSimulator).mockResolvedValueOnce({
        success: false,
        error: 'Simulator not found',
        errorCode: 'SIMULATOR_NOT_FOUND',
      });

      const result = await screenshot({
        udid: 'nonexistent',
        outputPath: '/tmp/screenshot.png',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_FOUND');
    });

    it('returns error when screenshot command fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Screenshot failed',
        exitCode: 1,
      });

      const result = await screenshot({
        udid: 'test-udid',
        outputPath: '/tmp/screenshot.png',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SCREENSHOT_FAILED');
    });

    it('handles file stat error gracefully', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('File not found'));

      const result = await screenshot({
        udid: 'test-udid',
        outputPath: '/tmp/screenshot.png',
      });

      expect(result.success).toBe(true);
      expect(result.data!.size).toBe(0);
    });

    it('creates output directory if needed', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await screenshot({
        udid: 'test-udid',
        outputPath: '/new/nested/dir/screenshot.png',
      });

      expect(fs.mkdir).toHaveBeenCalledWith('/new/nested/dir', { recursive: true });
    });
  });

  // =============================================================================
  // captureScreenshot (auto-naming)
  // =============================================================================

  describe('captureScreenshot', () => {
    it('captures screenshot with auto-generated filename', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await captureScreenshot('test-udid', '/tmp/screenshots');

      expect(result.success).toBe(true);
      expect(result.data!.path).toMatch(/\/tmp\/screenshots\/screenshot-\d{4}-\d{2}-\d{2}T/);
      expect(result.data!.path).toMatch(/\.png$/);
    });

    it('uses custom prefix for filename', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await captureScreenshot('test-udid', '/tmp/screenshots', 'test-capture');

      expect(result.success).toBe(true);
      expect(result.data!.path).toMatch(/\/tmp\/screenshots\/test-capture-\d{4}-\d{2}-\d{2}T/);
    });
  });

  // =============================================================================
  // startRecording / stopRecording / isRecording
  // =============================================================================

  describe('startRecording', () => {
    it('starts video recording', async () => {
      // Mock runSimctl to return immediately (recording runs in background)
      mockExecFileNoThrow.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await startRecording({
        udid: 'test-udid',
        outputPath: '/tmp/recording.mp4',
      });

      expect(result.success).toBe(true);
      expect(isRecording('test-udid')).toBe(true);
    });

    it('starts recording with custom options', async () => {
      mockExecFileNoThrow.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await startRecording({
        udid: 'test-udid-2',
        outputPath: '/tmp/recording.mp4',
        codec: 'hevc',
        display: 'external',
        mask: 'alpha',
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcrun',
        expect.arrayContaining([
          'simctl', 'io', 'test-udid-2', 'recordVideo',
          '--codec', 'hevc',
          '--display', 'external',
          '--mask', 'alpha',
          '/tmp/recording.mp4',
        ]),
        undefined
      );
    });

    it('returns error when already recording', async () => {
      mockExecFileNoThrow.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Start first recording
      await startRecording({
        udid: 'test-udid-3',
        outputPath: '/tmp/recording1.mp4',
      });

      // Try to start second recording on same simulator
      const result = await startRecording({
        udid: 'test-udid-3',
        outputPath: '/tmp/recording2.mp4',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RECORDING_FAILED');
      expect(result.error).toContain('already in progress');
    });

    it('returns error when simulator not booted', async () => {
      vi.mocked(simulator.getSimulator).mockResolvedValueOnce({
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

      const result = await startRecording({
        udid: 'test-udid',
        outputPath: '/tmp/recording.mp4',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });
  });

  describe('stopRecording', () => {
    beforeEach(() => {
      // Clear any existing recordings
      vi.clearAllMocks();
    });

    it('stops active recording', async () => {
      mockExecFileNoThrow.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Start recording first
      await startRecording({
        udid: 'stop-test-udid',
        outputPath: '/tmp/recording.mp4',
      });

      // Stop recording
      const result = await stopRecording('stop-test-udid');

      expect(result.success).toBe(true);
      expect(result.data).toBe('/tmp/recording.mp4');
      expect(isRecording('stop-test-udid')).toBe(false);
    });

    it('returns error when no active recording', async () => {
      const result = await stopRecording('no-recording-udid');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RECORDING_FAILED');
      expect(result.error).toContain('No active recording');
    });

    it('returns error when recording file not found', async () => {
      mockExecFileNoThrow.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Start recording
      await startRecording({
        udid: 'file-test-udid',
        outputPath: '/tmp/missing.mp4',
      });

      // Mock file not existing
      vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await stopRecording('file-test-udid');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RECORDING_FAILED');
      expect(result.error).toContain('not found');
    });
  });

  describe('isRecording', () => {
    it('returns false when no recording active', () => {
      expect(isRecording('nonexistent-udid')).toBe(false);
    });

    it('returns true when recording is active', async () => {
      mockExecFileNoThrow.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await startRecording({
        udid: 'is-recording-test',
        outputPath: '/tmp/recording.mp4',
      });

      expect(isRecording('is-recording-test')).toBe(true);
    });
  });

  // =============================================================================
  // getScreenSize
  // =============================================================================

  describe('getScreenSize', () => {
    it('returns screen dimensions from screenshot', async () => {
      // Mock successful screenshot
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Mock PNG file with dimensions in header
      // PNG signature (8 bytes) + IHDR chunk header (8 bytes) + width (4 bytes) + height (4 bytes)
      const pngBuffer = Buffer.alloc(32);
      pngBuffer.writeUInt32BE(1170, 16); // width at byte 16
      pngBuffer.writeUInt32BE(2532, 20); // height at byte 20
      vi.mocked(fs.readFile).mockResolvedValueOnce(pngBuffer);

      const result = await getScreenSize('test-udid');

      expect(result.success).toBe(true);
      expect(result.data!.width).toBe(1170);
      expect(result.data!.height).toBe(2532);
    });

    it('returns fallback dimensions on screenshot failure', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Screenshot failed',
        exitCode: 1,
      });

      const result = await getScreenSize('test-udid');

      expect(result.success).toBe(true);
      // Fallback dimensions
      expect(result.data!.width).toBe(1170);
      expect(result.data!.height).toBe(2532);
    });

    it('returns fallback dimensions when PNG parsing fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Mock a file that's too small to be a valid PNG
      vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.alloc(8));

      const result = await getScreenSize('test-udid');

      expect(result.success).toBe(true);
      // Should return fallback dimensions
      expect(result.data!.width).toBe(1170);
      expect(result.data!.height).toBe(2532);
    });

    it('cleans up temporary screenshot file', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const pngBuffer = Buffer.alloc(32);
      pngBuffer.writeUInt32BE(1170, 16);
      pngBuffer.writeUInt32BE(2532, 20);
      vi.mocked(fs.readFile).mockResolvedValueOnce(pngBuffer);

      await getScreenSize('test-udid');

      expect(fs.unlink).toHaveBeenCalled();
    });
  });
});
