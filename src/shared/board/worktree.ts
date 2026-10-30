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

/** Directory (next to the project root) that holds every worktree checkout. */
export const BOARD_WORKTREE_DIRNAME = 'worktrees';

/**
 * Encode an ID as one git-safe path segment without losing identity. Safe ASCII
 * IDs (including generated UUIDs) keep their existing names. Escape underscores
 * as well as unsafe UTF-16 code units so literal escape-looking IDs cannot
 * collide with encoded ones, unlike lossy branch sanitization.
 */
function idSegment(id: string): string {
	return (
		id.replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16)}_`) || '_empty_'
	);
}

/**
 * Branch name for a card's isolated worktree: `board/<board>/<card>`.
 *
 * Both ids are encoded so a hand-written board id (`board.yaml` is
 * user-editable) can never produce an invalid ref, and kept whole so distinct
 * ids always yield distinct branches (and therefore distinct checkouts).
 */
export function boardCardBranchName(boardId: string, cardId: string): string {
	return `board/${idSegment(boardId)}/${idSegment(cardId)}`;
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
