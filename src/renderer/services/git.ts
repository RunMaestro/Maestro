/**
 * Git operations service
 * Wraps IPC calls to main process for git operations
 */

import {
	remoteUrlToBrowserUrl,
	parseGitStatusPorcelain,
	parseGitNumstat,
} from '../../shared/gitUtils';
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
import { createIpcMethod } from './ipcWrapper';

export interface GitStatus {
	files: Array<{
		path: string;
		status: string;
	}>;
	branch?: string;
}

export interface GitDiff {
	diff: string;
}

export interface GitNumstat {
	files: Array<{
		path: string;
		additions: number;
		deletions: number;
	}>;
}

export interface GitGraphNode {
	hash: string;
	shortHash: string;
	parents: string[];
	author: string;
	date: string;
	refs: string[];
	subject: string;
}

export interface GitSwitchResult {
	success: boolean;
	stderr: string;
}

/**
 * All git service methods support SSH remote execution via optional sshRemoteId parameter.
 * When sshRemoteId is provided, operations execute on the remote host via SSH.
 */
export const gitService = {
	/**
	 * Check if a directory is a git repository
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async isRepo(cwd: string, sshRemoteId?: string): Promise<boolean> {
		return createIpcMethod({
			call: () => window.maestro.git.isRepo(cwd, sshRemoteId),
			errorContext: 'Git isRepo',
			defaultValue: false,
		});
	},

	/**
	 * Initialize a new git repository at the given directory.
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async init(cwd: string, sshRemoteId?: string): Promise<{ success: boolean; error?: string }> {
		return createIpcMethod({
			call: () => window.maestro.git.init(cwd, sshRemoteId),
			errorContext: 'Git init',
			defaultValue: { success: false, error: 'git init failed' },
		});
	},

	/**
	 * Stage all changes and commit them in one shot. A clean working tree is not
	 * an error: it resolves `{ success: true, committed: false }`. Used by Auto
	 * Run to checkpoint each iteration.
	 * @param cwd Working directory path
	 * @param message Commit message
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async commitAll(
		cwd: string,
		message: string,
		sshRemoteId?: string
	): Promise<{ success: boolean; committed: boolean; commitHash?: string; error?: string }> {
		return createIpcMethod({
			call: () => window.maestro.git.commitAll(cwd, message, sshRemoteId),
			errorContext: 'Git commitAll',
			defaultValue: { success: false, committed: false, error: 'git commit failed' },
		});
	},

	// --- Worktree checkpoints ---
	// Snapshot / roll back a working tree. See src/shared/gitCheckpoints.ts for
	// the model and src/main/git/checkpoints.ts for the git mechanism.

	/**
	 * Snapshot the working tree. Captures staged, unstaged, and untracked files;
	 * pass `includeIgnored` to capture .gitignore'd ones too.
	 */
	async createCheckpoint(
		cwd: string,
		options?: CreateCheckpointOptions,
		sshRemoteId?: string
	): Promise<CheckpointResult> {
		return createIpcMethod({
			call: () => window.maestro.git.checkpointCreate(cwd, options, sshRemoteId),
			errorContext: 'Git createCheckpoint',
			defaultValue: { success: false, error: 'Failed to create checkpoint' },
		});
	},

	/** List this working tree's checkpoints, newest first. */
	async listCheckpoints(
		cwd: string,
		options?: { allWorktrees?: boolean },
		sshRemoteId?: string
	): Promise<CheckpointListResult> {
		return createIpcMethod({
			call: () => window.maestro.git.checkpointList(cwd, options, sshRemoteId),
			errorContext: 'Git listCheckpoints',
			defaultValue: { success: false, checkpoints: [], error: 'Failed to list checkpoints' },
		});
	},

	/**
	 * Roll the working tree back to a checkpoint. A safety checkpoint is taken
	 * first and returned, so the restore itself can be undone.
	 */
	async restoreCheckpoint(
		cwd: string,
		checkpointId: string,
		sshRemoteId?: string
	): Promise<RestoreCheckpointResult> {
		return createIpcMethod({
			call: () => window.maestro.git.checkpointRestore(cwd, checkpointId, sshRemoteId),
			errorContext: 'Git restoreCheckpoint',
			defaultValue: { success: false, error: 'Failed to restore checkpoint' },
		});
	},

	/** Delete a checkpoint. */
	async deleteCheckpoint(
		cwd: string,
		checkpointId: string,
		sshRemoteId?: string
	): Promise<DeleteCheckpointResult> {
		return createIpcMethod({
			call: () => window.maestro.git.checkpointDelete(cwd, checkpointId, sshRemoteId),
			errorContext: 'Git deleteCheckpoint',
			defaultValue: { success: false, error: 'Failed to delete checkpoint' },
		});
	},

	/**
	 * Get git status (porcelain format) and current branch
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async getStatus(cwd: string, sshRemoteId?: string): Promise<GitStatus> {
		return createIpcMethod({
			call: async () => {
				const [statusResult, branchResult] = await Promise.all([
					window.maestro.git.status(cwd, sshRemoteId),
					window.maestro.git.branch(cwd, sshRemoteId),
				]);

				const files = parseGitStatusPorcelain(statusResult.stdout || '');
				const branch = branchResult.stdout?.trim() || undefined;

				return { files, branch };
			},
			errorContext: 'Git status',
			defaultValue: { files: [], branch: undefined },
		});
	},

	/**
	 * Get git diff for specific files or all changes
	 * @param cwd Working directory path
	 * @param files Optional list of files to get diff for
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async getDiff(cwd: string, files?: string[], sshRemoteId?: string): Promise<GitDiff> {
		return createIpcMethod({
			call: async () => {
				// If no files specified, get full diff
				if (!files || files.length === 0) {
					const result = await window.maestro.git.diff(cwd, undefined, sshRemoteId);
					return { diff: result.stdout };
				}
				// Otherwise get diff for specific files
				const results = await Promise.all(
					files.map((file) => window.maestro.git.diff(cwd, file, sshRemoteId))
				);
				return { diff: results.map((result) => result.stdout).join('\n') };
			},
			errorContext: 'Git diff',
			defaultValue: { diff: '' },
		});
	},

	/**
	 * Get line-level statistics for all changes
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async getNumstat(cwd: string, sshRemoteId?: string): Promise<GitNumstat> {
		return createIpcMethod({
			call: async () => {
				const result = await window.maestro.git.numstat(cwd, sshRemoteId);
				const files = parseGitNumstat(result.stdout || '');
				return { files };
			},
			errorContext: 'Git numstat',
			defaultValue: { files: [] },
		});
	},

	/**
	 * Get the browser-friendly URL for the remote repository
	 * Returns null if no remote or URL cannot be parsed
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async getRemoteBrowserUrl(cwd: string, sshRemoteId?: string): Promise<string | null> {
		return createIpcMethod({
			call: async () => {
				const result = await window.maestro.git.remote(cwd, sshRemoteId);
				return result.stdout ? remoteUrlToBrowserUrl(result.stdout) : null;
			},
			errorContext: 'Git remote',
			defaultValue: null,
		});
	},

	/**
	 * Get all branches (local and remote, deduplicated)
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async getBranches(cwd: string, sshRemoteId?: string): Promise<string[]> {
		return createIpcMethod({
			call: async () => {
				const result = await window.maestro.git.branches(cwd, sshRemoteId);
				return result.branches || [];
			},
			errorContext: 'Git branches',
			defaultValue: [],
		});
	},

	/**
	 * Run a network git operation (pull/push/fetch), streaming its output.
	 *
	 * Subscribe with `onCommandOutput` BEFORE awaiting this: chunks start
	 * arriving as soon as git writes them.
	 */
	async runCommand(options: {
		runId: string;
		operation: GitStreamingOperation;
		cwd: string;
		sshRemoteId?: string;
		remoteCwd?: string;
		setUpstream?: boolean;
	}): Promise<GitRunCommandResult> {
		return createIpcMethod({
			call: () => window.maestro.git.runCommand(options),
			errorContext: `Git ${options.operation}`,
			defaultValue: {
				success: false,
				exitCode: 1,
				cancelled: false,
				error: `git ${options.operation} failed`,
			},
		});
	},

	/**
	 * Subscribe to output streamed by `runCommand`. Returns an unsubscribe.
	 */
	onCommandOutput(callback: (data: GitCommandOutputChunk) => void): () => void {
		return window.maestro.git.onCommandOutput(callback);
	},

	/**
	 * Terminate an in-flight `runCommand`.
	 */
	async cancelCommand(runId: string): Promise<void> {
		await createIpcMethod({
			call: () => window.maestro.git.cancelCommand(runId),
			errorContext: 'Git cancelCommand',
			defaultValue: { success: false },
		});
	},

	/**
	 * Check out a branch in the working tree.
	 * @param createTracking Check out a branch that only exists on origin
	 */
	async checkoutBranch(
		cwd: string,
		branch: string,
		createTracking?: boolean,
		sshRemoteId?: string
	): Promise<{ success: boolean; output?: string; error?: string }> {
		return createIpcMethod({
			call: () => window.maestro.git.checkoutBranch(cwd, branch, createTracking, sshRemoteId),
			errorContext: 'Git checkoutBranch',
			defaultValue: { success: false, error: 'git checkout failed' },
		});
	},

	/**
	 * Get all tags
	 * @param cwd Working directory path
	 * @param sshRemoteId Optional SSH remote ID for remote execution
	 */
	async getTags(cwd: string, sshRemoteId?: string): Promise<string[]> {
		return createIpcMethod({
			call: async () => {
				const result = await window.maestro.git.tags(cwd, sshRemoteId);
				return result.tags || [];
			},
			errorContext: 'Git tags',
			defaultValue: [],
		});
	},

	/**
	 * Get topology graph nodes (commits with parent hashes) for graph rendering.
	 * Throws on a main-process git error so the caller can render a real error
	 * state instead of an indistinguishable empty list.
	 */
	async getGraph(
		cwd: string,
		options?: { limit?: number },
		sshRemoteId?: string,
		remoteCwd?: string
	): Promise<GitGraphNode[]> {
		return createIpcMethod({
			call: async () => {
				const result = await window.maestro.git.graph(cwd, options, sshRemoteId, remoteCwd);
				if (result.error) throw new Error(result.error);
				return result.nodes || [];
			},
			errorContext: 'Git graph',
			rethrow: true,
		});
	},

	/**
	 * Switch to an existing branch in the current working tree.
	 * Returns success=false with stderr text on failure (e.g., dirty working tree).
	 */
	async switchBranch(
		cwd: string,
		branchName: string,
		sshRemoteId?: string,
		remoteCwd?: string
	): Promise<GitSwitchResult> {
		return createIpcMethod({
			call: async () => {
				const result = await window.maestro.git.switchBranch(
					cwd,
					branchName,
					sshRemoteId,
					remoteCwd
				);
				return { success: result.success, stderr: result.stderr };
			},
			errorContext: 'Git switch',
			defaultValue: { success: false, stderr: 'IPC call failed' },
		});
	},
};
