/**
 * index.ts
 *
 * Barrel re-exports for the planning-pipeline CCPM mirror module.
 *
 * Public surface:
 *   - StageTransitionEntry, StageTransitionActor — audit-entry types
 *   - StageMirrorDeps                            — dependency-injection interface
 *   - AppendResult                               — return type of append functions
 *   - appendStageTransition()                    — record a stage move in the mirror
 *   - appendRetryEvent()                         — record a retry/dead-letter event
 */

export type { StageTransitionEntry, StageTransitionActor } from './stage-mirror-types';

export type { StageMirrorDeps, AppendResult } from './stage-mirror';
export { appendStageTransition, appendRetryEvent } from './stage-mirror';
