/**
 * PM Audit Runner — #434
 *
 * Standalone rule-based audit engine for in-flight work items. Runs a battery
 * of 7 checks, auto-fixing what it can and surfacing the rest as `needs-attention`
 * findings for human review.
 *
 * Slash-command wiring (/PM-Check) and 5th-slot UI are deferred until #428 lands.
 *
 * Check IDs (stable — used in AuditFinding.checkId):
 *   STALE_CLAIM          — claimed but no heartbeat renewal for > staleClaimMs
 *   IN_REVIEW_NO_PR      — Status=review but no PR linked in github ref
 *   PR_MERGED_NOT_DONE   — linked PR is merged but Status ≠ done
 *   DUPLICATE_TITLE      — two items share same title under same epic
 *   IN_PROGRESS_NO_ROLE  — Status=in_progress but no role/owner assigned
 *   ORPHANED_SLOT_AGENT  — agent is in a role slot but that slot is empty in projectRoleSlots
 *   DONE_NO_CODE         — Status=done but no PR or commit SHA
 */

import type { WorkGraphStorage } from '../work-graph';
import type { WorkItem, WorkGraphActor } from '../../shared/work-graph-types';

// ── Public types ─────────────────────────────────────────────────────────────

export interface AuditCheck {
	id: string;
	description: string;
	severity: 'auto-fix' | 'needs-attention';
	run(workItem: WorkItem, ctx: AuditContext): AuditFinding | null;
}

export interface AuditFinding {
	workItemId: string;
	checkId: string;
	message: string;
	severity: 'auto-fix' | 'needs-attention';
	/** Present only on auto-fix findings. Caller invokes this to apply the fix. */
	autoFixAction?: () => Promise<void>;
}

/** Slim pm:* tool interface — mirrors the handlers registered by #430. */
export interface PmTools {
	setStatus(agentSessionId: string, status: string): Promise<unknown>;
	setRole(agentSessionId: string, role: string): Promise<unknown>;
	setBlocked(agentSessionId: string, reason: string): Promise<unknown>;
}

export interface AuditContext {
	/** WorkGraphStorage instance (from `getWorkGraphItemStore()`). */
	workGraph: WorkGraphStorage;
	/** Direct handles to the pm:* IPC handlers — called in-process, not over IPC. */
	pmTools: PmTools;
	/** Current wall-clock timestamp in ms (injectable for testing). */
	now: number;
	/** A claim is "stale" when it was last renewed more than this many ms ago. Default: 5 min. */
	staleClaimMs: number;
	/**
	 * Map of role → agentId for the current project, derived from the
	 * `projectRoleSlots` store.  Used by check ORPHANED_SLOT_AGENT.
	 */
	projectRoleSlots?: Partial<Record<string, string>>;
}

export interface AuditReport {
	totalAudited: number;
	autoFixed: AuditFinding[];
	needsAttention: AuditFinding[];
	errors: Array<{ workItemId: string; error: string }>;
}

// ── System actor (used for auto-fix operations) ──────────────────────────────

const AUDIT_ACTOR: WorkGraphActor = {
	type: 'system',
	id: 'pm-audit-runner',
	name: 'PM Audit Runner',
};

// ── The 7 audit checks ────────────────────────────────────────────────────────

/**
 * CHECK 1 — STALE_CLAIM
 *
 * A work item is "claimed" but the active claim's `expiresAt` has already
 * passed (or no expiresAt was set and the claim is older than staleClaimMs).
 * Auto-fix: release the claim and revert Status to `ready`.
 */
const checkStaleClaim: AuditCheck = {
	id: 'STALE_CLAIM',
	description: 'Claimed item with no agent heartbeat renewal — lease expired.',
	severity: 'auto-fix',
	run(item, ctx) {
		if (item.status !== 'claimed') return null;
		const claim = item.claim;
		if (!claim || claim.status !== 'active') return null;

		const nowIso = new Date(ctx.now).toISOString();
		const isExpired = claim.expiresAt
			? claim.expiresAt < nowIso
			: // No expiry: treat as stale if claimedAt is older than staleClaimMs
				new Date(claim.claimedAt).getTime() + ctx.staleClaimMs < ctx.now;

		if (!isExpired) return null;

		return {
			workItemId: item.id,
			checkId: 'STALE_CLAIM',
			message: `Claim expired at ${claim.expiresAt ?? '(no expiry set)'} — no agent heartbeat. Will release and set Status → ready.`,
			severity: 'auto-fix',
			autoFixAction: async () => {
				await ctx.workGraph.releaseClaim(item.id, {
					note: 'PM Audit: stale claim auto-released (no heartbeat)',
					actor: AUDIT_ACTOR,
					revertStatusTo: 'ready',
				});
			},
		};
	},
};

/**
 * CHECK 2 — IN_REVIEW_NO_PR
 *
 * Status is `review` but no GitHub pull request number is linked.
 * Manual: surfaced for a human to link the PR or revert status.
 */
const checkInReviewNoPr: AuditCheck = {
	id: 'IN_REVIEW_NO_PR',
	description: 'Status=review but no GitHub PR is linked.',
	severity: 'needs-attention',
	run(item) {
		if (item.status !== 'review') return null;
		const hasPr = !!item.github?.pullRequestNumber;
		if (hasPr) return null;

		return {
			workItemId: item.id,
			checkId: 'IN_REVIEW_NO_PR',
			message: `"${item.title}" is Status=review but has no linked GitHub PR. Link a PR or move Status back to in_progress.`,
			severity: 'needs-attention',
		};
	},
};

/**
 * CHECK 3 — PR_MERGED_NOT_DONE
 *
 * The work item's linked PR carries `merged: true` (via metadata) but the
 * item's Status is not `done`.  Auto-fix: set Status → done.
 */
const checkPrMergedNotDone: AuditCheck = {
	id: 'PR_MERGED_NOT_DONE',
	description: 'Linked PR is merged but Status ≠ done.',
	severity: 'auto-fix',
	run(item, ctx) {
		if (item.status === 'done' || item.status === 'archived' || item.status === 'canceled') {
			return null;
		}
		// We rely on the metadata field "prMerged": true, which delivery-planner/github-sync
		// stamps when it observes a merged PR event.
		const prMerged = item.metadata?.prMerged === true;
		if (!prMerged) return null;

		return {
			workItemId: item.id,
			checkId: 'PR_MERGED_NOT_DONE',
			message: `"${item.title}" has a merged PR but Status is "${item.status}". Auto-setting Status → done.`,
			severity: 'auto-fix',
			autoFixAction: async () => {
				await ctx.workGraph.updateItem({
					id: item.id,
					patch: { status: 'done', completedAt: new Date(ctx.now).toISOString() },
					actor: AUDIT_ACTOR,
				});
			},
		};
	},
};

/**
 * CHECK 4 — DUPLICATE_TITLE
 *
 * Two or more work items share the same title under the same parent epic.
 * Manual: flag both items so a human can decide which to remove.
 *
 * NOTE: This check is run at the collection level, not per-item.  We implement
 * it as an AuditCheck by keeping per-run state that is reset via the `reset()`
 * call at the start of `runAudit`. The AuditCheck interface is item-level, so
 * we accumulate a seen-map and emit a finding on the second occurrence.
 */
function makeDuplicateTitleCheck(): AuditCheck & { reset(): void } {
	// key: `${parentWorkItemId ?? '__root__'}:${title.toLowerCase().trim()}`
	const seen = new Map<string, string>(); // key → first workItemId

	return {
		id: 'DUPLICATE_TITLE',
		description: 'Two work items share the same title under the same epic.',
		severity: 'needs-attention',
		reset() {
			seen.clear();
		},
		run(item) {
			// Skip terminal states — duplicates in done/archived/canceled are low-signal noise.
			if (item.status === 'done' || item.status === 'archived' || item.status === 'canceled') {
				return null;
			}
			const key = `${item.parentWorkItemId ?? '__root__'}:${item.title.toLowerCase().trim()}`;
			if (!seen.has(key)) {
				seen.set(key, item.id);
				return null;
			}
			const firstId = seen.get(key)!;
			return {
				workItemId: item.id,
				checkId: 'DUPLICATE_TITLE',
				message: `"${item.title}" duplicates work item ${firstId} under the same epic/parent. Review and consolidate.`,
				severity: 'needs-attention',
			};
		},
	};
}

/**
 * CHECK 5 — IN_PROGRESS_NO_ROLE
 *
 * Status is `in_progress` but no owner/role is assigned.
 * Auto-fix: set Status → blocked with reason="no role assigned".
 */
const checkInProgressNoRole: AuditCheck = {
	id: 'IN_PROGRESS_NO_ROLE',
	description: 'Status=in_progress but no agent role is assigned.',
	severity: 'auto-fix',
	run(item, ctx) {
		if (item.status !== 'in_progress') return null;
		const hasOwner = !!item.owner?.id;
		if (hasOwner) return null;

		return {
			workItemId: item.id,
			checkId: 'IN_PROGRESS_NO_ROLE',
			message: `"${item.title}" is in_progress but has no role/owner assigned. Auto-setting Status → blocked (no role assigned).`,
			severity: 'auto-fix',
			autoFixAction: async () => {
				await ctx.workGraph.updateItem({
					id: item.id,
					patch: { status: 'blocked', metadata: { blockedReason: 'no role assigned' } },
					actor: AUDIT_ACTOR,
				});
			},
		};
	},
};

/**
 * CHECK 6 — ORPHANED_SLOT_AGENT
 *
 * An agent is assigned to the work item (item.owner) but the role that agent
 * occupies is no longer present in `projectRoleSlots`.  This means the slot
 * was removed mid-flight (e.g. the Roles panel was edited while the agent was
 * working).  Manual: surface for human to either re-add the slot or reassign.
 */
const checkOrphanedSlotAgent: AuditCheck = {
	id: 'ORPHANED_SLOT_AGENT',
	description: 'Agent assigned to item but its slot was removed from projectRoleSlots.',
	severity: 'needs-attention',
	run(item, ctx) {
		// Only check active/in-progress items with an assigned owner.
		if (
			item.status === 'done' ||
			item.status === 'archived' ||
			item.status === 'canceled' ||
			item.status === 'blocked'
		) {
			return null;
		}
		const ownerId = item.owner?.id;
		if (!ownerId) return null;

		// No slot map provided — skip (feature not configured).
		const slots = ctx.projectRoleSlots;
		if (!slots) return null;

		// Check whether any active slot still references this agent.
		const slotValues = Object.values(slots);
		const stillInSlot = slotValues.includes(ownerId);
		if (stillInSlot) return null;

		return {
			workItemId: item.id,
			checkId: 'ORPHANED_SLOT_AGENT',
			message: `Agent "${ownerId}" is assigned to "${item.title}" but was removed from projectRoleSlots mid-flight. Re-add the slot or reassign the work item.`,
			severity: 'needs-attention',
		};
	},
};

/**
 * CHECK 7 — DONE_NO_CODE
 *
 * Status is `done` but neither a PR number nor a commit SHA is recorded.
 * Manual: "completed without any code change — was this intentional?"
 */
const checkDoneNoCode: AuditCheck = {
	id: 'DONE_NO_CODE',
	description: 'Status=done but no PR or commit SHA is linked.',
	severity: 'needs-attention',
	run(item) {
		if (item.status !== 'done') return null;
		const hasPr = !!item.github?.pullRequestNumber;
		const hasCommit = !!item.github?.commitSha;
		if (hasPr || hasCommit) return null;

		// Non-code item types are exempt (documents, decisions, milestones).
		const codeItemTypes: Array<typeof item.type> = ['task', 'bug', 'feature', 'chore'];
		if (!codeItemTypes.includes(item.type)) return null;

		return {
			workItemId: item.id,
			checkId: 'DONE_NO_CODE',
			message: `"${item.title}" is marked done but has no linked PR or commit SHA. Was this completed without a code change?`,
			severity: 'needs-attention',
		};
	},
};

// ── runAudit ─────────────────────────────────────────────────────────────────

/**
 * Execute all audit checks against every non-archived work item in the Work Graph.
 *
 * Auto-fix actions are applied immediately (serially, per item) before the
 * function returns so that the returned report reflects the post-fix state.
 *
 * @returns A structured {@link AuditReport} describing findings and auto-fixes applied.
 */
export async function runAudit(ctx: AuditContext): Promise<AuditReport> {
	const duplicateTitleCheck = makeDuplicateTitleCheck();
	duplicateTitleCheck.reset();

	const checks: AuditCheck[] = [
		checkStaleClaim,
		checkInReviewNoPr,
		checkPrMergedNotDone,
		duplicateTitleCheck,
		checkInProgressNoRole,
		checkOrphanedSlotAgent,
		checkDoneNoCode,
	];

	// Fetch all non-archived work items.
	const listResult = await ctx.workGraph.listItems({
		statuses: [
			'discovered',
			'planned',
			'ready',
			'claimed',
			'in_progress',
			'blocked',
			'review',
			'done',
		],
	});

	const report: AuditReport = {
		totalAudited: listResult.total ?? listResult.items.length,
		autoFixed: [],
		needsAttention: [],
		errors: [],
	};

	for (const item of listResult.items) {
		for (const check of checks) {
			let finding: AuditFinding | null = null;
			try {
				finding = check.run(item, ctx);
			} catch (err) {
				report.errors.push({
					workItemId: item.id,
					error: `check ${check.id} threw: ${err instanceof Error ? err.message : String(err)}`,
				});
				continue;
			}

			if (!finding) continue;

			if (finding.severity === 'auto-fix' && finding.autoFixAction) {
				try {
					await finding.autoFixAction();
					report.autoFixed.push(finding);
				} catch (err) {
					// Auto-fix failed — demote to needs-attention so it isn't silently swallowed.
					const demoted: AuditFinding = {
						...finding,
						severity: 'needs-attention',
						message: `${finding.message} [auto-fix failed: ${err instanceof Error ? err.message : String(err)}]`,
					};
					report.needsAttention.push(demoted);
				}
			} else {
				report.needsAttention.push(finding);
			}
		}
	}

	return report;
}
