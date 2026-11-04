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
