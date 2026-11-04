import type {
	WorktreePullRequest,
	WorktreePullRequestMergePreflightRequest,
	WorktreePullRequestMergeTarget,
} from './worktreePullRequests';

/** Persisted user choice. Automatic cleanup requires a separate, explicit opt-in. */
export type WorktreePullRequestCleanupPolicy =
	| { mode: 'keep' }
	| { mode: 'ask' }
	| { mode: 'automatic'; optedIn: true };

/** Missing, legacy or malformed settings preserve the checkout. No migration writes. */
export function resolveWorktreePullRequestCleanupPolicy(
	raw: unknown
): WorktreePullRequestCleanupPolicy {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'mode'))
		return { mode: 'keep' };
	const stored = raw as Record<string, unknown>;
	if (stored.mode === 'ask') return { mode: 'ask' };
	if (stored.mode === 'automatic' && Object.hasOwn(stored, 'optedIn') && stored.optedIn === true)
		return { mode: 'automatic', optedIn: true };
	return { mode: 'keep' };
}

export type WorktreePullRequestCleanupIntent =
	| 'keep'
	| 'awaiting-merge'
	| 'ask'
	| 'preflight-required';

/**
 * Post-merge notification/scheduling decision only. A displayed MERGED state and
 * an opt-in never authorize removal; the backend must independently verify safety.
 * An explicit manual cleanup action also needs its own fresh, guarded preflight.
 */
export function getWorktreePullRequestCleanupIntent(
	rawPolicy: unknown,
	state: WorktreePullRequest['state'] | undefined
): WorktreePullRequestCleanupIntent {
	const policy = resolveWorktreePullRequestCleanupPolicy(rawPolicy);
	if (policy.mode === 'keep') return 'keep';
	if (state !== 'MERGED') return 'awaiting-merge';
	return policy.mode === 'ask' ? 'ask' : 'preflight-required';
}

export interface WorktreePullRequestCleanupPreflightRequest extends WorktreePullRequestMergePreflightRequest {
	/** Resolve the owning agent and parent from trusted main-process registration. */
	sessionId: string;
}

/**
 * Fresh GitHub evidence for the exact PR head, including squash/rebase merges.
 * Local ancestry of the merge commit alone cannot establish that a PR was merged.
 */
export interface WorktreePullRequestCleanupMergeEvidence {
	target: WorktreePullRequestMergeTarget;
	mergedAt: string;
	mergeCommitSha: string;
}

/** Describes the verified checkout; it is neither a lease nor a removal token. */
export interface WorktreePullRequestCleanupSnapshot {
	sessionId: string;
	parentSessionId: string;
	/** Real paths established from registration, the filesystem and Git registry. */
	worktreePath: string;
	mainWorktreePath: string;
	commonGitDirectory: string;
	branch: string;
	/** Must equal the independently confirmed PR head, never merely an ancestor. */
	localHeadSha: string;
	merge: WorktreePullRequestCleanupMergeEvidence;
	checkedAt: string;
}

export interface WorktreePullRequestCleanupBlocker {
	code:
		| 'ssh-unsupported'
		| 'registration'
		| 'path'
		| 'main-checkout'
		| 'repository'
		| 'identity-changed'
		| 'head-changed'
		| 'unmerged'
		| 'dirty'
		| 'untracked'
		| 'ignored-data'
		| 'active-consumer'
		| 'mutation-busy'
		| 'unknown';
	message: string;
}

/**
 * Readiness is advisory. Execution must acquire mutation exclusion, re-read
 * policy/consent, and repeat all checks before a non-forced Git removal.
 * Missing/unsupported consumer or filesystem evidence must be a blocker.
 */
export type WorktreePullRequestCleanupPreflight =
	| { status: 'eligible'; snapshot: WorktreePullRequestCleanupSnapshot }
	| { status: 'blocked'; blockers: WorktreePullRequestCleanupBlocker[] };
