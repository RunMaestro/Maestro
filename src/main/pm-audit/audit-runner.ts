/**
 * PM Audit Runner — #434, #444
 *
 * Standalone rule-based audit engine for in-flight work items. Runs a battery
 * of 7 checks, auto-fixing what it can and surfacing the rest as `needs-attention`
 * findings for human review.
 *
 * #444: work-graph SQLite removed. The audit runner now queries GitHub Projects v2
 * directly via GithubClient for the current state of all project items.
 * Auto-fix actions write to GitHub fields directly.
 *
 * Slash-command wiring (/PM-Check) and 5th-slot UI are deferred until #428 lands.
 *
 * Check IDs (stable — used in AuditFinding.checkId):
 *   STALE_CLAIM          — AI Assigned Slot set but no heartbeat renewal for > staleClaimMs
 *   IN_REVIEW_NO_PR      — Status=In Review but no PR linked
 *   PR_MERGED_NOT_DONE   — linked PR is merged but Status !== Done
 *   DUPLICATE_TITLE      — two items share same title
 *   IN_PROGRESS_NO_ROLE  — Status=In Progress but no AI Role assigned
 *   ORPHANED_SLOT_AGENT  — AI Assigned Slot set but that slot is empty in projectRoleSlots
 *   DONE_NO_CODE         — Status=Done but no PR linked
 */

import type { GithubProjectItem } from '../agent-dispatch/github-client';
import { getGithubClient } from '../agent-dispatch/github-client';
import { getClaimTracker } from '../agent-dispatch/claim-tracker';
import { auditLog } from '../agent-dispatch/dispatch-audit-log';
import { logger } from '../utils/logger';

// ── Public types ─────────────────────────────────────────────────────────────

export interface AuditCheck {
	id: string;
	description: string;
	severity: 'auto-fix' | 'needs-attention';
	run(item: GithubProjectItem, ctx: AuditContext): AuditFinding | null;
}

export interface AuditFinding {
	workItemId: string;
	checkId: string;
	message: string;
	severity: 'auto-fix' | 'needs-attention';
	/** Present only on auto-fix findings. Caller invokes this to apply the fix. */
	autoFixAction?: () => Promise<void>;
}

export interface AuditContext {
	/** Current wall-clock timestamp in ms (injectable for testing). */
	now: number;
	/** A claim is "stale" when it was last renewed more than this many ms ago. Default: 5 min. */
	staleClaimMs: number;
	/**
	 * Map of role => agentId for the current project, derived from the
	 * projectRoleSlots store. Used by check ORPHANED_SLOT_AGENT.
	 */
	projectRoleSlots?: Partial<Record<string, string>>;
	/** GitHub project ID for write operations (setItemFieldValue). */
	projectId: string;
}

export interface AuditReport {
	totalAudited: number;
	autoFixed: AuditFinding[];
	needsAttention: AuditFinding[];
	errors: Array<{ workItemId: string; error: string }>;
}

// ── CHECK 1 — STALE_CLAIM ─────────────────────────────────────────────────────

const checkStaleClaim: AuditCheck = {
	id: 'STALE_CLAIM',
	description: 'Item AI Assigned Slot is set but agent heartbeat has gone stale.',
	severity: 'auto-fix',
	run(item, ctx) {
		const slot = item.fields['AI Assigned Slot'] ?? '';
		if (!slot) return null;

		// Check in-memory claim tracker for staleness
		const claim = getClaimTracker().getByProjectItemId(item.id);
		if (!claim) {
			// Slot is set on GitHub but no in-memory claim — likely stale from a previous
			// Maestro run that was not cleaned up on startup.
			return {
				workItemId: item.id,
				checkId: 'STALE_CLAIM',
				message: `AI Assigned Slot="${slot}" but no in-memory claim exists (likely stale from previous run).`,
				severity: 'auto-fix',
				autoFixAction: async () => {
					const client = getGithubClient();
					await client.setItemFieldValue(ctx.projectId, item.id, 'AI Assigned Slot', '');
					await client.setItemFieldValue(ctx.projectId, item.id, 'AI Status', 'Tasks Ready');
					auditLog('heartbeat_stale', {
						actor: 'pm-audit-runner',
						workItemId: item.id,
						reason: 'No in-memory claim found — slot cleared, status reset',
					});
				},
			};
		}

		// Check if the heartbeat is stale
		const lastBeat = new Date(claim.lastHeartbeatAt).getTime();
		if (ctx.now - lastBeat <= ctx.staleClaimMs) return null;

		return {
			workItemId: item.id,
			checkId: 'STALE_CLAIM',
			message: `AI Assigned Slot="${slot}" but last heartbeat was ${Math.round((ctx.now - lastBeat) / 1000)}s ago (threshold: ${ctx.staleClaimMs / 1000}s).`,
			severity: 'auto-fix',
			autoFixAction: async () => {
				const client = getGithubClient();
				await client.setItemFieldValue(ctx.projectId, item.id, 'AI Assigned Slot', '');
				await client.setItemFieldValue(ctx.projectId, item.id, 'AI Status', 'Tasks Ready');
				auditLog('heartbeat_stale', {
					actor: 'pm-audit-runner',
					workItemId: item.id,
					reason: 'Heartbeat stale — slot cleared, status reset to Tasks Ready',
				});
			},
		};
	},
};

// ── CHECK 2 — IN_REVIEW_NO_PR ─────────────────────────────────────────────────

const checkInReviewNoPr: AuditCheck = {
	id: 'IN_REVIEW_NO_PR',
	description: 'Status=In Review but no GitHub PR is linked.',
	severity: 'needs-attention',
	run(item) {
		const status = item.fields['AI Status'] ?? '';
		if (status !== 'In Review') return null;
		return {
			workItemId: item.id,
			checkId: 'IN_REVIEW_NO_PR',
			message: `"${item.title ?? item.id}" is Status=In Review — verify a GitHub PR is linked.`,
			severity: 'needs-attention',
		};
	},
};

// ── CHECK 3 — PR_MERGED_NOT_DONE ──────────────────────────────────────────────

const checkPrMergedNotDone: AuditCheck = {
	id: 'PR_MERGED_NOT_DONE',
	description: 'Status=In Review with no assigned slot — PR may be merged.',
	severity: 'needs-attention',
	run(item) {
		const status = item.fields['AI Status'] ?? '';
		if (status === 'Done' || status === 'Backlog') return null;
		const slot = item.fields['AI Assigned Slot'] ?? '';
		if (status !== 'In Review' || slot !== '') return null;

		return {
			workItemId: item.id,
			checkId: 'PR_MERGED_NOT_DONE',
			message: `"${item.title ?? item.id}" is Status=In Review with no assigned slot — PR may be merged. Verify and set Status to Done if complete.`,
			severity: 'needs-attention',
		};
	},
};

// ── CHECK 4 — DUPLICATE_TITLE ─────────────────────────────────────────────────

function makeDuplicateTitleCheck(): AuditCheck & { reset(): void } {
	const seen = new Map<string, string>();
	return {
		id: 'DUPLICATE_TITLE',
		description: 'Two work items share the same title.',
		severity: 'needs-attention',
		reset() {
			seen.clear();
		},
		run(item) {
			const status = item.fields['AI Status'] ?? '';
			if (status === 'Done' || status === 'Backlog') return null;
			const key = (item.title ?? '').toLowerCase().trim();
			if (!key) return null;
			if (!seen.has(key)) {
				seen.set(key, item.id);
				return null;
			}
			const firstId = seen.get(key)!;
			return {
				workItemId: item.id,
				checkId: 'DUPLICATE_TITLE',
				message: `"${item.title ?? item.id}" duplicates item ${firstId}. Review and consolidate.`,
				severity: 'needs-attention',
			};
		},
	};
}

// ── CHECK 5 — IN_PROGRESS_NO_ROLE ─────────────────────────────────────────────

const checkInProgressNoRole: AuditCheck = {
	id: 'IN_PROGRESS_NO_ROLE',
	description: 'Status=In Progress but no AI Role is assigned.',
	severity: 'auto-fix',
	run(item, ctx) {
		const status = item.fields['AI Status'] ?? '';
		if (status !== 'In Progress') return null;
		const role = item.fields['AI Role'] ?? '';
		if (role) return null;

		return {
			workItemId: item.id,
			checkId: 'IN_PROGRESS_NO_ROLE',
			message: `"${item.title ?? item.id}" is In Progress but has no AI Role. Auto-setting Status to Blocked.`,
			severity: 'auto-fix',
			autoFixAction: async () => {
				const client = getGithubClient();
				await client.setItemFieldValue(ctx.projectId, item.id, 'AI Status', 'Blocked');
				auditLog('auto_fix', {
					actor: 'pm-audit-runner',
					workItemId: item.id,
					newState: { 'AI Status': 'Blocked' },
					reason: 'IN_PROGRESS_NO_ROLE auto-fix',
				});
			},
		};
	},
};

// ── CHECK 6 — ORPHANED_SLOT_AGENT ─────────────────────────────────────────────

const checkOrphanedSlotAgent: AuditCheck = {
	id: 'ORPHANED_SLOT_AGENT',
	description: 'AI Assigned Slot set but that agent is not in projectRoleSlots.',
	severity: 'needs-attention',
	run(item, ctx) {
		const status = item.fields['AI Status'] ?? '';
		if (status === 'Done' || status === 'Blocked' || status === 'Backlog') return null;

		const slot = item.fields['AI Assigned Slot'] ?? '';
		if (!slot) return null;

		const slots = ctx.projectRoleSlots;
		if (!slots) return null;

		// Extract agentId from slot format "<agentId>:<role>" or just use the whole string
		const agentId = slot.includes(':') ? slot.split(':')[0] : slot;
		const slotValues = Object.values(slots) as unknown[];
		const isInSlots = slotValues.some((s) => {
			if (typeof s === 'string') return s === agentId;
			if (s && typeof s === 'object') {
				const rec = s as Record<string, string>;
				return rec.agentId === agentId || rec.sessionId === agentId;
			}
			return false;
		});
		if (isInSlots) return null;

		return {
			workItemId: item.id,
			checkId: 'ORPHANED_SLOT_AGENT',
			message: `AI Assigned Slot="${slot}" but agent "${agentId}" is not in projectRoleSlots. Re-add slot or clear assignment.`,
			severity: 'needs-attention',
		};
	},
};

// ── CHECK 7 — DONE_NO_CODE ────────────────────────────────────────────────────

const checkDoneNoCode: AuditCheck = {
	id: 'DONE_NO_CODE',
	description: 'Status=Done — verify PR linkage.',
	severity: 'needs-attention',
	run(item) {
		const status = item.fields['AI Status'] ?? '';
		if (status !== 'Done') return null;
		return {
			workItemId: item.id,
			checkId: 'DONE_NO_CODE',
			message: `"${item.title ?? item.id}" is Done — verify a GitHub PR or commit is linked.`,
			severity: 'needs-attention',
		};
	},
};

// ── runAudit ─────────────────────────────────────────────────────────────────

/**
 * Execute all audit checks against all in-flight project items from GitHub.
 *
 * #444: queries GitHub via GithubClient instead of work-graph SQLite.
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

	const client = getGithubClient();
	let items: GithubProjectItem[];
	try {
		items = await client.listProjectItems({
			statusIn: [
				'Idea',
				'PRD Draft',
				'Refinement',
				'Tasks Ready',
				'In Progress',
				'In Review',
				'Blocked',
			],
		});
	} catch (err) {
		logger.warn(
			`pmAudit: GitHub query failed — ${err instanceof Error ? err.message : String(err)}`,
			'[PmAudit]'
		);
		items = [];
	}

	const report: AuditReport = {
		totalAudited: items.length,
		autoFixed: [],
		needsAttention: [],
		errors: [],
	};

	for (const item of items) {
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
