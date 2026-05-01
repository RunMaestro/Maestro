/**
 * Per-project role slot types for the Roles tab (#429).
 *
 * Each project can assign exactly one agent per dispatch role.
 * The slot also carries optional model / effort overrides that
 * apply when that agent claims a work item in that role for this project.
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

/**
 * A single slot assignment: which agent is assigned to a role and any inline
 * model / effort overrides for that project.
 */
export interface RoleSlotAssignment {
	/** ID of the Maestro agent (Session.id) assigned to this slot. */
	agentId: string;
	/** Optional model override applied when this agent claims in this role. */
	modelOverride?: string;
	/** Optional effort override (e.g. 'high', 'medium') for this slot. */
	effortOverride?: string;
}

/**
 * The persisted project-level roster: exactly 1 slot per role (or unassigned).
 *
 * Stored under `projectRoleSlots` in project metadata (key-value store keyed
 * by `projectPath`).
 */
export interface ProjectRoleSlots {
	runner?: RoleSlotAssignment;
	fixer?: RoleSlotAssignment;
	reviewer?: RoleSlotAssignment;
	merger?: RoleSlotAssignment;
}
