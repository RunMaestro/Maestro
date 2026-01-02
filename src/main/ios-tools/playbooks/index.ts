/**
 * iOS Playbooks Module
 *
 * Exports all iOS playbook executors for automated workflows.
 */

// Feature Ship Loop Playbook
export {
  runFeatureShipLoop,
  formatFeatureShipLoopResult,
  formatFeatureShipLoopResultAsJson,
  formatFeatureShipLoopResultCompact,
} from './feature-ship-loop';

export type {
  PlaybookAssertion,
  FeatureShipLoopInputs,
  FeatureShipLoopOptions,
  FeatureShipLoopProgress,
  FeatureShipLoopIterationResult,
  FeatureShipLoopResult,
} from './feature-ship-loop';

// Regression Check Playbook
export {
  runRegressionCheck,
  formatRegressionCheckResult,
  formatRegressionCheckResultAsJson,
  formatRegressionCheckResultCompact,
} from './regression-check';

export type {
  RegressionFlow,
  RegressionCheckInputs,
  RegressionCheckOptions,
  RegressionCheckProgress,
  ScreenshotComparisonResult,
  RegressionFlowResult,
  RegressionCheckResult,
} from './regression-check';

// Crash Hunt Playbook
export {
  runCrashHunt,
  formatCrashHuntResult,
  formatCrashHuntResultAsJson,
  formatCrashHuntResultCompact,
} from './crash-hunt';

export type {
  ActionWeights,
  CrashHuntInputs,
  CrashHuntOptions,
  CrashHuntProgress,
  RecordedAction,
  CrashDetection,
  CrashHuntResult,
} from './crash-hunt';

// Design Review Playbook
export {
  runDesignReview,
  formatDesignReviewResult,
  formatDesignReviewResultAsJson,
  formatDesignReviewResultCompact,
} from './design-review';

export type {
  DesignScreen,
  DesignReviewInputs,
  DesignReviewOptions,
  DesignReviewProgress,
  ScreenCaptureResult,
  DeviceResult,
  DesignReviewResult,
} from './design-review';

// Performance Check Playbook
export {
  runPerformanceCheck,
  formatPerformanceCheckResult,
  formatPerformanceCheckResultAsJson,
  formatPerformanceCheckResultCompact,
} from './performance-check';

export type {
  PerformanceFlow,
  PerformanceCheckInputs,
  PerformanceCheckOptions,
  PerformanceCheckProgress,
  LaunchTimeMeasurement,
  MemorySample,
  FrameRateSample,
  CpuSample,
  FlowMetrics,
  PerformanceRegression,
  PerformanceMetrics,
  PerformanceBaseline,
  PerformanceCheckResult,
} from './performance-check';
