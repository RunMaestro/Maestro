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

// Simple inspection using simctl ui describe
export { inspect } from './inspect-simple';
export type {
  UIElement,
  InspectOptions,
  InspectResult,
} from './inspect-simple';

// XCUITest-based inspection (more detailed)
export { inspectWithXCUITest } from './inspect';
export type {
  XCUITestInspectOptions,
  XCUITestInspectResult,
  ElementNode,
  ElementFrame,
  AccessibilityWarning,
} from './inspect';

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
  getTextInputs,
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
  detectIssues,
  summarizeScreen,
} from './ui-analyzer';
export type {
  ElementQuery,
  QueryResult,
  InteractableElement,
  AccessibilityIssueType,
  AccessibilityIssue,
  AccessibilityIssueResult,
  ScreenSummary,
} from './ui-analyzer';

// =============================================================================
// Inspect Formatters
// =============================================================================

export {
  formatInspectForAgent,
  formatInspectAsJson,
  formatInspectAsElementList,
  formatInspectCompact,
  formatElementQuery,
  formatElementQueryTable,
  formatActionSuggestions,
} from './inspect-formatter';
export type {
  FormattedInspect,
  FormatOptions,
} from './inspect-formatter';

// =============================================================================
// Inspect Error Handling
// =============================================================================

export {
  detectInspectError,
  createAppNotRunningError,
  createAppCrashedError,
  createBuildFailedError,
  createSigningError,
  createDependencyMissingError,
  createTimeoutError,
  createEmptyUITreeError,
  createLoadingStateError,
  createGenericInspectError,
  formatInspectError,
  formatInspectErrorCompact,
  wrapInspectError,
  isInspectErrorType,
  isRecoverableError,
  getRetryDelay,
  analyzeInspectionOutput,
} from './inspect-errors';
export type {
  InspectErrorCode,
  InspectError,
} from './inspect-errors';

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
  parseXcodebuildOutput,
  waitFor,
  sleep,
  createError,
  createFailure,
  parseIOSVersionFromRuntime,
  parseDeviceTypeName,
} from './utils';
export type {
  BuildDiagnostic,
  BuildPhase,
  CompilationStep,
  LinkerStep,
  ParsedXcodebuildOutput,
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
  installMaestro,
  validateMaestroSetup,
} from './maestro-cli';
export type {
  MaestroInfo,
  MaestroDetectResult,
  MaestroInstallMethod,
  InstallMaestroOptions,
  InstallMaestroResult,
  MaestroSetupValidation,
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
  // Wait for assertions (renamed to avoid conflict with utils.waitFor)
  waitFor as waitForElement,
  waitForById as waitForElementById,
  waitForByLabel as waitForElementByLabel,
  waitForByText as waitForElementByText,
  waitForNot as waitForElementNot,
  waitForNotById as waitForElementNotById,
  waitForNotByLabel as waitForElementNotByLabel,
  waitForNotByText as waitForElementNotByText,
  // Text assertions
  assertText,
  assertTextById,
  assertTextByLabel,
  assertTextContains,
  assertTextMatches,
  assertTextStartsWith,
  assertTextEndsWith,
  // Value assertions
  assertValue,
  assertValueById,
  assertValueByLabel,
  assertValueContains,
  assertValueMatches,
  assertValueStartsWith,
  assertValueEndsWith,
  assertValueEmpty,
  assertValueNotEmpty,
  // Enabled/Disabled assertions
  assertEnabled,
  assertEnabledById,
  assertEnabledByLabel,
  assertEnabledByText,
  assertDisabled,
  assertDisabledById,
  assertDisabledByLabel,
  assertDisabledByText,
  // Selected assertions
  assertSelected,
  assertSelectedById,
  assertSelectedByLabel,
  assertSelectedByText,
  assertNotSelected,
  assertNotSelectedById,
  assertNotSelectedByLabel,
  assertNotSelectedByText,
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
  // Wait for types
  WaitForTarget,
  WaitForOptions,
  WaitForData,
  // Text assertion types
  TextMatchMode,
  TextElementTarget,
  AssertTextOptions,
  TextAssertionData,
  // Value assertion types
  ValueMatchMode,
  ValueElementTarget,
  AssertValueOptions,
  ValueAssertionData,
  // Enabled/Disabled assertion types
  EnabledElementTarget,
  AssertEnabledOptions,
  EnabledAssertionData,
  // Selected assertion types
  SelectedElementTarget,
  AssertSelectedOptions,
  SelectedAssertionData,
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

// =============================================================================
// Error Handling
// =============================================================================

export {
  ERROR_MESSAGES,
  ERROR_PATTERNS,
  formatErrorForUser,
  getTroubleshootingHint,
  detectErrorType,
  createUserFriendlyError,
  wrapCommandError,
  validateSimulatorBooted,
  validateBundleId,
  noBootedSimulatorError,
  simulatorNotFoundError,
  appNotInstalledError,
  permissionDeniedError,
  screenshotTimeoutError,
  logParsingWarning,
} from './errors';

// =============================================================================
// XCUITest Project Management
// =============================================================================

export {
  createInspectorProject,
  buildInspector,
  runInspector,
  parseInspectorOutput,
  cleanupInspectorProject,
  getCachedInspector,
  clearInspectorCache,
} from './xcuitest-project';
export type {
  CreateProjectOptions,
  CreateProjectResult,
  BuildInspectorOptions,
  BuildInspectorResult,
  RunInspectorOptions,
  RunInspectorResult,
} from './xcuitest-project';

// =============================================================================
// Native XCUITest Driver
// =============================================================================

export {
  // Driver class and factory
  NativeDriver,
  createNativeDriver,
  // Target helpers
  byId,
  byLabel,
  byText,
  byPredicate,
  byCoordinates,
  byType,
  // Action helpers
  tap as nativeTap,
  doubleTap as nativeDoubleTap,
  longPress as nativeLongPress,
  typeText as nativeTypeText,
  clearText as nativeClearText,
  scroll as nativeScroll,
  scrollTo as nativeScrollTo,
  swipe as nativeSwipe,
  pinch as nativePinch,
  rotate as nativeRotate,
  waitForElement as nativeWaitForElement,
  waitForNotExist as nativeWaitForNotExist,
  assertExists as nativeAssertExists,
  assertNotExists as nativeAssertNotExists,
  assertEnabled as nativeAssertEnabled,
  assertDisabled as nativeAssertDisabled,
} from './native-driver';
export type {
  ActionTarget as NativeActionTarget,
  SwipeDirection as NativeSwipeDirection,
  SwipeVelocity as NativeSwipeVelocity,
  ActionType as NativeActionType,
  ActionStatus as NativeActionStatus,
  ActionRequest as NativeActionRequest,
  ActionResult as NativeActionResult,
  BatchActionResult as NativeBatchActionResult,
  ElementInfo as NativeElementInfo,
  ActionDetails as NativeActionDetails,
  NativeDriverOptions,
} from './native-driver';

// =============================================================================
// Action Recording
// =============================================================================

export {
  // Session management (renamed to avoid conflicts with video recording)
  startRecording as startActionRecording,
  stopRecording as stopActionRecording,
  pauseRecording as pauseActionRecording,
  resumeRecording as resumeActionRecording,
  cancelRecording as cancelActionRecording,
  isRecordingActive as isActionRecordingActive,
  getCurrentSession as getActionRecordingSession,
  getRecordingStats as getActionRecordingStats,
  // Individual action recording
  recordTap,
  recordDoubleTap,
  recordLongPress,
  recordType,
  recordScroll,
  recordSwipe,
  recordLaunchApp,
  recordTerminateApp,
  recordScreenshot,
  annotateLastAction,
  // Conversion functions
  convertToFlowSteps,
  convertToNativeActions,
  exportToMaestroYaml,
  exportToNativeActions,
} from './action-recorder';
export type {
  RecordedActionType,
  RecordedAction,
  RecordedElement,
  RecordingOptions as ActionRecordingOptions,
  RecordingState as ActionRecordingState,
  RecordingSession as ActionRecordingSession,
  StopRecordingResult as StopActionRecordingResult,
  StopRecordingOptions as StopActionRecordingOptions,
} from './action-recorder';

// =============================================================================
// Action Validation
// =============================================================================

export {
  validateTarget,
  suggestAlternatives,
  checkHittable,
  validateForAction,
  targetExists,
  getElementCenter,
} from './action-validator';
export type {
  NotHittableReason,
  ValidationResult,
  SuggestedTarget,
  HittabilityResult,
  ValidationOptions,
} from './action-validator';

// =============================================================================
// Interaction Error Handling
// =============================================================================

export {
  // Error code mapping
  mapNotHittableReasonToCode,
  mapActionStatusToCode,
  // Error message constants
  INTERACTION_ERROR_MESSAGES,
  // Error creation functions
  createElementNotFoundError,
  createElementNotHittableError,
  createMaestroNotInstalledError,
  createFlowTimeoutError,
  createAppCrashedError as createInteractionAppCrashedError,  // Renamed to avoid conflict with inspect-errors
  createErrorFromActionResult,
  createErrorFromValidationResult,
  // Error formatting
  formatInteractionError,
  formatInteractionErrorAsJson,
  formatInteractionErrorCompact,
  // Utility functions
  formatTarget as formatActionTarget,  // Renamed to avoid ambiguity
  createIOSResultFromError,
  hasElementSuggestions,
  getBestSuggestion,
} from './interaction-errors';
export type {
  InteractionErrorCode,
  InteractionError,
} from './interaction-errors';
