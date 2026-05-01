/**
 * Per-project role slot types for the Roles tab (#429).
 *
 * Slots reference an existing Left Bar agent (Session.id).  When a work item
 * is claimed for a role, DispatchEngine looks up the slot's agentId, fetches
 * that session's config from sessionsStore + agentConfigsStore, and spawns a
 * fresh process via ProcessManager — mirroring how Cue spawns agents.
 *
 * The agent picker in SlotCard.tsx filters the Left Bar to agents whose
 * projectRoot (normalised) and SSH remote match the active session's project
 * and host, so the dispatched process always runs in the right context.
 */

import type { DispatchRole } from './agent-dispatch-types';

export type { DispatchRole };

/** The four dispatch roles, in display order. */
export const DISPATCH_ROLES: DispatchRole[] = ['runner', 'fixer', 'reviewer', 'merger'];

/** Human-readable label for each role. */
export const DISPATCH_ROLE_LABELS: Record<DispatchRole, string> = {
	runner: 'Runner',
	fixer: 'Fixer',
	reviewer: 'Reviewer',
	merger: 'Merger',
};

// ============================================================================
// Core slot shape (#429)
// ============================================================================

/**
 * A single role slot assignment.
 *
 * References an existing Left Bar agent by its Session.id.  At dispatch time
 * DispatchEngine resolves the agent's config (toolType, command, SSH remote,
 * model/effort overrides) and spawns a fresh process via ProcessManager with
 * WorkItem.projectPath as cwd.
 */
export interface RoleSlotAssignment {
	/**
	 * Session.id of the Left Bar agent to use as the template for dispatch.
	 * Must be a valid id present in sessionsStore at dispatch time.
	 */
	agentId: string;
	/** Optional model override. Undefined => agent's stored customModel or agent default. */
	modelOverride?: string;
	/** Optional effort override. Undefined => agent's stored customEffort or agent default. */
	effortOverride?: string;
	/**
	 * Whether this slot is enabled for new work pickup (default: true).
	 *
	 * When false the slot enters "drain mode": the DispatchEngine rejects
	 * any new auto-pickup or manual assignment for this role, but any
	 * currently-running item is allowed to complete naturally.
	 */
	enabled?: boolean;
}

/**
 * The persisted project-level roster: exactly 1 slot per role (or unassigned).
 *
 * Stored under projectRoleSlots in project metadata (key-value store keyed
 * by projectPath).
 */
export interface ProjectRoleSlots {
	runner?: RoleSlotAssignment;
	fixer?: RoleSlotAssignment;
	reviewer?: RoleSlotAssignment;
	merger?: RoleSlotAssignment;
}
