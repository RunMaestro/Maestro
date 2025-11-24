/**
 * Git operations service
 * Wraps IPC calls to main process for git operations
 */

export interface GitStatus {
  files: Array<{
    path: string;
    status: string;
  }>;
}

export interface GitDiff {
  diff: string;
}

export const gitService = {
  /**
   * Check if a directory is a git repository
   */
  async isRepo(cwd: string): Promise<boolean> {
    try {
      const result = await window.maestro.git.isRepo(cwd);
      return result;
    } catch (error) {
      console.error('Git isRepo error:', error);
      return false;
    }
  },

  /**
   * Get git status (porcelain format)
   */
  async getStatus(cwd: string): Promise<GitStatus> {
    try {
      const result = await window.maestro.git.status(cwd);
      return result;
    } catch (error) {
      console.error('Git status error:', error);
      return { files: [] };
    }
  },

  /**
   * Get git diff for specific files
   */
  async getDiff(cwd: string, files: string[]): Promise<GitDiff> {
    try {
      const result = await window.maestro.git.diff(cwd, files);
      return result;
    } catch (error) {
      console.error('Git diff error:', error);
      return { diff: '' };
    }
  }
};
