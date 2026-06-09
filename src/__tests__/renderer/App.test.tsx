import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WizardProvider } from '../../renderer/components/Wizard';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import MaestroConsole from '../../renderer/App';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { DEFAULT_ENCORE_FEATURES, useSettingsStore } from '../../renderer/stores/settingsStore';
import { useTabStore } from '../../renderer/stores/tabStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../renderer/constants/themes';
import { consumeGroupChatAutoRun } from '../../renderer/utils/groupChatAutoRunRegistry';
import type { Session } from '../../renderer/types';

const mockAppModalsState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockMarketplaceState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockGistState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockSettingsState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockSymphonyState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockDirectorNotesState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockGroupChatPanelState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockGroupChatRightPanelState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockMainPanelState = vi.hoisted(() => ({
	focusFilePreviewCalls: 0,
	latestProps: null as Record<string, any> | null,
	refreshGitInfoCalls: 0,
}));

const mockKeyboardHandlerState = vi.hoisted(() => ({
	latestRef: null as { current: Record<string, any> | null } | null,
}));

const mockSessionNavigationState = vi.hoisted(() => ({
	latestDeps: null as Record<string, any> | null,
}));

const mockRightPanelPropsState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockRightPanelState = vi.hoisted(() => ({
	completedTaskCount: 7,
	latestProps: null as Record<string, any> | null,
	refreshHistoryPanelCalls: 0,
}));

const mockToastState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockLogViewerState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockDocumentGraphState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockWindowsWarningState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockPlaygroundState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockDebugWizardState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockDeleteAgentConfirmState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

const mockTourState = vi.hoisted(() => ({
	latestProps: null as Record<string, any> | null,
}));

vi.mock('../../renderer/components/AppModals', () => ({
	AppModals: (props: Record<string, any>) => {
		mockAppModalsState.latestProps = props;
		return <div data-testid="app-modals" />;
	},
}));

vi.mock('../../renderer/components/WindowsWarningModal', () => ({
	exposeWindowsWarningModalDebug: vi.fn((setShowWindowsWarning: (show: boolean) => void) => {
		(window as any).__showWindowsWarningModal = () => setShowWindowsWarning(true);
	}),
	WindowsWarningModal: (props: Record<string, any>) => {
		mockWindowsWarningState.latestProps = props;
		return props.isOpen ? <div data-testid="windows-warning-modal" /> : null;
	},
}));

vi.mock('../../renderer/components/DebugPackageModal', () => ({
	DebugPackageModal: (props: Record<string, any>) =>
		props.isOpen ? <div data-testid="debug-package-modal" /> : null,
}));

vi.mock('../../renderer/components/PlaygroundPanel', () => ({
	PlaygroundPanel: (props: Record<string, any>) => {
		mockPlaygroundState.latestProps = props;
		return <div data-testid="playground-panel" />;
	},
}));

vi.mock('../../renderer/components/DebugWizardModal', () => ({
	DebugWizardModal: (props: Record<string, any>) => {
		mockDebugWizardState.latestProps = props;
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
		mockTourState.latestProps = props;
		return props.isOpen ? <div data-testid="tour-overlay" /> : null;
	},
}));

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
			mockRightPanelPropsState.latestProps = props;
			return props;
		},
	};
});

vi.mock('../../renderer/components/RightPanel', async () => {
	const React = await vi.importActual<typeof import('react')>('react');
	const MockRightPanel = React.memo(
		React.forwardRef(function MockRightPanel(props: Record<string, any>, ref) {
			mockRightPanelState.latestProps = props;
			React.useImperativeHandle(ref, () => ({
				focusAutoRun: () => {},
				getAutoRunCompletedTaskCount: () => mockRightPanelState.completedTaskCount,
				openAutoRunResetTasksModal: () => {},
				refreshHistoryPanel: () => {
					mockRightPanelState.refreshHistoryPanelCalls += 1;
				},
				toggleAutoRunExpanded: () => {},
			}));
			return <aside data-testid="right-panel" />;
		})
	);

	return { RightPanel: MockRightPanel };
});

vi.mock('../../renderer/components/MainPanel', async () => {
	const React = await vi.importActual<typeof import('react')>('react');
	const MockMainPanel = React.memo(
		React.forwardRef(function MockMainPanel(props: Record<string, any>, ref) {
			mockMainPanelState.latestProps = props;
			React.useImperativeHandle(ref, () => ({
				focusFilePreview: () => {
					mockMainPanelState.focusFilePreviewCalls += 1;
				},
				refreshGitInfo: async () => {
					mockMainPanelState.refreshGitInfoCalls += 1;
				},
			}));
			return <main data-testid="main-panel" />;
		})
	);

	return { MainPanel: MockMainPanel };
});

vi.mock('../../renderer/components/Toast', () => ({
	ToastContainer: (props: Record<string, any>) => {
		mockToastState.latestProps = props;
		return <div data-testid="toast-container" />;
	},
}));

vi.mock('../../renderer/components/LogViewer', () => ({
	LogViewer: (props: Record<string, any>) => {
		mockLogViewerState.latestProps = props;
		return <section data-testid="log-viewer">Log Viewer</section>;
	},
}));

vi.mock('../../renderer/components/GroupChatPanel', () => ({
	GroupChatPanel: (props: Record<string, any>) => {
		mockGroupChatPanelState.latestProps = props;
		return <section data-testid="group-chat-panel">{props.groupChat.name}</section>;
	},
}));

vi.mock('../../renderer/components/GroupChatRightPanel', () => ({
	GroupChatRightPanel: (props: Record<string, any>) => {
		mockGroupChatRightPanelState.latestProps = props;
		return <aside data-testid="group-chat-right-panel">{props.activeTab}</aside>;
	},
}));

vi.mock('../../renderer/components/Settings/SettingsModal', () => ({
	SettingsModal: (props: Record<string, any>) => {
		mockSettingsState.latestProps = props;
		return props.isOpen ? <div data-testid="settings-modal">Settings Modal</div> : null;
	},
}));

vi.mock('../../renderer/components/MarketplaceModal', () => ({
	MarketplaceModal: (props: Record<string, any>) => {
		mockMarketplaceState.latestProps = props;
		return <div data-testid="marketplace-modal">Marketplace Modal</div>;
	},
}));

vi.mock('../../renderer/components/GistPublishModal', () => ({
	GistPublishModal: (props: Record<string, any>) => {
		mockGistState.latestProps = props;
		return <div data-testid="gist-publish-modal">Gist Publish Modal</div>;
	},
}));

vi.mock('../../renderer/components/SymphonyModal', () => ({
	SymphonyModal: (props: Record<string, any>) => {
		mockSymphonyState.latestProps = props;
		return <div data-testid="symphony-modal">Symphony Modal</div>;
	},
}));

vi.mock('../../renderer/components/DirectorNotes', () => ({
	DirectorNotesModal: (props: Record<string, any>) => {
		mockDirectorNotesState.latestProps = props;
		return <div data-testid="director-notes-modal">Director Notes Modal</div>;
	},
}));

vi.mock('../../renderer/components/DocumentGraph/DocumentGraphView', () => ({
	DocumentGraphView: (props: Record<string, any>) => {
		mockDocumentGraphState.latestProps = props;
		return <div data-testid="document-graph-view">{props.focusFilePath}</div>;
	},
}));

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
		removeParticipant: vi.fn().mockResolvedValue({ success: true }),
		rename: vi.fn().mockResolvedValue({ success: true }),
		reportAutoRunComplete: vi.fn().mockResolvedValue(undefined),
		resetParticipantContext: vi.fn().mockResolvedValue({ success: true }),
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
	maestro.agentError = {
		clearError: vi.fn().mockResolvedValue(undefined),
	};
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

let consoleLog: ReturnType<typeof vi.spyOn>;

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
		encoreFeatures: DEFAULT_ENCORE_FEATURES,
		settingsLoaded: true,
		suppressWindowsWarning: true,
		useNativeTitleBar: false,
	});
	useTabStore.setState({
		fileGistUrls: {},
		tabGistContent: null,
	});
}

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		activeTabId: 'tab-1',
		aiLogs: [],
		aiPid: 12345,
		aiTabs: [
			{
				agentSessionId: 'claude-session-1',
				createdAt: 1,
				id: 'tab-1',
				isUnread: false,
				logs: [],
				name: 'Planning',
				state: 'busy',
			},
		],
		cwd: '/test/project',
		executionQueue: [],
		fileExplorerExpanded: [],
		filePreviewTabs: [],
		fileTreeAutoRefreshInterval: 180,
		fileTree: [],
		id: 'session-1',
		inputMode: 'ai',
		isGitRepo: true,
		messageQueue: [],
		name: 'Agent One',
		projectRoot: '/test/project',
		shellLogs: [],
		state: 'busy',
		terminalPid: 12346,
		toolType: 'claude-code',
		busySource: 'ai',
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		...overrides,
	};
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

function getSessionById(sessionId: string) {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	expect(session).toBeDefined();
	return session as Session;
}

type GroupChatAutoRunHandler = (
	groupChatId: string,
	participantName: string,
	targetFilename?: string
) => void;

async function renderAppCapturingGroupChatAutoRun(session?: Session) {
	const maestro = configureMaestroBridge();
	let triggerAutoRun: GroupChatAutoRunHandler | undefined;
	maestro.groupChat.onAutoRunTriggered.mockImplementation((handler: GroupChatAutoRunHandler) => {
		triggerAutoRun = handler;
		return () => {};
	});

	if (session) {
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
	}

	const view = renderApp();
	await waitFor(() => expect(triggerAutoRun).toEqual(expect.any(Function)));

	return {
		maestro,
		view,
		triggerAutoRun: async (
			groupChatId: string,
			participantName: string,
			targetFilename?: string
		) => {
			await act(async () => {
				triggerAutoRun?.(groupChatId, participantName, targetFilename);
				await Promise.resolve();
				await Promise.resolve();
			});
		},
	};
}

async function expectGroupChatAutoRunFailure(trigger: () => Promise<void>, expectedReason: string) {
	window.maestro.groupChat.reportAutoRunComplete.mockClear();
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	try {
		await trigger();
		await waitFor(() =>
			expect(window.maestro.groupChat.reportAutoRunComplete).toHaveBeenCalledWith(
				'chat-1',
				'Planner',
				expect.stringContaining(expectedReason)
			)
		);
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(expectedReason));
	} finally {
		consoleWarn.mockRestore();
	}
}

describe('MaestroConsole app shell', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAppModalsState.latestProps = null;
		mockDebugWizardState.latestProps = null;
		mockDeleteAgentConfirmState.latestProps = null;
		mockDirectorNotesState.latestProps = null;
		mockGistState.latestProps = null;
		mockGroupChatPanelState.latestProps = null;
		mockGroupChatRightPanelState.latestProps = null;
		mockLogViewerState.latestProps = null;
		mockMarketplaceState.latestProps = null;
		mockMainPanelState.focusFilePreviewCalls = 0;
		mockMainPanelState.latestProps = null;
		mockMainPanelState.refreshGitInfoCalls = 0;
		mockKeyboardHandlerState.latestRef = null;
		mockSessionNavigationState.latestDeps = null;
		mockRightPanelPropsState.latestProps = null;
		mockDocumentGraphState.latestProps = null;
		mockRightPanelState.completedTaskCount = 7;
		mockRightPanelState.latestProps = null;
		mockRightPanelState.refreshHistoryPanelCalls = 0;
		mockSettingsState.latestProps = null;
		mockSymphonyState.latestProps = null;
		mockToastState.latestProps = null;
		mockTourState.latestProps = null;
		mockWindowsWarningState.latestProps = null;
		mockPlaygroundState.latestProps = null;
		configureMaestroBridge();
		resetRendererStores();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		window.__hideSplash = vi.fn();
	});

	afterEach(() => {
		consoleLog.mockRestore();
	});

	it('renders the no-session empty state and wires startup bridge subscriptions', async () => {
		const maestro = configureMaestroBridge();

		const { unmount } = renderApp();

		expect(await screen.findByRole('heading', { name: 'MAESTRO' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /New Agent/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Wizard/i })).toBeInTheDocument();

		await waitFor(() => expect(window.__hideSplash).toHaveBeenCalled());
		expect(maestro.git.checkGhCli).toHaveBeenCalled();
		expect(consoleLog).toHaveBeenCalledWith(
			'[useRemoteIntegration] Setting up onRemoteCommand listener'
		);
		expect(maestro.groupChat.onAutoRunTriggered).toHaveBeenCalled();
		expect(maestro.groupChat.onStateChange).toHaveBeenCalled();
		expect(maestro.stats.getInitializationResult).toHaveBeenCalled();

		unmount();
		expect(consoleLog).toHaveBeenCalledWith(
			'[BatchProcessor] Unmounting, isMountedRef set to false'
		);
	});

	it('routes empty-state menu actions into app-level modals', async () => {
		renderApp();

		expect(await screen.findByRole('heading', { name: 'MAESTRO' })).toBeInTheDocument();

		act(() => {
			useModalStore.getState().openModal('newInstance', { duplicatingSessionId: null });
		});
		await waitFor(() => expect(mockAppModalsState.latestProps?.existingSessions).toEqual([]));

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('Settings'));
		await waitFor(() => expect(screen.getByTestId('settings-modal')).toBeInTheDocument());
		expect(mockSettingsState.latestProps?.initialTab).toBe('general');

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('Keyboard Shortcuts'));
		await waitFor(() => expect(useModalStore.getState().isOpen('shortcutsHelp')).toBe(true));

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('Check for Updates'));
		await waitFor(() => expect(useModalStore.getState().isOpen('updateCheck')).toBe(true));

		fireEvent.click(screen.getByTitle('Menu'));
		fireEvent.click(await screen.findByText('About Maestro'));
		await waitFor(() => expect(useModalStore.getState().isOpen('about')).toBe(true));
	});

	it('renders the active-session workspace when a session exists', async () => {
		const session = createSession({ groupId: 'group-1' });
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			groups: [{ id: 'group-1', name: 'Core Team', emoji: 'G' }],
			sessions: [session],
		});

		const { unmount } = renderApp();

		expect(await screen.findByText('G Core Team | Agent One | Planning')).toBeInTheDocument();
		expect(maestro.process.onData).toHaveBeenCalled();
		expect(maestro.history.onExternalChange).toHaveBeenCalled();

		act(() => {
			useModalStore.getState().openModal('newInstance', { duplicatingSessionId: null });
		});
		await waitFor(() => expect(mockAppModalsState.latestProps?.existingSessions).toHaveLength(1));

		unmount();
		expect(consoleLog).toHaveBeenCalledWith(
			'[BatchProcessor] Unmounting, isMountedRef set to false'
		);
	});

	it('renders terminal cwd and title fallbacks for sessions without groups or tab names', async () => {
		const session = createSession({
			aiTabs: [
				{
					agentSessionId: 'abc123-def456',
					createdAt: 1,
					id: 'tab-1',
					isUnread: false,
					logs: [],
					name: '',
					state: 'idle',
				},
			],
			groupId: undefined,
			inputMode: 'terminal',
			shellCwd: '/test/project/shell',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});

		renderApp();

		expect(await screen.findByText('Agent One | ABC123')).toBeInTheDocument();
		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.gitViewerCwd).toBe('/test/project/shell')
		);

		act(() => {
			const current = getSessionById(session.id);
			useSessionStore.setState({
				sessions: [
					{
						...current,
						shellCwd: undefined,
					},
				],
			});
		});
		await waitFor(() => expect(mockAppModalsState.latestProps?.gitViewerCwd).toBe('/test/project'));

		act(() => {
			const current = getSessionById(session.id);
			useSessionStore.setState({
				sessions: [
					{
						...current,
						aiTabs: [{ ...current.aiTabs[0], agentSessionId: undefined }],
					},
				],
			});
		});

		await waitFor(() => expect(screen.getAllByText('Agent One').length).toBeGreaterThan(0));

		act(() => {
			const current = getSessionById(session.id);
			useSessionStore.setState({
				sessions: [
					{
						...current,
						aiTabs: [],
					},
				],
			});
		});
		await waitFor(() => expect(screen.getAllByText('Agent One').length).toBeGreaterThan(0));
	});

	it('uses native title bar spacing and shows the image drop overlay while dragging files', async () => {
		const session = createSession({
			aiTabs: [
				{
					createdAt: 1,
					id: 'tab-1',
					isUnread: false,
					logs: [],
					name: 'Draft',
					state: 'idle',
					stagedImages: ['data:image/png;base64,one'],
				},
			],
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSettingsStore.setState({ useNativeTitleBar: true });
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});

		renderApp();

		await screen.findByTestId('main-panel');
		expect(screen.queryByText(/Maestro Group Chat/)).not.toBeInTheDocument();

		fireEvent.dragEnter(screen.getByTestId('main-panel'), {
			dataTransfer: { types: ['Files'] },
		});

		expect(await screen.findByText('Drop image to attach')).toBeInTheDocument();
	});

	it('uses custom theme colors from settings', async () => {
		const customThemeColors = {
			...useSettingsStore.getState().customThemeColors,
			accent: '#123456',
			bgMain: '#101010',
			textMain: '#f0f0f0',
		};
		useSettingsStore.setState({
			activeThemeId: 'custom',
			customThemeColors,
		});

		renderApp();

		expect(await screen.findByRole('heading', { name: 'MAESTRO' })).toBeInTheDocument();
		await waitFor(() =>
			expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#123456')
		);
	});

	it('exposes debug modal helpers and cleans them up on unmount', async () => {
		const { unmount } = renderApp();

		await waitFor(() =>
			expect((window as any).__maestroDebug?.openSettings).toEqual(expect.any(Function))
		);
		const debugHelpers = (window as any).__maestroDebug;
		await act(async () => {
			await debugHelpers.openWizard();
			debugHelpers.openCommandK();
			debugHelpers.openDebugWizard();
			debugHelpers.openSettings();
		});

		await waitFor(() =>
			expect(window.maestro.settings.get).toHaveBeenCalledWith('wizardResumeState')
		);
		expect(useModalStore.getState().isOpen('quickAction')).toBe(true);
		expect(useModalStore.getState().isOpen('debugWizard')).toBe(true);
		expect(useModalStore.getState().isOpen('settings')).toBe(true);

		unmount();
		expect((window as any).__maestroDebug).toBeUndefined();
	});

	it('exposes debug toast helpers through the effect-backed console API', async () => {
		let currentDebugApi: Record<string, any> | undefined;
		let effectDebugApi: Record<string, any> | undefined;
		Object.defineProperty(window, '__maestroDebug', {
			configurable: true,
			get: () => currentDebugApi,
			set: (value) => {
				currentDebugApi = value;
				if (value?.addToast) {
					effectDebugApi = value;
				}
			},
		});

		try {
			renderApp();

			await waitFor(() => expect(effectDebugApi?.addToast).toEqual(expect.any(Function)));

			act(() => {
				effectDebugApi?.addToast('warning', 'Heads up', 'Check logs');
				effectDebugApi?.testToast();
			});

			expect(useNotificationStore.getState().toasts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'warning',
						title: 'Heads up',
						message: 'Check logs',
					}),
					expect.objectContaining({
						type: 'success',
						title: 'Test Notification',
						message: 'This is a test toast notification from the console!',
						group: 'Debug',
						project: 'Test Project',
					}),
				])
			);
		} finally {
			delete (window as any).__maestroDebug;
		}
	});

	it('routes overlay and confirmation callbacks back into stores and bridge calls', async () => {
		const session = createSession({ cwd: '/test/project', worktreeParentPath: '/test' });
		const maestro = configureMaestroBridge();
		maestro.process.kill = vi.fn().mockResolvedValue(undefined);
		maestro.playbooks = { deleteAll: vi.fn().mockResolvedValue(undefined) };
		maestro.shell.trashItem = vi.fn().mockResolvedValue(undefined);
		maestro.stats.recordSessionClosed = vi.fn();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		useModalStore.getState().openModal('windowsWarning');
		useModalStore.getState().openModal('playground');
		useModalStore.getState().openModal('debugWizard');
		useModalStore.getState().openModal('deleteAgent', { session });
		useModalStore.getState().openModal('tour', { fromWizard: true });

		renderApp();

		expect(await screen.findByTestId('windows-warning-modal')).toBeInTheDocument();
		expect(screen.getByTestId('playground-panel')).toBeInTheDocument();
		expect(screen.getByTestId('debug-wizard-modal')).toBeInTheDocument();
		expect(screen.getByTestId('delete-agent-confirm-modal')).toBeInTheDocument();
		expect(screen.getByTestId('tour-overlay')).toBeInTheDocument();
		expect(mockTourState.latestProps?.fromWizard).toBe(true);

		act(() => {
			mockWindowsWarningState.latestProps?.onOpenDebugPackage();
			mockWindowsWarningState.latestProps?.onClose();
			mockPlaygroundState.latestProps?.onClose();
			mockDebugWizardState.latestProps?.onClose();
			mockTourState.latestProps?.onClose();
		});
		expect(useModalStore.getState().isOpen('debugPackage')).toBe(true);
		expect(useModalStore.getState().isOpen('windowsWarning')).toBe(false);
		expect(useModalStore.getState().isOpen('playground')).toBe(false);
		expect(useModalStore.getState().isOpen('debugWizard')).toBe(false);
		expect(useModalStore.getState().isOpen('tour')).toBe(false);
		expect(useSettingsStore.getState().tourCompleted).toBe(true);
		expect(maestro.settings.set).toHaveBeenCalledWith('tourCompleted', true);

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
		useSessionStore.setState({ activeSessionId: eraseSession.id, sessions: [eraseSession] });
		useModalStore.getState().openModal('deleteAgent', { session: eraseSession });
		await waitFor(() =>
			expect(mockDeleteAgentConfirmState.latestProps?.agentName).toBe('Erase Agent')
		);
		await act(async () => {
			await mockDeleteAgentConfirmState.latestProps?.onConfirmAndErase();
		});
		expect(maestro.shell.trashItem).toHaveBeenCalledWith('/test/project/erase');
	});

	it('clears auto-send activation and cancels delayed send when the active target changes', async () => {
		const autoSendSession = createSession({
			aiTabs: [
				{
					agentSessionId: 'claude-session-1',
					autoSendOnActivate: true,
					createdAt: 1,
					id: 'tab-1',
					inputValue: 'Transferred context',
					isUnread: false,
					logs: [],
					name: 'Planning',
					pendingMergedContext: 'Merged context',
					state: 'idle',
				},
			],
			state: 'idle',
			busySource: undefined,
		});
		const otherSession = createSession({
			id: 'session-2',
			name: 'Other Agent',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.process.write = vi.fn().mockResolvedValue(undefined);
		maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 12345 });
		maestro.sessions.getAll.mockResolvedValue([autoSendSession, otherSession]);
		useSessionStore.setState({
			activeSessionId: autoSendSession.id,
			sessions: [autoSendSession, otherSession],
		});

		renderApp();

		await waitFor(() =>
			expect(getSessionById(autoSendSession.id).aiTabs[0].autoSendOnActivate).toBe(false)
		);

		act(() => {
			useSessionStore.getState().setActiveSessionIdInternal(otherSession.id);
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 130));
		});

		expect(maestro.process.write).not.toHaveBeenCalled();
		expect(maestro.process.spawn).not.toHaveBeenCalled();
	});

	it('cancels delayed auto-send when the target tab is removed before send', async () => {
		const autoSendSession = createSession({
			aiTabs: [
				{
					agentSessionId: 'claude-session-1',
					autoSendOnActivate: true,
					createdAt: 1,
					id: 'tab-1',
					inputValue: 'Transferred context',
					isUnread: false,
					logs: [],
					name: 'Planning',
					pendingMergedContext: 'Merged context',
					state: 'idle',
				},
				{
					agentSessionId: 'claude-session-2',
					createdAt: 2,
					id: 'tab-2',
					inputValue: 'Different prompt',
					isUnread: false,
					logs: [],
					name: 'Follow-up',
					state: 'idle',
				},
			],
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.process.write = vi.fn().mockResolvedValue(undefined);
		maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 12345 });
		maestro.sessions.getAll.mockResolvedValue([autoSendSession]);
		useSessionStore.setState({
			activeSessionId: autoSendSession.id,
			sessions: [autoSendSession],
		});

		renderApp();

		await waitFor(() =>
			expect(getSessionById(autoSendSession.id).aiTabs[0].autoSendOnActivate).toBe(false)
		);

		act(() => {
			const session = getSessionById(autoSendSession.id);
			useSessionStore.setState({
				sessions: [
					{
						...session,
						aiTabs: [session.aiTabs[1]],
						unifiedTabOrder: [{ type: 'ai', id: 'tab-2' }],
					},
				],
			});
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 130));
		});

		expect(maestro.process.write).not.toHaveBeenCalled();
		expect(maestro.process.spawn).not.toHaveBeenCalled();
	});

	it('cancels delayed auto-send when the target session is removed before send', async () => {
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
				{
					agentSessionId: 'claude-session-1',
					autoSendOnActivate: true,
					createdAt: 1,
					id: 'tab-1',
					inputValue: 'Transferred context',
					isUnread: false,
					logs: [],
					name: 'Planning',
					pendingMergedContext: 'Merged context',
					state: 'idle',
				},
			],
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.process.write = vi.fn().mockResolvedValue(undefined);
		maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 12345 });
		maestro.sessions.getAll.mockResolvedValue([autoSendSession]);
		useSessionStore.setState({
			activeSessionId: autoSendSession.id,
			sessions: [autoSendSession],
		});

		try {
			renderApp();

			await waitFor(() =>
				expect(getSessionById(autoSendSession.id).aiTabs[0].autoSendOnActivate).toBe(false)
			);
			expect(delayedAutoSendCallbacks).toHaveLength(1);

			act(() => {
				useSessionStore.setState({
					activeSessionId: '',
					sessions: [],
				});
				delayedAutoSendCallbacks.forEach((callback) => callback());
			});

			expect(maestro.process.write).not.toHaveBeenCalled();
			expect(maestro.process.spawn).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it('auto-sends pending merged context when the activated target remains active', async () => {
		const autoSendSession = createSession({
			aiTabs: [
				{
					agentSessionId: 'claude-session-1',
					autoSendOnActivate: true,
					createdAt: 1,
					id: 'tab-1',
					inputValue: 'Transferred context',
					isUnread: false,
					logs: [],
					name: 'Planning',
					pendingMergedContext: 'Merged context',
					state: 'idle',
				},
			],
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 12345 });
		maestro.web.broadcastUserInput = vi.fn();
		maestro.sessions.getAll.mockResolvedValue([autoSendSession]);
		useSessionStore.setState({
			activeSessionId: autoSendSession.id,
			sessions: [autoSendSession],
		});

		renderApp();

		await waitFor(() =>
			expect(getSessionById(autoSendSession.id).aiTabs[0].autoSendOnActivate).toBe(false)
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
		await waitFor(() =>
			expect(getSessionById(autoSendSession.id).aiTabs[0].pendingMergedContext).toBeUndefined()
		);
	});

	it('passes aggregated slash commands and error recovery callbacks to the main panel', async () => {
		const agentError = {
			agentId: 'claude-code',
			message: 'Agent failed',
			recoverable: true,
			timestamp: Date.now(),
			type: 'agent_crashed' as const,
		};
		const session = createSession({
			agentCommands: [{ command: '/agent-help', description: 'Agent-specific command' }],
			agentError,
			agentErrorTabId: 'tab-1',
			aiTabs: [
				{
					agentError,
					agentSessionId: 'claude-session-1',
					createdAt: 1,
					id: 'tab-1',
					isUnread: false,
					logs: [],
					name: 'Planning',
					state: 'idle',
				},
			],
			executionQueue: [
				{
					id: 'queue-1',
					tabId: 'tab-1',
					text: 'Queued prompt',
					timestamp: 1,
					type: 'message',
				},
			],
			state: 'idle',
			busySource: undefined,
		});
		const otherSession = createSession({
			executionQueue: [
				{
					id: 'other-queue',
					tabId: 'tab-1',
					text: 'Other queued prompt',
					timestamp: 2,
					type: 'message',
				},
			],
			id: 'session-other',
			name: 'Other Agent',
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session, otherSession]);
		maestro.speckit.getPrompts.mockResolvedValue({
			success: true,
			commands: [
				{
					command: '/specify',
					description: 'Create a spec',
					id: 'specify',
					prompt: 'Write a specification',
				},
			],
		});
		maestro.openspec.getPrompts.mockResolvedValue({
			success: true,
			commands: [
				{
					command: '/openspec',
					description: 'Create an OpenSpec',
					id: 'openspec',
					prompt: 'Write an OpenSpec',
				},
			],
		});
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session, otherSession],
		});

		renderApp();
		await screen.findByTestId('main-panel');

		await waitFor(() =>
			expect(mockMainPanelState.latestProps?.slashCommands.map((cmd: any) => cmd.command)).toEqual(
				expect.arrayContaining(['/specify', '/openspec', '/agent-help'])
			)
		);
		expect(mockMainPanelState.latestProps?.slashCommands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ command: '/specify', isSpeckit: true }),
				expect.objectContaining({ command: '/openspec', isOpenspec: true }),
				expect.objectContaining({ command: '/agent-help' }),
			])
		);
		expect(mockMainPanelState.latestProps?.onClearAgentError).toEqual(expect.any(Function));
		const onClearAgentError = mockMainPanelState.latestProps?.onClearAgentError as () => void;

		act(() => {
			onClearAgentError();
		});

		await waitFor(() => expect(getSessionById(session.id).aiTabs[0].agentError).toBeUndefined());
		expect(maestro.agentError.clearError).toHaveBeenCalledWith(session.id);
		act(() => {
			onClearAgentError();
		});
		expect(maestro.agentError.clearError).toHaveBeenCalledTimes(1);
		act(() => {
			useSessionStore.setState({ activeSessionId: 'missing-session' });
			onClearAgentError();
		});
		expect(maestro.agentError.clearError).toHaveBeenCalledTimes(1);
		act(() => {
			useSessionStore.setState({ activeSessionId: session.id });
		});

		act(() => {
			mockMainPanelState.latestProps?.onRemoveQueuedItem('queue-1');
		});
		expect(getSessionById(session.id).executionQueue).toEqual([]);
		expect(getSessionById('session-other').executionQueue).toHaveLength(1);

		const theme = mockMainPanelState.latestProps?.theme;
		expect(mockMainPanelState.latestProps?.getContextColor(90, theme)).toBe(theme.colors.error);

		act(() => {
			useSessionStore.setState({
				sessions: [
					{ ...getSessionById(session.id), activeTabId: undefined },
					getSessionById('session-other'),
				],
			});
		});
		await waitFor(() => expect(mockAppModalsState.latestProps?.canSummarizeActiveTab).toBe(false));
	});

	it('bridges session navigation refs and keyboard summarization state through stores', async () => {
		const session = createSession({
			contextUsage: 95,
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			cyclePosition: 4,
			sessions: [session],
		});

		renderApp();
		await screen.findByTestId('main-panel');
		await waitFor(() =>
			expect(mockSessionNavigationState.latestDeps?.cyclePositionRef).toBeTruthy()
		);
		await waitFor(() => expect(mockKeyboardHandlerState.latestRef?.current).toBeTruthy());

		const cyclePositionRef = mockSessionNavigationState.latestDeps?.cyclePositionRef;
		expect(cyclePositionRef.current).toBe(4);

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
				sessions: [
					{
						...getSessionById(session.id),
						activeTabId: undefined,
					},
				],
			});
		});
		await waitFor(() =>
			expect(mockKeyboardHandlerState.latestRef?.current?.canSummarizeActiveTab).toBe(false)
		);

		act(() => {
			useSessionStore.setState({ activeSessionId: 'missing-session' });
		});
		await waitFor(() =>
			expect(mockKeyboardHandlerState.latestRef?.current?.canSummarizeActiveTab).toBe(false)
		);
	});

	it('checks wizard resume state before opening the onboarding wizard', async () => {
		const savedWizardState = {
			agentName: 'Claude Code',
			confidenceLevel: 75,
			conversationHistory: [{ role: 'user', content: 'Build the plan' }],
			currentStep: 'conversation',
			directoryPath: '/test/project',
			editedPhase1Content: null,
			generatedDocuments: [],
			isGitRepo: true,
			isReadyToProceed: false,
			selectedAgent: 'claude-code',
			wantsTour: false,
		};
		window.maestro.settings.get.mockImplementation((key: string) =>
			Promise.resolve(key === 'wizardResumeState' ? savedWizardState : undefined)
		);

		renderApp();
		fireEvent.click(await screen.findByRole('button', { name: /Wizard/i }));

		await waitFor(() =>
			expect(window.maestro.settings.get).toHaveBeenCalledWith('wizardResumeState')
		);
		await waitFor(() => expect(useModalStore.getState().isOpen('wizardResume')).toBe(true));
		expect(useModalStore.getState().getData('wizardResume')).toEqual({ state: savedWizardState });
	});

	it('falls back to a fresh wizard when resume state lookup fails', async () => {
		const error = new Error('settings unavailable');
		window.maestro.settings.get.mockImplementation((key: string) =>
			key === 'wizardResumeState' ? Promise.reject(error) : Promise.resolve(undefined)
		);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			renderApp();
			fireEvent.click(await screen.findByRole('button', { name: /Wizard/i }));

			await waitFor(() =>
				expect(consoleError).toHaveBeenCalledWith(
					'[App] Failed to check wizard resume state:',
					error
				)
			);
			expect(useModalStore.getState().isOpen('wizardResume')).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('ignores AppModals utility callbacks when no session is active', async () => {
		renderApp();
		await screen.findByTestId('app-modals');

		await act(async () => {
			mockAppModalsState.latestProps?.onSaveBatchPrompt('No active session');
			mockAppModalsState.latestProps?.onTabSelect('missing-tab');
			mockAppModalsState.latestProps?.onFileTabSelect('missing-file-tab');
			mockAppModalsState.latestProps?.onFileSearchSelect({
				depth: 0,
				fullPath: 'docs/plan.md',
				isFolder: false,
				name: 'plan.md',
			});
			mockAppModalsState.latestProps?.onFileSearchSelect({
				depth: 0,
				fullPath: 'docs',
				isFolder: true,
				name: 'docs',
			});
			await mockAppModalsState.latestProps?.onPRCreated({
				sourceBranch: 'feature/no-session',
				targetBranch: 'main',
				title: 'No active session PR',
				url: 'https://github.com/example/maestro/pull/7',
			});
		});

		expect(useSessionStore.getState().sessions).toEqual([]);
		expect(window.maestro.history.add).not.toHaveBeenCalled();
	});

	it('handles AppModals session navigation, utility, and PR callbacks', async () => {
		const sessionOne = createSession({
			activeFileTabId: 'readme-tab',
			inputMode: 'ai',
		});
		const sessionTwo = createSession({
			activeFileTabId: 'notes-tab',
			activeTabId: 'tab-a',
			aiTabs: [
				{
					agentSessionId: 'claude-session-a',
					createdAt: 1,
					id: 'tab-a',
					isUnread: false,
					logs: [],
					name: 'First Tab',
					state: 'idle',
				},
				{
					agentSessionId: 'claude-session-b',
					createdAt: 2,
					id: 'tab-b',
					isUnread: false,
					logs: [],
					name: 'Second Tab',
					state: 'idle',
				},
			],
			cwd: '/other/project',
			id: 'session-2',
			inputMode: 'shell',
			name: 'Agent Two',
			projectRoot: '',
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([sessionOne, sessionTwo]);
		useSessionStore.setState({
			activeSessionId: sessionOne.id,
			sessions: [sessionOne, sessionTwo],
		});
		useSettingsStore.setState({
			encoreFeatures: { directorNotes: true },
		});
		useModalStore.getState().openModal('usageDashboard');

		renderApp();
		await screen.findByTestId('app-modals');

		await act(async () => {
			mockAppModalsState.latestProps?.onNavigateToSession('session-2', 'tab-b');
		});

		await waitFor(() => expect(useSessionStore.getState().activeSessionId).toBe('session-2'));
		expect(getSessionById('session-2').activeTabId).toBe('tab-b');

		await act(async () => {
			mockAppModalsState.latestProps?.onNavigateToSession('session-2');
		});
		expect(useSessionStore.getState().activeSessionId).toBe('session-2');
		expect(getSessionById('session-2').activeTabId).toBe('tab-b');

		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.promptComposerSessionName).toBe('Agent Two')
		);
		act(() => {
			mockAppModalsState.latestProps?.onOpenCreatePR({
				...getSessionById('session-2'),
				projectRoot: '',
			});
		});
		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.createPRSession?.projectRoot).toBe('')
		);
		act(() => {
			mockAppModalsState.latestProps?.onSaveBatchPrompt('Summarize the changed files');
		});
		expect(getSessionById('session-2')).toEqual(
			expect.objectContaining({
				batchRunnerPrompt: 'Summarize the changed files',
				batchRunnerPromptModifiedAt: expect.any(Number),
			})
		);

		act(() => {
			mockAppModalsState.latestProps?.onTabSelect('tab-a');
		});
		expect(getSessionById('session-2')).toEqual(
			expect.objectContaining({
				activeFileTabId: null,
				activeTabId: 'tab-a',
			})
		);

		act(() => {
			mockAppModalsState.latestProps?.onFileTabSelect('notes-tab');
		});
		expect(getSessionById('session-2').activeFileTabId).toBe('notes-tab');

		vi.useFakeTimers();
		act(() => {
			mockAppModalsState.latestProps?.onNamedSessionSelect(
				'agent-session-new',
				'/other/project',
				'Named Session',
				true
			);
			vi.advanceTimersByTime(50);
		});
		expect(useUIStore.getState().activeFocus).toBe('main');
		vi.useRealTimers();

		maestro.fs.readFile.mockResolvedValueOnce('Plan body');
		maestro.fs.stat.mockResolvedValueOnce({ modifiedAt: '2026-01-02T03:04:05.000Z' });
		await act(async () => {
			mockAppModalsState.latestProps?.onFileSearchSelect({
				depth: 0,
				fullPath: 'docs/plan.md',
				isFolder: false,
				name: 'plan.md',
			});
			await Promise.resolve();
			await Promise.resolve();
		});
		await waitFor(() =>
			expect(getSessionById('session-2').filePreviewTabs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: 'Plan body',
						name: 'plan',
						path: '/other/project/docs/plan.md',
					}),
				])
			)
		);

		act(() => {
			mockAppModalsState.latestProps?.onCloseUsageDashboard();
			mockAppModalsState.latestProps?.onOpenSymphony();
			mockAppModalsState.latestProps?.onOpenDirectorNotes?.();
			mockAppModalsState.latestProps?.setCreateGroupModalOpenForQuickActions(true);
		});
		expect(useModalStore.getState().isOpen('usageDashboard')).toBe(false);
		expect(useModalStore.getState().isOpen('symphony')).toBe(true);
		expect(useModalStore.getState().isOpen('directorNotes')).toBe(true);
		await waitFor(() => expect(mockAppModalsState.latestProps?.createGroupModalOpen).toBe(true));
		act(() => {
			mockAppModalsState.latestProps?.onCloseCreateGroupModal();
		});
		await waitFor(() => expect(mockAppModalsState.latestProps?.createGroupModalOpen).toBe(false));

		await act(async () => {
			await mockAppModalsState.latestProps?.onPRCreated({
				description: 'Adds focused App shell behavior coverage.',
				sourceBranch: 'coverage/app-shell',
				targetBranch: 'main',
				title: 'Improve App shell tests',
				url: 'https://github.com/example/maestro/pull/42',
			});
		});

		expect(maestro.history.add).toHaveBeenCalledWith(
			expect.objectContaining({
				fullResponse: expect.stringContaining('Improve App shell tests'),
				projectPath: '/other/project',
				sessionId: 'session-2',
				sessionName: 'Agent Two',
				summary: 'Created PR: Improve App shell tests',
				type: 'USER',
			})
		);
		expect(mockRightPanelState.refreshHistoryPanelCalls).toBe(1);

		await act(async () => {
			await mockAppModalsState.latestProps?.onPRCreated({
				sourceBranch: 'coverage/no-description',
				targetBranch: 'main',
				title: 'PR without description',
				url: 'https://github.com/example/maestro/pull/43',
			});
		});

		expect(maestro.history.add).toHaveBeenLastCalledWith(
			expect.objectContaining({
				fullResponse: expect.not.stringContaining('Description'),
				projectPath: '/other/project',
				sessionId: 'session-2',
				summary: 'Created PR: PR without description',
			})
		);
		expect(mockRightPanelState.refreshHistoryPanelCalls).toBe(2);
	});

	it('routes right-panel and toast callbacks through session state', async () => {
		const sessionOne = createSession({
			activeFileTabId: 'readme-tab',
			autoRunFolderPath: '',
			inputMode: 'ai',
		});
		const sessionTwo = createSession({
			activeFileTabId: 'notes-tab',
			activeTabId: 'tab-a',
			aiTabs: [
				{
					agentSessionId: 'claude-session-a',
					createdAt: 1,
					id: 'tab-a',
					isUnread: false,
					logs: [],
					name: 'First Tab',
					state: 'idle',
				},
				{
					agentSessionId: 'claude-session-b',
					createdAt: 2,
					id: 'tab-b',
					isUnread: false,
					logs: [],
					name: 'Second Tab',
					state: 'idle',
				},
			],
			id: 'session-2',
			inputMode: 'shell',
			name: 'Agent Two',
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([sessionOne, sessionTwo]);
		useSessionStore.setState({
			activeSessionId: sessionOne.id,
			sessions: [sessionOne, sessionTwo],
		});

		renderApp();
		await screen.findByTestId('right-panel');
		await screen.findByTestId('toast-container');

		act(() => {
			mockRightPanelState.latestProps?.setActiveRightTab('autorun');
		});
		await waitFor(() => expect(useUIStore.getState().activeRightTab).toBe('autorun'));
		act(() => {
			mockRightPanelState.latestProps?.setActiveRightTab('files');
		});
		await waitFor(() => expect(useUIStore.getState().activeRightTab).toBe('files'));

		act(() => {
			mockRightPanelState.latestProps?.onAutoRefreshChange(45);
		});
		expect(getSessionById(sessionOne.id).fileTreeAutoRefreshInterval).toBe(45);

		act(() => {
			mockToastState.latestProps?.onSessionClick('session-2', 'missing-tab');
		});
		expect(useSessionStore.getState().activeSessionId).toBe('session-2');
		expect(getSessionById('session-2')).toEqual(
			expect.objectContaining({
				activeFileTabId: null,
				activeTabId: 'tab-a',
				inputMode: 'ai',
			})
		);

		act(() => {
			mockToastState.latestProps?.onSessionClick('session-2', 'tab-b');
		});
		expect(getSessionById('session-2')).toEqual(
			expect.objectContaining({
				activeFileTabId: null,
				activeTabId: 'tab-b',
				inputMode: 'ai',
			})
		);

		act(() => {
			mockAppModalsState.latestProps?.onPromptOpenLightbox?.(
				'data:image/png;base64,one',
				['data:image/png;base64,one'],
				'staged'
			);
		});
		await waitFor(() =>
			expect(mockAppModalsState.latestProps?.onDeleteLightboxImage).toEqual(expect.any(Function))
		);
	});

	it('ignores auto-refresh interval changes when no session is active', async () => {
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([]);
		useSessionStore.setState({
			activeSessionId: '',
			sessions: [],
		});

		renderApp();
		expect(await screen.findByRole('heading', { name: 'MAESTRO' })).toBeInTheDocument();

		act(() => {
			mockRightPanelPropsState.latestProps?.onAutoRefreshChange(45);
		});

		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('opens the active file preview in the document graph from main panel actions', async () => {
		const session = createSession({
			activeFileTabId: 'file-tab-1',
			filePreviewTabs: [
				{
					content: 'Plan body',
					id: 'file-tab-1',
					isDirty: false,
					name: 'plan.md',
					path: '/test/project/docs/plan.md',
				},
			] as any,
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});

		renderApp();
		await screen.findByTestId('main-panel');

		act(() => {
			mockMainPanelState.latestProps?.onOpenInGraph();
		});

		expect(useFileExplorerStore.getState().graphFocusFilePath).toBe('docs/plan.md');
		expect(useFileExplorerStore.getState().lastGraphFocusFilePath).toBe('docs/plan.md');
		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(true);
	});

	it('opens Auto Run setup when switching to Auto Run without a configured folder', async () => {
		const session = createSession({
			autoRunFolderPath: '',
			cwd: '',
			projectRoot: '',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});

		renderApp();
		await screen.findByTestId('right-panel');
		await screen.findByText('Agent One');
		await waitFor(() => expect(getSessionById(session.id).autoRunFolderPath).toBeFalsy());

		act(() => {
			mockRightPanelState.latestProps?.setActiveRightTab('autorun');
		});

		await waitFor(() => expect(useUIStore.getState().activeRightTab).toBe('autorun'));
		await waitFor(() => expect(useModalStore.getState().isOpen('autoRunSetup')).toBe(true));
	});

	it('renders active group chat view and routes group chat callbacks', async () => {
		const session = createSession({
			id: 'session-1',
			name: 'Planner',
			projectRoot: '/test/project',
		});
		const maestro = configureMaestroBridge();
		const groupChat = {
			createdAt: 1,
			id: 'chat-1',
			imagesDir: '/tmp/chat-images',
			logPath: '/tmp/chat.log',
			moderatorAgentId: 'codex',
			moderatorAgentSessionId: 'moderator-agent-session',
			moderatorSessionId: 'moderator-session',
			name: 'Design Review',
			participants: [
				{
					addedAt: 1,
					agentId: 'claude-code',
					name: 'Planner',
					sessionId: session.id,
					totalCost: 1.25,
				},
				{
					addedAt: 2,
					agentId: 'codex',
					name: 'Reviewer',
					sessionId: 'missing-session',
				},
			],
		};
		maestro.sessions.getAll.mockResolvedValue([session]);
		maestro.groupChat.list.mockResolvedValue([groupChat]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		useGroupChatStore.setState({
			activeGroupChatId: 'chat-1',
			groupChatExecutionQueue: [
				{
					id: 'queue-1',
					tabId: 'chat-1',
					text: 'First queued message',
					timestamp: 1,
					type: 'message',
				},
				{
					id: 'queue-2',
					tabId: 'chat-1',
					text: 'Second queued message',
					timestamp: 2,
					type: 'message',
				},
			],
			groupChatMessages: [
				{ timestamp: '2026-01-01T00:00:00.000Z', from: 'Planner', content: 'Hi' },
			],
			groupChatState: 'moderator-thinking',
			groupChats: [groupChat],
			moderatorUsage: { contextUsage: 42, tokenCount: 1000, totalCost: 0.75 },
			participantStates: new Map([['Planner', 'working']]),
		});

		renderApp();

		expect(await screen.findByText('Maestro Group Chat: Design Review')).toBeInTheDocument();
		expect(await screen.findByTestId('group-chat-panel')).toHaveTextContent('Design Review');
		expect(screen.getByTestId('group-chat-right-panel')).toHaveTextContent('participants');
		expect(mockGroupChatPanelState.latestProps).toEqual(
			expect.objectContaining({
				costIncomplete: true,
				totalCost: 2,
			})
		);
		expect(mockGroupChatRightPanelState.latestProps).toEqual(
			expect.objectContaining({
				groupChatId: 'chat-1',
				moderatorAgentId: 'codex',
				moderatorAgentSessionId: 'moderator-agent-session',
				moderatorSessionId: 'moderator-session',
				moderatorState: 'busy',
			})
		);
		expect(mockGroupChatRightPanelState.latestProps?.participantSessionPaths.get(session.id)).toBe(
			'/test/project'
		);

		act(() => {
			mockGroupChatPanelState.latestProps?.onRename();
			mockGroupChatPanelState.latestProps?.onShowInfo();
		});
		expect(useModalStore.getState().isOpen('renameGroupChat')).toBe(true);
		expect(useModalStore.getState().isOpen('groupChatInfo')).toBe(true);

		act(() => {
			mockGroupChatPanelState.latestProps?.onToggleRightPanel();
		});
		expect(useUIStore.getState().rightPanelOpen).toBe(false);

		act(() => {
			mockGroupChatPanelState.latestProps?.onDraftChange('Updated draft');
			mockGroupChatPanelState.latestProps?.setStagedImages(['data:image/png;base64,one']);
			mockGroupChatPanelState.latestProps?.setReadOnlyMode(true);
			mockGroupChatPanelState.latestProps?.onReorderQueuedItems(0, 1);
		});
		expect(useGroupChatStore.getState().groupChats[0].draftMessage).toBe('Updated draft');
		expect(useGroupChatStore.getState().groupChatStagedImages).toEqual([
			'data:image/png;base64,one',
		]);
		expect(useGroupChatStore.getState().groupChatReadOnlyMode).toBe(true);
		expect(useGroupChatStore.getState().groupChatExecutionQueue.map((item) => item.id)).toEqual([
			'queue-2',
			'queue-1',
		]);

		act(() => {
			mockGroupChatPanelState.latestProps?.onRemoveQueuedItem('queue-2');
			mockGroupChatRightPanelState.latestProps?.onToggle();
			mockGroupChatRightPanelState.latestProps?.onTabChange('history');
			mockGroupChatRightPanelState.latestProps?.onColorsComputed({ Planner: '#123456' });
		});
		expect(useGroupChatStore.getState().groupChatExecutionQueue.map((item) => item.id)).toEqual([
			'queue-1',
		]);
		expect(useUIStore.getState().rightPanelOpen).toBe(true);
		expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
		expect(maestro.settings.set).toHaveBeenCalledWith('groupChatRightTab:chat-1', 'history');
		expect(useGroupChatStore.getState().groupChatParticipantColors).toEqual({
			Planner: '#123456',
		});

		act(() => {
			mockGroupChatPanelState.latestProps?.onOpenPromptComposer();
		});
		await waitFor(() => expect(useModalStore.getState().isOpen('promptComposer')).toBe(true));

		act(() => {
			mockGroupChatPanelState.latestProps?.onToggleMarkdownEditMode();
		});
		await waitFor(() => expect(mockGroupChatPanelState.latestProps?.markdownEditMode).toBe(true));

		act(() => {
			useGroupChatStore.setState({
				groupChatState: 'idle',
				groupChats: [
					{
						...groupChat,
						name: '',
						moderatorAgentId: undefined,
						moderatorAgentSessionId: undefined,
						moderatorSessionId: undefined,
						participants: [
							{
								...groupChat.participants[0],
								totalCost: undefined,
							},
						],
					},
				],
				moderatorUsage: null,
			});
		});
		await waitFor(() =>
			expect(mockGroupChatPanelState.latestProps).toEqual(
				expect.objectContaining({
					costIncomplete: true,
					totalCost: 0,
				})
			)
		);
		await waitFor(() =>
			expect(screen.getByText('Maestro Group Chat: Unknown')).toBeInTheDocument()
		);
		expect(mockGroupChatRightPanelState.latestProps).toEqual(
			expect.objectContaining({
				moderatorAgentId: 'claude-code',
				moderatorAgentSessionId: undefined,
				moderatorSessionId: '',
			})
		);
		act(() => {
			useGroupChatStore.setState({
				groupChats: [
					{
						...groupChat,
						participants: groupChat.participants.map((participant) => ({
							...participant,
							totalCost: participant.totalCost ?? 0,
						})),
					},
				],
				moderatorUsage: { contextUsage: 0, tokenCount: 0, totalCost: 0 },
			});
		});
		await waitFor(() =>
			expect(mockGroupChatPanelState.latestProps).toEqual(
				expect.objectContaining({
					costIncomplete: false,
					totalCost: 1.25,
				})
			)
		);
		vi.useFakeTimers();
		act(() => {
			mockGroupChatPanelState.latestProps?.showFlashNotification('Message queued');
		});
		expect(screen.getByText('Message queued')).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.queryByText('Message queued')).not.toBeInTheDocument();
		vi.useRealTimers();
	});

	it('renders stale group-chat title state without mounting the chat panel', async () => {
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([]);
		maestro.groupChat.list.mockResolvedValue([]);
		useGroupChatStore.setState({
			activeGroupChatId: 'missing-chat',
			groupChats: [],
		});

		renderApp();

		expect(await screen.findByText('Maestro Group Chat: Unknown')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-panel')).not.toBeInTheDocument();
	});

	it('mounts lazy app-level modals and document graph when their stores are open', async () => {
		const session = createSession({
			autoRunFolderPath: '/test/project/autorun',
			projectRoot: '',
			state: 'idle',
			busySource: undefined,
		});
		const otherSession = createSession({
			id: 'session-2',
			name: 'Other Agent',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session, otherSession]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session, otherSession],
		});
		useSettingsStore.setState({
			encoreFeatures: { directorNotes: true },
		});
		useFileExplorerStore.setState({
			graphFocusFilePath: 'docs/plan.md',
			isGraphViewOpen: true,
			lastGraphFocusFilePath: 'docs/plan.md',
		});
		useModalStore.getState().openModal('settings', { tab: 'general' });
		useModalStore.getState().openModal('marketplace');
		useModalStore.getState().openModal('symphony');
		useModalStore.getState().openModal('directorNotes');

		const { unmount } = renderApp();

		expect(await screen.findByTestId('settings-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('marketplace-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('symphony-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('director-notes-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('document-graph-view')).toHaveTextContent('docs/plan.md');

		act(() => {
			mockAppModalsState.latestProps?.setLogViewerOpen(true);
		});
		expect(await screen.findByTestId('log-viewer')).toBeInTheDocument();
		expect(mockLogViewerState.latestProps).toEqual(
			expect.objectContaining({
				logLevel: 'info',
				savedSelectedLevels: ['debug', 'info', 'warn', 'error', 'toast'],
			})
		);
		act(() => {
			mockLogViewerState.latestProps?.onSelectedLevelsChange(['error', 'toast']);
			mockLogViewerState.latestProps?.onShortcutUsed('systemLogs');
			mockLogViewerState.latestProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('log-viewer')).not.toBeInTheDocument());
		expect(useSettingsStore.getState().logViewerSelectedLevels).toEqual(['error', 'toast']);
		expect(maestro.settings.set).toHaveBeenCalledWith('logViewerSelectedLevels', [
			'error',
			'toast',
		]);

		act(() => {
			mockSettingsState.latestProps?.onThemeImportError('Theme import failed');
		});
		expect(useUIStore.getState().flashNotification).toBe('Theme import failed');
		act(() => {
			mockSettingsState.latestProps?.onThemeImportSuccess('Theme imported');
		});
		expect(useUIStore.getState().flashNotification).toBe('Theme imported');
		act(() => {
			mockSettingsState.latestProps?.onClose();
			mockMarketplaceState.latestProps?.onClose();
		});
		expect(useModalStore.getState().isOpen('settings')).toBe(false);
		expect(useModalStore.getState().isOpen('marketplace')).toBe(false);

		act(() => {
			mockSymphonyState.latestProps?.onSelectSession(session.id);
		});
		expect(useSessionStore.getState().activeSessionId).toBe(session.id);
		expect(useModalStore.getState().isOpen('symphony')).toBe(false);
		act(() => {
			useModalStore.getState().openModal('symphony');
		});
		await waitFor(() => expect(mockSymphonyState.latestProps?.isOpen).toBe(true));
		act(() => {
			mockSymphonyState.latestProps?.onClose();
		});
		expect(useModalStore.getState().isOpen('symphony')).toBe(false);

		maestro.fs.readFile.mockResolvedValueOnce('Director note body');
		maestro.fs.stat.mockResolvedValueOnce({ modifiedAt: '2026-01-04T05:06:07.000Z' });
		await act(async () => {
			await mockDirectorNotesState.latestProps?.onFileClick('docs/director.md');
		});
		await waitFor(() =>
			expect(getSessionById(session.id).filePreviewTabs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: 'Director note body',
						path: '/test/project/docs/director.md',
					}),
				])
			)
		);
		await waitFor(() => expect(mockAppModalsState.latestProps?.isFilePreviewOpen).toBe(true));

		act(() => {
			mockAppModalsState.latestProps?.onPublishGist();
		});
		expect(await screen.findByTestId('gist-publish-modal')).toBeInTheDocument();
		expect(mockGistState.latestProps).toEqual(
			expect.objectContaining({
				content: 'Director note body',
				filename: 'director.md',
			})
		);
		act(() => {
			mockGistState.latestProps?.onSuccess('https://gist.github.com/example/director', false);
		});
		expect(useTabStore.getState().fileGistUrls['/test/project/docs/director.md']).toEqual(
			expect.objectContaining({
				gistUrl: 'https://gist.github.com/example/director',
				isPublic: false,
				publishedAt: expect.any(Number),
			})
		);
		expect(useNotificationStore.getState().toasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'success',
					title: 'Gist Published',
					actionUrl: 'https://gist.github.com/example/director',
				}),
			])
		);
		act(() => {
			mockGistState.latestProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('gist-publish-modal')).not.toBeInTheDocument());

		act(() => {
			const current = getSessionById(session.id);
			useSessionStore.setState({
				sessions: [{ ...current, activeFileTabId: null, filePreviewTabs: [] }],
			});
			useTabStore.getState().setTabGistContent({
				filename: 'conversation.md',
				content: 'Conversation transcript',
			});
			mockAppModalsState.latestProps?.onPublishGist();
		});
		expect(await screen.findByTestId('gist-publish-modal')).toBeInTheDocument();
		expect(mockGistState.latestProps).toEqual(
			expect.objectContaining({
				content: 'Conversation transcript',
				existingGist: undefined,
				filename: 'conversation.md',
			})
		);
		act(() => {
			mockGistState.latestProps?.onSuccess('https://gist.github.com/example/conversation', true);
		});
		expect(useTabStore.getState().tabGistContent).toBeNull();
		expect(useNotificationStore.getState().toasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining('Public gist created'),
				}),
			])
		);
		act(() => {
			mockGistState.latestProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('gist-publish-modal')).not.toBeInTheDocument());

		act(() => {
			useTabStore.getState().setTabGistContent({} as any);
			mockAppModalsState.latestProps?.onPublishGist();
		});
		expect(await screen.findByTestId('gist-publish-modal')).toBeInTheDocument();
		expect(mockGistState.latestProps).toEqual(
			expect.objectContaining({
				content: '',
				filename: 'conversation.md',
			})
		);
		act(() => {
			mockGistState.latestProps?.onClose();
		});
		await waitFor(() => expect(screen.queryByTestId('gist-publish-modal')).not.toBeInTheDocument());

		act(() => {
			mockDirectorNotesState.latestProps?.onClose();
		});
		expect(useModalStore.getState().isOpen('directorNotes')).toBe(false);

		act(() => {
			mockDocumentGraphState.latestProps?.onExternalLinkOpen('https://example.com/spec');
		});
		expect(maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/spec');

		act(() => {
			useSessionStore.setState({
				sessions: [getSessionById(session.id), otherSession],
			});
			mockDocumentGraphState.latestProps?.onLayoutTypeChange('radial');
		});
		expect(getSessionById(session.id).documentGraphLayout).toBe('radial');
		expect(getSessionById(otherSession.id).documentGraphLayout).toBeUndefined();
		expect(useSettingsStore.getState().documentGraphLayoutType).toBe('radial');
		expect(maestro.settings.set).toHaveBeenCalledWith('documentGraphLayoutType', 'radial');

		maestro.fs.readFile.mockResolvedValueOnce('Linked document body');
		maestro.fs.stat.mockResolvedValueOnce({ modifiedAt: '2026-01-03T04:05:06.000Z' });
		await act(async () => {
			await mockDocumentGraphState.latestProps?.onDocumentOpen('docs/linked.md');
		});
		await waitFor(() =>
			expect(getSessionById(session.id).filePreviewTabs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: 'Linked document body',
						path: '/test/project/docs/linked.md',
					}),
				])
			)
		);
		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);

		useFileExplorerStore.setState({ isGraphViewOpen: true });
		maestro.fs.readFile.mockResolvedValueOnce(null);
		await act(async () => {
			await mockDocumentGraphState.latestProps?.onDocumentOpen('docs/null.md');
		});
		expect(getSessionById(session.id).filePreviewTabs).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ path: '/test/project/docs/null.md' })])
		);
		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);

		useFileExplorerStore.setState({ isGraphViewOpen: true });
		maestro.fs.readFile.mockResolvedValueOnce('Document without stat');
		maestro.fs.stat.mockRejectedValueOnce(new Error('stat denied'));
		await act(async () => {
			await mockDocumentGraphState.latestProps?.onDocumentOpen('docs/no-stat.md');
		});
		await waitFor(() =>
			expect(getSessionById(session.id).filePreviewTabs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: 'Document without stat',
						path: '/test/project/docs/no-stat.md',
					}),
				])
			)
		);
		expect(maestro.fs.stat).toHaveBeenCalledWith('/test/project/docs/no-stat.md', undefined);
		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);

		useFileExplorerStore.setState({ isGraphViewOpen: true });
		const graphOpenFailure = new Error('read denied');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		maestro.fs.readFile.mockRejectedValueOnce(graphOpenFailure);
		try {
			await act(async () => {
				await mockDocumentGraphState.latestProps?.onDocumentOpen('docs/fail.md');
			});
			expect(consoleError).toHaveBeenCalledWith(
				'[DocumentGraph] Failed to open file:',
				graphOpenFailure
			);
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
		} finally {
			consoleError.mockRestore();
		}

		useFileExplorerStore.setState({ isGraphViewOpen: true });
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			});
		try {
			act(() => {
				mockDocumentGraphState.latestProps?.onClose();
			});
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
			expect(mockMainPanelState.focusFilePreviewCalls).toBe(1);
		} finally {
			requestAnimationFrameSpy.mockRestore();
		}

		unmount();
		expect(consoleLog).toHaveBeenCalledWith(
			'[BatchProcessor] Unmounting, isMountedRef set to false'
		);
	});

	it('uses document graph defaults when no session is active', async () => {
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([]);
		useFileExplorerStore.setState({
			graphFocusFilePath: 'docs/rootless.md',
			isGraphViewOpen: true,
		});

		renderApp();

		expect(await screen.findByTestId('document-graph-view')).toBeInTheDocument();
		expect(mockDocumentGraphState.latestProps?.rootPath).toBe('');

		act(() => {
			mockDocumentGraphState.latestProps?.onLayoutTypeChange('force');
		});
		expect(useSessionStore.getState().sessions).toEqual([]);
		expect(useSettingsStore.getState().documentGraphLayoutType).toBe('force');

		maestro.fs.readFile.mockResolvedValueOnce(null);
		await act(async () => {
			await mockDocumentGraphState.latestProps?.onDocumentOpen('docs/rootless.md');
		});

		expect(maestro.fs.readFile).toHaveBeenCalledWith('/docs/rootless.md', undefined);
		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
	});

	it('refreshes Auto Run documents after a marketplace import completes', async () => {
		const session = createSession({
			autoRunFolderPath: '/test/project/autorun',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		maestro.autorun.listDocs.mockResolvedValue({
			success: true,
			files: ['plans/phase-01.md', 'plans/phase-02.md'],
			tree: [],
		});
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		useModalStore.getState().openModal('marketplace');

		renderApp();
		expect(await screen.findByTestId('marketplace-modal')).toBeInTheDocument();

		await act(async () => {
			await mockMarketplaceState.latestProps?.onImportComplete('Starter Playbook');
		});

		await waitFor(() =>
			expect(maestro.autorun.listDocs).toHaveBeenCalledWith('/test/project/autorun', undefined)
		);
		await waitFor(() =>
			expect(useBatchStore.getState().documentList).toEqual([
				'plans/phase-01.md',
				'plans/phase-02.md',
			])
		);
	});

	it('skips marketplace document refresh when the active session has no Auto Run folder', async () => {
		const session = createSession({
			autoRunFolderPath: '',
			state: 'idle',
			busySource: undefined,
		});
		const maestro = configureMaestroBridge();
		maestro.sessions.getAll.mockResolvedValue([session]);
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		useModalStore.getState().openModal('marketplace');

		renderApp();
		expect(await screen.findByTestId('marketplace-modal')).toBeInTheDocument();
		maestro.autorun.listDocs.mockClear();

		await act(async () => {
			await mockMarketplaceState.latestProps?.onImportComplete('Starter Playbook');
		});

		expect(maestro.autorun.listDocs).not.toHaveBeenCalledWith('', expect.anything());
		expect(useNotificationStore.getState().toasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'success',
					title: 'Playbook Imported',
				}),
			])
		);
	});

	it('reports recoverable group-chat Auto Run startup failures to the moderator', async () => {
		const { maestro, triggerAutoRun, view } = await renderAppCapturingGroupChatAutoRun();

		await expectGroupChatAutoRunFailure(
			() => triggerAutoRun('chat-1', 'Planner'),
			'No Maestro agent named "Planner" found'
		);
		expect(maestro.autorun.listDocs).not.toHaveBeenCalled();

		window.maestro.groupChat.reportAutoRunComplete.mockClear();
		window.maestro.groupChat.reportAutoRunComplete.mockRejectedValueOnce(
			new Error('moderator offline')
		);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await triggerAutoRun('chat-1', 'Missing');
			await waitFor(() =>
				expect(consoleError).toHaveBeenCalledWith(
					'[GroupChat:AutoRun] Failed to report failure to moderator:',
					expect.any(Error)
				)
			);
		} finally {
			consoleError.mockRestore();
		}

		const session = createSession({
			autoRunFolderPath: '',
			cwd: '',
			name: 'Planner',
			projectRoot: '',
		});
		useSessionStore.setState({
			activeSessionId: session.id,
			sessions: [session],
		});
		maestro.autorun.listDocs.mockClear();

		await expectGroupChatAutoRunFailure(
			() => triggerAutoRun('chat-1', 'Planner'),
			'Agent "Planner" has no Auto Run folder configured'
		);
		expect(maestro.autorun.listDocs).not.toHaveBeenCalled();

		const sessionWithFolder = createSession({
			autoRunFolderPath: '/project/autorun',
			name: 'Planner',
			sshRemoteId: 'remote-1',
		});
		useSessionStore.setState({
			activeSessionId: sessionWithFolder.id,
			sessions: [sessionWithFolder],
		});
		maestro.autorun.listDocs.mockClear();
		maestro.autorun.listDocs.mockResolvedValueOnce({ success: true, files: [] });

		await expectGroupChatAutoRunFailure(
			() => triggerAutoRun('chat-1', 'Planner'),
			'No Auto Run documents found in "/project/autorun"'
		);
		expect(maestro.autorun.listDocs).toHaveBeenCalledWith('/project/autorun', 'remote-1');

		const localSessionWithFolder = createSession({
			autoRunFolderPath: '/local/autorun',
			name: 'Planner',
			sshRemoteId: undefined,
		});
		useSessionStore.setState({
			activeSessionId: localSessionWithFolder.id,
			sessions: [localSessionWithFolder],
		});
		maestro.autorun.listDocs.mockClear();
		maestro.autorun.listDocs.mockResolvedValueOnce({ success: true } as any);

		await expectGroupChatAutoRunFailure(
			() => triggerAutoRun('chat-1', 'Planner'),
			'No Auto Run documents found in "/local/autorun"'
		);
		expect(maestro.autorun.listDocs).toHaveBeenCalledWith('/local/autorun', undefined);

		useSessionStore.setState({
			activeSessionId: sessionWithFolder.id,
			sessions: [sessionWithFolder],
		});
		maestro.autorun.listDocs.mockClear();
		maestro.autorun.listDocs.mockResolvedValueOnce({ success: true, files: ['plans/phase-01'] });

		await expectGroupChatAutoRunFailure(
			() => triggerAutoRun('chat-1', 'Planner', 'missing.md'),
			'Specified file "missing.md" not found'
		);
		expect(maestro.autorun.listDocs).toHaveBeenCalledWith('/project/autorun', 'remote-1');

		maestro.autorun.listDocs.mockClear();
		maestro.autorun.listDocs.mockRejectedValueOnce(new Error('disk denied'));

		await expectGroupChatAutoRunFailure(
			() => triggerAutoRun('chat-1', 'Planner'),
			'Failed to read Auto Run folder: Error: disk denied'
		);
		expect(maestro.autorun.listDocs).toHaveBeenCalledWith('/project/autorun', 'remote-1');

		window.maestro.groupChat.reportAutoRunComplete.mockClear();
		maestro.autorun.listDocs.mockClear();
		maestro.autorun.listDocs.mockResolvedValueOnce({
			success: true,
			files: ['plans/phase-01', 'plans/phase-02'],
		});

		await triggerAutoRun('chat-1', 'Planner', 'phase-01.md');

		await waitFor(() =>
			expect(maestro.logger.log).toHaveBeenCalledWith(
				'info',
				'startBatchRun called',
				'BatchProcessor',
				expect.objectContaining({
					documentsCount: 1,
					folderPath: '/project/autorun',
					sessionId: sessionWithFolder.id,
				})
			)
		);
		expect(window.maestro.groupChat.reportAutoRunComplete).not.toHaveBeenCalled();
		expect(consumeGroupChatAutoRun(sessionWithFolder.id)).toEqual({
			groupChatId: 'chat-1',
			participantName: 'Planner',
		});
		view.unmount();
	});
});
