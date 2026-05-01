import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import type {
	AgentDispatchAssignmentDecision,
	AgentDispatchFleetEntry,
	AgentReadyWorkFilter,
	WorkItem,
	WorkItemClaimInput,
	WorkItemOwner,
} from '../../shared/agent-dispatch-types';
import type {
	WorkGraphActor,
	WorkGraphBroadcastEnvelope,
	WorkGraphListResult,
	WorkItemPipeline,
} from '../../shared/work-graph-types';
import type { DispatchRole } from '../../shared/project-roles-types';
import type { FleetRegistry } from './fleet-registry';
import { isAgentEligibleForPickup, selectAutoPickupAssignments } from './assignment-policy';
import {
	AUTO_PICKUP_FLEET_EVENTS,
	type AgentDispatchAutoPickupTrigger,
	getAutoPickupTriggerForFleetEvent,
	isAutoPickupRelevantWorkGraphEvent,
} from './events';
import { nextRole, isTerminal, type PipelineEvent } from './state-machine';

const execFile = promisify(execFileCallback);

export interface AgentDispatchWorkGraphStore {
	getUnblockedWorkItems(filters?: AgentReadyWorkFilter): Promise<WorkGraphListResult>;
	claimItem(input: WorkItemClaimInput, actor?: WorkGraphActor): Promise<WorkItem>;
	/**
	 * Persist a pipeline state update for a work item.
	 * Called by `advancePipeline` after a role completes its stage.
	 * Implementations must update `pipeline` on the stored item and broadcast
	 * the change so other subsystems (renderer, MCP) see the new role.
	 */
	updatePipeline?(
		workItemId: string,
		pipeline: WorkItemPipeline,
		actor?: WorkGraphActor
	): Promise<WorkItem>;
}

export interface AutoPickupExecution {
	decision: AgentDispatchAssignmentDecision;
	claimedItem: WorkItem;
}

export interface AgentDispatchEngineOptions {
	workGraph: AgentDispatchWorkGraphStore;
	fleetRegistry: FleetRegistry;
	executeClaim?: (execution: AutoPickupExecution) => void | Promise<void>;
	maxAssignmentsPerRun?: number;
	queryLimit?: number;
	/**
	 * Optional callback to check whether a role slot is enabled for new work.
	 *
	 * Called before auto-pickup and manual assignment.  If the slot is disabled
	 * (drain mode) the engine rejects the attempt without touching the claim
	 * — currently-running work is not interrupted.
	 *
	 * @param projectPath - the project the work item belongs to
	 * @param role        - the pipeline role being claimed
	 * @param agentId     - the fleet agent's Session.id
	 * @returns `true` when the slot is active; `false` when in drain mode
	 */
	isSlotEnabled?: (projectPath: string, role: DispatchRole, agentId: string) => boolean;
}

export interface AutoPickupRunResult {
	trigger: AgentDispatchAutoPickupTrigger;
	queried: number;
	selected: number;
	claimed: number;
	skipped: number;
	errors: Array<{ workItemId: string; agentId: string; message: string }>;
}

export interface ManualAssignmentInput {
	workItemId: string;
	/** The full work item — needed for role eligibility checks (#427). */
	workItem: WorkItem;
	agent: AgentDispatchFleetEntry;
	userInitiated: boolean;
	note?: string;
	expiresAt?: string;
	actor?: WorkGraphActor;
	expectedUpdatedAt?: string;
}

/**
 * Structured error returned when a manual assignment is rejected because the
 * fleet entry's roles do not include the work item's current pipeline role.
 */
export interface RoleEligibilityError {
	code: 'ROLE_NOT_ELIGIBLE';
	workItemId: string;
	workItemCurrentRole: string;
	agentId: string;
	agentRoles: string[];
	message: string;
}

export function isRoleEligibilityError(value: unknown): value is RoleEligibilityError {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as RoleEligibilityError).code === 'ROLE_NOT_ELIGIBLE'
	);
}

/**
 * Structured error returned when a manual assignment is rejected because the
 * work item is in `backlog` status (#439).  Backlog items are unapproved and
 * must be explicitly promoted before any agent can pick them up.
 */
export interface BacklogStatusError {
	code: 'BACKLOG_STATUS';
	workItemId: string;
	message: string;
}

export function isBacklogStatusError(value: unknown): value is BacklogStatusError {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as BacklogStatusError).code === 'BACKLOG_STATUS'
	);
}

/**
 * Structured error returned when a manual assignment is rejected because the
 * target role slot has been disabled (drain mode) by the user (#437).
 */
export interface SlotDisabledError {
	code: 'SLOT_DISABLED';
	role: string;
	slotAgentId: string;
	message: string;
}

export function isSlotDisabledError(value: unknown): value is SlotDisabledError {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as SlotDisabledError).code === 'SLOT_DISABLED'
	);
}

/**
 * Structured error returned when a runner-role assignment is rejected because
 * the agent is SSH-remote (#440). Runner agents must execute locally.
 */
export interface RunnerRequiresLocalError {
	code: 'RUNNER_REQUIRES_LOCAL';
	workItemId: string;
	agentId: string;
	detail: string;
}

export function isRunnerRequiresLocalError(value: unknown): value is RunnerRequiresLocalError {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as RunnerRequiresLocalError).code === 'RUNNER_REQUIRES_LOCAL'
	);
}

/**
 * Structured error returned when a runner-role assignment is rejected because
 * the agent's cwd or git remote doesn't match the work item's project (#440).
 * Runners must operate inside the project's local checkout.
 */
export interface RunnerProjectMismatchError {
	code: 'RUNNER_PROJECT_MISMATCH';
	workItemId: string;
	agentId: string;
	expectedProjectPath?: string;
	actualProjectPath?: string;
	expectedRemote?: string;
	actualRemote?: string;
	detail: string;
}

export function isRunnerProjectMismatchError(value: unknown): value is RunnerProjectMismatchError {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as RunnerProjectMismatchError).code === 'RUNNER_PROJECT_MISMATCH'
	);
}

export class AgentDispatchEngine {
	private running = false;
	private rerunRequested = false;

	constructor(private readonly options: AgentDispatchEngineOptions) {}

	bindFleetRegistry(): () => void {
		const unsubscribers = AUTO_PICKUP_FLEET_EVENTS.map((eventType) => {
			const handler = () => {
				const trigger = getAutoPickupTriggerForFleetEvent(eventType);
				if (trigger) {
					void this.runAutoPickup(trigger);
				}
			};
			this.options.fleetRegistry.on(eventType, handler);
			return () => this.options.fleetRegistry.off(eventType, handler);
		});

		return () => {
			for (const unsubscribe of unsubscribers) {
				unsubscribe();
			}
		};
	}

	handleWorkGraphEvent(event: WorkGraphBroadcastEnvelope): void {
		if (isAutoPickupRelevantWorkGraphEvent(event)) {
			void this.runAutoPickup('work-graph-ready-work-changed');
		}
	}

	async runAutoPickup(
		trigger: AgentDispatchAutoPickupTrigger = 'manual'
	): Promise<AutoPickupRunResult> {
		if (this.running) {
			this.rerunRequested = true;
			return {
				trigger,
				queried: 0,
				selected: 0,
				claimed: 0,
				skipped: 0,
				errors: [],
			};
		}

		this.running = true;
		this.rerunRequested = false;

		try {
			const result = await this.runAutoPickupOnce(trigger);
			if (this.rerunRequested) {
				this.rerunRequested = false;
				await this.runAutoPickupOnce('manual');
			}
			return result;
		} finally {
			this.running = false;
		}
	}

	/**
	 * Manually assign a work item to a specific fleet agent.
	 *
	 * Backlog gate (#439): items with `status === 'backlog'` are unapproved and
	 * are hard-blocked from both auto-pickup and manual assignment.  Promote the
	 * item out of backlog first (e.g. via `/PM prd-new` finalise or planner
	 * decompose) before assigning it.
	 *
	 * Role enforcement (#427): when the work item has a `pipeline` field, the
	 * agent's `dispatchProfile.roles` must include `pipeline.currentRole`.
	 * Returns a structured error (not a thrown exception) so the renderer can
	 * surface a human-readable message rather than catching a generic error.
	 */
	async assignManually(
		input: ManualAssignmentInput
	): Promise<WorkItem | RoleEligibilityError | BacklogStatusError | SlotDisabledError> {
		if (!input.userInitiated) {
			throw new Error('Manual assignment requires an explicit user-initiated action');
		}

		// Backlog gate (#439) — hard-block before any other checks.
		if (input.workItem.status === 'backlog') {
			return {
				code: 'BACKLOG_STATUS',
				workItemId: input.workItemId,
				message:
					`Work item '${input.workItemId}' is in backlog and cannot be assigned. ` +
					`Promote it out of backlog before assigning.`,
			};
		}

		// Role gate — only applies when the item has a pipeline with a currentRole
		if (input.workItem.pipeline) {
			const currentRole = input.workItem.pipeline.currentRole;
			const agentRoles = input.agent.dispatchProfile.roles ?? [];
			if (!agentRoles.includes(currentRole)) {
				return {
					code: 'ROLE_NOT_ELIGIBLE',
					workItemId: input.workItemId,
					workItemCurrentRole: currentRole,
					agentId: input.agent.id,
					agentRoles,
					message:
						`Agent '${input.agent.displayName}' (roles: [${agentRoles.join(', ') || 'none'}]) ` +
						`is not eligible for the '${currentRole}' role on work item '${input.workItemId}'.`,
				};
			}

			// Slot drain-mode gate (#437) — check after role eligibility so the role
			// error takes precedence when both conditions fail simultaneously.
			if (this.options.isSlotEnabled) {
				const projectPath = input.workItem.projectPath ?? '';
				if (
					projectPath &&
					!this.options.isSlotEnabled(projectPath, currentRole as DispatchRole, input.agent.id)
				) {
					return {
						code: 'SLOT_DISABLED',
						role: currentRole,
						slotAgentId: input.agent.id,
						message:
							`Slot for role '${currentRole}' is disabled (drain mode). ` +
							`New assignments are paused; the current item will complete normally.`,
					};
				}
			}
		}

		return this.options.workGraph.claimItem(
			{
				workItemId: input.workItemId,
				owner: toOwner(input.agent),
				source: 'manual',
				note: input.note,
				expiresAt: input.expiresAt,
				expectedUpdatedAt: input.expectedUpdatedAt,
			},
			input.actor ?? {
				type: 'user',
				id: input.agent.id,
				name: input.agent.displayName,
				agentId: input.agent.agentId,
				providerSessionId: input.agent.providerSessionId,
			}
		);
	}

	/**
	 * Advance the pipeline for a work item after its current role completes.
	 *
	 * Called when an agent signals completion via `pm:setStatus` (#430).
	 * - Computes the next pipeline state via the state machine.
	 * - Persists the update via `workGraph.updatePipeline` (if the store
	 *   supports it — stores without the method are treated as no-op to allow
	 *   gradual migration).
	 * - Returns `null` if the work item has no pipeline (non-role-gated items).
	 * - Returns the updated work item on success.
	 */
	async advancePipeline(
		workItem: WorkItem,
		event: PipelineEvent,
		actor?: WorkGraphActor
	): Promise<WorkItem | null> {
		if (!workItem.pipeline) {
			return null;
		}

		const updatedPipeline = nextRole(workItem.pipeline, event);

		if (!this.options.workGraph.updatePipeline) {
			// Store does not yet support pipeline persistence — return a synthetic item
			// so callers can still reason about the next state without crashing.
			return { ...workItem, pipeline: updatedPipeline };
		}

		return this.options.workGraph.updatePipeline(workItem.id, updatedPipeline, actor);
	}

	/**
	 * Returns true when the pipeline has reached its terminal state
	 * (merger-done), indicating the item can be marked 'done'.
	 */
	isPipelineTerminal(workItem: WorkItem): boolean {
		if (!workItem.pipeline) {
			return false;
		}
		return isTerminal(workItem.pipeline);
	}

	private async runAutoPickupOnce(
		trigger: AgentDispatchAutoPickupTrigger
	): Promise<AutoPickupRunResult> {
		const fleet = this.options.fleetRegistry.getEntries();
		const eligibleFleet = fleet.filter(isAgentEligibleForPickup);
		if (eligibleFleet.length === 0) {
			return { trigger, queried: 0, selected: 0, claimed: 0, skipped: 0, errors: [] };
		}

		// TODO #433: simplify under 4-slot model; capabilityTags is deprecated
		const capabilityTags = uniqueSorted(
			eligibleFleet.flatMap((entry) => entry.dispatchCapabilities)
		);
		const readyWork = await this.options.workGraph.getUnblockedWorkItems({
			excludeClaimed: true,
			capabilityTags,
			limit: this.options.queryLimit,
		});
		const decisions = selectAutoPickupAssignments({
			workItems: readyWork.items,
			fleet: eligibleFleet,
			maxAssignments: this.options.maxAssignmentsPerRun,
		});
		const result: AutoPickupRunResult = {
			trigger,
			queried: readyWork.items.length,
			selected: decisions.length,
			claimed: 0,
			skipped: 0,
			errors: [],
		};

		for (const decision of decisions) {
			// Slot drain-mode gate (#437): skip auto-pickup when the role slot is
			// disabled.  The item is left unclaimed so it can be picked up once the
			// slot is re-enabled or reassigned.
			if (this.options.isSlotEnabled && decision.workItem.pipeline) {
				const projectPath = decision.workItem.projectPath ?? '';
				const currentRole = decision.workItem.pipeline.currentRole as DispatchRole;
				if (
					projectPath &&
					!this.options.isSlotEnabled(projectPath, currentRole, decision.agent.id)
				) {
					result.skipped += 1;
					continue;
				}
			}

			const claimedItem = await this.tryClaim(decision, result);
			if (!claimedItem) {
				continue;
			}

			result.claimed += 1;
			if (this.options.executeClaim) {
				await this.options.executeClaim({ decision, claimedItem });
			}
		}

		return result;
	}

	private async tryClaim(
		decision: AgentDispatchAssignmentDecision,
		result: AutoPickupRunResult
	): Promise<WorkItem | undefined> {
		try {
			const claimedItem = await this.options.workGraph.claimItem(
				{
					workItemId: decision.workItem.id,
					owner: decision.owner,
					source: 'auto-pickup',
					expectedUpdatedAt: decision.workItem.updatedAt,
					note: `Auto-picked by ${decision.agent.displayName}`,
					capabilityRouting: {
						agentId: decision.agent.id,
						agentCapabilities: decision.agent.dispatchCapabilities,
						requireReadyTag: true,
					},
				},
				{
					type: 'system',
					id: 'auto-pickup',
					name: 'Auto Pickup',
					agentId: decision.agent.agentId,
					providerSessionId: decision.agent.providerSessionId,
				}
			);

			if (
				claimedItem.claim?.status !== 'active' ||
				claimedItem.claim.owner.id !== decision.owner.id ||
				claimedItem.claim.source !== 'auto-pickup'
			) {
				result.skipped += 1;
				return undefined;
			}

			return claimedItem;
		} catch (error) {
			result.skipped += 1;
			result.errors.push({
				workItemId: decision.workItem.id,
				agentId: decision.agent.id,
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}
}

function toOwner(entry: AgentDispatchFleetEntry): WorkItemOwner {
	return {
		type: 'agent',
		id: entry.id,
		name: entry.displayName,
		agentId: entry.agentId,
		providerSessionId: entry.providerSessionId,
		capabilities: entry.dispatchCapabilities,
	};
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
