import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoRunHandlers } from '../../renderer/hooks/batch/useAutoRunHandlers';
import type { BatchRunConfig, Session } from '../../renderer/types';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { gitService } from '../../renderer/services/git';
import { notifyToast } from '../../renderer/stores/notificationStore';
import {
	clearRecentlyCreatedWorktreePath,
	markWorktreePathAsRecentlyCreated,
} from '../../renderer/utils/worktreeDedup';

vi.mock('../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
	},
}));

vi.mock('../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

vi.mock('../../renderer/utils/worktreeDedup', () => ({
	markWorktreePathAsRecentlyCreated: vi.fn(),
	clearRecentlyCreatedWorktreePath: vi.fn(),
	isRecentlyCreatedWorktreePath: vi.fn(() => false),
	normalizePath: (path: string) => path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, ''),
	sessionMatchesWorktreeRoot: (session: Session, normalizedRoot: string) =>
		(session.projectRoot &&
			session.projectRoot.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') ===
				normalizedRoot) ||
		(session.cwd &&
			session.cwd.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') === normalizedRoot),
}));

const baseDocuments = [
	{ id: 'phase-1', filename: 'Phase 1', resetOnCompletion: false, isDuplicate: false },
];

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Parent Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/app',
		fullPath: '/repo/app',
		projectRoot: '/repo/app',
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
		autoRunFolderPath: '/repo/Auto Run Docs',
		autoRunSelectedFile: 'Phase 1',
		autoRunContent: '# Phase 1',
		autoRunContentVersion: 1,
		autoRunMode: 'edit',
		worktreeConfig: { basePath: '/repo/worktrees' },
		...overrides,
	} as Session;
}

function deps(overrides = {}) {
	return {
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
		autoRunDocumentList: ['Phase 1', 'Phase 2'],
		startBatchRun: vi.fn(),
		...overrides,
	};
}

function applySessionSetter(setSessions: ReturnType<typeof vi.fn>, sessions: Session[]) {
	const updater = setSessions.mock.calls.at(-1)?.[0] as (previous: Session[]) => Session[];
	return updater(sessions);
}

describe('useAutoRunHandlers integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
			success: true,
			files: ['Phase 1', 'Phase 2'],
			tree: [{ name: 'Phase 1.md', type: 'file', path: 'Phase 1.md' }],
		});
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
			success: true,
			content: '- [ ] First task\n- [x] Done\n- [ ] Second task',
		});
		vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/picked/docs');
		vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({ success: true });
		vi.mocked(gitService.getBranches).mockResolvedValue(['feature/run', 'main']);
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as any);
		useSettingsStore.setState({
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		} as any);
	});

	it('loads folders, selects the first document, and handles failed folder scans', async () => {
		const active = session({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } });
		const harness = deps();
		const { result, rerender } = renderHook(({ current }) => useAutoRunHandlers(current, harness), {
			initialProps: { current: active as Session | null },
		});

		await act(async () => {
			await result.current.handleAutoRunFolderSelected('/remote/docs');
		});

		expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/remote/docs', 'remote-1');
		expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
			'/remote/docs',
			'Phase 1.md',
			'remote-1'
		);
		expect(harness.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
		expect(harness.setAutoRunDocumentTree).toHaveBeenCalledWith([
			{ name: 'Phase 1.md', type: 'file', path: 'Phase 1.md' },
		]);
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunFolderPath: '/remote/docs',
			autoRunSelectedFile: 'Phase 1',
			autoRunContent: '- [ ] First task\n- [x] Done\n- [ ] Second task',
			autoRunContentVersion: 2,
		});
		expect(harness.setAutoRunSetupModalOpen).toHaveBeenCalledWith(false);
		expect(harness.setActiveRightTab).toHaveBeenCalledWith('autorun');
		expect(harness.setRightPanelOpen).toHaveBeenCalledWith(true);
		expect(harness.setActiveFocus).toHaveBeenCalledWith('right');

		vi.mocked(window.maestro.autorun.listDocs).mockRejectedValueOnce(new Error('scan failed'));
		await act(async () => {
			await result.current.handleAutoRunFolderSelected('/broken/docs');
		});
		expect(harness.setAutoRunDocumentList).toHaveBeenLastCalledWith([]);
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunFolderPath: '/broken/docs',
			autoRunSelectedFile: undefined,
			autoRunContent: '',
		});

		rerender({ current: null });
		await act(async () => {
			await result.current.handleAutoRunFolderSelected('/ignored');
		});
		expect(window.maestro.autorun.listDocs).toHaveBeenCalledTimes(2);
	});

	it('updates content, mode, scroll state, selected documents, task counts, and new docs', async () => {
		const active = session();
		const harness = deps();
		const { result } = renderHook(() => useAutoRunHandlers(active, harness));

		await act(async () => result.current.handleAutoRunContentChange('updated'));
		expect(applySessionSetter(harness.setSessions, [active])[0].autoRunContent).toBe('updated');

		act(() => result.current.handleAutoRunModeChange('preview'));
		expect(applySessionSetter(harness.setSessions, [active])[0].autoRunMode).toBe('preview');

		act(() =>
			result.current.handleAutoRunStateChange({
				mode: 'edit',
				cursorPosition: 12,
				editScrollPos: 34,
				previewScrollPos: 56,
			})
		);
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunMode: 'edit',
			autoRunCursorPosition: 12,
			autoRunEditScrollPos: 34,
			autoRunPreviewScrollPos: 56,
		});

		await act(async () => result.current.handleAutoRunSelectDocument('Phase 2'));
		expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
			'/repo/Auto Run Docs',
			'Phase 2.md',
			undefined
		);
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunSelectedFile: 'Phase 2',
			autoRunContent: '- [ ] First task\n- [x] Done\n- [ ] Second task',
			autoRunContentVersion: 2,
		});

		await expect(result.current.getDocumentTaskCount('Phase 2')).resolves.toBe(2);
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({ success: false });
		await expect(result.current.getDocumentTaskCount('Missing')).resolves.toBe(0);

		await expect(result.current.handleAutoRunCreateDocument('Phase 3')).resolves.toBe(true);
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/Auto Run Docs',
			'Phase 3.md',
			'',
			undefined
		);
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunSelectedFile: 'Phase 3',
			autoRunContent: '',
			autoRunMode: 'edit',
		});

		vi.mocked(window.maestro.autorun.writeDoc).mockRejectedValueOnce(new Error('write failed'));
		await expect(result.current.handleAutoRunCreateDocument('Broken')).resolves.toBe(false);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to create document:',
			undefined,
			expect.any(Error)
		);
	});

	it('covers null-session guards and folder-selection fallbacks', async () => {
		const harness = deps();
		const { result, rerender } = renderHook(({ current }) => useAutoRunHandlers(current, harness), {
			initialProps: { current: null as Session | null },
		});

		await act(async () => result.current.handleAutoRunFolderSelected('/ignored'));
		await act(async () =>
			result.current.handleStartBatchRun({
				documents: baseDocuments,
				prompt: 'missing session',
				loopEnabled: false,
			})
		);
		await expect(result.current.getDocumentTaskCount('Anything')).resolves.toBe(0);
		await act(async () => result.current.handleAutoRunContentChange('ignored'));
		act(() => result.current.handleAutoRunModeChange('preview'));
		act(() =>
			result.current.handleAutoRunStateChange({
				mode: 'preview',
				cursorPosition: 1,
				editScrollPos: 2,
				previewScrollPos: 3,
			})
		);
		await act(async () => result.current.handleAutoRunSelectDocument('Anything'));
		await act(async () => result.current.handleAutoRunRefresh());
		await expect(result.current.handleAutoRunCreateDocument('Anything')).resolves.toBe(false);

		expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();
		expect(harness.startBatchRun).not.toHaveBeenCalled();
		expect(harness.setSessions).not.toHaveBeenCalled();

		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValueOnce(null as any);
		await act(async () => result.current.handleAutoRunOpenSetup());
		expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);

		const active = session({ autoRunContentVersion: undefined });
		rerender({ current: active });

		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
		});
		await act(async () => result.current.handleAutoRunFolderSelected('/empty/docs'));
		expect(harness.setAutoRunDocumentList).toHaveBeenLastCalledWith([]);
		expect(harness.setAutoRunDocumentTree).toHaveBeenLastCalledWith([]);
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({
				id: active.id,
				autoRunFolderPath: '/empty/docs',
				autoRunSelectedFile: undefined,
				autoRunContent: '',
				autoRunContentVersion: 1,
			}),
			expect.objectContaining({ id: 'other' }),
		]);

		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['Empty'],
		});
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({ success: false });
		await act(async () => result.current.handleAutoRunFolderSelected('/failed-content'));
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunSelectedFile: 'Empty',
			autoRunContent: '',
		});

		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['Untitled'],
		});
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({ success: true });
		await act(async () => result.current.handleAutoRunFolderSelected('/blank-content'));
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunSelectedFile: 'Untitled',
			autoRunContent: '',
		});

		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: false,
		});
		await act(async () => result.current.handleAutoRunFolderSelected('/failed-list'));
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({
				id: active.id,
				autoRunFolderPath: '/failed-list',
				autoRunSelectedFile: undefined,
				autoRunContent: '',
				autoRunContentVersion: 1,
			}),
			expect.objectContaining({ id: 'other' }),
		]);
	});

	it('refreshes document lists and opens setup through local, existing, and SSH paths', async () => {
		const active = session();
		const harness = deps({ autoRunDocumentList: ['Phase 1'] });
		const { result, rerender } = renderHook(({ current }) => useAutoRunHandlers(current, harness), {
			initialProps: { current: active as Session | null },
		});

		await act(async () => result.current.handleAutoRunRefresh());
		expect(harness.setAutoRunIsLoadingDocuments).toHaveBeenNthCalledWith(1, true);
		expect(harness.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);
		expect(harness.setSuccessFlashNotification).toHaveBeenCalledWith('Found 1 new document');

		await act(async () => {
			await result.current.handleAutoRunOpenSetup();
		});
		expect(harness.setAutoRunSetupModalOpen).toHaveBeenCalledWith(true);

		rerender({ current: session({ autoRunFolderPath: '' }) });
		await act(async () => {
			await result.current.handleAutoRunOpenSetup();
		});
		expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		await waitFor(() =>
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/picked/docs', undefined)
		);

		rerender({
			current: session({
				autoRunFolderPath: '',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-2' },
			}),
		});
		await act(async () => {
			await result.current.handleAutoRunOpenSetup();
		});
		expect(harness.setAutoRunSetupModalOpen).toHaveBeenLastCalledWith(true);
	});

	it('covers refresh, selection, task-count, and create-document fallbacks', async () => {
		const active = session({ autoRunContentVersion: undefined });
		const harness = deps({ autoRunDocumentList: ['Phase 1', 'Phase 2'] });
		const { result } = renderHook(() => useAutoRunHandlers(active, harness));

		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({
			success: true,
			content: '- [x] Done',
		});
		await expect(result.current.getDocumentTaskCount('Done')).resolves.toBe(0);

		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({ success: false });
		await act(async () => result.current.handleAutoRunSelectDocument('Failed'));
		expect(applySessionSetter(harness.setSessions, [active])[0]).toMatchObject({
			autoRunSelectedFile: 'Failed',
			autoRunContent: '',
			autoRunContentVersion: 1,
		});

		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({ success: true });
		await act(async () => result.current.handleAutoRunSelectDocument('Blank'));
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({
				id: active.id,
				autoRunSelectedFile: 'Blank',
				autoRunContent: '',
				autoRunContentVersion: 1,
			}),
			expect.objectContaining({ id: 'other' }),
		]);

		await act(async () => result.current.handleAutoRunContentChange('updated again'));
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({ id: active.id, autoRunContent: 'updated again' }),
			expect.objectContaining({ id: 'other' }),
		]);

		act(() => result.current.handleAutoRunModeChange('preview'));
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({ id: active.id, autoRunMode: 'preview' }),
			expect.objectContaining({ id: 'other' }),
		]);

		act(() =>
			result.current.handleAutoRunStateChange({
				mode: 'edit',
				cursorPosition: 4,
				editScrollPos: 5,
				previewScrollPos: 6,
			})
		);
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({
				id: active.id,
				autoRunMode: 'edit',
				autoRunCursorPosition: 4,
				autoRunEditScrollPos: 5,
				autoRunPreviewScrollPos: 6,
			}),
			expect.objectContaining({ id: 'other' }),
		]);

		vi.useFakeTimers();
		try {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
				success: true,
				files: ['Phase 1'],
			});
			await act(async () => result.current.handleAutoRunRefresh());
			expect(harness.setSuccessFlashNotification).toHaveBeenCalledWith('1 document removed');
			act(() => {
				vi.runOnlyPendingTimers();
			});
			expect(harness.setSuccessFlashNotification).toHaveBeenLastCalledWith(null);
		} finally {
			vi.useRealTimers();
		}

		const pluralAddedHarness = deps({ autoRunDocumentList: [] });
		const { result: pluralAddedResult } = renderHook(() =>
			useAutoRunHandlers(active, pluralAddedHarness)
		);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['One', 'Two'],
		});
		await act(async () => pluralAddedResult.current.handleAutoRunRefresh());
		expect(pluralAddedHarness.setSuccessFlashNotification).toHaveBeenCalledWith(
			'Found 2 new documents'
		);

		const pluralRemovedHarness = deps({ autoRunDocumentList: ['One', 'Two', 'Three'] });
		const { result: pluralRemovedResult } = renderHook(() =>
			useAutoRunHandlers(active, pluralRemovedHarness)
		);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['One'],
		});
		await act(async () => pluralRemovedResult.current.handleAutoRunRefresh());
		expect(pluralRemovedHarness.setSuccessFlashNotification).toHaveBeenCalledWith(
			'2 documents removed'
		);

		const evenHarness = deps({ autoRunDocumentList: [] });
		const { result: evenResult } = renderHook(() => useAutoRunHandlers(active, evenHarness));
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
		});
		await act(async () => evenResult.current.handleAutoRunRefresh());
		expect(evenHarness.setAutoRunDocumentList).toHaveBeenCalledWith([]);
		expect(evenHarness.setAutoRunDocumentTree).toHaveBeenCalledWith([]);
		expect(evenHarness.setSuccessFlashNotification).toHaveBeenCalledWith(
			'Refresh complete, no new documents'
		);

		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({ success: false });
		await act(async () => evenResult.current.handleAutoRunRefresh());
		expect(evenHarness.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);

		vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValueOnce({ success: false });
		await expect(result.current.handleAutoRunCreateDocument('Rejected')).resolves.toBe(false);

		vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValueOnce({ success: true });
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({ success: false });
		await expect(result.current.handleAutoRunCreateDocument('NoRefresh')).resolves.toBe(true);

		vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValueOnce({ success: true });
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({ success: true });
		await expect(result.current.handleAutoRunCreateDocument('FallbackList')).resolves.toBe(true);
		expect(harness.setAutoRunDocumentList).toHaveBeenLastCalledWith([]);
		expect(harness.setAutoRunDocumentTree).toHaveBeenLastCalledWith([]);
		expect(applySessionSetter(harness.setSessions, [active, session({ id: 'other' })])).toEqual([
			expect.objectContaining({
				id: active.id,
				autoRunSelectedFile: 'FallbackList',
				autoRunContentVersion: 1,
				autoRunMode: 'edit',
			}),
			expect.objectContaining({ id: 'other' }),
		]);
	});

	it('dispatches batch runs to active and existing-open worktree targets with guard rails', async () => {
		const parent = session();
		const target = session({
			id: 'worktree-open',
			cwd: '/repo/worktrees/open',
			worktreeBranch: 'feature/open',
		});
		useSessionStore.setState({ sessions: [parent, target], activeSessionId: parent.id } as any);
		const harness = deps();
		const { result } = renderHook(() => useAutoRunHandlers(parent, harness));

		const baseConfig: BatchRunConfig = {
			documents: baseDocuments,
			prompt: 'Run it',
			loopEnabled: false,
		};
		await act(async () => result.current.handleStartBatchRun({ ...baseConfig }));
		expect(harness.startBatchRun).toHaveBeenCalledWith(
			parent.id,
			expect.any(Object),
			parent.autoRunFolderPath
		);

		const existingOpenConfig: BatchRunConfig = {
			...baseConfig,
			worktreeTarget: {
				mode: 'existing-open',
				sessionId: 'worktree-open',
				createPROnCompletion: true,
				baseBranch: 'develop',
			},
		};
		await act(async () => result.current.handleStartBatchRun(existingOpenConfig));
		expect(existingOpenConfig.worktree).toEqual({
			enabled: true,
			path: '/repo/worktrees/open',
			branchName: 'feature/open',
			createPROnCompletion: true,
			prTargetBranch: 'develop',
		});
		expect(harness.startBatchRun).toHaveBeenLastCalledWith(
			'worktree-open',
			existingOpenConfig,
			parent.autoRunFolderPath
		);

		await act(async () =>
			result.current.handleStartBatchRun({
				...baseConfig,
				worktreeTarget: { mode: 'existing-open', sessionId: 'missing' },
			})
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'warning', title: 'Worktree Agent Not Found' })
		);
		expect(harness.startBatchRun).toHaveBeenLastCalledWith(
			parent.id,
			expect.objectContaining({
				worktreeTarget: expect.objectContaining({ sessionId: 'missing' }),
			}),
			parent.autoRunFolderPath
		);

		useSessionStore.setState({
			sessions: [parent, { ...target, id: 'busy-target', state: 'busy' }],
			activeSessionId: parent.id,
		} as any);
		await act(async () =>
			result.current.handleStartBatchRun({
				...baseConfig,
				worktreeTarget: { mode: 'existing-open', sessionId: 'busy-target' },
			})
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'warning', title: 'Target Agent Busy' })
		);
	});

	it('covers worktree target fallback branches', async () => {
		const parent = session({ worktreeConfig: undefined });
		const trailingTarget = session({
			id: 'trailing-target',
			cwd: '/repo/worktrees/',
			worktreeBranch: '',
		});
		useSessionStore.setState({
			sessions: [parent, trailingTarget],
			activeSessionId: parent.id,
		} as any);
		const harness = deps();
		const { result } = renderHook(() => useAutoRunHandlers(parent, harness));
		const baseConfig: BatchRunConfig = {
			documents: baseDocuments,
			prompt: 'Run it',
			loopEnabled: false,
		};

		const existingOpenConfig: BatchRunConfig = {
			...baseConfig,
			worktreeTarget: {
				mode: 'existing-open',
				sessionId: 'trailing-target',
				createPROnCompletion: true,
				baseBranch: '',
			},
		};
		await act(async () => result.current.handleStartBatchRun(existingOpenConfig));
		expect(existingOpenConfig.worktree).toEqual({
			enabled: true,
			path: '/repo/worktrees/',
			branchName: 'worktree',
			createPROnCompletion: true,
			prTargetBranch: 'main',
		});

		const existingOpenNoPrConfig: BatchRunConfig = {
			...baseConfig,
			worktreeTarget: {
				mode: 'existing-open',
				sessionId: 'trailing-target',
				createPROnCompletion: false,
			},
		};
		await act(async () => result.current.handleStartBatchRun(existingOpenNoPrConfig));
		expect(existingOpenNoPrConfig.worktree).toBeUndefined();

		const createConfig: BatchRunConfig = {
			...baseConfig,
			worktreeTarget: {
				mode: 'create-new',
				newBranchName: '',
				createPROnCompletion: false,
			},
		};
		const startCallsBeforeInvalidBranch = harness.startBatchRun.mock.calls.length;
		await act(async () => result.current.handleStartBatchRun(createConfig));
		expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalledWith(
			'/repo/app',
			'/repo/worktrees/',
			'',
			undefined
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Invalid Branch Name',
			})
		);
		expect(harness.startBatchRun).toHaveBeenCalledTimes(startCallsBeforeInvalidBranch);
		expect(createConfig.worktree).toBeUndefined();

		vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValueOnce({
			success: false,
		});
		await act(async () =>
			result.current.handleStartBatchRun({
				...baseConfig,
				worktreeTarget: { mode: 'create-new', newBranchName: 'feature/unknown-error' },
			})
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Failed to Create Worktree',
				message: 'Unknown error',
			})
		);

		const closedConfig: BatchRunConfig = {
			...baseConfig,
			worktreeTarget: {
				mode: 'existing-closed',
				worktreePath: '/repo/worktrees/',
				createPROnCompletion: true,
			},
		};
		await act(async () => result.current.handleStartBatchRun(closedConfig));
		expect(closedConfig.worktree).toEqual(
			expect.objectContaining({
				path: '/repo/worktrees/',
				branchName: 'worktree',
				prTargetBranch: 'main',
			})
		);

		vi.mocked(window.maestro.git.worktreeSetup).mockRejectedValueOnce('spawn string');
		await act(async () =>
			result.current.handleStartBatchRun({
				...baseConfig,
				worktreeTarget: { mode: 'create-new', newBranchName: 'feature/string-error' },
			})
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Worktree Error',
				message: 'spawn string',
			})
		);
	});

	it('creates and reuses worktree agent sessions with cleanup and error paths', async () => {
		const parent = session({ sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' } });
		useSessionStore.setState({ sessions: [parent], activeSessionId: parent.id } as any);
		const harness = deps();
		const { result } = renderHook(() => useAutoRunHandlers(parent, harness));
		const config: BatchRunConfig = {
			documents: baseDocuments,
			prompt: 'Run new worktree',
			loopEnabled: false,
			worktreeTarget: {
				mode: 'create-new',
				newBranchName: 'feature/new',
				createPROnCompletion: true,
				baseBranch: 'release',
			},
		};

		await act(async () => result.current.handleStartBatchRun(config));
		expect(markWorktreePathAsRecentlyCreated).toHaveBeenCalledWith('/repo/worktrees/feature/new');
		expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
			'/repo/app',
			'/repo/worktrees/feature/new',
			'feature/new',
			'ssh-1',
			'release'
		);
		expect(gitService.getBranches).toHaveBeenCalledWith('/repo/worktrees/feature/new', 'ssh-1');
		expect(config.worktree).toEqual({
			enabled: true,
			path: '/repo/worktrees/feature/new',
			branchName: 'feature/new',
			createPROnCompletion: true,
			prTargetBranch: 'release',
		});
		expect(useSessionStore.getState().sessions).toHaveLength(2);
		const createdSession = useSessionStore
			.getState()
			.sessions.find((storedSession) => storedSession.id !== parent.id);
		expect(createdSession).toBeDefined();
		expect(harness.startBatchRun).toHaveBeenCalledWith(
			createdSession!.id,
			config,
			parent.autoRunFolderPath
		);

		vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValueOnce({
			success: false,
			error: 'cannot create',
		});
		await act(async () =>
			result.current.handleStartBatchRun({
				documents: baseDocuments,
				prompt: 'fail',
				loopEnabled: false,
				worktreeTarget: { mode: 'create-new', newBranchName: 'feature/fail' },
			})
		);
		expect(clearRecentlyCreatedWorktreePath).toHaveBeenCalledWith('/repo/worktrees/feature/fail');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', title: 'Failed to Create Worktree' })
		);

		vi.mocked(gitService.getBranches).mockRejectedValueOnce(new Error('git failed'));
		await act(async () =>
			result.current.handleStartBatchRun({
				documents: baseDocuments,
				prompt: 'closed',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-closed',
					worktreePath: '/repo/worktrees/existing-branch',
					createPROnCompletion: true,
				},
			})
		);
		const existingClosedSession = useSessionStore
			.getState()
			.sessions.find((storedSession) => storedSession.cwd === '/repo/worktrees/existing-branch');
		expect(existingClosedSession).toBeDefined();
		expect(harness.startBatchRun).toHaveBeenLastCalledWith(
			existingClosedSession!.id,
			expect.objectContaining({
				worktree: expect.objectContaining({
					path: '/repo/worktrees/existing-branch',
					branchName: 'existing-branch',
				}),
			}),
			parent.autoRunFolderPath
		);

		vi.mocked(window.maestro.git.worktreeSetup).mockRejectedValueOnce(new Error('spawn exploded'));
		await act(async () =>
			result.current.handleStartBatchRun({
				documents: baseDocuments,
				prompt: 'throw',
				loopEnabled: false,
				worktreeTarget: { mode: 'create-new', newBranchName: 'feature/throw' },
			})
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', title: 'Worktree Error', message: 'spawn exploded' })
		);
	});
});
