/** Trusted local registration and Git ownership for the bounded retirement path. */
import * as fs from 'fs';
import * as path from 'path';
import type { StoredSession, StoredRetiredWorktree } from '../stores/types';
import { foldPathCase, isPathWithin } from '../utils/real-path-containment';
import { execGitReadOnly } from '../utils/remote-git';
import type { ManagedCheckout } from './worktreeRetirement';

/** Supplied by persistence, using the SAME lane as sessions:setMany/setAll. */
export interface RetirementRegistrationSource {
	read(): readonly StoredSession[];
	generation(): number;
	enqueue<T>(operation: () => Promise<T>): Promise<T>;
	/** Called only in the owned preparation lane; preserve the trusted identities. */
	persistPrepared?(sessions: StoredSession[], isCurrent: () => boolean): Promise<void>;
	/** Internal token-owned caller already holds the sessions lane and removal fence. */
	reconcileRetired?(record: StoredRetiredWorktree, parent: StoredSession): Promise<void>;
}

export interface CheckoutOwnership {
	sessionId: string;
	parentSessionId: string;
	parentPath: string;
	commonDir: string;
	gitDir: string;
	branch: string;
}

export function retirementRegistrationPair(sessions: readonly StoredSession[], sessionId: string) {
	const children = sessions.filter((session) => session.id === sessionId);
	const child = children[0];
	const parents = sessions.filter((session) => session.id === child?.parentSessionId);
	const parent = parents[0];
	if (
		children.length !== 1 ||
		parents.length !== 1 ||
		!child ||
		!parent ||
		child.id === parent.id ||
		parent.parentSessionId ||
		typeof child.worktreeBranch !== 'string' ||
		!child.worktreeBranch
	)
		throw new Error('A unique managed child and surviving primary parent are required');
	for (const session of [child, parent]) {
		if (session.sshRemoteId || session.sessionSshRemoteConfig?.enabled)
			throw new Error('SSH retirement is unsupported');
		if (!path.isAbsolute(session.cwd)) throw new Error('Absolute local registration required');
	}
	return { child, parent };
}

/** The caller holds admission and the persistence lane throughout these reads. */
export async function verifyRetirementOwnership(
	sessions: readonly StoredSession[],
	sessionId: string,
	generation: number
): Promise<ManagedCheckout & { ownership: Readonly<CheckoutOwnership> }> {
	const { child, parent } = retirementRegistrationPair(sessions, sessionId);
	const physical = (value: string) => fs.realpathSync.native(value);
	const same = (a: string, b: string) => foldPathCase(a) === foldPathCase(b);
	const root = physical(child.cwd);
	const parentRoot = physical(parent.cwd);
	if (
		isPathWithin(foldPathCase(root), foldPathCase(parentRoot)) ||
		isPathWithin(foldPathCase(parentRoot), foldPathCase(root))
	)
		throw new Error('Child and parent checkouts must not overlap');
	if (!same(physical(child.projectRoot), root))
		throw new Error('Child project root differs from its checkout');
	for (const session of sessions) {
		if (session.id === child.id || session.sshRemoteId || session.sessionSshRemoteConfig?.enabled)
			continue;
		// Unresolvable registrations cannot establish exclusive ownership.
		const other = physical(session.cwd);
		if (
			isPathWithin(foldPathCase(other), foldPathCase(root)) ||
			isPathWithin(foldPathCase(root), foldPathCase(other))
		)
			throw new Error('Another registration overlaps the child checkout');
	}
	const git = async (cwd: string, args: string[]) => {
		const result = await execGitReadOnly(args, cwd);
		if (result.exitCode !== 0) throw new Error('Git ownership verification failed');
		return result.stdout;
	};
	const probe = async (cwd: string) => {
		const top = physical((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
		const gitDir = physical((await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim());
		const commonDir = physical(
			path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim())
		);
		return { top, gitDir, commonDir };
	};
	const childGit = await probe(root);
	const parentGit = await probe(parentRoot);
	if (
		!same(root, childGit.top) ||
		!same(parentRoot, parentGit.top) ||
		!same(childGit.commonDir, parentGit.commonDir) ||
		!same(parentGit.gitDir, parentGit.commonDir) ||
		same(childGit.gitDir, childGit.commonDir) ||
		!isPathWithin(
			foldPathCase(childGit.gitDir),
			foldPathCase(path.join(childGit.commonDir, 'worktrees'))
		)
	)
		throw new Error('Checkout is not a linked worktree of its registered primary parent');
	const registry = await git(parentRoot, ['worktree', 'list', '--porcelain', '-z']);
	const entries = registry
		.split('\0\0')
		.filter(Boolean)
		.map((record) => record.split('\0'));
	if (!entries[0]?.[0]?.startsWith('worktree ')) throw new Error('Missing primary Git worktree');
	if (!same(physical(entries[0][0].slice(9)), parentRoot))
		throw new Error('Registered parent is not the primary Git checkout');
	const matches = entries.filter((entry) => {
		const field = entry.find((line) => line.startsWith('worktree '));
		return field && same(physical(field.slice(9)), root);
	});
	const entry = matches[0];
	if (
		matches.length !== 1 ||
		!entry.includes(`branch refs/heads/${child.worktreeBranch}`) ||
		entry.some((field) => /^(locked|prunable|bare|detached)( |$)/.test(field))
	)
		throw new Error('Git worktree registration changed, locked, detached or prunable');
	const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
	if (!/^[a-f\d]{40,64}$/i.test(head) || !entry.includes(`HEAD ${head}`))
		throw new Error('Local HEAD changed during Git ownership verification');
	// Detect aliases retargeted while the async Git reads ran.
	if (!same(physical(child.cwd), root) || !same(physical(parent.cwd), parentRoot))
		throw new Error('Registration path changed during Git ownership verification');
	return {
		path: foldPathCase(root),
		head,
		generation,
		ownership: Object.freeze({
			sessionId: child.id,
			parentSessionId: parent.id,
			parentPath: foldPathCase(parentRoot),
			commonDir: childGit.commonDir,
			gitDir: childGit.gitDir,
			branch: child.worktreeBranch,
		}),
	};
}
