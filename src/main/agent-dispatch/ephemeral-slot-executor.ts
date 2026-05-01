/**
 * Ephemeral Slot Executor (#441)
 *
 * When a work item is claimed for a role that is configured via the new
 * RoleSlotConfig shape (agentProvider + model + effort), this module spawns a
 * temporary, isolated agent process for that single claim and tears it down on
 * completion.
 *
 * Key design points:
 * - Reuses `spawnAgent()` from `src/cli/services/agent-spawner.ts` — no
 *   duplicate spawn logic.
 * - Creates a per-claim git worktree at
 *   `<projectPath>/.maestro/worktrees/<role>-<claimId>/` and removes it when
 *   the agent exits (success or error).
 * - Host is implicit: derived from the WorkItem's projectPath binding via the
 *   caller-supplied `getSshRemoteForProject` hook.  If the project maps to an
 *   SSH remote, the agent spawns there via wrapSpawnWithSsh automatically.
 * - Runner role must be local (#440): if the project's resolved host is
 *   SSH-remote AND the role is runner, the executor rejects the claim.
 * - Heartbeat via WorkGraph is logged as a no-op until #435 lands.
 * - All lifecycle events (start, complete, error, worktree-cleanup) are written
 *   to the audit log via the provided callback.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { AgentId } from '../../shared/agentIds';
import type { DispatchRole, RoleSlotConfig } from '../../shared/project-roles-types';
import type { WorkItem } from '../../shared/work-graph-types';
import type { WorkGraphActor } from '../../shared/work-graph-types';
import type { AgentSshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';

const execFile = promisify(execFileCb);
const LOG_CONTEXT = '[EphemeralSlotExecutor]';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EphemeralSlotContext {
	/** The work item being executed. */
	workItem: WorkItem;
	/** The pipeline role being executed. */
	role: DispatchRole;
	/** The slot configuration for this role. */
	slotConfig: RoleSlotConfig;
	/**
	 * The prompt / task description to send to the ephemeral agent.
	 * Callers should embed the work item title, description, and any relevant
	 * context links here.
	 */
	prompt: string;
	/**
	 * Absolute path to the project's local checkout.  The worktree is created
	 * here; for the runner role this must be a git repository.
	 */
	projectPath: string;
	/**
	 * Returns the SSH remote config for the given project path, or undefined if
	 * the project runs locally.  Used to derive the spawn host from
	 * WorkItem.projectPath rather than from a stored `host` field on the slot.
	 *
	 * The caller resolves this by looking up the project's SSH remote binding
	 * (e.g. from project metadata or settings) and returning the matching
	 * AgentSshRemoteConfig when the project lives on a remote host.
	 */
	getSshRemoteForProject: (projectPath: string) => AgentSshRemoteConfig | undefined;
	/**
	 * Called when the work item should be released after execution.
	 */
	releaseClaim: (
		workItemId: string,
		opts?: { note?: string; actor?: WorkGraphActor }
	) => Promise<void>;
	/**
	 * Called to advance the pipeline after a successful role completion.
	 */
	advancePipeline: (
		workItem: WorkItem,
		event: 'complete' | 'fail',
		actor?: WorkGraphActor
	) => Promise<void>;
	/**
	 * Structured audit log sink.
	 */
	auditLog: (event: EphemeralAuditEvent) => void;
}

export type EphemeralAuditEventKind =
	| 'worktree-created'
	| 'spawn-start'
	| 'spawn-complete'
	| 'spawn-error'
	| 'worktree-cleaned'
	| 'worktree-clean-error'
	| 'pipeline-advanced'
	| 'claim-released'
	| 'heartbeat-pending';

export interface EphemeralAuditEvent {
	kind: EphemeralAuditEventKind;
	workItemId: string;
	role: DispatchRole;
	agentProvider: AgentId;
	claimId?: string;
	detail?: string;
	timestamp: string;
}

export interface EphemeralSlotResult {
	success: boolean;
	error?: string;
	worktreePath?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that a slot config is ready to spawn:
 * 1. agentProvider is set
 * 2. Runner role must not be on an SSH-remote project (#440)
 *
 * `resolvedSshConfig` is the SSH remote derived from the WorkItem's
 * projectPath — pass `undefined` for local projects.
 *
 * Returns a human-readable error string when invalid, or null when valid.
 */
export function validateSlotConfig(
	role: DispatchRole,
	config: RoleSlotConfig,
	resolvedSshConfig?: AgentSshRemoteConfig
): string | null {
	if (!config.agentProvider) {
		return `Slot for role '${role}' has no agentProvider configured.`;
	}

	if (role === 'runner' && resolvedSshConfig?.enabled) {
		// Runner must be local (#440) — reject when project is on SSH remote
		return (
			`Runner role slot must execute locally — project is on SSH remote ` +
			`'${resolvedSshConfig.remoteId}' (#440).`
		);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

/**
 * Create a per-claim git worktree under `<projectPath>/.maestro/worktrees/`.
 * Returns the absolute worktree path.
 */
async function createClaimWorktree(
	projectPath: string,
	role: DispatchRole,
	claimId: string
): Promise<string> {
	const worktreesBase = path.join(projectPath, '.maestro', 'worktrees');
	await fs.promises.mkdir(worktreesBase, { recursive: true });

	const worktreeName = `${role}-${claimId}`;
	const worktreePath = path.join(worktreesBase, worktreeName);

	// Create the worktree on a detached HEAD (no extra branch name needed)
	await execFile('git', ['-C', projectPath, 'worktree', 'add', '--detach', worktreePath]);

	return worktreePath;
}

/** Remove a claim worktree. Non-fatal — logs on failure instead of throwing. */
async function removeClaimWorktree(
	projectPath: string,
	worktreePath: string,
	auditLog: EphemeralSlotContext['auditLog'],
	role: DispatchRole,
	agentProvider: AgentId,
	workItemId: string
): Promise<void> {
	try {
		// Prune the git worktree reference
		await execFile('git', ['-C', projectPath, 'worktree', 'remove', '--force', worktreePath]);
	} catch {
		// Worktree may already be gone — try a plain rm as fallback
		try {
			await fs.promises.rm(worktreePath, { recursive: true, force: true });
		} catch (err) {
			auditLog({
				kind: 'worktree-clean-error',
				workItemId,
				role,
				agentProvider,
				detail: err instanceof Error ? err.message : String(err),
				timestamp: new Date().toISOString(),
			});
			return;
		}
	}

	auditLog({
		kind: 'worktree-cleaned',
		workItemId,
		role,
		agentProvider,
		worktreePath,
		timestamp: new Date().toISOString(),
	} as EphemeralAuditEvent);
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Execute a single work item claim using an ephemeral agent spawned from the
 * role slot configuration.
 *
 * Lifecycle:
 * 1. Validate slot config (rejects runner on SSH-remote project per #440)
 * 2. Create per-claim worktree
 * 3. Spawn ephemeral agent via agent-spawner.ts `spawnAgent()`
 * 4. Heartbeat log (waits for #435)
 * 5. On exit: advance pipeline, release claim, clean up worktree
 */
export async function executeEphemeralSlot(
	ctx: EphemeralSlotContext
): Promise<EphemeralSlotResult> {
	const {
		workItem,
		role,
		slotConfig,
		prompt,
		projectPath,
		getSshRemoteForProject,
		releaseClaim,
		advancePipeline,
		auditLog,
	} = ctx;

	const { agentProvider, model, effort } = slotConfig;
	const workItemId = workItem.id;
	const claimId = workItem.claim?.id ?? workItemId;

	// Resolve SSH config from project path — host is implicit, never stored on slot
	const sshRemoteConfig = getSshRemoteForProject(projectPath);

	// 1. Validate
	const validationError = validateSlotConfig(role, slotConfig, sshRemoteConfig);
	if (validationError) {
		logger.warn(validationError, LOG_CONTEXT, { workItemId, role });
		return { success: false, error: validationError };
	}

	// 2. Create worktree
	let worktreePath: string | undefined;
	try {
		worktreePath = await createClaimWorktree(projectPath, role, claimId);
		auditLog({
			kind: 'worktree-created',
			workItemId,
			role,
			agentProvider,
			detail: worktreePath,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logger.warn('Failed to create claim worktree', LOG_CONTEXT, { workItemId, detail });
		// Fall back to using the project path directly rather than blocking execution
		worktreePath = projectPath;
		logger.info('Falling back to projectPath for ephemeral spawn', LOG_CONTEXT, { worktreePath });
	}

	// 3. Spawn via existing agent-spawner (no new spawn logic)
	auditLog({
		kind: 'spawn-start',
		workItemId,
		role,
		agentProvider,
		claimId,
		detail: `host=${sshRemoteConfig?.enabled ? `ssh:${sshRemoteConfig.remoteId}` : 'local'} model=${model ?? 'default'} effort=${effort ?? 'default'}`,
		timestamp: new Date().toISOString(),
	});

	// 4. Heartbeat note — will emit heartbeat once #435 lands
	auditLog({
		kind: 'heartbeat-pending',
		workItemId,
		role,
		agentProvider,
		detail: 'Heartbeat machinery pending #435 — logging only',
		timestamp: new Date().toISOString(),
	});

	// Dynamic import keeps SSH chain out of the local hot path (mirrors agent-spawner.ts pattern)
	const { spawnAgent } = await import('../../cli/services/agent-spawner');

	let spawnSuccess = false;
	let spawnError: string | undefined;

	try {
		const result = await spawnAgent(
			agentProvider,
			worktreePath,
			prompt,
			undefined, // no agentSessionId — always a fresh session
			{
				customModel: model,
				customEffort: effort,
				sshRemoteConfig,
			}
		);

		spawnSuccess = result.success;
		spawnError = result.error;

		auditLog({
			kind: result.success ? 'spawn-complete' : 'spawn-error',
			workItemId,
			role,
			agentProvider,
			claimId,
			detail: result.success
				? `Agent completed — agentSessionId=${result.agentSessionId ?? 'n/a'}`
				: result.error,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		spawnSuccess = false;
		spawnError = err instanceof Error ? err.message : String(err);
		auditLog({
			kind: 'spawn-error',
			workItemId,
			role,
			agentProvider,
			detail: spawnError,
			timestamp: new Date().toISOString(),
		});
	}

	// 5. Advance pipeline + release claim
	const actor: WorkGraphActor = {
		type: 'system',
		id: `ephemeral-${role}-${claimId}`,
		name: `Ephemeral ${role} agent (${agentProvider})`,
		agentId: undefined,
	};

	try {
		await advancePipeline(workItem, spawnSuccess ? 'complete' : 'fail', actor);
		auditLog({
			kind: 'pipeline-advanced',
			workItemId,
			role,
			agentProvider,
			detail: spawnSuccess ? 'complete' : 'fail',
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		logger.warn('Failed to advance pipeline after ephemeral spawn', LOG_CONTEXT, {
			workItemId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	try {
		await releaseClaim(workItemId, {
			note: spawnSuccess
				? `Ephemeral ${role} agent completed successfully`
				: `Ephemeral ${role} agent failed: ${spawnError ?? 'unknown error'}`,
			actor,
		});
		auditLog({
			kind: 'claim-released',
			workItemId,
			role,
			agentProvider,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		logger.warn('Failed to release claim after ephemeral spawn', LOG_CONTEXT, {
			workItemId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 6. Clean up worktree (non-fatal)
	if (worktreePath && worktreePath !== projectPath) {
		await removeClaimWorktree(projectPath, worktreePath, auditLog, role, agentProvider, workItemId);
	}

	return {
		success: spawnSuccess,
		error: spawnError,
		worktreePath,
	};
}
