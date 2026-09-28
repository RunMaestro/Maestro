/**
 * Regression tests for `handleAutoRunRefresh`.
 *
 * "Refresh document list" re-reads the Auto Run folder. The per-document task
 * counts live in a separate cache in the batch store that was never refreshed,
 * so a document edited on disk kept its stale count until the app was
 * restarted (#1529). A refresh now re-reads the counts the same way the
 * document loader does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks';
import type { Session } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';

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

const DOC_CONTENT: Record<string, string> = {
	'Phase 1.md': '- [x] done\n- [ ] todo\n- [ ] todo again\n',
	'Phase 2.md': '- [x] a\n- [x] b\n',
};

describe('handleAutoRunRefresh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const session = createSession();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as any);
		useBatchStore.getState().setDocumentTaskCounts(
			new Map([
				['Phase 1', { completed: 1, total: 4 }],
				['Phase 2', { completed: 0, total: 2 }],
			])
		);
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(
			async (_folder: string, file: string) => ({
				success: true,
				content: DOC_CONTENT[file] ?? '',
			})
		);
	});

	it('re-reads the task counts from disk so edited documents show fresh counts', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['Phase 1', 'Phase 2'],
			tree: [],
		});
		const deps = createDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		await act(async () => {
			await result.current.handleAutoRunRefresh({ silent: true });
		});

		expect(deps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
		expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
			'/projects/autorun-docs',
			'Phase 1.md',
			undefined
		);
		const counts = useBatchStore.getState().documentTaskCounts;
		expect(counts.get('Phase 1')).toEqual({ completed: 1, total: 3 });
		expect(counts.get('Phase 2')).toEqual({ completed: 2, total: 2 });
		expect(counts.size).toBe(2);
	});

	it('keeps the cached task counts when listing the folder fails', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: false,
			error: 'boom',
		});
		const deps = createDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		await act(async () => {
			await result.current.handleAutoRunRefresh({ silent: true });
		});

		expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();
		expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
		expect(useBatchStore.getState().documentTaskCounts.get('Phase 1')).toEqual({
			completed: 1,
			total: 4,
		});
	});

	it('leaves the loading flag to the newer refresh when an older one settles late', async () => {
		type ListResult = { success: boolean; files: string[]; tree: never[] };
		const resolvers: Array<(value: ListResult) => void> = [];
		vi.mocked(window.maestro.autorun.listDocs).mockImplementation(
			() =>
				new Promise<ListResult>((resolve) => {
					resolvers.push(resolve);
				}) as never
		);
		const deps = createDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		let first: Promise<void> = Promise.resolve();
		let second: Promise<void> = Promise.resolve();
		act(() => {
			first = result.current.handleAutoRunRefresh({ silent: true });
			second = result.current.handleAutoRunRefresh({ silent: true });
		});
		await act(async () => {
			resolvers[0]({ success: true, files: ['Phase 1'], tree: [] });
			await first;
		});
		// The superseded refresh settled, but the newer one is still loading.
		expect(deps.setAutoRunIsLoadingDocuments).not.toHaveBeenCalledWith(false);
		expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();

		await act(async () => {
			resolvers[1]({ success: true, files: ['Phase 1', 'Phase 2'], tree: [] });
			await second;
		});
		expect(deps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
		expect(deps.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);
	});

	it('discards a refresh that finishes after the user switched to another session', async () => {
		let resolveList: (value: {
			success: boolean;
			files: string[];
			tree: never[];
		}) => void = () => {};
		vi.mocked(window.maestro.autorun.listDocs).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveList = resolve;
			})
		);
		const deps = createDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		let refresh: Promise<void> = Promise.resolve();
		act(() => {
			refresh = result.current.handleAutoRunRefresh({ silent: true });
		});
		// The user switches sessions while the listing is still in flight.
		useSessionStore.setState({ activeSessionId: 'session-2' } as any);
		await act(async () => {
			resolveList({ success: true, files: ['Phase 1', 'Phase 2'], tree: [] });
			await refresh;
		});

		expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();
		expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
		expect(useBatchStore.getState().documentTaskCounts.get('Phase 1')).toEqual({
			completed: 1,
			total: 4,
		});
		expect(deps.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);
	});
});
