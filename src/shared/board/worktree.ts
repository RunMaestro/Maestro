/**
 * Board worktree naming (Board Phase 4 - per-card isolation).
 *
 * Pure and framework-free: the renderer's card editor, the CLI's `--worktree`
 * flag, and the main-process provisioning helper all derive the SAME branch and
 * path from these functions, so a card's isolated checkout is predictable
 * wherever it was created.
 *
 * Naming scheme:
 *   branch  `board/<boardId-first-8>/<cardId-first-8>`
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

/** How many id characters go into a branch segment. Enough to stay unique per board. */
const ID_SEGMENT_LENGTH = 8;

/** Directory (next to the project root) that holds every worktree checkout. */
export const BOARD_WORKTREE_DIRNAME = 'worktrees';

/**
 * Branch name for a card's isolated worktree: `board/<board>/<card>`.
 *
 * Both ids are truncated and sanitized so a hand-written board id (`board.yaml`
 * is user-editable) can never produce an invalid ref.
 */
export function boardCardBranchName(boardId: string, cardId: string): string {
	const board = sanitizeGitBranchName(boardId.slice(0, ID_SEGMENT_LENGTH)) || 'board';
	const card = sanitizeGitBranchName(cardId.slice(0, ID_SEGMENT_LENGTH)) || 'card';
	return `board/${board}/${card}`;
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
