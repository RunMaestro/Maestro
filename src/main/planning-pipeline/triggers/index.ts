/**
 * index.ts
 *
 * Barrel re-exports for Planning Pipeline trigger handlers.
 *
 * Handler catalogue:
 *   - prd-to-epic-trigger           (#247) — prd-finalized → epic-decomposed
 *   - tasks-agent-ready-trigger     (#248) — epic-decomposed → tasks-decomposed
 *   - agent-ready-claim-trigger     (#249) — * → agent-ready
 *   - pr-quality-gate-trigger       (#250) — runner-active → needs-review
 *   - review-runner-trigger         (#251) — * → needs-review (review agent launch)
 *   - serialized-merge-trigger      (#252) — review-approved → fork-merged (serialized)
 *   - doc-gap-auto-promote-trigger  (#257) — workGraph.item.created (living-wiki-doc-gap) → planner task
 */

export { createPrdToEpicTrigger, registerPrdToEpicTrigger } from './prd-to-epic-trigger';
export type {
	PrdToEpicTriggerDeps,
	PrdToEpicPlannerService,
	GetActor,
} from './prd-to-epic-trigger';

export {
	createTasksAgentReadyTrigger,
	registerTasksAgentReadyTrigger,
} from './tasks-agent-ready-trigger';
export type { TasksAgentReadyTriggerDeps } from './tasks-agent-ready-trigger';

export {
	createAgentReadyClaimTrigger,
	registerAgentReadyClaimTrigger,
	AGENT_READY_PREDECESSORS,
} from './agent-ready-claim-trigger';
export type {
	AgentReadyClaimEngine,
	AgentReadyClaimTriggerDeps,
} from './agent-ready-claim-trigger';

export {
	createPrQualityGateTrigger,
	registerPrQualityGateTrigger,
} from './pr-quality-gate-trigger';
export type {
	QualityGateChecker,
	QualityGateCheckResult,
	QualityGateCheckResultPayload,
	PrQualityGateTriggerDeps,
} from './pr-quality-gate-trigger';

export {
	createReviewRunnerTrigger,
	registerReviewRunnerTrigger,
	NEEDS_REVIEW_PREDECESSORS,
} from './review-runner-trigger';
export type {
	ReviewerLauncher,
	ReviewerLaunchArgs,
	ReviewerLaunchResult,
	ReviewRunnerTriggerDeps,
} from './review-runner-trigger';

export {
	createSerializedMergeTrigger,
	registerSerializedMergeTrigger,
	FORK_MERGED_PREDECESSORS,
} from './serialized-merge-trigger';
export type {
	MergeRunner,
	MergeRunResult,
	SerializedMergeTriggerDeps,
} from './serialized-merge-trigger';

export {
	createDocGapAutoPromoteSubscriber,
	registerDocGapAutoPromote,
} from './doc-gap-auto-promote-trigger';
export type {
	DocGapAutoPromoteDeps,
	DocGapAutoPromotePlannerService,
	DocGapAutoPromoteEventBus,
} from './doc-gap-auto-promote-trigger';
