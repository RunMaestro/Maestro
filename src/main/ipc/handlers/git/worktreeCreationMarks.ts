/**
 * Main-process registry of worktree paths Maestro itself just created.
 *
 * The renderer already keeps a "recently created" set so its own chokidar
 * listener doesn't build a second child session for a worktree it created a
 * moment ago. That set is MODULE-LOCAL to one renderer, and
 * `worktree:discovered` is broadcast by `safeSend` to every renderer - each
 * Electron window and every connected web-desktop bridge client. So the guard
 * only ever suppressed the duplicate in the renderer that did the creating;
 * every other renderer saw an unmarked event, found no child of its own, and
 * minted one with a fresh id. Since persistence ships incremental
 * `sessions:setMany` diffs, all of those rival children merge into the store -
 * same parent, same worktree path, same provider, different ids (issue #1506).
 *
 * Marking here instead means the discovery event is never emitted for a
 * Maestro-created worktree at all, so no renderer can race to claim it. The
 * creating renderer builds the child directly (it already does), and any other
 * agent that should also adopt the worktree picks it up on the next
 * startup/visibility rescan - exactly what the renderer-local mark already
 * produced for the creating renderer.
 */

import { normalizeWorktreePath } from '../../../../shared/worktreePaths';

/** Normalized path -> expiry timestamp (ms since epoch). */
const marks = new Map<string, number>();

/**
 * How long a mark survives. Sized to comfortably outlast a slow
 * `git worktree add` plus the setup script that follows it (large repo, cold
 * disk, SSH remote), matching WORKTREE_SETUP_MARK_TTL_MS on the renderer side.
 */
export const WORKTREE_CREATION_MARK_TTL_MS = 60000;

/** Drop expired entries so the map can't grow without bound. */
function sweep(now: number): void {
	for (const [key, expiry] of marks) {
		if (expiry <= now) marks.delete(key);
	}
}

/**
 * Record that Maestro is creating (or has just created) a worktree at `p`, so
 * the directory watcher suppresses the discovery event for it.
 */
export function markWorktreeCreatedByMaestro(
	p: string,
	ttlMs: number = WORKTREE_CREATION_MARK_TTL_MS
): void {
	if (!p) return;
	const now = Date.now();
	sweep(now);
	marks.set(normalizeWorktreePath(p), now + ttlMs);
}

/** Release a creation mark when setup exits without producing a usable worktree. */
export function clearWorktreeCreatedByMaestro(p: string): void {
	if (!p) return;
	marks.delete(normalizeWorktreePath(p));
}

/** Whether `p` was marked by {@link markWorktreeCreatedByMaestro} and is still live. */
export function isWorktreeCreatedByMaestro(p: string): boolean {
	if (!p) return false;
	const key = normalizeWorktreePath(p);
	const expiry = marks.get(key);
	if (expiry === undefined) return false;
	if (expiry <= Date.now()) {
		marks.delete(key);
		return false;
	}
	return true;
}

/** Test-only: clear every mark. */
export function clearWorktreeCreationMarks(): void {
	marks.clear();
}
