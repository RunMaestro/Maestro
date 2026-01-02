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
});
