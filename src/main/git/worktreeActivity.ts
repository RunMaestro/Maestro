import fs from 'fs/promises';
import path from 'path';
import type { WorktreePullRequestCleanupBlocker } from '../../shared/worktreePullRequestCleanup';
import { foldPathCase, isPathWithin } from '../utils/real-path-containment';

const activities = new Set<{ roots: string[] | null }>();
const reservations = new Set<string>();

async function canonicalRoots(paths: readonly string[]): Promise<string[]> {
	if (!paths.length || paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p)))
		throw new Error('Absolute activity paths are required.');
	return Promise.all(
		paths.map(async (p) => {
			const real = await fs.realpath(p);
			if (!path.isAbsolute(real)) throw new Error('Canonical activity path is unavailable.');
			return foldPathCase(path.normalize(real));
		})
	);
}

function overlaps(a: string, b: string): boolean {
	return isPathWithin(a, b) || isPathWithin(b, a);
}

/**
 * Admit a cooperating local participant before its first async setup or side
 * effect. Pending/unresolvable paths block every reservation. Unknown paths
 * remain tracked until release; they are never treated as unrelated activity.
 * Callers must await admission and release only after their work has settled.
 */
export async function beginWorktreeActivity(paths: readonly string[]): Promise<() => void> {
	const activity: { roots: string[] | null } = { roots: null };
	// Register synchronously, before realpath can yield to a cleanup request.
	activities.add(activity);
	try {
		try {
			activity.roots = await canonicalRoots(paths);
		} catch {
			// Preserve unknown coverage for normal operations with an unavailable cwd.
		}
		if (
			[...reservations].some(
				(root) => !activity.roots || activity.roots.some((p) => overlaps(p, root))
			)
		)
			throw new Error('Worktree cleanup has reserved this path. Retry after it finishes.');
		return () => {
			activities.delete(activity);
		};
	} catch (error) {
		activities.delete(activity);
		throw error;
	}
}

/**
 * Git can change common metadata from a sibling checkout, via -C/--git-dir,
 * environment overrides or hooks. Until repository domains are verified, track
 * participating local Git globally, including its setup. Empty paths deliberately
 * retain unknown roots, blocking every reservation and admission under any hold.
 */
export function beginWorktreeGitActivity(): Promise<() => void> {
	return beginWorktreeActivity([]);
}

export type WorktreeCleanupReservation =
	| { status: 'blocked'; blockers: WorktreePullRequestCleanupBlocker[] }
	| {
			status: 'reserved-partially';
			/** Always nonempty: this local reservation cannot authorize removal. */
			blockers: WorktreePullRequestCleanupBlocker[];
			release: () => void;
	  };

/**
 * Reserve a canonical target against cooperating main-process participants.
 * This is NOT full mutation exclusion, a preflight result or a removal token.
 * No callback or option can bypass missing native/client/external coverage.
 * It neither establishes Git ownership nor inspects OS users/open handles.
 */
export async function reserveWorktreeCleanup(
	worktreePath: string
): Promise<WorktreeCleanupReservation> {
	let root: string;
	try {
		[root] = await canonicalRoots([worktreePath]);
		if (foldPathCase(path.normalize(worktreePath)) !== root)
			throw new Error('Cleanup target is an alias.');
	} catch {
		return {
			status: 'blocked',
			blockers: [{ code: 'path', message: 'A canonical local cleanup target is required.' }],
		};
	}
	// No await between observing participants and installing the reservation.
	if (
		[...reservations].some((p) => overlaps(p, root)) ||
		[...activities].some((a) => !a.roots || a.roots.some((p) => overlaps(p, root)))
	)
		return {
			status: 'blocked',
			blockers: [{ code: 'mutation-busy', message: 'Overlapping or unknown work is in flight.' }],
		};
	reservations.add(root);
	let released = false;
	return {
		status: 'reserved-partially',
		blockers: [
			{
				code: 'unknown',
				message: 'Complete native Git, process, client and registration exclusion is unavailable.',
			},
			{
				code: 'unknown',
				message: 'OS users, external processes, open handles and writers are not excluded.',
			},
		],
		release: () => {
			if (released) return;
			released = true;
			reservations.delete(root);
		},
	};
}
