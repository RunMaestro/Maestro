/**
 * iOS Tools - Main Module Exports
 *
 * Central export point for all iOS tooling functionality.
 * This module provides a clean API for:
 * - Xcode detection and validation
 * - Simulator management
 * - Screenshot and video capture
 * - Log collection
 */

// =============================================================================
// Type Exports
// =============================================================================

export * from './types';

// =============================================================================
// Xcode Functions
// =============================================================================

export {
  detectXcode,
  getXcodeVersion,
  validateXcodeInstallation,
  getXcodeInfo,
  listSDKs,
} from './xcode';

// =============================================================================
// Simulator Functions
// =============================================================================

export {
  // Listing
  listSimulators,
  listSimulatorsByRuntime,
  getBootedSimulators,
  getSimulator,
  // Lifecycle
  bootSimulator,
  waitForSimulatorBoot,
  shutdownSimulator,
  eraseSimulator,
  // App Installation
  installApp,
  uninstallApp,
  // App Lifecycle
  launchApp,
  terminateApp,
  // App Data
  getAppContainer,
  // Deep Links
  openURL,
} from './simulator';

// =============================================================================
// Capture Functions
// =============================================================================

export {
  screenshot,
  captureScreenshot,
  startRecording,
  stopRecording,
  isRecording,
  getScreenSize,
} from './capture';

// =============================================================================
// Log Functions
// =============================================================================

export {
  getSystemLog,
  getSystemLogText,
  getCrashLogs,
  getDiagnostics,
  hasRecentCrashes,
} from './logs';

// =============================================================================
// Snapshot Functions
// =============================================================================

export { captureSnapshot } from './snapshot';
export type { SnapshotOptions, SnapshotResult } from './snapshot';

// =============================================================================
// Snapshot Formatters
// =============================================================================

export {
  formatSnapshotForAgent,
  formatSnapshotAsJson,
  summarizeLog,
} from './snapshot-formatter';
export type { FormattedSnapshot } from './snapshot-formatter';

// =============================================================================
// Artifact Management
// =============================================================================

export {
  getArtifactDirectory,
  getSnapshotDirectory,
  generateSnapshotId,
  listSessionArtifacts,
  pruneSessionArtifacts,
  getSessionArtifactsSize,
} from './artifacts';

// =============================================================================
// Utility Functions
// =============================================================================

export {
  runSimctl,
  runXcrun,
  runXcodeSelect,
  runXcodebuild,
  parseSimctlJson,
  parseJson,
  waitFor,
  sleep,
  createError,
  createFailure,
  parseIOSVersionFromRuntime,
  parseDeviceTypeName,
} from './utils';
