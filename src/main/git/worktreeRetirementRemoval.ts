/** Checked, local-only Git removal. Callers retain the Main fence throughout. */
import * as fs from 'fs';
import type { ManagedCheckout } from './worktreeRetirement';
import { discoverWorktreePullRequest } from './worktreePullRequests';
import { execGitReadOnly } from '../utils/remote-git';
import { execFileNoThrow } from '../utils/execFile';
import { getExpandedEnv, resolveGhPath } from '../utils/cliDetection';

/** Independently re-read GitHub, never accept a renderer's merged flag.
 * The original PR head must equal local HEAD. An ancestry test against the base
 * would incorrectly reject squash/rebase merges, whose commit ids differ.
 */
export async function verifyRetirementMerge(checkout: Readonly<ManagedCheckout>): Promise<void> {
	const ownership = checkout.ownership;
	if (!ownership) throw new Error('Trusted checkout ownership required');
	const found = await discoverWorktreePullRequest({ worktreePath: checkout.path });
	if (
		found.status !== 'found' ||
		found.pullRequest.state !== 'MERGED' ||
		found.head.branch !== ownership.branch ||
		found.head.localSha !== checkout.head ||
		found.pullRequest.headSha !== checkout.head
	)
		throw new Error('A uniquely identified merged PR with the exact local HEAD is required');
	const pr = found.pullRequest;
	const repo = pr.identity.repository;
	if (repo.host !== 'github.com' || !/^[\w.-]+$/.test(repo.owner) || !/^[\w.-]+$/.test(repo.name))
		throw new Error('Unsupported GitHub repository');
	const result = await execFileNoThrow(
		await resolveGhPath(),
		[
			'api',
			'--hostname',
			'github.com',
			`repos/${repo.owner}/${repo.name}/pulls/${pr.identity.number}`,
		],
		checkout.path,
		{ timeout: 30000, env: getExpandedEnv() }
	);
	if (result.exitCode !== 0) throw new Error('Fresh GitHub merge confirmation unavailable');
	const remote = JSON.parse(result.stdout);
	const same = (a: unknown, b: string) =>
		typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
	if (
		remote.number !== pr.identity.number ||
		remote.state !== 'closed' ||
		remote.merged !== true ||
		typeof remote.merged_at !== 'string' ||
		!Number.isFinite(Date.parse(remote.merged_at)) ||
		typeof remote.merge_commit_sha !== 'string' ||
		!/^[a-f\d]{40,64}$/i.test(remote.merge_commit_sha) ||
		!same(remote.head?.repo?.owner?.login, pr.headRepository.owner) ||
		!same(remote.head?.repo?.name, pr.headRepository.name) ||
		remote.head?.ref !== ownership.branch ||
		!same(remote.head?.sha, checkout.head) ||
		!same(remote.base?.repo?.owner?.login, repo.owner) ||
		!same(remote.base?.repo?.name, repo.name) ||
		remote.base?.ref !== pr.baseBranch
	)
		throw new Error('GitHub merge identity or state changed');
}

/** Ignored files are unsecured data too: non-force Git removal alone can erase
 * them. Hidden index entries and submodules require unsupported extra evidence.
 */
export async function verifyRetirementClean(checkout: Readonly<ManagedCheckout>): Promise<void> {
	const status = await execGitReadOnly(
		[
			'-c',
			'core.fsmonitor=false',
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--ignored=matching',
		],
		checkout.path
	);
	if (status.exitCode !== 0 || status.stdout !== '')
		throw new Error(
			'Checkout contains changed, untracked or ignored data, or status is unavailable'
		);
	const index = await execGitReadOnly(['ls-files', '-v', '-z'], checkout.path);
	if (
		index.exitCode !== 0 ||
		index.stdout.split('\0').some((entry) => entry && !entry.startsWith('H '))
	)
		throw new Error('Checkout has hidden index entries or index evidence is unavailable');
	const staged = await execGitReadOnly(['ls-files', '--stage', '-z'], checkout.path);
	if (
		staged.exitCode !== 0 ||
		staged.stdout.split('\0').some((entry) => entry.startsWith('160000 '))
	)
		throw new Error('Submodule cleanup is unsupported or index evidence is unavailable');
}

/** No force, branch deletion, recursive fallback, shell, or timeout unlock.
 * Even a nonzero/lost result can have partially changed the Git administration.
 */
export async function removeRetirementCheckout(checkout: Readonly<ManagedCheckout>): Promise<void> {
	if (!checkout.ownership) throw new Error('Trusted checkout ownership required');
	const result = await execFileNoThrow(
		'git',
		['worktree', 'remove', '--', checkout.path],
		checkout.ownership.parentPath
	);
	if (result.exitCode !== 0) throw new Error('Git refused removal or its result is uncertain');
	for (const endpoint of [checkout.path, checkout.ownership.gitDir]) {
		try {
			fs.lstatSync(endpoint);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		throw new Error('Git removal has not settled on disk');
	}
}
