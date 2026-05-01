/**
 * Agent Dispatch renderer service
 *
 * Thin wrapper around window.maestro.agentDispatch that unwraps the
 * { success, data } IPC envelope and throws on failure so callers can rely on
 * normal async/await error handling.
 *
 * #444: getBoard now returns in-memory ClaimTracker state (no workGraph dependency).
 * releaseClaim input shape updated to { projectItemId, agentSessionId, role }.
 */

import type { WorkItem } from '../../shared/work-graph-types';
import type { AgentDispatchFleetEntry } from '../../shared/agent-dispatch-types';
import type {
	ManualAssignmentInput,
	RoleEligibilityError,
	SlotDisabledError,
} from '../../main/agent-dispatch/dispatch-engine';

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
	 * Fetch in-memory claim state (replaces work-graph board query, #444).
	 */
	getBoard: (): Promise<{ items: unknown[]; total: number }> =>
		unwrap(window.maestro.agentDispatch.getBoard()),

	/**
	 * Fetch the current fleet entries from the FleetRegistry.
	 * Returns an empty array if the Agent Dispatch runtime is not running.
	 */
	getFleet: (): Promise<AgentDispatchFleetEntry[]> =>
		unwrap(window.maestro.agentDispatch.getFleet()),

	/**
	 * Manually assign a work item to an agent.
	 * Requires input.userInitiated === true.
	 *
	 * Resolves with the claimed `WorkItem`, or a structured `RoleEligibilityError`
	 * / `SlotDisabledError` when the engine rejects the assignment without
	 * throwing — callers should check `data.code` before treating the result as
	 * a full `WorkItem`.
	 */
	assignManually: (
		input: ManualAssignmentInput
	): Promise<WorkItem | RoleEligibilityError | SlotDisabledError> =>
		unwrap(window.maestro.agentDispatch.assignManually(input)),

	/**
	 * Release an active claim on a GitHub project item (#444).
	 * Clears AI Assigned Slot on GitHub and removes from in-memory ClaimTracker.
	 */
	releaseClaim: (input: {
		projectItemId: string;
		agentSessionId: string;
		role: string;
	}): Promise<{ released: boolean; projectItemId: string }> =>
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
