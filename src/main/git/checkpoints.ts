/**
 * Worktree checkpoints - the git mechanism.
 *
 * Read `src/shared/gitCheckpoints.ts` first for what a checkpoint IS and why it
 * is ref-backed rather than a shadow copy of the tree. This file is the half
 * that runs git.
 *
 * ## Creating
 *
 * A snapshot is built in a SCRATCH INDEX, never the repo's real one:
 *
 *   1. `rev-parse --absolute-git-dir` locates a private place to put it.
 *   2. `read-tree HEAD` seeds the scratch index, then `add -A` (plus `-f` when
 *      capturing ignored files) folds in everything on disk.
 *   3. `write-tree` turns that into a tree object.
 *   4. `commit-tree` roots it at a commit, and `update-ref` anchors the commit
 *      so `git gc` can never collect it.
 *
 * The scratch index matters more than it looks. The whole point of a checkpoint
 * is to be taken WHILE an agent is working, and `git add -A` against the real
 * index would silently stage that agent's in-progress edits. `GIT_INDEX_FILE`
 * is exactly how `git stash -u` builds its own untracked tree internally.
 *
 * ## Restoring
 *
 *   1. Take a safety checkpoint first, so the restore is itself undoable.
 *   2. `read-tree --reset -u <treeSha>` rewrites the index AND the working tree
 *      to the snapshot. This is `reset --hard` minus the part that moves the
 *      branch - a checkpoint restores a TREE, it does not rewrite history.
 *   3. `clean -fd` removes files created after the checkpoint. Nothing in step 2
 *      deletes them: they are untracked, so no index entry ever referred to them.
 *   4. `read-tree <indexTreeSha>` rewinds the staging area, which puts the
 *      files that were untracked at checkpoint time back to untracked rather
 *      than leaving the user's `.env` staged.
 *
 * Step 3 is the one that can destroy data, which is why step 1 is not optional
 * in practice and why `-x` is only ever passed for a checkpoint that actually
 * captured ignored files. Passing `-x` against a checkpoint that did not would
 * delete the `.env` and `node_modules` the snapshot never contained.
 */

import * as fsp from 'fs/promises';
import { execGit, execShellRemote } from '../utils/remote-git';
import { shellEscape } from '../utils/shell-escape';
import { logger } from '../utils/logger';
import type { SshRemoteConfig } from '../../shared/types';
import type { ExecResult } from '../utils/execFile';
import {
	CHECKPOINT_REF_PREFIX,
	buildCheckpointId,
	checkpointRef,
	defaultCheckpointLabel,
	filterCheckpointsForWorktree,
	formatCheckpointCommitMessage,
	isValidCheckpointId,
	parseCheckpointRef,
	sanitizeCheckpointLabel,
	type CheckpointListResult,
	type CheckpointResult,
	type CreateCheckpointOptions,
	type DeleteCheckpointResult,
	type GitCheckpoint,
	type RestoreCheckpointResult,
} from '../../shared/gitCheckpoints';

const LOG_CONTEXT = '[GitCheckpoints]';

/**
 * Where a checkpoint operation runs. `remoteCwd` is only consulted when
 * `sshRemote` is set, matching every other git handler in this codebase.
 */
export interface CheckpointTarget {
	/** Working tree path (local path, or the local mirror for display). */
	cwd: string;
	sshRemote?: SshRemoteConfig | null;
	remoteCwd?: string;
}

function run(
	target: CheckpointTarget,
	args: string[],
	env?: Record<string, string>
): Promise<ExecResult> {
	const effectiveRemoteCwd = target.sshRemote ? target.remoteCwd || target.cwd : undefined;
	return execGit(args, target.cwd, target.sshRemote, effectiveRemoteCwd, env);
}

/** git's stderr is the useful half of a failure; fall back to stdout, then a label. */
function failureText(result: ExecResult, fallback: string): string {
	return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

/**
 * A short random tail for checkpoint ids.
 *
 * Not `generateUUID()`: the id is a ref path segment and shows up in CLI output
 * the user has to type back, so it stays short. Collisions only matter within
 * one second (the id is timestamp-prefixed), and `update-ref` would fail loudly
 * on a duplicate rather than silently overwriting a checkpoint.
 */
function randomTail(): string {
	return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

/**
 * Locate the scratch index path.
 *
 * It goes inside the git dir rather than the OS temp dir for two reasons: it is
 * on the same filesystem as the objects being written, and over SSH it needs no
 * second round trip to `mktemp`. `--absolute-git-dir` resolves a linked
 * worktree's own git dir, so two worktrees checkpointing at once never share a
 * scratch file.
 */
async function resolveScratchIndexPath(target: CheckpointTarget): Promise<string | null> {
	const result = await run(target, ['rev-parse', '--absolute-git-dir']);
	if (result.exitCode !== 0) return null;
	const gitDir = result.stdout.trim();
	if (!gitDir) return null;
	// Always POSIX-joined: this string is handed to git, which accepts forward
	// slashes on every platform, and over SSH the remote is POSIX regardless of
	// what the desktop is running on.
	return `${gitDir.replace(/[\\/]+$/, '')}/maestro-checkpoint-${randomTail()}.index`;
}

async function removeScratchIndex(target: CheckpointTarget, indexPath: string): Promise<void> {
	// Best effort. A leftover scratch index is inert - git only ever reads it
	// when GIT_INDEX_FILE points at it, and every path here generates a fresh
	// name - so failing to clean one up must never turn a successful checkpoint
	// into a reported failure.
	try {
		if (target.sshRemote) {
			await execShellRemote(`rm -f ${shellEscape(indexPath)}`, target.sshRemote, {
				cwd: target.remoteCwd || target.cwd,
			});
			return;
		}
		await fsp.rm(indexPath, { force: true });
	} catch (error) {
		logger.debug('Failed to remove checkpoint scratch index', LOG_CONTEXT, { indexPath, error });
	}
}

/** Read the current branch, or null when HEAD is detached or unborn. */
async function readBranch(target: CheckpointTarget): Promise<string | null> {
	const result = await run(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
	if (result.exitCode !== 0) return null;
	return result.stdout.trim() || null;
}

/** Read HEAD's commit, or null in a repo with no commits yet. */
async function readHead(target: CheckpointTarget): Promise<string | null> {
	const result = await run(target, ['rev-parse', '--verify', '--quiet', 'HEAD']);
	if (result.exitCode !== 0) return null;
	return result.stdout.trim() || null;
}

/** Absolute path of the working tree, as git sees it. */
async function readWorktreeRoot(target: CheckpointTarget): Promise<string | null> {
	const result = await run(target, ['rev-parse', '--show-toplevel']);
	if (result.exitCode !== 0) return null;
	return result.stdout.trim() || null;
}

/**
 * Re-anchor a target at the worktree ROOT.
 *
 * Two of the commands here are cwd-relative in a way that silently truncates
 * the operation: `git add -A -- .` stages only the current directory's subtree,
 * and `git clean -fd` only cleans below the cwd. A terminal-mode agent's
 * `resolveGitCwd` returns its live shell cwd, so an agent that has `cd`-ed into
 * `src/` would otherwise checkpoint a third of its repo and restore over the
 * rest - a snapshot that looks like it worked and silently isn't one.
 *
 * Index-level commands (`read-tree`, `write-tree`) are repo-global and don't
 * care, but running everything from the root keeps that distinction from being
 * something the next caller has to remember.
 */
function atWorktreeRoot(target: CheckpointTarget, root: string): CheckpointTarget {
	// Over SSH, `--show-toplevel` already reported a REMOTE path, so it belongs
	// in remoteCwd; `cwd` stays as the local handle the caller passed.
	return target.sshRemote ? { ...target, remoteCwd: root } : { ...target, cwd: root };
}

/**
 * Write a tree from the CURRENT (real) index without disturbing it.
 *
 * `write-tree` is a pure read of the index, so this is safe to run beside a
 * working agent. It is what lets a restore put the staging area back exactly as
 * the user left it.
 */
async function writeIndexTree(target: CheckpointTarget): Promise<string | null> {
	const result = await run(target, ['write-tree']);
	if (result.exitCode !== 0) return null;
	return result.stdout.trim() || null;
}

/**
 * Create a checkpoint of the working tree.
 *
 * Succeeds on a clean tree too. That is deliberate: "nothing has changed yet"
 * is precisely the state most worth being able to return to, and refusing here
 * would make the Auto Run boundary hook skip the checkpoint before the first
 * task - the single most valuable one in the whole run.
 */
export async function createCheckpoint(
	target: CheckpointTarget,
	options: CreateCheckpointOptions = {}
): Promise<CheckpointResult> {
	const includeIgnored = options.includeIgnored === true;
	const origin = options.origin ?? 'manual';
	const createdAt = Date.now();

	const worktreePath = await readWorktreeRoot(target);
	if (!worktreePath) {
		return { success: false, error: 'Not a git repository' };
	}
	const root = atWorktreeRoot(target, worktreePath);

	const scratchIndex = await resolveScratchIndexPath(root);
	if (!scratchIndex) {
		return { success: false, error: 'Could not resolve the git directory' };
	}

	const env = { GIT_INDEX_FILE: scratchIndex };

	try {
		const headSha = await readHead(root);
		const branch = await readBranch(root);

		// The staged-only tree comes from the REAL index, so it is written before
		// the scratch index exists and without the env override.
		const indexTreeSha = await writeIndexTree(root);
		if (!indexTreeSha) {
			// Overwhelmingly this is an index with unmerged entries - a conflicted
			// merge or rebase in progress. Say so, because "write-tree failed" sends
			// the user looking for a Maestro bug instead of at their own repo state.
			return {
				success: false,
				error:
					'Could not read the staging area. A conflicted merge or rebase in progress has to be resolved or aborted before this tree can be checkpointed.',
			};
		}

		// Seed the scratch index from HEAD so tracked-but-unmodified files carry
		// their existing blobs. An unborn HEAD has nothing to seed from, which is
		// fine - `add -A` below still picks up every file on disk.
		if (headSha) {
			const seed = await run(root, ['read-tree', headSha], env);
			if (seed.exitCode !== 0) {
				return { success: false, error: failureText(seed, 'git read-tree failed') };
			}
		}

		// `--` then `.` scopes the add explicitly, so a path that happens to look
		// like a flag can't be reinterpreted. `.` is the worktree ROOT here because
		// `root` re-anchored the cwd. `-f` is what lets ignored files in; without
		// it `add -A` honors .gitignore.
		const addArgs = ['add', '-A', ...(includeIgnored ? ['-f'] : []), '--', '.'];
		const add = await run(root, addArgs, env);
		if (add.exitCode !== 0) {
			return { success: false, error: failureText(add, 'git add failed') };
		}

		const writeTree = await run(root, ['write-tree'], env);
		if (writeTree.exitCode !== 0) {
			return { success: false, error: failureText(writeTree, 'git write-tree failed') };
		}
		const treeSha = writeTree.stdout.trim();
		if (!treeSha) {
			return { success: false, error: 'git write-tree produced no tree' };
		}

		const id = buildCheckpointId(createdAt, randomTail());
		const label = sanitizeCheckpointLabel(options.label || defaultCheckpointLabel(createdAt));
		const message = formatCheckpointCommitMessage({
			label,
			id,
			createdAt,
			indexTreeSha,
			headSha,
			branch,
			worktreePath,
			includesIgnored: includeIgnored,
			origin,
		});

		// Parented on HEAD so the checkpoint reads as "the tree as of this point
		// in history" in `git log --graph` and so its objects share history's
		// deltas. An unborn HEAD simply yields a root commit.
		//
		// `-m` rather than stdin: `commit-tree` reads the message from stdin when
		// no `-m` is given, and the SSH path has no stdin to write to, so a stdin
		// message would hang the remote command instead of failing.
		const commitArgs = ['commit-tree', treeSha, ...(headSha ? ['-p', headSha] : []), '-m', message];
		const commit = await run(root, commitArgs, {
			...env,
			// Checkpoints are Maestro's bookkeeping, not the user's authorship, and
			// a repo with no configured identity would otherwise fail `commit-tree`
			// outright - which would make checkpoints unavailable exactly on the
			// throwaway clones where they are most useful.
			GIT_AUTHOR_NAME: 'Maestro',
			GIT_AUTHOR_EMAIL: 'checkpoints@runmaestro.ai',
			GIT_COMMITTER_NAME: 'Maestro',
			GIT_COMMITTER_EMAIL: 'checkpoints@runmaestro.ai',
		});
		if (commit.exitCode !== 0) {
			return { success: false, error: failureText(commit, 'git commit-tree failed') };
		}
		const commitSha = commit.stdout.trim();
		if (!commitSha) {
			return { success: false, error: 'git commit-tree produced no commit' };
		}

		const ref = checkpointRef(id);
		const update = await run(root, ['update-ref', ref, commitSha]);
		if (update.exitCode !== 0) {
			return { success: false, error: failureText(update, 'git update-ref failed') };
		}

		logger.info(`Created checkpoint ${id} (${origin})`, LOG_CONTEXT, {
			worktreePath,
			includeIgnored,
		});

		return {
			success: true,
			checkpoint: {
				id,
				label,
				commitSha,
				treeSha,
				indexTreeSha,
				headSha,
				branch,
				worktreePath,
				includesIgnored: includeIgnored,
				origin,
				createdAt,
			},
		};
	} finally {
		await removeScratchIndex(root, scratchIndex);
	}
}

/**
 * Separator between `for-each-ref` fields.
 *
 * A commit message can contain literally any character sequence, including
 * newlines, so the record separator has to be something that cannot appear in
 * one. NUL is the only such byte, and `%00` emits it.
 */
const FIELD_SEP = '\0';
const RECORD_SEP = '\0\0\0';

/**
 * List checkpoints, newest first.
 *
 * Scoped to one working tree by default - refs are shared across every worktree
 * of a repo, so an unfiltered list would offer to restore a sibling worktree's
 * snapshot over the tree on screen.
 */
export async function listCheckpoints(
	target: CheckpointTarget,
	options: { allWorktrees?: boolean } = {}
): Promise<CheckpointListResult> {
	const format = [
		'%(refname)',
		'%(objectname)',
		'%(tree)',
		'%(committerdate:unix)',
		'%(contents)',
	].join('%00');

	const result = await run(target, [
		'for-each-ref',
		`--format=${format}%00%00%00`,
		CHECKPOINT_REF_PREFIX,
	]);

	// No refs yet is an empty list, not a failure - `for-each-ref` exits 0 with
	// no output for a namespace nothing has written to.
	if (result.exitCode !== 0) {
		return {
			success: false,
			checkpoints: [],
			error: failureText(result, 'git for-each-ref failed'),
		};
	}

	const checkpoints: GitCheckpoint[] = [];
	for (const record of result.stdout.split(RECORD_SEP)) {
		if (!record.trim()) continue;
		const [refname, objectname, tree, committerdate, ...messageParts] = record.split(FIELD_SEP);
		if (!refname || !objectname || !tree) continue;
		// `%(contents)` is last in the format and can itself contain NULs only if
		// the commit message does, which git forbids - so rejoining is lossless.
		const parsed = parseCheckpointRef({
			ref: refname.trim(),
			commitSha: objectname.trim(),
			treeSha: tree.trim(),
			message: messageParts.join(FIELD_SEP),
			committedAtSeconds: Number(committerdate) || 0,
		});
		if (parsed) checkpoints.push(parsed);
	}

	const scoped = options.allWorktrees
		? checkpoints
		: filterCheckpointsForWorktree(checkpoints, (await readWorktreeRoot(target)) || target.cwd);

	// Newest first, tie-broken by id (itself timestamp-prefixed) so the order is
	// deterministic rather than whatever `for-each-ref` emitted.
	scoped.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
	return { success: true, checkpoints: scoped };
}

/** Find one checkpoint by id, scoped to this working tree. */
export async function getCheckpoint(
	target: CheckpointTarget,
	id: string
): Promise<GitCheckpoint | null> {
	if (!isValidCheckpointId(id)) return null;
	const { checkpoints } = await listCheckpoints(target);
	return checkpoints.find((c) => c.id === id) ?? null;
}

export interface RestoreCheckpointOptions {
	/**
	 * Skip the automatic safety checkpoint. Only for a caller that has already
	 * taken one - the point of restoring is that it is reversible, and the
	 * safety snapshot is the entire reason it is.
	 */
	skipSafetyCheckpoint?: boolean;
}

/**
 * Restore the working tree to a checkpoint.
 *
 * HEAD and the branch pointer are left exactly where they are: a checkpoint
 * restores a TREE. Rewinding the branch too would turn "undo the last six hours
 * of edits" into "throw away six hours of commits", which is a different and
 * far more destructive operation than the one the user asked for.
 */
export async function restoreCheckpoint(
	target: CheckpointTarget,
	id: string,
	options: RestoreCheckpointOptions = {}
): Promise<RestoreCheckpointResult> {
	if (!isValidCheckpointId(id)) {
		return { success: false, error: `Invalid checkpoint id: ${id}` };
	}

	const checkpoint = await getCheckpoint(target, id);
	if (!checkpoint) {
		return { success: false, error: `Checkpoint not found: ${id}` };
	}

	// Taken BEFORE anything is overwritten. If this fails the restore does not
	// proceed: an irreversible restore is not the feature that was asked for.
	let safetyCheckpoint: GitCheckpoint | undefined;
	if (!options.skipSafetyCheckpoint) {
		const safety = await createCheckpoint(target, {
			label: `Before restoring "${checkpoint.label}"`,
			// Match the checkpoint being restored. Restoring an ignored-inclusive
			// checkpoint runs `clean -fdx` below, so the safety snapshot has to hold
			// the ignored files that step is about to delete.
			includeIgnored: checkpoint.includesIgnored,
			origin: 'pre-restore',
		});
		if (!safety.success || !safety.checkpoint) {
			return {
				success: false,
				error: `Could not take a safety checkpoint before restoring: ${safety.error ?? 'unknown error'}`,
			};
		}
		safetyCheckpoint = safety.checkpoint;
	}

	// `git clean` below is cwd-relative, so the whole restore runs from the
	// worktree root. Restoring from a subdirectory would leave every file added
	// outside it in place - a partial restore reported as a complete one.
	const worktreeRoot = await readWorktreeRoot(target);
	if (!worktreeRoot) {
		return { success: false, safetyCheckpoint, error: 'Not a git repository' };
	}
	const root = atWorktreeRoot(target, worktreeRoot);

	// Index + working tree to the snapshot. `--reset` discards conflicting
	// entries instead of refusing, which is what makes this work on a dirty tree
	// (the only kind anyone ever restores).
	const readTree = await run(root, ['read-tree', '--reset', '-u', checkpoint.treeSha]);
	if (readTree.exitCode !== 0) {
		return {
			success: false,
			safetyCheckpoint,
			error: failureText(readTree, 'git read-tree failed'),
		};
	}

	// Remove files created since the checkpoint. `-x` ONLY when the checkpoint
	// captured ignored files - otherwise this would delete the .env and build
	// output the snapshot never contained and cannot put back.
	const cleanArgs = ['clean', '-fd', ...(checkpoint.includesIgnored ? ['-x'] : [])];
	const clean = await run(root, cleanArgs);
	if (clean.exitCode !== 0) {
		return { success: false, safetyCheckpoint, error: failureText(clean, 'git clean failed') };
	}

	// Rewind the staging area. Without this every file that was untracked at
	// checkpoint time comes back STAGED, because the snapshot tree necessarily
	// tracks everything it contains.
	const restoreIndex = await run(root, ['read-tree', checkpoint.indexTreeSha]);
	if (restoreIndex.exitCode !== 0) {
		return {
			success: false,
			safetyCheckpoint,
			error: failureText(restoreIndex, 'git read-tree (index) failed'),
		};
	}

	logger.info(`Restored checkpoint ${id}`, LOG_CONTEXT, {
		worktreePath: checkpoint.worktreePath,
		safetyCheckpointId: safetyCheckpoint?.id,
	});

	return { success: true, safetyCheckpoint };
}

/**
 * Delete a checkpoint.
 *
 * Only the ref goes. The objects it anchored become unreachable and are
 * collected by git's own `gc` on its own schedule, which is the correct owner
 * of that decision - they may still be shared with reachable history.
 */
export async function deleteCheckpoint(
	target: CheckpointTarget,
	id: string
): Promise<DeleteCheckpointResult> {
	if (!isValidCheckpointId(id)) {
		return { success: false, error: `Invalid checkpoint id: ${id}` };
	}
	const checkpoint = await getCheckpoint(target, id);
	if (!checkpoint) {
		return { success: false, error: `Checkpoint not found: ${id}` };
	}
	// Passing the expected sha makes this a compare-and-swap: a checkpoint that
	// moved between the read above and here is not deleted blindly.
	const result = await run(target, ['update-ref', '-d', checkpointRef(id), checkpoint.commitSha]);
	if (result.exitCode !== 0) {
		return { success: false, error: failureText(result, 'git update-ref -d failed') };
	}
	return { success: true };
}
