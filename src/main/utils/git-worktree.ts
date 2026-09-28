/**
 * Local git worktree provisioning.
 *
 * This is the ONE local implementation of "create or reuse a worktree". It was
 * lifted verbatim out of the `git:worktreeSetup` IPC handler so it can be called
 * from places that are not an IPC handler (the Board's per-card isolation) - the
 * handler now delegates to it, so there is no second copy of the `git worktree
 * add` logic to keep in sync. The SSH-remote variant lives in
 * `remote-git.ts` (`worktreeSetupRemote`) and is dispatched by the handler.
 *
 * Deliberately Electron-free (only `fs`, `path`, `child_process` via
 * {@link execFileNoThrow}) so the CLI can import it too.
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeWorktreePath } from '../../shared/worktreePaths';
import {
	clearWorktreeCreatedByMaestro,
	markWorktreeCreatedByMaestro,
} from '../ipc/handlers/git/worktreeCreationMarks';
import { execFileNoThrow } from './execFile';
import { isWorktreeAlreadyUsedError, parseWorktreePathForBranch } from '../../shared/gitUtils';

/** Result of {@link setupWorktreeLocal}. Mirrors the `git:worktreeSetup` reply shape. */
export interface WorktreeSetupResult {
	success: boolean;
	/** Failure reason when `success` is false. */
	error?: string;
	/** True when this call ran `git worktree add`. */
	created?: boolean;
	/** True when the branch was already attached to another worktree on disk. */
	alreadyExisted?: boolean;
	/** Path of that pre-existing worktree, when `alreadyExisted`. */
	existingPath?: string;
	/** Branch checked out in the resolved worktree. */
	currentBranch?: string;
	/** Branch the caller asked for. */
	requestedBranch?: string;
	/** True when an existing worktree is on a different branch than requested. */
	branchMismatch?: boolean;
}

/** Optional log sink so the IPC handler keeps its existing debug output. */
export type WorktreeLog = (message: string) => void;

/**
 * Look up the worktree path currently checked out on the given branch
 * by running `git worktree list --porcelain` against the local repo.
 *
 * Used to recover from `git worktree add` failures with the "already used /
 * already checked out" error: instead of bubbling up an opaque error, we
 * return the existing worktree path so callers can open it as a session.
 *
 * Stale registrations (where the directory was deleted manually without
 * `git worktree prune`) are filtered out by an `fs.access` check so callers
 * never get a path that points at nothing.
 *
 * @returns Absolute worktree path, or null if not found / stale
 */
export async function findLocalWorktreeForBranch(
	mainRepoCwd: string,
	branchName: string
): Promise<string | null> {
	const result = await execFileNoThrow('git', ['worktree', 'list', '--porcelain'], mainRepoCwd);
	if (result.exitCode !== 0) return null;
	const existingPath = parseWorktreePathForBranch(result.stdout, branchName);
	if (!existingPath) return null;
	try {
		await fs.access(existingPath);
		return existingPath;
	} catch {
		return null;
	}
}

/**
 * Mark both the caller-facing path and the spelling a filesystem watcher may
 * report when the parent traverses a symlink or Windows junction. The target
 * itself may not exist yet, so canonicalize its existing parent and append the
 * unchanged basename rather than calling realpath on the full target.
 *
 * @returns Every spelling marked, for callers that must release them on failure.
 */
async function markWorktreeCreationAliases(worktreePath: string): Promise<string[]> {
	const markedPaths = [worktreePath];
	markWorktreeCreatedByMaestro(worktreePath);

	try {
		const physicalParent = await fs.realpath(path.dirname(worktreePath));
		const physicalAlias = path.join(physicalParent, path.basename(worktreePath));
		markedPaths.push(physicalAlias);
		markWorktreeCreatedByMaestro(physicalAlias);
	} catch {
		// The lexical mark is still useful when the parent cannot be resolved.
	}

	return markedPaths;
}

/**
 * Create the worktree at `worktreePath` on `branchName`, or reuse it when it is
 * already a worktree of the same repository. Never throws for the expected
 * failure modes - they come back as `{ success: false, error }`.
 *
 * @param baseBranch - Branch the new branch is rooted at. Ignored when the
 *   branch already exists (it has its own commit); defaults to the main repo's
 *   current HEAD when omitted.
 */
export async function setupWorktreeLocal(
	mainRepoCwd: string,
	worktreePath: string,
	branchName: string,
	baseBranch?: string,
	log?: WorktreeLog
): Promise<WorktreeSetupResult> {
	const debug = log ?? (() => {});

	// Resolve relative worktree paths from the same cwd Git uses. Resolving
	// from the Maestro process cwd would mark a different directory and let
	// the watcher broadcast the real one to every renderer (issue #1506).
	const resolvedMainRepo = path.resolve(mainRepoCwd);
	const resolvedWorktree = path.resolve(resolvedMainRepo, worktreePath);
	debug(`Resolved paths: ${JSON.stringify({ resolvedMainRepo, resolvedWorktree })}`);

	// Claim the path BEFORE `git worktree add` runs. The directory watcher
	// fires as soon as the directory appears, and the requesting renderer is
	// already creating the child session directly. Keep the mark only when
	// setup returns a usable worktree; otherwise an external retry during the
	// TTL must still be discoverable.
	const requestedMarks = await markWorktreeCreationAliases(resolvedWorktree);
	const retainedMarks = new Set<string>();
	let keepRequestedMark = false;
	try {
		// Check if worktree path is inside the main repo (nested worktree)
		// This can cause issues because git and Claude Code search upward for .git
		// and may resolve to the parent repo instead of the worktree
		if (resolvedWorktree.startsWith(resolvedMainRepo + path.sep)) {
			return {
				success: false,
				error:
					'Worktree path cannot be inside the main repository. Please use a sibling directory (e.g., ../my-worktree) instead.',
			};
		}

		// First check if the worktree path already exists
		let pathExists = true;
		try {
			await fs.access(resolvedWorktree);
			debug(`Path exists: ${resolvedWorktree}`);
		} catch {
			pathExists = false;
			debug(`Path does not exist: ${resolvedWorktree}`);
		}

		if (pathExists) {
			// Check if it's already a worktree of this repo
			const worktreeInfoResult = await execFileNoThrow(
				'git',
				['rev-parse', '--is-inside-work-tree'],
				resolvedWorktree
			);
			debug(`is-inside-work-tree result: ${JSON.stringify(worktreeInfoResult)}`);
			if (worktreeInfoResult.exitCode !== 0) {
				// Path exists but isn't a git repo - check if it's empty and can be removed
				const dirContents = await fs.readdir(resolvedWorktree);
				debug(`Directory contents: ${JSON.stringify(dirContents)}`);
				if (dirContents.length === 0) {
					// Empty directory - remove it so we can create the worktree
					debug(`Removing empty directory`);
					await fs.rmdir(resolvedWorktree);
					pathExists = false;
				} else {
					debug(`Directory not empty, returning error`);
					return {
						success: false,
						error: 'Path exists but is not a git worktree or repository (and is not empty)',
					};
				}
			}
		}

		if (pathExists) {
			// Get the common dir to check if it's the same repo (parallel)
			const [gitCommonDirResult, mainGitDirResult] = await Promise.all([
				execFileNoThrow('git', ['rev-parse', '--git-common-dir'], resolvedWorktree),
				execFileNoThrow('git', ['rev-parse', '--git-dir'], resolvedMainRepo),
			]);

			if (gitCommonDirResult.exitCode === 0 && mainGitDirResult.exitCode === 0) {
				const worktreeCommonDir = path.resolve(resolvedWorktree, gitCommonDirResult.stdout.trim());
				const mainGitDir = path.resolve(resolvedMainRepo, mainGitDirResult.stdout.trim());

				// Normalize paths for comparison
				const normalizedWorktreeCommon = path.normalize(worktreeCommonDir);
				const normalizedMainGit = path.normalize(mainGitDir);

				if (normalizedWorktreeCommon !== normalizedMainGit) {
					return { success: false, error: 'Worktree path belongs to a different repository' };
				}
			}

			// Get current branch in the existing worktree
			const currentBranchResult = await execFileNoThrow(
				'git',
				['rev-parse', '--abbrev-ref', 'HEAD'],
				resolvedWorktree
			);
			const currentBranch =
				currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

			keepRequestedMark = true;
			return {
				success: true,
				created: false,
				currentBranch,
				requestedBranch: branchName,
				branchMismatch: currentBranch !== branchName && branchName !== '',
			};
		}

		// Worktree doesn't exist, create it
		// First check if the branch exists
		const branchExistsResult = await execFileNoThrow(
			'git',
			['rev-parse', '--verify', branchName],
			mainRepoCwd
		);
		const branchExists = branchExistsResult.exitCode === 0;

		let createResult;
		if (branchExists) {
			// Branch exists, just add worktree pointing to it. baseBranch is
			// ignored here because the existing branch already has its own commit.
			createResult = await execFileNoThrow(
				'git',
				['worktree', 'add', worktreePath, branchName],
				mainRepoCwd
			);
		} else if (baseBranch) {
			// Branch doesn't exist; create it from the requested base branch.
			// `git worktree add -b <new> <path> <base>` is the explicit form.
			createResult = await execFileNoThrow(
				'git',
				['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
				mainRepoCwd
			);
		} else {
			// Branch doesn't exist and no base specified; defaults to current HEAD
			// of the main repo (preserves pre-baseBranch behavior).
			createResult = await execFileNoThrow(
				'git',
				['worktree', 'add', '-b', branchName, worktreePath],
				mainRepoCwd
			);
		}

		if (createResult.exitCode !== 0) {
			// Recover from "already used / already checked out" - the branch is
			// already registered with another worktree on disk. Resolve that path
			// from `git worktree list --porcelain` so the caller can open it.
			const errMsg = createResult.stderr || '';
			if (isWorktreeAlreadyUsedError(errMsg)) {
				const existingPath = await findLocalWorktreeForBranch(mainRepoCwd, branchName);
				if (existingPath) {
					// The caller opens this path instead of the one it requested, so
					// it needs the same suppression the requested path already got.
					const existingMarks = await markWorktreeCreationAliases(existingPath);
					for (const existingMark of existingMarks) {
						retainedMarks.add(normalizeWorktreePath(existingMark));
					}
					return {
						success: true,
						created: false,
						alreadyExisted: true,
						existingPath,
						currentBranch: branchName,
						requestedBranch: branchName,
						branchMismatch: false,
					};
				}
			}
			return { success: false, error: createResult.stderr || 'Failed to create worktree' };
		}

		keepRequestedMark = true;
		return {
			success: true,
			created: true,
			currentBranch: branchName,
			requestedBranch: branchName,
			branchMismatch: false,
		};
	} finally {
		if (!keepRequestedMark) {
			for (const markedPath of requestedMarks) {
				if (!retainedMarks.has(normalizeWorktreePath(markedPath))) {
					clearWorktreeCreatedByMaestro(markedPath);
				}
			}
		}
	}
}
