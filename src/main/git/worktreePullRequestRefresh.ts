import type {
	WorktreePullRequestDiscoveryRequest,
	WorktreePullRequestSnapshot,
} from '../../shared/worktreePullRequests';
import { execGitReadOnly } from '../utils/remote-git';
import { discoverWorktreePullRequest, readWorktreePullRequestCi } from './worktreePullRequests';

// No timer is retained: callers poll on their own lifecycle. Bound both age and memory.
const TTL_MS = 30_000;
const MAX_ENTRIES = 100;
const entries = new Map<
	string,
	{ expires: number; promise: Promise<WorktreePullRequestSnapshot> }
>();

/** Invalidate all identities for a checkout, including requests already in flight. */
export function invalidateWorktreePullRequest(worktreePath: string): void {
	for (const key of entries.keys()) {
		if (JSON.parse(key)[0] === worktreePath) entries.delete(key);
	}
}

async function checkout(request: WorktreePullRequestDiscoveryRequest): Promise<string | null> {
	const [sha, branch, remote] = await Promise.all([
		execGitReadOnly(['rev-parse', '--verify', 'HEAD'], request.worktreePath),
		execGitReadOnly(['symbolic-ref', '--quiet', '--short', 'HEAD'], request.worktreePath),
		execGitReadOnly(['remote', 'get-url', 'origin'], request.worktreePath),
	]);
	if (
		sha.exitCode !== 0 ||
		(branch.exitCode !== 0 && branch.exitCode !== 1) ||
		remote.exitCode !== 0
	)
		return null;
	return JSON.stringify([
		sha.stdout.trim(),
		branch.exitCode === 1 ? null : branch.stdout.trim(),
		remote.stdout.trim(),
	]);
}

/** One bounded snapshot per checkout, local identity and retained PR. */
export async function refreshWorktreePullRequest(
	request: WorktreePullRequestDiscoveryRequest
): Promise<WorktreePullRequestSnapshot> {
	if (request.sshRemoteId) return { discovery: await discoverWorktreePullRequest(request) };
	const before = await checkout(request);
	if (before === null)
		return {
			discovery: {
				status: 'unavailable',
				reason: 'git',
				message: 'Cannot read checkout identity.',
			},
		};
	const key = JSON.stringify([request.worktreePath, before, request.knownPullRequest ?? null]);
	const now = Date.now();
	for (const [oldKey, entry] of entries) if (entry.expires <= now) entries.delete(oldKey);
	let entry = entries.get(key);
	if (!entry) {
		const promise = (async (): Promise<WorktreePullRequestSnapshot> => {
			const discovery = await discoverWorktreePullRequest(request);
			if (discovery.status !== 'found') return { discovery };
			const details = await readWorktreePullRequestCi(request, discovery);
			if (
				details.ci.status === 'unavailable' &&
				details.ci.message === 'PR head or checkout changed during checks lookup.'
			) {
				return { discovery: { status: 'unavailable', reason: 'git', message: details.ci.message } };
			}
			return { discovery, ...details };
		})();
		entry = { expires: now + TTL_MS, promise };
		entries.set(key, entry);
		while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
	}
	const snapshot = await entry.promise;
	const after = await checkout(request);
	if (entries.get(key) !== entry || before !== after) {
		if (entries.get(key) === entry) entries.delete(key);
		return {
			discovery: {
				status: 'unavailable',
				reason: 'git',
				message: 'Checkout changed or request was invalidated during refresh.',
			},
		};
	}
	// Errors should be retryable immediately, not cached as authoritative results.
	if (snapshot.discovery.status === 'unavailable' || snapshot.ci?.status === 'unavailable')
		entries.delete(key);
	return snapshot;
}
