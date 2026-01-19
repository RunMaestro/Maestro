/**
 * Git operations service
 * Wraps IPC calls to main process for git operations
 */

import {
	remoteUrlToBrowserUrl,
	parseGitStatusPorcelain,
	parseGitNumstat,
} from '../../shared/gitUtils';
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
};
