/**
 * Git operations service
 * Wraps IPC calls to main process for git operations
 */

import { remoteUrlToBrowserUrl, parseGitStatusPorcelain, parseGitNumstat } from '../../shared/gitUtils';
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

export const gitService = {
  /**
   * Check if a directory is a git repository
   */
  async isRepo(cwd: string): Promise<boolean> {
    return createIpcMethod({
      call: () => window.maestro.git.isRepo(cwd),
      errorContext: 'Git isRepo',
      defaultValue: false,
    });
  },

  /**
   * Get git status (porcelain format) and current branch
   */
  async getStatus(cwd: string): Promise<GitStatus> {
    return createIpcMethod({
      call: async () => {
        const [statusResult, branchResult] = await Promise.all([
          window.maestro.git.status(cwd),
          window.maestro.git.branch(cwd),
        ]);

        const files = parseGitStatusPorcelain(statusResult.stdout || '');
        const branch = branchResult.stdout?.trim() || undefined;

        return { files, branch };
      },
      errorContext: 'Git status',
      defaultValue: { files: [] },
    });
  },

  /**
   * Get git diff for specific files or all changes
   */
  async getDiff(cwd: string, files?: string[]): Promise<GitDiff> {
    return createIpcMethod({
      call: async () => {
        // If no files specified, get full diff
        if (!files || files.length === 0) {
          const result = await window.maestro.git.diff(cwd);
          return { diff: result.stdout };
        }
        // Otherwise get diff for specific files
        return window.maestro.git.diff(cwd, files);
      },
      errorContext: 'Git diff',
      defaultValue: { diff: '' },
    });
  },

  /**
   * Get line-level statistics for all changes
   */
  async getNumstat(cwd: string): Promise<GitNumstat> {
    return createIpcMethod({
      call: async () => {
        const result = await window.maestro.git.numstat(cwd);
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
   */
  async getRemoteBrowserUrl(cwd: string): Promise<string | null> {
    return createIpcMethod({
      call: async () => {
        const result = await window.maestro.git.remote(cwd);
        return result.stdout ? remoteUrlToBrowserUrl(result.stdout) : null;
      },
      errorContext: 'Git remote',
      defaultValue: null,
    });
  },

  /**
   * Get all branches (local and remote, deduplicated)
   */
  async getBranches(cwd: string): Promise<string[]> {
    return createIpcMethod({
      call: async () => {
        const result = await window.maestro.git.branches(cwd);
        return result.branches || [];
      },
      errorContext: 'Git branches',
      defaultValue: [],
    });
  },

  /**
   * Get all tags
   */
  async getTags(cwd: string): Promise<string[]> {
    return createIpcMethod({
      call: async () => {
        const result = await window.maestro.git.tags(cwd);
        return result.tags || [];
      },
      errorContext: 'Git tags',
      defaultValue: [],
    });
  }
};
