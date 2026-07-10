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

/** Normalize a path for containment comparison: forward slashes, no trailing sep. */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * True when `childDir` is `parentDir` itself or nested inside it. Separator-aware
 * (handles both `/` and `\`) and boundary-safe: `/repo` does NOT contain
 * `/repo-two`. Case-sensitive; agent dirs are expected to match the project's
 * casing. Empty / missing inputs are never contained.
 */
export function isPathWithin(parentDir: string, childDir: string | undefined | null): boolean {
	if (!parentDir || !childDir) return false;
	const parent = normalizePath(parentDir);
	const child = normalizePath(childDir);
	if (!parent) return false;
	return child === parent || child.startsWith(`${parent}/`);
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
