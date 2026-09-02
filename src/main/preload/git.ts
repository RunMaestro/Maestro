/**
 * Preload API for git operations
 *
 * Provides the window.maestro.git namespace for:
 * - Git status, diff, branch operations
 * - Git log and commit viewing
 * - Git worktree operations for Auto Run parallelization
 * - GitHub CLI integration (PR creation, gists)
 * - SSH remote support for all operations
 */

import { ipcRenderer } from 'electron';
import type {
	GitCommandOutputChunk,
	GitRunCommandResult,
	GitStreamingOperation,
} from '../../shared/gitUtils';
import type {
	CheckpointListResult,
	CheckpointResult,
	CreateCheckpointOptions,
	DeleteCheckpointResult,
	RestoreCheckpointResult,
} from '../../shared/gitCheckpoints';

/**
 * Git worktree information
 */
export interface WorktreeInfo {
	success: boolean;
	exists?: boolean;
	isWorktree?: boolean;
	currentBranch?: string;
	repoRoot?: string;
	error?: string;
}

/**
 * Git worktree list entry
 */
export interface WorktreeEntry {
	path: string;
	head: string;
	branch: string | null;
	isBare: boolean;
}

/**
 * Git subdirectory scan result
 */
export interface GitSubdirEntry {
	path: string;
	name: string;
	isWorktree: boolean;
	branch: string | null;
	repoRoot: string | null;
}

/**
 * Git log entry
 */
export interface GitLogEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	refs: string[];
	subject: string;
}

/**
 * Git graph node - like GitLogEntry but with parent hashes for topology rendering.
 */
export interface GitGraphNode {
	hash: string;
	shortHash: string;
	parents: string[];
	author: string;
	date: string;
	refs: string[];
	subject: string;
}

/**
 * Discovered worktree event data
 */
export interface WorktreeDiscoveredData {
	sessionId: string;
	worktree: {
		path: string;
		name: string;
		branch: string | null;
	};
}

/**
 * Removed worktree event data
 */
export interface WorktreeRemovedData {
	sessionId: string;
	worktreePath: string;
}

/**
 * Result of the `git.worktreeSetup` IPC.
 *
 * Shared between the preload bridge and the renderer global declaration so
 * the contract stays in one place.
 *
 * Named `GitWorktreeSetupResult` to avoid colliding with the higher-level
 * `WorktreeSetupResult` exported from `renderer/hooks/batch/useWorktreeManager`.
 */
export interface GitWorktreeSetupResult {
	success: boolean;
	created?: boolean;
	currentBranch?: string;
	requestedBranch?: string;
	branchMismatch?: boolean;
	/** True when the branch was already attached to a worktree on disk. */
	alreadyExisted?: boolean;
	/** Path of the existing worktree when alreadyExisted is true. */
	existingPath?: string;
	error?: string;
}

/**
 * Context passed to the post-create setup script, surfaced to it as MAESTRO_*
 * environment variables.
 */
export interface WorktreeSetupScriptContext {
	/** Absolute path of the newly created worktree (the script's cwd) */
	worktreePath: string;
	/** Branch checked out in the new worktree */
	branchName: string;
	/** Absolute path of the main repository the worktree was created from */
	mainRepoPath: string;
	/** Branch the new branch was based on, when one was specified */
	baseBranch?: string;
}

/**
 * Result of the `git.worktreeRunSetup` IPC.
 */
export interface GitWorktreeRunSetupResult {
	/** True when the script ran and exited 0 (also true when nothing was configured) */
	success: boolean;
	/** False when no script was configured, so nothing was executed */
	ran: boolean;
	exitCode?: number | string;
	stdout: string;
	stderr: string;
	error?: string;
}

/**
 * Result of the `git.worktreeCheckout` IPC.
 */
export interface GitWorktreeCheckoutResult {
	success: boolean;
	hasUncommittedChanges: boolean;
	error?: string;
}

/**
 * Creates the git API object for preload exposure
 */
export function createGitApi() {
	return {
		/**
		 * Get git status for a repository
		 */
		status: (cwd: string, sshRemoteId?: string, remoteCwd?: string): Promise<string> =>
			ipcRenderer.invoke('git:status', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get git diff for a repository or specific file
		 */
		diff: (cwd: string, file?: string, sshRemoteId?: string, remoteCwd?: string): Promise<string> =>
			ipcRenderer.invoke('git:diff', cwd, file, sshRemoteId, remoteCwd),

		/**
		 * Check if a directory is a git repository
		 */
		isRepo: (cwd: string, sshRemoteId?: string, remoteCwd?: string): Promise<boolean> =>
			ipcRenderer.invoke('git:isRepo', cwd, sshRemoteId, remoteCwd),

		/**
		 * Initialize a new git repository at the given directory.
		 */
		init: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('git:init', cwd, sshRemoteId, remoteCwd),

		/**
		 * Stage all changes and commit them. A clean tree returns
		 * { success: true, committed: false } (not an error).
		 */
		commitAll: (
			cwd: string,
			message: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{
			success: boolean;
			committed: boolean;
			commitHash?: string;
			error?: string;
		}> => ipcRenderer.invoke('git:commitAll', cwd, message, sshRemoteId, remoteCwd),

		/**
		 * Get git diff numstat
		 */
		numstat: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:numstat', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get current branch name
		 */
		branch: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:branch', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get list of all branches
		 */
		branches: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:branches', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get list of tags
		 */
		tags: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:tags', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get remote URL
		 */
		remote: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:remote', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get comprehensive git info (branch, remote, ahead/behind, changes)
		 */
		info: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{
			branch: string;
			remote: string;
			behind: number;
			ahead: number;
			uncommittedChanges: number;
		}> => ipcRenderer.invoke('git:info', cwd, sshRemoteId, remoteCwd),

		/**
		 * Get git log with optional limit and search
		 */
		log: (
			cwd: string,
			options?: { limit?: number; search?: string },
			sshRemoteId?: string
		): Promise<{
			entries: GitLogEntry[];
			error: string | null;
		}> => ipcRenderer.invoke('git:log', cwd, options, sshRemoteId),

		/**
		 * Get topology graph data (commits with parent hashes) for graph rendering
		 */
		graph: (
			cwd: string,
			options?: { limit?: number },
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ nodes: GitGraphNode[]; error: string | null }> =>
			ipcRenderer.invoke('git:graph', cwd, options, sshRemoteId, remoteCwd),

		/**
		 * Switch the current working tree to an existing branch.
		 * Returns success=false on dirty working tree (stderr contains git's message).
		 */
		switchBranch: (
			cwd: string,
			branchName: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ success: boolean; stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:switch', cwd, branchName, sshRemoteId, remoteCwd),

		/**
		 * Run a network git operation (pull/push/fetch), streaming its output.
		 *
		 * Subscribe with `onCommandOutput` BEFORE calling this: chunks start
		 * arriving as soon as the child process writes them.
		 */
		runCommand: (options: {
			runId: string;
			operation: GitStreamingOperation;
			cwd: string;
			sshRemoteId?: string;
			remoteCwd?: string;
			setUpstream?: boolean;
		}): Promise<GitRunCommandResult> => ipcRenderer.invoke('git:runCommand', options),

		/**
		 * Terminate an in-flight `runCommand`.
		 */
		cancelCommand: (runId: string): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('git:cancelCommand', runId),

		/**
		 * Subscribe to streamed output from `runCommand`. Returns an unsubscribe.
		 */
		onCommandOutput: (callback: (data: GitCommandOutputChunk) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, data: GitCommandOutputChunk) =>
				callback(data);
			ipcRenderer.on('git:commandOutput', handler);
			return () => ipcRenderer.removeListener('git:commandOutput', handler);
		},

		/**
		 * Check out a branch in the session's working tree.
		 * Pass `createTracking` for a branch that only exists on origin.
		 */
		checkoutBranch: (
			cwd: string,
			branch: string,
			createTracking?: boolean,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ success: boolean; output?: string; error?: string }> =>
			ipcRenderer.invoke('git:checkoutBranch', cwd, branch, createTracking, sshRemoteId, remoteCwd),

		/**
		 * Get commit count
		 */
		commitCount: (
			cwd: string,
			sshRemoteId?: string
		): Promise<{ count: number; error: string | null }> =>
			ipcRenderer.invoke('git:commitCount', cwd, sshRemoteId),

		/**
		 * Show a specific commit
		 */
		show: (
			cwd: string,
			hash: string,
			sshRemoteId?: string
		): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:show', cwd, hash, sshRemoteId),

		/**
		 * Show file content at a specific ref
		 */
		showFile: (
			cwd: string,
			ref: string,
			filePath: string
		): Promise<{ content?: string; error?: string }> =>
			ipcRenderer.invoke('git:showFile', cwd, ref, filePath),

		// Git worktree operations for Auto Run parallelization
		// All worktree operations support SSH remote execution via optional sshRemoteId parameter

		/**
		 * Get worktree information
		 */
		worktreeInfo: (worktreePath: string, sshRemoteId?: string): Promise<WorktreeInfo> =>
			ipcRenderer.invoke('git:worktreeInfo', worktreePath, sshRemoteId),

		/**
		 * Get the root of a git repository
		 */
		getRepoRoot: (
			cwd: string,
			sshRemoteId?: string
		): Promise<{ success: boolean; root?: string; error?: string }> =>
			ipcRenderer.invoke('git:getRepoRoot', cwd, sshRemoteId),

		/**
		 * Setup a worktree (create if needed).
		 *
		 * `baseBranch` is honored only when the named branch does not already exist;
		 * it is forwarded as the third positional arg to `git worktree add -b`.
		 * Omitting it preserves the historical behavior of branching from the main
		 * repo's current HEAD.
		 */
		worktreeSetup: (
			mainRepoCwd: string,
			worktreePath: string,
			branchName: string,
			sshRemoteId?: string,
			baseBranch?: string
		): Promise<GitWorktreeSetupResult> =>
			ipcRenderer.invoke(
				'git:worktreeSetup',
				mainRepoCwd,
				worktreePath,
				branchName,
				sshRemoteId,
				baseBranch
			),

		/**
		 * Run the configured post-create setup script inside a new worktree.
		 * A blank script resolves to `{ success: true, ran: false }`.
		 */
		worktreeRunSetup: (
			script: string,
			context: WorktreeSetupScriptContext,
			sshRemoteId?: string
		): Promise<GitWorktreeRunSetupResult> =>
			ipcRenderer.invoke('git:worktreeRunSetup', script, context, sshRemoteId),

		/**
		 * Checkout a branch in a worktree
		 */
		worktreeCheckout: (
			worktreePath: string,
			branchName: string,
			createIfMissing: boolean,
			sshRemoteId?: string
		): Promise<GitWorktreeCheckoutResult> =>
			ipcRenderer.invoke(
				'git:worktreeCheckout',
				worktreePath,
				branchName,
				createIfMissing,
				sshRemoteId
			),

		// Worktree checkpoints - snapshot and roll back a working tree.
		// See src/shared/gitCheckpoints.ts for the model; every call is
		// SSH-aware via the optional sshRemoteId / remoteCwd pair.

		/**
		 * Snapshot the working tree (staged, unstaged, and untracked; ignored
		 * files too when `includeIgnored` is set) into a ref-backed checkpoint.
		 */
		checkpointCreate: (
			cwd: string,
			options?: CreateCheckpointOptions,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<CheckpointResult> =>
			ipcRenderer.invoke('git:checkpointCreate', cwd, options, sshRemoteId, remoteCwd),

		/**
		 * List this working tree's checkpoints, newest first. Pass
		 * `allWorktrees` to see every worktree's - refs are shared repo-wide.
		 */
		checkpointList: (
			cwd: string,
			options?: { allWorktrees?: boolean },
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<CheckpointListResult> =>
			ipcRenderer.invoke('git:checkpointList', cwd, options, sshRemoteId, remoteCwd),

		/**
		 * Roll the working tree back to a checkpoint. Always takes a safety
		 * checkpoint first and returns it, so the restore is itself undoable.
		 * Leaves HEAD and the branch pointer alone - this restores a tree, it
		 * does not rewrite history.
		 */
		checkpointRestore: (
			cwd: string,
			checkpointId: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<RestoreCheckpointResult> =>
			ipcRenderer.invoke('git:checkpointRestore', cwd, checkpointId, sshRemoteId, remoteCwd),

		/** Delete a checkpoint's ref. Its objects are left to `git gc`. */
		checkpointDelete: (
			cwd: string,
			checkpointId: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<DeleteCheckpointResult> =>
			ipcRenderer.invoke('git:checkpointDelete', cwd, checkpointId, sshRemoteId, remoteCwd),

		/**
		 * Create a GitHub PR
		 */
		createPR: (
			worktreePath: string,
			baseBranch: string,
			title: string,
			body: string,
			ghPath?: string
		): Promise<{
			success: boolean;
			prUrl?: string;
			error?: string;
		}> => ipcRenderer.invoke('git:createPR', worktreePath, baseBranch, title, body, ghPath),

		/**
		 * Get the default branch of a repository
		 */
		getDefaultBranch: (
			cwd: string
		): Promise<{ success: boolean; branch?: string; error?: string }> =>
			ipcRenderer.invoke('git:getDefaultBranch', cwd),

		/**
		 * Check if GitHub CLI is installed and authenticated
		 */
		checkGhCli: (ghPath?: string): Promise<{ installed: boolean; authenticated: boolean }> =>
			ipcRenderer.invoke('git:checkGhCli', ghPath),

		/**
		 * Create a GitHub Gist from file content
		 */
		createGist: (
			filename: string,
			content: string,
			description: string,
			isPublic: boolean,
			ghPath?: string
		): Promise<{
			success: boolean;
			gistUrl?: string;
			error?: string;
		}> => ipcRenderer.invoke('git:createGist', filename, content, description, isPublic, ghPath),

		/**
		 * List all worktrees for a git repository
		 * Supports SSH remote execution via optional sshRemoteId parameter
		 */
		listWorktrees: (cwd: string, sshRemoteId?: string): Promise<{ worktrees: WorktreeEntry[] }> =>
			ipcRenderer.invoke('git:listWorktrees', cwd, sshRemoteId),

		/**
		 * Scan a directory for subdirectories that are git repositories or worktrees
		 * Supports SSH remote execution via optional sshRemoteId parameter
		 */
		scanWorktreeDirectory: (
			parentPath: string,
			sshRemoteId?: string
		): Promise<{ gitSubdirs: GitSubdirEntry[]; scanFailed?: boolean }> =>
			ipcRenderer.invoke('git:scanWorktreeDirectory', parentPath, sshRemoteId),

		/**
		 * Watch a worktree directory for new worktrees
		 * Note: File watching is not available for SSH remote sessions.
		 * For remote sessions, returns isRemote: true indicating polling should be used instead.
		 */
		watchWorktreeDirectory: (
			sessionId: string,
			worktreePath: string,
			sshRemoteId?: string
		): Promise<{
			success: boolean;
			error?: string;
			isRemote?: boolean;
			message?: string;
		}> => ipcRenderer.invoke('git:watchWorktreeDirectory', sessionId, worktreePath, sshRemoteId),

		/**
		 * Stop watching a worktree directory
		 */
		unwatchWorktreeDirectory: (sessionId: string): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('git:unwatchWorktreeDirectory', sessionId),

		/**
		 * Remove a worktree directory from disk
		 */
		removeWorktree: (
			worktreePath: string,
			force?: boolean
		): Promise<{
			success: boolean;
			error?: string;
			hasUncommittedChanges?: boolean;
		}> => ipcRenderer.invoke('git:removeWorktree', worktreePath, force),

		/**
		 * Subscribe to discovered worktrees
		 */
		onWorktreeDiscovered: (callback: (data: WorktreeDiscoveredData) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, data: WorktreeDiscoveredData) =>
				callback(data);
			ipcRenderer.on('worktree:discovered', handler);
			return () => ipcRenderer.removeListener('worktree:discovered', handler);
		},

		onWorktreeRemoved: (callback: (data: WorktreeRemovedData) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, data: WorktreeRemovedData) =>
				callback(data);
			ipcRenderer.on('worktree:removed', handler);
			return () => ipcRenderer.removeListener('worktree:removed', handler);
		},
	};
}

/**
 * TypeScript type for the git API
 */
export type GitApi = ReturnType<typeof createGitApi>;
