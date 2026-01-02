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
