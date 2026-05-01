/**
 * Per-project role slot types for the Roles tab (#429, #441).
 *
 * #441 — Dev Crew slots use ephemeral sessions (not tied to existing Left Bar
 * agents). Each slot stores an agentProvider (AgentId) plus optional
 * model/effort overrides that control how the ephemeral agent is spawned when
 * it claims a work item in that role.
 *
 * Host is implicit — derived from the WorkItem's projectPath binding.  When
 * the project lives on a remote host the runner spawns there via
 * wrapSpawnWithSsh; the user never picks a host in the Dev Crew UI.
 *
 * Migration note: existing slot configs that carry the old `agentId` field
 * (the former `RoleSlotAssignment` shape) are read-tolerant — SlotCard detects
 * the presence of `agentId` and surfaces a "reconfigure: ephemeral mode" banner
 * so the user can pick fresh settings.  The old `agentId` is never
 * auto-promoted to `agentProvider`.
 */

import type { AgentId } from './agentIds';
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
// #441 — ephemeral slot shape
// ============================================================================

/**
 * Configuration for a single role slot under the #441 ephemeral-spawn model.
 *
 * Slots are no longer tied to an existing user agent (Session.id).  Instead,
 * the slot carries everything the DispatchEngine needs to spin up a fresh,
 * isolated ephemeral agent process for each claim:
 *
 * - `agentProvider` — which agent binary to invoke
 * - `model`         — optional model override (populated from provider discovery)
 * - `effort`        — optional effort level (hidden in UI when agent doesn't support it)
 * - `enabled`       — drain-mode flag from #437
 *
 * Host is NOT stored here.  It is derived at dispatch time from the
 * WorkItem's projectPath binding: if the project is on an SSH remote the
 * runner spawns there via wrapSpawnWithSsh automatically.  The UI exposes
 * only Provider / Model / Effort (3 dropdowns).
 *
 * Runner local-only constraint (#440): enforced at claim time — if the
 * project's resolved host is SSH-remote AND the role is runner, the claim is
 * rejected.  NOT a UI restriction.
 */
export interface RoleSlotConfig {
	/** Agent provider — e.g. 'claude-code' | 'codex' | 'opencode' | 'factory-droid' | 'copilot-cli' */
	agentProvider: AgentId;
	/** Model override. Undefined → agent default. */
	model?: string;
	/** Effort level override. Undefined → agent default. Hidden in UI when not applicable. */
	effort?: 'xhigh' | 'high' | 'medium' | 'low';
	/**
	 * Whether this slot is enabled for new work pickup (default: true).
	 *
	 * When `false` the slot enters "drain mode": the DispatchEngine rejects
	 * any new auto-pickup or manual assignment for this role, but any
	 * currently-running item is allowed to complete naturally.
	 */
	enabled?: boolean;
}

/**
 * The persisted project-level roster: exactly 1 slot per role (or unassigned).
 *
 * Stored under `projectRoleSlots` in project metadata (key-value store keyed
 * by `projectPath`).
 */
export interface ProjectRoleSlots {
	runner?: RoleSlotConfig;
	fixer?: RoleSlotConfig;
	reviewer?: RoleSlotConfig;
	merger?: RoleSlotConfig;
}

// ============================================================================
// v1 legacy type — kept for read-tolerant migration detection
// ============================================================================

/**
 * @deprecated #441 — replaced by RoleSlotConfig (ephemeral-spawn model).
 *
 * This interface described the old shape where a slot was tied to an existing
 * Maestro agent (Session.id).  It is kept here solely so that SlotCard can
 * detect legacy stored values (presence of `agentId` field) and surface a
 * one-time migration banner.  Do NOT use this type for new code.
 *
 * Migration path: user opens the Roles tab, sees the "reconfigure: ephemeral
 * mode" banner on each legacy slot, and picks fresh agentProvider / model /
 * effort settings.  The old agentId is never auto-promoted.
 */
export interface LegacyRoleSlotAssignment {
	/** @deprecated Session.id of the previously-assigned agent. */
	agentId: string;
	/** @deprecated */
	modelOverride?: string;
	/** @deprecated */
	effortOverride?: string;
	/** @deprecated */
	enabled?: boolean;
}

/**
 * Type guard: returns true when a stored slot value looks like the old
 * `RoleSlotAssignment` shape (has `agentId` but no `agentProvider`).
 */
export function isLegacySlot(value: unknown): value is LegacyRoleSlotAssignment {
	return (
		typeof value === 'object' && value !== null && 'agentId' in value && !('agentProvider' in value)
	);
}

/**
 * Union of the current and legacy slot shapes, for read-tolerant storage access.
 * The persisted store may contain either shape until the user reconfigures.
 */
export type AnyRoleSlot = RoleSlotConfig | LegacyRoleSlotAssignment;

/**
 * @deprecated Alias retained for any files that imported RoleSlotAssignment
 * before #441. Those callers should migrate to RoleSlotConfig.
 */
export type RoleSlotAssignment = LegacyRoleSlotAssignment;
