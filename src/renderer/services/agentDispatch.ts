/**
 * Agent Dispatch renderer service
 *
 * Thin wrapper around window.maestro.agentDispatch that unwraps the
 * { success, data } IPC envelope and throws on failure so callers can rely on
 * normal async/await error handling.
 */

import type {
	WorkItemFilters,
	WorkItemClaimReleaseInput,
	WorkGraphListResult,
	WorkItem,
	WorkItemClaim,
} from '../../shared/work-graph-types';
import type { AgentDispatchFleetEntry } from '../../shared/agent-dispatch-types';
import type { ManualAssignmentInput } from '../../main/agent-dispatch/dispatch-engine';

type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };

const unwrap = async <T>(response: Promise<IpcResponse<T>>): Promise<T> => {
	const result = await response;
	if (!result.success) {
		throw new Error(result.error);
	}
	return result.data;
};

export const agentDispatchService = {
	/**
	 * Fetch work items formatted for kanban display.
	 */
	getBoard: (filters?: WorkItemFilters): Promise<WorkGraphListResult> =>
		unwrap(window.maestro.agentDispatch.getBoard(filters)),

	/**
	 * Fetch the current fleet entries from the FleetRegistry.
	 * Returns an empty array if the Agent Dispatch runtime is not running.
	 */
	getFleet: (): Promise<AgentDispatchFleetEntry[]> =>
		unwrap(window.maestro.agentDispatch.getFleet()),

	/**
	 * Manually assign a work item to an agent.
	 * Requires input.userInitiated === true.
	 */
	assignManually: (input: ManualAssignmentInput): Promise<WorkItem> =>
		unwrap(window.maestro.agentDispatch.assignManually(input)),

	/**
	 * Release an active claim on a work item.
	 */
	releaseClaim: (input: WorkItemClaimReleaseInput): Promise<WorkItemClaim | undefined> =>
		unwrap(window.maestro.agentDispatch.releaseClaim(input)),

	/**
	 * Pause auto-pickup for the given agent (in-memory, resets on restart).
	 */
	pauseAgent: (agentId: string): Promise<{ paused: boolean }> =>
		unwrap(window.maestro.agentDispatch.pauseAgent(agentId)),

	/**
	 * Resume auto-pickup for the given agent.
	 */
	resumeAgent: (agentId: string): Promise<{ paused: boolean }> =>
		unwrap(window.maestro.agentDispatch.resumeAgent(agentId)),
};
