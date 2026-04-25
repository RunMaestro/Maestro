/**
 * Tests for useAutoRunDocumentLoader hook
 *
 * Tests cover:
 * - countTasksInContent helper - counts markdown task items
 * - loadTaskCounts - loads and counts tasks for each document
 * - Document loading effect - loads docs when activeSession has autoRunFolderPath
 * - Document loading - skips when no activeSession or no autoRunFolderPath
 * - File watching setup and cleanup
 * - SSH remote ID resolution for document loading
 * - Error handling during document loading
 * - isLoadingDocuments state during loading
 * - Content reload on file change event
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import type { Session } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// ============================================================================
// Now import the hook and stores
// ============================================================================

import { useAutoRunDocumentLoader } from '../../../renderer/hooks/batch/useAutoRunDocumentLoader';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';

// ============================================================================
// Helpers
// ============================================================================

// Thin wrapper: pre-populates an AI tab so the auto run doc loader has a
// tab to hydrate.
function createMockSession(overrides: Partial<Session> = {}): Session {
	return baseCreateMockSession({
		name: 'Test Agent',
		aiTabs: [
			{
				id: 'tab-1',
				label: 'AI',
				type: 'ai',
				logs: [],
				state: 'idle',
			},
		] as any,
		activeTabId: 'tab-1',
		createdAt: Date.now(),
		...overrides,
	});
}

// ============================================================================
// Mock autorun IPC
// ============================================================================

const mockListDocs = vi.fn();
const mockReadDoc = vi.fn();
const mockWatchFolder = vi.fn();
const mockOnFileChanged = vi.fn();
const mockUnwatchFolder = vi.fn();

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset stores to clean state
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		groups: [],
		sessionsLoaded: false,
		initialLoadComplete: false,
	});

	useBatchStore.setState({
		documentList: [],
		documentTree: [],
		isLoadingDocuments: false,
		documentTaskCounts: new Map(),
		batchRunStates: {},
		customPrompts: {},
	});

	// Default mock implementations
	mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });
	mockReadDoc.mockResolvedValue({ success: true, content: '' });
	mockWatchFolder.mockResolvedValue(undefined);
	mockOnFileChanged.mockReturnValue(vi.fn()); // returns unsubscribe fn
	mockUnwatchFolder.mockResolvedValue(undefined);

	// Setup window.maestro
	(window as any).maestro = {
		autorun: {
			listDocs: mockListDocs,
			readDoc: mockReadDoc,
			watchFolder: mockWatchFolder,
			onFileChanged: mockOnFileChanged,
			unwatchFolder: mockUnwatchFolder,
		},
	};
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('useAutoRunDocumentLoader', () => {
	// ========================================================================
	// Return shape
	// ========================================================================

	describe('initialization', () => {
		it('returns loadTaskCounts function', async () => {
			const { result } = renderHook(() => useAutoRunDocumentLoader());

			expect(result.current).toHaveProperty('loadTaskCounts');
			expect(typeof result.current.loadTaskCounts).toBe('function');
		});
	});

	// ========================================================================
	// countTasksInContent (tested indirectly via loadTaskCounts)
	// ========================================================================

	describe('countTasksInContent (via loadTaskCounts)', () => {
		it('counts zero tasks when content has no task items', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: ['doc1'], tree: [] });
			mockReadDoc.mockResolvedValue({
				success: true,
				content: '# A header\n\nSome regular text\n- A plain list item',
			});

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			// loadTaskCounts excludes docs with 0 total tasks from the returned map
			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['doc1']));

			// No tasks found → not added to map
			expect(counts.size).toBe(0);
		});

		it('counts only completed tasks (- [x]) correctly', async () => {
			const content = '- [x] Done task one\n- [x] Done task two\n- [x] Done task three';
			mockReadDoc.mockResolvedValue({ success: true, content });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['myDoc']));

			expect(counts.get('myDoc')).toEqual({ completed: 3, total: 3 });
		});

		it('counts only unchecked tasks (- [ ]) correctly', async () => {
			const content = '- [ ] Todo one\n- [ ] Todo two';
			mockReadDoc.mockResolvedValue({ success: true, content });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['myDoc']));

			expect(counts.get('myDoc')).toEqual({ completed: 0, total: 2 });
		});

		it('counts mixed completed and unchecked tasks', async () => {
			const content = [
				'# Sprint Tasks',
				'',
				'- [x] Task one done',
				'- [ ] Task two pending',
				'- [x] Task three done',
				'- [ ] Task four pending',
				'- [ ] Task five pending',
			].join('\n');
			mockReadDoc.mockResolvedValue({ success: true, content });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['sprint']));

			expect(counts.get('sprint')).toEqual({ completed: 2, total: 5 });
		});

		it('handles asterisk bullet syntax (* [x] and * [ ])', async () => {
			const content = '* [x] Starred done\n* [ ] Starred pending';
			mockReadDoc.mockResolvedValue({ success: true, content });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['starred']));

			expect(counts.get('starred')).toEqual({ completed: 1, total: 2 });
		});

		it('handles indented task items', async () => {
			const content = '  - [x] Indented done\n    - [ ] Nested pending';
			mockReadDoc.mockResolvedValue({ success: true, content });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['indented']));

			expect(counts.get('indented')).toEqual({ completed: 1, total: 2 });
		});
	});

	// ========================================================================
	// loadTaskCounts
	// ========================================================================

	describe('loadTaskCounts', () => {
		it('loads and counts tasks for multiple documents in parallel', async () => {
			mockReadDoc.mockImplementation((_folder, docPath) => {
				if (docPath === 'alpha.md') {
					return Promise.resolve({ success: true, content: '- [x] Done\n- [ ] Pending' });
				}
				if (docPath === 'beta.md') {
					return Promise.resolve({ success: true, content: '- [x] All done' });
				}
				return Promise.resolve({ success: true, content: '' });
			});

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () =>
				result.current.loadTaskCounts('/docs', ['alpha', 'beta'])
			);

			expect(mockReadDoc).toHaveBeenCalledWith('/docs', 'alpha.md', undefined);
			expect(mockReadDoc).toHaveBeenCalledWith('/docs', 'beta.md', undefined);
			expect(counts.get('alpha')).toEqual({ completed: 1, total: 2 });
			expect(counts.get('beta')).toEqual({ completed: 1, total: 1 });
		});

		it('appends .md extension when calling readDoc', async () => {
			mockReadDoc.mockResolvedValue({ success: true, content: '- [x] Task' });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			await act(async () => result.current.loadTaskCounts('/my/folder', ['my-doc']));

			expect(mockReadDoc).toHaveBeenCalledWith('/my/folder', 'my-doc.md', undefined);
		});

		it('passes sshRemoteId to readDoc when provided', async () => {
			mockReadDoc.mockResolvedValue({ success: true, content: '- [x] Done' });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			await act(async () => result.current.loadTaskCounts('/docs', ['remoteDoc'], 'remote-abc'));

			expect(mockReadDoc).toHaveBeenCalledWith('/docs', 'remoteDoc.md', 'remote-abc');
		});

		it('excludes documents with zero total tasks from result map', async () => {
			mockReadDoc.mockResolvedValue({ success: true, content: 'No tasks here at all' });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['empty-doc']));

			expect(counts.has('empty-doc')).toBe(false);
			expect(counts.size).toBe(0);
		});

		it('skips documents where readDoc returns success: false', async () => {
			mockReadDoc.mockResolvedValue({ success: false, content: undefined });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['failed-doc']));

			expect(counts.has('failed-doc')).toBe(false);
		});

		it('skips documents where readDoc returns no content', async () => {
			mockReadDoc.mockResolvedValue({ success: true, content: null });

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['null-doc']));

			expect(counts.has('null-doc')).toBe(false);
		});

		it('ignores errors for individual documents and continues', async () => {
			mockReadDoc.mockImplementation((_folder, docPath) => {
				if (docPath === 'bad.md') {
					return Promise.reject(new Error('Read error'));
				}
				return Promise.resolve({ success: true, content: '- [x] Done' });
			});

			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', ['bad', 'good']));

			// 'bad' fails but 'good' still counted
			expect(counts.has('bad')).toBe(false);
			expect(counts.get('good')).toEqual({ completed: 1, total: 1 });
		});

		it('returns empty map when no documents provided', async () => {
			const { result } = renderHook(() => useAutoRunDocumentLoader());

			const counts = await act(async () => result.current.loadTaskCounts('/docs', []));

			expect(counts.size).toBe(0);
			expect(mockReadDoc).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Document loading effect
	// ========================================================================

	describe('document loading effect', () => {
		it('loads documents when activeSession has autoRunFolderPath', async () => {
			const files = ['doc-one', 'doc-two'];
			const tree = [
				{ name: 'doc-one', type: 'file' },
				{ name: 'doc-two', type: 'file' },
			];
			mockListDocs.mockResolvedValue({ success: true, files, tree });
			mockReadDoc.mockResolvedValue({ success: true, content: '' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/my/autorun/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().documentList).toEqual(files);
			});

			expect(mockListDocs).toHaveBeenCalledWith('/my/autorun/docs', undefined);
			expect(useBatchStore.getState().documentTree).toEqual(tree);
		});

		it('clears document list when no activeSession', async () => {
			// Pre-populate store with stale data
			useBatchStore.setState({
				documentList: ['stale-doc'],
				documentTree: [{ name: 'stale-doc' } as any],
				documentTaskCounts: new Map([['stale-doc', { completed: 1, total: 1 }]]),
			});

			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().documentList).toEqual([]);
			});

			expect(useBatchStore.getState().documentTree).toEqual([]);
			expect(useBatchStore.getState().documentTaskCounts.size).toBe(0);
		});

		it('clears document list when activeSession has no autoRunFolderPath', async () => {
			useBatchStore.setState({
				documentList: ['old-doc'],
				documentTree: [],
				documentTaskCounts: new Map(),
			});

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: undefined,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().documentList).toEqual([]);
			});

			expect(mockListDocs).not.toHaveBeenCalled();
		});

		it('sets isLoadingDocuments true before loading and false after', async () => {
			let resolveList: (v: any) => void;
			const listPromise = new Promise((res) => {
				resolveList = res;
			});
			mockListDocs.mockReturnValue(listPromise);

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			// Becomes true while loading
			await waitFor(() => {
				expect(useBatchStore.getState().isLoadingDocuments).toBe(true);
			});

			// Resolve the list fetch
			await act(async () => {
				resolveList!({ success: true, files: [], tree: [] });
			});

			await waitFor(() => {
				expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
			});
		});

		it('sets isLoadingDocuments to false even when listDocs fails', async () => {
			mockListDocs.mockResolvedValue({ success: false });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
			});
		});

		it('loads task counts for all documents returned by listDocs', async () => {
			const files = ['sprint', 'backlog'];
			mockListDocs.mockResolvedValue({ success: true, files, tree: [] });
			mockReadDoc.mockImplementation((_folder, docPath) => {
				if (docPath === 'sprint.md') {
					return Promise.resolve({ success: true, content: '- [x] Done\n- [ ] Pending' });
				}
				return Promise.resolve({ success: true, content: '- [ ] Not started' });
			});

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/work',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				const counts = useBatchStore.getState().documentTaskCounts;
				expect(counts.has('sprint')).toBe(true);
				expect(counts.has('backlog')).toBe(true);
			});

			const counts = useBatchStore.getState().documentTaskCounts;
			expect(counts.get('sprint')).toEqual({ completed: 1, total: 2 });
			expect(counts.get('backlog')).toEqual({ completed: 0, total: 1 });
		});

		it('does not call listDocs when listResult.success is false', async () => {
			mockListDocs.mockResolvedValue({ success: false });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
			});

			// readDoc should not be called when listDocs fails
			expect(mockReadDoc).not.toHaveBeenCalled();
		});

		it('handles listDocs returning undefined files gracefully', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: undefined, tree: undefined });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().documentList).toEqual([]);
			});

			expect(useBatchStore.getState().documentTree).toEqual([]);
		});
	});

	// ========================================================================
	// SSH remote ID resolution
	// ========================================================================

	describe('SSH remote ID resolution', () => {
		it('uses sshRemoteId from session when present', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/remote/docs',
				sshRemoteId: 'ssh-remote-xyz',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/remote/docs', 'ssh-remote-xyz');
			});
		});

		it('falls back to sessionSshRemoteConfig.remoteId when sshRemoteId is absent', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/remote/docs',
				sshRemoteId: undefined,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'config-remote-id',
				},
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/remote/docs', 'config-remote-id');
			});
		});

		it('uses no remote ID when neither sshRemoteId nor sessionSshRemoteConfig is set', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/local/docs',
				sshRemoteId: undefined,
				sessionSshRemoteConfig: undefined,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/local/docs', undefined);
			});
		});

		it('passes SSH remote ID to loadTaskCounts during initial load', async () => {
			const files = ['task-doc'];
			mockListDocs.mockResolvedValue({ success: true, files, tree: [] });
			mockReadDoc.mockResolvedValue({ success: true, content: '- [x] Done' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/remote/docs',
				sshRemoteId: 'my-ssh-remote',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockReadDoc).toHaveBeenCalledWith('/remote/docs', 'task-doc.md', 'my-ssh-remote');
			});
		});
	});

	// ========================================================================
	// Content reload for selected file
	// ========================================================================

	describe('selected file content loading', () => {
		it('reads and stores content for autoRunSelectedFile when session has one', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: ['my-doc'], tree: [] });
			mockReadDoc.mockImplementation((_folder, docPath) => {
				if (docPath === 'my-doc.md') {
					return Promise.resolve({ success: true, content: '# My Document\n\n- [x] Done' });
				}
				return Promise.resolve({ success: true, content: '' });
			});

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'my-doc',
				autoRunContent: '',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				const sessions = useSessionStore.getState().sessions;
				const updated = sessions.find((s) => s.id === 'session-1');
				expect(updated?.autoRunContent).toBe('# My Document\n\n- [x] Done');
			});
		});

		it('increments autoRunContentVersion when loading selected file content', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: ['doc'], tree: [] });
			mockReadDoc.mockResolvedValue({ success: true, content: 'some content' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'doc',
				autoRunContent: '',
				autoRunContentVersion: 5,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				const sessions = useSessionStore.getState().sessions;
				const updated = sessions.find((s) => s.id === 'session-1');
				expect(updated?.autoRunContentVersion).toBe(6);
			});
		});

		it('sets autoRunContent to empty string when readDoc fails for selected file', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: ['doc'], tree: [] });
			mockReadDoc.mockResolvedValue({ success: false, content: undefined });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'doc',
				autoRunContent: 'old content',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				const sessions = useSessionStore.getState().sessions;
				const updated = sessions.find((s) => s.id === 'session-1');
				expect(updated?.autoRunContent).toBe('');
			});
		});

		it('does not call readDoc for selected file when no autoRunSelectedFile', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: undefined,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
			});

			// readDoc should only be called for task counts (no files), not for selected file
			expect(mockReadDoc).not.toHaveBeenCalled();
		});

		it('only updates the active session, not other sessions', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: ['doc'], tree: [] });
			mockReadDoc.mockResolvedValue({ success: true, content: 'active content' });

			const session1 = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'doc',
				autoRunContent: 'original',
			});
			const session2 = createMockSession({
				id: 'session-2',
				autoRunFolderPath: undefined,
				autoRunContent: 'untouched',
			});
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				const sessions = useSessionStore.getState().sessions;
				const s1 = sessions.find((s) => s.id === 'session-1');
				expect(s1?.autoRunContent).toBe('active content');
			});

			const sessions = useSessionStore.getState().sessions;
			const s2 = sessions.find((s) => s.id === 'session-2');
			expect(s2?.autoRunContent).toBe('untouched');
		});
	});

	// ========================================================================
	// File watching setup and cleanup
	// ========================================================================

	describe('file watching', () => {
		it('calls watchFolder when session has autoRunFolderPath', async () => {
			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/watch/this',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockWatchFolder).toHaveBeenCalledWith('/watch/this', undefined);
			});
		});

		it('does not call watchFolder when no autoRunFolderPath', async () => {
			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: undefined,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			// Allow effects to settle
			await act(async () => {});

			expect(mockWatchFolder).not.toHaveBeenCalled();
		});

		it('does not call watchFolder when no session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			renderHook(() => useAutoRunDocumentLoader());

			await act(async () => {});

			expect(mockWatchFolder).not.toHaveBeenCalled();
		});

		it('passes sshRemoteId to watchFolder', async () => {
			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/remote/watch',
				sshRemoteId: 'remote-watch-id',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockWatchFolder).toHaveBeenCalledWith('/remote/watch', 'remote-watch-id');
			});
		});

		it('subscribes to onFileChanged events', async () => {
			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/my/folder',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockOnFileChanged).toHaveBeenCalled();
			});
		});

		it('calls unwatchFolder and unsubscribes onFileChanged when unmounted', async () => {
			const mockUnsubscribe = vi.fn();
			mockOnFileChanged.mockReturnValue(mockUnsubscribe);

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/watch/path',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { unmount } = renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockWatchFolder).toHaveBeenCalled();
			});

			unmount();

			expect(mockUnwatchFolder).toHaveBeenCalledWith('/watch/path');
			expect(mockUnsubscribe).toHaveBeenCalled();
		});

		it('calls unwatchFolder with previous path when folderPath changes', async () => {
			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/old/folder',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { rerender } = renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockWatchFolder).toHaveBeenCalledWith('/old/folder', undefined);
			});

			// Switch to a new folder
			const updatedSession = { ...session, autoRunFolderPath: '/new/folder' };
			act(() => {
				useSessionStore.setState({ sessions: [updatedSession], activeSessionId: 'session-1' });
			});

			rerender();

			await waitFor(() => {
				expect(mockUnwatchFolder).toHaveBeenCalledWith('/old/folder');
				expect(mockWatchFolder).toHaveBeenCalledWith('/new/folder', undefined);
			});
		});
	});

	// ========================================================================
	// File change event handling
	// ========================================================================

	describe('onFileChanged event handling', () => {
		it('reloads document list when a file change event fires for the watched folder', async () => {
			let fileChangedCallback: ((data: any) => void) | null = null;
			mockOnFileChanged.mockImplementation((cb) => {
				fileChangedCallback = cb;
				return vi.fn();
			});

			const updatedFiles = ['doc-a', 'doc-b', 'new-doc'];
			// Initial load returns 2 files, after change returns 3
			mockListDocs
				.mockResolvedValueOnce({ success: true, files: ['doc-a', 'doc-b'], tree: [] })
				.mockResolvedValueOnce({ success: true, files: updatedFiles, tree: [] });

			mockReadDoc.mockResolvedValue({ success: true, content: '' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/watched/folder',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			// Wait for initial load and subscription
			await waitFor(() => {
				expect(fileChangedCallback).not.toBeNull();
				expect(useBatchStore.getState().documentList).toEqual(['doc-a', 'doc-b']);
			});

			// Fire the file change event
			await act(async () => {
				fileChangedCallback!({ folderPath: '/watched/folder', filename: 'new-doc' });
			});

			await waitFor(() => {
				expect(useBatchStore.getState().documentList).toEqual(updatedFiles);
			});
		});

		it('ignores file change events for a different folder', async () => {
			let fileChangedCallback: ((data: any) => void) | null = null;
			mockOnFileChanged.mockImplementation((cb) => {
				fileChangedCallback = cb;
				return vi.fn();
			});

			mockListDocs.mockResolvedValue({ success: true, files: ['doc-a'], tree: [] });
			mockReadDoc.mockResolvedValue({ success: true, content: '' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/my/folder',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(fileChangedCallback).not.toBeNull();
			});

			const callCountBefore = mockListDocs.mock.calls.length;

			// Fire event for a different folder
			await act(async () => {
				fileChangedCallback!({ folderPath: '/different/folder', filename: 'some-file' });
			});

			// listDocs should not have been called again
			expect(mockListDocs.mock.calls.length).toBe(callCountBefore);
		});

		it('reloads selected file content when changed file matches autoRunSelectedFile', async () => {
			let fileChangedCallback: ((data: any) => void) | null = null;
			mockOnFileChanged.mockImplementation((cb) => {
				fileChangedCallback = cb;
				return vi.fn();
			});

			mockListDocs.mockResolvedValue({ success: true, files: ['active-doc'], tree: [] });
			// Call sequence:
			// 1. task count for 'active-doc' (initial effect)
			// 2. selected file content for 'active-doc' (initial effect)
			// 3. task count for 'active-doc' (file change re-load)
			// 4. selected file content for 'active-doc' (file change re-load)
			mockReadDoc
				.mockResolvedValueOnce({ success: true, content: '- [x] Done' }) // 1: initial task count
				.mockResolvedValueOnce({ success: true, content: 'initial content' }) // 2: initial selected file
				.mockResolvedValueOnce({ success: true, content: '- [x] Done' }) // 3: file change task count
				.mockResolvedValueOnce({ success: true, content: 'updated content' }); // 4: file change selected file

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'active-doc',
				autoRunContent: '',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			// Wait for subscription to be set up
			await waitFor(() => {
				expect(fileChangedCallback).not.toBeNull();
			});

			// Fire a file change for the selected document
			await act(async () => {
				fileChangedCallback!({
					folderPath: '/docs',
					filename: 'active-doc',
				});
			});

			await waitFor(() => {
				const sessions = useSessionStore.getState().sessions;
				const updated = sessions.find((s) => s.id === 'session-1');
				expect(updated?.autoRunContent).toBe('updated content');
			});
		});

		it('does not reload file content when changed file does not match selected file', async () => {
			let fileChangedCallback: ((data: any) => void) | null = null;
			mockOnFileChanged.mockImplementation((cb) => {
				fileChangedCallback = cb;
				return vi.fn();
			});

			mockListDocs.mockResolvedValue({ success: true, files: ['doc-a', 'doc-b'], tree: [] });
			mockReadDoc.mockResolvedValue({ success: true, content: 'selected content' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'doc-a',
				autoRunContent: 'selected content',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(fileChangedCallback).not.toBeNull();
			});

			const initialContent = useSessionStore
				.getState()
				.sessions.find((s) => s.id === 'session-1')?.autoRunContent;

			// Fire event for a different file (doc-b), not the selected one (doc-a)
			await act(async () => {
				fileChangedCallback!({ folderPath: '/docs', filename: 'doc-b' });
			});

			// content should remain the same — only listDocs + task counts reload
			const afterContent = useSessionStore
				.getState()
				.sessions.find((s) => s.id === 'session-1')?.autoRunContent;

			// Since the content is managed by the session store and we
			// expect no second write for the wrong file, content is stable
			expect(afterContent).toBe(initialContent);
		});

		it('increments autoRunContentVersion on file change content reload', async () => {
			let fileChangedCallback: ((data: any) => void) | null = null;
			mockOnFileChanged.mockImplementation((cb) => {
				fileChangedCallback = cb;
				return vi.fn();
			});

			mockListDocs.mockResolvedValue({ success: true, files: ['doc'], tree: [] });
			mockReadDoc.mockResolvedValue({ success: true, content: 'new content from disk' });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
				autoRunSelectedFile: 'doc',
				autoRunContent: '',
				autoRunContentVersion: 3,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(fileChangedCallback).not.toBeNull();
			});

			// Capture current version after initial load
			await waitFor(() => {
				const s = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
				// After initial load, version incremented once
				expect(s?.autoRunContentVersion).toBeGreaterThan(3);
			});

			const versionAfterInit = useSessionStore
				.getState()
				.sessions.find((s) => s.id === 'session-1')!.autoRunContentVersion!;

			// Fire file change
			await act(async () => {
				fileChangedCallback!({ folderPath: '/docs', filename: 'doc' });
			});

			await waitFor(() => {
				const s = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
				expect(s?.autoRunContentVersion).toBe(versionAfterInit + 1);
			});
		});

		it('updates task counts on file change event', async () => {
			let fileChangedCallback: ((data: any) => void) | null = null;
			mockOnFileChanged.mockImplementation((cb) => {
				fileChangedCallback = cb;
				return vi.fn();
			});

			mockListDocs.mockResolvedValue({ success: true, files: ['task-doc'], tree: [] });
			// First call: initial task count (no tasks found, not added to map)
			// Second call: after file change, task count returns tasks
			mockReadDoc
				.mockResolvedValueOnce({ success: true, content: '' }) // initial task count (no tasks)
				.mockResolvedValueOnce({ success: true, content: '- [x] Done\n- [ ] Pending' }); // after file change

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(fileChangedCallback).not.toBeNull();
			});

			// Fire file change
			await act(async () => {
				fileChangedCallback!({ folderPath: '/docs', filename: 'task-doc' });
			});

			await waitFor(() => {
				const counts = useBatchStore.getState().documentTaskCounts;
				expect(counts.has('task-doc')).toBe(true);
			});

			const counts = useBatchStore.getState().documentTaskCounts;
			expect(counts.get('task-doc')).toEqual({ completed: 1, total: 2 });
		});
	});

	// ========================================================================
	// Error handling
	// ========================================================================

	describe('error handling', () => {
		it('stores remain in a consistent state when listDocs returns success: false', async () => {
			// When listDocs returns failure, document state should be cleared/untouched
			mockListDocs.mockResolvedValue({ success: false });

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			// isLoadingDocuments should become false again after the failed load
			await waitFor(() => {
				expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
			});

			// documentList should remain empty (not populated on failed list)
			expect(useBatchStore.getState().documentList).toEqual([]);
		});

		it('handles individual readDoc errors during task counting without crashing', async () => {
			mockListDocs.mockResolvedValue({ success: true, files: ['bad', 'good'], tree: [] });
			mockReadDoc.mockImplementation((_folder, docPath) => {
				if (docPath === 'bad.md') return Promise.reject(new Error('Read failed'));
				return Promise.resolve({ success: true, content: '- [x] OK' });
			});

			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/docs',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				const counts = useBatchStore.getState().documentTaskCounts;
				expect(counts.has('good')).toBe(true);
			});

			// 'bad' should not appear in counts, 'good' should
			const counts = useBatchStore.getState().documentTaskCounts;
			expect(counts.has('bad')).toBe(false);
			expect(counts.get('good')).toEqual({ completed: 1, total: 1 });
		});
	});

	// ========================================================================
	// Re-render / reactivity
	// ========================================================================

	describe('reactivity', () => {
		it('re-runs document loading when activeSessionId changes', async () => {
			const session1 = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/folder-one',
			});
			const session2 = createMockSession({
				id: 'session-2',
				autoRunFolderPath: '/folder-two',
			});

			mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });

			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/folder-one', undefined);
			});

			// Switch active session
			act(() => {
				useSessionStore.setState({ activeSessionId: 'session-2' });
			});

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/folder-two', undefined);
			});
		});

		it('re-runs document loading when autoRunFolderPath changes', async () => {
			const session = createMockSession({
				id: 'session-1',
				autoRunFolderPath: '/initial/path',
			});

			mockListDocs.mockResolvedValue({ success: true, files: [], tree: [] });

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useAutoRunDocumentLoader());

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/initial/path', undefined);
			});

			act(() => {
				useSessionStore.setState({
					sessions: [{ ...session, autoRunFolderPath: '/new/path' }],
					activeSessionId: 'session-1',
				});
			});

			await waitFor(() => {
				expect(mockListDocs).toHaveBeenCalledWith('/new/path', undefined);
			});
		});
	});
});
