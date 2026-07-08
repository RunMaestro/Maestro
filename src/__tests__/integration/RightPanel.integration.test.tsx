import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchRunState, Session, Theme } from '../../renderer/types';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { RightPanel, type RightPanelHandle } from '../../renderer/components/RightPanel';

const childMocks = vi.hoisted(() => ({
	autoRunFocus: vi.fn(),
	autoRunGetCompletedTaskCount: vi.fn(() => 7),
	autoRunOpenResetTasksModal: vi.fn(),
	historyFocus: vi.fn(),
	historyRefresh: vi.fn(),
	resizeStart: vi.fn(),
}));

vi.mock('../../renderer/hooks', async () => {
	const React = await import('react');

	return {
		useResizablePanel: () => ({
			panelRef: React.createRef<HTMLDivElement>(),
			onResizeStart: childMocks.resizeStart,
			transitionClass: 'transition-right-panel',
		}),
	};
});

vi.mock('../../renderer/components/FileExplorerPanel', async () => {
	const React = await import('react');

	return {
		FileExplorerPanel: ({
			fileTreeFilterInputRef,
		}: {
			fileTreeFilterInputRef: React.RefObject<HTMLInputElement>;
		}) =>
			React.createElement(
				'div',
				{ 'data-testid': 'file-explorer-panel' },
				React.createElement('input', {
					ref: fileTreeFilterInputRef,
					'data-testid': 'file-filter-input',
				})
			),
	};
});

vi.mock('../../renderer/components/HistoryPanel', async () => {
	const React = await import('react');

	return {
		HistoryPanel: React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
			React.useImperativeHandle(ref, () => ({
				focus: childMocks.historyFocus,
				refreshHistory: childMocks.historyRefresh,
			}));

			return React.createElement('div', { 'data-testid': 'history-panel' }, 'History panel');
		}),
	};
});

vi.mock('../../renderer/components/AutoRun', async () => {
	const React = await import('react');

	return {
		AutoRun: React.forwardRef(
			(
				props: {
					folderPath: string | null;
					mode: 'edit' | 'preview';
					onExpand: () => void;
					selectedFile: string | null;
				},
				ref: React.Ref<unknown>
			) => {
				React.useImperativeHandle(ref, () => ({
					focus: childMocks.autoRunFocus,
					getCompletedTaskCount: childMocks.autoRunGetCompletedTaskCount,
					openResetTasksModal: childMocks.autoRunOpenResetTasksModal,
				}));

				return React.createElement(
					'div',
					{ 'data-testid': 'autorun-panel' },
					React.createElement('button', { onClick: props.onExpand }, 'Expand Auto Run'),
					React.createElement('span', null, props.folderPath ?? 'no-folder'),
					React.createElement('span', null, props.selectedFile ?? 'no-file'),
					React.createElement('span', null, props.mode)
				);
			}
		),
	};
});

vi.mock('../../renderer/components/AutoRun/AutoRunExpandedModal', async () => {
	const React = await import('react');

	return {
		AutoRunExpandedModal: ({ onClose }: { onClose: () => void }) =>
			React.createElement(
				'div',
				{ role: 'dialog', 'aria-label': 'Expanded Auto Run' },
				React.createElement('button', { onClick: onClose }, 'Close Expanded Auto Run')
			),
	};
});

vi.mock('../../renderer/components/ConfirmModal', async () => {
	const React = await import('react');

	return {
		ConfirmModal: ({
			confirmLabel,
			onClose,
			onConfirm,
			title,
		}: {
			confirmLabel: string;
			onClose: () => void;
			onConfirm: () => void;
			title: string;
		}) =>
			React.createElement(
				'div',
				{ role: 'dialog', 'aria-label': title },
				React.createElement('button', { onClick: onConfirm }, confirmLabel),
				React.createElement('button', { onClick: onClose }, 'Close Confirm')
			),
	};
});

const theme: Theme = {
	id: 'right-panel-test',
	name: 'Right Panel Test',
	mode: 'dark',
	colors: {
		bgMain: '#202124',
		bgSidebar: '#15171a',
		bgActivity: '#25282d',
		border: '#343842',
		textMain: '#f5f5f5',
		textDim: '#9ca3af',
		accent: '#38bdf8',
		accentDim: 'rgba(56, 189, 248, 0.2)',
		accentText: '#0ea5e9',
		accentForeground: '#001018',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent One',
		toolType: 'codex',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1,
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
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		autoRunContent: 'Initial Auto Run content',
		autoRunContentVersion: 1,
		autoRunFolderPath: '/repo/Auto Run Docs',
		autoRunMode: 'preview',
		autoRunSelectedFile: 'phase-1.md',
		...overrides,
	} as Session;
}

function createBatchState(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return {
		isRunning: true,
		isStopping: false,
		documents: ['phase-1'],
		lockedDocuments: [],
		currentDocumentIndex: 0,
		currentDocTasksTotal: 2,
		currentDocTasksCompleted: 1,
		totalTasksAcrossAllDocs: 0,
		completedTasksAcrossAllDocs: 0,
		loopEnabled: false,
		loopIteration: 0,
		folderPath: '/repo/Auto Run Docs',
		worktreeActive: false,
		totalTasks: 4,
		completedTasks: 2,
		currentTaskIndex: 1,
		originalContent: 'original',
		sessionIds: [],
		startTime: Date.now() - 5000,
		...overrides,
	};
}

function resetStores(session: Session | null = createSession()) {
	useSessionStore.setState({
		activeSessionId: session?.id ?? '',
		groups: [],
		sessions: session ? [session] : [],
	});
	useUIStore.setState({
		activeFocus: 'right',
		activeRightTab: 'files',
		rightPanelOpen: true,
	});
	useSettingsStore.setState({
		fileExplorerIconTheme: 'classic',
		rightPanelWidth: 420,
		shortcuts: {
			...useSettingsStore.getState().shortcuts,
			toggleRightPanel: {
				id: 'toggleRightPanel',
				label: 'Toggle right panel',
				keys: ['Cmd', 'B'],
			},
		},
		showHiddenFiles: false,
	});
	useFileExplorerStore.setState({
		fileTreeFilter: '',
		fileTreeFilterOpen: false,
		filteredFileTree: [],
		lastGraphFocusFilePath: undefined,
		selectedFileIndex: 0,
	});
	useBatchStore.setState({
		batchRunStates: {},
		documentList: [],
		documentTaskCounts: new Map(),
		documentTree: [],
		isLoadingDocuments: false,
	});
}

function createProps(overrides: Partial<React.ComponentProps<typeof RightPanel>> = {}) {
	return {
		theme,
		setActiveRightTab: vi.fn(),
		fileTreeContainerRef: React.createRef<HTMLDivElement>(),
		fileTreeFilterInputRef: React.createRef<HTMLInputElement>(),
		toggleFolder: vi.fn(),
		handleFileClick: vi.fn(),
		expandAllFolders: vi.fn(),
		collapseAllFolders: vi.fn(),
		updateSessionWorkingDirectory: vi.fn(),
		refreshFileTree: vi.fn(),
		onAutoRunContentChange: vi.fn(),
		onAutoRunModeChange: vi.fn(),
		onAutoRunStateChange: vi.fn(),
		onAutoRunSelectDocument: vi.fn(),
		onAutoRunCreateDocument: vi.fn(),
		onAutoRunRefresh: vi.fn(),
		onAutoRunOpenSetup: vi.fn(),
		...overrides,
	};
}

describe('RightPanel integration', () => {
	beforeEach(() => {
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			callback(0);
			return 1;
		});
		childMocks.autoRunGetCompletedTaskCount.mockReturnValue(7);
		resetStores();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('wires file tab focus, scroll persistence, closed state, and tab callbacks', () => {
		const secondarySession = createSession({ id: 'session-2', name: 'Agent Two' });
		useSessionStore.setState({
			sessions: [useSessionStore.getState().sessions[0], secondarySession],
		});
		const props = createProps();
		const { rerender } = render(<RightPanel {...props} />);

		expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
		fireEvent.click(props.fileTreeContainerRef.current!);
		expect(document.activeElement).toBe(props.fileTreeContainerRef.current);

		props.fileTreeContainerRef.current!.scrollTop = 48;
		fireEvent.scroll(props.fileTreeContainerRef.current!);
		expect(useSessionStore.getState().sessions[0].fileExplorerScrollPos).toBe(48);
		expect(useSessionStore.getState().sessions[1].fileExplorerScrollPos).toBe(0);

		fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));
		expect(props.setActiveRightTab).toHaveBeenCalledWith('autorun');
		fireEvent.click(screen.getByRole('button', { name: 'History' }));
		expect(props.setActiveRightTab).toHaveBeenCalledWith('history');

		act(() => useUIStore.setState({ activeFocus: 'main', activeRightTab: 'autorun' }));
		rerender(<RightPanel {...props} />);
		props.fileTreeContainerRef.current!.scrollTop = 96;
		fireEvent.scroll(props.fileTreeContainerRef.current!);
		expect(useSessionStore.getState().sessions[0].fileExplorerScrollPos).toBe(48);

		act(() => useUIStore.setState({ rightPanelOpen: false }));
		rerender(<RightPanel {...props} />);
		fireEvent.click(screen.getByTitle(/Expand Right Panel/));
		expect(useUIStore.getState().rightPanelOpen).toBe(true);
	});

	it('returns null without an active session', () => {
		resetStores(null);
		const { container } = render(<RightPanel {...createProps()} />);

		expect(container.firstChild).toBeNull();
	});

	it('exposes history and Auto Run imperative handles while managing the expanded modal', async () => {
		const panelRef = React.createRef<RightPanelHandle>();
		const props = createProps();

		act(() => useUIStore.setState({ activeRightTab: 'history' }));
		const { rerender } = render(<RightPanel ref={panelRef} {...props} />);
		await waitFor(() => expect(childMocks.historyFocus).toHaveBeenCalled());

		panelRef.current?.refreshHistoryPanel();
		expect(childMocks.historyRefresh).toHaveBeenCalled();
		expect(panelRef.current?.getAutoRunCompletedTaskCount()).toBe(0);

		act(() => useUIStore.setState({ activeRightTab: 'autorun' }));
		rerender(<RightPanel ref={panelRef} {...props} />);
		await waitFor(() => expect(childMocks.autoRunFocus).toHaveBeenCalled());
		expect(screen.getByText('/repo/Auto Run Docs')).toBeInTheDocument();
		expect(screen.getAllByText('phase-1.md').length).toBeGreaterThan(0);
		expect(screen.getByText('preview')).toBeInTheDocument();

		act(() =>
			useSessionStore.setState({
				activeSessionId: 'session-1',
				sessions: [
					createSession({
						autoRunContent: 'Changed Auto Run content',
						autoRunContentVersion: 2,
						autoRunSelectedFile: 'phase-2.md',
					}),
				],
			})
		);
		rerender(<RightPanel ref={panelRef} {...props} />);
		expect(screen.getByText('phase-2.md')).toBeInTheDocument();

		panelRef.current?.focusAutoRun();
		panelRef.current?.openAutoRunResetTasksModal();
		expect(panelRef.current?.getAutoRunCompletedTaskCount()).toBe(7);
		expect(childMocks.autoRunFocus).toHaveBeenCalled();
		expect(childMocks.autoRunOpenResetTasksModal).toHaveBeenCalled();

		act(() => {
			panelRef.current?.toggleAutoRunExpanded();
		});
		expect(screen.getByRole('dialog', { name: 'Expanded Auto Run' })).toBeInTheDocument();
		act(() => {
			panelRef.current?.toggleAutoRunExpanded();
		});
		expect(childMocks.autoRunFocus).toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Expand Auto Run' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close Expanded Auto Run' }));
		expect(childMocks.autoRunFocus).toHaveBeenCalled();
	});

	it('renders running and stopping batch progress variants', async () => {
		const now = new Date('2026-05-27T12:00:00Z').getTime();
		vi.spyOn(Date, 'now').mockReturnValue(now);

		act(() => useUIStore.setState({ activeRightTab: 'autorun' }));
		const onKillBatchRun = vi.fn();
		const props = createProps({ onKillBatchRun });
		const { rerender } = render(
			<RightPanel
				{...props}
				currentSessionBatchState={createBatchState({
					startTime: Date.now() - 3_660_000,
					worktreeActive: true,
				})}
			/>
		);

		expect(await screen.findByText('Auto Run Active')).toBeInTheDocument();
		expect(screen.getByText('1h 1m')).toBeInTheDocument();
		expect(screen.getByTitle('Worktree: active')).toBeInTheDocument();
		expect(screen.getAllByText('phase-1.md').length).toBeGreaterThan(0);
		expect(screen.getByText('2 of 4 tasks completed')).toBeInTheDocument();

		rerender(
			<RightPanel
				{...props}
				currentSessionBatchState={createBatchState({
					documents: ['phase-1', 'phase-2'],
					currentDocTasksTotal: 0,
					isStopping: true,
					startTime: Date.now() - 70_000,
					totalTasks: 0,
				})}
			/>
		);
		expect(await screen.findByText('Stopping')).toBeInTheDocument();
		expect(screen.getByText('1m 10s')).toBeInTheDocument();
		expect(screen.getByText(/Document 1\/2:/)).toBeInTheDocument();
		expect(
			screen.getByText('Waiting for current task to complete before stopping...')
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Kill/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Kill Process' }));
		expect(onKillBatchRun).toHaveBeenCalledWith('session-1');
		fireEvent.click(screen.getByRole('button', { name: 'Close Confirm' }));

		rerender(
			<RightPanel
				{...props}
				currentSessionBatchState={createBatchState({
					completedTasksAcrossAllDocs: 3,
					documents: ['phase-1', 'phase-2'],
					startTime: Date.now() - 5_000,
					totalTasksAcrossAllDocs: 6,
				})}
			/>
		);
		expect(await screen.findByText('5s')).toBeInTheDocument();
		expect(screen.getByText('3 of 6 tasks completed')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'View history' }));
		expect(props.setActiveRightTab).toHaveBeenCalledWith('history');
	});

	it('renders error-paused batch controls and Auto Run shared-prop fallbacks', async () => {
		const session = createSession({
			autoRunContent: undefined,
			autoRunContentVersion: undefined,
			autoRunFolderPath: undefined,
			autoRunMode: undefined,
			autoRunSelectedFile: undefined,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		resetStores(session);
		act(() => {
			useUIStore.setState({ activeRightTab: 'autorun' });
			useBatchStore.setState({
				batchRunStates: {
					'session-1': {
						errorPaused: true,
						error: { recoverable: true },
					} as BatchRunState,
				},
			});
		});

		const onAbortBatchOnError = vi.fn();
		const onResumeAfterError = vi.fn();
		const props = createProps({ onAbortBatchOnError, onResumeAfterError });
		render(
			<RightPanel
				{...props}
				currentSessionBatchState={createBatchState({
					completedTasksAcrossAllDocs: 3,
					currentDocTasksCompleted: 2,
					currentDocTasksTotal: 4,
					documents: ['phase-1', 'phase-2'],
					loopEnabled: true,
					loopIteration: 1,
					maxLoops: null,
					totalTasksAcrossAllDocs: 6,
					worktreeActive: true,
					worktreeBranch: 'feature/right-panel',
				})}
			/>
		);

		expect(await screen.findByText('Auto Run Paused')).toBeInTheDocument();
		expect(screen.getByText('Paused due to error')).toBeInTheDocument();
		expect(screen.getByTitle('Worktree: feature/right-panel')).toBeInTheDocument();
		expect(
			screen.getAllByText(
				(_content, element) => element?.textContent?.includes('Loop 2 of') ?? false
			).length
		).toBeGreaterThan(0);
		expect(screen.getByText('no-folder')).toBeInTheDocument();
		expect(screen.getByText('no-file')).toBeInTheDocument();
		expect(screen.getByText('edit')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Auto Run Paused' }));
		expect(props.setActiveRightTab).toHaveBeenCalledWith('autorun');
		fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
		fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
		expect(onResumeAfterError).toHaveBeenCalled();
		expect(onAbortBatchOnError).toHaveBeenCalled();
	});
});
