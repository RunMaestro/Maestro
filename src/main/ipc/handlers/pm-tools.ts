/**
 * pm-tools IPC handlers — agent-callable project management tools (#430).
 *
 * Exposes three channels that agents call at workflow transitions to self-update
 * their claimed work item in the Projects v2 custom fields:
 *
 *   pm:setStatus  → updates AI Status field for the agent's claimed item
 *   pm:setRole    → updates AI Role field for the agent's claimed item
 *   pm:setBlocked → sets AI Status=Blocked + posts a comment with the reason
 *
 * Each handler:
 *  1. Resolves the calling agent's currently-claimed work item via in-memory ClaimTracker.
 *  2. Enforces ownership — agents cannot update items they don't own.
 *  3. Persists the new field value to GitHub Projects v2 via GithubClient.
 *  4. Records an audit event in the local JSONL audit log.
 *
 * #444: work-graph SQLite removed — GitHub Projects v2 is the sole durable state.
 *
 * Gated by the `deliveryPlanner` encore feature flag (same gate as delivery-planner handlers).
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import { getClaimTracker } from '../../agent-dispatch/claim-tracker';
import { getGithubClient } from '../../agent-dispatch/github-client';
import { auditLog } from '../../agent-dispatch/dispatch-audit-log';
import { sweepMergedBranches } from '../../pm-branch-hygiene/branch-cleaner';
import { DELIVERY_PLANNER_GITHUB_REPOSITORY } from '../../delivery-planner/github-safety';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[PmTools]';

export interface PmToolsSetStatusInput {
	/** The agent's own session ID — used to look up its current claim. */
	agentSessionId: string;
	/** Target status value — must match an AI Status field option name. */
	status: string;
}

export interface PmToolsSetRoleInput {
	agentSessionId: string;
	/** Target role value — must match an AI Role field option name. */
	role: string;
}

export interface PmToolsSetBlockedInput {
	agentSessionId: string;
	/** Human-readable reason posted as a GitHub comment and recorded in the audit log. */
	reason: string;
}

export interface PmToolsResult {
	workItemId: string;
	field: string;
	value: string;
}

export interface PmToolsHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPmToolsHandlers(deps: PmToolsHandlerDependencies): void {
	/** Returns structured error if deliveryPlanner encore flag is off. */
	const gate = () => requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');

	// ── pm:setStatus ──────────────────────────────────────────────────────────
	ipcMain.handle('pm:setStatus', async (_event, input: PmToolsSetStatusInput) => {
		const gateError = gate();
		if (gateError) return gateError;

		try {
			const claim = getClaimTracker().getByAgent(input.agentSessionId);
			if (!claim) {
				return {
					success: false,
					error: `Agent session "${input.agentSessionId}" has no active claim`,
				};
			}

			const client = getGithubClient();
			await client.setItemFieldValue(
				claim.projectId,
				claim.projectItemId,
				'AI Status',
				input.status
			);

			auditLog('status_change', {
				actor: input.agentSessionId,
				workItemId: claim.projectItemId,
				priorState: { role: claim.role },
				newState: { 'AI Status': input.status },
			});

			logger.info(
				`pm:setStatus projectItem=${claim.projectItemId} status=${input.status}`,
				LOG_CONTEXT
			);

			// Merger-done branch cleanup — best-effort
			if (input.status.toLowerCase() === 'done' && claim.projectPath) {
				void tryDeleteBranch(claim.projectPath, claim.projectItemId);
			}

			return {
				success: true,
				data: {
					workItemId: claim.projectItemId,
					field: 'AI Status',
					value: input.status,
				} satisfies PmToolsResult,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`pm:setStatus failed: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	// ── pm:setRole ────────────────────────────────────────────────────────────
	ipcMain.handle('pm:setRole', async (_event, input: PmToolsSetRoleInput) => {
		const gateError = gate();
		if (gateError) return gateError;

		try {
			const claim = getClaimTracker().getByAgent(input.agentSessionId);
			if (!claim) {
				return {
					success: false,
					error: `Agent session "${input.agentSessionId}" has no active claim`,
				};
			}

			const client = getGithubClient();
			await client.setItemFieldValue(claim.projectId, claim.projectItemId, 'AI Role', input.role);

			auditLog('role_change', {
				actor: input.agentSessionId,
				workItemId: claim.projectItemId,
				priorState: { role: claim.role },
				newState: { 'AI Role': input.role },
			});

			logger.info(`pm:setRole projectItem=${claim.projectItemId} role=${input.role}`, LOG_CONTEXT);
			return {
				success: true,
				data: {
					workItemId: claim.projectItemId,
					field: 'AI Role',
					value: input.role,
				} satisfies PmToolsResult,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`pm:setRole failed: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	// ── pm:setBlocked ─────────────────────────────────────────────────────────
	ipcMain.handle('pm:setBlocked', async (_event, input: PmToolsSetBlockedInput) => {
		const gateError = gate();
		if (gateError) return gateError;

		try {
			const claim = getClaimTracker().getByAgent(input.agentSessionId);
			if (!claim) {
				return {
					success: false,
					error: `Agent session "${input.agentSessionId}" has no active claim`,
				};
			}

			const client = getGithubClient();

			// 1. Set AI Status → Blocked on GitHub Projects v2
			await client.setItemFieldValue(claim.projectId, claim.projectItemId, 'AI Status', 'Blocked');

			// 2. Post a comment on the GitHub issue if we have the issue number
			if (claim.issueNumber) {
				await client.addItemComment(
					claim.issueNumber,
					DELIVERY_PLANNER_GITHUB_REPOSITORY,
					`**Blocked** — ${input.reason}`
				);
			}

			auditLog('blocked', {
				actor: input.agentSessionId,
				workItemId: claim.projectItemId,
				priorState: { 'AI Status': 'In Progress' },
				newState: { 'AI Status': 'Blocked' },
				reason: input.reason,
			});

			logger.info(
				`pm:setBlocked projectItem=${claim.projectItemId} reason="${input.reason}"`,
				LOG_CONTEXT
			);
			return {
				success: true,
				data: {
					workItemId: claim.projectItemId,
					field: 'AI Status',
					value: 'Blocked',
				} satisfies PmToolsResult,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`pm:setBlocked failed: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});
}

// ── Branch cleanup helper ──────────────────────────────────────────────────

async function tryDeleteBranch(projectPath: string, projectItemId: string): Promise<void> {
	try {
		await sweepMergedBranches(projectPath, 'main', { graceDays: 0, dryRun: false });
		logger.info(
			`merger-done: branch sweep attempted for projectItem=${projectItemId}`,
			LOG_CONTEXT
		);
	} catch (err) {
		logger.warn(
			`merger-done: branch sweep failed for projectItem=${projectItemId}: ${
				err instanceof Error ? err.message : String(err)
			}`,
			LOG_CONTEXT
		);
	}
}
