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
// Build Functions
// =============================================================================

export {
  // Project detection
  detectProject,
  // Scheme/Target listing
  listSchemes,
  listTargets,
  // Build operations
  build,
  buildForTesting,
  // Derived data
  getDefaultDerivedDataPath,
  getDerivedDataPath,
  getBuiltAppPath,
  // Build settings
  getBuildSettings,
} from './build';
export type {
  ProjectType,
  XcodeProject,
  XcodeScheme,
  XcodeTarget,
  BuildOptions,
  BuildResult,
  BuildProgressCallback,
  BuildProgress,
} from './build';

// =============================================================================
// Test Functions
// =============================================================================

export {
  runTests,
  runUITests,
  parseTestResults,
  listTests,
} from './testing';
export type {
  TestRunOptions,
  TestCaseResult,
  PerformanceMetric,
  TestSuiteResult,
  TestRunResult,
  TestInfo,
  XCResultInfo,
} from './testing';

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
  // Real-time log streaming
  streamLog,
  stopLogStream,
  getActiveLogStreams,
  stopAllLogStreams,
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
// UI Inspection
// =============================================================================

export { inspect } from './inspect-simple';
export type {
  UIElement,
  InspectOptions,
  InspectResult,
} from './inspect-simple';

// =============================================================================
// UI Analysis
// =============================================================================

export {
  findElements,
  findElement,
  findByIdentifier,
  findByLabel,
  findByType,
  findByText,
  getInteractableElements,
  getButtons,
  getTextFields,
  getTextElements,
  getNavigationElements,
  isInteractable,
  isTextElement,
  getSuggestedAction,
  describeElement,
  getBestIdentifier,
  filterVisible,
  filterEnabled,
  filterActive,
  sortByPosition,
} from './ui-analyzer';
export type {
  ElementQuery,
  QueryResult,
  InteractableElement,
} from './ui-analyzer';

// =============================================================================
// Inspect Formatters
// =============================================================================

export {
  formatInspectForAgent,
  formatInspectAsJson,
  formatInspectAsElementList,
  formatInspectCompact,
} from './inspect-formatter';
export type {
  FormattedInspect,
  FormatOptions,
} from './inspect-formatter';

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

// =============================================================================
// Maestro CLI Integration
// =============================================================================

export {
  runMaestro,
  detectMaestroCli,
  isMaestroAvailable,
  getMaestroInfo,
  validateMaestroVersion,
  getInstallInstructions,
} from './maestro-cli';
export type {
  MaestroInfo,
  MaestroDetectResult,
} from './maestro-cli';

// =============================================================================
// Flow Generation
// =============================================================================

export {
  // Main generators
  generateFlow,
  generateFlowFile,
  generateFlowFromStrings,
  parseActionString,
  // Step helper functions (some suffixed with "Step" to avoid conflicts)
  tap,
  inputText,
  scroll,
  screenshotStep,
  assertVisible as assertVisibleStep,  // Renamed to avoid conflict with assertions
  assertNotVisible as assertNotVisibleStep,  // Renamed to avoid conflict with assertions
  waitForStep,
  swipe,
  launchAppStep,
  stopApp as stopAppStep,  // Also rename for consistency
  openLink,
  pressKey,
  hideKeyboard,
  eraseText,
  wait,
  copyTextFrom,
} from './flow-generator';
export type {
  // Step types
  FlowStep,
  FlowStepBase,
  TapStep,
  InputTextStep,
  ScrollStep,
  ScreenshotStep,
  AssertVisibleStep,
  AssertNotVisibleStep,
  WaitForStep,
  SwipeStep,
  LaunchAppStep,
  StopAppStep,
  OpenLinkStep,
  PressKeyStep,
  HideKeyboardStep,
  EraseTextStep,
  WaitStep,
  CopyTextStep,
  // Configuration types
  FlowConfig,
  FlowDefinition,
  GeneratedFlow,
} from './flow-generator';

// =============================================================================
// Flow Execution
// =============================================================================

export {
  runFlow,
  runFlowWithRetry,
  runFlows,
  validateFlow,
  validateFlowWithMaestro,
} from './flow-runner';
export type {
  FlowRunOptions,
  FlowRunWithRetryOptions,
  FlowStepResult,
  FlowRunResult,
  BatchFlowResult,
} from './flow-runner';

// =============================================================================
// Action Formatting
// =============================================================================

export {
  formatFlowResult,
  formatFlowResultAsJson,
  formatFlowResultCompact,
  formatBatchFlowResult,
  formatStepsTable,
  formatStatusBadge,
  formatDuration,
  formatProgressBar,
} from './action-formatter';
export type {
  FlowFormatOptions,
  FormattedFlowResult,
} from './action-formatter';

// =============================================================================
// Verification Infrastructure
// =============================================================================

export {
  pollUntil,
  withRetry,
  verifyWithPollingAndRetry,
  generateVerificationId,
  buildVerificationResult,
  createPassedResult,
  createFailedResult,
  createTimeoutResult,
  createErrorResult,
  calculateRetryDelay,
  mergePollingOptions,
  mergeRetryPolicy,
} from './verification';
export type {
  RetryPolicy,
  PollingOptions,
  AssertionBaseOptions,
  VerificationStatus,
  VerificationAttempt,
  VerificationResult,
  VerificationCheck,
} from './verification';

// =============================================================================
// Assertions
// =============================================================================

export {
  // Visibility assertions
  assertVisible,
  assertVisibleById,
  assertVisibleByLabel,
  assertVisibleByText,
  assertNotVisible,
  // Crash assertions
  assertNoCrash,
  hasCrashed,
  waitForNoCrash,
  assertNoCrashInWindow,
} from './assertions';
export type {
  // Visibility types
  ElementTarget,
  AssertVisibleOptions,
  VisibleAssertionData,
  // Crash types
  AssertNoCrashOptions,
  NoCrashAssertionData,
} from './assertions';

// =============================================================================
// Verification Formatting
// =============================================================================

export {
  formatVerificationResult,
  formatVerificationAsJson,
  formatVerificationCompact,
  formatVerificationBatch,
  formatDuration as formatVerificationDuration,
  formatProgressBar as formatVerificationProgressBar,
  formatStatusBadge as formatVerificationStatusBadge,
} from './verification-formatter';
export type {
  VerificationFormatOptions,
  FormattedVerification,
} from './verification-formatter';

// =============================================================================
// Feature Ship Loop
// =============================================================================

export {
  runShipLoop,
  formatShipLoopResult,
  formatShipLoopResultAsJson,
  formatShipLoopResultCompact,
} from './ship-loop';
export type {
  AssertionType,
  AssertionSpec,
  ShipLoopOptions,
  IterationResult,
  ShipLoopProgress,
  ShipLoopResult,
} from './ship-loop';
