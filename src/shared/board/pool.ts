import * as path from 'node:path';

/**
 * Board worker-pool selection (Board Phase 6) - pure, framework-free.
 *
 * A card that names only a role (no pinned agent) is dispatched to a FREE
 * "board worker": a Left Bar agent that (1) has opted in via `boardWorker: true`
 * and (2) lives in the board's project directory or a sub-folder of it. This
 * module holds the containment + filtering rules so the desktop engine wiring
 * (`index.ts`) and the headless CLI (`board tick`) share ONE definition of the
 * pool and never drift.
 */

/** The minimal shape of a Left Bar agent this module needs to place it in a pool. */
export interface PoolCandidate {
	/** Stable agent (session) id. */
	id: string;
	/** The agent's working directory (projectRoot / cwd / fullPath), if known. */
	dir?: string | null;
	/** Opt-in flag: only `true` makes the agent an eligible board worker. */
	boardWorker?: boolean;
}

/**
 * Absolute local containment for migration grants. Node's path implementation
 * collapses dot segments and preserves drive/UNC/POSIX roots. Remote migration
 * uses its separate SSH identity rules, never this local pool.
 */
export function isPathWithin(parentDir: string, childDir: string | undefined | null): boolean {
	if (!parentDir || !childDir || parentDir.includes('\0') || childDir.includes('\0')) return false;
	const paths = /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(parentDir) ? path.win32 : path.posix;
	if (!paths.isAbsolute(parentDir) || !paths.isAbsolute(childDir)) return false;
	// A Windows rooted path without a drive/share depends on process cwd.
	if (paths === path.win32 && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(childDir)) return false;
	const relative = paths.relative(paths.normalize(parentDir), paths.normalize(childDir));
	return (
		relative === '' ||
		(relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
	);
}

/**
 * The ids of agents eligible to be board workers for `projectRoot`: opted in
 * (`boardWorker === true`) AND living in `projectRoot` or a sub-folder. Input
 * order is preserved so the dispatcher's "first free worker" pick is stable.
 */
export function selectPoolAgentIds(
	projectRoot: string,
	agents: readonly PoolCandidate[]
): string[] {
	return agents
		.filter((a) => a.boardWorker === true && isPathWithin(projectRoot, a.dir ?? undefined))
		.map((a) => a.id)
		.filter((id): id is string => typeof id === 'string' && id.length > 0);
}
