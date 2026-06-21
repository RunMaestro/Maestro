import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MaestroConsole from '../../renderer/App';
import { WizardProvider } from '../../renderer/components/Wizard';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../renderer/constants/themes';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useCenterFlashStore } from '../../renderer/stores/centerFlashStore';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { DEFAULT_ENCORE_FEATURES, useSettingsStore } from '../../renderer/stores/settingsStore';
import { useTabStore } from '../../renderer/stores/tabStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import type { AITab, FilePreviewTab, Session } from '../../renderer/types';

const mockAppModalsState = vi.hoisted(() => ({ latestProps: null as Record<string, any> | null }));
const mockDeleteAgentConfirmState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));
const mockKeyboardHandlerState = vi.hoisted(() => ({
	latestRef: null as { current?: Record<string, any> | null } | null,
}));
const mockMainPanelState = vi.hoisted(() => ({
	focusFilePreviewCalls: 0,
	latestProps: null as Record<string, any> | null,
}));
const mockRightPanelState = vi.hoisted(() => ({
	completedTaskCount: 4,
	latestProps: null as Record<string, any> | null,
	refreshHistoryPanelCalls: 0,
}));
const mockSessionNavigationState = vi.hoisted(() => ({
	latestDeps: null as Record<string, any> | null,
}));
const mockPropsHookState = vi.hoisted(() => ({
	latestRightPanelProps: null as Record<string, any> | null,
}));
const mockLazyState = vi.hoisted(() => ({
	debugPackageProps: null as Record<string, any> | null,
	debugWizardProps: null as Record<string, any> | null,
	directorNotesProps: null as Record<string, any> | null,
	documentGraphProps: null as Record<string, any> | null,
	gistProps: null as Record<string, any> | null,
	groupChatPanelProps: null as Record<string, any> | null,
	groupChatRightPanelProps: null as Record<string, any> | null,
	marketplaceProps: null as Record<string, any> | null,
	playgroundProps: null as Record<string, any> | null,
	settingsProps: null as Record<string, any> | null,
	symphonyProps: null as Record<string, any> | null,
	toastProps: null as Record<string, any> | null,
	tourProps: null as Record<string, any> | null,
	windowsWarningProps: null as Record<string, any> | null,
	wizardProps: null as Record<string, any> | null,
	wizardResumeProps: null as Record<string, any> | null,
}));

vi.mock('../../renderer/components/AppModals', () => ({
	AppModals: (props: Record<string, any>) => {
		mockAppModalsState.latestProps = props;
		return <div data-testid="app-modals" />;
	},
}));

vi.mock('../../renderer/components/MainPanel', async () => {
	const React = await vi.importActual<typeof import('react')>('react');
	return {
		MainPanel: React.forwardRef(function MockMainPanel(props: Record<string, any>, ref) {
			mockMainPanelState.latestProps = props;
			React.useImperativeHandle(ref, () => ({
				focusFilePreview: () => {
					mockMainPanelState.focusFilePreviewCalls += 1;
				},
				refreshGitInfo: vi.fn().mockResolvedValue(undefined),
			}));
			return <main data-testid="main-panel" />;
		}),
	};
});

vi.mock('../../renderer/components/RightPanel', async () => {
	const React = await vi.importActual<typeof import('react')>('react');
	return {
		RightPanel: React.forwardRef(function MockRightPanel(props: Record<string, any>, ref) {
			mockRightPanelState.latestProps = props;
			React.useImperativeHandle(ref, () => ({
				focusAutoRun: vi.fn(),
				getAutoRunCompletedTaskCount: () => mockRightPanelState.completedTaskCount,
				openAutoRunResetTasksModal: vi.fn(),
				refreshHistoryPanel: () => {
					mockRightPanelState.refreshHistoryPanelCalls += 1;
				},
				toggleAutoRunExpanded: vi.fn(),
			}));
			return <aside data-testid="right-panel" />;
		}),
	};
});

vi.mock('../../renderer/components/Toast', () => ({
	ToastContainer: (props: Record<string, any>) => {
		mockLazyState.toastProps = props;
		return <div data-testid="toast-container" />;
	},
}));

vi.mock('../../renderer/components/Settings/SettingsModal', () => ({
	SettingsModal: (props: Record<string, any>) => {
		mockLazyState.settingsProps = props;
		return props.isOpen ? <div data-testid="settings-modal">Settings Modal</div> : null;
	},
}));

vi.mock('../../renderer/components/MarketplaceModal', () => ({
	MarketplaceModal: (props: Record<string, any>) => {
		mockLazyState.marketplaceProps = props;
		return <div data-testid="marketplace-modal">Marketplace Modal</div>;
	},
}));

vi.mock('../../renderer/components/GistPublishModal', () => ({
	GistPublishModal: (props: Record<string, any>) => {
		mockLazyState.gistProps = props;
		return <div data-testid="gist-publish-modal">Gist Publish Modal</div>;
	},
}));

vi.mock('../../renderer/components/SymphonyModal', () => ({
	SymphonyModal: (props: Record<string, any>) => {
		mockLazyState.symphonyProps = props;
		return <div data-testid="symphony-modal">Symphony Modal</div>;
	},
}));

vi.mock('../../renderer/components/DirectorNotes', () => ({
	DirectorNotesModal: (props: Record<string, any>) => {
		mockLazyState.directorNotesProps = props;
		return <div data-testid="director-notes-modal">Director Notes</div>;
	},
}));

vi.mock('../../renderer/components/DocumentGraph/DocumentGraphView', () => ({
	DocumentGraphView: (props: Record<string, any>) => {
		mockLazyState.documentGraphProps = props;
		return <div data-testid="document-graph-view">{props.focusFilePath}</div>;
	},
}));

vi.mock('../../renderer/components/LogViewer', () => ({
	LogViewer: () => <section data-testid="log-viewer">Log Viewer</section>,
}));

vi.mock('../../renderer/components/GroupChatPanel', () => ({
	GroupChatPanel: (props: Record<string, any>) => {
		mockLazyState.groupChatPanelProps = props;
		return <section data-testid="group-chat-panel">{props.groupChat.name}</section>;
	},
}));

vi.mock('../../renderer/components/GroupChatRightPanel', () => ({
	GroupChatRightPanel: (props: Record<string, any>) => {
		mockLazyState.groupChatRightPanelProps = props;
		return <aside data-testid="group-chat-right-panel">{props.activeTab}</aside>;
	},
}));

vi.mock('../../renderer/components/WindowsWarningModal', () => ({
	exposeWindowsWarningModalDebug: vi.fn(),
	WindowsWarningModal: (props: Record<string, any>) => {
		mockLazyState.windowsWarningProps = props;
		return props.isOpen ? <div data-testid="windows-warning-modal" /> : null;
	},
}));

vi.mock('../../renderer/components/DebugPackageModal', () => ({
	DebugPackageModal: (props: Record<string, any>) => {
		mockLazyState.debugPackageProps = props;
		return props.isOpen ? <div data-testid="debug-package-modal" /> : null;
	},
}));

vi.mock('../../renderer/components/PlaygroundPanel', () => ({
	PlaygroundPanel: (props: Record<string, any>) => {
		mockLazyState.playgroundProps = props;
		return <div data-testid="playground-panel" />;
	},
}));

vi.mock('../../renderer/components/DebugWizardModal', () => ({
	DebugWizardModal: (props: Record<string, any>) => {
		mockLazyState.debugWizardProps = props;
		return props.isOpen ? <div data-testid="debug-wizard-modal" /> : null;
	},
}));

vi.mock('../../renderer/components/DeleteAgentConfirmModal', () => ({
	DeleteAgentConfirmModal: (props: Record<string, any>) => {
		mockDeleteAgentConfirmState.latestProps = props;
		return <div data-testid="delete-agent-confirm-modal" />;
	},
}));

vi.mock('../../renderer/components/Wizard/tour', () => ({
	TourOverlay: (props: Record<string, any>) => {
		mockLazyState.tourProps = props;
		return props.isOpen ? <div data-testid="tour-overlay" /> : null;
	},
}));

vi.mock('../../renderer/components/Wizard', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/components/Wizard')>(
		'../../renderer/components/Wizard'
	);
	return {
		...actual,
		MaestroWizard: (props: Record<string, any>) => {
			mockLazyState.wizardProps = props;
			return <div data-testid="maestro-wizard" />;
		},
		WizardResumeModal: (props: Record<string, any>) => {
			mockLazyState.wizardResumeProps = props;
			return <div data-testid="wizard-resume-modal">{props.resumeState.currentStep}</div>;
		},
	};
});

vi.mock('../../renderer/hooks/keyboard/useMainKeyboardHandler', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../renderer/hooks/keyboard/useMainKeyboardHandler')>();

	return {
		...actual,
		useMainKeyboardHandler: () => {
			const result = actual.useMainKeyboardHandler();
			mockKeyboardHandlerState.latestRef = result.keyboardHandlerRef;
			return result;
		},
	};
});

vi.mock('../../renderer/hooks/session/useSessionNavigation', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../renderer/hooks/session/useSessionNavigation')>();

	return {
		...actual,
		useSessionNavigation: (
			sessions: Parameters<typeof actual.useSessionNavigation>[0],
			deps: Parameters<typeof actual.useSessionNavigation>[1]
		) => {
			mockSessionNavigationState.latestDeps = deps as Record<string, any>;
			return actual.useSessionNavigation(sessions, deps);
		},
	};
});

vi.mock('../../renderer/hooks/props', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../renderer/hooks/props')>();

	return {
		...actual,
		useRightPanelProps: (deps: Parameters<typeof actual.useRightPanelProps>[0]) => {
			const props = actual.useRightPanelProps(deps);
			mockPropsHookState.latestRightPanelProps = props as Record<string, any>;
			return props;
		},
	};
});

function configureMaestroBridge() {
	const maestro = window.maestro as unknown as Record<string, any>;

	maestro.power = {
		addReason: vi.fn().mockResolvedValue(undefined),
		getStatus: vi.fn().mockResolvedValue({ platform: 'darwin' }),
		removeReason: vi.fn().mockResolvedValue(undefined),
		setEnabled: vi.fn().mockResolvedValue(undefined),
	};
	maestro.updates = {
		check: vi.fn().mockResolvedValue({ updateAvailable: false, error: null }),
		download: vi.fn().mockResolvedValue({ success: true }),
		install: vi.fn(),
		onStatus: vi.fn().mockReturnValue(() => {}),
		setAllowPrerelease: vi.fn(),
	};
	maestro.groupChat = {
		archive: vi.fn().mockResolvedValue({ success: true }),
		create: vi.fn().mockResolvedValue({ id: 'chat-1', name: 'Chat', participants: [] }),
		delete: vi.fn().mockResolvedValue({ success: true }),
		getHistory: vi.fn().mockResolvedValue([]),
		getImages: vi.fn().mockResolvedValue([]),
		getMessages: vi.fn().mockResolvedValue([]),
		list: vi.fn().mockResolvedValue([]),
		load: vi.fn().mockResolvedValue(null),
		onAutoRunBatchComplete: vi.fn().mockReturnValue(() => {}),
		onAutoRunTriggered: vi.fn().mockReturnValue(() => {}),
		onHistoryEntry: vi.fn().mockReturnValue(() => {}),
		onMessage: vi.fn().mockReturnValue(() => {}),
		onModeratorSessionIdChanged: vi.fn().mockReturnValue(() => {}),
		onModeratorUsage: vi.fn().mockReturnValue(() => {}),
		onParticipantLiveOutput: vi.fn().mockReturnValue(() => {}),
		onParticipantState: vi.fn().mockReturnValue(() => {}),
		onParticipantsChanged: vi.fn().mockReturnValue(() => {}),
		onStateChange: vi.fn().mockReturnValue(() => {}),
		reportAutoRunComplete: vi.fn().mockResolvedValue(undefined),
		sendToModerator: vi.fn().mockResolvedValue(undefined),
		startModerator: vi.fn().mockResolvedValue('moderator-session'),
		stopAll: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue({ success: true }),
	};
	for (const listenerName of [
		'onAgentError',
		'onCommandExit',
		'onData',
		'onExit',
		'onRemoteCloseTab',
		'onRemoteCommand',
		'onRemoteInterrupt',
		'onRemoteNewTab',
		'onRemoteRenameTab',
		'onRemoteReorderTab',
		'onRemoteSelectSession',
		'onRemoteSelectTab',
		'onRemoteStarTab',
		'onRemoteSwitchMode',
		'onRemoteToggleBookmark',
		'onSessionId',
		'onSlashCommands',
		'onSshRemote',
		'onStderr',
		'onThinkingChunk',
		'onToolExecution',
		'onUsage',
	]) {
		maestro.process[listenerName] = vi.fn().mockReturnValue(() => {});
	}
	maestro.process.getActiveProcesses = vi.fn().mockResolvedValue([]);
	maestro.process.interrupt = vi.fn().mockResolvedValue(undefined);
	maestro.process.sendRemoteNewTabResponse = vi.fn();
	maestro.git.onWorktreeDiscovered = vi.fn().mockReturnValue(() => {});
	maestro.sessions.getAll = vi.fn().mockResolvedValue([]);
	maestro.speckit = {
		getCommand: vi.fn().mockResolvedValue({ success: true, command: null }),
		getMetadata: vi.fn().mockResolvedValue({ success: true, metadata: null }),
		getPrompts: vi.fn().mockResolvedValue({ success: true, commands: [] }),
	};
	maestro.openspec = {
		getCommand: vi.fn().mockResolvedValue({ success: true, command: null }),
		getMetadata: vi.fn().mockResolvedValue({ success: true, metadata: null }),
		getPrompts: vi.fn().mockResolvedValue({ success: true, commands: [] }),
	};
	maestro.history = {
		add: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(true),
		getAll: vi.fn().mockResolvedValue([]),
		getFilePath: vi.fn().mockResolvedValue(null),
		onExternalChange: vi.fn().mockReturnValue(() => {}),
		reload: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(true),
	};
	maestro.agentError = { clearError: vi.fn().mockResolvedValue(undefined) };
	maestro.agents.get = vi.fn().mockResolvedValue({
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		args: [],
	});
	maestro.agents.discoverSlashCommands = vi.fn().mockResolvedValue([]);
	maestro.claude.getCommands = vi.fn().mockResolvedValue([]);
	maestro.autorun.onFileChanged = vi.fn().mockReturnValue(() => {});
	maestro.git.tags = vi.fn().mockResolvedValue({ tags: [] });
	maestro.stats.getInitializationResult = vi.fn().mockResolvedValue(null);
	maestro.stats.clearInitializationResult = vi.fn();

	return maestro;
}

function resetRendererStores() {
	useSessionStore.setState({
		activeSessionId: '',
		cyclePosition: -1,
		groups: [],
		initialLoadComplete: true,
		removedWorktreePaths: new Set(),
		sessions: [],
		sessionsLoaded: true,
	});
	useUIStore.setState({
		activeFocus: 'main',
		activeRightTab: 'files',
		bookmarksCollapsed: false,
		draggingSessionId: null,
		editingGroupId: null,
		editingSessionId: null,
		flashNotification: null,
		leftSidebarOpen: true,
		rightPanelOpen: true,
		selectedSidebarIndex: 0,
		showUnreadOnly: false,
		successFlashNotification: null,
	});
	useCenterFlashStore.setState({ active: null });
	useGroupChatStore.setState({
		activeGroupChatId: null,
		allGroupChatParticipantStates: new Map(),
		groupChatError: null,
		groupChatExecutionQueue: [],
		groupChatMessages: [],
		groupChatParticipantColors: {},
		groupChatReadOnlyMode: false,
		groupChatRightTab: 'participants',
		groupChatStagedImages: [],
		groupChatState: 'idle',
		groupChatStates: new Map(),
		groupChats: [],
		moderatorUsage: null,
		participantLiveOutput: new Map(),
		participantStates: new Map(),
	});
	useBatchStore.setState({
		documentList: [],
		documentTree: [],
		isLoadingDocuments: false,
	});
	useFileExplorerStore.setState({
		filePreviewLoading: false,
		graphFocusFilePath: null,
		isGraphViewOpen: false,
		lastGraphFocusFilePath: null,
	});
	useModalStore.setState({ modals: new Map() });
	useNotificationStore.getState().clearToasts();
	useSettingsStore.setState({
		activeThemeId: 'dracula',
		checkForUpdatesOnStartup: false,
		customThemeColors: DEFAULT_CUSTOM_THEME_COLORS,
		documentGraphLayoutType: 'mindmap',
		enableBetaUpdates: false,
		encoreFeatures: { ...DEFAULT_ENCORE_FEATURES, directorNotes: true },
		settingsLoaded: true,
		suppressWindowsWarning: true,
		useNativeTitleBar: false,
	});
	useTabStore.setState({
		fileGistUrls: {},
		tabGistContent: null,
	});
}

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'claude-session-1',
		name: 'Planning',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1,
		state: 'busy',
		saveToHistory: true,
		...overrides,
	};
}

function createFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-1',
		path: '/test/project/docs/plan.md',
		name: 'plan',
		extension: '.md',
		content: '# Plan',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: '# Plan',
		createdAt: 1,
		lastModified: 1,
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab(overrides.aiTabs?.[0]);

	return {
		id: 'session-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'busy',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		createdAt: 1,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 12345,
		terminalPid: 12346,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
		unifiedClosedTabHistory: [],
		busySource: 'ai',
		...overrides,
	} as Session;
}

function renderApp() {
	return render(
		<LayerStackProvider>
			<WizardProvider>
				<MaestroConsole />
			</WizardProvider>
		</LayerStackProvider>
	);
}

describe('MaestroConsole integration', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockAppModalsState.latestProps = null;
		mockDeleteAgentConfirmState.latestProps = null;
		mockKeyboardHandlerState.latestRef = null;
		mockMainPanelState.focusFilePreviewCalls = 0;
		mockMainPanelState.latestProps = null;
		mockRightPanelState.latestProps = null;
		mockRightPanelState.refreshHistoryPanelCalls = 0;
		mockSessionNavigationState.latestDeps = null;
		mockPropsHookState.latestRightPanelProps = null;
		for (const key of Object.keys(mockLazyState) as Array<keyof typeof mockLazyState>) {
			mockLazyState[key] = null;
		}
		configureMaestroBridge();
		resetRendererStores();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		window.__hideSplash = vi.fn();
	});

	afterEach(() => {
		cleanup();
		consoleLog.mockRestore();
	});

	it('renders the empty app shell and routes menu actions into app-level modals', async () => {
		const maestro = configureMaestroBridge();

		renderApp();

		expect(await screen.findByRole('heading', { name: 'MAESTRO' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Create your first agent/i })).toBeInTheDocument();
		await waitFor(() => expect(window.__hideSplash).toHaveBeenCalled());
		expect(maestro.stats.getInitializationResult).toHaveBeenCalled();
		expect(mockAppModalsState.latestProps?.existingSessions).toEqual([]);

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('Settings'));
		await waitFor(() => expect(screen.getByTestId('settings-modal')).toBeInTheDocument());
		expect(mockLazyState.settingsProps?.isOpen).toBe(true);

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('Keyboard Shortcuts'));
		await waitFor(() => expect(useModalStore.getState().isOpen('shortcutsHelp')).toBe(true));

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('About Maestro'));
		await waitFor(() => expect(useModalStore.getState().isOpen('about')).toBe(true));

		act(() => {
			mockAppModalsState.latestProps?.onSaveBatchPrompt('ignored without an active agent');
			mockAppModalsState.latestProps?.onTabSelect('missing-tab');
			mockAppModalsState.latestProps?.onFileTabSelect('missing-file-tab');
		});
		expect(useSessionStore.getState().sessions).toEqual([]);

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(screen.getByText('Check for Updates'));
		await waitFor(() => expect(useModalStore.getState().isOpen('updateCheck')).toBe(true));
	});

	it('renders an active session workspace and propagates AppModals utility callbacks', async () => {
		const session = createSession({ groupId: 'group-1' });
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			groups: [{ id: 'group-1', name: 'Core Team', emoji: 'G' }],
			sessions: [session],
		});

		renderApp();

		expect(await screen.findByText('G Core Team | Agent One | Planning')).toBeInTheDocument();
		expect(screen.getByTestId('main-panel')).toBeInTheDocument();
		expect(screen.getByTestId('right-panel')).toBeInTheDocument();
		act(() => {
			useModalStore.getState().openModal('newInstance', { duplicatingSessionId: null });
		});
		await waitFor(() => expect(mockAppModalsState.latestProps).not.toBeNull());
		expect(mockAppModalsState.latestProps?.autoRunCompletedTaskCount).toBe(4);

		act(() => {
			mockAppModalsState.latestProps?.onSaveBatchPrompt('Review every changed file');
		});
		expect(useSessionStore.getState().sessions[0].batchRunnerPrompt).toBe(
			'Review every changed file'
		);

		act(() => {
			mockAppModalsState.latestProps?.setPlaygroundOpen(true);
		});
		expect(await screen.findByTestId('playground-panel')).toBeInTheDocument();
		act(() => {
			mockLazyState.playgroundProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('playground-panel')).not.toBeInTheDocument());

		act(() => {
			mockAppModalsState.latestProps?.onOpenSymphony();
		});
		expect(await screen.findByTestId('symphony-modal')).toBeInTheDocument();
		expect(mockLazyState.symphonyProps?.sessions).toHaveLength(1);
		act(() => {
			mockLazyState.symphonyProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('symphony-modal')).not.toBeInTheDocument());
		act(() => {
			mockAppModalsState.latestProps?.onOpenSymphony();
		});
		expect(await screen.findByTestId('symphony-modal')).toBeInTheDocument();
		act(() => {
			mockLazyState.symphonyProps?.onSelectSession(session.id);
		});
		await waitFor(() => expect(screen.queryByTestId('symphony-modal')).not.toBeInTheDocument());
	});

	it('mounts active group chat panels and switches to the log viewer through modal props', async () => {
		const session = createSession({ id: 'session-1', name: 'Planner' });
		const maestro = configureMaestroBridge();
		const chat = {
			id: 'chat-1',
			name: 'Planning Chat',
			createdAt: 1,
			moderatorAgentId: 'claude-code',
			moderatorSessionId: 'moderator-session',
			participants: [
				{
					name: 'Planner',
					agentId: 'claude-code',
					sessionId: session.id,
					addedAt: 1,
					totalCost: 1.25,
				},
			],
			logPath: '/tmp/chat.log',
			imagesDir: '/tmp/images',
		};
		maestro.sessions.getAll.mockResolvedValue([session]);
		maestro.groupChat.list.mockResolvedValue([chat]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		useGroupChatStore.setState({
			activeGroupChatId: chat.id,
			groupChats: [chat],
			groupChatExecutionQueue: [
				{
					id: 'group-queue-1',
					timestamp: 1,
					tabId: chat.id,
					type: 'message',
					text: 'queued group prompt',
				},
				{
					id: 'other-chat-queue',
					timestamp: 2,
					tabId: 'other-chat',
					type: 'message',
					text: 'other prompt',
				},
			],
			groupChatMessages: [
				{ timestamp: '2026-01-01T00:00:00.000Z', from: 'Planner', content: 'Start' },
			],
			groupChatState: 'idle',
			groupChatRightTab: 'history',
			moderatorUsage: { totalCost: 0.5 } as any,
		});

		renderApp();

		expect(await screen.findByText('Maestro Group Chat: Planning Chat')).toBeInTheDocument();
		expect(screen.getByTestId('group-chat-panel')).toHaveTextContent('Planning Chat');
		expect(screen.getByTestId('group-chat-right-panel')).toHaveTextContent('history');
		expect(mockLazyState.groupChatPanelProps?.messages).toHaveLength(1);
		expect(mockLazyState.groupChatPanelProps?.totalCost).toBe(1.75);
		expect(mockLazyState.groupChatPanelProps?.costIncomplete).toBe(false);
		expect(mockLazyState.groupChatRightPanelProps?.participantSessionPaths.get(session.id)).toBe(
			'/test/project'
		);

		act(() => {
			mockLazyState.groupChatPanelProps?.onRename();
			mockLazyState.groupChatPanelProps?.onOpenPromptComposer();
			mockLazyState.groupChatPanelProps?.onRemoveQueuedItem('group-queue-1');
			mockLazyState.groupChatPanelProps?.onToggleRightPanel();
			mockLazyState.groupChatRightPanelProps?.onToggle();
			mockLazyState.groupChatPanelProps?.onShowInfo();
			mockLazyState.groupChatPanelProps?.onToggleMarkdownEditMode();
		});
		expect(useUIStore.getState().rightPanelOpen).toBe(false);
		expect(useModalStore.getState().isOpen('groupChatInfo')).toBe(true);
		expect(useModalStore.getState().isOpen('promptComposer')).toBe(true);

		vi.useFakeTimers();
		try {
			act(() => {
				mockLazyState.groupChatPanelProps?.showFlashNotification('Group chat copied');
			});
			expect(useCenterFlashStore.getState().active).toMatchObject({
				message: 'Group chat copied',
				color: 'theme',
			});
			act(() => {
				vi.advanceTimersByTime(2000);
			});
			expect(useCenterFlashStore.getState().active).toBeNull();
		} finally {
			vi.useRealTimers();
		}

		act(() => {
			mockAppModalsState.latestProps?.setLogViewerOpen(true);
		});
		expect(await screen.findByTestId('log-viewer')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-panel')).not.toBeInTheDocument();
	});

	it('mounts file-scoped lazy workflows for marketplace, gist publishing, and document graph', async () => {
		const fileTab = createFileTab();
		const session = createSession({
			autoRunFolderPath: '/test/project/docs',
			activeFileTabId: fileTab.id,
			filePreviewTabs: [fileTab],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'file', id: fileTab.id },
			],
		});
		configureMaestroBridge().sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });
		useFileExplorerStore.setState({
			graphFocusFilePath: 'docs/plan.md',
			isGraphViewOpen: true,
			lastGraphFocusFilePath: 'docs/plan.md',
		});

		renderApp();

		await waitFor(() => expect(mockAppModalsState.latestProps?.isFilePreviewOpen).toBe(true));
		expect(await screen.findByTestId('document-graph-view')).toHaveTextContent('docs/plan.md');
		expect(mockLazyState.documentGraphProps?.rootPath).toBe('/test/project');

		act(() => {
			mockAppModalsState.latestProps?.onOpenMarketplace();
		});
		expect(await screen.findByTestId('marketplace-modal')).toBeInTheDocument();
		expect(mockLazyState.marketplaceProps?.autoRunFolderPath).toBe('/test/project/docs');

		act(() => {
			mockAppModalsState.latestProps?.onPublishGist();
		});
		expect(await screen.findByTestId('gist-publish-modal')).toBeInTheDocument();
		expect(mockLazyState.gistProps?.filename).toBe('plan.md');

		act(() => {
			mockLazyState.gistProps?.onSuccess('https://gist.github.com/example', false);
		});
		expect(useTabStore.getState().fileGistUrls[fileTab.path]).toMatchObject({
			gistUrl: 'https://gist.github.com/example',
			isPublic: false,
		});
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Gist Published');
		act(() => {
			mockLazyState.gistProps?.onClose();
		});
		expect(useTabStore.getState().tabGistContent).toBeNull();

		await act(async () => {
			await mockLazyState.marketplaceProps?.onImportComplete('Starter Kit');
		});
		expect(useNotificationStore.getState().toasts.at(-1)?.message).toContain('Starter Kit');
		act(() => {
			mockLazyState.marketplaceProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('marketplace-modal')).not.toBeInTheDocument());

		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('Document body');
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				modifiedAt: '2026-01-02T00:00:00.000Z',
			} as any);
			await mockLazyState.documentGraphProps?.onDocumentOpen('docs/next.md');
		});
		expect(useSessionStore.getState().sessions[0].filePreviewTabs.at(-1)).toMatchObject({
			path: '/test/project/docs/next.md',
			name: 'next',
			content: 'Document body',
		});
		act(() => {
			mockLazyState.documentGraphProps?.onLayoutTypeChange('radial');
			mockLazyState.documentGraphProps?.onExternalLinkOpen('https://example.com/spec');
			mockLazyState.documentGraphProps?.onClose();
		});
		expect(useSessionStore.getState().sessions[0].documentGraphLayout).toBe('radial');
		expect(useSessionStore.getState().sessions[0].browserTabs?.at(-1)).toMatchObject({
			url: 'https://example.com/spec',
		});
		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('No stat body');
			vi.mocked(window.maestro.fs.stat).mockRejectedValueOnce(new Error('stat unavailable'));
			await mockLazyState.documentGraphProps?.onDocumentOpen('docs/no-stat.md');
		});
		expect(useSessionStore.getState().sessions[0].filePreviewTabs.at(-1)).toMatchObject({
			path: '/test/project/docs/no-stat.md',
			content: 'No stat body',
		});
		const tabCountBeforeFailedOpen = useSessionStore.getState().sessions[0].filePreviewTabs.length;
		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(new Error('read failed'));
			await mockLazyState.documentGraphProps?.onDocumentOpen('docs/broken.md');
		});
		expect(useSessionStore.getState().sessions[0].filePreviewTabs).toHaveLength(
			tabCountBeforeFailedOpen
		);
		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
	});

	it('routes utility callbacks through App-owned glue state', async () => {
		const fileTab = createFileTab();
		const session = createSession({
			aiTabs: [
				createTab({ id: 'tab-1', name: 'Planning' }),
				createTab({ id: 'tab-2', name: 'Review' }),
			],
			filePreviewTabs: [fileTab],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'ai', id: 'tab-2' },
				{ type: 'file', id: fileTab.id },
			],
		});
		configureMaestroBridge().sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });

		renderApp();

		await waitFor(() => expect(mockAppModalsState.latestProps).not.toBeNull());
		expect((window as any).__maestroDebug?.openSettings).toEqual(expect.any(Function));

		act(() => {
			(window as any).__maestroDebug.openSettings();
			(window as any).__maestroDebug.openDebugWizard();
			(window as any).__maestroDebug.openCommandK();
			mockAppModalsState.latestProps?.onNavigateToSession(session.id, 'tab-2');
			mockAppModalsState.latestProps?.onTabSelect('tab-1');
			mockAppModalsState.latestProps?.onFileTabSelect(fileTab.id);
			mockAppModalsState.latestProps?.onCloseUsageDashboard();
			mockAppModalsState.latestProps?.onOpenDirectorNotes?.();
		});

		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-1');
		expect(useSessionStore.getState().sessions[0].activeFileTabId).toBe(fileTab.id);
		expect(await screen.findByTestId('debug-wizard-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('director-notes-modal')).toBeInTheDocument();
		act(() => {
			mockLazyState.debugWizardProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('debug-wizard-modal')).not.toBeInTheDocument());
		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('Director note');
			await mockLazyState.directorNotesProps?.onFileClick('docs/director.md');
		});
		expect(useSessionStore.getState().sessions[0].filePreviewTabs.at(-1)).toMatchObject({
			path: '/test/project/docs/director.md',
			content: 'Director note',
		});
		act(() => {
			mockLazyState.directorNotesProps?.onClose();
		});
		await waitFor(() =>
			expect(screen.queryByTestId('director-notes-modal')).not.toBeInTheDocument()
		);
		await waitFor(() => expect(mockLazyState.settingsProps).not.toBeNull());
		act(() => {
			mockLazyState.settingsProps?.onThemeImportError('Theme import failed');
			mockLazyState.settingsProps?.onThemeImportSuccess('Theme imported');
		});
		expect(useCenterFlashStore.getState().active).toMatchObject({
			message: 'Theme imported',
			color: 'yellow',
		});
	});

	it('bridges session refs, keyboard getters, and debug toast callbacks through stores', async () => {
		const session = createSession({
			busySource: undefined,
			contextUsage: 95,
			state: 'idle',
		});
		configureMaestroBridge().sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			cyclePosition: 4,
			sessions: [session],
		});
		const debugAssignments: Array<Record<string, any>> = [];
		Object.defineProperty(window, '__maestroDebug', {
			configurable: true,
			get: () => debugAssignments.at(-1),
			set: (value) => {
				debugAssignments.push(value);
			},
		});

		renderApp();

		await screen.findByTestId('main-panel');
		await waitFor(() =>
			expect(mockSessionNavigationState.latestDeps?.cyclePositionRef).toBeTruthy()
		);
		await waitFor(() => expect(mockKeyboardHandlerState.latestRef?.current).toBeTruthy());

		const cyclePositionRef = mockSessionNavigationState.latestDeps?.cyclePositionRef;
		expect(cyclePositionRef.current).toBe(useSessionStore.getState().cyclePosition);

		act(() => {
			useSessionStore.getState().setCyclePosition(2);
		});
		expect(cyclePositionRef.current).toBe(2);

		act(() => {
			cyclePositionRef.current = -1;
		});
		expect(useSessionStore.getState().cyclePosition).toBe(-1);
		expect(Reflect.set(cyclePositionRef, 'other', 7)).toBe(false);
		expect(cyclePositionRef.other).toBeUndefined();

		expect(mockKeyboardHandlerState.latestRef?.current?.canSummarizeActiveTab).toBe(true);
		act(() => {
			useSessionStore.setState({
				sessions: [{ ...useSessionStore.getState().sessions[0], activeTabId: undefined as any }],
			});
		});
		await waitFor(() =>
			expect(mockKeyboardHandlerState.latestRef?.current?.canSummarizeActiveTab).toBe(false)
		);

		await waitFor(() =>
			expect(debugAssignments.some((value) => typeof value?.testToast === 'function')).toBe(true)
		);
		const debugToast = debugAssignments.find((value) => typeof value?.testToast === 'function');
		act(() => {
			debugToast?.addToast('info', 'Debug toast', 'Works');
			debugToast?.testToast();
		});
		expect(useNotificationStore.getState().toasts.map((toast) => toast.title)).toEqual(
			expect.arrayContaining(['Debug toast', 'Test Notification'])
		);
	});

	it('guards App-owned callbacks across mixed active-session state', async () => {
		const agentError = {
			agentId: 'claude-code',
			message: 'Agent failed',
			recoverable: true,
			timestamp: Date.now(),
			type: 'agent_crashed' as const,
		};
		const fileTab = createFileTab();
		const activeSession = createSession({
			activeFileTabId: fileTab.id,
			agentError,
			agentErrorTabId: 'tab-1',
			aiTabs: [createTab({ agentError, state: 'idle' })],
			busySource: undefined,
			executionQueue: [
				{
					id: 'queue-1',
					tabId: 'tab-1',
					text: 'queued prompt',
					timestamp: 1,
					type: 'message',
				},
			],
			filePreviewTabs: [fileTab],
			state: 'idle',
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'file', id: fileTab.id },
			],
		});
		const otherSession = createSession({
			executionQueue: [
				{
					id: 'other-queue',
					tabId: 'tab-1',
					text: 'other queued prompt',
					timestamp: 2,
					type: 'message',
				},
			],
			id: 'session-2',
			name: 'Other Agent',
		});
		const maestro = configureMaestroBridge();
		maestro.agentError.clearError = vi.fn().mockResolvedValue(undefined);
		maestro.agentSessions = {
			...(maestro.agentSessions ?? {}),
			read: vi.fn().mockResolvedValue({ messages: [] }),
		};
		maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({});
		maestro.sessions.getAll.mockResolvedValue([activeSession, otherSession]);
		useSessionStore.setState({
			activeSessionId: activeSession.id,
			sessions: [activeSession, otherSession],
		});

		renderApp();

		await screen.findByTestId('main-panel');
		await screen.findByTestId('right-panel');
		await waitFor(() =>
			expect(mockMainPanelState.latestProps?.activeFileTab?.path).toBe(fileTab.path)
		);
		const clearAgentError = mockMainPanelState.latestProps?.onClearAgentError;
		expect(clearAgentError).toEqual(expect.any(Function));

		act(() => {
			mockMainPanelState.latestProps?.onOpenInGraph();
		});
		expect(useFileExplorerStore.getState().graphFocusFilePath).toBe('docs/plan.md');

		act(() => {
			mockMainPanelState.latestProps?.onRemoveQueuedItem('queue-1');
			mockRightPanelState.latestProps?.setActiveRightTab('autorun');
			mockLazyState.toastProps?.onSessionClick(activeSession.id, 'tab-1');
		});
		const sessionsAfterQueueUpdate = useSessionStore.getState().sessions;
		expect(sessionsAfterQueueUpdate[0].executionQueue).toEqual([]);
		expect(sessionsAfterQueueUpdate[1].executionQueue).toHaveLength(1);
		expect(useUIStore.getState().activeRightTab).toBe('autorun');

		act(() => {
			clearAgentError?.();
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentError).toBeUndefined();

		act(() => {
			useSessionStore.setState({
				sessions: [
					{
						...useSessionStore.getState().sessions[0],
						aiTabs: [createTab({ state: 'idle' })],
					},
					useSessionStore.getState().sessions[1],
				],
			});
			clearAgentError?.();
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentError).toBeUndefined();

		act(() => {
			useSessionStore.setState({ activeSessionId: 'missing-session' });
			clearAgentError?.();
		});
		expect(useSessionStore.getState().activeSessionId).toBe('missing-session');

		vi.useFakeTimers();
		try {
			act(() => {
				mockAppModalsState.latestProps?.onNamedSessionSelect(
					'closed-agent-session',
					'/test/project',
					'Closed Agent',
					true
				);
			});
			expect(useUIStore.getState().activeFocus).toBe('main');
			act(() => {
				vi.advanceTimersByTime(50);
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('auto-sends transferred context when the activated target remains active', async () => {
		const autoSendSession = createSession({
			aiTabs: [
				createTab({
					autoSendOnActivate: true,
					inputValue: 'Transferred context',
					pendingMergedContext: 'Merged context',
					state: 'idle',
				}),
				createTab({
					agentSessionId: 'claude-session-2',
					id: 'tab-2',
					inputValue: 'Follow-up prompt',
					name: 'Follow-up',
					state: 'idle',
				}),
			],
			busySource: undefined,
			state: 'idle',
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'ai', id: 'tab-2' },
			],
		});
		const otherSession = createSession({
			id: 'session-2',
			name: 'Other Agent',
			state: 'idle',
		});
		const maestro = configureMaestroBridge();
		maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 12345 });
		maestro.web = { ...(maestro.web ?? {}), broadcastUserInput: vi.fn() };
		maestro.sessions.getAll.mockResolvedValue([autoSendSession, otherSession]);
		useSessionStore.setState({
			activeSessionId: autoSendSession.id,
			sessions: [autoSendSession, otherSession],
		});

		renderApp();

		await waitFor(() =>
			expect(useSessionStore.getState().sessions[0].aiTabs[0].autoSendOnActivate).toBe(false)
		);
		await waitFor(() => expect(maestro.process.spawn).toHaveBeenCalled());

		const spawnOptions = maestro.process.spawn.mock.calls[0][0];
		expect(spawnOptions).toEqual(
			expect.objectContaining({
				agentSessionId: 'claude-session-1',
				sessionId: `${autoSendSession.id}-ai-tab-1`,
			})
		);
		expect(spawnOptions.prompt).toContain('Merged context');
		expect(spawnOptions.prompt).toContain('Transferred context');
		expect(maestro.web.broadcastUserInput).toHaveBeenCalledWith(
			autoSendSession.id,
			'Transferred context',
			'ai'
		);
	});

	it('cancels delayed auto-send when the target disappears or loses focus', async () => {
		const originalSetTimeout = global.setTimeout;
		const delayedAutoSendCallbacks: Array<() => void> = [];
		const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
			handler: TimerHandler,
			timeout?: number,
			...args: any[]
		) => {
			const handlerSource = typeof handler === 'function' ? String(handler) : '';
			if (
				timeout === 100 &&
				typeof handler === 'function' &&
				handlerSource.includes('currentSessions') &&
				handlerSource.includes('processInput')
			) {
				delayedAutoSendCallbacks.push(() => handler(...args));
				return 0 as any;
			}
			return originalSetTimeout(handler, timeout, ...args);
		}) as typeof setTimeout);
		const autoSendSession = createSession({
			aiTabs: [
				createTab({
					autoSendOnActivate: true,
					inputValue: 'Transferred context',
					pendingMergedContext: 'Merged context',
					state: 'idle',
				}),
			],
			busySource: undefined,
			state: 'idle',
		});
		const otherSession = createSession({ id: 'session-2', name: 'Other Agent' });
		const maestro = configureMaestroBridge();
		maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 12345 });
		maestro.sessions.getAll.mockResolvedValue([autoSendSession, otherSession]);
		useSessionStore.setState({
			activeSessionId: autoSendSession.id,
			sessions: [autoSendSession, otherSession],
		});

		try {
			renderApp();

			await waitFor(() =>
				expect(useSessionStore.getState().sessions[0].aiTabs[0].autoSendOnActivate).toBe(false)
			);
			expect(delayedAutoSendCallbacks).toHaveLength(1);

			act(() => {
				useSessionStore.setState({ activeSessionId: '', sessions: [] });
				delayedAutoSendCallbacks[0]();
			});
			act(() => {
				useSessionStore.setState({
					activeSessionId: otherSession.id,
					sessions: [autoSendSession, otherSession],
				});
				delayedAutoSendCallbacks[0]();
			});

			expect(maestro.process.spawn).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it('routes delete agent confirmation callbacks into lifecycle cleanup', async () => {
		const session = createSession({ cwd: '/test/project', worktreeParentPath: '/test' });
		const maestro = configureMaestroBridge();
		maestro.process.kill = vi.fn().mockResolvedValue(undefined);
		maestro.playbooks = { deleteAll: vi.fn().mockResolvedValue(undefined) };
		maestro.shell = {
			...(maestro.shell ?? {}),
			openExternal: maestro.shell?.openExternal ?? vi.fn(),
			trashItem: vi.fn().mockResolvedValue(undefined),
		};
		maestro.stats.recordSessionClosed = vi.fn();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		useModalStore.getState().openModal('deleteAgent', { session });

		renderApp();

		expect(await screen.findByTestId('delete-agent-confirm-modal')).toBeInTheDocument();
		await act(async () => {
			await mockDeleteAgentConfirmState.latestProps?.onConfirm();
		});
		expect(maestro.stats.recordSessionClosed).toHaveBeenCalledWith(session.id, expect.any(Number));
		expect(maestro.process.kill).toHaveBeenCalledWith(`${session.id}-ai`);
		expect(maestro.process.kill).toHaveBeenCalledWith(`${session.id}-terminal`);
		expect(maestro.playbooks.deleteAll).toHaveBeenCalledWith(session.id);
		expect(useSessionStore.getState().sessions).toEqual([]);

		const eraseSession = createSession({
			cwd: '/test/project/erase',
			id: 'session-erase',
			name: 'Erase Agent',
			worktreeParentPath: '/test',
		});
		act(() => {
			useSessionStore.setState({ activeSessionId: eraseSession.id, sessions: [eraseSession] });
			useModalStore.getState().openModal('deleteAgent', { session: eraseSession });
		});
		await waitFor(() =>
			expect(mockDeleteAgentConfirmState.latestProps?.agentName).toBe('Erase Agent')
		);
		await act(async () => {
			await mockDeleteAgentConfirmState.latestProps?.onConfirmAndErase();
		});
		expect(maestro.shell.trashItem).toHaveBeenCalledWith('/test/project/erase');
	});

	it('handles wizard resume and App-owned modal callbacks', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const maestro = configureMaestroBridge();
		const customColors = {
			...DEFAULT_CUSTOM_THEME_COLORS,
			bgMain: '#101820',
			accent: '#2f80ed',
		};
		const fileTab = createFileTab({ id: 'toast-file' });
		const session = createSession({
			aiTabs: [
				createTab({
					id: 'tab-1',
					agentError: { message: 'Boom', recoverable: true } as any,
					state: 'idle',
				}),
				createTab({ id: 'tab-2', name: 'Review', state: 'idle' }),
			],
			activeTabId: 'tab-1',
			activeFileTabId: fileTab.id,
			agentCommands: [{ command: '/agent-check', description: 'Agent check' }] as any,
			executionQueue: [
				{
					id: 'queue-1',
					timestamp: 1,
					tabId: 'tab-1',
					type: 'message',
					text: 'queued prompt',
				},
			],
			filePreviewTabs: [fileTab],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'ai', id: 'tab-2' },
				{ type: 'file', id: fileTab.id },
			],
		});
		useSettingsStore.setState({ activeThemeId: 'custom', customThemeColors: customColors });
		maestro.speckit.getPrompts.mockResolvedValueOnce({
			success: true,
			commands: [
				{
					id: 'specify',
					command: '/specify',
					description: 'Create a specification',
					prompt: 'Draft a spec',
				},
			],
		});
		maestro.openspec.getPrompts.mockResolvedValueOnce({
			success: true,
			commands: [
				{
					id: 'proposal',
					command: '/openspec-proposal',
					description: 'Create an OpenSpec proposal',
					prompt: 'Draft a proposal',
				},
			],
		});
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });

		renderApp();

		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.theme.colors.bgMain).toBe('#101820')
		);
		expect(mockMainPanelState.latestProps?.slashCommands).toEqual(
			expect.arrayContaining([expect.objectContaining({ command: '/agent-check' })])
		);
		await waitFor(() =>
			expect(mockMainPanelState.latestProps?.slashCommands).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						command: '/specify',
						aiOnly: true,
						prompt: 'Draft a spec',
					}),
					expect.objectContaining({
						command: '/openspec-proposal',
						aiOnly: true,
						prompt: 'Draft a proposal',
					}),
				])
			)
		);
		expect(
			mockMainPanelState.latestProps?.getContextColor(92, mockAppModalsState.latestProps?.theme)
		).toEqual(expect.any(String));

		vi.mocked(window.maestro.settings.get).mockResolvedValueOnce({
			currentStep: 'conversation',
			selectedAgentId: 'claude-code',
		});
		await act(async () => {
			await mockAppModalsState.latestProps?.openWizard();
		});
		expect(await screen.findByTestId('wizard-resume-modal')).toHaveTextContent('conversation');
		act(() => {
			mockLazyState.wizardResumeProps?.onClose();
		});
		await waitFor(() =>
			expect(screen.queryByTestId('wizard-resume-modal')).not.toBeInTheDocument()
		);

		const settingsError = new Error('settings offline');
		await waitFor(() =>
			expect((window as any).__maestroDebug?.openWizard).toEqual(expect.any(Function))
		);
		vi.mocked(window.maestro.settings.get).mockRejectedValueOnce(settingsError);
		await act(async () => {
			await (window as any).__maestroDebug.openWizard();
		});
		expect(consoleError).toHaveBeenCalledWith(
			'[App] Failed to check wizard resume state:',
			settingsError
		);
		expect(await screen.findByTestId('maestro-wizard')).toBeInTheDocument();

		act(() => {
			mockMainPanelState.latestProps?.onClearAgentError?.();
			mockMainPanelState.latestProps?.onRemoveQueuedItem('queue-1');
			mockRightPanelState.latestProps?.setActiveRightTab('autorun');
			mockRightPanelState.latestProps?.onAutoRefreshChange(45);
			mockLazyState.toastProps?.onSessionClick(session.id, 'missing-tab');
		});
		expect(useSessionStore.getState().sessions[0].executionQueue).toEqual([]);
		expect(useUIStore.getState().activeRightTab).toBe('autorun');
		expect(useSessionStore.getState().sessions[0].fileTreeAutoRefreshInterval).toBe(45);
		expect(useSessionStore.getState().sessions[0].activeFileTabId).toBeNull();
		expect(useSessionStore.getState().sessions[0].inputMode).toBe('ai');
		act(() => {
			mockLazyState.toastProps?.onSessionClick(session.id, 'tab-2');
		});
		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-2');

		act(() => {
			mockAppModalsState.latestProps?.onCloseCreateGroupModal();
		});

		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('Search result');
			await mockAppModalsState.latestProps?.onFileSearchSelect({
				name: 'result.md',
				fullPath: 'docs/result.md',
				isFolder: false,
			});
		});
		expect(useSessionStore.getState().sessions[0].filePreviewTabs.at(-1)).toMatchObject({
			path: '/test/project/docs/result.md',
			content: 'Search result',
		});

		await act(async () => {
			await mockAppModalsState.latestProps?.onPRCreated({
				title: 'Ship integration coverage',
				url: 'https://github.com/runmaestro/maestro/pull/123',
				sourceBranch: 'coverage-app',
				targetBranch: 'main',
				description: 'App coverage expansion',
			});
		});
		expect(maestro.history.add).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Created PR: Ship integration coverage',
				sessionId: session.id,
			})
		);
		expect(mockRightPanelState.refreshHistoryPanelCalls).toBe(1);

		act(() => {
			mockAppModalsState.latestProps?.setDebugPackageModalOpen(true);
			useModalStore.getState().openModal('windowsWarning');
		});
		expect(await screen.findByTestId('debug-package-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('windows-warning-modal')).toBeInTheDocument();
		act(() => {
			mockLazyState.windowsWarningProps?.onOpenDebugPackage();
			mockLazyState.windowsWarningProps?.onClose();
		});
		await waitFor(() =>
			expect(screen.queryByTestId('windows-warning-modal')).not.toBeInTheDocument()
		);
		act(() => {
			mockLazyState.debugPackageProps?.onClose();
		});
		await waitFor(() =>
			expect(screen.queryByTestId('debug-package-modal')).not.toBeInTheDocument()
		);

		act(() => {
			mockAppModalsState.latestProps?.startTour();
		});
		expect(await screen.findByTestId('tour-overlay')).toBeInTheDocument();
		act(() => {
			mockLazyState.tourProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('tour-overlay')).not.toBeInTheDocument());

		act(() => {
			mockAppModalsState.latestProps?.setGitDiffPreview('diff --git a b');
			mockAppModalsState.latestProps?.setGitLogOpen(true);
			mockAppModalsState.latestProps?.onCloseGitDiff();
			mockAppModalsState.latestProps?.onCloseGitLog();
			mockAppModalsState.latestProps?.onCloseAutoRunSetup();
			mockAppModalsState.latestProps?.onCloseBatchRunner();
			mockAppModalsState.latestProps?.onCloseQueueBrowser();
		});
		expect(useModalStore.getState().isOpen('gitDiff')).toBe(false);
		expect(useModalStore.getState().isOpen('gitLog')).toBe(false);
		expect(useModalStore.getState().isOpen('autoRunSetup')).toBe(false);

		consoleError.mockRestore();
	});

	it('starts the wizard when saved resume state is not resumable', async () => {
		const maestro = configureMaestroBridge();
		maestro.settings.get.mockResolvedValueOnce({
			currentStep: 'agent-selection',
			selectedAgentId: 'claude-code',
		});

		renderApp();

		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.openWizard).toEqual(expect.any(Function))
		);
		await act(async () => {
			await mockAppModalsState.latestProps?.openWizard();
		});

		expect(await screen.findByTestId('maestro-wizard')).toBeInTheDocument();
		expect(screen.queryByTestId('wizard-resume-modal')).not.toBeInTheDocument();
	});

	it('keeps non-target sessions untouched across App-owned utility callbacks', async () => {
		const fileTab = createFileTab();
		const activeSession = createSession({
			aiTabs: [
				createTab({ id: 'tab-1', name: 'Planning' }),
				createTab({ id: 'tab-2', name: 'Review' }),
			],
			filePreviewTabs: [fileTab],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'ai', id: 'tab-2' },
				{ type: 'file', id: fileTab.id },
			],
		});
		const otherSession = createSession({
			activeTabId: 'other-tab',
			fileTreeAutoRefreshInterval: 5,
			id: 'session-2',
			name: 'Other Agent',
			aiTabs: [createTab({ id: 'other-tab', name: 'Other' })],
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([activeSession, otherSession]);
		useSessionStore.setState({
			activeSessionId: activeSession.id,
			sessions: [activeSession, otherSession],
		});

		renderApp();

		await screen.findByTestId('right-panel');
		act(() => {
			mockAppModalsState.latestProps?.onSaveBatchPrompt('Keep this scoped');
			mockAppModalsState.latestProps?.onTabSelect('tab-2');
			mockAppModalsState.latestProps?.onFileTabSelect(fileTab.id);
			mockRightPanelState.latestProps?.onAutoRefreshChange(30);
		});
		expect(useSessionStore.getState().sessions[0]).toMatchObject({
			activeTabId: 'tab-2',
			activeFileTabId: fileTab.id,
			batchRunnerPrompt: 'Keep this scoped',
			fileTreeAutoRefreshInterval: 30,
		});
		expect(useSessionStore.getState().sessions[1].activeTabId).toBe('other-tab');
		expect(useSessionStore.getState().sessions[1].batchRunnerPrompt).toBeUndefined();
		expect(useSessionStore.getState().sessions[1].fileTreeAutoRefreshInterval).toBe(5);

		act(() => {
			mockAppModalsState.latestProps?.onNavigateToSession(otherSession.id);
		});
		expect(useSessionStore.getState().activeSessionId).toBe(otherSession.id);
		expect(useSessionStore.getState().sessions[1].activeTabId).toBe('other-tab');

		act(() => {
			mockAppModalsState.latestProps?.onNavigateToSession(activeSession.id, 'tab-1');
		});
		expect(useSessionStore.getState().activeSessionId).toBe(activeSession.id);
		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-1');

		vi.mocked(window.maestro.fs.readFile).mockClear();
		await act(async () => {
			await mockAppModalsState.latestProps?.onFileSearchSelect({
				name: 'docs',
				fullPath: 'docs',
				isFolder: true,
			});
		});
		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();

		const fallbackPrSession = {
			...useSessionStore.getState().sessions[0],
			cwd: '/fallback/project',
			projectRoot: undefined,
		} as Session;
		act(() => {
			useSessionStore.setState({
				activeSessionId: fallbackPrSession.id,
				sessions: [fallbackPrSession, useSessionStore.getState().sessions[1]],
			});
		});
		await act(async () => {
			await mockAppModalsState.latestProps?.onPRCreated({
				title: 'Fallback PR',
				url: 'https://github.com/runmaestro/maestro/pull/456',
				sourceBranch: 'fallback',
				targetBranch: 'main',
			});
		});
		expect(maestro.history.add).toHaveBeenLastCalledWith(
			expect.objectContaining({
				fullResponse: expect.not.stringContaining('Description'),
				projectPath: '/fallback/project',
			})
		);

		maestro.history.add.mockClear();
		mockAppModalsState.latestProps = null;
		act(() => {
			useSessionStore.setState({ activeSessionId: '', sessions: [] });
		});
		await waitFor(() => expect(mockAppModalsState.latestProps).not.toBeNull());
		await act(async () => {
			await mockAppModalsState.latestProps?.onPRCreated({
				title: 'No active PR',
				url: 'https://github.com/runmaestro/maestro/pull/789',
				sourceBranch: 'none',
				targetBranch: 'main',
			});
		});
		expect(maestro.history.add).not.toHaveBeenCalled();
	});

	it('renders fallback chrome, drag, and capability states', async () => {
		const noNameTab = createTab({
			agentSessionId: 'closed-session-123',
			id: 'tab-from-agent-session',
			name: '',
			state: 'idle',
		});
		const noLabelTab = createTab({
			agentSessionId: undefined as any,
			id: 'tab-without-label',
			name: '',
			state: 'idle',
		});
		const session = createSession({
			activeTabId: noNameTab.id,
			aiTabs: [noNameTab, noLabelTab],
			inputMode: 'ai',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSettingsStore.setState({
			encoreFeatures: { ...DEFAULT_ENCORE_FEATURES, directorNotes: false },
		});
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });
		const { container } = renderApp();

		await screen.findByTestId('main-panel');
		expect(await screen.findByText('Agent One | CLOSED')).toBeInTheDocument();
		act(() => {
			useSettingsStore.setState({ useNativeTitleBar: true });
		});
		await waitFor(() => expect(container.firstElementChild).toHaveClass('pt-0'));
		expect(mockAppModalsState.latestProps?.onOpenDirectorNotes).toBeUndefined();
		expect(mockAppModalsState.latestProps?.setPromptComposerStagedImages).toEqual(
			expect.any(Function)
		);

		act(() => {
			useModalStore.getState().openModal('lightbox', {
				allowDelete: true,
				image: 'data:image/png;base64,abc',
				images: ['data:image/png;base64,abc'],
				source: 'staged',
			});
		});
		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.onDeleteLightboxImage).toEqual(expect.any(Function))
		);

		const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });
		const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
		expect(document.dispatchEvent(dragOverEvent)).toBe(false);
		expect(document.dispatchEvent(dropEvent)).toBe(false);
		expect(dragOverEvent.defaultPrevented).toBe(true);
		expect(dropEvent.defaultPrevented).toBe(true);

		act(() => {
			useSettingsStore.setState({ useNativeTitleBar: false });
			useSessionStore.setState({
				sessions: [{ ...session, activeTabId: noLabelTab.id }],
			});
		});
		await waitFor(() => expect(mockAppModalsState.latestProps?.isAiMode).toBe(true));
	});

	it('routes terminal cwd and right-panel callback fallback branches', async () => {
		const session = createSession({
			autoRunFolderPath: undefined,
			cwd: '/fallback/project',
			inputMode: 'terminal',
			shellCwd: '/shell/project',
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });

		renderApp();

		await screen.findByTestId('right-panel');
		mockPropsHookState.latestRightPanelProps = null;
		act(() => {
			useSessionStore.setState({
				activeSessionId: session.id,
				sessions: [{ ...session, autoRunFolderPath: undefined }],
			});
		});
		await waitFor(() =>
			expect(mockPropsHookState.latestRightPanelProps?.setActiveRightTab).toEqual(
				expect.any(Function)
			)
		);
		expect(mockAppModalsState.latestProps?.gitViewerCwd).toBe('/shell/project');

		act(() => {
			mockPropsHookState.latestRightPanelProps?.setActiveRightTab('autorun');
		});
		expect(useModalStore.getState().isOpen('autoRunSetup')).toBe(true);
		expect(useUIStore.getState().activeRightTab).toBe('autorun');

		act(() => {
			useSessionStore.setState({
				sessions: [{ ...useSessionStore.getState().sessions[0], shellCwd: undefined }],
			});
		});
		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.gitViewerCwd).toBe('/fallback/project')
		);

		mockPropsHookState.latestRightPanelProps = null;
		act(() => {
			useSessionStore.setState({ activeSessionId: '', sessions: [] });
		});
		await waitFor(() =>
			expect(mockPropsHookState.latestRightPanelProps?.onAutoRefreshChange).toEqual(
				expect.any(Function)
			)
		);
		act(() => {
			mockPropsHookState.latestRightPanelProps?.onAutoRefreshChange(90);
		});
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('publishes tab-context gists without a file preview tab', async () => {
		const session = createSession();
		configureMaestroBridge().sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });
		useTabStore.setState({
			tabGistContent: { filename: undefined, content: undefined } as any,
		});

		renderApp();

		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.onPublishGist).toEqual(expect.any(Function))
		);
		act(() => {
			mockAppModalsState.latestProps?.onPublishGist();
		});
		expect(await screen.findByTestId('gist-publish-modal')).toBeInTheDocument();
		expect(mockLazyState.gistProps).toMatchObject({
			content: '',
			existingGist: undefined,
			filename: 'conversation.md',
		});

		act(() => {
			mockLazyState.gistProps?.onSuccess('https://gist.github.com/context', true);
		});
		expect(useTabStore.getState().fileGistUrls).toEqual({});
		expect(useTabStore.getState().tabGistContent).toBeNull();
		expect(useNotificationStore.getState().toasts.at(-1)?.message).toContain('Public gist');
	});

	it('handles document graph fallbacks without opening unavailable content', async () => {
		const activeSession = createSession({
			cwd: '/fallback/project',
			filePreviewTabs: [],
			projectRoot: undefined,
		} as Partial<Session>);
		const otherSession = createSession({ id: 'session-2', name: 'Other Agent' });
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([activeSession, otherSession]);
		useSessionStore.setState({
			activeSessionId: activeSession.id,
			sessions: [activeSession, otherSession],
		});
		useFileExplorerStore.setState({
			graphFocusFilePath: 'docs/plan.md',
			isGraphViewOpen: true,
			lastGraphFocusFilePath: 'docs/plan.md',
		});

		renderApp();

		expect(await screen.findByTestId('document-graph-view')).toHaveTextContent('docs/plan.md');
		expect(mockLazyState.documentGraphProps?.rootPath).toBe('/fallback/project');
		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null as any);
			await mockLazyState.documentGraphProps?.onDocumentOpen('docs/missing.md');
		});
		expect(useSessionStore.getState().sessions[0].filePreviewTabs).toEqual([]);

		act(() => {
			mockLazyState.documentGraphProps?.onLayoutTypeChange('force');
		});
		expect(useSessionStore.getState().sessions[0].documentGraphLayout).toBe('force');
		expect(useSessionStore.getState().sessions[1].documentGraphLayout).toBeUndefined();

		mockLazyState.documentGraphProps = null;
		act(() => {
			useSessionStore.setState({ activeSessionId: '', sessions: [] });
		});
		await waitFor(() => expect(mockLazyState.documentGraphProps?.rootPath).toBe(''));
		await act(async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null as any);
			await mockLazyState.documentGraphProps?.onDocumentOpen('docs/offline.md');
		});
		act(() => {
			mockLazyState.documentGraphProps?.onLayoutTypeChange('radial');
		});
		expect(useSettingsStore.getState().documentGraphLayoutType).toBe('radial');
	});

	it('renders group chat fallback labels and missing cost data', async () => {
		const session = createSession({ id: 'session-1', name: 'Planner' });
		const chat = {
			id: 'chat-1',
			name: '',
			createdAt: 1,
			participants: [
				{
					name: 'Planner',
					agentId: 'claude-code',
					sessionId: session.id,
					addedAt: 1,
				},
			],
			logPath: '/tmp/chat.log',
			imagesDir: '/tmp/images',
		};
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		maestro.groupChat.list.mockResolvedValue([chat]);
		useSessionStore.setState({ activeSessionId: session.id, sessions: [session] });
		useGroupChatStore.setState({
			activeGroupChatId: chat.id,
			groupChats: [chat as any],
			groupChatState: 'idle',
			moderatorUsage: null,
		});

		renderApp();

		expect(await screen.findByText('Maestro Group Chat: Unknown')).toBeInTheDocument();
		expect(mockLazyState.groupChatPanelProps?.totalCost).toBe(0);
		expect(mockLazyState.groupChatPanelProps?.costIncomplete).toBe(true);
		expect(mockLazyState.groupChatRightPanelProps).toMatchObject({
			moderatorAgentId: 'claude-code',
			moderatorSessionId: '',
		});
	});
});
