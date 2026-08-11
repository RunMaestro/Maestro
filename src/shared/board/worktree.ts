/**
 * Board worktree naming (Board Phase 4 - per-card isolation).
 *
 * Pure and framework-free: the renderer's card editor, the CLI's `--worktree`
 * flag, and the main-process provisioning helper all derive the SAME branch and
 * path from these functions, so a card's isolated checkout is predictable
 * wherever it was created.
 *
 * Naming scheme:
 *   branch  `board/<boardId>/<cardId>`
 *   path    `<sibling-of-projectRoot>/worktrees/<branch>`
 *
 * The path is a SIBLING of the project root on purpose: git (and the agents
 * themselves) walk upward looking for `.git`, so a worktree nested inside the
 * main repo resolves to the parent repo instead. `setupWorktreeLocal` refuses
 * such a path outright - this mirrors the Auto Run convention
 * (`<parent>/worktrees/<branch>`) so both features share one layout on disk.
 */

import { getParentDir, joinPath } from '../formatters';
import { sanitizeGitBranchName } from '../gitUtils';

/** Directory (next to the project root) that holds every worktree checkout. */
export const BOARD_WORKTREE_DIRNAME = 'worktrees';

/**
 * One id as one branch/path segment: the FULL id, git-sanitized, with any
 * surviving `/` flattened so the id can never add hierarchy of its own.
 *
 * The full id matters: `board.yaml` is user-editable, so ids are not always
 * UUIDs - two hand-written ids like `feature-auth` / `feature-api` share a
 * first-8 prefix, and a truncated scheme would silently hand both cards the
 * same checkout, defeating isolation.
 */
function idSegment(id: string, fallback: string): string {
	return sanitizeGitBranchName(id).replace(/\//g, '-') || fallback;
}

/**
 * Branch name for a card's isolated worktree: `board/<board>/<card>`.
 *
 * Both ids are sanitized so a hand-written board id (`board.yaml` is
 * user-editable) can never produce an invalid ref, and kept whole so distinct
 * ids always yield distinct branches (and therefore distinct checkouts).
 */
export function boardCardBranchName(boardId: string, cardId: string): string {
	return `board/${idSegment(boardId, 'board')}/${idSegment(cardId, 'card')}`;
}

/**
 * Filesystem path for a board worktree branch: a `worktrees/` directory beside
 * the project root, mirroring the branch name underneath it.
 */
export function boardWorktreePath(projectRoot: string, branch: string): string {
	return joinPath(getParentDir(projectRoot), BOARD_WORKTREE_DIRNAME, branch);
}

/**
 * Build the {@link WorktreeRef}-shaped value a card stores when the user opts
 * into isolation. Kept as a plain structural return so this module does not
 * import the board types (and the types file does not import this one).
 */
export function buildCardWorktreeRef(
	projectRoot: string,
	boardId: string,
	cardId: string
): { path: string; branch: string } {
	const branch = boardCardBranchName(boardId, cardId);
	return { path: boardWorktreePath(projectRoot, branch), branch };
}
