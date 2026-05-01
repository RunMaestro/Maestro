import type {
	AgentReadyWorkFilter,
	WorkGraphEventType,
	WorkItem,
	WorkItemClaim,
	WorkItemClaimInput,
	WorkItemOwner,
	WorkItemStatus,
} from './work-graph-types';
import { WORK_GRAPH_AGENT_READY_TAG } from './work-graph-types';

export type {
	AgentReadyWorkFilter,
	WorkGraphEventType,
	WorkItem,
	WorkItemClaim,
	WorkItemClaimInput,
	WorkItemOwner,
	WorkItemStatus,
};
export { WORK_GRAPH_AGENT_READY_TAG };

export type AgentDispatchReadiness =
	| 'unavailable'
	| 'connecting'
	| 'ready'
	| 'idle'
	| 'busy'
	| 'paused'
	| 'error';

export type AgentDispatchLocality = 'local' | 'ssh';

export interface AgentDispatchSshRemoteMetadata {
	id: string;
	name?: string;
	host?: string;
	workingDirOverride?: string;
	enabled?: boolean;
	source:
		| 'session.sshRemoteId'
		| 'session.sessionSshRemoteConfig.remoteId'
		| 'session.sshRemote.id';
}

export const AGENT_DISPATCH_PROFILE_CONFIG_KEY = 'dispatchProfile';

export interface AgentDispatchSuggestedDefaults {
	capabilityTags?: string[];
	maxConcurrentClaims?: number;
}

export interface AgentDispatchProfile {
	autoPickupEnabled: boolean;
	capabilityTags: string[];
	maxConcurrentClaims: number;
	/** Whether this agent is eligible to appear in the fleet (dispatch-eligible). */
	fleetEnabled?: boolean;
	/**
	 * Absolute path to an external runner script invoked when this agent
	 * claims a work item. When omitted, dispatch falls back to the Auto Run
	 * playbook trigger path.  Required after #410 removes the default path.
	 */
	runnerScriptPath?: string;
	suggestedDefaults?: AgentDispatchSuggestedDefaults;
}

export interface AgentDispatchSettings {
	globalAutoPickupEnabled: boolean;
	projectAutoPickupEnabled: Record<string, boolean>;
	sshRemoteAutoPickupEnabled: Record<string, boolean>;
}

export const DEFAULT_AGENT_DISPATCH_PROFILE: AgentDispatchProfile = {
	autoPickupEnabled: false,
	capabilityTags: [],
	maxConcurrentClaims: 1,
};

export const DEFAULT_AGENT_DISPATCH_SETTINGS: AgentDispatchSettings = {
	globalAutoPickupEnabled: false,
	projectAutoPickupEnabled: {},
	sshRemoteAutoPickupEnabled: {},
};

export interface AgentDispatchAgentEligibility {
	agentId: string;
	readiness: AgentDispatchReadiness;
	autoPickupEnabled: boolean;
	capabilityTags: string[];
}

export interface AgentDispatchFleetEntry {
	id: string;
	agentId: string;
	sessionId?: string;
	providerSessionId?: string;
	displayName: string;
	providerType: string;
	host: string;
	locality: AgentDispatchLocality;
	sshRemote?: AgentDispatchSshRemoteMetadata;
	readiness: AgentDispatchReadiness;
	currentClaims: WorkItemClaim[];
	currentLoad: number;
	dispatchCapabilities: string[];
	dispatchProfile: AgentDispatchProfile;
	pickupEnabled: boolean;
	updatedAt: string;
}

export type AgentDispatchFleetEventType =
	| 'agentDispatch.fleet.changed'
	| 'agentDispatch.agent.readinessChanged'
	| 'agentDispatch.agent.claimsChanged'
	| 'agentDispatch.agent.pickupChanged';

export interface AgentDispatchFleetEvent {
	type: AgentDispatchFleetEventType;
	entry: AgentDispatchFleetEntry;
	previous?: AgentDispatchFleetEntry;
	timestamp: string;
}

export interface AgentDispatchCandidate {
	workItem: WorkItem;
	claim?: WorkItemClaim;
}

export interface AgentDispatchSelectionRequest {
	filter: AgentReadyWorkFilter;
	agent: AgentDispatchAgentEligibility;
}

export interface AgentDispatchSelectionResult {
	workItem: WorkItem;
	claim?: WorkItemClaim;
	eventType?: WorkGraphEventType;
}

export interface AgentDispatchAssignmentDecision {
	agent: AgentDispatchFleetEntry;
	workItem: WorkItem;
	owner: WorkItemOwner;
	capabilityOverlap: string[];
	loadBeforeAssignment: number;
	capacityBeforeAssignment: number;
}

/**
 * Agent Dispatch consumes Work Graph eligibility in this order:
 * 1. Work-item auto-pickup eligibility is
 *    `unblocked && tags.includes(WORK_GRAPH_AGENT_READY_TAG)`.
 * 2. Agent-side eligibility is ready/idle, auto-pickup-enabled, and capability
 *    overlap with the WorkItem tags.
 * 3. Capability, project, status, and claim exclusions must come from
 *    AgentReadyWorkFilter rather than an Agent Dispatch-specific work state.
 */
export interface AgentDispatchEligibilityContract {
	readyWorkTag: typeof WORK_GRAPH_AGENT_READY_TAG;
	workFilter: AgentReadyWorkFilter;
	workItem: WorkItem;
	claim?: WorkItemClaim;
	agent: AgentDispatchAgentEligibility;
}
/**
 * Agent Dispatch Types
 *
 * Shared type definitions for Agent Dispatch: the subsystem that routes
 * Work Graph items to capable, idle agents.
 *
 * NOTE: The Agent Dispatch runtime (engine + fleetRegistry) is implemented
 * by issue #73/#76. These types are used here only by the slash-command and
 * IPC surface — actual dispatch logic lives in src/main/agent-dispatch/.
 */

// ============================================================================
// Work-item status vocabulary
// ============================================================================

/**
 * Subset of Work Graph item statuses relevant to dispatch.
 * An item must carry the `agent-ready` label to be eligible for assignment.
 */
export type DispatchItemStatus =
	| 'agent-ready' // Ready for an agent to claim
	| 'in-progress' // Claimed and being worked
	| 'blocked' // Dependency not yet resolved
	| 'done'; // Completed

// ============================================================================
// Agent fleet vocabulary
// ============================================================================

/**
 * Availability states an agent can be in from the dispatcher's perspective.
 */
export type AgentAvailability = 'idle' | 'busy' | 'offline';

/**
 * A registered agent visible to the dispatcher.
 */
export interface DispatchAgent {
	/** Maestro session ID */
	sessionId: string;
	/** Display name of the agent */
	name: string;
	/** Agent type (e.g. 'claude-code', 'codex') */
	toolType: string;
	/** Current availability */
	availability: AgentAvailability;
	/** Work-item ID the agent is currently processing, if any */
	currentWorkItemId?: string;
}

// ============================================================================
// Work-item representation
// ============================================================================

/**
 * A Work Graph item that the dispatcher can reason about.
 */
export interface DispatchWorkItem {
	/** Unique item ID */
	id: string;
	/** Short human-readable title */
	title: string;
	/** Current dispatch status */
	status: DispatchItemStatus;
	/** IDs of items this item depends on */
	dependsOn: string[];
	/** Session ID of the agent that claimed this item, if any */
	claimedBySessionId?: string;
	/** ISO 8601 timestamp when the item was claimed */
	claimedAt?: string;
	/** Parent item ID (for subtasks) */
	parentId?: string;
}

// ============================================================================
// IPC request/response shapes
// ============================================================================

/**
 * Response for the list-agents operation.
 */
export interface ListAgentsResponse {
	agents: DispatchAgent[];
}

/**
 * Response for the list-eligible operation.
 */
export interface ListEligibleResponse {
	items: DispatchWorkItem[];
}

/**
 * Parameters for the assign operation.
 */
export interface AssignParams {
	/** Work-item ID to assign */
	itemId: string;
	/** Session ID of the target agent */
	sessionId: string;
}

/**
 * Response for the assign operation.
 */
export interface AssignResponse {
	item: DispatchWorkItem;
}

/**
 * Parameters for the release operation.
 */
export interface ReleaseParams {
	/** Work-item ID to release */
	itemId: string;
}

/**
 * Response for the release operation.
 */
export interface ReleaseResponse {
	item: DispatchWorkItem;
}

/**
 * Parameters for the pause/resume operations.
 */
export interface PauseResumeParams {
	/** Session ID to pause or resume */
	sessionId: string;
}

/**
 * Response for pause/resume operations.
 */
export interface PauseResumeResponse {
	agent: DispatchAgent;
}

/**
 * Parameters for the create-subtask operation.
 */
export interface CreateSubtaskParams {
	/** Title of the new subtask */
	title: string;
	/** Parent work-item ID */
	parentId: string;
	/** IDs of items this subtask must wait for */
	dependsOn?: string[];
}

/**
 * Response for the create-subtask operation.
 */
export interface CreateSubtaskResponse {
	item: DispatchWorkItem;
}

/**
 * Overall dispatch status summary.
 */
export interface DispatchStatusResponse {
	agents: DispatchAgent[];
	eligible: DispatchWorkItem[];
	inProgress: DispatchWorkItem[];
}
