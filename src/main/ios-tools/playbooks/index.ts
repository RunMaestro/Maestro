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
