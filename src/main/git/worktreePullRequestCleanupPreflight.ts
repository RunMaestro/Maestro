import * as fs from 'fs/promises';
import * as path from 'path';
import { canonicalJson } from '../../shared/canonicalJson';
import { normalizeWorktreePath } from '../../shared/worktreePaths';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import type {
	WorktreePullRequestCleanupBlocker,
	WorktreePullRequestCleanupPreflight,
	WorktreePullRequestCleanupPreflightRequest,
} from '../../shared/worktreePullRequestCleanup';
import { getSessionsStore } from '../stores/getters';
import { getExpandedEnv, resolveGhPath } from '../utils/cliDetection';
import { execFileNoThrow } from '../utils/execFile';
import { foldPathCase, isPathWithin } from '../utils/real-path-containment';
import { execGitReadOnly } from '../utils/remote-git';
import { discoverWorktreePullRequest } from './worktreePullRequests';
type BlockerCode = WorktreePullRequestCleanupBlocker['code'];
class CleanupBlocked extends Error {
	readonly code: BlockerCode;
	constructor(code: BlockerCode, message: string) {
		super(message);
		this.code = code;
	}
}
function refuse(code: BlockerCode, message: string): never {
	throw new CleanupBlocked(code, message);
}
const pathKey = (value: string) => foldPathCase(normalizeWorktreePath(value));
async function canonicalPath(value: string): Promise<string> {
	if (typeof value !== 'string' || !path.isAbsolute(value))
		refuse('path', 'An absolute registered path is required.');
	const real = await fs.realpath(value);
	if (pathKey(value) !== pathKey(real)) refuse('path', 'Symlink and path aliases are unsupported.');
	return real;
}
async function git(args: string[], cwd: string): Promise<string> {
	const result = await execGitReadOnly(args, cwd);
	if (result.exitCode !== 0) refuse('unknown', 'Git could not establish cleanup safety.');
	return result.stdout;
}
function registration(request: WorktreePullRequestCleanupPreflightRequest) {
	// Include dormant agents. A hidden registration still owns user data.
	const sessions = getSessionsStore().get('sessions');
	if (!Array.isArray(sessions) || sessions.some((s) => !s || typeof s.id !== 'string'))
		refuse('registration', 'Agent registration is unavailable or malformed.');
	const children = sessions.filter((s) => s.id === request.sessionId);
	if (children.length !== 1) refuse('registration', 'The owning agent is missing or ambiguous.');
	const child = children[0];
	const parents = sessions.filter((s) => s.id === child.parentSessionId);
	if (parents.length !== 1 || parents[0].parentSessionId || parents[0].id === child.id)
		refuse('registration', 'A registered main-checkout parent is required.');
	const parent = parents[0];
	if ([child, parent].some((s) => s.sshRemoteId || s.sessionSshRemoteConfig))
		refuse('ssh-unsupported', 'Cleanup preflight requires unambiguous local registration.');
	if (child.worktreeBranch !== request.target.headBranch)
		refuse('identity-changed', 'The registered worktree branch changed.');
	return { child, parent, fingerprint: canonicalJson([child, parent]) };
}
async function inspectCheckout(request: WorktreePullRequestCleanupPreflightRequest) {
	const { child, parent, fingerprint } = registration(request);
	const worktree = await canonicalPath(child.cwd);
	const main = await canonicalPath(parent.cwd);
	if (pathKey(await canonicalPath(request.worktreePath)) !== pathKey(worktree))
		refuse('registration', 'The requested path does not belong to this agent.');
	if (pathKey(worktree) === pathKey(main))
		refuse('main-checkout', 'The main checkout is protected.');
	if (
		pathKey(await canonicalPath(child.projectRoot)) !== pathKey(worktree) ||
		pathKey(await canonicalPath(parent.projectRoot)) !== pathKey(main)
	)
		refuse('registration', 'Registered project roots do not identify the checkouts.');
	const common = await canonicalPath(
		path.resolve(main, (await git(['rev-parse', '--git-common-dir'], main)).trim())
	);
	const worktreeCommon = await canonicalPath(
		path.resolve(worktree, (await git(['rev-parse', '--git-common-dir'], worktree)).trim())
	);
	const mainGit = await canonicalPath(
		path.resolve(main, (await git(['rev-parse', '--git-dir'], main)).trim())
	);
	const worktreeGit = await canonicalPath(
		path.resolve(worktree, (await git(['rev-parse', '--git-dir'], worktree)).trim())
	);
	if (pathKey(worktreeGit) === pathKey(common))
		refuse('main-checkout', 'A linked checkout is required.');
	if (
		pathKey(common) !== pathKey(worktreeCommon) ||
		pathKey(mainGit) !== pathKey(common) ||
		!isPathWithin(foldPathCase(worktreeGit), foldPathCase(path.join(common, 'worktrees')))
	)
		refuse('repository', 'The checkout does not belong to the registered main repository.');
	const marker = path.join(worktree, '.git');
	if (
		!(await fs.lstat(marker)).isFile() ||
		pathKey(
			await canonicalPath((await fs.readFile(path.join(worktreeGit, 'gitdir'), 'utf8')).trim())
		) !== pathKey(marker)
	)
		refuse('repository', 'Git metadata does not point back to this linked checkout.');
	for (const root of [main, worktree]) {
		if (pathKey((await git(['rev-parse', '--show-toplevel'], root)).trim()) !== pathKey(root))
			refuse('repository', 'Registration must identify the Git checkout root.');
	}
	const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree)).trim();
	const head = (await git(['rev-parse', '--verify', 'HEAD'], worktree)).trim();
	if (branch !== request.target.headBranch)
		refuse('identity-changed', 'The checkout branch changed.');
	if (head !== request.target.headSha)
		refuse('head-changed', 'Local HEAD must equal the reviewed PR head.');
	// The existing line-based branch parser cannot safely frame arbitrary path names.
	const registry = await git(['worktree', 'list', '--porcelain', '-z'], main);
	if (!registry.endsWith('\0\0')) refuse('unknown', 'Incomplete Git worktree registry.');
	const records = registry
		.slice(0, -2)
		.split('\0\0')
		.map((record) => {
			const fields = record.split('\0');
			if (fields[0]?.startsWith('worktree ')) fields[0] = `worktree ${pathKey(fields[0].slice(9))}`;
			return fields;
		});
	const matches = records.filter(
		(fields) =>
			fields.includes(`worktree ${pathKey(worktree)}`) ||
			fields.includes(`branch refs/heads/${branch}`)
	);
	if (
		records[0]?.[0] !== `worktree ${pathKey(main)}` ||
		matches.length !== 1 ||
		canonicalJson([...matches[0]].sort()) !==
			canonicalJson(
				[`worktree ${pathKey(worktree)}`, `HEAD ${head}`, `branch refs/heads/${branch}`].sort()
			)
	)
		refuse('repository', 'Git registration is missing, ambiguous, locked, prunable or changed.');
	const index = await git(['ls-files', '--stage', '-v', '-z'], worktree);
	if (index && !index.endsWith('\0')) refuse('unknown', 'Incomplete Git index inventory.');
	const tracked = new Set<string>();
	for (const entry of index.split('\0').filter(Boolean)) {
		const match = /^H (?:100644|100755|120000) [a-f\d]{40,64} 0\t(.+)$/s.exec(entry);
		if (!match) refuse('unknown', 'Submodules, sparse or hidden index entries are unsupported.');
		if (!match[1] || normalizeRootRelativePath(match[1]) !== match[1])
			refuse('unknown', 'Git index contains an unsafe relative path.');
		tracked.add(match[1]);
	}
	const status = await git(
		[
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.untrackedCache=false',
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--ignored=traditional',
			'--ignore-submodules=none',
		],
		worktree
	);
	if (status) {
		const code = status.startsWith('?? ')
			? 'untracked'
			: status.startsWith('!! ')
				? 'ignored-data'
				: 'dirty';
		refuse(code, 'The checkout contains changed, untracked or unsecured ignored data.');
	}
	// Git omits empty directories and special files. Inventory those without following links.
	const directories = new Set<string>();
	for (const file of tracked) {
		let dir = path.posix.dirname(file);
		while (dir !== '.') {
			directories.add(dir);
			dir = path.posix.dirname(dir);
		}
	}
	const pending = [''];
	while (pending.length) {
		const relative = pending.pop()!;
		for (const entry of await fs.readdir(path.join(worktree, relative), { withFileTypes: true })) {
			if (!relative && entry.name === '.git') continue;
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory() && directories.has(name)) pending.push(name);
			else if (!(entry.isFile() || entry.isSymbolicLink()) || !tracked.has(name))
				refuse('unknown', 'Filesystem data outside the tracked inventory is unsecured.');
		}
	}
	const origin = await git(['remote', 'get-url', 'origin'], worktree);
	return { worktree, main, common, branch, head, fingerprint, origin };
}
/** Read-only and advisory. This stage can never authorize checkout removal. */
export async function preflightWorktreePullRequestCleanup(
	request: WorktreePullRequestCleanupPreflightRequest
): Promise<WorktreePullRequestCleanupPreflight> {
	try {
		if (request?.sshRemoteId)
			refuse('ssh-unsupported', 'Cleanup is unsupported for SSH worktrees.');
		const target = request?.target;
		if (
			!request?.sessionId ||
			!target?.identity ||
			!/^[a-f\d]{40}$/i.test(target.headSha) ||
			!target.headBranch ||
			!target.baseBranch ||
			!Number.isSafeInteger(target.identity.number) ||
			target.identity.number <= 0 ||
			![target.identity.repository, target.headRepository].every(
				(repo) =>
					repo?.host === 'github.com' &&
					typeof repo.owner === 'string' &&
					typeof repo.name === 'string' &&
					/^[\w-][\w.-]*$/.test(repo.owner) &&
					/^[\w-][\w.-]*$/.test(repo.name)
			)
		)
			refuse('unknown', 'Invalid cleanup target.');
		const before = await inspectCheckout(request);
		const found = await discoverWorktreePullRequest({
			worktreePath: before.worktree,
			knownPullRequest: target.identity,
		});
		if (found.status === 'unavailable') refuse('unknown', 'Fresh GitHub discovery is unavailable.');
		if (found.status !== 'found')
			refuse('identity-changed', 'The checkout no longer identifies this PR.');
		const pr = found.pullRequest;
		if (
			canonicalJson({
				identity: pr.identity,
				headRepository: pr.headRepository,
				headBranch: pr.headBranch,
				headSha: pr.headSha,
				baseBranch: pr.baseBranch,
			}) !== canonicalJson(target) ||
			canonicalJson(found.head.repository) !== canonicalJson(target.headRepository) ||
			found.head.branch !== before.branch ||
			found.head.localSha !== before.head
		)
			refuse(
				'identity-changed',
				'Fresh discovery does not match the exact reviewed PR and checkout.'
			);
		const repo = target.identity.repository;
		const result = await execFileNoThrow(
			await resolveGhPath(),
			[
				'api',
				'--hostname',
				'github.com',
				`repos/${repo.owner}/${repo.name}/pulls/${target.identity.number}`,
			],
			before.worktree,
			{ timeout: 30000, env: getExpandedEnv() }
		);
		if (result.exitCode !== 0)
			refuse('unknown', 'Independent GitHub merge confirmation is unavailable.');
		const remote = JSON.parse(result.stdout);
		if (
			remote?.number !== target.identity.number ||
			remote.head?.repo?.owner?.login !== target.headRepository.owner ||
			remote.head?.repo?.name !== target.headRepository.name ||
			remote.base?.repo?.owner?.login !== repo.owner ||
			remote.base?.repo?.name !== repo.name ||
			remote.head?.ref !== target.headBranch ||
			remote.base?.ref !== target.baseBranch
		)
			refuse('identity-changed', 'GitHub returned a different repository, PR or branch.');
		if (remote.head?.sha !== target.headSha) refuse('head-changed', 'GitHub PR head changed.');
		if (remote.merged !== true || remote.state !== 'closed' || pr.state !== 'MERGED')
			refuse('unmerged', 'GitHub has not independently confirmed this PR merge.');
		if (
			typeof remote.merged_at !== 'string' ||
			!Number.isFinite(Date.parse(remote.merged_at)) ||
			Date.parse(remote.merged_at) > Date.now() ||
			typeof remote.merge_commit_sha !== 'string' ||
			!/^[a-f\d]{40}$/i.test(remote.merge_commit_sha)
		)
			refuse('unknown', 'GitHub merge time or commit evidence is incomplete.');
		// A squash/rebase result need not have the same SHA as the PR head.
		if (canonicalJson(await inspectCheckout(request)) !== canonicalJson(before))
			refuse('identity-changed', 'Registration or checkout changed during preflight.');
		return {
			status: 'blocked',
			blockers: [
				{ code: 'active-consumer', message: 'Fresh native consumer inventory is not implemented.' },
				{ code: 'mutation-busy', message: 'Shared mutation exclusion is not implemented.' },
			],
		};
	} catch (error) {
		if (error instanceof CleanupBlocked)
			return { status: 'blocked', blockers: [{ code: error.code, message: error.message }] };
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code)
			return {
				status: 'blocked',
				blockers: [{ code: 'unknown', message: 'Filesystem or GitHub evidence is unavailable.' }],
			};
		throw error;
	}
}
