import type {
	AgentDispatchFleetEntry,
	WorkItem,
	WorkItemClaimInput,
	WorkItemOwner,
} from '../../shared/agent-dispatch-types';
import type { WorkGraphActor, WorkItemClaim } from '../../shared/work-graph-types';
import type { FleetRegistry } from './fleet-registry';

/**
 * Store interface required by the manual-override surface.
 */
export interface ManualOverrideWorkGraphStore {
	claimItem(input: WorkItemClaimInput, actor?: WorkGraphActor): Promise<WorkItem>;
	releaseClaim(
		workItemId: string,
		options?: { note?: string; actor?: WorkGraphActor }
	): Promise<WorkItemClaim | undefined>;
}

export interface ManualAssignOptions {
	/** The Work Graph item to assign. */
	workItemId: string;
	/** The fleet entry that should own the claim. */
	agent: AgentDispatchFleetEntry;
	/**
	 * Actor identity for the audit event.  Defaults to a user actor derived
	 * from the agent entry when not provided.
	 */
	actor?: WorkGraphActor;
	/** Optional human-readable note recorded on the claim event. */
	note?: string;
	/** ISO-8601 expiry for the new claim.  No expiry if omitted. */
	expiresAt?: string;
	/**
	 * Optimistic concurrency guard – pass the item's current updatedAt so
	 * the Work Graph can reject a stale assignment.
	 */
	expectedUpdatedAt?: string;
}

export interface ForceReleaseOptions {
	/** The Work Graph item whose active claim should be released. */
	workItemId: string;
	/**
	 * Actor identity recorded on the release event.
	 * Required so the action is fully auditable.
	 */
	actor: WorkGraphActor;
	/** Optional human-readable note recorded on the release event. */
	note?: string;
}

export interface PauseResumeResult {
	entryId: string;
	paused: boolean;
	entry: AgentDispatchFleetEntry | undefined;
}

/**
 * ManualOverride provides the authoritative surfaces for operator control of
 * Agent Dispatch state that bypasses the auto-pickup engine:
 *
 * - manualAssign   – claim a Work Graph item on behalf of a specific agent,
 *                   recording a 'manual' source so the audit log is clear.
 * - forceRelease   – release an active claim regardless of which agent owns
 *                   it, recording the releasing actor for auditability.
 * - pauseAgent     – prevent an agent from auto-picking up new work without
 *                   evicting its current claims or hiding it from the fleet.
 * - resumeAgent    – re-enable auto-pickup for a previously paused agent.
 */
export class ManualOverride {
	constructor(
		private readonly workGraph: ManualOverrideWorkGraphStore,
		private readonly fleetRegistry: FleetRegistry
	) {}

	/**
	 * Claim a work item and assign it to a specific agent.
	 * Wins over auto-pickup because it uses source: 'manual' and does not
	 * require the `agent-ready` tag.
	 */
	async manualAssign(options: ManualAssignOptions): Promise<WorkItem> {
		const actor: WorkGraphActor = options.actor ?? {
			type: 'user',
			id: options.agent.id,
			name: options.agent.displayName,
			agentId: options.agent.agentId,
			providerSessionId: options.agent.providerSessionId,
		};

		return this.workGraph.claimItem(
			{
				workItemId: options.workItemId,
				owner: toOwner(options.agent),
				source: 'manual',
				note: options.note,
				expiresAt: options.expiresAt,
				expectedUpdatedAt: options.expectedUpdatedAt,
			},
			actor
		);
	}

	/**
	 * Release an active claim on a work item, regardless of which agent owns
	 * it.  The releasing actor is recorded in the Work Graph event log.
	 */
	async forceRelease(options: ForceReleaseOptions): Promise<WorkItemClaim | undefined> {
		return this.workGraph.releaseClaim(options.workItemId, {
			note: options.note ?? 'force-released by operator',
			actor: options.actor,
		});
	}

	/**
	 * Pause an agent so it is excluded from auto-pickup decisions.
	 * The agent's current claims remain active and visible; the agent is not
	 * removed from the fleet.
	 */
	pauseAgent(entryId: string): PauseResumeResult {
		const entry = this.fleetRegistry.pause(entryId);
		return { entryId, paused: true, entry };
	}

	/**
	 * Resume a previously paused agent, re-enabling auto-pickup eligibility.
	 */
	resumeAgent(entryId: string): PauseResumeResult {
		const entry = this.fleetRegistry.resume(entryId);
		return { entryId, paused: false, entry };
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
