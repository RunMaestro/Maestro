/**
 * index.ts
 *
 * Barrel export for the SLA tracking subsystem of the Planning Pipeline.
 *
 * Consumers should import from this barrel rather than the individual modules
 * to insulate against future internal reorganization.
 */

export type { StageDuration, SlaConfig, SlaBreach } from './sla-types';
export { SlaTracker } from './sla-tracker';
export type {
	NotificationSeverity,
	NotificationChannel,
	CheckAndNotifyResult,
} from './notification-emitter';
export { SlaBreachNotifier } from './notification-emitter';
export type { InFlightRecoveryItem, RecoveryDeps, RecoveryResult } from './restart-recovery';
export { recoverPipelineState } from './restart-recovery';
