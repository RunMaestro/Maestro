/**
 * Shared Git utilities for Maestro
 *
 * This module provides common git-related parsing and utility functions
 * used across main process, renderer, and CLI.
 *
 * Note: Actual git command execution differs by environment:
 * - Main process: Uses execFileNoThrow
 * - CLI: Uses execFileSync
 *
 * This module focuses on parsing and utility functions that can be shared.
 */

/**
 * Represents a file change from git status output
 */
export interface GitFileStatus {
	path: string;
	status: string;
}

/**
 * Represents a file with numstat information (additions/deletions)
 */
export interface GitNumstatFile {
	path: string;
	additions: number;
	deletions: number;
}

/**
 * Behind/ahead counts relative to upstream
 */
export interface GitBehindAhead {
	behind: number;
	ahead: number;
}

/**
 * Parse git status --porcelain output into structured file statuses
 *
 * Porcelain format: XY PATH or XY PATH -> NEWPATH (for renames)
 * Where XY is the two-character status code
 *
 * @param stdout - Raw stdout from `git status --porcelain`
 * @returns Array of file statuses with path and status code
 *
 * @example
 * ```typescript
 * const files = parseGitStatusPorcelain(' M src/index.ts\n?? new-file.ts\n');
 * // Returns: [
 * //   { path: 'src/index.ts', status: ' M' },
 * //   { path: 'new-file.ts', status: '??' }
 * // ]
 * ```
 */
export function parseGitStatusPorcelain(stdout: string): GitFileStatus[] {
	if (!stdout || !stdout.trim()) {
		return [];
	}

	// Split on newlines but don't trim the whole string - leading spaces are significant!
	// Only trim trailing whitespace to remove the final newline
	const lines = stdout
		.replace(/\s+$/, '')
		.split('\n')
		.filter((line) => line.length > 0);
	const files: GitFileStatus[] = [];

	for (const line of lines) {
		// Porcelain format: XY PATH or XY PATH -> NEWPATH (for renames)
		// XY is exactly 2 characters, followed by a space, then the path
		const status = line.substring(0, 2);
		const path = line.substring(3).split(' -> ')[0]; // Handle renames

		files.push({ path, status });
	}

	return files;
}

/**
 * Count uncommitted changes from git status --porcelain output
 *
 * @param stdout - Raw stdout from `git status --porcelain`
 * @returns Number of uncommitted changes
 */
export function countUncommittedChanges(stdout: string): number {
	if (!stdout || !stdout.trim()) {
		return 0;
	}
	return stdout
		.trim()
		.split('\n')
		.filter((line) => line.length > 0).length;
}

/**
 * Check if git status output indicates any uncommitted changes
 *
 * @param stdout - Raw stdout from `git status --porcelain`
 * @returns True if there are any uncommitted changes
 */
export function hasUncommittedChanges(stdout: string): boolean {
	return stdout.trim().length > 0;
}

/**
 * Parse git diff --numstat output into structured file statistics
 *
 * Numstat format: ADDITIONS\tDELETIONS\tPATH
 * Binary files show '-' for additions/deletions
 *
 * @param stdout - Raw stdout from `git diff --numstat`
 * @returns Array of files with additions and deletions counts
 *
 * @example
 * ```typescript
 * const files = parseGitNumstat('10\t5\tsrc/index.ts\n-\t-\timage.png\n');
 * // Returns: [
 * //   { path: 'src/index.ts', additions: 10, deletions: 5 },
 * //   { path: 'image.png', additions: 0, deletions: 0 }
 * // ]
 * ```
 */
export function parseGitNumstat(stdout: string): GitNumstatFile[] {
	if (!stdout || !stdout.trim()) {
		return [];
	}

	const lines = stdout
		.trim()
		.split('\n')
		.filter((line) => line.length > 0);
	const files: GitNumstatFile[] = [];

	for (const line of lines) {
		const parts = line.split('\t');
		if (parts.length >= 3) {
			// Binary files show '-' for additions/deletions
			const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
			const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
			const path = parts[2];

			files.push({ path, additions, deletions });
		}
	}

	return files;
}

/**
 * Parse git rev-list --left-right --count output for behind/ahead counts
 *
 * Format: BEHIND\tAHEAD (tab-separated)
 *
 * @param stdout - Raw stdout from `git rev-list --left-right --count @{upstream}...HEAD`
 * @returns Object with behind and ahead counts
 *
 * @example
 * ```typescript
 * const counts = parseGitBehindAhead('3\t5\n');
 * // Returns: { behind: 3, ahead: 5 }
 * ```
 */
export function parseGitBehindAhead(stdout: string): GitBehindAhead {
	if (!stdout || !stdout.trim()) {
		return { behind: 0, ahead: 0 };
	}

	const parts = stdout.trim().split(/\s+/);
	return {
		behind: parseInt(parts[0], 10) || 0,
		ahead: parseInt(parts[1], 10) || 0,
	};
}

/**
 * Parse branch list output into array of branch names
 *
 * Handles output from `git branch -a --format=%(refname:short)`
 * Cleans up remote branch names and removes duplicates
 *
 * @param stdout - Raw stdout from git branch command
 * @returns Array of unique branch names
 *
 * @example
 * ```typescript
 * const branches = parseGitBranches('main\norigin/main\nfeature/foo\norigin/feature/foo\n');
 * // Returns: ['main', 'feature/foo']
 * ```
 */
export function parseGitBranches(stdout: string): string[] {
	if (!stdout || !stdout.trim()) {
		return [];
	}

	return (
		stdout
			.split('\n')
			.map((b) => b.trim())
			.filter((b) => b.length > 0)
			// Clean up remote branch names (origin/main -> main for remotes)
			.map((b) => b.replace(/^origin\//, ''))
			// Remove duplicates (local and remote might have same name)
			.filter((b, i, arr) => arr.indexOf(b) === i)
			// Filter out HEAD pointer
			.filter((b) => b !== 'HEAD')
	);
}

/**
 * Parse tags list output into array of tag names
 *
 * @param stdout - Raw stdout from `git tag --list`
 * @returns Array of tag names
 */
export function parseGitTags(stdout: string): string[] {
	if (!stdout || !stdout.trim()) {
		return [];
	}

	return stdout
		.split('\n')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/**
 * Clean and normalize a branch name from git output
 *
 * @param stdout - Raw stdout from `git rev-parse --abbrev-ref HEAD`
 * @returns Trimmed branch name or empty string
 *
 * @internal Currently used only in tests; available for future use
 */
export function cleanBranchName(stdout: string): string {
	return stdout?.trim() || '';
}

/**
 * Clean and normalize a path from git output
 *
 * @param stdout - Raw stdout from git commands returning paths
 * @returns Trimmed path or empty string
 *
 * @internal Currently used only in tests; available for future use
 */
export function cleanGitPath(stdout: string): string {
	return stdout?.trim() || '';
}

/**
 * Convert a git remote URL to a browser-friendly URL
 * Supports GitHub, GitLab, Bitbucket, and other common hosts
 *
 * @param remoteUrl - Git remote URL (SSH or HTTPS format)
 * @returns Browser-friendly URL or null if cannot be parsed
 *
 * @example
 * ```typescript
 * remoteUrlToBrowserUrl('git@github.com:user/repo.git')
 * // Returns: 'https://github.com/user/repo'
 *
 * remoteUrlToBrowserUrl('https://github.com/user/repo.git')
 * // Returns: 'https://github.com/user/repo'
 * ```
 */
export function remoteUrlToBrowserUrl(remoteUrl: string): string | null {
	if (!remoteUrl) return null;

	let url = remoteUrl.trim();

	// Handle SSH format: git@github.com:user/repo.git
	if (url.startsWith('git@')) {
		url = url
			.replace(/^git@/, 'https://')
			.replace(/:([^/])/, '/$1') // Replace first : with / (but not :// from https)
			.replace(/\.git$/, '');
		return url;
	}

	// Handle HTTPS format: https://github.com/user/repo.git
	if (url.startsWith('https://') || url.startsWith('http://')) {
		url = url.replace(/\.git$/, '');
		return url;
	}

	// Handle SSH format without git@: ssh://git@github.com/user/repo.git
	if (url.startsWith('ssh://')) {
		url = url
			.replace(/^ssh:\/\/git@/, 'https://')
			.replace(/^ssh:\/\//, 'https://')
			.replace(/\.git$/, '');
		return url;
	}

	return null;
}

/**
 * Common image file extensions for git file handling
 */
export const GIT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];

/**
 * Check if a file path is an image based on extension
 *
 * @param filePath - File path to check
 * @returns True if the file is an image
 */
export function isImageFile(filePath: string): boolean {
	const ext = filePath.split('.').pop()?.toLowerCase() || '';
	return GIT_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Get MIME type for an image extension
 *
 * @param ext - File extension (without dot)
 * @returns MIME type string
 */
export function getImageMimeType(ext: string): string {
	if (ext === 'svg') return 'image/svg+xml';
	if (ext === 'jpg') return 'image/jpeg';
	return `image/${ext}`;
}
