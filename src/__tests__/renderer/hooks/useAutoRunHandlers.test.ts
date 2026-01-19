/**
 * @file useAutoRunHandlers.test.ts
 * @description Unit tests for the useAutoRunHandlers hook
 *
 * Tests cover:
 * - handleAutoRunContentChange - only updates state (no file write)
 * - handleAutoRunModeChange - updates session mode
 * - handleAutoRunSelectDocument - loads content and updates session atomically
 * - handleAutoRunRefresh - reloads document list and shows notification
 * - handleAutoRunCreateDocument - creates file and selects it
 * - handleAutoRunFolderSelected - sets up Auto Run folder and loads documents
 * - handleStartBatchRun - starts batch run with configuration
 * - getDocumentTaskCount - counts unchecked tasks using regex
 * - handleAutoRunStateChange - updates scroll/cursor positions
 * - handleAutoRunOpenSetup - opens setup modal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../renderer/hooks';
import type { Session, BatchRunConfig } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
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
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	executionQueue: [],
	activeTimeMs: 0,
	aiTabs: [],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	autoRunFolderPath: '/test/autorun',
	autoRunSelectedFile: 'Phase 1',
	autoRunContent: '# Phase 1\n\nInitial content',
	autoRunContentVersion: 1,
	autoRunMode: 'edit',
	...overrides,
});

const createMockDeps = () => ({
	setSessions: vi.fn(),
	setAutoRunDocumentList: vi.fn(),
	setAutoRunDocumentTree: vi.fn(),
	setAutoRunIsLoadingDocuments: vi.fn(),
	setAutoRunSetupModalOpen: vi.fn(),
	setBatchRunnerModalOpen: vi.fn(),
	setActiveRightTab: vi.fn(),
	setRightPanelOpen: vi.fn(),
	setActiveFocus: vi.fn(),
	setSuccessFlashNotification: vi.fn(),
	autoRunDocumentList: ['Phase 1', 'Phase 2', 'Phase 3'],
	startBatchRun: vi.fn(),
});

// ============================================================================
// Tests for handleAutoRunContentChange
// ============================================================================

describe('useAutoRunHandlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('handleAutoRunContentChange', () => {
		it('should update session state with new content', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunContentChange('Updated content');
			});

			expect(mockDeps.setSessions).toHaveBeenCalledOnce();
			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunContent).toBe('Updated content');
		});

		it('should NOT call writeDoc (content changes are in-memory only)', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunContentChange('New content');
			});

			// Verify writeDoc was NOT called - content changes don't persist immediately
			expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('should do nothing when activeSession is null', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunContentChange('Content');
			});

			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});

		it('should only update the active session in an array of sessions', async () => {
			const mockSession = createMockSession({ id: 'session-2' });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunContentChange('Session 2 content');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const allSessions = [
				createMockSession({ id: 'session-1', autoRunContent: 'Original 1' }),
				createMockSession({ id: 'session-2', autoRunContent: 'Original 2' }),
				createMockSession({ id: 'session-3', autoRunContent: 'Original 3' }),
			];
			const updatedSessions = updateFn(allSessions);

			expect(updatedSessions[0].autoRunContent).toBe('Original 1');
			expect(updatedSessions[1].autoRunContent).toBe('Session 2 content');
			expect(updatedSessions[2].autoRunContent).toBe('Original 3');
		});

		it('should handle empty content', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunContentChange('');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunContent).toBe('');
		});
	});

	// ============================================================================
	// Tests for handleAutoRunModeChange
	// ============================================================================

	describe('handleAutoRunModeChange', () => {
		it('should update session mode to edit', () => {
			const mockSession = createMockSession({ autoRunMode: 'preview' });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleAutoRunModeChange('edit');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunMode).toBe('edit');
		});

		it('should update session mode to preview', () => {
			const mockSession = createMockSession({ autoRunMode: 'edit' });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleAutoRunModeChange('preview');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunMode).toBe('preview');
		});

		it('should do nothing when activeSession is null', () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			act(() => {
				result.current.handleAutoRunModeChange('edit');
			});

			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});

		it('should only update the active session mode', () => {
			const mockSession = createMockSession({ id: 'session-2', autoRunMode: 'edit' });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleAutoRunModeChange('preview');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const allSessions = [
				createMockSession({ id: 'session-1', autoRunMode: 'edit' }),
				createMockSession({ id: 'session-2', autoRunMode: 'edit' }),
			];
			const updatedSessions = updateFn(allSessions);

			expect(updatedSessions[0].autoRunMode).toBe('edit');
			expect(updatedSessions[1].autoRunMode).toBe('preview');
		});
	});

	// ============================================================================
	// Tests for handleAutoRunStateChange
	// ============================================================================

	describe('handleAutoRunStateChange', () => {
		it('should update all state properties atomically', () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleAutoRunStateChange({
					mode: 'preview',
					cursorPosition: 100,
					editScrollPos: 200,
					previewScrollPos: 300,
				});
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunMode).toBe('preview');
			expect(updatedSessions[0].autoRunCursorPosition).toBe(100);
			expect(updatedSessions[0].autoRunEditScrollPos).toBe(200);
			expect(updatedSessions[0].autoRunPreviewScrollPos).toBe(300);
		});

		it('should do nothing when activeSession is null', () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			act(() => {
				result.current.handleAutoRunStateChange({
					mode: 'edit',
					cursorPosition: 0,
					editScrollPos: 0,
					previewScrollPos: 0,
				});
			});

			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Tests for handleAutoRunSelectDocument
	// ============================================================================

	describe('handleAutoRunSelectDocument', () => {
		it('should load document content and update session atomically', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: '# Phase 2\n\nNew document content',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunSelectDocument('Phase 2');
			});

			expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
				'/test/autorun',
				'Phase 2.md',
				undefined // sshRemoteId - not set in test session
			);

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunSelectedFile).toBe('Phase 2');
			expect(updatedSessions[0].autoRunContent).toBe('# Phase 2\n\nNew document content');
			expect(updatedSessions[0].autoRunContentVersion).toBe(2);
		});

		it('should handle failed document read gracefully', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: false,
				content: undefined,
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunSelectDocument('Missing Doc');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunSelectedFile).toBe('Missing Doc');
			expect(updatedSessions[0].autoRunContent).toBe('');
		});

		it('should do nothing when activeSession is null', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunSelectDocument('Phase 1');
			});

			expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});

		it('should do nothing when autoRunFolderPath is not set', async () => {
			const mockSession = createMockSession({ autoRunFolderPath: undefined });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunSelectDocument('Phase 1');
			});

			expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});

		it('should increment contentVersion to force sync', async () => {
			const mockSession = createMockSession({ autoRunContentVersion: 5 });
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: 'Content',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunSelectDocument('Phase 2');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunContentVersion).toBe(6);
		});
	});

	// ============================================================================
	// Tests for handleAutoRunRefresh
	// ============================================================================

	describe('handleAutoRunRefresh', () => {
		it('should reload document list and show notification', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();
			mockDeps.autoRunDocumentList = ['Phase 1', 'Phase 2'];

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1', 'Phase 2', 'Phase 3'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(mockDeps.setAutoRunIsLoadingDocuments).toHaveBeenCalledWith(true);
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/test/autorun', undefined);
			expect(mockDeps.setAutoRunDocumentList).toHaveBeenCalledWith([
				'Phase 1',
				'Phase 2',
				'Phase 3',
			]);
			expect(mockDeps.setAutoRunDocumentTree).toHaveBeenCalled();
			expect(mockDeps.setAutoRunIsLoadingDocuments).toHaveBeenCalledWith(false);
			expect(mockDeps.setSuccessFlashNotification).toHaveBeenCalledWith('Found 1 new document');
		});

		it('should show plural message when multiple new documents found', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();
			mockDeps.autoRunDocumentList = ['Phase 1'];

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(mockDeps.setSuccessFlashNotification).toHaveBeenCalledWith('Found 3 new documents');
		});

		it('should show removal message when documents were removed', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();
			mockDeps.autoRunDocumentList = ['Phase 1', 'Phase 2', 'Phase 3'];

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(mockDeps.setSuccessFlashNotification).toHaveBeenCalledWith('2 documents removed');
		});

		it('should show "no new documents" when count unchanged', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();
			mockDeps.autoRunDocumentList = ['Phase 1', 'Phase 2'];

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1', 'Phase 2'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(mockDeps.setSuccessFlashNotification).toHaveBeenCalledWith(
				'Refresh complete, no new documents'
			);
		});

		it('should clear flash notification after 2 seconds', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(mockDeps.setSuccessFlashNotification).toHaveBeenCalledTimes(1);

			// Advance timers by 2 seconds
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			expect(mockDeps.setSuccessFlashNotification).toHaveBeenCalledTimes(2);
			expect(mockDeps.setSuccessFlashNotification).toHaveBeenLastCalledWith(null);
		});

		it('should do nothing when activeSession is null', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();
		});

		it('should do nothing when autoRunFolderPath is not set', async () => {
			const mockSession = createMockSession({ autoRunFolderPath: undefined });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();
		});

		it('should stop loading indicator even on failure', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: false,
				files: [],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunRefresh();
			});

			expect(mockDeps.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);
		});
	});

	// ============================================================================
	// Tests for handleAutoRunCreateDocument
	// ============================================================================

	describe('handleAutoRunCreateDocument', () => {
		it('should create document with empty content', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1', 'Phase 2', 'New Document'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let success: boolean = false;
			await act(async () => {
				success = await result.current.handleAutoRunCreateDocument('New Document');
			});

			expect(success).toBe(true);
			expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/autorun',
				'New Document.md',
				'',
				undefined // sshRemoteId - not set in test session
			);
		});

		it('should refresh document list after creation', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1', 'New Doc'],
				tree: [{ name: 'Phase 1', type: 'file', path: 'Phase 1.md' }],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunCreateDocument('New Doc');
			});

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/test/autorun', undefined);
			expect(mockDeps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'New Doc']);
			expect(mockDeps.setAutoRunDocumentTree).toHaveBeenCalledWith([
				{ name: 'Phase 1', type: 'file', path: 'Phase 1.md' },
			]);
		});

		it('should select the new document and switch to edit mode', async () => {
			const mockSession = createMockSession({ autoRunMode: 'preview' });
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['New Doc'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunCreateDocument('New Doc');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunSelectedFile).toBe('New Doc');
			expect(updatedSessions[0].autoRunContent).toBe('');
			expect(updatedSessions[0].autoRunMode).toBe('edit');
		});

		it('should increment contentVersion', async () => {
			const mockSession = createMockSession({ autoRunContentVersion: 3 });
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['New Doc'],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunCreateDocument('New Doc');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunContentVersion).toBe(4);
		});

		it('should return false when write fails', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: false });

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let success: boolean = true;
			await act(async () => {
				success = await result.current.handleAutoRunCreateDocument('New Doc');
			});

			expect(success).toBe(false);
			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});

		it('should return false when activeSession is null', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			let success: boolean = true;
			await act(async () => {
				success = await result.current.handleAutoRunCreateDocument('New Doc');
			});

			expect(success).toBe(false);
			expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('should return false when autoRunFolderPath is not set', async () => {
			const mockSession = createMockSession({ autoRunFolderPath: undefined });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let success: boolean = true;
			await act(async () => {
				success = await result.current.handleAutoRunCreateDocument('New Doc');
			});

			expect(success).toBe(false);
			expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('should handle write exception gracefully', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.writeDoc).mockRejectedValue(new Error('Write failed'));

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let success: boolean = true;
			await act(async () => {
				success = await result.current.handleAutoRunCreateDocument('New Doc');
			});

			expect(success).toBe(false);
		});
	});

	// ============================================================================
	// Tests for getDocumentTaskCount (unchecked task counting regex)
	// ============================================================================

	describe('getDocumentTaskCount', () => {
		it('should count unchecked tasks in document', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: `# Tasks
- [ ] Task one
- [ ] Task two
- [x] Completed task
- [ ] Task three`,
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 0;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Tasks');
			});

			expect(count).toBe(3);
			expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
				'/test/autorun',
				'Tasks.md',
				undefined // sshRemoteId - not set in test session
			);
		});

		it('should return 0 for document with no tasks', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: '# Just a heading\n\nSome text without tasks.',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 99;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('NoTasks');
			});

			expect(count).toBe(0);
		});

		it('should return 0 for document with only completed tasks', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: `# Done
- [x] Done 1
- [X] Done 2
- [x] Done 3`,
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 99;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Done');
			});

			expect(count).toBe(0);
		});

		it('should return 0 when document read fails', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: false,
				content: undefined,
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 99;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Missing');
			});

			expect(count).toBe(0);
		});

		it('should return 0 when activeSession has no folder path', async () => {
			const mockSession = createMockSession({ autoRunFolderPath: undefined });
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 99;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Tasks');
			});

			expect(count).toBe(0);
			expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
		});

		it('should handle indented tasks', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: `# Nested
- [ ] Parent
  - [ ] Child
    - [ ] Grandchild`,
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 0;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Nested');
			});

			expect(count).toBe(3);
		});

		it('should handle tasks with special characters', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: `# Special
- [ ] Task with "quotes"
- [ ] Task with **bold**
- [ ] Task with \`code\`
- [ ] Task with [link](url)`,
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 0;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Special');
			});

			expect(count).toBe(4);
		});

		it('should handle empty document content', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: '',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			let count: number = 99;
			await act(async () => {
				count = await result.current.getDocumentTaskCount('Empty');
			});

			expect(count).toBe(0);
		});
	});

	// ============================================================================
	// Tests for handleAutoRunFolderSelected
	// ============================================================================

	describe('handleAutoRunFolderSelected', () => {
		it('should load documents and set up folder', async () => {
			const mockSession = createMockSession({ autoRunFolderPath: undefined });
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Phase 1', 'Phase 2'],
				tree: [{ name: 'Phase 1', type: 'file', path: 'Phase 1.md' }],
			});
			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: '# Phase 1 Content',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunFolderSelected('/new/folder');
			});

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/new/folder', undefined);
			expect(mockDeps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
			expect(mockDeps.setAutoRunDocumentTree).toHaveBeenCalled();
			expect(mockDeps.setAutoRunSetupModalOpen).toHaveBeenCalledWith(false);
			expect(mockDeps.setActiveRightTab).toHaveBeenCalledWith('autorun');
			expect(mockDeps.setRightPanelOpen).toHaveBeenCalledWith(true);
			expect(mockDeps.setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should auto-select and load first document', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['First Doc', 'Second Doc'],
				tree: [],
			});
			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: '# First Doc Content',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunFolderSelected('/folder');
			});

			expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
				'/folder',
				'First Doc.md',
				undefined
			);

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunFolderPath).toBe('/folder');
			expect(updatedSessions[0].autoRunSelectedFile).toBe('First Doc');
			expect(updatedSessions[0].autoRunContent).toBe('# First Doc Content');
		});

		it('should handle empty folder', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: [],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunFolderSelected('/empty/folder');
			});

			// Should not try to read a document when folder is empty
			expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunFolderPath).toBe('/empty/folder');
			expect(updatedSessions[0].autoRunSelectedFile).toBeUndefined();
			expect(updatedSessions[0].autoRunContent).toBe('');
		});

		it('should handle listDocs failure', async () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: false,
				files: [],
				tree: [],
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunFolderSelected('/bad/folder');
			});

			expect(mockDeps.setAutoRunDocumentList).toHaveBeenCalledWith([]);
			expect(mockDeps.setAutoRunDocumentTree).toHaveBeenCalledWith([]);
			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunFolderPath).toBe('/bad/folder');
			expect(updatedSessions[0].autoRunSelectedFile).toBeUndefined();
			expect(updatedSessions[0].autoRunContent).toBe('');
		});

		it('should do nothing when activeSession is null', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunFolderSelected('/folder');
			});

			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();
			expect(mockDeps.setSessions).not.toHaveBeenCalled();
		});

		it('should increment contentVersion', async () => {
			const mockSession = createMockSession({ autoRunContentVersion: 7 });
			const mockDeps = createMockDeps();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['Doc'],
				tree: [],
			});
			vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
				success: true,
				content: 'Content',
			});

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			await act(async () => {
				await result.current.handleAutoRunFolderSelected('/folder');
			});

			const updateFn = mockDeps.setSessions.mock.calls[0][0];
			const updatedSessions = updateFn([mockSession]);
			expect(updatedSessions[0].autoRunContentVersion).toBe(8);
		});
	});

	// ============================================================================
	// Tests for handleStartBatchRun
	// ============================================================================

	describe('handleStartBatchRun', () => {
		it('should start batch run with config', () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const config: BatchRunConfig = {
				documents: [{ id: '1', filename: 'Phase 1', resetOnCompletion: false, isDuplicate: false }],
				prompt: 'Test prompt',
				loopEnabled: false,
			};

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleStartBatchRun(config);
			});

			expect(mockDeps.setBatchRunnerModalOpen).toHaveBeenCalledWith(false);
			expect(mockDeps.startBatchRun).toHaveBeenCalledWith(
				'test-session-1',
				config,
				'/test/autorun'
			);
		});

		it('should do nothing when activeSession is null', () => {
			const mockDeps = createMockDeps();

			const config: BatchRunConfig = {
				documents: [],
				prompt: 'Test',
				loopEnabled: false,
			};

			const { result } = renderHook(() => useAutoRunHandlers(null, mockDeps));

			act(() => {
				result.current.handleStartBatchRun(config);
			});

			expect(mockDeps.startBatchRun).not.toHaveBeenCalled();
		});

		it('should do nothing when autoRunFolderPath is not set', () => {
			const mockSession = createMockSession({ autoRunFolderPath: undefined });
			const mockDeps = createMockDeps();

			const config: BatchRunConfig = {
				documents: [],
				prompt: 'Test',
				loopEnabled: false,
			};

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleStartBatchRun(config);
			});

			expect(mockDeps.startBatchRun).not.toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Tests for handleAutoRunOpenSetup
	// ============================================================================

	describe('handleAutoRunOpenSetup', () => {
		it('should open setup modal', () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			act(() => {
				result.current.handleAutoRunOpenSetup();
			});

			expect(mockDeps.setAutoRunSetupModalOpen).toHaveBeenCalledWith(true);
		});
	});

	// ============================================================================
	// Tests for hook memoization
	// ============================================================================

	describe('handler memoization', () => {
		it('should maintain stable handler references when deps unchanged', () => {
			const mockSession = createMockSession();
			const mockDeps = createMockDeps();

			const { result, rerender } = renderHook(() => useAutoRunHandlers(mockSession, mockDeps));

			const firstRender = { ...result.current };
			rerender();
			const secondRender = result.current;

			// Handlers should be the same reference due to useCallback
			expect(firstRender.handleAutoRunContentChange).toBe(secondRender.handleAutoRunContentChange);
			expect(firstRender.handleAutoRunModeChange).toBe(secondRender.handleAutoRunModeChange);
			expect(firstRender.handleAutoRunOpenSetup).toBe(secondRender.handleAutoRunOpenSetup);
		});

		it('should update handlers when session changes', () => {
			const mockSession1 = createMockSession({ id: 'session-1' });
			const mockSession2 = createMockSession({ id: 'session-2' });
			const mockDeps = createMockDeps();

			const { result, rerender } = renderHook(
				({ session }) => useAutoRunHandlers(session, mockDeps),
				{ initialProps: { session: mockSession1 } }
			);

			const firstHandler = result.current.handleAutoRunContentChange;
			rerender({ session: mockSession2 });
			const secondHandler = result.current.handleAutoRunContentChange;

			// Handler should change when session changes
			expect(firstHandler).not.toBe(secondHandler);
		});
	});
});
