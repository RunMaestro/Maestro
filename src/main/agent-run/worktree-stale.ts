/**
 * AgentRun worktree-stale marker (F6, ISC-6.7 / D12).
 *
 * When a run's worktree is deleted - either through the git handler
 * (`git:removeWorktree`) or a watched filesystem deletion event
 * (`unlinkDir`) - the run is no longer a valid jump/diff target. Rather than
 * let the dashboard present a broken worktree, we mark every non-terminal run
 * bound to that path with a `metadata.stale = true` flag. We deliberately do
 * NOT invent a 'stale' status: the AgentRunStatus set is fixed and terminal
 * transitions are audited, so a metadata flag is the correct, additive signal.
 *
 * The core `markStaleForDeletedWorktree` is pure over injected store deps so it
 * is unit-testable without fs/electron. `markStaleForDeletedWorktreeUsingStore`
 * wires the real store + broadcast for the main process and never throws (a
 * marking failure must not break worktree removal or the fs watcher).
 */

import * as path from 'path';
import type { AgentRun } from '../../shared/agent-run';
import { isTerminalAgentRunStatus } from '../../shared/agent-run';
import { readAgentRuns, upsertAgentRun } from '../../cli/services/agent-run-store';
import { broadcastRunUpdated } from './broadcast';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[AgentRun:WorktreeStale]';

export interface WorktreeStaleDeps {
	/** All known runs (unfiltered snapshot). */
	listRuns: () => AgentRun[];
	/** Persist an updated run; returns the saved run. */
	upsertRun: (run: AgentRun) => AgentRun;
	/** Optional clock override for deterministic tests. */
	now?: () => number;
	/** Optional post-write hook (e.g. live-push broadcast). */
	onRunUpdated?: (run: AgentRun) => void;
}

// Filesystem paths from chokidar vs. the stored worktreePath can differ in
// separators and (on Windows) case, so compare on a resolved, case-folded form.
function normalizeWorktreePath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Flag every non-terminal run bound to `worktreePath` as stale. Idempotent: a
 * run already flagged stale is skipped. Returns the runs that were updated.
 */
export function markStaleForDeletedWorktree(
	worktreePath: string,
	deps: WorktreeStaleDeps
): AgentRun[] {
	const normalizedTarget = normalizeWorktreePath(worktreePath);
	const timestamp = deps.now ? deps.now() : Date.now();

	const affected = deps
		.listRuns()
		.filter(
			(run) =>
				run.worktreePath !== undefined &&
				normalizeWorktreePath(run.worktreePath) === normalizedTarget &&
				!isTerminalAgentRunStatus(run.status) &&
				run.metadata?.stale !== true
		);

	return affected.map((run) => {
		const updated: AgentRun = {
			...run,
			updatedAt: timestamp,
			metadata: {
				...(run.metadata ?? {}),
				stale: true,
				staleReason: 'worktree-deleted',
				staleWorktreePath: worktreePath,
				staleAt: timestamp,
			},
		};
		const saved = deps.upsertRun(updated);
		deps.onRunUpdated?.(saved);
		return saved;
	});
}

/**
 * Store-wired convenience for the main process. Never throws: a marking failure
 * is logged and swallowed so worktree removal / the fs watcher stay unaffected.
 */
export function markStaleForDeletedWorktreeUsingStore(worktreePath: string): AgentRun[] {
	try {
		const updated = markStaleForDeletedWorktree(worktreePath, {
			listRuns: readAgentRuns,
			upsertRun: upsertAgentRun,
			onRunUpdated: broadcastRunUpdated,
		});
		if (updated.length > 0) {
			logger.info(
				`${LOG_CONTEXT} Marked ${updated.length} run(s) stale for deleted worktree: ${worktreePath}`
			);
		}
		return updated;
	} catch (error) {
		logger.warn(
			`${LOG_CONTEXT} Failed to mark runs stale for ${worktreePath}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		return [];
	}
}
