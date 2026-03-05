import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunAutoFollow } from '../../../renderer/hooks/batch/useAutoRunAutoFollow';
import type { UseAutoRunAutoFollowDeps } from '../../../renderer/hooks/batch/useAutoRunAutoFollow';
import type { BatchRunState } from '../../../renderer/types';
import { useUIStore } from '../../../renderer/stores/uiStore';

function createBatchState(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return {
		isRunning: false,
		isStopping: false,
		documents: [],
		lockedDocuments: [],
		currentDocumentIndex: 0,
		currentDocTasksTotal: 0,
		currentDocTasksCompleted: 0,
		totalTasksAcrossAllDocs: 0,
		completedTasksAcrossAllDocs: 0,
		loopEnabled: false,
		loopIteration: 0,
		folderPath: '/tmp',
		worktreeActive: false,
		totalTasks: 0,
		completedTasks: 0,
		currentTaskIndex: 0,
		originalContent: '',
		sessionIds: [],
		...overrides,
	};
}

function createDeps(overrides: Partial<UseAutoRunAutoFollowDeps> = {}): UseAutoRunAutoFollowDeps {
	return {
		currentSessionBatchState: null,
		onAutoRunSelectDocument: vi.fn(),
		selectedFile: null,
		setActiveRightTab: vi.fn(),
		rightPanelOpen: true,
		setRightPanelOpen: vi.fn(),
		toggleRightPanel: vi.fn(),
		onAutoRunModeChange: vi.fn(),
		currentMode: 'preview',
		...overrides,
	};
}

describe('useAutoRunAutoFollow', () => {
	beforeEach(() => {
		// Reset the zustand store between tests
		useUIStore.setState({ autoFollowEnabled: false });
	});

	it('should not auto-select when autoFollowEnabled is false', () => {
		const onAutoRunSelectDocument = vi.fn();
		const deps = createDeps({
			onAutoRunSelectDocument,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a', 'doc-b'],
				currentDocumentIndex: 0,
			}),
		});

		renderHook(() => useAutoRunAutoFollow(deps));

		expect(onAutoRunSelectDocument).not.toHaveBeenCalled();
	});

	it('should auto-select document when batch starts and autoFollow is enabled', () => {
		const onAutoRunSelectDocument = vi.fn();
		const deps = createDeps({
			onAutoRunSelectDocument,
			currentSessionBatchState: null,
		});

		const { result, rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: deps }
		);

		// Enable auto-follow
		act(() => {
			result.current.setAutoFollowEnabled(true);
		});

		// Simulate batch start
		const runningDeps = createDeps({
			onAutoRunSelectDocument,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a', 'doc-b'],
				currentDocumentIndex: 0,
			}),
		});

		rerender(runningDeps);

		expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-a');
	});

	it('should auto-select next document on index change', () => {
		const onAutoRunSelectDocument = vi.fn();
		const initialDeps = createDeps({
			onAutoRunSelectDocument,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a', 'doc-b'],
				currentDocumentIndex: 0,
			}),
		});

		const { result, rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: initialDeps }
		);

		// Enable auto-follow
		act(() => {
			result.current.setAutoFollowEnabled(true);
		});

		// Move to next document
		const nextDeps = createDeps({
			onAutoRunSelectDocument,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a', 'doc-b'],
				currentDocumentIndex: 1,
			}),
		});

		rerender(nextDeps);

		expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-b');
	});

	it('should not auto-select if already on correct document', () => {
		const onAutoRunSelectDocument = vi.fn();
		const deps = createDeps({
			onAutoRunSelectDocument,
			selectedFile: 'doc-a',
			currentSessionBatchState: null,
		});

		const { result, rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: deps }
		);

		// Enable auto-follow
		act(() => {
			result.current.setAutoFollowEnabled(true);
		});

		// Start batch with doc-a at index 0, but selectedFile is already doc-a
		const runningDeps = createDeps({
			onAutoRunSelectDocument,
			selectedFile: 'doc-a',
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a', 'doc-b'],
				currentDocumentIndex: 0,
			}),
		});

		rerender(runningDeps);

		expect(onAutoRunSelectDocument).not.toHaveBeenCalled();
	});

	it('should switch to autorun tab on batch start when autoFollow enabled', () => {
		const setActiveRightTab = vi.fn();
		const deps = createDeps({
			setActiveRightTab,
			currentSessionBatchState: createBatchState({ isRunning: false }),
		});

		const { result, rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: deps }
		);

		// Enable auto-follow
		act(() => {
			result.current.setAutoFollowEnabled(true);
		});

		// Transition to running
		const runningDeps = createDeps({
			setActiveRightTab,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a'],
				currentDocumentIndex: 0,
			}),
		});

		rerender(runningDeps);

		expect(setActiveRightTab).toHaveBeenCalledWith('autorun');
	});

	it('should not switch tab when autoFollow is disabled', () => {
		const setActiveRightTab = vi.fn();
		const deps = createDeps({
			setActiveRightTab,
			currentSessionBatchState: createBatchState({ isRunning: false }),
		});

		const { rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: deps }
		);

		// Leave auto-follow off, transition to running
		const runningDeps = createDeps({
			setActiveRightTab,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a'],
				currentDocumentIndex: 0,
			}),
		});

		rerender(runningDeps);

		expect(setActiveRightTab).not.toHaveBeenCalled();
	});

	it('should open right panel on batch start when closed and autoFollow enabled', () => {
		const setRightPanelOpen = vi.fn();
		const deps = createDeps({
			rightPanelOpen: false,
			setRightPanelOpen,
			currentSessionBatchState: createBatchState({ isRunning: false }),
		});

		const { result, rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: deps }
		);

		// Enable auto-follow
		act(() => {
			result.current.setAutoFollowEnabled(true);
		});

		// Transition to running with panel closed
		const runningDeps = createDeps({
			rightPanelOpen: false,
			setRightPanelOpen,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a'],
				currentDocumentIndex: 0,
			}),
		});

		rerender(runningDeps);

		expect(setRightPanelOpen).toHaveBeenCalledWith(true);
	});

	it('should reset refs when batch ends', () => {
		const onAutoRunSelectDocument = vi.fn();
		const deps = createDeps({
			onAutoRunSelectDocument,
			currentSessionBatchState: createBatchState({
				isRunning: true,
				documents: ['doc-a', 'doc-b', 'doc-c'],
				currentDocumentIndex: 0,
			}),
		});

		const { result, rerender } = renderHook(
			(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
			{ initialProps: deps }
		);

		// Enable auto-follow
		act(() => {
			result.current.setAutoFollowEnabled(true);
		});

		// Advance to index 2
		rerender(
			createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b', 'doc-c'],
					currentDocumentIndex: 2,
				}),
			})
		);

		expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-c');
		onAutoRunSelectDocument.mockClear();

		// End batch
		rerender(
			createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: false,
					documents: [],
					currentDocumentIndex: 0,
				}),
			})
		);

		onAutoRunSelectDocument.mockClear();

		// Start new batch from index 0 — should auto-select again
		rerender(
			createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-x', 'doc-y'],
					currentDocumentIndex: 0,
				}),
			})
		);

		expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-x');
	});
});
