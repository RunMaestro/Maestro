/**
 * Regression tests for `handleAutoRunRefresh`.
 *
 * "Refresh document list" re-reads the Auto Run folder. The per-document task
 * counts live in a separate cache in the batch store that was never
 * invalidated, so a document edited on disk kept its stale count until the app
 * was restarted (#1529).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks';
import type { Session } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';
import { useBatchStore } from '../../../../renderer/stores/batchStore';

const createSession = (overrides: Partial<Session> = {}): Session =>
	createMockSession({
		id: 'session-1',
		autoRunFolderPath: '/projects/autorun-docs',
		...overrides,
	});

const createDeps = () => ({
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
	autoRunDocumentList: ['Phase 1'],
	startBatchRun: vi.fn(),
});

describe('handleAutoRunRefresh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useBatchStore.getState().setDocumentTaskCounts(
			new Map([
				['Phase 1', { completed: 1, total: 4 }],
				['Phase 2', { completed: 0, total: 2 }],
			])
		);
	});

	it('invalidates the cached task counts so edited documents are re-read from disk', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['Phase 1', 'Phase 2'],
			tree: [],
		});
		const deps = createDeps();
		const { result } = renderHook(() => useAutoRunHandlers(createSession(), deps));

		await act(async () => {
			await result.current.handleAutoRunRefresh({ silent: true });
		});

		expect(deps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
		expect(useBatchStore.getState().documentTaskCounts.size).toBe(0);
	});

	it('keeps the cached task counts when listing the folder fails', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: false,
			error: 'boom',
		});
		const deps = createDeps();
		const { result } = renderHook(() => useAutoRunHandlers(createSession(), deps));

		await act(async () => {
			await result.current.handleAutoRunRefresh({ silent: true });
		});

		expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();
		expect(useBatchStore.getState().documentTaskCounts.size).toBe(2);
	});
});
