/** GitHub repository identity, independent of the local remote's name. */
export interface WorktreePullRequestRepository {
	host: string;
	owner: string;
	name: string;
}

/** Stable identity retained after a PR is merged or closed. */
export interface WorktreePullRequestIdentity {
	repository: WorktreePullRequestRepository;
	number: number;
}

/** The checkout and remote head to which a discovery result applies. */
export interface WorktreePullRequestHead {
	branch: string;
	localSha: string;
	repository: WorktreePullRequestRepository;
}

export interface WorktreePullRequest {
	identity: WorktreePullRequestIdentity;
	title: string;
	url: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	isDraft: boolean;
	headRepository: WorktreePullRequestRepository;
	headBranch: string;
	headSha: string;
	baseBranch: string;
}

export interface WorktreePullRequestDiscoveryRequest {
	worktreePath: string;
	/** An SSH project must never be read from the local filesystem. */
	sshRemoteId?: string;
	/** Re-query this PR by number to track it after it leaves the open list. */
	knownPullRequest?: WorktreePullRequestIdentity;
}

/** CI belongs to the GitHub PR head, independently of the checkout's HEAD. */
export type WorktreePullRequestCheckState =
	| 'pending'
	| 'running'
	| 'passed'
	| 'failed'
	| 'skipped'
	| 'cancelled'
	| 'unavailable';

export interface WorktreePullRequestCheck {
	/** GitHub check-run or commit-status identity, scoped to the repository. */
	kind: 'check-run' | 'status';
	id: string;
	name: string;
	state: WorktreePullRequestCheckState;
	detailsUrl: string | null;
	workflow: { id: string; name: string } | null;
	updatedAt: string | null;
}

export type WorktreePullRequestCi =
	| { status: 'no-ci'; headSha: string; checkedAt: string }
	| {
			status: 'available';
			headSha: string;
			checkedAt: string;
			checks: WorktreePullRequestCheck[];
	  }
	| { status: 'unavailable'; headSha: string; checkedAt: string; message: string };

/** Comparison with the PR head; differences do not change remote CI results. */
export type WorktreePullRequestDivergence =
	| { status: 'equal'; localSha: string; pullRequestHeadSha: string }
	| {
			status: 'different';
			localSha: string;
			pullRequestHeadSha: string;
			ahead: number;
			behind: number;
	  }
	| {
			status: 'unavailable';
			localSha: string;
			pullRequestHeadSha: string;
			message: string;
	  };

/** Absence, ambiguity and operational failures must remain distinguishable. */
export type WorktreePullRequestDiscoveryResult =
	| { status: 'found'; head: WorktreePullRequestHead; pullRequest: WorktreePullRequest }
	| { status: 'no-pr'; head: WorktreePullRequestHead; repository: WorktreePullRequestRepository }
	| { status: 'ambiguous'; head: WorktreePullRequestHead; pullRequests: WorktreePullRequest[] }
	| { status: 'detached'; localSha: string }
	| {
			status: 'unavailable';
			reason: 'ssh-unsupported' | 'git' | 'repository' | 'gh' | 'invalid-response';
			message: string;
	  };
