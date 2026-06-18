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

		try {
			renderApp();

			await waitFor(() =>
				expect(getSessionById(autoSendSession.id).aiTabs[0].autoSendOnActivate).toBe(false)
			);
			expect(delayedAutoSendCallbacks).toHaveLength(1);

			act(() => {
				useSessionStore.getState().setActiveSessionIdInternal(otherSession.id);
				delayedAutoSendCallbacks.forEach((callback) => callback());
			});

			expect(maestro.process.write).not.toHaveBeenCalled();
			expect(maestro.process.spawn).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it('cancels delayed auto-send when the target tab is removed before send', async () => {
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

		try {
			renderApp();

			await waitFor(() =>
				expect(getSessionById(autoSendSession.id).aiTabs[0].autoSendOnActivate).toBe(false)
			);
			expect(delayedAutoSendCallbacks).toHaveLength(1);

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
				delayedAutoSendCallbacks.forEach((callback) => callback());
			});

			expect(maestro.process.write).not.toHaveBeenCalled();
			expect(maestro.process.spawn).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
		}
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
});
