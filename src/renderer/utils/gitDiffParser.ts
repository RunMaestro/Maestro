import { parseDiff, type FileData, type HunkData, type ChangeData } from 'react-diff-view';

// Image file extensions for binary detection
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];

export interface ParsedFileDiff {
	oldPath: string;
	newPath: string;
	diffText: string;
	parsedDiff: FileData[];
	isBinary: boolean;
	isImage: boolean;
	isNewFile: boolean;
	isDeletedFile: boolean;
}

/**
 * Parse git diff output and separate it by file
 * @param diffText - The raw git diff output
 * @returns Array of parsed file diffs
 */
export function parseGitDiff(diffText: string): ParsedFileDiff[] {
	if (!diffText || diffText.trim() === '') {
		return [];
	}

	// Split by "diff --git" to get individual file diffs
	const fileSections = diffText.split(/(?=diff --git)/g).filter((section) => section.trim());

	return fileSections.map((section) => {
		// Extract file paths from the diff header
		// Format: "diff --git a/path/to/file.ts b/path/to/file.ts"
		const pathMatch = section.match(/diff --git a\/(.*?) b\/(.*)/);
		const oldPath = pathMatch?.[1] || 'unknown';
		const newPath = pathMatch?.[2] || 'unknown';

		// Detect binary files - git outputs "Binary files ... differ"
		const isBinary = /Binary files .* differ/.test(section);

		// Check if the file is an image based on extension
		const ext = newPath.split('.').pop()?.toLowerCase() || '';
		const isImage = IMAGE_EXTENSIONS.includes(ext);

		// Detect new/deleted files
		const isNewFile = section.includes('new file mode') || section.includes('/dev/null\n+++ b/');
		const isDeletedFile =
			section.includes('deleted file mode') ||
			(section.includes('--- a/') && section.includes('+++ /dev/null'));

		try {
			// Use react-diff-view's parseDiff to parse the diff section
			// For binary files, parseDiff will likely fail or return empty, but that's okay
			const parsedDiff = isBinary ? [] : parseDiff(section);

			return {
				oldPath,
				newPath,
				diffText: section,
				parsedDiff,
				isBinary,
				isImage,
				isNewFile,
				isDeletedFile,
			};
		} catch (error) {
			console.error('Failed to parse diff section:', error);
			// Return a fallback structure if parsing fails
			return {
				oldPath,
				newPath,
				diffText: section,
				parsedDiff: [],
				isBinary,
				isImage,
				isNewFile,
				isDeletedFile,
			};
		}
	});
}

/**
 * Get a display name for a file path (just the filename)
 * @param path - Full file path
 * @returns Just the filename
 */
export function getFileName(path: string): string {
	const parts = path.split('/');
	return parts[parts.length - 1];
}

/**
 * Get statistics for a parsed diff (additions, deletions)
 * @param parsedDiff - Parsed diff from react-diff-view
 * @returns Object with additions and deletions count
 */
export function getDiffStats(parsedDiff: FileData[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;

	parsedDiff.forEach((file: FileData) => {
		file.hunks.forEach((hunk: HunkData) => {
			hunk.changes.forEach((change: ChangeData) => {
				if (change.type === 'insert') additions++;
				if (change.type === 'delete') deletions++;
			});
		});
	});

	return { additions, deletions };
}
