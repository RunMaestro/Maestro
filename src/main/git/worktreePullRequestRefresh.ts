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
	{ expires: number | null; promise: Promise<WorktreePullRequestSnapshot>; invalidated: boolean }
>();

/** Invalidate all identities for a checkout, including requests already in flight. */
export function invalidateWorktreePullRequest(worktreePath: string): void {
	for (const [key, entry] of entries) {
		if (JSON.parse(key)[0] === worktreePath) {
			entry.invalidated = true;
			entries.delete(key);
		}
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
	for (const [oldKey, entry] of entries)
		if (entry.expires !== null && entry.expires <= now) entries.delete(oldKey);
	let entry = entries.get(key);
	if (!entry) {
		// Pending entries must survive both TTL expiry and cache pressure.
		for (const [oldKey, cached] of entries) {
			if (entries.size < MAX_ENTRIES) break;
			if (cached.expires !== null) entries.delete(oldKey);
		}
		if (entries.size >= MAX_ENTRIES)
			return {
				discovery: {
					status: 'unavailable',
					reason: 'gh',
					message: 'Too many pull request refreshes are in flight; retry shortly.',
				},
			};
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
		entry = { expires: null, promise, invalidated: false };
		entries.set(key, entry);
	}
	let snapshot: WorktreePullRequestSnapshot;
	try {
		snapshot = await entry.promise;
	} catch (error) {
		if (entries.get(key) === entry) entries.delete(key);
		throw error;
	}
	const after = await checkout(request);
	if (entry.invalidated || before !== after) {
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
	if (snapshot.discovery.status === 'unavailable' || snapshot.ci?.status === 'unavailable') {
		if (entries.get(key) === entry) entries.delete(key);
	} else entry.expires ??= Date.now() + TTL_MS;
	return snapshot;
}
