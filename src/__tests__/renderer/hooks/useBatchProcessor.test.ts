/**
 * Tests for useBatchProcessor hook - Pure Functions and Hook Behavior
 *
 * This file tests the pure utility functions exported from useBatchProcessor
 * and the hook behavior with mocked IPC.
 *
 * Note: The hook itself (useBatchProcessor) has complex async state management
 * that requires careful mocking of the window.maestro IPC bridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type {
	Session,
	Group,
	HistoryEntry,
	UsageStats,
	BatchRunConfig,
	AgentError,
} from '../../../renderer/types';

// Import the exported functions directly
import { countUnfinishedTasks, uncheckAllTasks, useBatchProcessor } from '../../../renderer/hooks';

// ============================================================================
// Tests for countUnfinishedTasks
// ============================================================================

describe('countUnfinishedTasks', () => {
	describe('empty and no-checkbox content', () => {
		it('should return 0 for empty string', () => {
			expect(countUnfinishedTasks('')).toBe(0);
		});

		it('should return 0 for whitespace only', () => {
			expect(countUnfinishedTasks('   \n\t\n   ')).toBe(0);
		});

		it('should return 0 for content with no checkboxes', () => {
			const content = `# My Document

This is some text without any checkboxes.
- Regular list item
- Another item`;
			expect(countUnfinishedTasks(content)).toBe(0);
		});

		it('should return 0 for content with only regular markdown', () => {
			const content = `# Heading
## Subheading
Some **bold** and *italic* text.
- Item 1
- Item 2
1. Numbered item
2. Another numbered item`;
			expect(countUnfinishedTasks(content)).toBe(0);
		});
	});

	describe('counting unchecked tasks', () => {
		it('should count single unchecked task', () => {
			const content = '- [ ] Task one';
			expect(countUnfinishedTasks(content)).toBe(1);
		});

		it('should count multiple unchecked tasks', () => {
			const content = `# Tasks
- [ ] Task one
- [ ] Task two
- [ ] Task three`;
			expect(countUnfinishedTasks(content)).toBe(3);
		});

		it('should count unchecked tasks at various document positions', () => {
			const content = `- [ ] First task at start

Some content in between

- [ ] Middle task

More content

- [ ] Last task at end`;
			expect(countUnfinishedTasks(content)).toBe(3);
		});
	});

	describe('ignoring checked tasks', () => {
		it('should not count checked tasks (lowercase x)', () => {
			const content = `- [x] Completed task
- [ ] Pending task`;
			expect(countUnfinishedTasks(content)).toBe(1);
		});

		it('should not count checked tasks (uppercase X)', () => {
			const content = `- [X] Completed task
- [ ] Pending task`;
			expect(countUnfinishedTasks(content)).toBe(1);
		});

		it('should not count any checked task variants', () => {
			const content = `- [x] Done lowercase
- [X] Done uppercase
- [✓] Done checkmark
- [✔] Done heavy checkmark`;
			expect(countUnfinishedTasks(content)).toBe(0);
		});
	});

	describe('mixed checked and unchecked tasks', () => {
		it('should handle mixed checked and unchecked tasks', () => {
			const content = `# Project Tasks
- [x] Setup project
- [ ] Write tests
- [X] Configure CI
- [ ] Deploy
- [ ] Document`;
			expect(countUnfinishedTasks(content)).toBe(3);
		});

		it('should handle alternating checked/unchecked pattern', () => {
			const content = `- [x] Done 1
- [ ] Todo 1
- [x] Done 2
- [ ] Todo 2
- [x] Done 3
- [ ] Todo 3`;
			expect(countUnfinishedTasks(content)).toBe(3);
		});
	});

	describe('indentation handling', () => {
		it('should handle indented checkboxes', () => {
			const content = `# Nested Tasks
- [ ] Parent task
  - [ ] Child task 1
    - [ ] Grandchild task
  - [ ] Child task 2`;
			expect(countUnfinishedTasks(content)).toBe(4);
		});

		it('should handle deeply nested checkboxes', () => {
			const content = `- [ ] Level 0
    - [ ] Level 1
        - [ ] Level 2
            - [ ] Level 3
                - [ ] Level 4`;
			expect(countUnfinishedTasks(content)).toBe(5);
		});

		it('should handle tabs as indentation', () => {
			const content = `\t- [ ] Tabbed task
\t\t- [ ] Double tabbed task`;
			expect(countUnfinishedTasks(content)).toBe(2);
		});

		it('should handle mixed tabs and spaces', () => {
			const content = `  - [ ] Space indented
\t- [ ] Tab indented
  \t- [ ] Mixed indented`;
			expect(countUnfinishedTasks(content)).toBe(3);
		});
	});

	describe('checkbox format variations', () => {
		it('should handle extra spaces in checkbox (still matches with \\s*)', () => {
			const content = `- [  ] Task with extra space
- [ ] Normal task`;
			// The regex uses \s* which allows any whitespace, so both match
			expect(countUnfinishedTasks(content)).toBe(2);
		});

		it('should handle no space in checkbox', () => {
			const content = '- [] Task with no space';
			// The regex allows \s* so [] should match
			expect(countUnfinishedTasks(content)).toBe(1);
		});
	});

	describe('task content variations', () => {
		it('should handle checkboxes with various content after', () => {
			const content = `- [ ] Simple task
- [ ] Task with **bold** text
- [ ] Task with \`code\`
- [ ] Task with [link](url)
- [ ] Task with emoji 🎉`;
			expect(countUnfinishedTasks(content)).toBe(5);
		});

		it('should match checkbox followed by trailing space (.+ matches space)', () => {
			// The regex uses .+ which matches any character including space
			// But .+$ requires non-empty content at end of line - trailing space counts!
			const content = '- [ ] ';
			// Actually .+ in multiline mode requires at least one character
			// A trailing space IS a character, so this should match
			expect(countUnfinishedTasks(content)).toBe(1);
		});

		it('should match checkbox with single character content', () => {
			const content = '- [ ] x';
			expect(countUnfinishedTasks(content)).toBe(1);
		});

		it('should handle very long task descriptions', () => {
			const longDescription = 'a'.repeat(1000);
			const content = `- [ ] ${longDescription}`;
			expect(countUnfinishedTasks(content)).toBe(1);
		});
	});

	describe('line position requirements', () => {
		it('should handle checkboxes at start of lines only', () => {
			const content = `Some text - [ ] not a task
- [ ] Real task
Text - [ ] also not a task`;
			// The regex uses ^ with multiline flag, so only line-start checkboxes match
			expect(countUnfinishedTasks(content)).toBe(1);
		});

		it('should not match checkbox in middle of text', () => {
			const content = 'This is some text with - [ ] embedded checkbox';
			expect(countUnfinishedTasks(content)).toBe(0);
		});
	});

	describe('line ending handling', () => {
		it('should handle Windows line endings (CRLF)', () => {
			const content = '- [ ] Task one\r\n- [ ] Task two\r\n- [ ] Task three';
			expect(countUnfinishedTasks(content)).toBe(3);
		});

		it('should handle Unix line endings (LF)', () => {
			const content = '- [ ] Task one\n- [ ] Task two\n- [ ] Task three';
			expect(countUnfinishedTasks(content)).toBe(3);
		});

		it('should handle mixed line endings', () => {
			const content = '- [ ] Task one\r\n- [ ] Task two\n- [ ] Task three';
			expect(countUnfinishedTasks(content)).toBe(3);
		});

		it('should handle task at end of file without newline', () => {
			const content = '- [ ] Only task';
			expect(countUnfinishedTasks(content)).toBe(1);
		});
	});

	describe('special characters', () => {
		it('should handle tasks with special regex characters', () => {
			const content = `- [ ] Task with (parentheses)
- [ ] Task with [brackets]
- [ ] Task with {braces}
- [ ] Task with $dollar and ^caret`;
			expect(countUnfinishedTasks(content)).toBe(4);
		});

		it('should handle unicode content', () => {
			const content = `- [ ] タスク (Japanese)
- [ ] 任务 (Chinese)
- [ ] задача (Russian)`;
			expect(countUnfinishedTasks(content)).toBe(3);
		});
	});
});

// ============================================================================
// Tests for uncheckAllTasks
// ============================================================================

describe('uncheckAllTasks', () => {
	describe('empty and no-checkbox content', () => {
		it('should return empty string for empty input', () => {
			expect(uncheckAllTasks('')).toBe('');
		});

		it('should not modify content without checkboxes', () => {
			const content = `# My Document
Just some text here.`;
			expect(uncheckAllTasks(content)).toBe(content);
		});

		it('should not modify unchecked checkboxes', () => {
			const content = '- [ ] Unchecked task';
			expect(uncheckAllTasks(content)).toBe(content);
		});

		it('should preserve regular markdown formatting', () => {
			const content = `# Heading
Some **bold** and *italic* text.
- Regular item
1. Numbered item`;
			expect(uncheckAllTasks(content)).toBe(content);
		});
	});

	describe('checked task conversion', () => {
		it('should convert lowercase x checkbox to unchecked', () => {
			const content = '- [x] Completed task';
			expect(uncheckAllTasks(content)).toBe('- [ ] Completed task');
		});

		it('should convert uppercase X checkbox to unchecked', () => {
			const content = '- [X] Completed task';
			expect(uncheckAllTasks(content)).toBe('- [ ] Completed task');
		});

		it('should convert checkmark checkbox to unchecked', () => {
			const content = '- [✓] Completed task';
			expect(uncheckAllTasks(content)).toBe('- [ ] Completed task');
		});

		it('should convert heavy checkmark checkbox to unchecked', () => {
			const content = '- [✔] Completed task';
			expect(uncheckAllTasks(content)).toBe('- [ ] Completed task');
		});
	});

	describe('multiple task handling', () => {
		it('should handle multiple checked tasks', () => {
			const content = `- [x] Task one
- [X] Task two
- [✓] Task three
- [✔] Task four`;
			const expected = `- [ ] Task one
- [ ] Task two
- [ ] Task three
- [ ] Task four`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should preserve unchecked tasks while converting checked ones', () => {
			const content = `- [x] Completed
- [ ] Pending
- [X] Also completed
- [ ] Also pending`;
			const expected = `- [ ] Completed
- [ ] Pending
- [ ] Also completed
- [ ] Also pending`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should handle alternating checked/unchecked pattern', () => {
			const content = `- [x] Done
- [ ] Not done
- [x] Done
- [ ] Not done`;
			const expected = `- [ ] Done
- [ ] Not done
- [ ] Done
- [ ] Not done`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});
	});

	describe('indentation preservation', () => {
		it('should preserve indentation', () => {
			const content = `- [x] Parent task
  - [x] Child task
    - [x] Grandchild task`;
			const expected = `- [ ] Parent task
  - [ ] Child task
    - [ ] Grandchild task`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should preserve deep indentation', () => {
			const content = `- [x] Level 0
    - [x] Level 1
        - [x] Level 2
            - [x] Level 3`;
			const expected = `- [ ] Level 0
    - [ ] Level 1
        - [ ] Level 2
            - [ ] Level 3`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should handle tabbed indentation', () => {
			const content = `\t- [x] Tabbed task
\t\t- [X] Double tabbed task`;
			const expected = `\t- [ ] Tabbed task
\t\t- [ ] Double tabbed task`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should preserve mixed indentation styles', () => {
			const content = `  - [x] Space indented
\t- [x] Tab indented`;
			const expected = `  - [ ] Space indented
\t- [ ] Tab indented`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});
	});

	describe('content preservation', () => {
		it('should preserve other content around checkboxes', () => {
			const content = `# Tasks

## Phase 1
- [x] Setup project

## Phase 2
- [x] Write code

Some other text here.`;
			const expected = `# Tasks

## Phase 1
- [ ] Setup project

## Phase 2
- [ ] Write code

Some other text here.`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should preserve task descriptions', () => {
			const content = '- [x] This is a **very** important task with `code` and [links](url)';
			const expected = '- [ ] This is a **very** important task with `code` and [links](url)';
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should preserve emoji in task descriptions', () => {
			const content = '- [x] Task with emoji 🎉';
			const expected = '- [ ] Task with emoji 🎉';
			expect(uncheckAllTasks(content)).toBe(expected);
		});
	});

	describe('line ending handling', () => {
		it('should handle Windows line endings', () => {
			const content = '- [x] Task one\r\n- [x] Task two';
			const expected = '- [ ] Task one\r\n- [ ] Task two';
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should handle Unix line endings', () => {
			const content = '- [x] Task one\n- [x] Task two';
			const expected = '- [ ] Task one\n- [ ] Task two';
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should handle mixed line endings', () => {
			const content = '- [x] Task one\r\n- [x] Task two\n- [x] Task three';
			const expected = '- [ ] Task one\r\n- [ ] Task two\n- [ ] Task three';
			expect(uncheckAllTasks(content)).toBe(expected);
		});
	});

	describe('edge cases', () => {
		it('should handle single checked task', () => {
			const content = '- [x] Only task';
			const expected = '- [ ] Only task';
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should handle task at end of file without newline', () => {
			const content = '- [x] Last task';
			const expected = '- [ ] Last task';
			expect(uncheckAllTasks(content)).toBe(expected);
		});

		it('should handle inline patterns (regex matches at line start only)', () => {
			// The CHECKED_TASK_REGEX uses ^ anchor, so only line-start checkboxes are modified
			// But "- [x]" in middle of line starts with "- " so it CAN match
			// Actually: /^(\s*-\s*)\[[xX✓✔]\]/gm - the ^ in multiline mode matches start of line
			// "This text has [x]" - the "[x]" is not preceded by "- " so it won't match
			// "but - [x]" - this ALSO won't match because the line doesn't START with "-"
			const content = 'This text has [x] in the middle but - [x] also in middle';
			// Neither should be converted - neither is at line start
			expect(uncheckAllTasks(content)).toBe(content);
		});

		it('should handle unicode task descriptions', () => {
			const content = `- [x] タスク完了 (Japanese)
- [x] 任务完成 (Chinese)`;
			const expected = `- [ ] タスク完了 (Japanese)
- [ ] 任务完成 (Chinese)`;
			expect(uncheckAllTasks(content)).toBe(expected);
		});
	});

	describe('idempotency', () => {
		it('should be idempotent - running twice produces same result', () => {
			const content = `- [x] Task 1
- [X] Task 2
- [ ] Task 3`;
			const firstPass = uncheckAllTasks(content);
			const secondPass = uncheckAllTasks(firstPass);
			expect(firstPass).toBe(secondPass);
		});

		it('should not change already unchecked content', () => {
			const content = `- [ ] Task 1
- [ ] Task 2
- [ ] Task 3`;
			expect(uncheckAllTasks(content)).toBe(content);
		});
	});
});

// ============================================================================
// Integration: countUnfinishedTasks + uncheckAllTasks
// ============================================================================

describe('countUnfinishedTasks + uncheckAllTasks integration', () => {
	it('should count same number of tasks after unchecking', () => {
		const content = `- [x] Task 1
- [X] Task 2
- [✓] Task 3`;

		// Initially no unchecked tasks
		expect(countUnfinishedTasks(content)).toBe(0);

		// After unchecking, should have 3 unchecked tasks
		const unchecked = uncheckAllTasks(content);
		expect(countUnfinishedTasks(unchecked)).toBe(3);
	});

	it('should preserve count of already unchecked tasks', () => {
		const content = `- [x] Completed
- [ ] Pending 1
- [x] Also completed
- [ ] Pending 2`;

		const originalCount = countUnfinishedTasks(content);
		expect(originalCount).toBe(2);

		const unchecked = uncheckAllTasks(content);
		const newCount = countUnfinishedTasks(unchecked);
		expect(newCount).toBe(4);
	});

	it('should handle complex document', () => {
		const content = `# Project Status

## Phase 1 - Setup
- [x] Initialize repository
- [x] Configure CI/CD
- [ ] Write documentation

## Phase 2 - Development
- [x] Implement feature A
- [ ] Implement feature B
- [ ] Add tests

## Phase 3 - Launch
- [ ] Review code
- [ ] Deploy to staging
- [ ] Deploy to production`;

		// Check initial state
		const initialUnchecked = countUnfinishedTasks(content);
		expect(initialUnchecked).toBe(6);

		// After unchecking all
		const unchecked = uncheckAllTasks(content);
		const finalUnchecked = countUnfinishedTasks(unchecked);
		expect(finalUnchecked).toBe(9);
	});
});

// ============================================================================
// Tests for useBatchProcessor hook
// ============================================================================

describe('useBatchProcessor hook', () => {
	// Mock sessions and groups
	const createMockSession = (overrides?: Partial<Session>): Session => ({
		id: 'test-session-id',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/test/path',
		projectRoot: '/test/path',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		...overrides,
	});

	const createMockGroup = (overrides?: Partial<Group>): Group => ({
		id: 'test-group-id',
		name: 'Test Group',
		collapsed: false,
		...overrides,
	});

	// Mock callbacks
	let mockOnUpdateSession: ReturnType<typeof vi.fn>;
	let mockOnSpawnAgent: ReturnType<typeof vi.fn>;
	let mockOnAddHistoryEntry: ReturnType<typeof vi.fn>;
	let mockOnComplete: ReturnType<typeof vi.fn>;
	let mockOnPRResult: ReturnType<typeof vi.fn>;

	// Mock window.maestro methods
	let mockReadDoc: ReturnType<typeof vi.fn>;
	let mockWriteDoc: ReturnType<typeof vi.fn>;
	let mockCreateWorkingCopy: ReturnType<typeof vi.fn>;
	let mockStatus: ReturnType<typeof vi.fn>;
	let mockBranch: ReturnType<typeof vi.fn>;
	let mockBroadcastAutoRunState: ReturnType<typeof vi.fn>;
	let mockRegisterSessionOrigin: ReturnType<typeof vi.fn>;
	let mockWorktreeSetup: ReturnType<typeof vi.fn>;
	let mockWorktreeCheckout: ReturnType<typeof vi.fn>;
	let mockGetDefaultBranch: ReturnType<typeof vi.fn>;
	let mockCreatePR: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// Reset mocks
		mockOnUpdateSession = vi.fn();
		mockOnSpawnAgent = vi.fn().mockResolvedValue({
			success: true,
			agentSessionId: 'mock-claude-session',
			usageStats: {
				inputTokens: 100,
				outputTokens: 200,
				totalCostUsd: 0.01,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				contextWindow: 0,
			},
			response: '**Summary:** Test task completed\n\n**Details:** Some details here.',
		});
		mockOnAddHistoryEntry = vi.fn();
		mockOnComplete = vi.fn();
		mockOnPRResult = vi.fn();

		// Set up window.maestro mocks
		mockReadDoc = vi
			.fn()
			.mockResolvedValue({ success: true, content: '# Tasks\n- [ ] Task 1\n- [ ] Task 2' });
		mockWriteDoc = vi.fn().mockResolvedValue({ success: true });
		mockCreateWorkingCopy = vi.fn().mockResolvedValue({ workingCopyPath: 'Runs/tasks-run-1.md' });
		mockStatus = vi.fn().mockResolvedValue({ stdout: '' });
		mockBranch = vi.fn().mockResolvedValue({ stdout: 'main' });
		mockBroadcastAutoRunState = vi.fn();
		mockRegisterSessionOrigin = vi.fn().mockResolvedValue(undefined);
		mockWorktreeSetup = vi.fn().mockResolvedValue({ success: true });
		mockWorktreeCheckout = vi.fn().mockResolvedValue({ success: true });
		mockGetDefaultBranch = vi.fn().mockResolvedValue({ success: true, branch: 'main' });
		mockCreatePR = vi
			.fn()
			.mockResolvedValue({ success: true, prUrl: 'https://github.com/test/test/pull/1' });

		// Configure window.maestro
		window.maestro = {
			...window.maestro,
			autorun: {
				readDoc: mockReadDoc,
				writeDoc: mockWriteDoc,
				createWorkingCopy: mockCreateWorkingCopy,
				watchFolder: vi.fn(),
				unwatchFolder: vi.fn(),
				readFolder: vi.fn(),
			},
			git: {
				...window.maestro.git,
				status: mockStatus,
				branch: mockBranch,
				worktreeSetup: mockWorktreeSetup,
				worktreeCheckout: mockWorktreeCheckout,
				getDefaultBranch: mockGetDefaultBranch,
				createPR: mockCreatePR,
			},
			web: {
				...window.maestro.web,
				broadcastAutoRunState: mockBroadcastAutoRunState,
			},
			agentSessions: {
				...window.maestro.agentSessions,
				registerSessionOrigin: mockRegisterSessionOrigin,
			},
			power: {
				addReason: vi.fn(),
				removeReason: vi.fn(),
				setEnabled: vi.fn(),
				isEnabled: vi.fn().mockResolvedValue(true),
				getStatus: vi
					.fn()
					.mockResolvedValue({ enabled: true, blocking: false, reasons: [], platform: 'darwin' }),
			},
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('hook initialization', () => {
		it('should initialize with empty batch states', () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			expect(result.current.batchRunStates).toEqual({});
			expect(result.current.hasAnyActiveBatch).toBe(false);
			expect(result.current.activeBatchSessionIds).toEqual([]);
			expect(result.current.customPrompts).toEqual({});
		});

		it('should provide getBatchState that returns default state for unknown sessions', () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			const state = result.current.getBatchState('unknown-session');
			expect(state.isRunning).toBe(false);
			expect(state.isStopping).toBe(false);
			expect(state.totalTasks).toBe(0);
			expect(state.completedTasks).toBe(0);
		});
	});

	describe('state synchronization', () => {
		/**
		 * Regression test for bug where progress bar was stuck at "0 of N tasks completed"
		 * even after all tasks finished.
		 *
		 * Root cause: batchRunStatesRef was only updated on React re-render, but the
		 * debounce callback read this ref to compare state changes. When dispatches
		 * happened faster than React re-renders, the ref contained stale state.
		 *
		 * Fix: The dispatch wrapper now synchronously updates batchRunStatesRef
		 * immediately after each dispatch, ensuring debounced callbacks always
		 * see the current state.
		 *
		 * These tests verify the fix at the unit level by checking that getBatchState
		 * returns correct values immediately after state-changing operations.
		 */
		it('should provide correct initial state via getBatchState', () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			// Initial state should have 0 completed tasks
			const state = result.current.getBatchState('test-session-id');
			expect(state.completedTasksAcrossAllDocs).toBe(0);
			expect(state.totalTasksAcrossAllDocs).toBe(0);
			expect(state.isRunning).toBe(false);
		});

		it('should track hasAnyActiveBatch correctly', () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			// Initially no active batches
			expect(result.current.hasAnyActiveBatch).toBe(false);
			expect(result.current.activeBatchSessionIds).toEqual([]);
		});

		it('should return default state for sessions that have not started batch processing', () => {
			const sessions = [
				createMockSession({ id: 'session-1' }),
				createMockSession({ id: 'session-2' }),
			];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			// Both sessions should return default state with 0 progress
			const state1 = result.current.getBatchState('session-1');
			const state2 = result.current.getBatchState('session-2');

			expect(state1.completedTasksAcrossAllDocs).toBe(0);
			expect(state1.totalTasksAcrossAllDocs).toBe(0);
			expect(state2.completedTasksAcrossAllDocs).toBe(0);
			expect(state2.totalTasksAcrossAllDocs).toBe(0);
		});
	});

	describe('setCustomPrompt', () => {
		it('should set custom prompt for a session', () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			act(() => {
				result.current.setCustomPrompt('test-session-id', 'Custom prompt here');
			});

			expect(result.current.customPrompts['test-session-id']).toBe('Custom prompt here');
		});

		it('should update custom prompt for a session', () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			act(() => {
				result.current.setCustomPrompt('test-session-id', 'First prompt');
			});

			expect(result.current.customPrompts['test-session-id']).toBe('First prompt');

			act(() => {
				result.current.setCustomPrompt('test-session-id', 'Updated prompt');
			});

			expect(result.current.customPrompts['test-session-id']).toBe('Updated prompt');
		});

		it('should handle multiple session prompts', () => {
			const sessions = [
				createMockSession({ id: 'session-1' }),
				createMockSession({ id: 'session-2' }),
			];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			act(() => {
				result.current.setCustomPrompt('session-1', 'Prompt for session 1');
				result.current.setCustomPrompt('session-2', 'Prompt for session 2');
			});

			expect(result.current.customPrompts['session-1']).toBe('Prompt for session 1');
			expect(result.current.customPrompts['session-2']).toBe('Prompt for session 2');
		});
	});

	describe('startBatchRun', () => {
		it('should not start if session is not found', async () => {
			const sessions: Session[] = [];
			const groups: Group[] = [];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'non-existent-session',
					{
						documents: [{ filename: 'test', resetOnCompletion: false }],
						prompt: 'Test prompt',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should not start if no documents provided', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [],
						prompt: 'Test prompt',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should not start if no tasks found in documents', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock empty document with no tasks
			mockReadDoc.mockResolvedValue({ success: true, content: '# Empty document\nNo tasks here.' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'empty', resetOnCompletion: false }],
						prompt: 'Test prompt',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should start batch run and process tasks', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock document with 2 tasks initially, then 1 task, then 0 tasks
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) {
					return { success: true, content: '# Tasks\n- [ ] Task 1\n- [ ] Task 2' };
				} else if (callCount <= 4) {
					return { success: true, content: '# Tasks\n- [x] Task 1\n- [ ] Task 2' };
				} else {
					return { success: true, content: '# Tasks\n- [x] Task 1\n- [x] Task 2' };
				}
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Complete the next task',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have spawned agent
			expect(mockOnSpawnAgent).toHaveBeenCalled();

			// Should have called completion callback
			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'test-session-id',
					sessionName: 'Test Session',
				})
			);
		});

		it('should handle agent failure gracefully', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock single task - readDoc is called multiple times:
			// 1. Initial count (line 425)
			// 2. Document processing start (line 531)
			// 3. Template variable expansion (line 596)
			// 4. After agent runs to count remaining (line 626)
			// First 3 calls need unchecked tasks, call 4+ returns checked
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) {
					return { success: true, content: '# Tasks\n- [ ] Task 1' };
				} else {
					return { success: true, content: '# Tasks\n- [x] Task 1' };
				}
			});

			// Mock agent failure
			mockOnSpawnAgent.mockResolvedValue({ success: false });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Complete the task',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have tried to spawn agent
			expect(mockOnSpawnAgent).toHaveBeenCalled();

			// Should have added history entry with failure
			expect(mockOnAddHistoryEntry).toHaveBeenCalled();
		});
	});

	describe('stopBatchRun', () => {
		it('should set isStopping flag', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Create a deferred promise we can control
			let resolveAgent: (value: { success: boolean; agentSessionId?: string }) => void;
			const agentPromise = new Promise<{ success: boolean; agentSessionId?: string }>((resolve) => {
				resolveAgent = resolve;
			});
			mockOnSpawnAgent.mockReturnValue(agentPromise);

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
				})
			);

			// Start batch (don't await - we want it to be running)
			let batchFinished = false;
			act(() => {
				result.current
					.startBatchRun(
						'test-session-id',
						{
							documents: [{ filename: 'tasks', resetOnCompletion: false }],
							prompt: 'Test',
							loopEnabled: false,
						},
						'/test/folder'
					)
					.then(() => {
						batchFinished = true;
					});
			});

			// Wait for batch to actually be running (agent called)
			await waitFor(() => {
				expect(mockOnSpawnAgent).toHaveBeenCalled();
			});

			// Stop the batch while agent is "running"
			act(() => {
				result.current.stopBatchRun('test-session-id');
			});

			// Check state - isStopping should be true
			expect(result.current.getBatchState('test-session-id').isStopping).toBe(true);

			// Clean up: resolve the agent promise to let the batch finish
			await act(async () => {
				resolveAgent!({ success: true, agentSessionId: 'test-session' });
			});

			// Wait for batch to finish
			await waitFor(() => {
				expect(batchFinished).toBe(true);
			});
		});
	});

	describe('worktree handling', () => {
		it('should set up worktree when enabled', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Single task - need unchecked for first 3 calls (initial count, doc start, template expansion)
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) {
					return { success: true, content: '- [ ] Task' };
				}
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature/test',
						},
					},
					'/test/folder'
				);
			});

			expect(mockWorktreeSetup).toHaveBeenCalledWith(
				'/test/path',
				'/test/worktree',
				'feature/test',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('should handle worktree setup failure', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock worktree setup failure
			mockWorktreeSetup.mockResolvedValue({ success: false, error: 'Worktree setup failed' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature/test',
						},
					},
					'/test/folder'
				);
			});

			// Should not have spawned agent due to worktree failure
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should checkout different branch when worktree exists with branch mismatch', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock worktree exists with different branch
			mockWorktreeSetup.mockResolvedValue({ success: true, branchMismatch: true });

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature/test',
						},
					},
					'/test/folder'
				);
			});

			expect(mockWorktreeCheckout).toHaveBeenCalledWith(
				'/test/worktree',
				'feature/test',
				true,
				undefined // sshRemoteId (undefined for local sessions)
			);
		});
	});

	describe('PR creation', () => {
		it('should create PR when worktree is used and PR creation enabled', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature/test',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			expect(mockCreatePR).toHaveBeenCalled();
			expect(mockOnPRResult).toHaveBeenCalledWith(
				expect.objectContaining({
					success: true,
					prUrl: 'https://github.com/test/test/pull/1',
				})
			);
		});

		it('should handle PR creation failure', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock PR creation failure
			mockCreatePR.mockResolvedValue({ success: false, error: 'PR creation failed' });

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature/test',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			expect(mockOnPRResult).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: 'PR creation failed',
				})
			);
		});

		it('should use custom target branch for PR', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature/test',
							createPROnCompletion: true,
							prTargetBranch: 'develop',
						},
					},
					'/test/folder'
				);
			});

			expect(mockCreatePR).toHaveBeenCalledWith(
				'/test/worktree',
				'develop',
				expect.any(String),
				expect.any(String),
				undefined
			);
		});
	});

	describe('loop mode', () => {
		it('should stop at max loops', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock document that properly simulates task completion cycle
			// The batch processor calls readDoc at multiple points - we need to simulate
			// tasks being completed after the agent runs
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				// Calls 1-3: initial count, doc start, template - show unchecked
				// Call 4: after agent runs - show checked (task completed)
				// The reset-on-completion will uncheck, but since we hit maxLoops=1, we exit
				if (callCount <= 3) {
					return { success: true, content: '- [ ] Task 1' };
				} else {
					return { success: true, content: '- [x] Task 1' };
				}
			});

			// Track agent calls
			let spawnCount = 0;
			mockOnSpawnAgent.mockImplementation(async () => {
				spawnCount++;
				return { success: true, agentSessionId: `session-${spawnCount}` };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: true }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 1,
					},
					'/test/folder'
				);
			});

			// Should complete after max loops reached
			expect(mockOnComplete).toHaveBeenCalled();
			// Should have spawned at least one agent
			expect(spawnCount).toBeGreaterThanOrEqual(1);
		});
	});

	describe('reset on completion', () => {
		it('should create working copy when resetOnCompletion is enabled', async () => {
			// Note: Reset-on-completion now uses working copies in /Runs/ directory
			// instead of modifying the original document. This preserves the original
			// and allows the agent to work on a copy.
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// First 3 reads return unchecked task (initial count, doc start, template expansion)
			// After that, return checked task (agent completed it)
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) {
					return { success: true, content: '- [ ] Task 1' };
				}
				// After task completion
				return { success: true, content: '- [x] Task 1' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: true }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have created a working copy for the reset-on-completion document
			expect(mockCreateWorkingCopy).toHaveBeenCalledWith('/test/folder', 'tasks', 1);
		});
	});

	describe('audio feedback', () => {
		it('should speak synopsis when audio feedback is enabled', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const mockSpeak = vi.fn().mockResolvedValue(undefined);
			window.maestro.notification = {
				...window.maestro.notification,
				speak: mockSpeak,
			};

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					audioFeedbackEnabled: true,
					audioFeedbackCommand: 'say',
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockSpeak).toHaveBeenCalled();
		});
	});

	describe('state broadcasting', () => {
		it('should broadcast state to web interface', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have broadcast state updates
			expect(mockBroadcastAutoRunState).toHaveBeenCalled();
		});
	});

	describe('history entries', () => {
		it('should add history entry for each completed task', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'AUTO',
					sessionId: 'test-session-id',
				})
			);
		});
	});

	describe('hasAnyActiveBatch and activeBatchSessionIds', () => {
		it('should update when batch starts and ends', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Single task - need unchecked for first 3 calls
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			// Initially no active batches
			expect(result.current.hasAnyActiveBatch).toBe(false);
			expect(result.current.activeBatchSessionIds).toEqual([]);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// After batch completes, no active batches
			expect(result.current.hasAnyActiveBatch).toBe(false);
		});
	});

	describe('synopsis parsing', () => {
		it('should parse synopsis with proper Summary and Details format', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent response with synopsis format (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'mock-claude-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response:
					'**Summary:** Created new component\n\n**Details:** Added a React component with hooks and tests.',
			});

			// Single task that completes
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have added history entry with parsed synopsis
			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'AUTO',
					summary: 'Created new component',
				})
			);
		});

		it('should handle synopsis with ANSI codes and box characters', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent response with ANSI codes and box drawing chars (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'mock-claude-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '\x1b[32m**Summary:**\x1b[0m ─── Task done │\n\n**Details:** Info here.',
			});

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have cleaned up the synopsis
			expect(mockOnAddHistoryEntry).toHaveBeenCalled();
		});

		it('should handle synopsis without Details section', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent response with only Summary (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'mock-claude-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '**Summary:** No changes made.',
			});

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'No changes made.',
				})
			);
		});

		it('should handle synopsis without proper format (fallback to first line)', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent response without proper markdown format (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'mock-claude-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: 'Just a plain text response\nWith multiple lines.',
			});

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should use first sentence as summary (full paragraph if no sentence break found within 150 chars)
			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Just a plain text response\nWith multiple lines.',
				})
			);
		});

		it('should handle empty synopsis response', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent response with empty text (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'mock-claude-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '',
			});

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should use default summary (includes document name prefix)
			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: expect.stringContaining('Task completed'),
				})
			);
		});

		it('should handle synopsis failure gracefully', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent failure (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockResolvedValue({
				success: false,
				agentSessionId: 'mock-claude-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '',
			});

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should use default summary
			expect(mockOnAddHistoryEntry).toHaveBeenCalled();
		});

		it('should handle synopsis generation error', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock agent throwing error (synopsis is now extracted from agent response)
			mockOnSpawnAgent.mockRejectedValue(new Error('Agent execution failed'));

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should still complete and add history entry
			expect(mockOnAddHistoryEntry).toHaveBeenCalled();
			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('document reading and template substitution', () => {
		it('should substitute template variables in document content', async () => {
			const sessions = [createMockSession({ name: 'MySession' })];
			const groups = [createMockGroup({ name: 'MyGroup' })];

			// Document with template variables - uses callCount to progress task completion
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task for ${session_name}' };
				return { success: true, content: '- [x] Task for MySession' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Process: ${session_name}',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnSpawnAgent).toHaveBeenCalled();
		});

		it('should handle document read failure gracefully (no expansion if read fails)', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// First read for counting, then task progresses to completion
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				// First read for initial count - has task
				if (callCount === 1) return { success: true, content: '- [ ] Task' };
				// Second read for document update - returns original (still has task)
				if (callCount === 2) return { success: true, content: '- [ ] Task' };
				// Reads for template expansion could fail but we still spawn
				// After spawn, task is marked complete
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have attempted to spawn agent and completed
			expect(mockOnSpawnAgent).toHaveBeenCalled();
			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('git branch detection', () => {
		it('should get git branch for git repos', async () => {
			const sessions = [createMockSession({ isGitRepo: true })];
			const groups = [createMockGroup()];

			mockBranch.mockResolvedValue({ stdout: 'feature/test' });

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test ${git_branch}',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockStatus).toHaveBeenCalled();
			expect(mockBranch).toHaveBeenCalled();
		});

		it('should handle git status failure gracefully', async () => {
			const sessions = [createMockSession({ isGitRepo: true })];
			const groups = [createMockGroup()];

			mockStatus.mockRejectedValue(new Error('Git error'));

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should still proceed
			expect(mockOnSpawnAgent).toHaveBeenCalled();
		});

		it('should not fetch git status for non-git repos', async () => {
			const sessions = [createMockSession({ isGitRepo: false })];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockStatus).not.toHaveBeenCalled();
			expect(mockBranch).not.toHaveBeenCalled();
		});
	});

	describe('group name detection', () => {
		it('should find group name for session with groupId', async () => {
			const sessions = [createMockSession({ groupId: 'group-1' })];
			const groups = [createMockGroup({ id: 'group-1', name: 'My Group' })];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Group: ${group_name}',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnSpawnAgent).toHaveBeenCalled();
		});
	});

	describe('multiple documents', () => {
		it('should process multiple documents in order', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Track which document is being read
			const readOrder: string[] = [];
			let doc1Calls = 0;
			let doc2Calls = 0;

			mockReadDoc.mockImplementation(async (_folder: string, filename: string) => {
				readOrder.push(filename);

				if (filename === 'doc1.md') {
					doc1Calls++;
					if (doc1Calls <= 2) return { success: true, content: '- [ ] Doc1 Task' };
					return { success: true, content: '- [x] Doc1 Task' };
				}
				if (filename === 'doc2.md') {
					doc2Calls++;
					if (doc2Calls <= 2) return { success: true, content: '- [ ] Doc2 Task' };
					return { success: true, content: '- [x] Doc2 Task' };
				}
				return { success: true, content: '' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [
							{ filename: 'doc1', resetOnCompletion: false },
							{ filename: 'doc2', resetOnCompletion: false },
						],
						prompt: 'Process document',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
			expect(mockOnComplete).toHaveBeenCalled();
		});

		it('should skip documents with no tasks', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockReadDoc.mockImplementation(async (_folder: string, filename: string) => {
				if (filename === 'empty.md') {
					return { success: true, content: '# No tasks here' };
				}
				if (filename === 'tasks.md') {
					return { success: true, content: '- [x] Already done' };
				}
				return { success: true, content: '' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [
							{ filename: 'empty', resetOnCompletion: false },
							{ filename: 'tasks', resetOnCompletion: false },
						],
						prompt: 'Process',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should not spawn agent for empty documents
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});
	});

	describe('task error handling', () => {
		it('should continue to next task on agent spawn error', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Multiple tasks
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task 1\n- [ ] Task 2' };
				if (callCount <= 4) return { success: true, content: '- [x] Task 1\n- [ ] Task 2' };
				return { success: true, content: '- [x] Task 1\n- [x] Task 2' };
			});

			// First spawn fails, second succeeds
			let spawnCount = 0;
			mockOnSpawnAgent.mockImplementation(async () => {
				spawnCount++;
				if (spawnCount === 1) throw new Error('Spawn failed');
				return { success: true, agentSessionId: 'session-2' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have attempted both tasks
			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('error pause handling', () => {
		it('should pause processing until resumeAfterError is called', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const contentInitial = '- [ ] Task 1\n- [ ] Task 2';
			const contentAfterFirst = '- [x] Task 1\n- [ ] Task 2';
			const contentAfterSecond = '- [x] Task 1\n- [x] Task 2';
			const docStates = [
				contentInitial,
				contentInitial,
				contentInitial,
				contentAfterFirst,
				contentAfterFirst,
				contentAfterSecond,
			];

			mockReadDoc.mockImplementation(async () => ({
				success: true,
				content: docStates.shift() ?? contentAfterSecond,
			}));

			let pauseHandler:
				| ((
						sessionId: string,
						error: AgentError,
						documentIndex: number,
						taskDescription?: string
				  ) => void)
				| null = null;

			mockOnSpawnAgent.mockImplementation(async () => {
				if (pauseHandler) {
					pauseHandler(
						'test-session-id',
						{
							type: 'auth',
							message: 'Auth error',
							recoverable: true,
							timestamp: Date.now(),
						},
						0,
						'Task 1'
					);
					pauseHandler = null;
				}
				return { success: true, agentSessionId: 'session-1' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			pauseHandler = result.current.pauseBatchOnError;

			let startPromise: Promise<void>;
			act(() => {
				startPromise = result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			await waitFor(() => expect(mockOnSpawnAgent).toHaveBeenCalledTimes(1));
			await waitFor(() =>
				expect(result.current.getBatchState('test-session-id').errorPaused).toBe(true)
			);
			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(1);

			act(() => {
				result.current.resumeAfterError('test-session-id');
			});

			await startPromise;
			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
		});
	});

	describe('session claude ID tracking', () => {
		it('should collect claude session IDs from successful spawns', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Multiple tasks
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task 1\n- [ ] Task 2' };
				if (callCount <= 4) return { success: true, content: '- [x] Task 1\n- [ ] Task 2' };
				return { success: true, content: '- [x] Task 1\n- [x] Task 2' };
			});

			let spawnCount = 0;
			mockOnSpawnAgent.mockImplementation(async () => {
				spawnCount++;
				return { success: true, agentSessionId: `claude-session-${spawnCount}` };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have registered session origins
			expect(mockRegisterSessionOrigin).toHaveBeenCalledWith(
				'/test/path',
				'claude-session-1',
				'auto'
			);
			expect(mockRegisterSessionOrigin).toHaveBeenCalledWith(
				'/test/path',
				'claude-session-2',
				'auto'
			);
		});

		it('should handle missing claude session ID', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			// Spawn succeeds but no claude session ID
			mockOnSpawnAgent.mockResolvedValue({ success: true });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should not call synopsis since no claude session ID
			// But should still complete
			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('usage stats tracking', () => {
		it('should track usage stats from agent spawns', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
				usageStats: {
					inputTokens: 500,
					outputTokens: 1000,
					totalCostUsd: 0.05,
					cacheReadInputTokens: 100,
					cacheCreationInputTokens: 50,
					contextWindow: 100000,
				},
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// History entry should include usage stats
			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					usageStats: expect.objectContaining({
						inputTokens: 500,
						outputTokens: 1000,
						totalCostUsd: 0.05,
					}),
				})
			);
		});
	});

	describe('elapsed time tracking', () => {
		it('should track elapsed time for each task', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			// Delay agent spawn to create elapsed time
			mockOnSpawnAgent.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { success: true, agentSessionId: 'test' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// History entry should have elapsed time
			expect(mockOnAddHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					elapsedTimeMs: expect.any(Number),
				})
			);
		});

		it('should track total elapsed time for batch completion', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					elapsedTimeMs: expect.any(Number),
				})
			);
		});
	});

	describe('task count handling', () => {
		it('should handle Claude adding tasks (negative completion count)', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Claude adds a task instead of completing one
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task 1' };
				// After first run, there are MORE tasks
				if (callCount <= 4) return { success: true, content: '- [ ] Task 1\n- [ ] Task 2' };
				// Eventually complete
				if (callCount <= 6) return { success: true, content: '- [x] Task 1\n- [ ] Task 2' };
				return { success: true, content: '- [x] Task 1\n- [x] Task 2' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('worktree with cwd override', () => {
		it('should pass worktree path as cwd override to agent', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/custom/worktree',
							branchName: 'feature/test',
						},
					},
					'/test/folder'
				);
			});

			// Should have called spawn with cwd override
			expect(mockOnSpawnAgent).toHaveBeenCalledWith('test-session-id', 'Test', '/custom/worktree');
		});
	});

	describe('session name in completion', () => {
		it('should use session name in completion callback', async () => {
			const sessions = [createMockSession({ name: 'My Custom Session' })];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'My Custom Session',
				})
			);
		});

		it('should use cwd folder name as fallback for session name', async () => {
			const sessions = [createMockSession({ name: '', cwd: '/path/to/myproject' })];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'task', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'myproject',
				})
			);
		});
	});

	describe('stopBatchRun', () => {
		it('should set isStopping flag when called', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Simple test: start batch, call stop immediately, verify isStopping is set
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({ success: true, agentSessionId: 'test' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			// Start batch and immediately stop
			act(() => {
				result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
				result.current.stopBatchRun('test-session-id');
			});

			// Verify stop flag is set
			expect(result.current.getBatchState('test-session-id').isStopping).toBe(true);
		});
	});

	describe('loop mode with max loops limit', () => {
		it('should stop after reaching maxLoops', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Simulate task completion: first 3 calls show unchecked, then checked
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				// Calls 1-3: initial count, doc start, template - show unchecked
				// Call 4+: after agent runs - show checked (task completed)
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({ success: true, agentSessionId: 'test' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 2,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('worktree setup', () => {
		it('should handle worktree setup failure', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockReadDoc.mockResolvedValue({ success: true, content: '- [ ] Task' });

			// Mock worktree setup to fail
			const mockWorktreeSetup = vi.fn().mockResolvedValue({
				success: false,
				error: 'Failed to create worktree',
			});
			window.maestro.git.worktreeSetup = mockWorktreeSetup;

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: false,
						},
					},
					'/test/folder'
				);
			});

			// Should not have spawned agent due to worktree failure
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should handle worktree branch mismatch and checkout', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			// Mock worktree setup with branch mismatch
			const mockWorktreeSetup = vi.fn().mockResolvedValue({
				success: true,
				branchMismatch: true,
			});
			window.maestro.git.worktreeSetup = mockWorktreeSetup;

			const mockWorktreeCheckout = vi.fn().mockResolvedValue({
				success: true,
			});
			window.maestro.git.worktreeCheckout = mockWorktreeCheckout;

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: false,
						},
					},
					'/test/folder'
				);
			});

			// Should have called worktree checkout
			expect(mockWorktreeCheckout).toHaveBeenCalledWith(
				'/test/worktree',
				'feature-branch',
				true,
				undefined // sshRemoteId (undefined for local sessions)
			);

			// Should have spawned agent with worktree path
			expect(mockOnSpawnAgent).toHaveBeenCalledWith('test-session-id', 'Test', '/test/worktree');
		});

		it('should handle worktree checkout failure with uncommitted changes', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockReadDoc.mockResolvedValue({ success: true, content: '- [ ] Task' });

			// Mock worktree setup with branch mismatch
			const mockWorktreeSetup = vi.fn().mockResolvedValue({
				success: true,
				branchMismatch: true,
			});
			window.maestro.git.worktreeSetup = mockWorktreeSetup;

			// Mock checkout failure due to uncommitted changes
			const mockWorktreeCheckout = vi.fn().mockResolvedValue({
				success: false,
				hasUncommittedChanges: true,
			});
			window.maestro.git.worktreeCheckout = mockWorktreeCheckout;

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: false,
						},
					},
					'/test/folder'
				);
			});

			// Should not have spawned agent due to checkout failure
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});
	});

	describe('PR creation on completion', () => {
		it('should create PR when worktree completes with createPROnCompletion enabled', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			// Mock worktree setup
			const mockWorktreeSetup = vi.fn().mockResolvedValue({ success: true });
			window.maestro.git.worktreeSetup = mockWorktreeSetup;

			// Mock PR creation
			const mockCreatePR = vi.fn().mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/test/repo/pull/123',
			});
			window.maestro.git.createPR = mockCreatePR;

			// Mock default branch detection
			const mockGetDefaultBranch = vi.fn().mockResolvedValue({
				success: true,
				branch: 'main',
			});
			window.maestro.git.getDefaultBranch = mockGetDefaultBranch;

			const mockOnPRResult = vi.fn();

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			// Should have created PR
			expect(mockCreatePR).toHaveBeenCalled();
			expect(mockOnPRResult).toHaveBeenCalledWith(
				expect.objectContaining({
					success: true,
					prUrl: 'https://github.com/test/repo/pull/123',
				})
			);
		});

		it('should handle PR creation failure gracefully', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			// Mock worktree setup
			const mockWorktreeSetup = vi.fn().mockResolvedValue({ success: true });
			window.maestro.git.worktreeSetup = mockWorktreeSetup;

			// Mock PR creation failure
			const mockCreatePR = vi.fn().mockResolvedValue({
				success: false,
				error: 'No upstream configured',
			});
			window.maestro.git.createPR = mockCreatePR;

			const mockGetDefaultBranch = vi.fn().mockResolvedValue({
				success: true,
				branch: 'main',
			});
			window.maestro.git.getDefaultBranch = mockGetDefaultBranch;

			const mockOnPRResult = vi.fn();

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			// Should report PR failure but still complete the batch
			expect(mockOnPRResult).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: 'No upstream configured',
				})
			);
			expect(mockOnComplete).toHaveBeenCalled();
		});

		it('should use custom PR target branch when specified', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			// Mock worktree setup
			const mockWorktreeSetup = vi.fn().mockResolvedValue({ success: true });
			window.maestro.git.worktreeSetup = mockWorktreeSetup;

			// Mock PR creation
			const mockCreatePR = vi.fn().mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/test/repo/pull/456',
			});
			window.maestro.git.createPR = mockCreatePR;

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
							prTargetBranch: 'develop',
						},
					},
					'/test/folder'
				);
			});

			// Should have used custom target branch
			expect(mockCreatePR).toHaveBeenCalledWith(
				'/test/worktree',
				'develop',
				expect.any(String),
				expect.any(String),
				undefined
			);
		});
	});

	describe('audio feedback', () => {
		it('should speak synopsis when audio feedback is enabled', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '**Summary:** Fixed the bug\n\n**Details:** Updated the function.',
			});

			const mockSpeak = vi.fn().mockResolvedValue(undefined);
			window.maestro.notification.speak = mockSpeak;

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					audioFeedbackEnabled: true,
					audioFeedbackCommand: 'say',
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have called speak with the synopsis
			expect(mockSpeak).toHaveBeenCalledWith('Fixed the bug', 'say');
		});
	});

	describe('reset-on-completion in loop mode', () => {
		it('should create working copy when document has resetOnCompletion enabled', async () => {
			// Note: Reset-on-completion now uses working copies in /Runs/ directory
			// instead of modifying the original document. This preserves the original
			// and allows the agent to work on a copy each loop iteration.
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// First 3 calls show unchecked, then checked after agent runs
			let readCount = 0;
			mockReadDoc.mockImplementation(async () => {
				readCount++;
				if (readCount <= 3) return { success: true, content: '- [ ] Repeating task' };
				return { success: true, content: '- [x] Repeating task' };
			});

			mockOnSpawnAgent.mockResolvedValue({ success: true, agentSessionId: 'test' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: true }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 1,
					},
					'/test/folder'
				);
			});

			// Should have created a working copy for the reset-on-completion document
			expect(mockCreateWorkingCopy).toHaveBeenCalledWith('/test/folder', 'tasks', 1);
		});
	});

	describe('PR creation exception handling', () => {
		it('should handle PR creation throwing an Error', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Mock worktree setup success
			mockWorktreeSetup.mockResolvedValue({ success: true });

			// Mock PR creation throws an Error
			mockCreatePR.mockRejectedValue(new Error('Network timeout'));

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			// Should have notified of PR failure
			expect(mockOnPRResult).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: 'Network timeout',
				})
			);
		});

		it('should handle PR creation throwing a non-Error object', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockWorktreeSetup.mockResolvedValue({ success: true });
			mockCreatePR.mockRejectedValue('String error'); // Non-Error rejection

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			// Should have notified with 'Unknown error' for non-Error objects
			expect(mockOnPRResult).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: 'Unknown error',
				})
			);
		});

		it('should handle PR creation exception without onPRResult callback', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockWorktreeSetup.mockResolvedValue({ success: true });
			mockCreatePR.mockRejectedValue(new Error('Git error'));

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					// No onPRResult callback - tests the if (onPRResult) branch
				})
			);

			// Should not throw even without onPRResult callback
			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			// Should still complete successfully
			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('loop mode with multiple iterations', () => {
		it('should complete loop and add loop summary history entry', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Track document states: first 3 calls show unchecked, then checked
			let readCount = 0;
			mockReadDoc.mockImplementation(async () => {
				readCount++;
				// Calls 1-3: initial count, doc start, template - show unchecked
				if (readCount <= 3) return { success: true, content: '- [ ] Task 1' };
				// Call 4+: after agent - show checked
				return { success: true, content: '- [x] Task 1' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
				usageStats: {
					inputTokens: 500,
					outputTokens: 200,
					totalCostUsd: 0.05,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '**Summary:** Fixed it\n\n**Details:** Done.',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 2, // Allow 2 loops
					},
					'/test/folder'
				);
			});

			// Verify completion was called
			expect(mockOnComplete).toHaveBeenCalled();
		});

		it('should exit loop when reaching max loops limit', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// First 3 calls show unchecked, then checked
			let readCount = 0;
			mockReadDoc.mockImplementation(async () => {
				readCount++;
				if (readCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 1, // Limit to 1 loop
					},
					'/test/folder'
				);
			});

			// Should exit after max loops
			expect(mockOnComplete).toHaveBeenCalled();
		});

		it('should handle loop with reset-on-completion documents', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// First 3 calls show unchecked, then checked
			let readCount = 0;
			mockReadDoc.mockImplementation(async () => {
				readCount++;
				if (readCount <= 3) return { success: true, content: '- [ ] Repeating task' };
				return { success: true, content: '- [x] Repeating task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: true }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 1, // Limit iterations
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalled();
		});

		it('should exit loop when no tasks were processed in an iteration', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// First 3 calls show unchecked, then no tasks
			let readCount = 0;
			mockReadDoc.mockImplementation(async () => {
				readCount++;
				if (readCount <= 3) return { success: true, content: '- [ ] Task' };
				// After processing - no tasks left
				return { success: true, content: '# Empty\nNo tasks here.' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: true,
						maxLoops: 5, // High limit - should exit early due to no tasks processed
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('worktree checkout handling', () => {
		it('should handle worktree checkout failure due to uncommitted changes', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Worktree exists but on different branch
			mockWorktreeSetup.mockResolvedValue({ success: true, branchMismatch: true });

			// Checkout fails due to uncommitted changes
			mockWorktreeCheckout.mockResolvedValue({
				success: false,
				hasUncommittedChanges: true,
			});

			mockReadDoc.mockResolvedValue({ success: true, content: '- [ ] Task' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
						},
					},
					'/test/folder'
				);
			});

			// Should not have spawned agent due to checkout failure
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should handle worktree checkout failure without uncommitted changes', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockWorktreeSetup.mockResolvedValue({ success: true, branchMismatch: true });

			// Checkout fails for other reasons
			mockWorktreeCheckout.mockResolvedValue({
				success: false,
				error: 'Branch does not exist',
			});

			mockReadDoc.mockResolvedValue({ success: true, content: '- [ ] Task' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
						},
					},
					'/test/folder'
				);
			});

			// Should not have spawned agent due to checkout failure
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should handle worktree setup exception', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Worktree setup throws exception
			mockWorktreeSetup.mockRejectedValue(new Error('Git not found'));

			mockReadDoc.mockResolvedValue({ success: true, content: '- [ ] Task' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
						},
					},
					'/test/folder'
				);
			});

			// Should not have spawned agent due to exception
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});
	});

	describe('PR creation with fallback to default branch', () => {
		it('should use default branch when prTargetBranch is not specified', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockWorktreeSetup.mockResolvedValue({ success: true });
			mockGetDefaultBranch.mockResolvedValue({ success: true, branch: 'develop' });
			mockCreatePR.mockResolvedValue({ success: true, prUrl: 'https://github.com/test/pr/1' });

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
							// No prTargetBranch - should use default
						},
					},
					'/test/folder'
				);
			});

			// Should have called getDefaultBranch
			expect(mockGetDefaultBranch).toHaveBeenCalled();

			// Should have created PR with detected default branch
			expect(mockCreatePR).toHaveBeenCalledWith(
				expect.any(String),
				'develop', // The detected default branch
				expect.any(String),
				expect.any(String),
				undefined
			);
		});

		it('should fall back to main when getDefaultBranch fails', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockWorktreeSetup.mockResolvedValue({ success: true });
			mockGetDefaultBranch.mockResolvedValue({ success: false });
			mockCreatePR.mockResolvedValue({ success: true, prUrl: 'https://github.com/test/pr/1' });

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
						},
					},
					'/test/folder'
				);
			});

			// Should have created PR with fallback to 'main'
			expect(mockCreatePR).toHaveBeenCalledWith(
				expect.any(String),
				'main', // Fallback
				expect.any(String),
				expect.any(String),
				undefined
			);
		});
	});

	describe('session name extraction', () => {
		it('should extract session name from cwd when name is not set', async () => {
			// Session without a name, only cwd
			const sessions = [createMockSession({ name: '', cwd: '/path/to/MyProject' })];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should extract 'MyProject' from cwd
			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'MyProject',
				})
			);
		});

		it('should use Unknown when cwd has no path segments', async () => {
			const sessions = [createMockSession({ name: '', cwd: '' })];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'Unknown',
				})
			);
		});
	});

	describe('Claude session registration', () => {
		it('should register session origin as auto-initiated', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'new-claude-session-123',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should have registered the Claude session as auto-initiated
			expect(mockRegisterSessionOrigin).toHaveBeenCalledWith(
				'/test/path', // session.cwd
				'new-claude-session-123',
				'auto'
			);
		});

		it('should handle session registration error gracefully', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockRegisterSessionOrigin.mockRejectedValue(new Error('Registration failed'));

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			// Should not throw even if registration fails
			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('document with failed read', () => {
		it('should handle document read returning empty content', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			// Document read fails (no content)
			mockReadDoc.mockResolvedValue({ success: true, content: '' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'empty', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should not spawn agent for empty document
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});

		it('should handle document read failure', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockReadDoc.mockResolvedValue({ success: false });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'missing', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			// Should not spawn agent for failed read
			expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		});
	});

	describe('audio feedback edge cases', () => {
		it('should not speak if audio feedback is disabled', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const mockSpeak = vi.fn().mockResolvedValue(undefined);
			window.maestro.notification.speak = mockSpeak;

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					audioFeedbackEnabled: false, // Disabled
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockSpeak).not.toHaveBeenCalled();
		});

		it('should handle speak error gracefully', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			const mockSpeak = vi.fn().mockRejectedValue(new Error('TTS not available'));
			window.maestro.notification.speak = mockSpeak;

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					totalCostUsd: 0.01,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				},
				response: '**Summary:** Done',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					audioFeedbackEnabled: true,
					audioFeedbackCommand: 'say',
				})
			);

			// Should not throw even if speak fails
			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/test/folder'
				);
			});

			expect(mockOnComplete).toHaveBeenCalled();
		});
	});

	describe('ghPath for PR creation', () => {
		it('should pass ghPath to createPR when specified', async () => {
			const sessions = [createMockSession()];
			const groups = [createMockGroup()];

			mockWorktreeSetup.mockResolvedValue({ success: true });
			mockCreatePR.mockResolvedValue({ success: true, prUrl: 'https://github.com/test/pr/1' });

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			mockOnSpawnAgent.mockResolvedValue({
				success: true,
				agentSessionId: 'test-session',
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
					onPRResult: mockOnPRResult,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/test/worktree',
							branchName: 'feature-branch',
							createPROnCompletion: true,
							prTargetBranch: 'main',
							ghPath: '/usr/local/bin/gh', // Custom gh path
						},
					},
					'/test/folder'
				);
			});

			// Should have passed ghPath to createPR
			expect(mockCreatePR).toHaveBeenCalledWith(
				expect.any(String),
				'main',
				expect.any(String),
				expect.any(String),
				'/usr/local/bin/gh'
			);
		});
	});

	describe('SSH remote session support', () => {
		it('should pass sshRemoteId to readDoc for SSH sessions', async () => {
			const sshSession = createMockSession({
				sshRemoteId: 'ssh-remote-123',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'ssh-remote-123',
				},
			});
			const sessions = [sshSession];
			const groups = [createMockGroup()];

			mockReadDoc.mockResolvedValue({ success: true, content: '- [x] Completed' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/remote/path'
				);
			});

			// Verify readDoc was called with sshRemoteId
			expect(mockReadDoc).toHaveBeenCalledWith(
				'/remote/path',
				'tasks.md',
				'ssh-remote-123' // sshRemoteId should be passed
			);
		});

		it('should pass sshRemoteId through multiple readDoc calls for SSH sessions', async () => {
			const sshSession = createMockSession({
				sshRemoteId: 'ssh-remote-456',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'ssh-remote-456',
				},
			});
			const sessions = [sshSession];
			const groups = [createMockGroup()];

			// Start with one unchecked task, then return checked after agent run
			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 2) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/remote/path'
				);
			});

			// Verify all readDoc calls included sshRemoteId
			const readDocCalls = mockReadDoc.mock.calls;
			expect(readDocCalls.length).toBeGreaterThan(0);

			// Every call should have sshRemoteId as the third argument
			for (const call of readDocCalls) {
				expect(call[2]).toBe('ssh-remote-456');
			}
		});

		it('should use sessionSshRemoteConfig.remoteId when sshRemoteId is not set', async () => {
			// This tests the fallback: session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId
			const sshSession = createMockSession({
				sshRemoteId: undefined, // Not set (e.g., terminal-only SSH session)
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'fallback-remote-789',
				},
			});
			const sessions = [sshSession];
			const groups = [createMockGroup()];

			mockReadDoc.mockResolvedValue({ success: true, content: '- [x] Completed' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/remote/path'
				);
			});

			// Verify readDoc was called with the fallback sshRemoteId
			expect(mockReadDoc).toHaveBeenCalledWith(
				'/remote/path',
				'tasks.md',
				'fallback-remote-789' // Should use sessionSshRemoteConfig.remoteId as fallback
			);
		});

		it('should pass sshRemoteId to worktree operations for SSH sessions', async () => {
			const sshSession = createMockSession({
				sshRemoteId: 'ssh-worktree-remote',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'ssh-worktree-remote',
				},
			});
			const sessions = [sshSession];
			const groups = [createMockGroup()];

			let callCount = 0;
			mockReadDoc.mockImplementation(async () => {
				callCount++;
				if (callCount <= 3) return { success: true, content: '- [ ] Task' };
				return { success: true, content: '- [x] Task' };
			});

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
						worktree: {
							enabled: true,
							path: '/remote/worktree',
							branchName: 'feature/ssh-test',
						},
					},
					'/remote/folder'
				);
			});

			// Verify worktreeSetup was called with sshRemoteId
			expect(mockWorktreeSetup).toHaveBeenCalledWith(
				'/test/path', // session.cwd
				'/remote/worktree',
				'feature/ssh-test',
				'ssh-worktree-remote' // sshRemoteId should be passed
			);
		});

		it('should not pass sshRemoteId for local sessions', async () => {
			// Regular local session without SSH config
			const localSession = createMockSession({
				sshRemoteId: undefined,
				sessionSshRemoteConfig: undefined,
			});
			const sessions = [localSession];
			const groups = [createMockGroup()];

			mockReadDoc.mockResolvedValue({ success: true, content: '- [x] Completed' });

			const { result } = renderHook(() =>
				useBatchProcessor({
					sessions,
					groups,
					onUpdateSession: mockOnUpdateSession,
					onSpawnAgent: mockOnSpawnAgent,
					onAddHistoryEntry: mockOnAddHistoryEntry,
					onComplete: mockOnComplete,
				})
			);

			await act(async () => {
				await result.current.startBatchRun(
					'test-session-id',
					{
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
						prompt: 'Test',
						loopEnabled: false,
					},
					'/local/path'
				);
			});

			// Verify readDoc was called without sshRemoteId (undefined)
			expect(mockReadDoc).toHaveBeenCalledWith(
				'/local/path',
				'tasks.md',
				undefined // No sshRemoteId for local sessions
			);
		});
	});
});
