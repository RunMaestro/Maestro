import type {
	WorktreePullRequest,
	WorktreePullRequestDiscoveryRequest,
	WorktreePullRequestDiscoveryResult,
	WorktreePullRequestRepository,
} from '../../shared/worktreePullRequests';
import { resolveGhPath, getExpandedEnv } from '../utils/cliDetection';
import { execFileNoThrow } from '../utils/execFile';
import { execGitReadOnly } from '../utils/remote-git';

// Deliberately accept only GitHub.com remotes: a different host needs its own
// authenticated API routing, not a silent request to github.com.
function githubRemote(url: string): WorktreePullRequestRepository | undefined {
	const match =
		/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/]+@)?github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
			url.trim()
		);
	return match ? { host: 'github.com', owner: match[1], name: match[2] } : undefined;
}

function sameRepo(a: WorktreePullRequestRepository, b: WorktreePullRequestRepository): boolean {
	return (
		`${a.host}/${a.owner}/${a.name}`.toLowerCase() ===
		`${b.host}/${b.owner}/${b.name}`.toLowerCase()
	);
}

function repoFromApi(value: any): WorktreePullRequestRepository | undefined {
	if (typeof value?.owner?.login !== 'string' || typeof value?.name !== 'string') return undefined;
	return { host: 'github.com', owner: value.owner.login, name: value.name };
}

function pullFromApi(
	value: any,
	repository: WorktreePullRequestRepository
): WorktreePullRequest | undefined {
	const headRepository = repoFromApi(value?.head?.repo);
	const state = value?.merged_at
		? 'MERGED'
		: value?.state === 'open'
			? 'OPEN'
			: value?.state === 'closed'
				? 'CLOSED'
				: undefined;
	if (
		!headRepository ||
		!state ||
		!Number.isSafeInteger(value.number) ||
		value.number <= 0 ||
		typeof value.title !== 'string' ||
		typeof value.html_url !== 'string' ||
		typeof value.draft !== 'boolean' ||
		typeof value.head?.ref !== 'string' ||
		typeof value.head?.sha !== 'string' ||
		typeof value.base?.ref !== 'string'
	)
		return undefined;
	return {
		identity: { repository, number: value.number },
		title: value.title,
		url: value.html_url,
		state,
		isDraft: value.draft,
		headRepository,
		headBranch: value.head.ref,
		headSha: value.head.sha,
		baseBranch: value.base.ref,
	};
}

/** Discover PRs without relying on AgentRun or guessing the checkout from an SSH path. */
export async function discoverWorktreePullRequest(
	request: WorktreePullRequestDiscoveryRequest
): Promise<WorktreePullRequestDiscoveryResult> {
	if (request.sshRemoteId)
		return {
			status: 'unavailable',
			reason: 'ssh-unsupported',
			message: 'Pull request discovery is not yet supported for SSH worktrees.',
		};
	const cwd = request.worktreePath;
	const unavailable = (
		reason: 'git' | 'repository' | 'gh' | 'invalid-response',
		message: string
	): WorktreePullRequestDiscoveryResult => ({ status: 'unavailable', reason, message });
	try {
		const sha = await execGitReadOnly(['rev-parse', '--verify', 'HEAD'], cwd);
		if (sha.exitCode !== 0 || !sha.stdout.trim())
			return unavailable('git', sha.stderr || 'Cannot read HEAD');
		const branch = await execGitReadOnly(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
		if (branch.exitCode === 1) return { status: 'detached', localSha: sha.stdout.trim() };
		if (branch.exitCode !== 0 || !branch.stdout.trim())
			return unavailable('git', branch.stderr || 'Cannot read branch');
		const remote = await execGitReadOnly(['remote', 'get-url', 'origin'], cwd);
		if (remote.exitCode !== 0) return unavailable('git', remote.stderr || 'Cannot read origin');
		const headRepo = githubRemote(remote.stdout);
		if (!headRepo)
			return unavailable('repository', 'Origin is not a supported GitHub.com repository URL.');
		const head = {
			branch: branch.stdout.trim(),
			localSha: sha.stdout.trim(),
			repository: headRepo,
		};
		const gh = await resolveGhPath();
		const api = async (args: string[]) =>
			execFileNoThrow(gh, ['api', '--hostname', 'github.com', ...args], cwd, {
				timeout: 30000,
				env: getExpandedEnv(),
			});
		const repoResult = await api([`repos/${headRepo.owner}/${headRepo.name}`]);
		if (repoResult.exitCode !== 0)
			return unavailable('gh', repoResult.stderr || 'GitHub repository lookup failed');
		const metadata = JSON.parse(repoResult.stdout);
		const actualHead = repoFromApi(metadata);
		const target = metadata.fork === true ? repoFromApi(metadata.parent) : actualHead;
		if (
			!actualHead ||
			!target ||
			!sameRepo(actualHead, headRepo) ||
			typeof metadata.fork !== 'boolean'
		)
			return unavailable('invalid-response', 'Invalid repository metadata from GitHub.');
		const endpoint = `repos/${target.owner}/${target.name}/pulls`;
		const matchesHead = (pr: WorktreePullRequest) =>
			sameRepo(pr.headRepository, headRepo) && pr.headBranch === head.branch;
		const list = await api([
			'--method',
			'GET',
			'--paginate',
			'--slurp',
			endpoint,
			'-f',
			'state=open',
			'-f',
			`head=${headRepo.owner}:${head.branch}`,
			'-f',
			'per_page=100',
		]);
		if (list.exitCode !== 0)
			return unavailable('gh', list.stderr || 'GitHub pull request lookup failed');
		const pages: unknown = JSON.parse(list.stdout);
		if (!Array.isArray(pages) || !pages.every(Array.isArray))
			return unavailable('invalid-response', 'Invalid pull request list from GitHub.');
		const prs = pages.flat().map((item) => pullFromApi(item, target));
		if (prs.some((pr) => !pr))
			return unavailable('invalid-response', 'Invalid pull request data from GitHub.');
		const matches = (prs as WorktreePullRequest[]).filter(matchesHead);
		if (matches.length > 1) return { status: 'ambiguous', head, pullRequests: matches };
		if (matches.length === 1) return { status: 'found', head, pullRequest: matches[0] };
		const known = request.knownPullRequest;
		if (
			known &&
			sameRepo(known.repository, target) &&
			Number.isSafeInteger(known.number) &&
			known.number > 0
		) {
			const result = await api([`${endpoint}/${known.number}`]);
			if (result.exitCode !== 0)
				return unavailable('gh', result.stderr || 'Known pull request lookup failed');
			const pr = pullFromApi(JSON.parse(result.stdout), target);
			if (!pr)
				return unavailable('invalid-response', 'Invalid known pull request data from GitHub.');
			if (matchesHead(pr)) return { status: 'found', head, pullRequest: pr };
		}
		return { status: 'no-pr', head, repository: target };
	} catch (error) {
		return unavailable(
			error instanceof SyntaxError ? 'invalid-response' : 'gh',
			error instanceof Error ? error.message : String(error)
		);
	}
}
