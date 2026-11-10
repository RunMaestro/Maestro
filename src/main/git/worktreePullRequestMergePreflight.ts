import type {
	WorktreePullRequestMergeBlocker,
	WorktreePullRequestMergeMethod,
	WorktreePullRequestMergePreflight,
	WorktreePullRequestMergePreflightRequest,
	WorktreePullRequestRepository,
} from '../../shared/worktreePullRequests';
import { getExpandedEnv, resolveGhPath } from '../utils/cliDetection';
import { execFileNoThrow } from '../utils/execFile';
import { execGitReadOnly } from '../utils/remote-git';
import { discoverWorktreePullRequest } from './worktreePullRequests';

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    name owner { login } viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      number state isDraft headRefOid headRefName baseRefName
      headRepository { name owner { login } }
      mergeable mergeStateStatus reviewDecision isMergeQueueEnabled isInMergeQueue mergeQueue { id } mergeQueueEntry { id }
    }
  }
}`;

function validRepository(repo: WorktreePullRequestRepository | undefined): boolean {
	return (
		!!repo &&
		repo.host === 'github.com' &&
		typeof repo.owner === 'string' &&
		/^[\w.-]+$/.test(repo.owner) &&
		typeof repo.name === 'string' &&
		/^[\w.-]+$/.test(repo.name)
	);
}

function sameRepository(
	a: WorktreePullRequestRepository,
	b: WorktreePullRequestRepository
): boolean {
	return (
		`${a.host}/${a.owner}/${a.name}`.toLowerCase() ===
		`${b.host}/${b.owner}/${b.name}`.toLowerCase()
	);
}

/** Fresh, read-only preflight. GitHub must still enforce every rule on mutation. */
export async function preflightWorktreePullRequestMerge(
	request: WorktreePullRequestMergePreflightRequest
): Promise<WorktreePullRequestMergePreflight> {
	if (request?.sshRemoteId)
		return {
			status: 'unavailable',
			message: 'Merge preflight is not supported for SSH worktrees.',
		};
	const target = request?.target;
	if (
		!request ||
		typeof request.worktreePath !== 'string' ||
		!request.worktreePath ||
		!target ||
		!target.identity ||
		!validRepository(target.identity.repository) ||
		!validRepository(target.headRepository) ||
		!Number.isSafeInteger(target.identity.number) ||
		target.identity.number <= 0 ||
		typeof target.headBranch !== 'string' ||
		!target.headBranch ||
		typeof target.baseBranch !== 'string' ||
		!target.baseBranch ||
		typeof target.headSha !== 'string' ||
		!/^[a-f\d]{40}$/i.test(target.headSha)
	) {
		return { status: 'unavailable', message: 'Invalid merge target or checkout.' };
	}
	const blocked = (
		code: WorktreePullRequestMergeBlocker['code'],
		message: string
	): WorktreePullRequestMergePreflight => ({ status: 'blocked', blockers: [{ code, message }] });
	try {
		const found = await discoverWorktreePullRequest({
			worktreePath: request.worktreePath,
			knownPullRequest: target.identity,
		});
		if (found.status === 'unavailable') return { status: 'unavailable', message: found.message };
		if (found.status !== 'found')
			return blocked('identity-changed', 'The checkout no longer identifies this pull request.');
		const pr = found.pullRequest;
		if (
			!sameRepository(pr.identity.repository, target.identity.repository) ||
			pr.identity.number !== target.identity.number ||
			!sameRepository(pr.headRepository, target.headRepository) ||
			pr.headBranch !== target.headBranch ||
			pr.baseBranch !== target.baseBranch
		)
			return blocked('identity-changed', 'Pull request identity or base changed.');
		if (pr.headSha.toLowerCase() !== target.headSha.toLowerCase())
			return blocked('head-changed', 'Pull request head changed since review.');
		if (found.head.localSha.toLowerCase() !== target.headSha.toLowerCase())
			return blocked('head-changed', 'Local HEAD differs from the reviewed pull request head.');
		const gh = await resolveGhPath();
		const result = await execFileNoThrow(
			gh,
			[
				'api',
				'--hostname',
				'github.com',
				'graphql',
				'-f',
				`query=${QUERY}`,
				'-f',
				`owner=${target.identity.repository.owner}`,
				'-f',
				`name=${target.identity.repository.name}`,
				'-F',
				`number=${target.identity.number}`,
			],
			request.worktreePath,
			{ timeout: 30000, env: getExpandedEnv() }
		);
		if (result.exitCode !== 0)
			return { status: 'unavailable', message: result.stderr || 'GitHub preflight failed.' };
		const response = JSON.parse(result.stdout);
		if (response.errors?.length)
			return {
				status: 'unavailable',
				message: 'GitHub could not provide a complete merge preflight.',
			};
		const repo = response.data?.repository;
		const remote = repo?.pullRequest;
		if (
			!repo ||
			!remote ||
			typeof repo.owner?.login !== 'string' ||
			typeof repo.name !== 'string' ||
			![repo.mergeCommitAllowed, repo.squashMergeAllowed, repo.rebaseMergeAllowed].every(
				(v) => typeof v === 'boolean'
			) ||
			!['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(repo.viewerPermission) ||
			typeof remote.isDraft !== 'boolean' ||
			typeof remote.isMergeQueueEnabled !== 'boolean' ||
			typeof remote.isInMergeQueue !== 'boolean' ||
			remote.isMergeQueueEnabled !== (remote.mergeQueue !== null) ||
			remote.isInMergeQueue !== (remote.mergeQueueEntry !== null) ||
			!['OPEN', 'CLOSED', 'MERGED'].includes(remote.state) ||
			!Object.hasOwn(remote, 'mergeQueue') ||
			!Object.hasOwn(remote, 'mergeQueueEntry') ||
			(remote.mergeQueue !== null && typeof remote.mergeQueue?.id !== 'string') ||
			(remote.mergeQueueEntry !== null && typeof remote.mergeQueueEntry?.id !== 'string')
		)
			return { status: 'unavailable', message: 'Incomplete GitHub merge preflight response.' };
		const apiHead = {
			host: 'github.com',
			owner: remote.headRepository?.owner?.login,
			name: remote.headRepository?.name,
		};
		if (
			!validRepository(apiHead) ||
			!sameRepository(apiHead, target.headRepository) ||
			!sameRepository(
				{ host: 'github.com', owner: repo.owner.login, name: repo.name },
				target.identity.repository
			) ||
			remote.number !== target.identity.number ||
			remote.headRefName !== target.headBranch ||
			remote.baseRefName !== target.baseBranch
		)
			return blocked('identity-changed', 'GitHub pull request identity or base changed.');
		if (
			typeof remote.headRefOid !== 'string' ||
			remote.headRefOid.toLowerCase() !== target.headSha.toLowerCase()
		)
			return blocked('head-changed', 'Pull request head changed since review.');
		if (remote.state !== pr.state || remote.isDraft !== pr.isDraft)
			return {
				status: 'unavailable',
				message: 'Pull request changed during preflight; refresh and retry.',
			};
		// Verify that the local checkout was not switched during network requests.
		const [sha, branch, origin] = await Promise.all([
			execGitReadOnly(['rev-parse', '--verify', 'HEAD'], request.worktreePath),
			execGitReadOnly(['symbolic-ref', '--quiet', '--short', 'HEAD'], request.worktreePath),
			execGitReadOnly(['remote', 'get-url', 'origin'], request.worktreePath),
		]);
		if (
			sha.exitCode !== 0 ||
			branch.exitCode !== 0 ||
			origin.exitCode !== 0 ||
			sha.stdout.trim() !== found.head.localSha ||
			branch.stdout.trim() !== found.head.branch
		)
			return { status: 'unavailable', message: 'Checkout changed during merge preflight.' };
		// Rediscover to verify origin and its fork relationship as well as the PR identity.
		const verified = await discoverWorktreePullRequest({
			worktreePath: request.worktreePath,
			knownPullRequest: target.identity,
		});
		if (
			verified.status !== 'found' ||
			!sameRepository(verified.head.repository, found.head.repository) ||
			verified.head.branch !== found.head.branch ||
			verified.head.localSha !== found.head.localSha ||
			!sameRepository(verified.pullRequest.identity.repository, target.identity.repository) ||
			verified.pullRequest.identity.number !== target.identity.number ||
			!sameRepository(verified.pullRequest.headRepository, target.headRepository) ||
			verified.pullRequest.headBranch !== target.headBranch ||
			verified.pullRequest.baseBranch !== target.baseBranch ||
			verified.pullRequest.headSha.toLowerCase() !== target.headSha.toLowerCase() ||
			verified.pullRequest.state !== pr.state ||
			verified.pullRequest.isDraft !== pr.isDraft
		)
			return {
				status: 'unavailable',
				message: 'Checkout or pull request changed during merge preflight.',
			};
		if (remote.state === 'MERGED') return { status: 'merged', pullRequest: verified.pullRequest };
		if (remote.state === 'CLOSED')
			return blocked('closed', 'Pull request is closed without merging.');
		if (remote.isDraft) return blocked('draft', 'Pull request is a draft.');
		if (remote.mergeQueueEntry) return { status: 'queued', pullRequest: verified.pullRequest };
		const blockers: WorktreePullRequestMergeBlocker[] = [];
		if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission))
			blockers.push({ code: 'protection', message: 'GitHub does not report write access.' });
		if (remote.mergeable === 'CONFLICTING')
			blockers.push({ code: 'conflict', message: 'Pull request has merge conflicts.' });
		else if (remote.mergeable !== 'MERGEABLE')
			blockers.push({ code: 'unknown', message: 'GitHub has not determined mergeability.' });
		if (
			remote.reviewDecision === 'REVIEW_REQUIRED' ||
			remote.reviewDecision === 'CHANGES_REQUESTED'
		)
			blockers.push({ code: 'reviews', message: 'GitHub reports pending or requested reviews.' });
		else if (remote.reviewDecision !== null && remote.reviewDecision !== 'APPROVED')
			blockers.push({ code: 'unknown', message: 'GitHub review status is unavailable.' });
		switch (remote.mergeStateStatus) {
			case 'CLEAN':
			case 'HAS_HOOKS':
			case 'UNSTABLE':
				break;
			case 'DIRTY':
				blockers.push({ code: 'conflict', message: 'GitHub cannot create a clean merge.' });
				break;
			case 'BLOCKED':
			case 'BEHIND':
				blockers.push({
					code: 'protection',
					message: `GitHub merge state is ${remote.mergeStateStatus}; requirements must be satisfied.`,
				});
				break;
			case 'DRAFT':
				blockers.push({ code: 'draft', message: 'GitHub reports a draft pull request.' });
				break;
			default:
				blockers.push({ code: 'unknown', message: 'GitHub merge state is unavailable.' });
		}
		const allowedMethods: WorktreePullRequestMergeMethod[] = [];
		if (repo.mergeCommitAllowed) allowedMethods.push('merge');
		if (repo.squashMergeAllowed) allowedMethods.push('squash');
		if (repo.rebaseMergeAllowed) allowedMethods.push('rebase');
		const queueRequired = remote.isMergeQueueEnabled;
		if (!queueRequired && !allowedMethods.length)
			blockers.push({ code: 'method', message: 'No repository merge methods are enabled.' });
		return blockers.length
			? { status: 'blocked', blockers }
			: { status: 'ready', target, allowedMethods, queueRequired };
	} catch (error) {
		return {
			status: 'unavailable',
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
