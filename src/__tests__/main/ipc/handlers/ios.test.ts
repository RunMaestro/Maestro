/**
 * Tests for the iOS IPC handlers
 *
 * Tests verify that iOS snapshot and artifact IPC handlers
 * correctly delegate to ios-tools functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { registerIOSHandlers } from '../../../../main/ipc/handlers/ios';
import * as iosTools from '../../../../main/ios-tools';

// Mock electron's ipcMain and BrowserWindow
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
  },
}));

// Mock native driver class and functions
const mockExecute = vi.fn();
const mockNativeDriver = {
  execute: mockExecute,
  initialize: vi.fn(),
};

// Mock the ios-tools module
vi.mock('../../../../main/ios-tools', () => ({
  // Xcode
  detectXcode: vi.fn(),
  getXcodeVersion: vi.fn(),
  getXcodeInfo: vi.fn(),
  validateXcodeInstallation: vi.fn(),
  listSDKs: vi.fn(),
  // Simulator
  listSimulators: vi.fn(),
  getBootedSimulators: vi.fn(),
  getSimulator: vi.fn(),
  bootSimulator: vi.fn(),
  shutdownSimulator: vi.fn(),
  eraseSimulator: vi.fn(),
  // App
  installApp: vi.fn(),
  uninstallApp: vi.fn(),
  launchApp: vi.fn(),
  terminateApp: vi.fn(),
  getAppContainer: vi.fn(),
  openURL: vi.fn(),
  // Capture
  screenshot: vi.fn(),
  captureScreenshot: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  isRecording: vi.fn(),
  getScreenSize: vi.fn(),
  // Logs
  getSystemLog: vi.fn(),
  getSystemLogText: vi.fn(),
  getCrashLogs: vi.fn(),
  hasRecentCrashes: vi.fn(),
  getDiagnostics: vi.fn(),
  streamLog: vi.fn(),
  stopLogStream: vi.fn(),
  getActiveLogStreams: vi.fn(),
  stopAllLogStreams: vi.fn(),
  // Snapshot
  captureSnapshot: vi.fn(),
  formatSnapshotForAgent: vi.fn(),
  formatSnapshotAsJson: vi.fn(),
  // Artifacts
  getArtifactDirectory: vi.fn(),
  listSessionArtifacts: vi.fn(),
  pruneSessionArtifacts: vi.fn(),
  getSessionArtifactsSize: vi.fn(),
  // Inspect
  inspect: vi.fn(),
  formatInspectForAgent: vi.fn(),
  formatInspectAsJson: vi.fn(),
  formatInspectAsElementList: vi.fn(),
  formatInspectCompact: vi.fn(),
  // UI Analysis
  findElements: vi.fn(),
  findElement: vi.fn(),
  findByIdentifier: vi.fn(),
  findByLabel: vi.fn(),
  getInteractableElements: vi.fn(),
  getButtons: vi.fn(),
  getTextFields: vi.fn(),
  getTextElements: vi.fn(),
  describeElement: vi.fn(),
  getBestIdentifier: vi.fn(),
  // Maestro CLI
  detectMaestroCli: vi.fn(),
  isMaestroAvailable: vi.fn(),
  getMaestroInfo: vi.fn(),
  validateMaestroVersion: vi.fn(),
  getInstallInstructions: vi.fn(),
  // Flow
  generateFlow: vi.fn(),
  generateFlowFile: vi.fn(),
  generateFlowFromStrings: vi.fn(),
  parseActionString: vi.fn(),
  runFlow: vi.fn(),
  runFlowWithRetry: vi.fn(),
  runFlows: vi.fn(),
  validateFlow: vi.fn(),
  validateFlowWithMaestro: vi.fn(),
  formatFlowResult: vi.fn(),
  formatFlowResultAsJson: vi.fn(),
  formatFlowResultCompact: vi.fn(),
  formatBatchFlowResult: vi.fn(),
  // Assertions
  assertVisible: vi.fn(),
  assertVisibleById: vi.fn(),
  assertVisibleByLabel: vi.fn(),
  assertVisibleByText: vi.fn(),
  assertNotVisible: vi.fn(),
  assertNoCrash: vi.fn(),
  hasCrashed: vi.fn(),
  waitForNoCrash: vi.fn(),
  // Verification
  formatVerificationResult: vi.fn(),
  formatVerificationAsJson: vi.fn(),
  formatVerificationCompact: vi.fn(),
  formatVerificationBatch: vi.fn(),
  // Ship Loop
  runShipLoop: vi.fn(),
  formatShipLoopResult: vi.fn(),
  formatShipLoopResultAsJson: vi.fn(),
  formatShipLoopResultCompact: vi.fn(),
  // Testing
  runTests: vi.fn(),
  runUITests: vi.fn(),
  parseTestResults: vi.fn(),
  listTests: vi.fn(),
  // Native Driver
  createNativeDriver: vi.fn(() => mockNativeDriver),
  NativeDriver: vi.fn(() => mockNativeDriver),
  nativeTap: vi.fn((target, options) => ({ type: 'tap', target, ...options })),
  nativeDoubleTap: vi.fn((target) => ({ type: 'doubleTap', target })),
  nativeLongPress: vi.fn((target, duration) => ({ type: 'longPress', target, duration })),
  nativeTypeText: vi.fn((text, options) => ({ type: 'typeText', text, ...options })),
  nativeClearText: vi.fn((target) => ({ type: 'clearText', target })),
  nativeScroll: vi.fn((direction, options) => ({ type: 'scroll', direction, ...options })),
  nativeScrollTo: vi.fn((target, options) => ({ type: 'scrollTo', target, ...options })),
  nativeSwipe: vi.fn((direction, options) => ({ type: 'swipe', direction, ...options })),
  nativeWaitForElement: vi.fn((target, timeout) => ({ type: 'waitForElement', target, timeout })),
  nativeWaitForNotExist: vi.fn((target, timeout) => ({ type: 'waitForNotExist', target, timeout })),
  byId: vi.fn((id) => ({ type: 'identifier', value: id })),
  byLabel: vi.fn((label) => ({ type: 'label', value: label })),
  byCoordinates: vi.fn((x, y) => ({ type: 'coordinates', value: `${x},${y}` })),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('iOS IPC handlers', () => {
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Capture all registered handlers
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    // Register handlers
    registerIOSHandlers();
  });

  afterEach(() => {
    handlers.clear();
  });

  describe('registration', () => {
    it('should register all snapshot handlers', () => {
      const snapshotChannels = [
        'ios:snapshot:capture',
        'ios:snapshot:format',
        'ios:snapshot:formatJson',
        'ios:snapshot:list',
        'ios:snapshot:cleanup',
      ];

      for (const channel of snapshotChannels) {
        expect(handlers.has(channel), `Missing handler: ${channel}`).toBe(true);
      }
    });

    it('should register all artifact handlers', () => {
      const artifactChannels = [
        'ios:artifacts:getDirectory',
        'ios:artifacts:list',
        'ios:artifacts:prune',
        'ios:artifacts:size',
      ];

      for (const channel of artifactChannels) {
        expect(handlers.has(channel), `Missing handler: ${channel}`).toBe(true);
      }
    });
  });

  describe('ios:snapshot:capture', () => {
    it('should call captureSnapshot with options', async () => {
      const mockResult = {
        success: true,
        data: {
          id: 'snapshot-001',
          timestamp: new Date(),
          simulator: { udid: 'test-udid', name: 'iPhone 15', iosVersion: '17.0' },
          screenshot: { path: '/path/to/screenshot.png', size: 10000 },
          logs: { entries: [], counts: { error: 0, fault: 0, warning: 0, info: 0, debug: 0 } },
          crashes: { hasCrashes: false, reports: [] },
          artifactDir: '/path/to/artifacts',
        },
      };
      vi.mocked(iosTools.captureSnapshot).mockResolvedValue(mockResult as any);

      const handler = handlers.get('ios:snapshot:capture');
      const options = {
        udid: 'test-udid',
        sessionId: 'session-123',
        bundleId: 'com.example.app',
        logDuration: 120,
      };

      const result = await handler!({} as any, options);

      expect(iosTools.captureSnapshot).toHaveBeenCalledWith(options);
      expect(result).toEqual(mockResult);
    });

    it('should handle capture failure', async () => {
      const mockError = {
        success: false,
        error: 'No booted simulator found',
        errorCode: 'SIMULATOR_NOT_BOOTED',
      };
      vi.mocked(iosTools.captureSnapshot).mockResolvedValue(mockError as any);

      const handler = handlers.get('ios:snapshot:capture');
      const result = await handler!({} as any, { sessionId: 'session-123' });

      expect(result).toEqual(mockError);
    });
  });

  describe('ios:snapshot:list', () => {
    it('should call listSessionArtifacts and return snapshots', async () => {
      const mockSnapshots = ['snapshot-001', 'snapshot-002', 'snapshot-003'];
      vi.mocked(iosTools.listSessionArtifacts).mockResolvedValue(mockSnapshots);

      const handler = handlers.get('ios:snapshot:list');
      const result = await handler!({} as any, 'session-123');

      expect(iosTools.listSessionArtifacts).toHaveBeenCalledWith('session-123');
      expect(result).toEqual({ success: true, data: mockSnapshots });
    });

    it('should return empty array for new session', async () => {
      vi.mocked(iosTools.listSessionArtifacts).mockResolvedValue([]);

      const handler = handlers.get('ios:snapshot:list');
      const result = await handler!({} as any, 'new-session');

      expect(result).toEqual({ success: true, data: [] });
    });
  });

  describe('ios:snapshot:cleanup', () => {
    it('should call pruneSessionArtifacts with default keep count', async () => {
      vi.mocked(iosTools.pruneSessionArtifacts).mockResolvedValue(undefined);

      const handler = handlers.get('ios:snapshot:cleanup');
      const result = await handler!({} as any, 'session-123');

      expect(iosTools.pruneSessionArtifacts).toHaveBeenCalledWith('session-123', undefined);
      expect(result).toEqual({ success: true });
    });

    it('should call pruneSessionArtifacts with custom keep count', async () => {
      vi.mocked(iosTools.pruneSessionArtifacts).mockResolvedValue(undefined);

      const handler = handlers.get('ios:snapshot:cleanup');
      const result = await handler!({} as any, 'session-123', 10);

      expect(iosTools.pruneSessionArtifacts).toHaveBeenCalledWith('session-123', 10);
      expect(result).toEqual({ success: true });
    });
  });

  describe('ios:snapshot:format', () => {
    it('should format snapshot for agent output', async () => {
      const mockFormatted = {
        summary: 'iOS Snapshot captured',
        sections: { screenshot: 'Screenshot saved' },
        fullOutput: '## iOS Snapshot\n...',
      };
      vi.mocked(iosTools.formatSnapshotForAgent).mockReturnValue(mockFormatted as any);

      const handler = handlers.get('ios:snapshot:format');
      const mockSnapshotResult = { id: 'snapshot-001' };
      const result = await handler!({} as any, mockSnapshotResult);

      expect(iosTools.formatSnapshotForAgent).toHaveBeenCalledWith(mockSnapshotResult);
      expect(result).toEqual({ success: true, data: mockFormatted });
    });
  });

  describe('ios:snapshot:formatJson', () => {
    it('should format snapshot as JSON', async () => {
      const mockJson = { id: 'snapshot-001', timestamp: '2024-01-15T10:00:00Z' };
      vi.mocked(iosTools.formatSnapshotAsJson).mockReturnValue(mockJson as any);

      const handler = handlers.get('ios:snapshot:formatJson');
      const mockSnapshotResult = { id: 'snapshot-001' };
      const result = await handler!({} as any, mockSnapshotResult);

      expect(iosTools.formatSnapshotAsJson).toHaveBeenCalledWith(mockSnapshotResult);
      expect(result).toEqual({ success: true, data: mockJson });
    });
  });

  describe('ios:artifacts:getDirectory', () => {
    it('should return artifact directory path', async () => {
      const mockDir = '/path/to/ios-artifacts/session-123';
      vi.mocked(iosTools.getArtifactDirectory).mockResolvedValue(mockDir);

      const handler = handlers.get('ios:artifacts:getDirectory');
      const result = await handler!({} as any, 'session-123');

      expect(iosTools.getArtifactDirectory).toHaveBeenCalledWith('session-123');
      expect(result).toEqual({ success: true, data: mockDir });
    });
  });

  describe('ios:artifacts:list', () => {
    it('should return list of artifacts', async () => {
      const mockArtifacts = ['snapshot-001', 'snapshot-002'];
      vi.mocked(iosTools.listSessionArtifacts).mockResolvedValue(mockArtifacts);

      const handler = handlers.get('ios:artifacts:list');
      const result = await handler!({} as any, 'session-123');

      expect(iosTools.listSessionArtifacts).toHaveBeenCalledWith('session-123');
      expect(result).toEqual({ success: true, data: mockArtifacts });
    });
  });

  describe('ios:artifacts:prune', () => {
    it('should prune artifacts with default keep count', async () => {
      vi.mocked(iosTools.pruneSessionArtifacts).mockResolvedValue(undefined);

      const handler = handlers.get('ios:artifacts:prune');
      const result = await handler!({} as any, 'session-123');

      expect(iosTools.pruneSessionArtifacts).toHaveBeenCalledWith('session-123', undefined);
      expect(result).toEqual({ success: true });
    });

    it('should prune artifacts with custom keep count', async () => {
      vi.mocked(iosTools.pruneSessionArtifacts).mockResolvedValue(undefined);

      const handler = handlers.get('ios:artifacts:prune');
      const result = await handler!({} as any, 'session-123', 25);

      expect(iosTools.pruneSessionArtifacts).toHaveBeenCalledWith('session-123', 25);
      expect(result).toEqual({ success: true });
    });
  });

  describe('ios:artifacts:size', () => {
    it('should return total size of artifacts', async () => {
      vi.mocked(iosTools.getSessionArtifactsSize).mockResolvedValue(1048576);

      const handler = handlers.get('ios:artifacts:size');
      const result = await handler!({} as any, 'session-123');

      expect(iosTools.getSessionArtifactsSize).toHaveBeenCalledWith('session-123');
      expect(result).toEqual({ success: true, data: 1048576 });
    });

    it('should return 0 for empty session', async () => {
      vi.mocked(iosTools.getSessionArtifactsSize).mockResolvedValue(0);

      const handler = handlers.get('ios:artifacts:size');
      const result = await handler!({} as any, 'empty-session');

      expect(result).toEqual({ success: true, data: 0 });
    });
  });

  // ===========================================================================
  // Native Driver Action Handlers
  // ===========================================================================

  describe('ios:action:tap', () => {
    beforeEach(() => {
      mockExecute.mockReset();
    });

    it('should register the ios:action:tap handler', () => {
      expect(handlers.has('ios:action:tap')).toBe(true);
    });

    it('should create a native driver and execute a tap action', async () => {
      const mockResult = {
        success: true,
        data: {
          success: true,
          status: 'success',
          actionType: 'tap',
          duration: 150,
          timestamp: '2024-01-15T10:00:00Z',
        },
      };
      mockExecute.mockResolvedValue(mockResult);

      const handler = handlers.get('ios:action:tap');
      const options = {
        bundleId: 'com.example.app',
        udid: 'test-udid',
        target: { type: 'identifier', value: 'loginButton' },
      };

      const result = await handler!({} as any, options);

      expect(iosTools.createNativeDriver).toHaveBeenCalledWith({
        bundleId: 'com.example.app',
        udid: 'test-udid',
        timeout: undefined,
        screenshotDir: undefined,
        debug: undefined,
      });
      expect(iosTools.nativeTap).toHaveBeenCalledWith(options.target, {
        offsetX: undefined,
        offsetY: undefined,
      });
      expect(mockExecute).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('should execute a double tap when double option is true', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:tap');
      const options = {
        bundleId: 'com.example.app',
        target: { type: 'label', value: 'Submit' },
        double: true,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeDoubleTap).toHaveBeenCalledWith(options.target);
      expect(iosTools.nativeTap).not.toHaveBeenCalled();
    });

    it('should execute a long press when long option is true', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:tap');
      const options = {
        bundleId: 'com.example.app',
        target: { type: 'identifier', value: 'item' },
        long: true,
        longDuration: 2.0,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeLongPress).toHaveBeenCalledWith(options.target, 2.0);
      expect(iosTools.nativeTap).not.toHaveBeenCalled();
    });

    it('should use default duration of 1.0 for long press', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:tap');
      const options = {
        bundleId: 'com.example.app',
        target: { type: 'identifier', value: 'item' },
        long: true,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeLongPress).toHaveBeenCalledWith(options.target, 1.0);
    });

    it('should pass offset options to tap', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:tap');
      const options = {
        bundleId: 'com.example.app',
        target: { type: 'identifier', value: 'button' },
        offsetX: 10,
        offsetY: -5,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeTap).toHaveBeenCalledWith(options.target, {
        offsetX: 10,
        offsetY: -5,
      });
    });
  });

  describe('ios:action:type', () => {
    beforeEach(() => {
      mockExecute.mockReset();
    });

    it('should register the ios:action:type handler', () => {
      expect(handlers.has('ios:action:type')).toBe(true);
    });

    it('should create a native driver and execute a type action', async () => {
      const mockResult = {
        success: true,
        data: {
          success: true,
          status: 'success',
          actionType: 'typeText',
          duration: 200,
          timestamp: '2024-01-15T10:00:00Z',
        },
      };
      mockExecute.mockResolvedValue(mockResult);

      const handler = handlers.get('ios:action:type');
      const options = {
        bundleId: 'com.example.app',
        text: 'Hello World',
      };

      const result = await handler!({} as any, options);

      expect(iosTools.createNativeDriver).toHaveBeenCalledWith({
        bundleId: 'com.example.app',
        udid: undefined,
        timeout: undefined,
        screenshotDir: undefined,
        debug: undefined,
      });
      expect(iosTools.nativeTypeText).toHaveBeenCalledWith('Hello World', {
        target: undefined,
        clearFirst: undefined,
      });
      expect(result).toEqual(mockResult);
    });

    it('should pass target and clearFirst options', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:type');
      const target = { type: 'identifier', value: 'emailField' };
      const options = {
        bundleId: 'com.example.app',
        text: 'test@example.com',
        target,
        clearFirst: true,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeTypeText).toHaveBeenCalledWith('test@example.com', {
        target,
        clearFirst: true,
      });
    });
  });

  describe('ios:action:scroll', () => {
    beforeEach(() => {
      mockExecute.mockReset();
    });

    it('should register the ios:action:scroll handler', () => {
      expect(handlers.has('ios:action:scroll')).toBe(true);
    });

    it('should execute a scroll in direction', async () => {
      const mockResult = {
        success: true,
        data: {
          success: true,
          status: 'success',
          actionType: 'scroll',
          duration: 300,
          timestamp: '2024-01-15T10:00:00Z',
        },
      };
      mockExecute.mockResolvedValue(mockResult);

      const handler = handlers.get('ios:action:scroll');
      const options = {
        bundleId: 'com.example.app',
        direction: 'down',
        distance: 0.5,
      };

      const result = await handler!({} as any, options);

      expect(iosTools.nativeScroll).toHaveBeenCalledWith('down', {
        target: undefined,
        distance: 0.5,
      });
      expect(result).toEqual(mockResult);
    });

    it('should default to down direction when not specified', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:scroll');
      const options = {
        bundleId: 'com.example.app',
      };

      await handler!({} as any, options);

      expect(iosTools.nativeScroll).toHaveBeenCalledWith('down', {
        target: undefined,
        distance: undefined,
      });
    });

    it('should execute scrollTo when scrollToTarget is provided', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:scroll');
      const scrollToTarget = { type: 'identifier', value: 'bottomElement' };
      const options = {
        bundleId: 'com.example.app',
        scrollToTarget,
        maxAttempts: 5,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeScrollTo).toHaveBeenCalledWith(scrollToTarget, {
        direction: undefined,
        maxAttempts: 5,
      });
      expect(iosTools.nativeScroll).not.toHaveBeenCalled();
    });
  });

  describe('ios:action:swipe', () => {
    beforeEach(() => {
      mockExecute.mockReset();
    });

    it('should register the ios:action:swipe handler', () => {
      expect(handlers.has('ios:action:swipe')).toBe(true);
    });

    it('should execute a swipe action', async () => {
      const mockResult = {
        success: true,
        data: {
          success: true,
          status: 'success',
          actionType: 'swipe',
          duration: 150,
          timestamp: '2024-01-15T10:00:00Z',
        },
      };
      mockExecute.mockResolvedValue(mockResult);

      const handler = handlers.get('ios:action:swipe');
      const options = {
        bundleId: 'com.example.app',
        direction: 'left',
        velocity: 'fast',
      };

      const result = await handler!({} as any, options);

      expect(iosTools.nativeSwipe).toHaveBeenCalledWith('left', {
        target: undefined,
        velocity: 'fast',
      });
      expect(result).toEqual(mockResult);
    });

    it('should pass target to swipe', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:swipe');
      const target = { type: 'identifier', value: 'carousel' };
      const options = {
        bundleId: 'com.example.app',
        direction: 'right',
        target,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeSwipe).toHaveBeenCalledWith('right', {
        target,
        velocity: undefined,
      });
    });
  });

  describe('ios:action:wait', () => {
    beforeEach(() => {
      mockExecute.mockReset();
    });

    it('should register the ios:action:wait handler', () => {
      expect(handlers.has('ios:action:wait')).toBe(true);
    });

    it('should execute a wait for element action', async () => {
      const mockResult = {
        success: true,
        data: {
          success: true,
          status: 'success',
          actionType: 'waitForElement',
          duration: 1000,
          timestamp: '2024-01-15T10:00:00Z',
        },
      };
      mockExecute.mockResolvedValue(mockResult);

      const handler = handlers.get('ios:action:wait');
      const target = { type: 'identifier', value: 'loadingSpinner' };
      const options = {
        bundleId: 'com.example.app',
        target,
        timeout: 5000,
      };

      const result = await handler!({} as any, options);

      expect(iosTools.nativeWaitForElement).toHaveBeenCalledWith(target, 5000);
      expect(result).toEqual(mockResult);
    });

    it('should execute wait for not exist when waitForNotExist is true', async () => {
      mockExecute.mockResolvedValue({ success: true, data: {} });

      const handler = handlers.get('ios:action:wait');
      const target = { type: 'identifier', value: 'loadingSpinner' };
      const options = {
        bundleId: 'com.example.app',
        target,
        waitForNotExist: true,
        timeout: 10000,
      };

      await handler!({} as any, options);

      expect(iosTools.nativeWaitForNotExist).toHaveBeenCalledWith(target, 10000);
      expect(iosTools.nativeWaitForElement).not.toHaveBeenCalled();
    });
  });

  describe('native driver action handler registration', () => {
    it('should register all native driver action handlers', () => {
      const actionChannels = [
        'ios:action:tap',
        'ios:action:type',
        'ios:action:scroll',
        'ios:action:swipe',
        'ios:action:wait',
      ];

      for (const channel of actionChannels) {
        expect(handlers.has(channel), `Missing handler: ${channel}`).toBe(true);
      }
    });
  });
});
