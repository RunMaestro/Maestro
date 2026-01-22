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
			options?: { limit?: number; search?: string }
		): Promise<{
			entries: GitLogEntry[];
			error: string | null;
		}> => ipcRenderer.invoke('git:log', cwd, options),

		/**
		 * Get commit count
		 */
		commitCount: (cwd: string): Promise<{ count: number; error: string | null }> =>
			ipcRenderer.invoke('git:commitCount', cwd),

		/**
		 * Show a specific commit
		 */
		show: (cwd: string, hash: string): Promise<{ stdout: string; stderr: string }> =>
			ipcRenderer.invoke('git:show', cwd, hash),

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
		 * Setup a worktree (create if needed)
		 */
		worktreeSetup: (
			mainRepoCwd: string,
			worktreePath: string,
			branchName: string,
			sshRemoteId?: string
		): Promise<{
			success: boolean;
			created?: boolean;
			currentBranch?: string;
			requestedBranch?: string;
			branchMismatch?: boolean;
			error?: string;
		}> =>
			ipcRenderer.invoke('git:worktreeSetup', mainRepoCwd, worktreePath, branchName, sshRemoteId),

		/**
		 * Checkout a branch in a worktree
		 */
		worktreeCheckout: (
			worktreePath: string,
			branchName: string,
			createIfMissing: boolean,
			sshRemoteId?: string
		): Promise<{
			success: boolean;
			hasUncommittedChanges: boolean;
			error?: string;
		}> =>
			ipcRenderer.invoke(
				'git:worktreeCheckout',
				worktreePath,
				branchName,
				createIfMissing,
				sshRemoteId
			),

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
		): Promise<{ gitSubdirs: GitSubdirEntry[] }> =>
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
	};
}

/**
 * TypeScript type for the git API
 */
export type GitApi = ReturnType<typeof createGitApi>;
