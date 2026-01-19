import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useTabCompletion,
	TabCompletionSuggestion,
	TabCompletionFilter,
} from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';

// Helper to create a minimal session for testing
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'test-session',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/project',
		projectRoot: '/project',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		isLive: false,
		isNew: false,
		scrollPosition: 0,
		inputHistory: [],
		inputHistoryIndex: -1,
		shellCommandHistory: [],
		shellCwd: '/project',
		...overrides,
	}) as Session;

// Helper to create a file tree
const createFileTree = (): FileNode[] => [
	{
		name: 'src',
		type: 'folder',
		children: [
			{
				name: 'components',
				type: 'folder',
				children: [
					{ name: 'Button.tsx', type: 'file' },
					{ name: 'Input.tsx', type: 'file' },
					{ name: 'Modal.tsx', type: 'file' },
				],
			},
			{
				name: 'hooks',
				type: 'folder',
				children: [
					{ name: 'useSettings.ts', type: 'file' },
					{ name: 'useTabCompletion.ts', type: 'file' },
				],
			},
			{ name: 'index.ts', type: 'file' },
		],
	},
	{ name: 'package.json', type: 'file' },
	{ name: 'README.md', type: 'file' },
	{
		name: 'tests',
		type: 'folder',
		children: [{ name: 'unit', type: 'folder', children: [{ name: 'test1.ts', type: 'file' }] }],
	},
];

describe('useTabCompletion', () => {
	describe('hook initialization', () => {
		it('returns getSuggestions function', () => {
			const session = createMockSession();
			const { result } = renderHook(() => useTabCompletion(session));

			expect(result.current.getSuggestions).toBeInstanceOf(Function);
		});

		it('handles null session', () => {
			const { result } = renderHook(() => useTabCompletion(null));

			expect(result.current.getSuggestions).toBeInstanceOf(Function);
			expect(result.current.getSuggestions('test')).toEqual([]);
		});
	});

	describe('getSuggestions - basic behavior', () => {
		it('returns empty array for empty input', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status', 'npm install'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			expect(result.current.getSuggestions('')).toEqual([]);
		});

		it('returns empty array for whitespace-only input', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status', 'npm install'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			expect(result.current.getSuggestions('   ')).toEqual([]);
		});

		it('returns empty array when session is null', () => {
			const { result } = renderHook(() => useTabCompletion(null));

			expect(result.current.getSuggestions('git')).toEqual([]);
		});
	});

	describe('getSuggestions - shell history', () => {
		it('matches history commands that start with input (filter: all)', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status', 'git commit', 'npm install', 'git push'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git');
			const historySuggestions = suggestions.filter((s) => s.type === 'history');

			expect(historySuggestions).toHaveLength(3);
			expect(historySuggestions.map((s) => s.value)).toContain('git status');
			expect(historySuggestions.map((s) => s.value)).toContain('git commit');
			expect(historySuggestions.map((s) => s.value)).toContain('git push');
		});

		it('matches history commands that contain input (filter: history)', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status', 'npm install', 'yarn add git-hooks'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git', 'history');
			const historySuggestions = suggestions.filter((s) => s.type === 'history');

			expect(historySuggestions).toHaveLength(2);
			expect(historySuggestions.map((s) => s.value)).toContain('git status');
			expect(historySuggestions.map((s) => s.value)).toContain('yarn add git-hooks');
		});

		it('shows all history items when filter is history and input is empty-ish', () => {
			const session = createMockSession({
				shellCommandHistory: ['command1', 'command2', 'command3'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			// With filter: history, empty string-like match shows all
			// Actually need some input to pass the empty check - let's use a space-separated
			const suggestions = result.current.getSuggestions('c', 'history');

			expect(suggestions.filter((s) => s.type === 'history').length).toBeGreaterThan(0);
		});

		it('is case-insensitive for history matching', () => {
			const session = createMockSession({
				shellCommandHistory: ['GIT STATUS', 'git commit'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git');
			const historySuggestions = suggestions.filter((s) => s.type === 'history');

			expect(historySuggestions).toHaveLength(2);
		});

		it('deduplicates history entries', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status', 'git status', 'git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git');
			const historySuggestions = suggestions.filter((s) => s.type === 'history');

			expect(historySuggestions).toHaveLength(1);
		});
	});

	describe('getSuggestions - git branches', () => {
		it('includes branch suggestions when in git repo', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main', 'feature/test', 'develop'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout m');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');

			expect(branchSuggestions.length).toBeGreaterThan(0);
			expect(branchSuggestions.some((s) => s.displayText === 'main')).toBe(true);
		});

		it('does not include branches when not in git repo', () => {
			const session = createMockSession({
				isGitRepo: false,
				gitBranches: ['main', 'develop'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout m');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');

			expect(branchSuggestions).toHaveLength(0);
		});

		it('filters branches by last word in input', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main', 'master', 'develop', 'feature-x'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ma');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');

			expect(branchSuggestions).toHaveLength(2);
			expect(branchSuggestions.map((s) => s.displayText)).toContain('main');
			expect(branchSuggestions.map((s) => s.displayText)).toContain('master');
		});

		it('builds full value with prefix for branches', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout m');
			const branchSuggestion = suggestions.find(
				(s) => s.type === 'branch' && s.displayText === 'main'
			);

			expect(branchSuggestion?.value).toBe('git checkout main');
		});

		it('shows all branches when last part is empty', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main', 'develop'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			// Input ends with space means last part is empty
			const suggestions = result.current.getSuggestions('git checkout ');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');

			expect(branchSuggestions).toHaveLength(2);
		});

		it('respects branch filter', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main', 'develop'],
				gitTags: ['v1.0.0'],
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ', 'branch');

			expect(suggestions.every((s) => s.type === 'branch')).toBe(true);
		});
	});

	describe('getSuggestions - git tags', () => {
		it('includes tag suggestions when in git repo', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitTags: ['v1.0.0', 'v1.1.0', 'v2.0.0'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout v1');
			const tagSuggestions = suggestions.filter((s) => s.type === 'tag');

			expect(tagSuggestions.length).toBeGreaterThan(0);
			expect(tagSuggestions.some((s) => s.displayText === 'v1.0.0')).toBe(true);
			expect(tagSuggestions.some((s) => s.displayText === 'v1.1.0')).toBe(true);
		});

		it('does not include tags when not in git repo', () => {
			const session = createMockSession({
				isGitRepo: false,
				gitTags: ['v1.0.0'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout v');
			const tagSuggestions = suggestions.filter((s) => s.type === 'tag');

			expect(tagSuggestions).toHaveLength(0);
		});

		it('filters tags by last word', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitTags: ['v1.0.0', 'v2.0.0', 'release-1.0'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout v');
			const tagSuggestions = suggestions.filter((s) => s.type === 'tag');

			expect(tagSuggestions).toHaveLength(2);
			expect(tagSuggestions.map((s) => s.displayText)).not.toContain('release-1.0');
		});

		it('builds full value with prefix for tags', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitTags: ['v1.0.0'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout v');
			const tagSuggestion = suggestions.find((s) => s.type === 'tag');

			expect(tagSuggestion?.value).toBe('git checkout v1.0.0');
		});

		it('respects tag filter', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				gitTags: ['v1.0.0', 'v2.0.0'],
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ', 'tag');

			expect(suggestions.every((s) => s.type === 'tag')).toBe(true);
		});
	});

	describe('getSuggestions - file completion', () => {
		it('suggests files matching the input at root level', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat p');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file');

			expect(fileSuggestions.some((s) => s.displayText === 'package.json')).toBe(true);
		});

		it('suggests folders with trailing slash', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cd s');
			const folderSuggestions = suggestions.filter((s) => s.type === 'folder');

			expect(folderSuggestions.some((s) => s.value.endsWith('/'))).toBe(true);
			expect(folderSuggestions.some((s) => s.displayText === 'src/')).toBe(true);
		});

		it('quotes paths that contain spaces', () => {
			const session = createMockSession({
				fileTree: [{ name: 'Auto Run Docs', type: 'folder', children: [] }],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('mv Scripts/Loop/ A');
			const folderSuggestion = suggestions.find((s) => s.type === 'folder');

			expect(folderSuggestion?.displayText).toBe('"Auto Run Docs/"');
			expect(folderSuggestion?.value).toBe('mv Scripts/Loop/ "Auto Run Docs/"');
		});

		it('handles path-based completion (cd src/c)', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cd src/c');
			const folderSuggestions = suggestions.filter((s) => s.type === 'folder');

			expect(folderSuggestions.some((s) => s.displayText === 'src/components/')).toBe(true);
		});

		it('handles ./ prefix in paths', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat ./p');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file');

			expect(fileSuggestions.some((s) => s.displayText === './package.json')).toBe(true);
			// fullValue = 'cat ./package.json' (prefix + completedPathWithPrefix)
			expect(fileSuggestions.some((s) => s.value === 'cat ./package.json')).toBe(true);
		});

		it('handles ./ alone as root', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls ./');

			// Should show root level items
			expect(suggestions.some((s) => s.displayText.includes('src/'))).toBe(true);
		});

		it('handles . alone as root', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls .');

			// With "." it might not match much, but should not throw
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('only shows immediate children in path completion', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			// When looking in src/, should only show components/, hooks/, index.ts
			// Not src/components/Button.tsx
			const suggestions = result.current.getSuggestions('ls src/');
			const fileAndFolderSuggestions = suggestions.filter(
				(s) => s.type === 'file' || s.type === 'folder'
			);

			// Should have immediate children
			expect(fileAndFolderSuggestions.some((s) => s.displayText.includes('components/'))).toBe(
				true
			);
			expect(fileAndFolderSuggestions.some((s) => s.displayText.includes('hooks/'))).toBe(true);
			expect(fileAndFolderSuggestions.some((s) => s.displayText.includes('index.ts'))).toBe(true);

			// Should NOT have nested children
			expect(fileAndFolderSuggestions.some((s) => s.displayText.includes('Button.tsx'))).toBe(
				false
			);
		});

		it('respects file filter', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				shellCommandHistory: ['git status'],
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat ', 'file');

			// Should only have file/folder types, no history or branches
			expect(suggestions.every((s) => s.type === 'file' || s.type === 'folder')).toBe(true);
		});

		it('is case-insensitive for file matching', () => {
			const session = createMockSession({
				fileTree: [{ name: 'README.md', type: 'file' }],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat read');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file');

			expect(fileSuggestions.some((s) => s.displayText === 'README.md')).toBe(true);
		});
	});

	describe('getSuggestions - shell relative path handling', () => {
		it('uses full tree when shell is at project root', () => {
			const session = createMockSession({
				cwd: '/project',
				shellCwd: '/project',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls s');
			const folderSuggestions = suggestions.filter((s) => s.type === 'folder');

			expect(folderSuggestions.some((s) => s.displayText === 'src/')).toBe(true);
		});

		it('filters tree when shell is in subdirectory', () => {
			const session = createMockSession({
				cwd: '/project',
				shellCwd: '/project/src',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls c');
			const folderSuggestions = suggestions.filter((s) => s.type === 'folder');

			// From src/, should see components/ and hooks/ (both start with 'c' or 'h')
			// Actually 'c' only matches components
			expect(folderSuggestions.some((s) => s.displayText === 'components/')).toBe(true);
		});

		it('returns empty files when shell is outside project', () => {
			const session = createMockSession({
				cwd: '/project',
				shellCwd: '/other/path',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls s');
			const fileAndFolderSuggestions = suggestions.filter(
				(s) => s.type === 'file' || s.type === 'folder'
			);

			expect(fileAndFolderSuggestions).toHaveLength(0);
		});

		it('handles missing cwd gracefully', () => {
			const session = createMockSession({
				cwd: undefined as any,
				shellCwd: '/project/src',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls s');
			// Should not throw
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles missing shellCwd gracefully', () => {
			const session = createMockSession({
				cwd: '/project',
				shellCwd: undefined as any,
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls s');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('returns empty when subdirectory not found in tree', () => {
			const session = createMockSession({
				cwd: '/project',
				shellCwd: '/project/nonexistent',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls s');
			const fileAndFolderSuggestions = suggestions.filter(
				(s) => s.type === 'file' || s.type === 'folder'
			);

			expect(fileAndFolderSuggestions).toHaveLength(0);
		});

		it('handles trailing slashes in paths', () => {
			const session = createMockSession({
				cwd: '/project/',
				shellCwd: '/project/',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls s');
			const folderSuggestions = suggestions.filter((s) => s.type === 'folder');

			expect(folderSuggestions.some((s) => s.displayText === 'src/')).toBe(true);
		});

		it('handles deep nested shell directory', () => {
			const session = createMockSession({
				cwd: '/project',
				shellCwd: '/project/src/components',
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat B');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file');

			expect(fileSuggestions.some((s) => s.displayText === 'Button.tsx')).toBe(true);
		});
	});

	describe('getSuggestions - sorting', () => {
		it('sorts by type: history, branch, tag, folder, file', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				gitTags: ['v1.0.0'],
				shellCommandHistory: ['make build'],
				fileTree: [
					{ name: 'Makefile', type: 'file' },
					{ name: 'modules', type: 'folder', children: [] },
				],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('m');
			const types = suggestions.map((s) => s.type);

			// History should come first
			const historyIndex = types.indexOf('history');
			const branchIndex = types.indexOf('branch');
			const tagIndex = types.indexOf('tag');
			const folderIndex = types.indexOf('folder');
			const fileIndex = types.indexOf('file');

			// Each type that exists should be before the next type
			if (historyIndex !== -1 && branchIndex !== -1) {
				expect(historyIndex).toBeLessThan(branchIndex);
			}
			if (branchIndex !== -1 && tagIndex !== -1) {
				expect(branchIndex).toBeLessThan(tagIndex);
			}
			if (tagIndex !== -1 && folderIndex !== -1) {
				expect(tagIndex).toBeLessThan(folderIndex);
			}
			if (folderIndex !== -1 && fileIndex !== -1) {
				expect(folderIndex).toBeLessThan(fileIndex);
			}
		});

		it('sorts alphabetically within same type', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['zebra', 'alpha', 'beta'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');
			const branchTexts = branchSuggestions.map((s) => s.displayText);

			// Should be alphabetical
			expect(branchTexts).toEqual(['alpha', 'beta', 'zebra']);
		});
	});

	describe('getSuggestions - limit and deduplication', () => {
		it('limits results to 15 suggestions', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: Array.from({ length: 20 }, (_, i) => `branch-${i}`),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout branch');

			expect(suggestions.length).toBeLessThanOrEqual(15);
		});

		it('deduplicates across all sources', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				shellCommandHistory: ['git checkout main'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout main');
			const uniqueValues = new Set(suggestions.map((s) => s.value));

			expect(uniqueValues.size).toBe(suggestions.length);
		});
	});

	describe('getSuggestions - filter parameter', () => {
		it('filter: all returns all types', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				gitTags: ['v1.0.0'],
				shellCommandHistory: ['history command'],
				fileTree: [{ name: 'file.txt', type: 'file' }],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('h', 'all');
			const types = new Set(suggestions.map((s) => s.type));

			// With 'all' filter, should have history at least
			expect(types.has('history')).toBe(true);
		});

		it('filter: history returns only history', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('g', 'history');

			expect(suggestions.every((s) => s.type === 'history')).toBe(true);
		});

		it('filter: branch returns only branches', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main', 'develop'],
				gitTags: ['v1.0.0'],
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ', 'branch');

			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions.every((s) => s.type === 'branch')).toBe(true);
		});

		it('filter: tag returns only tags', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				gitTags: ['v1.0.0', 'v2.0.0'],
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ', 'tag');

			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions.every((s) => s.type === 'tag')).toBe(true);
		});

		it('filter: file returns only files and folders', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				shellCommandHistory: ['git status'],
				fileTree: [
					{ name: 'src', type: 'folder', children: [] },
					{ name: 'package.json', type: 'file' },
				],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat ', 'file');

			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions.every((s) => s.type === 'file' || s.type === 'folder')).toBe(true);
		});

		it('defaults to all when filter not specified', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
				shellCommandHistory: ['make build'],
				fileTree: [{ name: 'Makefile', type: 'file' }],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestionsNoFilter = result.current.getSuggestions('m');
			const suggestionsAllFilter = result.current.getSuggestions('m', 'all');

			// Should behave the same
			expect(suggestionsNoFilter.length).toBe(suggestionsAllFilter.length);
		});
	});

	describe('edge cases', () => {
		it('handles empty file tree', () => {
			const session = createMockSession({
				fileTree: [],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls ');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles undefined file tree', () => {
			const session = createMockSession({
				fileTree: undefined as any,
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('ls ');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles empty shell history', () => {
			const session = createMockSession({
				shellCommandHistory: [],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git');
			const historySuggestions = suggestions.filter((s) => s.type === 'history');

			expect(historySuggestions).toHaveLength(0);
		});

		it('handles undefined shell history', () => {
			const session = createMockSession({
				shellCommandHistory: undefined as any,
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles empty git branches', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: [],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');

			expect(branchSuggestions).toHaveLength(0);
		});

		it('handles undefined git branches', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: undefined as any,
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles empty git tags', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitTags: [],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout ');
			const tagSuggestions = suggestions.filter((s) => s.type === 'tag');

			expect(tagSuggestions).toHaveLength(0);
		});

		it('handles special characters in file names', () => {
			const session = createMockSession({
				fileTree: [
					{ name: 'file-with-dash.ts', type: 'file' },
					{ name: 'file_with_underscore.ts', type: 'file' },
					{ name: 'file.multiple.dots.ts', type: 'file' },
				],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat file');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file');

			expect(fileSuggestions).toHaveLength(3);
		});

		it('handles special characters in branch names', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['feature/test', 'fix/bug-123', 'release-v1.0'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout f');
			const branchSuggestions = suggestions.filter((s) => s.type === 'branch');

			expect(branchSuggestions.length).toBeGreaterThan(0);
		});

		it('handles input with multiple spaces', () => {
			const session = createMockSession({
				shellCommandHistory: ['git  commit -m "message"'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git  c');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles input with leading/trailing spaces', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			// trim() is called, so leading space alone shouldn't matter
			// But note: input.trim() is checked, so ' ' becomes ''
			const suggestions = result.current.getSuggestions(' git');
			expect(Array.isArray(suggestions)).toBe(true);
		});

		it('handles deeply nested path completion', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat src/components/B');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file');

			expect(fileSuggestions.some((s) => s.displayText.includes('Button.tsx'))).toBe(true);
		});

		it('handles folder without children property', () => {
			const session = createMockSession({
				fileTree: [
					{ name: 'empty-folder', type: 'folder' }, // no children property
				],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cd e');
			const folderSuggestions = suggestions.filter((s) => s.type === 'folder');

			expect(folderSuggestions.some((s) => s.displayText === 'empty-folder/')).toBe(true);
		});

		it('handles non-matching path prefix', () => {
			const session = createMockSession({
				fileTree: createFileTree(),
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat nonexistent/path/');
			const fileSuggestions = suggestions.filter((s) => s.type === 'file' || s.type === 'folder');

			// Should return empty since path doesn't exist
			expect(fileSuggestions).toHaveLength(0);
		});
	});

	describe('suggestion structure', () => {
		it('history suggestions have correct structure', () => {
			const session = createMockSession({
				shellCommandHistory: ['git status'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git');
			const historySuggestion = suggestions.find((s) => s.type === 'history');

			expect(historySuggestion).toMatchObject({
				value: 'git status',
				type: 'history',
				displayText: 'git status',
			});
		});

		it('branch suggestions have correct structure', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitBranches: ['main'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout m');
			const branchSuggestion = suggestions.find((s) => s.type === 'branch');

			expect(branchSuggestion).toMatchObject({
				value: 'git checkout main',
				type: 'branch',
				displayText: 'main',
			});
		});

		it('tag suggestions have correct structure', () => {
			const session = createMockSession({
				isGitRepo: true,
				gitTags: ['v1.0.0'],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('git checkout v');
			const tagSuggestion = suggestions.find((s) => s.type === 'tag');

			expect(tagSuggestion).toMatchObject({
				value: 'git checkout v1.0.0',
				type: 'tag',
				displayText: 'v1.0.0',
			});
		});

		it('file suggestions have correct structure', () => {
			const session = createMockSession({
				fileTree: [{ name: 'README.md', type: 'file' }],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cat R');
			const fileSuggestion = suggestions.find((s) => s.type === 'file');

			expect(fileSuggestion).toMatchObject({
				value: 'cat README.md',
				type: 'file',
				displayText: 'README.md',
			});
		});

		it('folder suggestions have trailing slash in value and displayText', () => {
			const session = createMockSession({
				fileTree: [{ name: 'src', type: 'folder', children: [] }],
			});
			const { result } = renderHook(() => useTabCompletion(session));

			const suggestions = result.current.getSuggestions('cd s');
			const folderSuggestion = suggestions.find((s) => s.type === 'folder');

			expect(folderSuggestion?.value).toBe('cd src/');
			expect(folderSuggestion?.displayText).toBe('src/');
		});
	});

	describe('memoization behavior', () => {
		it('maintains stable getSuggestions reference when session does not change', () => {
			const session = createMockSession();
			const { result, rerender } = renderHook(() => useTabCompletion(session));

			const firstRef = result.current.getSuggestions;

			// Rerender with same session
			rerender();

			const secondRef = result.current.getSuggestions;

			expect(firstRef).toBe(secondRef);
		});

		it('updates getSuggestions when session changes', () => {
			let session = createMockSession({
				shellCommandHistory: ['command1'],
			});
			const { result, rerender } = renderHook(({ s }) => useTabCompletion(s), {
				initialProps: { s: session },
			});

			const firstResult = result.current.getSuggestions('command');

			// Change session
			session = createMockSession({
				shellCommandHistory: ['command1', 'command2'],
			});
			rerender({ s: session });

			const secondResult = result.current.getSuggestions('command');

			// Results should differ because history changed
			expect(secondResult.length).not.toBe(firstResult.length);
		});
	});

	describe('TypeScript types', () => {
		it('TabCompletionSuggestion type has correct shape', () => {
			const suggestion: TabCompletionSuggestion = {
				value: 'test',
				type: 'history',
				displayText: 'test',
			};

			expect(suggestion.value).toBeDefined();
			expect(suggestion.type).toBeDefined();
			expect(suggestion.displayText).toBeDefined();
		});

		it('TabCompletionFilter accepts valid values', () => {
			const filters: TabCompletionFilter[] = ['all', 'history', 'branch', 'tag', 'file'];

			expect(filters.length).toBe(5);
		});
	});
});
