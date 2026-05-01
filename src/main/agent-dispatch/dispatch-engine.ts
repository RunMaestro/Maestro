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
import type { FleetRegistry } from './fleet-registry';
import { isAgentEligibleForPickup, selectAutoPickupAssignments } from './assignment-policy';
import {
	AUTO_PICKUP_FLEET_EVENTS,
	type AgentDispatchAutoPickupTrigger,
	getAutoPickupTriggerForFleetEvent,
	isAutoPickupRelevantWorkGraphEvent,
} from './events';
import { nextRole, isTerminal, type PipelineEvent } from './state-machine';

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
	 * Role enforcement (#427): when the work item has a `pipeline` field, the
	 * agent's `dispatchProfile.roles` must include `pipeline.currentRole`.
	 * Returns a structured `RoleEligibilityError` (not a thrown exception) so
	 * the renderer can surface a human-readable message rather than catching a
	 * generic error.
	 */
	async assignManually(input: ManualAssignmentInput): Promise<WorkItem | RoleEligibilityError> {
		if (!input.userInitiated) {
			throw new Error('Manual assignment requires an explicit user-initiated action');
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
