// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/existingDocsDetector.test.ts
// Source: src/__tests__/renderer/utils/gitChangeMap.test.ts
// Source: src/__tests__/renderer/utils/gitDiffParser.test.ts
// Source: src/__tests__/renderer/utils/groupChatStatus.test.ts
// Source: src/__tests__/renderer/utils/ids.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getAutoRunFolderPath,
	hasExistingAutoRunDocs,
	getExistingAutoRunDocs,
	getExistingAutoRunDocsCount,
	ExistingDocument,
} from '../../../renderer/utils/existingDocsDetector';
import { PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import {
	classifyGitStatus,
	buildFileChangeMap,
	buildChangedAncestors,
} from '../../../renderer/utils/gitChangeMap';
import type { GitFileChange } from '../../../renderer/hooks';
import { logger } from '../../../renderer/utils/logger';
import {
	parseGitDiff,
	buildSyntheticGitDiff,
	getFileName,
	getDiffStats,
	ParsedFileDiff,
} from '../../../renderer/utils/gitDiffParser';
import {
	describeGroupChatRunState,
	getBusyGroupChatIds,
	getGroupChatRunState,
	isGroupChatBusy,
	type GroupChatBusySnapshot,
} from '../../../renderer/utils/groupChatStatus';
import { generateId } from '../../../renderer/utils/ids';
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
				changes: Array<{
					type: string;
					content: string;
					lineNumber: number;
				}>;
			}> = [];
			// Extract hunks from diff text
			const hunkMatches = diffText.matchAll(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@[^\n]*/g);
			for (const match of hunkMatches) {
				const hunkStart = match.index! + match[0].length;
				const hunkEnd = diffText.indexOf('\n@@', hunkStart);
				const hunkContent =
					hunkEnd === -1 ? diffText.slice(hunkStart) : diffText.slice(hunkStart, hunkEnd);
				const changes: Array<{
					type: string;
					content: string;
					lineNumber: number;
				}> = [];
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
// Source: src/__tests__/renderer/utils/existingDocsDetector.test.ts
describe('', () => {
	// Mock window.maestro.autorun API
	const mockAutorunApi = {
		listDocs: vi.fn(),
	};
	// Store original window.maestro
	const originalMaestro = (global as any).window?.maestro;
	describe('existingDocsDetector', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			// Setup window.maestro mock
			(global as any).window = {
				maestro: {
					autorun: mockAutorunApi,
				},
			};
		});
		afterEach(() => {
			// Restore original window.maestro if it existed
			if (originalMaestro) {
				(global as any).window = { maestro: originalMaestro };
			} else {
				delete (global as any).window;
			}
		});
		describe('PLAYBOOKS_DIR', () => {
			it('equals ".maestro/playbooks"', () => {
				expect(PLAYBOOKS_DIR).toBe('.maestro/playbooks');
			});
		});
		describe('getAutoRunFolderPath', () => {
			it('appends playbooks folder to project path', () => {
				const result = getAutoRunFolderPath('/path/to/project');
				expect(result).toBe('/path/to/project/.maestro/playbooks');
			});
			it('handles trailing slash in project path', () => {
				const result = getAutoRunFolderPath('/path/to/project/');
				expect(result).toBe('/path/to/project/.maestro/playbooks');
			});
			it('handles empty path', () => {
				const result = getAutoRunFolderPath('');
				expect(result).toBe('/.maestro/playbooks');
			});
			it('handles home directory paths', () => {
				const result = getAutoRunFolderPath('/Users/user/Projects/myapp');
				expect(result).toBe('/Users/user/Projects/myapp/.maestro/playbooks');
			});
			it('handles Windows-style paths', () => {
				const result = getAutoRunFolderPath('C:/Users/user/Projects');
				expect(result).toBe('C:/Users/user/Projects/.maestro/playbooks');
			});
		});
		describe('hasExistingAutoRunDocs', () => {
			it('returns true when documents exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2', 'roadmap'],
				});
				const result = await hasExistingAutoRunDocs('/path/to/project');
				expect(result).toBe(true);
				expect(mockAutorunApi.listDocs).toHaveBeenCalledWith('/path/to/project/.maestro/playbooks');
			});
			it('returns false when no documents exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: [],
				});
				const result = await hasExistingAutoRunDocs('/path/to/project');
				expect(result).toBe(false);
			});
			it('returns false when folder does not exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: false,
					error: 'ENOENT: no such file or directory',
				});
				const result = await hasExistingAutoRunDocs('/path/to/project');
				expect(result).toBe(false);
			});
			it('returns false when API throws an error', async () => {
				mockAutorunApi.listDocs.mockRejectedValue(new Error('Permission denied'));
				const result = await hasExistingAutoRunDocs('/path/to/project');
				expect(result).toBe(false);
			});
			it('returns true for single document', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['single-doc'],
				});
				const result = await hasExistingAutoRunDocs('/path/to/project');
				expect(result).toBe(true);
			});
			it('handles paths with trailing slash', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['doc1'],
				});
				const result = await hasExistingAutoRunDocs('/path/to/project/');
				expect(result).toBe(true);
				expect(mockAutorunApi.listDocs).toHaveBeenCalledWith('/path/to/project/.maestro/playbooks');
			});
		});
		describe('getExistingAutoRunDocs', () => {
			it('returns documents with correct structure', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2'],
				});
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toHaveLength(2);
				expect(result[0]).toEqual({
					name: 'phase-1',
					filename: 'phase-1.md',
					path: '/path/to/project/.maestro/playbooks/phase-1.md',
				});
				expect(result[1]).toEqual({
					name: 'phase-2',
					filename: 'phase-2.md',
					path: '/path/to/project/.maestro/playbooks/phase-2.md',
				});
			});
			it('returns empty array when no documents exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: [],
				});
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toEqual([]);
			});
			it('returns empty array when folder does not exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: false,
					error: 'ENOENT: no such file or directory',
				});
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toEqual([]);
			});
			it('returns empty array when API throws an error', async () => {
				mockAutorunApi.listDocs.mockRejectedValue(new Error('Network error'));
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toEqual([]);
			});
			it('handles single document', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['roadmap'],
				});
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toHaveLength(1);
				expect(result[0].name).toBe('roadmap');
				expect(result[0].filename).toBe('roadmap.md');
			});
			it('handles documents with special characters in names', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['phase-1 (draft)', 'feature-add-user-auth'],
				});
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toHaveLength(2);
				expect(result[0].name).toBe('phase-1 (draft)');
				expect(result[0].filename).toBe('phase-1 (draft).md');
			});
			it('returns empty array when files is undefined', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					// files is undefined
				});
				const result = await getExistingAutoRunDocs('/path/to/project');
				expect(result).toEqual([]);
			});
		});
		describe('getExistingAutoRunDocsCount', () => {
			it('returns correct count for multiple documents', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2', 'phase-3', 'roadmap'],
				});
				const result = await getExistingAutoRunDocsCount('/path/to/project');
				expect(result).toBe(4);
			});
			it('returns 0 when no documents exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: [],
				});
				const result = await getExistingAutoRunDocsCount('/path/to/project');
				expect(result).toBe(0);
			});
			it('returns 0 when folder does not exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: false,
					error: 'ENOENT: no such file or directory',
				});
				const result = await getExistingAutoRunDocsCount('/path/to/project');
				expect(result).toBe(0);
			});
			it('returns 0 when API throws an error', async () => {
				mockAutorunApi.listDocs.mockRejectedValue(new Error('Timeout'));
				const result = await getExistingAutoRunDocsCount('/path/to/project');
				expect(result).toBe(0);
			});
			it('returns 1 for single document', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['only-doc'],
				});
				const result = await getExistingAutoRunDocsCount('/path/to/project');
				expect(result).toBe(1);
			});
			it('returns 0 when files is undefined', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					// files is undefined
				});
				const result = await getExistingAutoRunDocsCount('/path/to/project');
				expect(result).toBe(0);
			});
		});
		describe('type exports', () => {
			it('ExistingDocument interface has correct shape', () => {
				const doc: ExistingDocument = {
					name: 'test',
					filename: 'test.md',
					path: '/path/to/test.md',
				};
				expect(doc.name).toBe('test');
				expect(doc.filename).toBe('test.md');
				expect(doc.path).toBe('/path/to/test.md');
			});
		});
		describe('integration scenarios', () => {
			it('handles project with many documents', async () => {
				const manyFiles = Array.from({ length: 100 }, (_, i) => `document-${i + 1}`);
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: manyFiles,
				});
				const hasDocsResult = await hasExistingAutoRunDocs('/project');
				const countResult = await getExistingAutoRunDocsCount('/project');
				const docsResult = await getExistingAutoRunDocs('/project');
				expect(hasDocsResult).toBe(true);
				expect(countResult).toBe(100);
				expect(docsResult).toHaveLength(100);
			});
			it('consistent behavior across all functions when folder is empty', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: [],
				});
				const hasDocsResult = await hasExistingAutoRunDocs('/project');
				const countResult = await getExistingAutoRunDocsCount('/project');
				const docsResult = await getExistingAutoRunDocs('/project');
				expect(hasDocsResult).toBe(false);
				expect(countResult).toBe(0);
				expect(docsResult).toEqual([]);
			});
			it('consistent behavior across all functions when folder does not exist', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: false,
					error: 'ENOENT',
				});
				const hasDocsResult = await hasExistingAutoRunDocs('/project');
				const countResult = await getExistingAutoRunDocsCount('/project');
				const docsResult = await getExistingAutoRunDocs('/project');
				expect(hasDocsResult).toBe(false);
				expect(countResult).toBe(0);
				expect(docsResult).toEqual([]);
			});
			it('uses correct folder path for real project paths', async () => {
				mockAutorunApi.listDocs.mockResolvedValue({
					success: true,
					files: ['doc'],
				});
				await hasExistingAutoRunDocs('/Users/developer/Projects/my-awesome-app');
				expect(mockAutorunApi.listDocs).toHaveBeenCalledWith(
					'/Users/developer/Projects/my-awesome-app/.maestro/playbooks'
				);
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/gitChangeMap.test.ts
describe('', () => {
	describe('classifyGitStatus', () => {
		// `useGitStatusPolling` stores `file.status.trim()` on GitFileChange, so the
		// trimmed forms below are what callers see in production. The function also
		// accepts the raw 2-char porcelain codes (covered separately below).
		it('maps untracked files to added', () => {
			expect(classifyGitStatus('??')).toBe('added');
		});
		it('maps modified-in-worktree (trimmed " M" → "M") to modified', () => {
			expect(classifyGitStatus('M')).toBe('modified');
		});
		it('maps modified-in-index ("M") to modified', () => {
			expect(classifyGitStatus('M')).toBe('modified');
		});
		it('maps added-in-index (trimmed "A " → "A") to added', () => {
			expect(classifyGitStatus('A')).toBe('added');
		});
		it('maps deleted-in-worktree (trimmed " D" → "D") to deleted', () => {
			expect(classifyGitStatus('D')).toBe('deleted');
		});
		it('treats added-then-deleted ("AD") as deleted (file is gone on disk)', () => {
			expect(classifyGitStatus('AD')).toBe('deleted');
		});
		it('treats renamed (trimmed "R " → "R") as modified', () => {
			expect(classifyGitStatus('R')).toBe('modified');
		});
		it('treats merge conflicts (UU) as modified', () => {
			expect(classifyGitStatus('UU')).toBe('modified');
		});
		it('falls back to modified for unknown codes', () => {
			expect(classifyGitStatus('XY')).toBe('modified');
		});
		it('accepts raw untrimmed porcelain codes the same as trimmed ones', () => {
			// Defensive: callers shouldn't need to remember whether their producer
			// trimmed the status; both forms classify identically.
			expect(classifyGitStatus(' M')).toBe('modified');
			expect(classifyGitStatus('M ')).toBe('modified');
			expect(classifyGitStatus(' D')).toBe('deleted');
			expect(classifyGitStatus('A ')).toBe('added');
			expect(classifyGitStatus(' ??')).toBe('added');
		});
	});
	describe('buildFileChangeMap', () => {
		const mkChange = (path: string, status: string): GitFileChange => ({
			path,
			status,
			additions: 0,
			deletions: 0,
			modified: false,
		});
		it('returns an empty map for undefined input', () => {
			expect(buildFileChangeMap(undefined).size).toBe(0);
		});
		it('returns an empty map for empty input', () => {
			expect(buildFileChangeMap([]).size).toBe(0);
		});
		it('keys by full relative path and classifies each entry (trimmed codes as produced by useGitStatusPolling)', () => {
			const map = buildFileChangeMap([
				mkChange('src/index.ts', 'M'),
				mkChange('README.md', '??'),
				mkChange('old.txt', 'D'),
			]);
			expect(map.get('src/index.ts')).toBe('modified');
			expect(map.get('README.md')).toBe('added');
			expect(map.get('old.txt')).toBe('deleted');
			expect(map.size).toBe(3);
		});
		it('skips entries with empty paths', () => {
			expect(buildFileChangeMap([mkChange('', 'M')]).size).toBe(0);
		});
	});
	describe('buildChangedAncestors', () => {
		it('returns an empty set for empty input', () => {
			expect(buildChangedAncestors([]).size).toBe(0);
		});
		it('collects every directory ancestor for each changed path', () => {
			const ancestors = buildChangedAncestors(['src/foo/bar.ts', 'docs/index.md']);
			expect(ancestors.has('src')).toBe(true);
			expect(ancestors.has('src/foo')).toBe(true);
			expect(ancestors.has('docs')).toBe(true);
			// Leaf files themselves are NOT ancestors.
			expect(ancestors.has('src/foo/bar.ts')).toBe(false);
			expect(ancestors.has('docs/index.md')).toBe(false);
		});
		it('handles top-level files (no ancestors)', () => {
			const ancestors = buildChangedAncestors(['package.json']);
			expect(ancestors.size).toBe(0);
		});
		it('deduplicates shared ancestors', () => {
			const ancestors = buildChangedAncestors(['src/a.ts', 'src/b.ts', 'src/nested/c.ts']);
			expect(ancestors.has('src')).toBe(true);
			expect(ancestors.has('src/nested')).toBe(true);
			expect(ancestors.size).toBe(2);
		});
		it('ignores empty paths', () => {
			expect(buildChangedAncestors(['']).size).toBe(0);
		});
	});
});
// Source: src/__tests__/renderer/utils/gitDiffParser.test.ts
describe('', () => {
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
					const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
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
					expect(consoleSpy).toHaveBeenCalledWith(
						'Failed to parse diff section:',
						undefined,
						expect.any(Error)
					);
					consoleSpy.mockRestore();
				});
				it('preserves all metadata even when parsing fails', async () => {
					const { parseDiff } = await import('react-diff-view');
					vi.mocked(parseDiff).mockImplementationOnce(() => {
						throw new Error('Parse error');
					});
					const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
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
					const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
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
				const changes: Array<{
					type: string;
					content: string;
					lineNumber: number;
				}> = [];
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
	describe('buildSyntheticGitDiff', () => {
		it('prefixes a git header parseGitDiff can split on, followed by the unified patch', () => {
			const diff = buildSyntheticGitDiff('prompt.md', 'a\nold\n', 'a\nnew\n');
			expect(diff.startsWith('diff --git a/prompt.md b/prompt.md\n')).toBe(true);
			expect(diff).toContain('-old');
			expect(diff).toContain('+new');
			expect(diff).toContain('@@');
		});
	});
});
// Source: src/__tests__/renderer/utils/groupChatStatus.test.ts
describe('', () => {
	const CHATS = [{ id: 'gc-1' }, { id: 'gc-2' }, { id: 'gc-3' }];
	describe('groupChatStatus', () => {
		it('treats an idle snapshot as not busy', () => {
			expect(isGroupChatBusy('gc-1', {})).toBe(false);
			expect(getBusyGroupChatIds(CHATS, {})).toEqual([]);
		});
		it('reads the active room from the active-chat fields, not the maps', () => {
			const snapshot: GroupChatBusySnapshot = {
				activeGroupChatId: 'gc-1',
				groupChatState: 'moderator-thinking',
				// Stale map entry for the active room - the live fields must win.
				groupChatStates: new Map([['gc-1', 'idle']]),
			};
			expect(isGroupChatBusy('gc-1', snapshot)).toBe(true);
		});
		it('reads non-active rooms from the all-chats maps', () => {
			const snapshot: GroupChatBusySnapshot = {
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChatStates: new Map([['gc-2', 'agent-working']]),
			};
			expect(isGroupChatBusy('gc-2', snapshot)).toBe(true);
			expect(isGroupChatBusy('gc-3', snapshot)).toBe(false);
		});
		it('counts a working participant even when the moderator is idle', () => {
			const snapshot: GroupChatBusySnapshot = {
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				participantStates: new Map([
					['Atlas', 'idle'],
					['Nova', 'working'],
				]),
				allGroupChatParticipantStates: new Map([
					['gc-2', new Map([['Orion', 'working'] as const])],
				]),
			};
			expect(getGroupChatRunState('gc-1', snapshot).workingParticipants).toEqual(['Nova']);
			expect(getBusyGroupChatIds(CHATS, snapshot)).toEqual(['gc-1', 'gc-2']);
		});
		it('ignores busy map entries for rooms the caller no longer knows about', () => {
			const snapshot: GroupChatBusySnapshot = {
				groupChatStates: new Map([['deleted-chat', 'agent-working']]),
			};
			expect(getBusyGroupChatIds(CHATS, snapshot)).toEqual([]);
		});
		it('describes what is running', () => {
			expect(
				describeGroupChatRunState({
					moderatorState: 'moderator-thinking',
					workingParticipants: [],
					isBusy: true,
				})
			).toBe('Moderator thinking');
			expect(
				describeGroupChatRunState({
					moderatorState: 'agent-working',
					workingParticipants: ['Atlas', 'Nova'],
					isBusy: true,
				})
			).toBe('Atlas, Nova working');
			expect(
				describeGroupChatRunState({
					moderatorState: 'agent-working',
					workingParticipants: ['Atlas', 'Nova', 'Orion'],
					isBusy: true,
				})
			).toBe('3 agents working');
			// Dispatched but the per-agent state has not landed yet.
			expect(
				describeGroupChatRunState({
					moderatorState: 'agent-working',
					workingParticipants: [],
					isBusy: true,
				})
			).toBe('Working');
		});
	});
});
// Source: src/__tests__/renderer/utils/ids.test.ts
describe('', () => {
	describe('generateId', () => {
		it('should generate a valid UUID v4', () => {
			const id = generateId();
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			expect(id).toMatch(uuidRegex);
		});
		it('should generate unique IDs', () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				ids.add(generateId());
			}
			expect(ids.size).toBe(100);
		});
		it('should use crypto.randomUUID', () => {
			const mockUUID = '12345678-1234-4123-8123-123456789abc';
			const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID);
			expect(generateId()).toBe(mockUUID);
			expect(spy).toHaveBeenCalled();
			spy.mockRestore();
		});
	});
});
