import {
	act,
	cleanup,
	fireEvent,
	render as rtlRender,
	screen,
	waitFor,
} from '@testing-library/react';
import type { RenderOptions } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitService } from '../../renderer/services/git';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import {
	clearCapabilitiesCache,
	setCapabilitiesCache,
	type AgentCapabilities,
} from '../../renderer/hooks/agent/useAgentCapabilities';
import type { FilePreviewTab, Session, Theme, ThinkingItem } from '../../renderer/types';

const mockFilePreviewFocus = vi.hoisted(() => vi.fn());
const mockRefreshGitStatus = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSafeClipboardWrite = vi.hoisted(() => vi.fn().mockResolvedValue(true));

const mockGitStatusData = vi.hoisted(() => ({
	current: {
		'session-1': {
			fileCount: 3,
			branch: 'main',
			remote: 'https://github.com/user/repo.git',
			ahead: 2,
			behind: 1,
		},
	} as Record<
		string,
		{
			fileCount: number;
			branch: string;
			remote: string;
			ahead: number;
			behind: number;
		}
	>,
}));

vi.mock('../../renderer/components/LogViewer', () => ({
	LogViewer: (props: { onClose: () => void }) => (
		<div data-testid="log-viewer">
			<button data-testid="log-viewer-close" onClick={props.onClose}>
				Close logs
			</button>
		</div>
	),
}));

vi.mock('../../renderer/components/AgentSessionsBrowser', () => ({
	AgentSessionsBrowser: (props: { onClose: () => void; onNewSession: () => void }) => (
		<div data-testid="agent-sessions-browser">
			<button data-testid="agent-sessions-close" onClick={props.onClose}>
				Close sessions
			</button>
			<button data-testid="agent-sessions-new" onClick={props.onNewSession}>
				New session
			</button>
		</div>
	),
}));

vi.mock('../../renderer/components/TerminalOutput', () => ({
	TerminalOutput: React.forwardRef(
		(
			props: {
				session: Session;
				onFileSaved?: () => void;
				onInterrupt?: () => void;
				cwd?: string;
			},
			ref
		) => (
			<div data-testid="terminal-output" ref={ref as React.RefObject<HTMLDivElement>}>
				<span>{`Terminal for ${props.session.name}`}</span>
				<span data-testid="terminal-cwd">{props.cwd}</span>
				<button data-testid="terminal-file-saved" onClick={props.onFileSaved}>
					File saved
				</button>
				<button data-testid="terminal-interrupt" onClick={props.onInterrupt}>
					Interrupt
				</button>
			</div>
		)
	),
}));

vi.mock('../../renderer/components/InputArea', () => ({
	InputArea: (props: {
		session: Session;
		onInputFocus: () => void;
		onStopAutoRun?: () => void;
		onSummarizeAndContinue?: () => void;
		onSessionClick?: (sessionId: string, tabId?: string) => void;
	}) => (
		<div data-testid="input-area">
			<input data-testid="input-field" onFocus={props.onInputFocus} />
			<span>{`Input for ${props.session.name}`}</span>
			<button data-testid="input-stop-auto-run" onClick={props.onStopAutoRun}>
				Stop input auto run
			</button>
			<button data-testid="input-summarize" onClick={props.onSummarizeAndContinue}>
				Summarize
			</button>
			<button
				data-testid="input-session-click"
				onClick={() => props.onSessionClick?.('session-2', 'tab-2')}
			>
				Session click
			</button>
		</div>
	),
}));

vi.mock('../../renderer/components/FilePreview', () => ({
	FilePreview: React.forwardRef(
		(
			props: {
				file: { name: string; path: string };
				onClose: () => void;
				setMarkdownEditMode?: (editMode: boolean) => void;
				onSave?: (path: string, content: string) => void | Promise<void>;
				onEditContentChange?: (content: string) => void;
				onScrollPositionChange?: (scrollTop: number) => void;
				onSearchQueryChange?: (query: string) => void;
				onReloadFile?: () => void;
				cwd?: string;
			},
			ref
		) => {
			React.useImperativeHandle(ref, () => ({ focus: mockFilePreviewFocus }));
			return (
				<div data-testid="file-preview">
					<span>{`File Preview: ${props.file.name}`}</span>
					<span data-testid="file-preview-cwd">{props.cwd}</span>
					<button data-testid="file-preview-close" onClick={props.onClose}>
						Close
					</button>
					<button
						data-testid="file-preview-edit-mode"
						onClick={() => props.setMarkdownEditMode?.(true)}
					>
						Edit mode
					</button>
					<button
						data-testid="file-preview-save"
						onClick={() => props.onSave?.('/repo/docs/readme.md', 'saved')}
					>
						Save
					</button>
					<button
						data-testid="file-preview-edit-content"
						onClick={() => props.onEditContentChange?.('changed')}
					>
						Edit content
					</button>
					<button
						data-testid="file-preview-scroll"
						onClick={() => props.onScrollPositionChange?.(44)}
					>
						Scroll
					</button>
					<button
						data-testid="file-preview-search"
						onClick={() => props.onSearchQueryChange?.('needle')}
					>
						Search
					</button>
					<button data-testid="file-preview-reload" onClick={props.onReloadFile}>
						Reload
					</button>
				</div>
			);
		}
	),
}));

vi.mock('../../renderer/components/GitStatusWidget', () => ({
	GitStatusWidget: (props: { onViewDiff: () => void; onViewLog?: () => void }) => (
		<div data-testid="git-status-widget">
			<button data-testid="view-diff" onClick={props.onViewDiff}>
				View diff
			</button>
			<button data-testid="view-log" onClick={props.onViewLog}>
				View log
			</button>
		</div>
	),
}));

vi.mock('../../renderer/components/TabBar', () => ({
	TabBar: (props: {
		tabs: Array<{ id: string; name?: string | null }>;
		onTabSelect: (id: string) => void;
		onNewTab: () => void;
	}) => (
		<div data-testid="tab-bar">
			{props.tabs.map((tab) => (
				<button
					key={tab.id}
					data-testid={`tab-${tab.id}`}
					onClick={() => props.onTabSelect(tab.id)}
				>
					{tab.name ?? tab.id}
				</button>
			))}
			<button data-testid="new-tab" onClick={props.onNewTab}>
				New tab
			</button>
		</div>
	),
}));

vi.mock('../../renderer/components/ErrorBoundary', () => ({
	ErrorBoundary: (props: { children: React.ReactNode }) => props.children,
}));

vi.mock('../../renderer/components/InlineWizard', () => ({
	WizardConversationView: (props: { conversationHistory: unknown[]; isLoading?: boolean }) => (
		<div data-testid="wizard-conversation-view">
			Wizard Conversation {props.conversationHistory.length}
			{props.isLoading && <span data-testid="wizard-loading"> loading</span>}
		</div>
	),
	DocumentGenerationView: (props: {
		documents: Array<{ filename: string }>;
		onComplete?: () => void;
		onDocumentSelect?: (index: number) => void;
		onContentChange?: (content: string, docIndex: number) => void;
		onCancel?: () => void;
		folderPath?: string;
	}) => (
		<div data-testid="document-generation-view">
			Document Generation {props.documents.length} {props.folderPath}
			<button data-testid="wizard-complete" onClick={props.onComplete}>
				Complete
			</button>
			<button data-testid="wizard-select" onClick={() => props.onDocumentSelect?.(1)}>
				Select
			</button>
			<button data-testid="wizard-change" onClick={() => props.onContentChange?.('updated', 0)}>
				Change
			</button>
			<button data-testid="wizard-cancel" onClick={props.onCancel}>
				Cancel
			</button>
		</div>
	),
}));

vi.mock('../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: mockSafeClipboardWrite,
}));

vi.mock('../../renderer/services/git', () => ({
	gitService: {
		getDiff: vi.fn().mockResolvedValue({ diff: 'mock diff content' }),
	},
}));

vi.mock('../../renderer/contexts/GitStatusContext', () => ({
	useGitBranch: () => ({
		getBranchInfo: (sessionId: string) => mockGitStatusData.current[sessionId],
	}),
	useGitFileStatus: () => ({
		getFileCount: (sessionId: string) => mockGitStatusData.current[sessionId]?.fileCount ?? 0,
		hasChanges: (sessionId: string) => (mockGitStatusData.current[sessionId]?.fileCount ?? 0) > 0,
	}),
	useGitDetail: () => ({
		getFileDetails: () => undefined,
		refreshGitStatus: mockRefreshGitStatus,
	}),
}));

import { MainPanel, type MainPanelHandle } from '../../renderer/components/MainPanel';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';

const AllProviders = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

function render(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
	return rtlRender(ui, { wrapper: AllProviders, ...options });
}

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#22d3ee',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const fullCapabilities: AgentCapabilities = {
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: true,
	supportsImageInputOnResume: true,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsUsageStats: true,
	supportsBatchMode: true,
	requiresPromptToStart: false,
	supportsStreaming: true,
	supportsResultMessages: true,
	supportsModelSelection: false,
	supportsStreamJsonInput: true,
	supportsThinkingDisplay: true,
	supportsContextMerge: true,
	supportsContextExport: true,
	supportsWizard: true,
	supportsGroupChatModeration: true,
	usesJsonLineOutput: false,
	usesCombinedContextWindow: true,
};

function aiTab(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tab-1',
		agentSessionId: 'claude-session-1234',
		name: 'Build tab',
		logs: [],
		createdAt: 1000,
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		usageStats: {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 100,
			cacheCreationInputTokens: 50,
			totalCostUsd: 0.05,
			contextWindow: 200000,
			reasoningTokens: 25,
		},
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	const aiTabs = overrides.aiTabs ?? [aiTab()];
	return {
		id: 'session-1',
		name: 'Main Integration Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1000,
		aiPid: 123,
		terminalPid: 456,
		port: 0,
		isLive: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId: aiTabs[0]?.id ?? 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
		shellCommandHistory: [],
		aiCommandHistory: [],
		customContextWindow: 200000,
		...overrides,
	} as Session;
}

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-1',
		path: '/repo/docs/readme.md',
		name: 'readme',
		extension: '.md',
		content: '# Readme',
		scrollTop: 5,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: 1000,
		lastModified: 1000,
		isLoading: false,
		navigationHistory: [{ path: '/repo/docs/readme.md', name: 'readme', scrollTop: 0 }],
		navigationIndex: 0,
		...overrides,
	};
}

function props(
	overrides: Partial<React.ComponentProps<typeof MainPanel>> = {}
): React.ComponentProps<typeof MainPanel> {
	return {
		logViewerOpen: false,
		agentSessionsOpen: false,
		activeAgentSessionId: null,
		activeSession: session(),
		thinkingItems: [] as ThinkingItem[],
		theme,
		inputValue: '',
		stagedImages: [],
		commandHistoryOpen: false,
		commandHistoryFilter: '',
		commandHistorySelectedIndex: 0,
		slashCommandOpen: false,
		slashCommands: [],
		selectedSlashCommandIndex: 0,
		setGitDiffPreview: vi.fn(),
		setLogViewerOpen: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		onResumeAgentSession: vi.fn(),
		onNewAgentSession: vi.fn(),
		setInputValue: vi.fn(),
		setStagedImages: vi.fn(),
		setLightboxImage: vi.fn(),
		setCommandHistoryOpen: vi.fn(),
		setCommandHistoryFilter: vi.fn(),
		setCommandHistorySelectedIndex: vi.fn(),
		setSlashCommandOpen: vi.fn(),
		setSelectedSlashCommandIndex: vi.fn(),
		setGitLogOpen: vi.fn(),
		inputRef: React.createRef<HTMLTextAreaElement>(),
		logsEndRef: React.createRef<HTMLDivElement>(),
		terminalOutputRef: React.createRef<HTMLDivElement>(),
		toggleInputMode: vi.fn(),
		processInput: vi.fn(),
		handleInterrupt: vi.fn(),
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
		getContextColor: vi.fn((usage: number) =>
			usage > 80 ? theme.colors.error : theme.colors.accent
		),
		setActiveSessionId: vi.fn(),
		onTabSelect: vi.fn(),
		onTabClose: vi.fn(),
		onNewTab: vi.fn(),
		onFileTabSelect: vi.fn(),
		onFileTabClose: vi.fn(),
		onFileTabEditModeChange: vi.fn(),
		onFileTabEditContentChange: vi.fn(),
		onFileTabScrollPositionChange: vi.fn(),
		onFileTabSearchQueryChange: vi.fn(),
		onReloadFileTab: vi.fn(),
		refreshFileTree: vi.fn().mockResolvedValue(undefined),
		onScrollPositionChange: vi.fn(),
		onAtBottomChange: vi.fn(),
		onSummarizeAndContinue: vi.fn(),
		...overrides,
	};
}

describe('MainPanel integration', () => {
	beforeEach(() => {
		clearCapabilitiesCache();
		setCapabilitiesCache('claude-code', fullCapabilities);
		vi.clearAllMocks();
		mockGitStatusData.current = {
			'session-1': {
				fileCount: 3,
				branch: 'main',
				remote: 'https://github.com/user/repo.git',
				ahead: 2,
				behind: 1,
			},
		};
		vi.mocked(window.maestro.agents.getCapabilities).mockResolvedValue(fullCapabilities);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ contextWindow: 200000 });
		Object.assign(window.maestro.fs, { writeFile: vi.fn().mockResolvedValue(undefined) });
		useUIStore.setState({
			activeFocus: 'none',
			rightPanelOpen: false,
			outputSearchOpen: false,
			outputSearchQuery: '',
			showUnreadOnly: false,
		});
		useSettingsStore.setState({
			fontFamily: 'monospace',
			enterToSendAI: true,
			enterToSendTerminal: false,
			chatRawTextMode: false,
			autoScrollAiMode: true,
			userMessageAlignment: 'right',
			maxOutputLines: 500,
			logLevel: 'info',
			logViewerSelectedLevels: ['info', 'warn', 'error'],
			colorBlindMode: false,
			shortcuts: {
				agentSessions: {
					id: 'agentSessions',
					label: 'Agent Sessions',
					keys: ['Meta', 'Shift', 'L'],
				},
				toggleRightPanel: {
					id: 'toggleRightPanel',
					label: 'Toggle Right Panel',
					keys: ['Meta', 'B'],
				},
			},
			contextManagementSettings: {
				contextWarningsEnabled: true,
				contextWarningYellowThreshold: 60,
				contextWarningRedThreshold: 80,
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		clearCapabilitiesCache();
	});

	it('routes log viewer, agent sessions, and empty-state panels', async () => {
		const setLogViewerOpen = vi.fn();
		render(<MainPanel {...props({ logViewerOpen: true, setLogViewerOpen })} />);
		fireEvent.click(screen.getByTestId('log-viewer-close'));
		expect(setLogViewerOpen).toHaveBeenCalledWith(false);

		cleanup();

		const setAgentSessionsOpen = vi.fn();
		const onNewAgentSession = vi.fn();
		render(
			<MainPanel
				{...props({
					agentSessionsOpen: true,
					setAgentSessionsOpen,
					onNewAgentSession,
				})}
			/>
		);
		await waitFor(() => expect(screen.getByTestId('agent-sessions-browser')).toBeInTheDocument());
		fireEvent.click(screen.getByTestId('agent-sessions-new'));
		fireEvent.click(screen.getByTestId('agent-sessions-close'));
		expect(onNewAgentSession).toHaveBeenCalledTimes(1);
		expect(setAgentSessionsOpen).toHaveBeenCalledWith(false);

		cleanup();

		render(<MainPanel {...props({ activeSession: null })} />);
		expect(screen.getByText('No agents. Create one to get started.')).toBeInTheDocument();
	});

	it('coordinates header, git, tab, terminal, input, and error actions', async () => {
		const activeSession = session({
			aiTabs: [
				aiTab({
					agentError: { message: 'Agent failed', recoverable: true },
				}),
			],
		});
		const setGitDiffPreview = vi.fn();
		const setGitLogOpen = vi.fn();
		const setAgentSessionsOpen = vi.fn();
		const setActiveAgentSessionId = vi.fn();
		const setActiveSessionId = vi.fn();
		const onStopBatchRun = vi.fn();
		const onTabSelect = vi.fn();
		const onNewTab = vi.fn();
		const onClearAgentError = vi.fn();
		const onShowAgentErrorModal = vi.fn();
		const handleInterrupt = vi.fn();
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		const onSummarizeAndContinue = vi.fn();

		render(
			<MainPanel
				{...props({
					activeSession,
					setGitDiffPreview,
					setGitLogOpen,
					setAgentSessionsOpen,
					setActiveAgentSessionId,
					setActiveSessionId,
					onStopBatchRun,
					onTabSelect,
					onNewTab,
					onClearAgentError,
					onShowAgentErrorModal,
					handleInterrupt,
					refreshFileTree,
					onSummarizeAndContinue,
					currentSessionBatchState: {
						isRunning: true,
						isStopping: false,
						completedTasks: 1,
						totalTasks: 3,
						worktreeActive: true,
						worktreeBranch: 'symphony/task',
					},
				})}
			/>
		);

		expect(screen.getByText('Main Integration Session')).toBeInTheDocument();
		expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
		expect(screen.getByTestId('input-area')).toBeInTheDocument();
		expect(screen.getByTestId('tab-bar')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Click to stop auto-run'));
		expect(onStopBatchRun).toHaveBeenCalledWith('session-1');
		fireEvent.click(screen.getByTestId('input-stop-auto-run'));
		expect(onStopBatchRun).toHaveBeenCalledWith('session-1');
		fireEvent.click(screen.getByTestId('input-summarize'));
		expect(onSummarizeAndContinue).toHaveBeenCalledWith('tab-1');

		fireEvent.click(screen.getByTestId('view-diff'));
		await waitFor(() => expect(setGitDiffPreview).toHaveBeenCalledWith('mock diff content'));
		expect(gitService.getDiff).toHaveBeenCalledWith('/repo', undefined, undefined);

		fireEvent.click(screen.getByTestId('view-log'));
		expect(setGitLogOpen).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByTitle(/Agent Sessions/));
		expect(setActiveAgentSessionId).toHaveBeenCalledWith(null);
		expect(setAgentSessionsOpen).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByTitle(/Show right panel/));
		expect(useUIStore.getState().rightPanelOpen).toBe(true);

		fireEvent.focus(screen.getByTestId('input-field'));
		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(useUIStore.getState().activeFocus).toBe('main');

		fireEvent.click(screen.getByTestId('input-session-click'));
		expect(setActiveSessionId).toHaveBeenCalledWith('session-2');
		expect(onTabSelect).toHaveBeenCalledWith('tab-2');

		fireEvent.click(screen.getByTestId('tab-tab-1'));
		fireEvent.click(screen.getByTestId('new-tab'));
		expect(onTabSelect).toHaveBeenCalledWith('tab-1');
		expect(onNewTab).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText('View Details'));
		fireEvent.click(screen.getByTitle('Dismiss error'));
		expect(onShowAgentErrorModal).toHaveBeenCalledTimes(1);
		expect(onClearAgentError).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTestId('terminal-interrupt'));
		expect(handleInterrupt).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTestId('terminal-file-saved'));
		expect(refreshFileTree).toHaveBeenCalledWith('session-1');
	});

	it('drives file preview callbacks and exposed focus/refresh handles', async () => {
		const activeFileTab = fileTab();
		const activeSession = session({
			activeFileTabId: activeFileTab.id,
			filePreviewTabs: [activeFileTab],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'file', id: activeFileTab.id },
			],
		});
		const ref = React.createRef<MainPanelHandle>();
		const onFileTabClose = vi.fn();
		const onFileTabEditModeChange = vi.fn();
		const onFileTabEditContentChange = vi.fn();
		const onFileTabScrollPositionChange = vi.fn();
		const onFileTabSearchQueryChange = vi.fn();
		const onReloadFileTab = vi.fn();

		render(
			<MainPanel
				ref={ref}
				{...props({
					activeSession,
					activeFileTabId: activeFileTab.id,
					activeFileTab,
					onFileTabClose,
					onFileTabEditModeChange,
					onFileTabEditContentChange,
					onFileTabScrollPositionChange,
					onFileTabSearchQueryChange,
					onReloadFileTab,
				})}
			/>
		);

		expect(await screen.findByText(/File Preview:\s*readme\.md/)).toBeInTheDocument();
		expect(screen.getByTestId('file-preview-cwd')).toHaveTextContent('docs');

		fireEvent.click(screen.getByTestId('file-preview-edit-mode'));
		fireEvent.click(screen.getByTestId('file-preview-edit-content'));
		fireEvent.click(screen.getByTestId('file-preview-scroll'));
		fireEvent.click(screen.getByTestId('file-preview-search'));
		fireEvent.click(screen.getByTestId('file-preview-reload'));
		fireEvent.click(screen.getByTestId('file-preview-close'));
		fireEvent.click(screen.getByTestId('file-preview-save'));

		await waitFor(() =>
			expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
				'/repo/docs/readme.md',
				'saved',
				undefined
			)
		);
		expect(onFileTabEditModeChange).toHaveBeenCalledWith(activeFileTab.id, true);
		expect(onFileTabEditContentChange).toHaveBeenCalledWith(activeFileTab.id, 'changed');
		expect(onFileTabScrollPositionChange).toHaveBeenCalledWith(activeFileTab.id, 44);
		expect(onFileTabSearchQueryChange).toHaveBeenCalledWith(activeFileTab.id, 'needle');
		expect(onReloadFileTab).toHaveBeenCalledWith(activeFileTab.id);
		expect(onFileTabClose).toHaveBeenCalledWith(activeFileTab.id);
		expect(onFileTabEditContentChange).toHaveBeenCalledWith(activeFileTab.id, undefined, 'saved');

		ref.current?.focusFilePreview();
		expect(mockFilePreviewFocus).toHaveBeenCalledTimes(1);
		await ref.current?.refreshGitInfo();
		expect(mockRefreshGitStatus).toHaveBeenCalledTimes(1);

		cleanup();

		const outsideFileTab = fileTab({ path: '/outside/readme.md' });
		render(
			<MainPanel
				{...props({
					activeSession: session({
						activeFileTabId: outsideFileTab.id,
						filePreviewTabs: [outsideFileTab],
					}),
					activeFileTabId: outsideFileTab.id,
					activeFileTab: outsideFileTab,
				})}
			/>
		);
		expect(screen.getByTestId('file-preview-cwd')).toHaveTextContent('');
	});

	it('guards git diff viewing when the active session is not a repository', async () => {
		render(<MainPanel {...props({ activeSession: session({ isGitRepo: false }) })} />);

		fireEvent.click(screen.getByTestId('view-diff'));

		expect(gitService.getDiff).not.toHaveBeenCalled();
	});

	it('renders loading and wizard content branches', () => {
		const activeFileTab = fileTab({ isLoading: true });
		const loadingView = render(
			<MainPanel
				{...props({
					activeSession: session({
						activeFileTabId: activeFileTab.id,
						filePreviewTabs: [activeFileTab],
					}),
					activeFileTabId: activeFileTab.id,
					activeFileTab,
				})}
			/>
		);
		expect(screen.getByText('Loading readme.md')).toBeInTheDocument();
		loadingView.unmount();

		const onWizardComplete = vi.fn();
		const onWizardDocumentSelect = vi.fn();
		const onWizardContentChange = vi.fn();
		const onWizardCancelGeneration = vi.fn();
		render(
			<MainPanel
				{...props({
					activeSession: session({
						aiTabs: [
							aiTab({
								wizardState: {
									isActive: true,
									isGeneratingDocs: true,
									generatedDocuments: [{ filename: 'plan.md', content: '# Plan' }],
									currentDocumentIndex: 0,
									subfolderPath: '/repo/Auto Run Docs',
								},
							}),
						],
					}),
					onWizardComplete,
					onWizardDocumentSelect,
					onWizardContentChange,
					onWizardCancelGeneration,
				})}
			/>
		);
		expect(screen.getByTestId('document-generation-view')).toHaveTextContent(
			'Document Generation 1'
		);
		fireEvent.click(screen.getByTestId('wizard-complete'));
		fireEvent.click(screen.getByTestId('wizard-select'));
		fireEvent.click(screen.getByTestId('wizard-change'));
		fireEvent.click(screen.getByTestId('wizard-cancel'));
		expect(onWizardComplete).toHaveBeenCalledTimes(1);
		expect(onWizardDocumentSelect).toHaveBeenCalledWith(1);
		expect(onWizardContentChange).toHaveBeenCalledWith('updated', 0);
		expect(onWizardCancelGeneration).toHaveBeenCalledTimes(1);
		cleanup();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						aiTabs: [
							aiTab({
								wizardState: {
									isActive: true,
									isWaiting: true,
									conversationHistory: [{ id: 'msg-1', role: 'assistant', content: 'Ready' }],
									confidence: 80,
								},
							}),
						],
					}),
				})}
			/>
		);
		expect(screen.getByTestId('wizard-conversation-view')).toHaveTextContent(
			'Wizard Conversation 1'
		);
		expect(screen.getByTestId('wizard-loading')).toBeInTheDocument();
	});

	it('loads configured context windows and handles config failures', async () => {
		const baseTab = aiTab();
		const activeSession = session({
			customContextWindow: undefined,
			aiTabs: [
				aiTab({
					usageStats: {
						...(baseTab.usageStats as Record<string, unknown>),
						contextWindow: 0,
					},
				}),
			],
		});

		vi.mocked(window.maestro.agents.getConfig).mockResolvedValueOnce({ contextWindow: 123456 });

		render(<MainPanel {...props({ activeSession })} />);

		await waitFor(() =>
			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('claude-code')
		);
		await waitFor(() => expect(screen.getByText('Context Window')).toBeInTheDocument());

		cleanup();

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(window.maestro.agents.getConfig).mockRejectedValueOnce(new Error('config failed'));

		render(<MainPanel {...props({ activeSession })} />);

		await waitFor(() =>
			expect(vi.mocked(window.maestro.agents.getConfig).mock.calls.length).toBeGreaterThanOrEqual(2)
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('resolves SSH remote names and falls back for failed remote lookups', async () => {
		const setGitLogOpen = vi.fn();
		const remoteSession = session({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			sshRemoteId: 'remote-1',
		});

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
			success: true,
			configs: [{ id: 'remote-1', name: 'Remote Lab' }],
		});

		render(<MainPanel {...props({ activeSession: remoteSession, setGitLogOpen })} />);

		const sshPill = await screen.findByTitle(/SSH Remote: Remote Lab/);
		fireEvent.click(sshPill);

		expect(mockRefreshGitStatus).toHaveBeenCalledTimes(1);
		expect(setGitLogOpen).toHaveBeenCalledWith(true);

		cleanup();

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
			success: false,
			configs: [],
		});

		render(<MainPanel {...props({ activeSession: remoteSession })} />);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2));
		expect(screen.queryByText('Remote Lab')).not.toBeInTheDocument();

		cleanup();

		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValueOnce(new Error('offline'));

		render(<MainPanel {...props({ activeSession: remoteSession })} />);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(3));
		expect(screen.queryByText('Remote Lab')).not.toBeInTheDocument();

		cleanup();

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
			success: true,
			configs: [{ id: 'other-remote', name: 'Other Lab' }],
		});

		render(<MainPanel {...props({ activeSession: remoteSession })} />);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(4));
		expect(screen.queryByText('Other Lab')).not.toBeInTheDocument();
	});

	it('drives git tooltip copy, browser, and worktree actions', async () => {
		const setGitLogOpen = vi.fn();
		const onOpenWorktreeConfig = vi.fn();

		render(<MainPanel {...props({ setGitLogOpen, onOpenWorktreeConfig })} />);

		const gitPill = screen.getByTitle('main');
		fireEvent.click(gitPill);

		expect(mockRefreshGitStatus).toHaveBeenCalledTimes(1);
		expect(setGitLogOpen).toHaveBeenCalledWith(true);

		fireEvent.mouseEnter(gitPill);

		expect(await screen.findByText('Origin')).toBeInTheDocument();

		vi.useFakeTimers();
		try {
			await act(async () => {
				fireEvent.click(screen.getByTitle('Copy branch name'));
			});
			await act(async () => {
				fireEvent.click(screen.getByTitle('Copy remote URL'));
			});
			act(() => {
				vi.runOnlyPendingTimers();
			});
		} finally {
			vi.useRealTimers();
		}

		expect(mockSafeClipboardWrite).toHaveBeenCalledWith('main');
		expect(mockSafeClipboardWrite).toHaveBeenCalledWith('https://github.com/user/repo.git');

		fireEvent.click(screen.getByTitle('Open https://github.com/user/repo.git'));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://github.com/user/repo');

		fireEvent.click(screen.getByText('Configure Worktrees'));
		expect(onOpenWorktreeConfig).toHaveBeenCalledTimes(1);

		cleanup();

		const onOpenCreatePR = vi.fn();
		render(
			<MainPanel
				{...props({
					activeSession: session({ parentSessionId: 'parent-session' }),
					isWorktreeChild: true,
					onOpenCreatePR,
				})}
			/>
		);

		const worktreeGitPill = screen.getByTitle('main').closest('div');
		expect(worktreeGitPill).not.toBeNull();
		fireEvent.mouseEnter(worktreeGitPill!);
		await screen.findByText('Branch');
		fireEvent.click(await screen.findByText('Create Pull Request'));

		expect(onOpenCreatePR).toHaveBeenCalledTimes(1);
	});

	it('renders settings, capability, and context fallback states', async () => {
		useSettingsStore.setState({
			shortcuts: {
				toggleRightPanel: {
					id: 'toggleRightPanel',
					label: 'Toggle Right Panel',
					keys: ['Meta', 'B'],
				},
			} as any,
			contextManagementSettings: {} as any,
		});
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValueOnce({});

		render(
			<MainPanel
				{...props({
					activeSession: session({
						customContextWindow: undefined,
						contextUsage: 42,
						aiTabs: [
							aiTab({
								name: undefined,
								usageStats: {
									contextWindow: 1000,
								},
							}),
						],
					}),
					onSummarizeAndContinue: undefined,
				})}
			/>
		);

		await waitFor(() =>
			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('claude-code')
		);
		expect(screen.getByText('$0.00')).toBeInTheDocument();
		expect(screen.getByTitle(/Agent Sessions/)).toBeInTheDocument();

		const contextWidget = screen.getByText('Context Window').closest('.header-context-widget');
		expect(contextWidget).not.toBeNull();
		fireEvent.mouseEnter(contextWidget!);
		expect(await screen.findByText('Context Details')).toBeInTheDocument();

		cleanup();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						aiTabs: [
							aiTab({
								agentSessionId: undefined,
								usageStats: {
									inputTokens: 10,
									outputTokens: 5,
									contextWindow: 1000,
								},
							}),
						],
					}),
				})}
			/>
		);

		expect(screen.getByText('$0.00')).toBeInTheDocument();

		cleanup();

		const setActiveSessionId = vi.fn();
		render(
			<MainPanel
				{...props({
					setActiveSessionId,
					onTabSelect: undefined,
					refreshFileTree: undefined,
				})}
			/>
		);
		fireEvent.click(screen.getByTestId('input-session-click'));
		expect(setActiveSessionId).toHaveBeenCalledWith('session-2');

		const reasoningContextWidget = screen
			.getByText('Context Window')
			.closest('.header-context-widget');
		expect(reasoningContextWidget).not.toBeNull();
		fireEvent.mouseEnter(reasoningContextWidget!);
		expect(await screen.findByText('Reasoning Tokens')).toBeInTheDocument();
	});

	it('covers git header fallbacks, ssh non-repo display, and terminal cwd diff handling', async () => {
		const setGitLogOpen = vi.fn();
		mockGitStatusData.current['session-1'] = {
			fileCount: 0,
			branch: '',
			remote: '',
			ahead: 0,
			behind: 0,
		};

		render(<MainPanel {...props({ setGitLogOpen })} />);

		const gitPill = screen.getByText('GIT').closest('span');
		expect(gitPill).not.toBeNull();
		fireEvent.mouseEnter(gitPill!);
		expect(await screen.findByText('Working tree clean')).toBeInTheDocument();

		cleanup();

		mockGitStatusData.current['session-1'] = {
			fileCount: 1,
			branch: 'feature/count',
			remote: '',
			ahead: 0,
			behind: 0,
		};
		render(<MainPanel {...props()} />);
		fireEvent.mouseEnter(screen.getByTitle('feature/count'));
		expect(await screen.findByText(/1 uncommitted/)).toHaveTextContent('1 uncommitted change');

		cleanup();

		render(
			<MainPanel {...props({ activeSession: session({ isGitRepo: false }), setGitLogOpen })} />
		);
		fireEvent.click(screen.getByText('LOCAL'));
		expect(setGitLogOpen).not.toHaveBeenCalled();

		cleanup();

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
			success: true,
			configs: [{ id: 'remote-1', name: 'Remote Lab' }],
		});
		render(
			<MainPanel
				{...props({
					activeSession: session({
						isGitRepo: false,
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
						sshRemoteId: 'remote-1',
					}),
					setGitLogOpen,
				})}
			/>
		);
		const sshPill = await screen.findByTitle('SSH Remote: Remote Lab');
		fireEvent.click(sshPill);
		expect(setGitLogOpen).not.toHaveBeenCalled();

		cleanup();

		const setGitDiffPreview = vi.fn();
		vi.mocked(gitService.getDiff).mockResolvedValueOnce({ diff: '' });
		render(<MainPanel {...props({ setGitDiffPreview })} />);
		fireEvent.click(screen.getByTestId('view-diff'));
		await waitFor(() => expect(gitService.getDiff).toHaveBeenCalled());
		expect(setGitDiffPreview).not.toHaveBeenCalled();

		cleanup();

		mockGitStatusData.current['session-1'] = {
			fileCount: 1,
			branch: 'feature/invalid-remote',
			remote: 'not-a-remote',
			ahead: 0,
			behind: 0,
		};
		render(<MainPanel {...props()} />);
		fireEvent.mouseEnter(screen.getByTitle('feature/invalid-remote'));
		fireEvent.click(await screen.findByTitle('Open not-a-remote'));
		expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();

		cleanup();

		const terminalSession = session({
			inputMode: 'terminal',
			shellCwd: '/repo/subdir',
			cwd: '/repo',
			fullPath: '/repo',
		});
		render(<MainPanel {...props({ activeSession: terminalSession })} />);
		fireEvent.click(screen.getByTestId('view-diff'));
		await waitFor(() =>
			expect(gitService.getDiff).toHaveBeenLastCalledWith('/repo/subdir', undefined, undefined)
		);

		cleanup();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						inputMode: 'terminal',
						shellCwd: '',
						cwd: '/outside',
						fullPath: '/repo',
					}),
				})}
			/>
		);
		expect(screen.getByTestId('terminal-cwd')).toHaveTextContent('');
		fireEvent.click(screen.getByTestId('view-diff'));
		await waitFor(() =>
			expect(gitService.getDiff).toHaveBeenLastCalledWith('/outside', undefined, undefined)
		);
	});

	it('covers file preview root paths, unchanged edits, and focus fallback', async () => {
		const activeFileTab = fileTab({
			path: '/repo/readme.md',
			content: 'changed',
		});
		const onFileTabEditContentChange = vi.fn();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						activeFileTabId: activeFileTab.id,
						filePreviewTabs: [activeFileTab],
					}),
					activeFileTabId: activeFileTab.id,
					activeFileTab,
					onFileTabEditContentChange,
				})}
			/>
		);

		expect(screen.getByTestId('file-preview-cwd')).toHaveTextContent('');
		fireEvent.click(screen.getByTestId('file-preview-edit-content'));
		expect(onFileTabEditContentChange).toHaveBeenCalledWith(activeFileTab.id, undefined);

		cleanup();

		const ref = React.createRef<MainPanelHandle>();
		mockFilePreviewFocus.mockClear();
		render(<MainPanel ref={ref} {...props()} />);

		ref.current?.focusFilePreview();
		expect(mockFilePreviewFocus).not.toHaveBeenCalled();
	});

	it('renders loading, wizard, and stopping auto-run fallback states', async () => {
		const loadingFileTab = fileTab({
			id: 'remote-file',
			path: '/repo/remote.md',
			name: 'remote',
			extension: '.md',
			isLoading: true,
		});
		render(
			<MainPanel
				{...props({
					activeSession: session({
						activeFileTabId: loadingFileTab.id,
						filePreviewTabs: [loadingFileTab],
					}),
					activeFileTabId: loadingFileTab.id,
					activeFileTab: loadingFileTab,
				})}
			/>
		);
		expect(screen.getByText(/Loading\s*remote\.md/)).toBeInTheDocument();

		cleanup();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						aiTabs: [
							aiTab({
								wizardState: {
									isActive: true,
									generatedDocuments: [{ filename: 'notes.md', content: '# Notes' }],
									autoRunFolderPath: '/repo/Generated',
								},
							}),
						],
					}),
				})}
			/>
		);
		expect(screen.getByTestId('document-generation-view')).toHaveTextContent(
			'Document Generation 1 /repo/Generated'
		);

		cleanup();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						aiTabs: [
							aiTab({
								wizardState: {
									isActive: true,
									isGeneratingDocs: true,
								},
							}),
						],
					}),
				})}
			/>
		);
		expect(screen.getByTestId('document-generation-view')).toHaveTextContent(
			'Document Generation 0'
		);

		cleanup();

		render(
			<MainPanel
				{...props({
					activeSession: session({
						aiTabs: [
							aiTab({
								wizardState: {
									isActive: true,
									conversationHistory: [],
								},
							}),
						],
					}),
				})}
			/>
		);
		expect(screen.getByTestId('wizard-conversation-view')).toHaveTextContent(
			'Wizard Conversation 0'
		);
		expect(screen.queryByTestId('wizard-loading')).not.toBeInTheDocument();

		cleanup();

		const onStopBatchRun = vi.fn();
		render(
			<MainPanel
				{...props({
					onStopBatchRun,
					currentSessionBatchState: {
						isRunning: true,
						isStopping: true,
						completedTasks: 2,
						totalTasks: 4,
						worktreeActive: true,
						worktreeBranch: '',
					},
				})}
			/>
		);

		expect(screen.getByText('Stopping')).toBeInTheDocument();
		expect(screen.getByTitle('Stopping after current task...')).toBeDisabled();
		expect(screen.getByTitle('Worktree: active')).toBeInTheDocument();
	});

	it('ignores late config failures after unmount', async () => {
		let rejectConfig: (error: Error) => void = () => undefined;
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(window.maestro.agents.getConfig).mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectConfig = reject;
			}) as ReturnType<typeof window.maestro.agents.getConfig>
		);

		const view = render(
			<MainPanel
				{...props({
					activeSession: session({ customContextWindow: undefined }),
				})}
			/>
		);
		view.unmount();

		await act(async () => {
			rejectConfig(new Error('late config failure'));
		});

		expect(consoleError).not.toHaveBeenCalled();
	});
});
