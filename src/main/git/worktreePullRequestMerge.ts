import type {
	WorktreePullRequestMergeRequest,
	WorktreePullRequestMergeResult,
} from '../../shared/worktreePullRequests';
import { getExpandedEnv, resolveGhPath } from '../utils/cliDetection';
import { execFileNoThrow } from '../utils/execFile';
import { preflightWorktreePullRequestMerge } from './worktreePullRequestMergePreflight';

const ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    name owner { login }
    pullRequest(number: $number) {
      id number state headRefOid headRefName baseRefName
      headRepository { name owner { login } }
    }
  }
}`;

const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) {
    mergeQueueEntry { id }
  }
}`;

/** Mutates only the freshly reviewed GitHub PR and reconciles every attempted mutation. */
export async function mergeWorktreePullRequest(
	request: WorktreePullRequestMergeRequest
): Promise<WorktreePullRequestMergeResult> {
	const action = request?.action;
	if (
		(request?.sshRemoteId !== undefined &&
			(typeof request.sshRemoteId !== 'string' || !request.sshRemoteId)) ||
		!action ||
		(action.kind !== 'enqueue' && action.kind !== 'merge') ||
		(action.kind === 'merge' && !['merge', 'squash', 'rebase'].includes(action.method))
	)
		return { status: 'unknown', message: 'Invalid merge action.' };

	const preflight = await preflightWorktreePullRequestMerge(request);
	if (preflight.status === 'unavailable') return { status: 'unknown', message: preflight.message };
	if (preflight.status === 'merged') return { ...preflight, observed: 'before-attempt' };
	if (preflight.status !== 'ready') return preflight;
	if (preflight.queueRequired !== (action.kind === 'enqueue'))
		return {
			status: 'blocked',
			blockers: [
				{ code: 'queue', message: 'The selected action does not match GitHub queue requirements.' },
			],
		};
	if (action.kind === 'merge' && !preflight.allowedMethods.includes(action.method))
		return {
			status: 'blocked',
			blockers: [{ code: 'method', message: 'Merge method is not enabled.' }],
		};

	const target = preflight.target;
	let gh: string;
	let id: string;
	try {
		gh = await resolveGhPath();
		const response = await execFileNoThrow(
			gh,
			[
				'api',
				'--hostname',
				'github.com',
				'graphql',
				'-f',
				`query=${ID_QUERY}`,
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
		if (response.exitCode !== 0)
			return { status: 'unknown', message: 'Could not identify the GitHub pull request.' };
		const data = JSON.parse(response.stdout);
		const repo = data.data?.repository;
		const pr = repo?.pullRequest;
		const equal = (a: unknown, b: string) =>
			typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
		if (
			data.errors?.length ||
			!repo ||
			!pr ||
			typeof pr.id !== 'string' ||
			!pr.id ||
			!equal(repo.owner?.login, target.identity.repository.owner) ||
			!equal(repo.name, target.identity.repository.name) ||
			pr.number !== target.identity.number ||
			!equal(pr.headRepository?.owner?.login, target.headRepository.owner) ||
			!equal(pr.headRepository?.name, target.headRepository.name) ||
			pr.headRefName !== target.headBranch ||
			pr.baseRefName !== target.baseBranch ||
			!equal(pr.headRefOid, target.headSha) ||
			pr.state !== 'OPEN'
		) {
			const current = await preflightWorktreePullRequestMerge(request);
			if (current.status === 'merged') return { ...current, observed: 'before-attempt' };
			if (current.status === 'queued' || current.status === 'blocked') return current;
			return {
				status: 'unknown',
				message: 'Pull request identity or state changed before mutation; refresh and retry.',
			};
		}
		id = pr.id;
	} catch {
		return { status: 'unknown', message: 'Could not identify the GitHub pull request.' };
	}

	let rejected = false;
	try {
		const args =
			action.kind === 'enqueue'
				? [
						'api',
						'--hostname',
						'github.com',
						'graphql',
						'-f',
						`query=${ENQUEUE}`,
						'-f',
						`id=${id}`,
						'-f',
						`head=${target.headSha}`,
					]
				: [
						'pr',
						'merge',
						String(target.identity.number),
						'--repo',
						`github.com/${target.identity.repository.owner}/${target.identity.repository.name}`,
						`--${action.method}`,
						'--match-head-commit',
						target.headSha,
					];
		const result = await execFileNoThrow(gh, args, request.worktreePath, {
			timeout: 30000,
			env: getExpandedEnv(),
		});
		if (action.kind === 'enqueue' && result.stdout) {
			const response = JSON.parse(result.stdout);
			rejected = Array.isArray(response.errors) && response.errors.length > 0 && !response.data;
		} else if (action.kind === 'merge') {
			// Numeric nonzero exits are CLI failures; timeout and lost responses remain ambiguous.
			rejected = typeof result.exitCode === 'number' && result.exitCode !== 0;
		}
	} catch {
		// A timeout, lost response, or malformed reply can still have reached GitHub.
	}

	const reconciled = await preflightWorktreePullRequestMerge(request);
	if (reconciled.status === 'merged') return { ...reconciled, observed: 'after-attempt' };
	if (reconciled.status === 'queued') return reconciled;
	if (
		reconciled.status === 'blocked' &&
		reconciled.blockers.some(
			(b) => b.code === 'closed' || b.code === 'head-changed' || b.code === 'identity-changed'
		)
	)
		return reconciled;
	if (rejected)
		return {
			status: 'blocked',
			blockers: [
				{
					code: 'unknown',
					message: 'GitHub rejected the operation; refresh the pull request for details.',
				},
			],
		};
	return {
		status: 'unknown',
		message: 'The GitHub operation could not be confirmed; refresh before retrying.',
	};
}
