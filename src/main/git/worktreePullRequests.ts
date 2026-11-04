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

/** Read CI for a discovered PR head and compare it with the local checkout. */
export async function readWorktreePullRequestCi(
	request: WorktreePullRequestDiscoveryRequest,
	found: Extract<WorktreePullRequestDiscoveryResult, { status: 'found' }>
): Promise<{
	ci: import('../../shared/worktreePullRequests').WorktreePullRequestCi;
	divergence: import('../../shared/worktreePullRequests').WorktreePullRequestDivergence;
}> {
	const checkedAt = new Date().toISOString();
	const { pullRequest, head } = found;
	const headSha = pullRequest.headSha;
	const unavailableCi = (
		message: string
	): import('../../shared/worktreePullRequests').WorktreePullRequestCi => ({
		status: 'unavailable',
		headSha,
		checkedAt,
		message,
	});
	const unavailableDivergence = (
		message: string
	): import('../../shared/worktreePullRequests').WorktreePullRequestDivergence => ({
		status: 'unavailable',
		localSha: head.localSha,
		pullRequestHeadSha: headSha,
		message,
	});
	if (request.sshRemoteId) {
		const message = 'Pull request checks are not yet supported for SSH worktrees.';
		return { ci: unavailableCi(message), divergence: unavailableDivergence(message) };
	}
	if (!/^[a-f\d]{40,64}$/i.test(headSha) || !/^[a-f\d]{40,64}$/i.test(head.localSha)) {
		const message = 'Invalid commit SHA.';
		return { ci: unavailableCi(message), divergence: unavailableDivergence(message) };
	}
	let divergence: import('../../shared/worktreePullRequests').WorktreePullRequestDivergence =
		unavailableDivergence('Local comparison failed.');
	try {
		const local = await execGitReadOnly(['rev-parse', '--verify', 'HEAD'], request.worktreePath);
		const branch = await execGitReadOnly(
			['symbolic-ref', '--quiet', '--short', 'HEAD'],
			request.worktreePath
		);
		if (
			local.exitCode !== 0 ||
			branch.exitCode !== 0 ||
			local.stdout.trim() !== head.localSha ||
			branch.stdout.trim() !== head.branch
		) {
			const message = 'Checkout changed since PR discovery.';
			return { ci: unavailableCi(message), divergence: unavailableDivergence(message) };
		}
		if (head.localSha === headSha) {
			divergence = { status: 'equal', localSha: head.localSha, pullRequestHeadSha: headSha };
		} else {
			const counts = await execGitReadOnly(
				['rev-list', '--left-right', '--count', `${head.localSha}...${headSha}`],
				request.worktreePath
			);
			const match = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
			divergence =
				counts.exitCode === 0 && match
					? {
							status: 'different',
							localSha: head.localSha,
							pullRequestHeadSha: headSha,
							ahead: Number(match[1]),
							behind: Number(match[2]),
						}
					: unavailableDivergence(
							counts.stderr || 'PR head is not available locally for comparison.'
						);
		}
		const gh = await resolveGhPath();
		const repo = pullRequest.identity.repository;
		if (
			repo.host !== 'github.com' ||
			!/^[\w.-]+$/.test(repo.owner) ||
			!/^[\w.-]+$/.test(repo.name) ||
			!Number.isSafeInteger(pullRequest.identity.number) ||
			pullRequest.identity.number <= 0
		) {
			return { ci: unavailableCi('Invalid GitHub PR identity.'), divergence };
		}
		const api = (args: string[]) =>
			execFileNoThrow(gh, ['api', '--hostname', 'github.com', ...args], request.worktreePath, {
				timeout: 30000,
				env: getExpandedEnv(),
			});
		const base = `repos/${repo.owner}/${repo.name}`;
		const [runs, statuses, workflows] = await Promise.all([
			api(['--paginate', '--slurp', `${base}/commits/${headSha}/check-runs?per_page=100`]),
			api(['--paginate', '--slurp', `${base}/commits/${headSha}/statuses?per_page=100`]),
			api(['--paginate', '--slurp', `${base}/actions/runs?head_sha=${headSha}&per_page=100`]),
		]);
		if (runs.exitCode !== 0 || statuses.exitCode !== 0)
			return {
				ci: unavailableCi(runs.stderr || statuses.stderr || 'GitHub checks lookup failed.'),
				divergence,
			};
		const runPages: unknown = JSON.parse(runs.stdout);
		const statusPages: unknown = JSON.parse(statuses.stdout);
		if (
			!Array.isArray(runPages) ||
			!runPages.every((page) => Array.isArray(page?.check_runs)) ||
			!Array.isArray(statusPages) ||
			!statusPages.every(Array.isArray)
		)
			throw new Error('Invalid GitHub checks response.');
		// Workflow metadata is optional: checks remain usable when Actions is disabled or inaccessible.
		const workflowBySuite = new Map<number, { id: string; name: string }>();
		if (workflows.exitCode === 0) {
			const pages: unknown = JSON.parse(workflows.stdout);
			if (Array.isArray(pages))
				for (const page of pages) {
					if (Array.isArray(page?.workflow_runs))
						for (const run of page.workflow_runs) {
							if (
								Number.isSafeInteger(run.check_suite_id) &&
								Number.isSafeInteger(run.workflow_id) &&
								typeof run.name === 'string'
							)
								workflowBySuite.set(run.check_suite_id, {
									id: String(run.workflow_id),
									name: run.name,
								});
						}
				}
		}
		const checks: import('../../shared/worktreePullRequests').WorktreePullRequestCheck[] = [];
		for (const run of runPages.flatMap((page) => page.check_runs)) {
			if (
				!Number.isSafeInteger(run.id) ||
				typeof run.name !== 'string' ||
				typeof run.status !== 'string'
			)
				throw new Error('Invalid GitHub check run.');
			const state =
				run.status === 'queued' ||
				run.status === 'waiting' ||
				run.status === 'pending' ||
				run.status === 'requested'
					? 'pending'
					: run.status === 'in_progress'
						? 'running'
						: run.status === 'completed'
							? ((
									{
										success: 'passed',
										failure: 'failed',
										timed_out: 'failed',
										action_required: 'failed',
										startup_failure: 'failed',
										skipped: 'skipped',
										neutral: 'skipped',
										cancelled: 'cancelled',
									} as Record<
										string,
										import('../../shared/worktreePullRequests').WorktreePullRequestCheckState
									>
								)[run.conclusion] ?? 'unavailable')
							: 'unavailable';
			checks.push({
				kind: 'check-run',
				id: String(run.id),
				name: run.name,
				state,
				detailsUrl: typeof run.html_url === 'string' ? run.html_url : null,
				workflow: workflowBySuite.get(run.check_suite?.id) ?? null,
				updatedAt:
					typeof run.completed_at === 'string'
						? run.completed_at
						: typeof run.started_at === 'string'
							? run.started_at
							: null,
			});
		}
		const seenContexts = new Set<string>();
		for (const status of statusPages.flat()) {
			if (
				!Number.isSafeInteger(status.id) ||
				typeof status.context !== 'string' ||
				typeof status.state !== 'string'
			)
				throw new Error('Invalid GitHub commit status.');
			if (seenContexts.has(status.context)) continue;
			seenContexts.add(status.context);
			const state =
				(
					{ pending: 'pending', success: 'passed', failure: 'failed', error: 'failed' } as Record<
						string,
						import('../../shared/worktreePullRequests').WorktreePullRequestCheckState
					>
				)[status.state] ?? 'unavailable';
			checks.push({
				kind: 'status',
				id: String(status.id),
				name: status.context,
				state,
				detailsUrl: typeof status.target_url === 'string' ? status.target_url : null,
				workflow: null,
				updatedAt: typeof status.updated_at === 'string' ? status.updated_at : null,
			});
		}
		const current = await api([`${base}/pulls/${pullRequest.identity.number}`]);
		if (current.exitCode !== 0)
			return { ci: unavailableCi(current.stderr || 'PR head verification failed.'), divergence };
		const verified = pullFromApi(JSON.parse(current.stdout), repo);
		const localAfter = await execGitReadOnly(
			['rev-parse', '--verify', 'HEAD'],
			request.worktreePath
		);
		const branchAfter = await execGitReadOnly(
			['symbolic-ref', '--quiet', '--short', 'HEAD'],
			request.worktreePath
		);
		if (
			!verified ||
			verified.headSha !== headSha ||
			verified.headBranch !== head.branch ||
			!sameRepo(verified.headRepository, head.repository) ||
			localAfter.exitCode !== 0 ||
			branchAfter.exitCode !== 0 ||
			localAfter.stdout.trim() !== head.localSha ||
			branchAfter.stdout.trim() !== head.branch
		) {
			const message = 'PR head or checkout changed during checks lookup.';
			return { ci: unavailableCi(message), divergence: unavailableDivergence(message) };
		}
		return {
			ci: checks.length
				? { status: 'available', headSha, checkedAt, checks }
				: { status: 'no-ci', headSha, checkedAt },
			divergence,
		};
	} catch (error) {
		return {
			ci: unavailableCi(error instanceof Error ? error.message : String(error)),
			divergence,
		};
	}
}
