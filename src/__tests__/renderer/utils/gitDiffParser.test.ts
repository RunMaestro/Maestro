import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	parseGitDiff,
	getFileName,
	getDiffStats,
	ParsedFileDiff,
} from '../../../renderer/utils/gitDiffParser';

// Mock react-diff-view's parseDiff
vi.mock('react-diff-view', () => ({
	parseDiff: vi.fn((diffText: string) => {
		// Simple mock that returns parsed structure based on diff text
		// Real parseDiff returns array of File objects with hunks
		if (diffText.includes('@@')) {
			const hunks: Array<{
				content: string;
				oldStart: number;
				oldLines: number;
				newStart: number;
				newLines: number;
				changes: Array<{ type: string; content: string; lineNumber: number }>;
			}> = [];

			// Extract hunks from diff text
			const hunkMatches = diffText.matchAll(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@[^\n]*/g);
			for (const match of hunkMatches) {
				const hunkStart = match.index! + match[0].length;
				const hunkEnd = diffText.indexOf('\n@@', hunkStart);
				const hunkContent =
					hunkEnd === -1 ? diffText.slice(hunkStart) : diffText.slice(hunkStart, hunkEnd);

				const changes: Array<{ type: string; content: string; lineNumber: number }> = [];
				const lines = hunkContent.split('\n').filter((l) => l);
				let lineNum = parseInt(match[3], 10);

				for (const line of lines) {
					if (line.startsWith('+') && !line.startsWith('+++')) {
						changes.push({ type: 'insert', content: line.slice(1), lineNumber: lineNum++ });
					} else if (line.startsWith('-') && !line.startsWith('---')) {
						changes.push({ type: 'delete', content: line.slice(1), lineNumber: lineNum });
					} else if (!line.startsWith('\\')) {
						changes.push({ type: 'normal', content: line.slice(1), lineNumber: lineNum++ });
					}
				}

				hunks.push({
					content: match[0],
					oldStart: parseInt(match[1], 10),
					oldLines: parseInt(match[2] || '1', 10),
					newStart: parseInt(match[3], 10),
					newLines: parseInt(match[4] || '1', 10),
					changes,
				});
			}

			return [
				{
					type: 'modify',
					hunks,
				},
			];
		}
		return [];
	}),
}));

describe('gitDiffParser', () => {
	describe('parseGitDiff', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		describe('empty input handling', () => {
			it('returns empty array for undefined input', () => {
				const result = parseGitDiff(undefined as unknown as string);
				expect(result).toEqual([]);
			});

			it('returns empty array for null input', () => {
				const result = parseGitDiff(null as unknown as string);
				expect(result).toEqual([]);
			});

			it('returns empty array for empty string', () => {
				const result = parseGitDiff('');
				expect(result).toEqual([]);
			});

			it('returns empty array for whitespace-only string', () => {
				const result = parseGitDiff('   \n\t  \n  ');
				expect(result).toEqual([]);
			});
		});

		describe('single file diff parsing', () => {
			it('parses a simple single file diff', () => {
				const diffText = `diff --git a/src/test.ts b/src/test.ts
index 1234567..abcdefg 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 const foo = 1;
+const bar = 2;
 const baz = 3;`;

				const result = parseGitDiff(diffText);

				expect(result).toHaveLength(1);
				expect(result[0].oldPath).toBe('src/test.ts');
				expect(result[0].newPath).toBe('src/test.ts');
				expect(result[0].isBinary).toBe(false);
				expect(result[0].isImage).toBe(false);
				expect(result[0].isNewFile).toBe(false);
				expect(result[0].isDeletedFile).toBe(false);
				expect(result[0].diffText).toBe(diffText);
			});

			it('extracts correct file paths from diff header', () => {
				const diffText = `diff --git a/path/to/deep/file.js b/path/to/deep/file.js
--- a/path/to/deep/file.js
+++ b/path/to/deep/file.js
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				expect(result[0].oldPath).toBe('path/to/deep/file.js');
				expect(result[0].newPath).toBe('path/to/deep/file.js');
			});

			it('handles renamed files with different paths', () => {
				const diffText = `diff --git a/old/path.ts b/new/path.ts
similarity index 100%
rename from old/path.ts
rename to new/path.ts`;

				const result = parseGitDiff(diffText);

				expect(result[0].oldPath).toBe('old/path.ts');
				expect(result[0].newPath).toBe('new/path.ts');
			});
		});

		describe('multiple file diffs', () => {
			it('parses multiple files in a single diff', () => {
				const diffText = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old1
+new1
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old2
+new2
diff --git a/file3.ts b/file3.ts
--- a/file3.ts
+++ b/file3.ts
@@ -1 +1 @@
-old3
+new3`;

				const result = parseGitDiff(diffText);

				expect(result).toHaveLength(3);
				expect(result[0].newPath).toBe('file1.ts');
				expect(result[1].newPath).toBe('file2.ts');
				expect(result[2].newPath).toBe('file3.ts');
			});

			it('handles mixed file types in one diff', () => {
				const diffText = `diff --git a/code.ts b/code.ts
--- a/code.ts
+++ b/code.ts
@@ -1 +1 @@
-old
+new
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/new-file.js b/new-file.js
new file mode 100644
--- /dev/null
+++ b/new-file.js
@@ -0,0 +1 @@
+console.log('hello');`;

				const result = parseGitDiff(diffText);

				expect(result).toHaveLength(3);
				expect(result[0].isBinary).toBe(false);
				expect(result[0].isImage).toBe(false);
				expect(result[1].isBinary).toBe(true);
				expect(result[1].isImage).toBe(true);
				expect(result[2].isNewFile).toBe(true);
			});
		});

		describe('binary file detection', () => {
			it('detects binary files', () => {
				const diffText = `diff --git a/document.pdf b/document.pdf
Binary files a/document.pdf and b/document.pdf differ`;

				const result = parseGitDiff(diffText);

				expect(result[0].isBinary).toBe(true);
				expect(result[0].parsedDiff).toEqual([]);
			});

			it('detects binary files with new file mode', () => {
				const diffText = `diff --git a/archive.zip b/archive.zip
new file mode 100644
Binary files /dev/null and b/archive.zip differ`;

				const result = parseGitDiff(diffText);

				expect(result[0].isBinary).toBe(true);
				expect(result[0].isNewFile).toBe(true);
			});

			it('non-binary files are not marked as binary', () => {
				const diffText = `diff --git a/code.ts b/code.ts
--- a/code.ts
+++ b/code.ts
@@ -1 +1 @@
-const x = 1;
+const x = 2;`;

				const result = parseGitDiff(diffText);

				expect(result[0].isBinary).toBe(false);
			});
		});

		describe('image file detection', () => {
			const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];

			it.each(imageExtensions)('detects %s as image file', (ext) => {
				const diffText = `diff --git a/image.${ext} b/image.${ext}
Binary files a/image.${ext} and b/image.${ext} differ`;

				const result = parseGitDiff(diffText);

				expect(result[0].isImage).toBe(true);
			});

			it('handles uppercase image extensions', () => {
				const diffText = `diff --git a/image.PNG b/image.PNG
Binary files a/image.PNG and b/image.PNG differ`;

				const result = parseGitDiff(diffText);

				// Note: The code uses toLowerCase() on the extension
				expect(result[0].isImage).toBe(true);
			});

			it('does not mark non-image files as images', () => {
				const nonImageExtensions = ['ts', 'js', 'json', 'txt', 'md', 'pdf', 'zip'];

				for (const ext of nonImageExtensions) {
					const diffText = `diff --git a/file.${ext} b/file.${ext}
--- a/file.${ext}
+++ b/file.${ext}
@@ -1 +1 @@
-old
+new`;

					const result = parseGitDiff(diffText);
					expect(result[0].isImage).toBe(false);
				}
			});

			it('handles files without extensions', () => {
				const diffText = `diff --git a/Makefile b/Makefile
--- a/Makefile
+++ b/Makefile
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				expect(result[0].isImage).toBe(false);
			});

			it('handles files with only a dot (no extension)', () => {
				// This triggers the empty string fallback when pop() returns empty
				const diffText = `diff --git a/file. b/file.
--- a/file.
+++ b/file.
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				expect(result[0].isImage).toBe(false);
			});
		});

		describe('new file detection', () => {
			it('detects new file with "new file mode"', () => {
				const diffText = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+const x = 1;
+const y = 2;
+const z = 3;`;

				const result = parseGitDiff(diffText);

				expect(result[0].isNewFile).toBe(true);
				expect(result[0].isDeletedFile).toBe(false);
			});

			it('detects new file with /dev/null in old path', () => {
				const diffText = `diff --git a/created.ts b/created.ts
--- /dev/null
+++ b/created.ts
@@ -0,0 +1 @@
+content`;

				const result = parseGitDiff(diffText);

				expect(result[0].isNewFile).toBe(true);
			});
		});

		describe('deleted file detection', () => {
			it('detects deleted file with "deleted file mode"', () => {
				const diffText = `diff --git a/removed.ts b/removed.ts
deleted file mode 100644
index 1234567..0000000
--- a/removed.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1;
-const y = 2;
-const z = 3;`;

				const result = parseGitDiff(diffText);

				expect(result[0].isDeletedFile).toBe(true);
				expect(result[0].isNewFile).toBe(false);
			});

			it('detects deleted file with /dev/null in new path', () => {
				const diffText = `diff --git a/deleted.ts b/deleted.ts
--- a/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-content`;

				const result = parseGitDiff(diffText);

				expect(result[0].isDeletedFile).toBe(true);
			});
		});

		describe('path extraction edge cases', () => {
			it('handles paths with spaces', () => {
				// Note: Git escapes spaces in paths, but let's test the pattern
				const diffText = `diff --git a/path with spaces/file.ts b/path with spaces/file.ts
--- a/path with spaces/file.ts
+++ b/path with spaces/file.ts
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				// The regex matches up to the space after 'b/'
				expect(result[0].oldPath).toBe('path with spaces/file.ts');
				expect(result[0].newPath).toBe('path with spaces/file.ts');
			});

			it('returns "unknown" for malformed diff header', () => {
				const diffText = `diff --git malformed header
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				expect(result[0].oldPath).toBe('unknown');
				expect(result[0].newPath).toBe('unknown');
			});

			it('handles paths with special characters', () => {
				const diffText = `diff --git a/path/with-dashes_and_underscores.test.ts b/path/with-dashes_and_underscores.test.ts
--- a/path/with-dashes_and_underscores.test.ts
+++ b/path/with-dashes_and_underscores.test.ts
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				expect(result[0].oldPath).toBe('path/with-dashes_and_underscores.test.ts');
				expect(result[0].newPath).toBe('path/with-dashes_and_underscores.test.ts');
			});
		});

		describe('error handling', () => {
			it('handles parse errors gracefully', async () => {
				// Import the mock to manipulate it
				const { parseDiff } = await import('react-diff-view');
				vi.mocked(parseDiff).mockImplementationOnce(() => {
					throw new Error('Parse error');
				});

				// Spy on console.error
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				const diffText = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`;

				const result = parseGitDiff(diffText);

				expect(result).toHaveLength(1);
				expect(result[0].parsedDiff).toEqual([]);
				expect(result[0].oldPath).toBe('file.ts');
				expect(result[0].newPath).toBe('file.ts');
				expect(consoleSpy).toHaveBeenCalledWith('Failed to parse diff section:', expect.any(Error));

				consoleSpy.mockRestore();
			});

			it('preserves all metadata even when parsing fails', async () => {
				const { parseDiff } = await import('react-diff-view');
				vi.mocked(parseDiff).mockImplementationOnce(() => {
					throw new Error('Parse error');
				});

				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				const diffText = `diff --git a/image.png b/image.png
new file mode 100644
Binary files /dev/null and b/image.png differ`;

				const result = parseGitDiff(diffText);

				expect(result[0].isBinary).toBe(true);
				expect(result[0].isImage).toBe(true);
				expect(result[0].isNewFile).toBe(true);

				consoleSpy.mockRestore();
			});
		});

		describe('diffText preservation', () => {
			it('preserves the original diff text in the result', () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				const diffText = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,5 @@
 line1
-line2
+modified line2
 line3
 line4
 line5`;

				const result = parseGitDiff(diffText);

				expect(result[0].diffText).toBe(diffText);
				consoleSpy.mockRestore();
			});

			it('preserves individual diff sections for multiple files', () => {
				const section1 = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old1
+new1`;

				const section2 = `diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old2
+new2`;

				const diffText = `${section1}
${section2}`;

				const result = parseGitDiff(diffText);

				expect(result[0].diffText).toContain('file1.ts');
				expect(result[0].diffText).toContain('-old1');
				expect(result[0].diffText).toContain('+new1');

				expect(result[1].diffText).toContain('file2.ts');
				expect(result[1].diffText).toContain('-old2');
				expect(result[1].diffText).toContain('+new2');
			});
		});
	});

	describe('getFileName', () => {
		it('extracts filename from simple path', () => {
			expect(getFileName('src/utils/file.ts')).toBe('file.ts');
		});

		it('extracts filename from deep nested path', () => {
			expect(getFileName('a/b/c/d/e/f/file.ts')).toBe('file.ts');
		});

		it('returns the same string if no path separator', () => {
			expect(getFileName('file.ts')).toBe('file.ts');
		});

		it('handles paths with multiple dots', () => {
			expect(getFileName('path/to/file.test.spec.ts')).toBe('file.test.spec.ts');
		});

		it('handles paths ending with slash', () => {
			// Edge case - path ending with slash would have empty last segment
			expect(getFileName('path/to/directory/')).toBe('');
		});

		it('handles empty string', () => {
			expect(getFileName('')).toBe('');
		});

		it('handles single character filename', () => {
			expect(getFileName('path/to/x')).toBe('x');
		});

		it('handles filename with special characters', () => {
			expect(getFileName('path/to/[file].test.tsx')).toBe('[file].test.tsx');
		});

		it('handles paths with dashes and underscores', () => {
			expect(getFileName('my-folder/sub_folder/my-file_name.ts')).toBe('my-file_name.ts');
		});

		it('handles hidden files (starting with dot)', () => {
			expect(getFileName('path/to/.gitignore')).toBe('.gitignore');
		});

		it('handles hidden folders in path', () => {
			expect(getFileName('.config/settings/app.json')).toBe('app.json');
		});
	});

	describe('getDiffStats', () => {
		it('returns zeros for empty diff array', () => {
			const result = getDiffStats([]);
			expect(result).toEqual({ additions: 0, deletions: 0 });
		});

		it('counts insertions correctly', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,3 +1,5 @@',
							oldStart: 1,
							oldLines: 3,
							newStart: 1,
							newLines: 5,
							changes: [
								{ type: 'insert', content: 'new line 1', lineNumber: 1 },
								{ type: 'insert', content: 'new line 2', lineNumber: 2 },
								{ type: 'normal', content: 'unchanged', lineNumber: 3 },
							],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(2);
			expect(result.deletions).toBe(0);
		});

		it('counts deletions correctly', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,5 +1,3 @@',
							oldStart: 1,
							oldLines: 5,
							newStart: 1,
							newLines: 3,
							changes: [
								{ type: 'delete', content: 'removed line 1', lineNumber: 1 },
								{ type: 'delete', content: 'removed line 2', lineNumber: 2 },
								{ type: 'normal', content: 'unchanged', lineNumber: 3 },
							],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(0);
			expect(result.deletions).toBe(2);
		});

		it('counts both insertions and deletions', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,3 +1,4 @@',
							oldStart: 1,
							oldLines: 3,
							newStart: 1,
							newLines: 4,
							changes: [
								{ type: 'delete', content: 'old line', lineNumber: 1 },
								{ type: 'insert', content: 'new line', lineNumber: 1 },
								{ type: 'insert', content: 'another new', lineNumber: 2 },
								{ type: 'normal', content: 'unchanged', lineNumber: 3 },
							],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(2);
			expect(result.deletions).toBe(1);
		});

		it('handles multiple hunks in one file', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,3 +1,4 @@',
							changes: [{ type: 'insert', content: 'added', lineNumber: 1 }],
						},
						{
							content: '@@ -10,3 +11,2 @@',
							changes: [{ type: 'delete', content: 'removed', lineNumber: 10 }],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(1);
			expect(result.deletions).toBe(1);
		});

		it('handles multiple files in diff', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,2 +1,3 @@',
							changes: [
								{ type: 'insert', content: 'added1', lineNumber: 1 },
								{ type: 'insert', content: 'added2', lineNumber: 2 },
							],
						},
					],
				},
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,3 +1,1 @@',
							changes: [
								{ type: 'delete', content: 'deleted1', lineNumber: 1 },
								{ type: 'delete', content: 'deleted2', lineNumber: 2 },
								{ type: 'delete', content: 'deleted3', lineNumber: 3 },
							],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(2);
			expect(result.deletions).toBe(3);
		});

		it('ignores normal (context) lines', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,5 +1,5 @@',
							changes: [
								{ type: 'normal', content: 'context1', lineNumber: 1 },
								{ type: 'normal', content: 'context2', lineNumber: 2 },
								{ type: 'delete', content: 'old', lineNumber: 3 },
								{ type: 'insert', content: 'new', lineNumber: 3 },
								{ type: 'normal', content: 'context3', lineNumber: 4 },
							],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(1);
			expect(result.deletions).toBe(1);
		});

		it('handles empty hunks array', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result).toEqual({ additions: 0, deletions: 0 });
		});

		it('handles empty changes array', () => {
			const parsedDiff = [
				{
					type: 'modify',
					hunks: [
						{
							content: '@@ -1,1 +1,1 @@',
							changes: [],
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result).toEqual({ additions: 0, deletions: 0 });
		});

		it('handles large diffs', () => {
			const changes: Array<{ type: string; content: string; lineNumber: number }> = [];
			for (let i = 0; i < 1000; i++) {
				changes.push({ type: 'insert', content: `line ${i}`, lineNumber: i });
			}

			const parsedDiff = [
				{
					type: 'add',
					hunks: [
						{
							content: '@@ -0,0 +1,1000 @@',
							changes,
						},
					],
				},
			];

			const result = getDiffStats(parsedDiff as any);

			expect(result.additions).toBe(1000);
			expect(result.deletions).toBe(0);
		});
	});
});
