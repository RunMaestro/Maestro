import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useMainPanelProps } from '../../../renderer/hooks/props/useMainPanelProps';
import type { UseMainPanelPropsDeps } from '../../../renderer/hooks/props/useMainPanelProps';
import type { FilePreviewTab, Session } from '../../../renderer/types';

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: overrides.id ?? 'session-1',
		name: overrides.name ?? 'Session 1',
		activeTabId: overrides.activeTabId,
		inputMode: overrides.inputMode ?? 'ai',
		projectRoot: overrides.projectRoot,
		cwd: overrides.cwd ?? '/repo',
	} as Session;
}

function makeFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: overrides.id ?? 'file-tab-1',
		name: overrides.name ?? 'README.md',
		path: overrides.path ?? '/repo/README.md',
		content: overrides.content ?? '',
		...overrides,
	} as FilePreviewTab;
}

function makeDeps(overrides: Partial<UseMainPanelPropsDeps> = {}): UseMainPanelPropsDeps {
	const noop = vi.fn();
	const textAreaRef = { current: null } as React.RefObject<HTMLTextAreaElement>;
	const divRef = { current: null } as React.RefObject<HTMLDivElement>;

	return {
		logViewerOpen: false,
		agentSessionsOpen: false,
		activeAgentSessionId: null,
		activeSession: null,
		thinkingItems: [],
		theme: { name: 'dark' } as UseMainPanelPropsDeps['theme'],
		isMobileLandscape: false,
		stagedImages: [],
		commandHistoryOpen: false,
		commandHistoryFilter: '',
		commandHistorySelectedIndex: -1,
		slashCommandOpen: false,
		slashCommands: [],
		selectedSlashCommandIndex: -1,
		filePreviewLoading: null,
		tabCompletionOpen: false,
		tabCompletionSuggestions: [],
		selectedTabCompletionIndex: -1,
		tabCompletionFilter: { query: '', startIndex: 0 },
		atMentionOpen: false,
		atMentionFilter: '',
		atMentionStartIndex: 0,
		atMentionSuggestions: [],
		selectedAtMentionIndex: -1,
		currentSessionBatchState: undefined,
		fileTree: [],
		canGoBack: false,
		canGoForward: false,
		backHistory: [],
		forwardHistory: [],
		filePreviewHistoryIndex: -1,
		activeTab: undefined,
		isWorktreeChild: false,
		summarizeProgress: null,
		summarizeResult: null,
		summarizeStartTime: 0,
		isSummarizing: false,
		mergeProgress: null,
		mergeStartTime: 0,
		isMerging: false,
		mergeSourceName: undefined,
		mergeTargetName: undefined,
		ghCliAvailable: false,
		hasGist: false,
		setGitDiffPreview: noop,
		setLogViewerOpen: noop,
		setAgentSessionsOpen: noop,
		setActiveAgentSessionId: noop,
		setInputValue: noop,
		setStagedImages: noop,
		setCommandHistoryOpen: noop,
		setCommandHistoryFilter: noop,
		setCommandHistorySelectedIndex: noop,
		setSlashCommandOpen: noop,
		setSelectedSlashCommandIndex: noop,
		setTabCompletionOpen: noop,
		setSelectedTabCompletionIndex: noop,
		setTabCompletionFilter: noop,
		setAtMentionOpen: noop,
		setAtMentionFilter: noop,
		setAtMentionStartIndex: noop,
		setSelectedAtMentionIndex: noop,
		setGitLogOpen: noop,
		inputRef: textAreaRef,
		logsEndRef: divRef,
		terminalOutputRef: divRef,
		handleResumeSession: noop,
		handleNewAgentSession: noop,
		toggleInputMode: noop,
		processInput: noop,
		handleInterrupt: noop,
		handleInputKeyDown: noop,
		handlePaste: noop,
		handleDrop: noop,
		getContextColor: vi.fn(() => 'green'),
		setActiveSessionId: noop,
		handleStopBatchRun: noop,
		handleDeleteLog: vi.fn(() => null),
		handleRemoveQueuedItem: noop,
		handleOpenQueueBrowser: noop,
		handleTabSelect: noop,
		handleTabClose: noop,
		handleNewTab: noop,
		handleRequestTabRename: noop,
		handleTabReorder: noop,
		handleUnifiedTabReorder: noop,
		handleUpdateTabByClaudeSessionId: noop,
		handleTabStar: noop,
		handleTabMarkUnread: noop,
		handleToggleTabReadOnlyMode: noop,
		handleToggleTabSaveToHistory: noop,
		handleToggleTabShowThinking: noop,
		toggleUnreadFilter: noop,
		handleOpenTabSearch: noop,
		handleCloseAllTabs: noop,
		handleCloseOtherTabs: noop,
		handleCloseTabsLeft: noop,
		handleCloseTabsRight: noop,
		unifiedTabs: [],
		activeFileTabId: null,
		activeFileTab: null,
		handleFileTabSelect: noop,
		handleFileTabClose: noop,
		handleFileTabEditModeChange: noop,
		handleFileTabEditContentChange: noop,
		handleFileTabScrollPositionChange: noop,
		handleFileTabSearchQueryChange: noop,
		handleReloadFileTab: noop,
		handleScrollPositionChange: noop,
		handleAtBottomChange: noop,
		handleMainPanelInputBlur: noop,
		handleOpenPromptComposer: noop,
		handleReplayMessage: noop,
		handleMainPanelFileClick: noop,
		handleNavigateBack: noop,
		handleNavigateForward: noop,
		handleNavigateToIndex: noop,
		handleClearFilePreviewHistory: noop,
		handleClearAgentErrorForMainPanel: noop,
		handleShowAgentErrorModal: noop,
		showSuccessFlash: noop,
		handleOpenFuzzySearch: noop,
		handleOpenWorktreeConfig: noop,
		handleOpenCreatePR: noop,
		handleSummarizeAndContinue: noop,
		handleMergeWith: noop,
		handleOpenSendToAgentModal: noop,
		handleCopyContext: noop,
		handleExportHtml: noop,
		handlePublishTabGist: noop,
		cancelTab: noop,
		cancelMergeTab: noop,
		recordShortcutUsage: vi.fn(() => ({ newLevel: null })),
		onKeyboardMasteryLevelUp: noop,
		handleSetLightboxImage: noop,
		setGistPublishModalOpen: noop,
		setGraphFocusFilePath: noop,
		setLastGraphFocusFilePath: noop,
		setIsGraphViewOpen: noop,
		generateInlineWizardDocuments: vi.fn().mockResolvedValue(undefined),
		retryInlineWizardMessage: noop,
		clearInlineWizardError: noop,
		endInlineWizard: noop,
		handleAutoRunRefresh: noop,
		refreshFileTree: vi.fn().mockResolvedValue(undefined),
		getActiveTab: vi.fn(),
		...overrides,
	} as UseMainPanelPropsDeps;
}

describe('useMainPanelProps', () => {
	it('maps representative state and callbacks to MainPanel prop names', () => {
		const handleTabSelect = vi.fn();
		const setLogViewerOpen = vi.fn();
		const deps = makeDeps({
			logViewerOpen: true,
			handleTabSelect,
			setLogViewerOpen,
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		expect(result.current.logViewerOpen).toBe(true);
		expect(result.current.onTabSelect).toBe(handleTabSelect);
		expect(result.current.setLogViewerOpen).toBe(setLogViewerOpen);
	});

	it('exposes agent-error and cancel handlers only when matching session state exists', () => {
		const handleClearAgentErrorForMainPanel = vi.fn();
		const cancelTab = vi.fn();
		const cancelMergeTab = vi.fn();
		const deps = makeDeps({
			activeSession: makeSession({ activeTabId: 'tab-1' }),
			activeTab: {
				id: 'tab-1',
				agentError: { message: 'failed' },
			} as UseMainPanelPropsDeps['activeTab'],
			handleClearAgentErrorForMainPanel,
			cancelTab,
			cancelMergeTab,
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onClearAgentError?.();
		result.current.onCancelSummarize?.();
		result.current.onCancelMerge?.();

		expect(handleClearAgentErrorForMainPanel).toHaveBeenCalledTimes(1);
		expect(cancelTab).toHaveBeenCalledWith('tab-1');
		expect(cancelMergeTab).toHaveBeenCalledWith('tab-1');
	});

	it('omits agent-error and cancel handlers when there is no active error or tab', () => {
		const deps = makeDeps({
			activeSession: makeSession({ activeTabId: undefined }),
			activeTab: { id: 'tab-1' } as UseMainPanelPropsDeps['activeTab'],
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		expect(result.current.onClearAgentError).toBeUndefined();
		expect(result.current.onCancelSummarize).toBeUndefined();
		expect(result.current.onCancelMerge).toBeUndefined();
	});

	it('reports keyboard mastery level-ups only when shortcut usage returns a new level', () => {
		const recordShortcutUsage = vi
			.fn()
			.mockReturnValueOnce({ newLevel: null })
			.mockReturnValueOnce({ newLevel: 3 });
		const onKeyboardMasteryLevelUp = vi.fn();
		const deps = makeDeps({ recordShortcutUsage, onKeyboardMasteryLevelUp });

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onShortcutUsed('copy');
		result.current.onShortcutUsed('paste');

		expect(recordShortcutUsage).toHaveBeenCalledWith('copy');
		expect(recordShortcutUsage).toHaveBeenCalledWith('paste');
		expect(onKeyboardMasteryLevelUp).toHaveBeenCalledWith(3);
		expect(onKeyboardMasteryLevelUp).toHaveBeenCalledTimes(1);
	});

	it('opens the gist publishing modal from the mapped callback', () => {
		const setGistPublishModalOpen = vi.fn();
		const deps = makeDeps({ setGistPublishModalOpen });

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onPublishGist();

		expect(setGistPublishModalOpen).toHaveBeenCalledWith(true);
	});

	it('focuses graph paths relative to the active session project root', () => {
		const setGraphFocusFilePath = vi.fn();
		const setLastGraphFocusFilePath = vi.fn();
		const setIsGraphViewOpen = vi.fn();
		const deps = makeDeps({
			activeSession: makeSession({ projectRoot: '/repo', cwd: '/fallback' }),
			activeFileTab: makeFileTab({ path: '/repo/docs/README.md', name: 'README.md' }),
			setGraphFocusFilePath,
			setLastGraphFocusFilePath,
			setIsGraphViewOpen,
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onOpenInGraph();

		expect(setGraphFocusFilePath).toHaveBeenCalledWith('docs/README.md');
		expect(setLastGraphFocusFilePath).toHaveBeenCalledWith('docs/README.md');
		expect(setIsGraphViewOpen).toHaveBeenCalledWith(true);
	});

	it('focuses graph paths using the cwd fallback and same-prefix fallback branches', () => {
		const setGraphFocusFilePath = vi.fn();
		const deps = makeDeps({
			activeSession: makeSession({ projectRoot: undefined, cwd: '/repo' }),
			activeFileTab: makeFileTab({ path: '/repo', name: 'root' }),
			setGraphFocusFilePath,
			setLastGraphFocusFilePath: vi.fn(),
			setIsGraphViewOpen: vi.fn(),
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onOpenInGraph();

		expect(setGraphFocusFilePath).toHaveBeenCalledWith('');
	});

	it('falls back to the file name when graph focus cannot be made relative', () => {
		const setGraphFocusFilePath = vi.fn();
		const deps = makeDeps({
			activeSession: makeSession({ projectRoot: '/repo', cwd: '/repo' }),
			activeFileTab: makeFileTab({ path: '/outside/file.md', name: 'file.md' }),
			setGraphFocusFilePath,
			setLastGraphFocusFilePath: vi.fn(),
			setIsGraphViewOpen: vi.fn(),
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onOpenInGraph();

		expect(setGraphFocusFilePath).toHaveBeenCalledWith('file.md');
	});

	it('handles graph focus when the active session has no project root or cwd', () => {
		const setGraphFocusFilePath = vi.fn();
		const deps = makeDeps({
			activeSession: { id: 'session-without-root', name: 'No Root' } as Session,
			activeFileTab: makeFileTab({ path: '/absolute.md', name: 'absolute.md' }),
			setGraphFocusFilePath,
			setLastGraphFocusFilePath: vi.fn(),
			setIsGraphViewOpen: vi.fn(),
		});

		const { result } = renderHook(() => useMainPanelProps(deps));

		result.current.onOpenInGraph();

		expect(setGraphFocusFilePath).toHaveBeenCalledWith('absolute.md');
	});

	it('does not open the graph without both an active file tab and active session', () => {
		const setGraphFocusFilePath = vi.fn();
		const first = renderHook(() =>
			useMainPanelProps(
				makeDeps({
					activeSession: makeSession(),
					activeFileTab: null,
					setGraphFocusFilePath,
				})
			)
		);
		const second = renderHook(() =>
			useMainPanelProps(
				makeDeps({
					activeSession: null,
					activeFileTab: makeFileTab(),
					setGraphFocusFilePath,
				})
			)
		);

		first.result.current.onOpenInGraph();
		second.result.current.onOpenInGraph();

		expect(setGraphFocusFilePath).not.toHaveBeenCalled();
	});
});
