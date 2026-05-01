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
 *  1. Resolves the calling agent's currently-claimed work item (via work-graph).
 *  2. Enforces ownership — agents cannot update items they don't own.
 *  3. Persists the new field value to the Projects v2 via GraphQL.
 *  4. Records an audit event in the work-graph event log (Track C).
 *
 * Gated by the `deliveryPlanner` encore feature flag (same gate as delivery-planner handlers).
 */

import { ipcMain } from 'electron';
import { getWorkGraphItemStore } from '../../work-graph';
import { DeliveryPlannerGithubSync } from '../../delivery-planner/github-sync';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import type { WorkItem, WorkGraphActor, WorkItemStatus } from '../../../shared/work-graph-types';
import { sweepMergedBranches } from '../../pm-branch-hygiene/branch-cleaner';

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
	/** Human-readable reason posted as a GitHub comment and recorded in the event log. */
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
	const workGraph = getWorkGraphItemStore();

	/** Returns structured error if deliveryPlanner encore flag is off. */
	const gate = () => requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');

	// ── pm:setStatus ──────────────────────────────────────────────────────────
	ipcMain.handle('pm:setStatus', async (_event, input: PmToolsSetStatusInput) => {
		const gateError = gate();
		if (gateError) return gateError;

		try {
			const { workItemId, projectId, projectItemId, workItem } = await resolveClaimedItem(
				workGraph,
				input.agentSessionId
			);

			const githubSync = new DeliveryPlannerGithubSync();
			await githubSync.updateStatusField(projectId, projectItemId, input.status);

			const actor = actorForSession(input.agentSessionId);
			await recordPmEvent(workGraph, {
				workItemId,
				actor,
				field: 'AI Status',
				priorState: undefined,
				newState: input.status,
			});

			console.log(`${LOG_CONTEXT} pm:setStatus workItem=${workItemId} status=${input.status}`);

			// ── Merger-done branch cleanup (#435) ──────────────────────────────
			// When the merger signals completion, attempt to delete the feature branch
			// associated with the work item (if one can be inferred).  Uses the same
			// sweepMergedBranches helper so the grace-period and protection rules are
			// consistent with the hourly cron.  Failures are logged but do not fail
			// the status update — branch cleanup is best-effort.
			if (input.status.toLowerCase() === 'done') {
				void tryDeleteWorkItemBranch(workItem, workItemId);
			}

			return {
				success: true,
				data: { workItemId, field: 'AI Status', value: input.status } satisfies PmToolsResult,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`${LOG_CONTEXT} pm:setStatus failed:`, message);
			return { success: false, error: message };
		}
	});

	// ── pm:setRole ────────────────────────────────────────────────────────────
	ipcMain.handle('pm:setRole', async (_event, input: PmToolsSetRoleInput) => {
		const gateError = gate();
		if (gateError) return gateError;

		try {
			const { workItemId, projectId, projectItemId } = await resolveClaimedItem(
				workGraph,
				input.agentSessionId
			);

			const githubSync = new DeliveryPlannerGithubSync();
			await githubSync.updateRoleField(projectId, projectItemId, input.role);

			const actor = actorForSession(input.agentSessionId);
			await recordPmEvent(workGraph, {
				workItemId,
				actor,
				field: 'AI Role',
				priorState: undefined,
				newState: input.role,
			});

			console.log(`${LOG_CONTEXT} pm:setRole workItem=${workItemId} role=${input.role}`);
			return {
				success: true,
				data: { workItemId, field: 'AI Role', value: input.role } satisfies PmToolsResult,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`${LOG_CONTEXT} pm:setRole failed:`, message);
			return { success: false, error: message };
		}
	});

	// ── pm:setBlocked ─────────────────────────────────────────────────────────
	ipcMain.handle('pm:setBlocked', async (_event, input: PmToolsSetBlockedInput) => {
		const gateError = gate();
		if (gateError) return gateError;

		try {
			const { workItemId, projectId, projectItemId, workItem } = await resolveClaimedItem(
				workGraph,
				input.agentSessionId
			);

			const githubSync = new DeliveryPlannerGithubSync();

			// 1. Set Projects v2 AI Status → Blocked.
			await githubSync.updateStatusField(projectId, projectItemId, 'Blocked');

			// 2. Post a comment on the GitHub issue if one exists.
			if (workItem.github?.issueNumber) {
				await githubSync.addProgressComment(workItem, `**Blocked** — ${input.reason}`);
			}

			// 3. Patch work-graph status to reflect the blocked state.
			const actor = actorForSession(input.agentSessionId);
			await workGraph.updateItem({
				id: workItemId,
				patch: { status: 'blocked' as WorkItemStatus },
				actor,
			});

			await recordPmEvent(workGraph, {
				workItemId,
				actor,
				field: 'AI Status',
				priorState: workItem.status,
				newState: 'Blocked',
				reason: input.reason,
			});

			console.log(`${LOG_CONTEXT} pm:setBlocked workItem=${workItemId} reason="${input.reason}"`);
			return {
				success: true,
				data: { workItemId, field: 'AI Status', value: 'Blocked' } satisfies PmToolsResult,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`${LOG_CONTEXT} pm:setBlocked failed:`, message);
			return { success: false, error: message };
		}
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ClaimedItemResolution {
	workItemId: string;
	projectId: string;
	projectItemId: string;
	workItem: WorkItem;
}

/**
 * Finds the work item currently claimed by the given agent session.
 * Throws if the agent has no active claim or the item isn't synced to a project.
 */
async function resolveClaimedItem(
	workGraph: ReturnType<typeof getWorkGraphItemStore>,
	agentSessionId: string
): Promise<ClaimedItemResolution> {
	// List items where the owner matches this session and the claim is active.
	const result = await workGraph.listItems({
		ownerId: agentSessionId,
		statuses: ['claimed', 'in_progress', 'blocked', 'review'],
	});

	const claimedItem = result.items.find(
		(item) =>
			item.claim?.status === 'active' &&
			(item.claim.owner.id === agentSessionId ||
				item.claim.owner.providerSessionId === agentSessionId)
	);

	if (!claimedItem) {
		throw new Error(
			`Agent session "${agentSessionId}" has no active claim — cannot update project fields`
		);
	}

	const projectItemId = claimedItem.github?.projectItemId;
	if (!projectItemId) {
		throw new Error(
			`Work item "${claimedItem.id}" is not synced to a GitHub Project — run sync first`
		);
	}

	// Read the project ID via a fresh project view.
	const githubSync = new DeliveryPlannerGithubSync();
	const projectId = await githubSync.readProjectId();

	return {
		workItemId: claimedItem.id,
		projectId,
		projectItemId,
		workItem: claimedItem,
	};
}

function actorForSession(agentSessionId: string): WorkGraphActor {
	return {
		type: 'agent',
		id: agentSessionId,
		providerSessionId: agentSessionId,
	};
}

interface PmEventInput {
	workItemId: string;
	actor: WorkGraphActor;
	field: string;
	priorState: string | undefined;
	newState: string;
	reason?: string;
}

/**
 * Records an audit log entry in the work-graph event log (Track C).
 * Maps to WorkItemEvent type 'updated' with before/after reflecting the field change.
 * Populates rich audit fields (#435): priorState, newState, reason.
 */
async function recordPmEvent(
	workGraph: ReturnType<typeof getWorkGraphItemStore>,
	input: PmEventInput
): Promise<void> {
	await workGraph.recordEvent({
		workItemId: input.workItemId,
		type: 'updated',
		actor: input.actor,
		before:
			input.priorState !== undefined ? { status: input.priorState as WorkItemStatus } : undefined,
		after: { status: input.newState as WorkItemStatus },
		message: input.reason
			? `pm:${input.field.toLowerCase()} → ${input.newState} (reason: ${input.reason})`
			: `pm:${input.field.toLowerCase()} → ${input.newState}`,
		priorState: input.priorState ? { [input.field]: input.priorState } : undefined,
		newState: { [input.field]: input.newState },
		reason: input.reason,
	});
}

// ── Merger-done branch cleanup helper (#435) ──────────────────────────────────

/**
 * After a work item transitions to "done", attempt to delete the associated
 * feature branch.  The branch name is taken from `workItem.github.branch` when
 * present; if absent the cleanup is silently skipped.
 *
 * Uses `sweepMergedBranches` with `graceDays: 0` so the per-item cleanup is
 * not subject to the 14-day wait — the merger explicitly completed the item, so
 * waiting is unnecessary.  Protected branches are still honoured.
 *
 * The project path is taken from `workItem.projectPath`; if unavailable the
 * cwd of the current process is used as a fallback.
 */
async function tryDeleteWorkItemBranch(workItem: WorkItem, workItemId: string): Promise<void> {
	const featureBranch = workItem.github?.branch;
	if (!featureBranch) {
		console.log(
			`${LOG_CONTEXT} merger-done: no github.branch on work item ${workItemId} — skipping branch cleanup`
		);
		return;
	}

	const repoPath = workItem.projectPath || process.cwd();

	try {
		const result = await sweepMergedBranches(repoPath, 'main', {
			graceDays: 0,
			dryRun: false,
		});

		const wasDeleted = result.deleted.includes(featureBranch);
		const skipEntry = result.skipped.find((s) => s.branch === featureBranch);

		if (wasDeleted) {
			console.log(
				`${LOG_CONTEXT} merger-done: deleted merged branch "${featureBranch}" for work item ${workItemId}`
			);
		} else if (skipEntry) {
			console.log(
				`${LOG_CONTEXT} merger-done: branch "${featureBranch}" skipped (${skipEntry.reason}) for work item ${workItemId}`
			);
		} else {
			// Branch not in merged list — not yet merged; leave it alone.
			console.log(
				`${LOG_CONTEXT} merger-done: branch "${featureBranch}" not yet merged — skipping deletion for work item ${workItemId}`
			);
		}
	} catch (err) {
		console.warn(
			`${LOG_CONTEXT} merger-done: branch cleanup failed for "${featureBranch}" (work item ${workItemId}): ${err instanceof Error ? err.message : String(err)}`
		);
	}
}
