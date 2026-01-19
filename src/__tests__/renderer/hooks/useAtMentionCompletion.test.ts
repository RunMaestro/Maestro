import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAtMentionCompletion,
	type AtMentionSuggestion,
	type UseAtMentionCompletionReturn,
} from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Creates a minimal mock Session with just the fields needed for useAtMentionCompletion
 */
function createMockSession(fileTree: FileNode[] | null = []): Session {
	return {
		id: 'test-session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: fileTree as any[],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
	};
}

/**
 * Creates a file node
 */
function createFile(name: string): FileNode {
	return { name, type: 'file' };
}

/**
 * Creates a folder node with optional children
 */
function createFolder(name: string, children: FileNode[] = []): FileNode {
	return { name, type: 'folder', children };
}

// =============================================================================
// INTERFACE TYPE TESTS
// =============================================================================

describe('useAtMentionCompletion', () => {
	describe('interface types', () => {
		it('AtMentionSuggestion has correct structure', () => {
			const suggestion: AtMentionSuggestion = {
				value: 'src/index.ts',
				type: 'file',
				displayText: 'index.ts',
				fullPath: 'src/index.ts',
				score: 100,
			};

			expect(suggestion.value).toBe('src/index.ts');
			expect(suggestion.type).toBe('file');
			expect(suggestion.displayText).toBe('index.ts');
			expect(suggestion.fullPath).toBe('src/index.ts');
			expect(suggestion.score).toBe(100);
		});

		it('UseAtMentionCompletionReturn has getSuggestions function', () => {
			const session = createMockSession([]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			expect(result.current).toHaveProperty('getSuggestions');
			expect(typeof result.current.getSuggestions).toBe('function');
		});
	});

	// =============================================================================
	// HOOK INITIALIZATION TESTS
	// =============================================================================

	describe('hook initialization', () => {
		it('returns getSuggestions function', () => {
			const session = createMockSession([]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			expect(result.current.getSuggestions).toBeDefined();
			expect(typeof result.current.getSuggestions).toBe('function');
		});

		it('getSuggestions has stable reference across re-renders when session does not change', () => {
			const session = createMockSession([createFile('test.ts')]);
			const { result, rerender } = renderHook(() => useAtMentionCompletion(session));

			const firstRef = result.current.getSuggestions;
			rerender();
			const secondRef = result.current.getSuggestions;

			expect(firstRef).toBe(secondRef);
		});

		it('getSuggestions updates when session changes', () => {
			const session1 = createMockSession([createFile('test.ts')]);
			const session2 = createMockSession([createFile('other.ts')]);

			const { result, rerender } = renderHook(({ session }) => useAtMentionCompletion(session), {
				initialProps: { session: session1 },
			});

			const firstSuggestions = result.current.getSuggestions('test');
			expect(firstSuggestions.length).toBe(1);
			expect(firstSuggestions[0].displayText).toBe('test.ts');

			rerender({ session: session2 });

			const secondSuggestions = result.current.getSuggestions('other');
			expect(secondSuggestions.length).toBe(1);
			expect(secondSuggestions[0].displayText).toBe('other.ts');
		});

		it('allFiles memo updates when session.fileTree changes', () => {
			const session = createMockSession([createFile('file1.ts')]);
			const { result, rerender } = renderHook(({ s }) => useAtMentionCompletion(s), {
				initialProps: { s: session },
			});

			expect(result.current.getSuggestions('').length).toBe(1);

			// Create new session with different fileTree
			const updatedSession = createMockSession([createFile('file1.ts'), createFile('file2.ts')]);
			rerender({ s: updatedSession });

			expect(result.current.getSuggestions('').length).toBe(2);
		});
	});

	// =============================================================================
	// NULL/EDGE CASE TESTS
	// =============================================================================

	describe('null/edge cases', () => {
		it('null session returns empty array', () => {
			const { result } = renderHook(() => useAtMentionCompletion(null));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions).toEqual([]);
		});

		it('session without fileTree returns empty array', () => {
			const session = createMockSession(null);
			(session as any).fileTree = undefined;
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('test');
			expect(suggestions).toEqual([]);
		});

		it('session with empty fileTree array returns empty array', () => {
			const session = createMockSession([]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions).toEqual([]);
		});

		it('session with null fileTree returns empty array', () => {
			const session = createMockSession(null);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('anything');
			expect(suggestions).toEqual([]);
		});
	});

	// =============================================================================
	// FILE TREE TRAVERSAL TESTS
	// =============================================================================

	describe('file tree traversal', () => {
		it('processes single file at root', () => {
			const session = createMockSession([createFile('index.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(1);
			expect(suggestions[0].displayText).toBe('index.ts');
			expect(suggestions[0].fullPath).toBe('index.ts');
		});

		it('processes single folder at root', () => {
			const session = createMockSession([createFolder('src')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(1);
			expect(suggestions[0].displayText).toBe('src');
			expect(suggestions[0].type).toBe('folder');
		});

		it('processes multiple files at root', () => {
			const session = createMockSession([
				createFile('index.ts'),
				createFile('app.tsx'),
				createFile('utils.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(3);
			const names = suggestions.map((s) => s.displayText);
			expect(names).toContain('index.ts');
			expect(names).toContain('app.tsx');
			expect(names).toContain('utils.ts');
		});

		it('processes nested files (1 level deep)', () => {
			const session = createMockSession([createFolder('src', [createFile('index.ts')])]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(2); // folder + nested file

			const indexSuggestion = suggestions.find((s) => s.displayText === 'index.ts');
			expect(indexSuggestion).toBeDefined();
			expect(indexSuggestion!.fullPath).toBe('src/index.ts');
		});

		it('processes deeply nested files (3+ levels)', () => {
			const session = createMockSession([
				createFolder('src', [
					createFolder('components', [
						createFolder('Button', [createFile('index.tsx'), createFile('Button.styles.ts')]),
					]),
				]),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			// src, components, Button (folders) + index.tsx, Button.styles.ts (files)
			expect(suggestions.length).toBe(5);

			const indexSuggestion = suggestions.find((s) => s.displayText === 'index.tsx');
			expect(indexSuggestion).toBeDefined();
			expect(indexSuggestion!.fullPath).toBe('src/components/Button/index.tsx');
		});

		it('builds correct paths for nested items', () => {
			const session = createMockSession([
				createFolder('level1', [createFolder('level2', [createFile('deep.ts')])]),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');

			const level1 = suggestions.find((s) => s.displayText === 'level1');
			const level2 = suggestions.find((s) => s.displayText === 'level2');
			const deep = suggestions.find((s) => s.displayText === 'deep.ts');

			expect(level1!.fullPath).toBe('level1');
			expect(level2!.fullPath).toBe('level1/level2');
			expect(deep!.fullPath).toBe('level1/level2/deep.ts');
		});

		it('handles mixed files and folders', () => {
			const session = createMockSession([
				createFile('README.md'),
				createFolder('src', [createFile('app.ts')]),
				createFile('package.json'),
				createFolder('docs'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(5); // 3 files + 2 folders

			const files = suggestions.filter((s) => s.type === 'file');
			const folders = suggestions.filter((s) => s.type === 'folder');

			expect(files.length).toBe(3);
			expect(folders.length).toBe(2);
		});

		it('handles folder without children', () => {
			const session = createMockSession([createFolder('empty-folder')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(1);
			expect(suggestions[0].displayText).toBe('empty-folder');
			expect(suggestions[0].type).toBe('folder');
		});

		it('handles folder with undefined children', () => {
			const folder: FileNode = { name: 'folder', type: 'folder' };
			const session = createMockSession([folder]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(1);
		});
	});

	// =============================================================================
	// GETSUGESTIONS - EMPTY FILTER TESTS
	// =============================================================================

	describe('getSuggestions - empty filter', () => {
		it('returns all files when filter is empty string', () => {
			const session = createMockSession([
				createFile('a.ts'),
				createFile('b.ts'),
				createFile('c.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(3);
		});

		it('returns all folders when filter is empty string', () => {
			const session = createMockSession([
				createFolder('src'),
				createFolder('lib'),
				createFolder('tests'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(3);
		});

		it('maintains sort order with empty filter', () => {
			const session = createMockSession([
				createFile('charlie.ts'),
				createFile('alpha.ts'),
				createFile('bravo.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			// With empty filter, scores are 0, so sorted alphabetically
			expect(suggestions[0].displayText).toBe('alpha.ts');
			expect(suggestions[1].displayText).toBe('bravo.ts');
			expect(suggestions[2].displayText).toBe('charlie.ts');
		});
	});

	// =============================================================================
	// GETSUGESTIONS - FILTER MATCHING TESTS
	// =============================================================================

	describe('getSuggestions - filter matching', () => {
		it('matches exact filename', () => {
			const session = createMockSession([createFile('index.ts'), createFile('other.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('index.ts');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('index.ts');
		});

		it('matches partial filename', () => {
			const session = createMockSession([createFile('index.ts'), createFile('utils.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('ind');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('index.ts');
		});

		it('matches by file extension', () => {
			const session = createMockSession([
				createFile('app.tsx'),
				createFile('index.ts'),
				createFile('style.css'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('.tsx');
			const tsxFiles = suggestions.filter((s) => s.displayText.endsWith('.tsx'));
			expect(tsxFiles.length).toBeGreaterThan(0);
		});

		it('matches by path component', () => {
			const session = createMockSession([
				createFolder('components', [createFile('Button.tsx')]),
				createFolder('utils', [createFile('helpers.ts')]),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('components');
			expect(suggestions.length).toBeGreaterThan(0);
			// The folder and its contents should be found
			const componentResults = suggestions.filter((s) => s.fullPath.includes('components'));
			expect(componentResults.length).toBeGreaterThan(0);
		});

		it('matches nested file by name', () => {
			const session = createMockSession([
				createFolder('src', [createFolder('components', [createFile('Button.tsx')])]),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('Button');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('Button.tsx');
			expect(suggestions[0].fullPath).toBe('src/components/Button.tsx');
		});

		it('returns empty array for no matches', () => {
			const session = createMockSession([createFile('index.ts'), createFile('app.tsx')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('xyznonexistent');
			expect(suggestions.length).toBe(0);
		});

		it('matches are case insensitive (from fuzzyMatchWithScore)', () => {
			const session = createMockSession([createFile('MyComponent.tsx'), createFile('other.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			// Search lowercase should find PascalCase file
			const suggestions = result.current.getSuggestions('mycomponent');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('MyComponent.tsx');
		});

		it('matches folder names', () => {
			const session = createMockSession([createFolder('components'), createFolder('services')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('comp');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('components');
		});
	});

	// =============================================================================
	// GETSUGESTIONS - SCORING TESTS
	// =============================================================================

	describe('getSuggestions - scoring', () => {
		it('uses name match score when better than path', () => {
			const session = createMockSession([createFolder('utils', [createFile('test.ts')])]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			// 'test' should match file name directly (better than matching path)
			const suggestions = result.current.getSuggestions('test');
			expect(suggestions[0].displayText).toBe('test.ts');
		});

		it('uses path match score when better than name', () => {
			const session = createMockSession([
				createFolder('utils', [createFile('index.ts')]),
				createFile('main.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			// 'utils/index' should match the nested file by path
			const suggestions = result.current.getSuggestions('utils/index');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].fullPath).toBe('utils/index.ts');
		});

		it('exact match scores higher than partial', () => {
			const session = createMockSession([
				createFile('index.ts'),
				createFile('indexer.ts'),
				createFile('main-index.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('index');
			// 'index.ts' should be first as it's an exact prefix match
			expect(suggestions[0].displayText).toBe('index.ts');
		});

		it('scores are numeric', () => {
			const session = createMockSession([createFile('test.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('test');
			expect(typeof suggestions[0].score).toBe('number');
			expect(suggestions[0].score).toBeGreaterThan(0);
		});
	});

	// =============================================================================
	// GETSUGESTIONS - SORTING TESTS
	// =============================================================================

	describe('getSuggestions - sorting', () => {
		it('sorts by score descending', () => {
			const session = createMockSession([
				createFile('abc.ts'),
				createFile('ab.ts'),
				createFile('a.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('a');
			// All match 'a', but 'a.ts' should score highest as shortest match
			// Scores decrease as filename length increases with same prefix
			for (let i = 0; i < suggestions.length - 1; i++) {
				expect(suggestions[i].score).toBeGreaterThanOrEqual(suggestions[i + 1].score);
			}
		});

		it('same score: files sorted before folders', () => {
			// Note: The actual implementation sorts files before folders when scores are EQUAL
			// We test the sorting logic by verifying that when we have a file and folder
			// with similar match scores, the file appears first
			const session = createMockSession([
				createFolder('test'),
				createFile('test'), // File without extension, same name as folder
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('test');
			expect(suggestions.length).toBe(2);

			// Both should match 'test' with similar scores (exact match)
			// When scores are equal, files should come before folders
			const fileIndex = suggestions.findIndex((s) => s.type === 'file');
			const folderIndex = suggestions.findIndex((s) => s.type === 'folder');

			// Verify both exist and file comes first when scores match
			expect(fileIndex).toBeDefined();
			expect(folderIndex).toBeDefined();
			// Since they have identical names ('test'), scores should be equal
			// and file should come first
			expect(suggestions[0].displayText).toBe('test');
			expect(fileIndex).toBeLessThan(folderIndex);
		});

		it('same score and type: alphabetical by displayText', () => {
			const session = createMockSession([
				createFile('charlie.ts'),
				createFile('alpha.ts'),
				createFile('bravo.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('.ts');
			// All have similar score for .ts extension match
			// When scores are similar and types same, sort alphabetically
			const names = suggestions.map((s) => s.displayText);
			const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
			expect(names).toEqual(sortedNames);
		});

		it('complex sorting with mixed types and scores', () => {
			const session = createMockSession([
				createFolder('test'),
				createFile('test.ts'),
				createFile('testing.ts'),
				createFolder('testing'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('test');
			expect(suggestions.length).toBe(4);

			// Higher scores first, then files before folders, then alphabetical
			// Verify general sorting pattern
			for (let i = 0; i < suggestions.length - 1; i++) {
				const current = suggestions[i];
				const next = suggestions[i + 1];

				if (current.score !== next.score) {
					expect(current.score).toBeGreaterThanOrEqual(next.score);
				}
			}
		});
	});

	// =============================================================================
	// GETSUGESTIONS - RESULT LIMIT TESTS
	// =============================================================================

	describe('getSuggestions - result limit', () => {
		it('returns at most 15 results', () => {
			// Create 20 files
			const files: FileNode[] = [];
			for (let i = 0; i < 20; i++) {
				files.push(createFile(`file${i.toString().padStart(2, '0')}.ts`));
			}
			const session = createMockSession(files);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(15);
		});

		it('keeps highest scored items when limiting', () => {
			// Create more than 15 files that all match the filter
			// Use a filter that will match all files
			const files: FileNode[] = [];
			// Create files with 'file' prefix - all will match 'file' filter
			files.push(createFile('file.ts')); // Best match (shortest)
			files.push(createFile('file0.ts')); // Good match
			for (let i = 1; i <= 20; i++) {
				files.push(createFile(`file${i.toString().padStart(2, '0')}.ts`));
			}
			const session = createMockSession(files);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('file');
			// All files match, so we get exactly 15 (the limit)
			expect(suggestions.length).toBe(15);
			// Best match (file.ts - shortest, exact prefix) should be first
			expect(suggestions[0].displayText).toBe('file.ts');
		});

		it('respects limit with empty filter', () => {
			const files: FileNode[] = [];
			for (let i = 0; i < 30; i++) {
				files.push(createFile(`file${i}.ts`));
			}
			const session = createMockSession(files);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(15);
		});
	});

	// =============================================================================
	// SUGGESTION STRUCTURE TESTS
	// =============================================================================

	describe('suggestion structure', () => {
		it('value equals fullPath for files', () => {
			const session = createMockSession([createFolder('src', [createFile('index.ts')])]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('index');
			const fileSuggestion = suggestions.find((s) => s.type === 'file');
			expect(fileSuggestion).toBeDefined();
			expect(fileSuggestion!.value).toBe(fileSuggestion!.fullPath);
		});

		it('value equals fullPath for folders', () => {
			const session = createMockSession([createFolder('components')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			const folderSuggestion = suggestions.find((s) => s.type === 'folder');
			expect(folderSuggestion).toBeDefined();
			expect(folderSuggestion!.value).toBe(folderSuggestion!.fullPath);
		});

		it('displayText is filename only (not path)', () => {
			const session = createMockSession([
				createFolder('very', [
					createFolder('deep', [createFolder('nested', [createFile('myfile.ts')])]),
				]),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('myfile');
			expect(suggestions[0].displayText).toBe('myfile.ts');
			expect(suggestions[0].fullPath).toBe('very/deep/nested/myfile.ts');
		});

		it('type is "file" for files', () => {
			const session = createMockSession([createFile('test.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions[0].type).toBe('file');
		});

		it('type is "folder" for folders', () => {
			const session = createMockSession([createFolder('testfolder')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions[0].type).toBe('folder');
		});

		it('score is a number', () => {
			const session = createMockSession([createFile('test.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('test');
			expect(typeof suggestions[0].score).toBe('number');
			expect(Number.isFinite(suggestions[0].score)).toBe(true);
		});

		it('all suggestion fields are defined', () => {
			const session = createMockSession([createFolder('src', [createFile('app.tsx')])]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			for (const suggestion of suggestions) {
				expect(suggestion.value).toBeDefined();
				expect(suggestion.type).toBeDefined();
				expect(suggestion.displayText).toBeDefined();
				expect(suggestion.fullPath).toBeDefined();
				expect(suggestion.score).toBeDefined();
			}
		});
	});

	// =============================================================================
	// MEMOIZATION BEHAVIOR TESTS
	// =============================================================================

	describe('memoization behavior', () => {
		it('allFiles recomputes when fileTree changes', () => {
			const session1 = createMockSession([createFile('old.ts')]);
			const { result, rerender } = renderHook(({ s }) => useAtMentionCompletion(s), {
				initialProps: { s: session1 },
			});

			let suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(1);
			expect(suggestions[0].displayText).toBe('old.ts');

			// Change fileTree
			const session2 = createMockSession([createFile('new1.ts'), createFile('new2.ts')]);
			rerender({ s: session2 });

			suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(2);
			expect(suggestions.map((s) => s.displayText)).toContain('new1.ts');
			expect(suggestions.map((s) => s.displayText)).toContain('new2.ts');
		});

		it('getSuggestions is stable when session does not change', () => {
			const session = createMockSession([createFile('stable.ts')]);
			const { result, rerender } = renderHook(() => useAtMentionCompletion(session));

			const firstFn = result.current.getSuggestions;
			rerender();
			const secondFn = result.current.getSuggestions;

			expect(firstFn).toBe(secondFn);
		});

		it('handles rapid session changes', () => {
			const { result, rerender } = renderHook(({ s }) => useAtMentionCompletion(s), {
				initialProps: { s: createMockSession([createFile('a.ts')]) },
			});

			// Rapidly change sessions
			for (let i = 0; i < 10; i++) {
				const newSession = createMockSession([createFile(`file${i}.ts`)]);
				rerender({ s: newSession });
			}

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(1);
			expect(suggestions[0].displayText).toBe('file9.ts');
		});
	});

	// =============================================================================
	// EDGE CASES AND SPECIAL SCENARIOS
	// =============================================================================

	describe('edge cases and special scenarios', () => {
		it('handles files with special characters in names', () => {
			const session = createMockSession([
				createFile('file-with-dashes.ts'),
				createFile('file_with_underscores.ts'),
				createFile('file.multiple.dots.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(3);
		});

		it('handles deeply nested structure efficiently', () => {
			// Create a deeply nested structure
			let tree: FileNode = createFile('leaf.ts');
			for (let i = 10; i >= 0; i--) {
				tree = createFolder(`level${i}`, [tree]);
			}
			const session = createMockSession([tree]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('leaf');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('leaf.ts');
			expect(suggestions[0].fullPath).toContain('level0/level1');
		});

		it('handles empty folder name', () => {
			const session = createMockSession([createFolder('', [createFile('test.ts')])]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('test');
			expect(suggestions.length).toBeGreaterThan(0);
		});

		it('handles files with no extension', () => {
			const session = createMockSession([
				createFile('Makefile'),
				createFile('README'),
				createFile('Dockerfile'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('Make');
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions[0].displayText).toBe('Makefile');
		});

		it('handles unicode characters in filenames', () => {
			const session = createMockSession([createFile('日本語.ts'), createFile('émoji.ts')]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('');
			expect(suggestions.length).toBe(2);
		});

		it('returns consistent results for same input', () => {
			const session = createMockSession([
				createFile('alpha.ts'),
				createFile('beta.ts'),
				createFile('gamma.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions1 = result.current.getSuggestions('');
			const suggestions2 = result.current.getSuggestions('');

			expect(suggestions1).toEqual(suggestions2);
		});

		it('handles filter with spaces', () => {
			const session = createMockSession([
				createFile('file with spaces.ts'),
				createFile('nospace.ts'),
			]);
			const { result } = renderHook(() => useAtMentionCompletion(session));

			const suggestions = result.current.getSuggestions('with spaces');
			// Should find the file with spaces in name
			const matchingFiles = suggestions.filter((s) => s.displayText.includes('spaces'));
			expect(matchingFiles.length).toBeGreaterThan(0);
		});
	});
});
