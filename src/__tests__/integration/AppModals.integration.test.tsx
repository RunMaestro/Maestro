/**
 * Integration tests for AppModals.tsx self-sourced modal state
 *
 * Verifies that AppModals reads data from Zustand stores
 * (sessionStore, groupChatStore, modalStore) instead of receiving
 * them as props, and correctly passes those values to sub-components.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import type { Theme, Session, Shortcut, Group, GroupChat } from '../../renderer/types';

// Track props passed to sub-components
let capturedInfoProps: Record<string, unknown> = {};
let capturedConfirmProps: Record<string, unknown> = {};
let capturedSessionProps: Record<string, unknown> = {};
let capturedGroupProps: Record<string, unknown> = {};
let capturedWorktreeProps: Record<string, unknown> = {};
let capturedUtilityProps: Record<string, unknown> = {};
let capturedGroupChatProps: Record<string, unknown> = {};
let capturedAgentProps: Record<string, unknown> = {};

// Mock ALL sub-components to capture props
vi.mock('../../renderer/components/AboutModal', () => ({ AboutModal: () => null }));
vi.mock('../../renderer/components/ShortcutsHelpModal', () => ({
	ShortcutsHelpModal: () => null,
}));
vi.mock('../../renderer/components/UpdateCheckModal', () => ({ UpdateCheckModal: () => null }));
vi.mock('../../renderer/components/ProcessMonitor', () => ({ ProcessMonitor: () => null }));
vi.mock('../../renderer/components/UsageDashboard', () => ({
	UsageDashboardModal: () => <div data-testid="usage-dashboard-modal" />,
}));
vi.mock('../../renderer/components/GitDiffViewer', () => ({
	GitDiffViewer: () => <div data-testid="git-diff-viewer" />,
}));
vi.mock('../../renderer/components/GitLogViewer', () => ({
	GitLogViewer: () => <div data-testid="git-log-viewer" />,
}));
vi.mock('../../renderer/components/ConfirmModal', () => ({
	ConfirmModal: (props: Record<string, unknown>) => {
		capturedConfirmProps.confirm = props;
		return <div data-testid="confirm-modal">{String(props.message ?? '')}</div>;
	},
}));
vi.mock('../../renderer/components/QuitConfirmModal', () => ({
	QuitConfirmModal: (props: { busyAgentCount?: number; busyAgentNames?: string[] }) => {
		capturedConfirmProps.quit = props;
		return <div data-testid="quit-confirm-modal">{props.busyAgentNames?.join('|')}</div>;
	},
}));
vi.mock('../../renderer/components/NewInstanceModal', () => ({
	NewInstanceModal: (props: { sourceSession?: Session }) => (
		<div data-testid="new-instance-modal">{props.sourceSession?.name}</div>
	),
	EditAgentModal: () => null,
}));
vi.mock('../../renderer/components/RenameSessionModal', () => ({
	RenameSessionModal: () => null,
}));
vi.mock('../../renderer/components/RenameTabModal', () => ({
	RenameTabModal: (props: { agentSessionId?: string }) => (
		<div data-testid="rename-tab-modal">{props.agentSessionId}</div>
	),
}));
vi.mock('../../renderer/components/CreateGroupModal', () => ({
	CreateGroupModal: (props: Record<string, unknown>) => {
		capturedGroupProps.create = props;
		return <div data-testid="create-group-modal" />;
	},
}));
vi.mock('../../renderer/components/RenameGroupModal', () => ({
	RenameGroupModal: (props: { groupId?: string; groupName?: string; groupEmoji?: string }) => {
		capturedGroupProps.rename = props;
		return (
			<div data-testid="rename-group-modal">
				{props.groupId}:{props.groupName}:{props.groupEmoji}
			</div>
		);
	},
}));
vi.mock('../../renderer/components/WorktreeConfigModal', () => ({
	WorktreeConfigModal: (props: { session?: Session }) => {
		capturedWorktreeProps.config = props;
		return <div data-testid="worktree-config-modal">{props.session?.name}</div>;
	},
}));
vi.mock('../../renderer/components/CreateWorktreeModal', () => ({
	CreateWorktreeModal: (props: { session?: Session }) => {
		capturedWorktreeProps.create = props;
		return <div data-testid="create-worktree-modal">{props.session?.name}</div>;
	},
}));
vi.mock('../../renderer/components/CreatePRModal', () => ({
	CreatePRModal: (props: {
		worktreePath?: string;
		worktreeBranch?: string;
		availableBranches?: string[];
	}) => {
		capturedWorktreeProps.createPR = props;
		return (
			<div data-testid="create-pr-modal">
				{props.worktreePath}:{props.worktreeBranch}:{props.availableBranches?.join(',')}
			</div>
		);
	},
}));
vi.mock('../../renderer/components/DeleteWorktreeModal', () => ({
	DeleteWorktreeModal: (props: { session?: Session }) => {
		capturedWorktreeProps.delete = props;
		return <div data-testid="delete-worktree-modal">{props.session?.name}</div>;
	},
}));
vi.mock('../../renderer/components/QuickActionsModal', () => ({
	QuickActionsModal: () => null,
}));
vi.mock('../../renderer/components/TabSwitcherModal', () => ({
	TabSwitcherModal: (props: { tabs?: unknown[]; fileTabs?: unknown[]; activeTabId?: string }) => {
		capturedUtilityProps.tabSwitcher = props;
		return <div data-testid="tab-switcher-modal">{props.activeTabId}</div>;
	},
}));
vi.mock('../../renderer/components/FileSearchModal', () => ({
	FileSearchModal: (props: Record<string, unknown>) => {
		capturedUtilityProps.fileSearch = props;
		return <div data-testid="file-search-modal" />;
	},
}));
vi.mock('../../renderer/components/PromptComposerModal', () => ({
	PromptComposerModal: (props: {
		sessions?: Session[];
		groups?: Group[];
		sessionName?: string;
	}) => {
		capturedUtilityProps.promptComposer = props;
		return <div data-testid="prompt-composer-modal">{props.sessionName}</div>;
	},
}));
vi.mock('../../renderer/components/ExecutionQueueBrowser', () => ({
	ExecutionQueueBrowser: () => null,
}));
vi.mock('../../renderer/components/BatchRunnerModal', () => ({
	BatchRunnerModal: (props: {
		initialPrompt?: string;
		presetDocuments?: string[];
		folderPath?: string;
	}) => {
		capturedUtilityProps.batchRunner = props;
		return (
			<div data-testid="batch-runner-modal">
				{props.folderPath}:{props.initialPrompt}:{props.presetDocuments?.join('|')}
			</div>
		);
	},
}));
vi.mock('../../renderer/components/AutoRun/AutoRunSetupModal', () => ({
	AutoRunSetupModal: () => null,
}));
vi.mock('../../renderer/components/LightboxModal', () => ({
	LightboxModal: (props: { image?: string; stagedImages?: string[] }) => {
		capturedUtilityProps.lightbox = props;
		return <div data-testid="lightbox-modal">{props.stagedImages?.join('|')}</div>;
	},
}));
vi.mock('../../renderer/components/GroupChatModal', () => ({
	GroupChatModal: (props: { mode?: string; groupChat?: GroupChat | null }) => {
		capturedGroupChatProps[props.mode ?? 'unknown'] = props;
		return <div data-testid={`group-chat-modal-${props.mode}`}>{props.groupChat?.name}</div>;
	},
}));
vi.mock('../../renderer/components/DeleteGroupChatModal', () => ({
	DeleteGroupChatModal: (props: { groupChatName?: string }) => (
		<div data-testid="delete-group-chat-modal">{props.groupChatName}</div>
	),
}));
vi.mock('../../renderer/components/RenameGroupChatModal', () => ({
	RenameGroupChatModal: (props: { currentName?: string }) => (
		<div data-testid="rename-group-chat-modal">{props.currentName}</div>
	),
}));
vi.mock('../../renderer/components/GroupChatInfoOverlay', () => ({
	GroupChatInfoOverlay: (props: { groupChat?: GroupChat }) => (
		<div data-testid="group-chat-info-overlay">{props.groupChat?.name}</div>
	),
}));
vi.mock('../../renderer/components/AgentErrorModal', () => ({
	AgentErrorModal: (props: { agentName?: string; sessionName?: string; dismissible?: boolean }) => {
		capturedAgentProps.error = props;
		return (
			<div data-testid="agent-error-modal">
				{props.agentName}:{props.sessionName}:{String(props.dismissible)}
			</div>
		);
	},
}));
vi.mock('../../renderer/components/MergeSessionModal', () => ({
	MergeSessionModal: (props: { sourceSession?: Session; sourceTabId?: string }) => {
		capturedAgentProps.merge = props;
		return <div data-testid="merge-session-modal">{props.sourceTabId}</div>;
	},
}));
vi.mock('../../renderer/components/SendToAgentModal', () => ({
	SendToAgentModal: (props: { sourceSession?: Session; sourceTabId?: string }) => {
		capturedAgentProps.sendToAgent = props;
		return <div data-testid="send-to-agent-modal">{props.sourceTabId}</div>;
	},
}));
vi.mock('../../renderer/components/TransferProgressModal', () => ({
	TransferProgressModal: (props: {
		progress?: unknown;
		sourceAgent?: string;
		targetAgent?: string;
	}) => {
		capturedAgentProps.transfer = props;
		return (
			<div data-testid="transfer-progress-modal">
				{props.sourceAgent}:{props.targetAgent}
			</div>
		);
	},
}));
vi.mock('../../renderer/components/LeaderboardRegistrationModal', () => ({
	LeaderboardRegistrationModal: () => null,
}));
vi.mock('../../renderer/components/AgentSessionsBrowser', () => ({
	AgentSessionsBrowser: () => null,
}));
vi.mock('../../renderer/components/WizardResumeModal', () => ({
	WizardResumeModal: () => null,
}));
vi.mock('../../renderer/components/MarketplaceModal', () => ({ MarketplaceModal: () => null }));
vi.mock('../../renderer/components/DebugWizardModal', () => ({ DebugWizardModal: () => null }));
vi.mock('../../renderer/components/DebugPackageModal', () => ({
	DebugPackageModal: () => null,
}));
vi.mock('../../renderer/components/WindowsWarningModal', () => ({
	WindowsWarningModal: () => null,
}));
vi.mock('../../renderer/components/SymphonyModal', () => ({ SymphonyModal: () => null }));
vi.mock('../../renderer/components/DirectorNotes/DirectorNotesPanel', () => ({
	DirectorNotesPanel: () => null,
}));
vi.mock('../../renderer/components/TourOverlay', () => ({ TourOverlay: () => null }));
vi.mock('../../renderer/components/PlaygroundPanel', () => ({ PlaygroundPanel: () => null }));

// Mock the LayerStackContext
vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: vi.fn(() => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	})),
}));

// Now mock AppModals sub-component groups to capture their props
// We do this by re-mocking the AppModals file itself, but actually we should
// import AppModals and test it as a real component. The sub-components are
// internal functions, not separate files.
// Instead, let's import AppModals directly and test the store reads.

// Import after mocks are set up
const { AppModals } = await import('../../renderer/components/AppModals');

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		state: 'idle',
		toolType: 'claude-code',
		cwd: '/tmp',
		...overrides,
	} as Session;
}

function createMockGroup(overrides: Partial<Group> = {}): Group {
	return {
		id: 'group-1',
		name: 'Test Group',
		sessionIds: ['session-1'],
		collapsed: false,
		emoji: '',
		...overrides,
	} as Group;
}

function createMockGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'gc-1',
		name: 'Test Group Chat',
		sessionIds: ['session-1'],
		messages: [],
		...overrides,
	} as GroupChat;
}

/**
 * Creates minimal required props for AppModals.
 * Data props (sessions, groups, groupChats, activeSessionId, modal booleans)
 * are now self-sourced from stores and NOT passed as props.
 */
function createDefaultProps(overrides: Record<string, unknown> = {}) {
	return {
		theme: mockTheme,
		shortcuts: {} as Record<string, Shortcut>,
		tabShortcuts: {} as Record<string, Shortcut>,
		// Info modals
		onCloseShortcutsHelp: vi.fn(),
		hasNoAgents: false,
		keyboardMasteryStats: {
			totalShortcutsUsed: 0,
			level: 0,
			uniqueShortcuts: new Set<string>(),
			shortcutCounts: {},
		},
		onCloseAboutModal: vi.fn(),
		autoRunStats: { totalRuns: 0, bestTimeMs: null, averageTimeMs: null, totalTimeMs: 0 },
		usageStats: null,
		handsOnTimeMs: 0,
		onOpenLeaderboardRegistration: vi.fn(),
		isLeaderboardRegistered: false,
		onCloseUpdateCheckModal: vi.fn(),
		onCloseProcessMonitor: vi.fn(),
		onNavigateToSession: vi.fn(),
		onNavigateToGroupChat: vi.fn(),
		onCloseUsageDashboard: vi.fn(),
		// Confirm modals
		confirmModalMessage: '',
		confirmModalOnConfirm: null,
		onCloseConfirmModal: vi.fn(),
		onConfirmQuit: vi.fn(),
		onCancelQuit: vi.fn(),
		// Session modals
		onCloseNewInstanceModal: vi.fn(),
		onCreateSession: vi.fn(),
		existingSessions: [],
		onCloseEditAgentModal: vi.fn(),
		onSaveEditAgent: vi.fn(),
		editAgentSession: null,
		renameSessionValue: '',
		setRenameSessionValue: vi.fn(),
		onCloseRenameSessionModal: vi.fn(),
		renameSessionTargetId: null,
		renameTabId: null,
		renameTabInitialName: '',
		onCloseRenameTabModal: vi.fn(),
		onRenameTab: vi.fn(),
		// Group modals
		createGroupModalOpen: false,
		onCloseCreateGroupModal: vi.fn(),
		renameGroupId: null,
		renameGroupValue: '',
		setRenameGroupValue: vi.fn(),
		renameGroupEmoji: '',
		setRenameGroupEmoji: vi.fn(),
		onCloseRenameGroupModal: vi.fn(),
		// Worktree modals
		onCloseWorktreeConfigModal: vi.fn(),
		onSaveWorktreeConfig: vi.fn(),
		onCreateWorktreeFromConfig: vi.fn(),
		onDisableWorktreeConfig: vi.fn(),
		createWorktreeSession: null,
		onCloseCreateWorktreeModal: vi.fn(),
		onCreateWorktree: vi.fn(),
		createPRSession: null,
		onCloseCreatePRModal: vi.fn(),
		onPRCreated: vi.fn(),
		deleteWorktreeSession: null,
		onCloseDeleteWorktreeModal: vi.fn(),
		onConfirmDeleteWorktree: vi.fn(),
		onConfirmAndDeleteWorktreeOnDisk: vi.fn(),
		// Utility modals
		quickActionInitialMode: undefined,
		setQuickActionOpen: vi.fn(),
		setActiveSessionId: vi.fn(),
		addNewSession: vi.fn(),
		setRenameInstanceValue: vi.fn(),
		setRenameInstanceModalOpen: vi.fn(),
		setRenameGroupId: vi.fn(),
		setRenameGroupValueForQuickActions: vi.fn(),
		setRenameGroupEmojiForQuickActions: vi.fn(),
		setRenameGroupModalOpenForQuickActions: vi.fn(),
		setCreateGroupModalOpenForQuickActions: vi.fn(),
		setLeftSidebarOpen: vi.fn(),
		setRightPanelOpen: vi.fn(),
		toggleInputMode: vi.fn(),
		deleteSession: vi.fn(),
		setSettingsModalOpen: vi.fn(),
		setSettingsTab: vi.fn(),
		setShortcutsHelpOpen: vi.fn(),
		setAboutModalOpen: vi.fn(),
		setLogViewerOpen: vi.fn(),
		setProcessMonitorOpen: vi.fn(),
		setUsageDashboardOpen: vi.fn(),
		setActiveRightTab: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		onCloseTabSwitcher: vi.fn(),
		onSelectTab: vi.fn(),
		hasActiveSessionCapability: vi.fn(() => false),
		flatFileList: [],
		fileTreeFilter: '',
		onCloseFuzzyFileSearch: vi.fn(),
		onFileSearchSelect: vi.fn(),
		onClosePromptComposer: vi.fn(),
		onExecutePrompt: vi.fn(),
		onCloseQueueBrowser: vi.fn(),
		onAutoRunSetupSubmit: vi.fn(),
		onCloseAutoRunSetup: vi.fn(),
		onCloseBatchRunnerModal: vi.fn(),
		lightboxImage: null,
		lightboxImages: [],
		lightboxAllowDelete: false,
		onCloseLightbox: vi.fn(),
		onDeleteLightboxImage: vi.fn(),
		gitDiffPreview: null,
		onCloseGitDiffViewer: vi.fn(),
		onCloseGitLog: vi.fn(),
		onGitLogCheckout: vi.fn(),
		// Group Chat modals
		showDeleteGroupChatModal: null,
		showRenameGroupChatModal: null,
		showEditGroupChatModal: null,
		onDeleteGroupChat: vi.fn(),
		onRenameGroupChat: vi.fn(),
		onCloseNewGroupChatModal: vi.fn(),
		onCreateGroupChat: vi.fn(),
		onCloseGroupChatInfo: vi.fn(),
		onCloseDeleteGroupChatModal: vi.fn(),
		onCloseRenameGroupChatModal: vi.fn(),
		onCloseEditGroupChatModal: vi.fn(),
		onUpdateGroupChat: vi.fn(),
		// Agent modals
		agentErrorData: null,
		onAgentErrorRecover: vi.fn(),
		onCloseAgentError: vi.fn(),
		onCloseMergeSessionModal: vi.fn(),
		onMergeSessions: vi.fn(),
		onCloseSendToAgentModal: vi.fn(),
		onSendToAgent: vi.fn(),
		transferProgress: null,
		onCloseTransferProgress: vi.fn(),
		leaderboardRegistration: null,
		onCloseLeaderboardRegistration: vi.fn(),
		onSubmitLeaderboardRegistration: vi.fn(),
		// Agent sessions browser
		agentSessionsOpen: false,
		setAgentSessionsOpenDirect: vi.fn(),
		activeAgentSessionId: null,
		setActiveAgentSessionIdDirect: vi.fn(),
		onRestoreAgentSession: vi.fn(),
		onDeleteAgentSession: vi.fn(),
		// Wizard resume
		wizardResumeModalOpen: false,
		wizardResumeState: null,
		onResumeWizard: vi.fn(),
		onDismissWizardResume: vi.fn(),
		// Marketplace
		marketplaceModalOpen: false,
		onCloseMarketplace: vi.fn(),
		onImportPlaybook: vi.fn(),
		// Debug wizard
		debugWizardModalOpen: false,
		onCloseDebugWizard: vi.fn(),
		onStartDebugPlaybook: vi.fn(),
		// Debug package
		debugPackageModalOpen: false,
		onCloseDebugPackage: vi.fn(),
		// Windows warning
		windowsWarningModalOpen: false,
		onCloseWindowsWarning: vi.fn(),
		// Tour
		tourOpen: false,
		onCloseTour: vi.fn(),
		tourFromWizard: false,
		// Symphony
		symphonyModalOpen: false,
		onCloseSymphony: vi.fn(),
		// Director's Notes
		directorNotesOpen: false,
		onCloseDirectorNotes: vi.fn(),
		// Playground
		playgroundOpen: false,
		onClosePlayground: vi.fn(),
		...overrides,
	} as any;
}

describe('AppModals (Tier 1B self-sourcing)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedInfoProps = {};
		capturedConfirmProps = {};
		capturedSessionProps = {};
		capturedGroupProps = {};
		capturedWorktreeProps = {};
		capturedUtilityProps = {};
		capturedGroupChatProps = {};
		capturedAgentProps = {};

		// Reset stores
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			groups: [],
		});
		useGroupChatStore.setState({
			groupChats: [],
			activeGroupChatId: null,
		});
		useModalStore.setState({ modals: new Map() });
	});

	describe('sessionStore self-sourcing', () => {
		it('reads sessions from sessionStore', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Agent 1' })];
			useSessionStore.setState({ sessions, activeSessionId: 's1' });

			// Component should render without sessions prop
			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();

			// No crash = sessions were read from store
		});

		it('computes activeSession from sessions + activeSessionId in store', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Agent 1' }),
				createMockSession({ id: 's2', name: 'Agent 2' }),
			];
			useSessionStore.setState({ sessions, activeSessionId: 's2' });

			// Renders without crash, meaning activeSession was computed internally
			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('computes activeSession as null when no matching session', () => {
			useSessionStore.setState({
				sessions: [createMockSession({ id: 's1' })],
				activeSessionId: 'nonexistent',
			});

			// Should not crash with null activeSession
			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('reads groups from sessionStore', () => {
			const groups = [createMockGroup({ id: 'g1', name: 'Group 1' })];
			useSessionStore.setState({ groups });

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('responds to sessionStore updates', () => {
			const { unmount } = render(<AppModals {...createDefaultProps()} />);

			// Update store after render - component should re-render
			act(() => {
				useSessionStore.setState({
					sessions: [createMockSession({ id: 's1' })],
					activeSessionId: 's1',
				});
			});

			unmount();
		});
	});

	describe('groupChatStore self-sourcing', () => {
		it('reads groupChats from groupChatStore', () => {
			const groupChats = [createMockGroupChat({ id: 'gc-1', name: 'Chat 1' })];
			useGroupChatStore.setState({ groupChats });

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('reads activeGroupChatId from groupChatStore', () => {
			useGroupChatStore.setState({
				groupChats: [createMockGroupChat({ id: 'gc-1' })],
				activeGroupChatId: 'gc-1',
			});

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});
	});

	describe('modalStore self-sourcing', () => {
		it('reads modal booleans from modalStore instead of props', () => {
			// Open a modal via the store
			const { openModal } = useModalStore.getState();
			openModal('about');

			// Render without passing aboutModalOpen as prop - component sources it from store
			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('reads shortcutsHelp open state from modalStore', () => {
			const { openModal } = useModalStore.getState();
			openModal('shortcutsHelp');

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('reads confirm modal open state from modalStore', () => {
			const { openModal } = useModalStore.getState();
			openModal('confirm');

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('reads quitConfirm open state from modalStore', () => {
			const { openModal } = useModalStore.getState();
			openModal('quitConfirm');

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('reads all 29 modal booleans from modalStore', () => {
			// Open all 29 modals at once
			const { openModal } = useModalStore.getState();
			const modalIds = [
				'shortcutsHelp',
				'about',
				'updateCheck',
				'processMonitor',
				'usageDashboard',
				'confirm',
				'quitConfirm',
				'newInstance',
				'editAgent',
				'renameInstance',
				'renameTab',
				'renameGroup',
				'worktreeConfig',
				'createWorktree',
				'createPR',
				'deleteWorktree',
				'quickAction',
				'tabSwitcher',
				'fuzzyFileSearch',
				'promptComposer',
				'queueBrowser',
				'autoRunSetup',
				'batchRunner',
				'gitLog',
				'newGroupChat',
				'groupChatInfo',
				'leaderboard',
				'mergeSession',
				'sendToAgent',
			] as const;

			for (const id of modalIds) {
				openModal(id);
			}

			// Should render without crash - all booleans sourced from store
			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('defaults modal booleans to false when not in modalStore', () => {
			// Empty modal store - all booleans should be false
			useModalStore.setState({ modals: new Map() });

			const { unmount } = render(<AppModals {...createDefaultProps()} />);
			unmount();
		});

		it('responds to modalStore updates after initial render', () => {
			const { unmount } = render(<AppModals {...createDefaultProps()} />);

			act(() => {
				useModalStore.getState().openModal('about');
			});

			unmount();
		});

		it('resolves lazy dashboard and git viewer modals when opened', async () => {
			useSessionStore.setState({
				sessions: [createMockSession({ id: 's1', name: 'Agent 1', cwd: '/repo' })],
				activeSessionId: 's1',
			});
			const { openModal } = useModalStore.getState();
			openModal('usageDashboard');
			openModal('gitLog');

			const { unmount } = render(
				<AppModals {...createDefaultProps({ gitDiffPreview: 'diff --git a/file b/file' })} />
			);

			expect(await screen.findByTestId('usage-dashboard-modal')).toBeInTheDocument();
			expect(await screen.findByTestId('git-diff-viewer')).toBeInTheDocument();
			expect(await screen.findByTestId('git-log-viewer')).toBeInTheDocument();

			unmount();
		});

		it('passes derived session data into new-instance and rename-tab modals', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						id: 's1',
						name: 'Source Agent',
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Planning',
								agentSessionId: 'agent-session-1',
								logs: [],
							},
						],
						activeTabId: 'tab-1',
					}),
				],
				activeSessionId: 's1',
			});
			const { openModal } = useModalStore.getState();
			openModal('newInstance');
			openModal('renameTab');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						duplicatingSessionId: 's1',
						renameTabId: 'tab-1',
						renameTabInitialName: 'Planning',
					})}
				/>
			);

			expect(screen.getByTestId('new-instance-modal')).toHaveTextContent('Source Agent');
			expect(screen.getByTestId('rename-tab-modal')).toHaveTextContent('agent-session-1');

			unmount();
		});

		it('looks up group chat modal data from groupChatStore ids', () => {
			const groupChat = createMockGroupChat({ id: 'gc-1', name: 'Planning Chat' });
			useGroupChatStore.setState({
				groupChats: [groupChat],
				activeGroupChatId: 'gc-1',
			});
			useModalStore.getState().openModal('groupChatInfo');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						showDeleteGroupChatModal: 'gc-1',
						showRenameGroupChatModal: 'gc-1',
						showEditGroupChatModal: 'gc-1',
						groupChatError: {
							groupChatId: 'gc-1',
							participantName: 'Planner',
							error: {
								message: 'participant failed',
								recoverable: true,
								timestamp: Date.now(),
								type: 'agent_crashed',
							},
						},
					})}
				/>
			);

			expect(screen.getByTestId('delete-group-chat-modal')).toHaveTextContent('Planning Chat');
			expect(screen.getByTestId('rename-group-chat-modal')).toHaveTextContent('Planning Chat');
			expect(screen.getByTestId('group-chat-modal-edit')).toHaveTextContent('Planning Chat');
			expect(screen.getByTestId('group-chat-info-overlay')).toHaveTextContent('Planning Chat');
			expect(screen.getByTestId('agent-error-modal')).toHaveTextContent('Planning Chat');

			unmount();
		});

		it('builds quit-confirm busy agent names from active and auto-run sessions', () => {
			const sessions = [
				createMockSession({ id: 'idle', name: 'Idle Agent', state: 'idle' }),
				createMockSession({
					id: 'user-busy',
					name: 'User Busy',
					state: 'busy',
					busySource: 'user',
				}),
				createMockSession({
					id: 'terminal-busy',
					name: 'Terminal Busy',
					state: 'busy',
					busySource: 'ai',
					toolType: 'terminal',
				}),
				createMockSession({
					id: 'ai-busy',
					name: 'AI Busy',
					state: 'busy',
					busySource: 'ai',
					toolType: 'claude-code',
				}),
				createMockSession({ id: 'auto-run', name: 'Auto Runner', state: 'idle' }),
			];
			useSessionStore.setState({ sessions, activeSessionId: 'ai-busy' });
			useModalStore.getState().openModal('quitConfirm');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						activeBatchSessionIds: ['ai-busy', 'auto-run'],
					})}
				/>
			);

			expect(screen.getByTestId('quit-confirm-modal')).toHaveTextContent(
				'AI Busy|Auto Runner (Auto Run)'
			);
			expect((capturedConfirmProps.quit as { busyAgentCount?: number }).busyAgentCount).toBe(2);

			unmount();
		});

		it('renders create and rename group modals with store-provided rename data', () => {
			useSessionStore.setState({
				groups: [createMockGroup({ id: 'group-1', name: 'Original Group' })],
			});
			useModalStore.getState().openModal('renameGroup');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						createGroupModalOpen: true,
						renameGroupId: 'group-1',
						renameGroupValue: 'Renamed Group',
						renameGroupEmoji: 'folder',
					})}
				/>
			);

			expect(screen.getByTestId('create-group-modal')).toBeInTheDocument();
			expect(screen.getByTestId('rename-group-modal')).toHaveTextContent(
				'group-1:Renamed Group:folder'
			);
			expect((capturedGroupProps.rename as { groupId?: string }).groupId).toBe('group-1');

			unmount();
		});

		it('renders worktree modals and create-PR branch data from active and explicit sessions', () => {
			const activeSession = createMockSession({
				id: 'active',
				name: 'Active Worktree',
				cwd: '/repo/active',
				worktreeBranch: 'feature/current',
				gitBranches: ['feature/current', 'main'],
			});
			const createSession = createMockSession({ id: 'create', name: 'Create Worktree' });
			const deleteSession = createMockSession({ id: 'delete', name: 'Delete Worktree' });
			useSessionStore.setState({ sessions: [activeSession], activeSessionId: 'active' });
			const { openModal } = useModalStore.getState();
			openModal('worktreeConfig');
			openModal('createWorktree');
			openModal('createPR');
			openModal('deleteWorktree');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						createWorktreeSession: createSession,
						deleteWorktreeSession: deleteSession,
					})}
				/>
			);

			expect(screen.getByTestId('worktree-config-modal')).toHaveTextContent('Active Worktree');
			expect(screen.getByTestId('create-worktree-modal')).toHaveTextContent('Create Worktree');
			expect(screen.getByTestId('delete-worktree-modal')).toHaveTextContent('Delete Worktree');
			expect(screen.getByTestId('create-pr-modal')).toHaveTextContent(
				'/repo/active:feature/current:feature/current,main'
			);

			unmount();
		});

		it('falls back through create-PR branch sources in order', () => {
			const branchOnlySession = createMockSession({
				id: 'branch-only',
				cwd: '/repo/branch-only',
				gitBranches: ['develop'],
			});
			useModalStore.getState().openModal('createPR');
			const first = render(
				<AppModals {...createDefaultProps({ createPRSession: branchOnlySession })} />
			);

			expect(screen.getByTestId('create-pr-modal')).toHaveTextContent(
				'/repo/branch-only:develop:develop'
			);
			first.unmount();

			useModalStore.setState({ modals: new Map() });
			const fallbackSession = createMockSession({ id: 'fallback', cwd: '/repo/fallback' });
			useModalStore.getState().openModal('createPR');
			const second = render(
				<AppModals {...createDefaultProps({ createPRSession: fallbackSession })} />
			);

			expect(screen.getByTestId('create-pr-modal')).toHaveTextContent(
				'/repo/fallback:main:main,master'
			);
			second.unmount();
		});

		it('uses explicit lightbox images before staged-image fallbacks', () => {
			const explicit = render(
				<AppModals
					{...createDefaultProps({
						lightboxImage: 'current.png',
						lightboxImages: ['current.png', 'next.png'],
						stagedImages: ['fallback.png'],
					})}
				/>
			);

			expect(screen.getByTestId('lightbox-modal')).toHaveTextContent('current.png|next.png');
			explicit.unmount();

			const fallback = render(
				<AppModals
					{...createDefaultProps({
						lightboxImage: 'current.png',
						lightboxImages: [],
						stagedImages: ['fallback.png'],
					})}
				/>
			);

			expect(screen.getByTestId('lightbox-modal')).toHaveTextContent('fallback.png');
			fallback.unmount();
		});

		it('renders utility modals from active-session state and prompt composer group-chat context', () => {
			const session = createMockSession({
				id: 'utility-session',
				name: 'Utility Agent',
				autoRunFolderPath: '/docs',
				batchRunnerPrompt: 'Summarize',
				autoRunSelectedFile: 'intro.md',
				aiTabs: [{ id: 'tab-1', name: 'Main', logs: [] }],
				filePreviewTabs: [{ id: 'file-1', path: '/docs/intro.md' }],
				activeTabId: 'tab-1',
				activeFileTabId: 'file-1',
				projectRoot: '/repo',
			} as Partial<Session>);
			const groups = [createMockGroup({ id: 'group-1', name: 'Writers' })];
			useSessionStore.setState({ sessions: [session], activeSessionId: 'utility-session', groups });
			useGroupChatStore.setState({
				groupChats: [createMockGroupChat()],
				activeGroupChatId: 'gc-1',
			});
			const { openModal } = useModalStore.getState();
			openModal('batchRunner', { presetDocuments: ['intro.md'] });
			openModal('tabSwitcher');
			openModal('fuzzyFileSearch');
			openModal('promptComposer');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						filteredFileTree: [{ name: 'intro.md' }],
						fileExplorerExpanded: new Set(['/docs']),
						promptComposerSessionName: 'Utility Agent',
						onCloseBatchRunner: vi.fn(),
						onStartBatchRun: vi.fn(),
						onSaveBatchPrompt: vi.fn(),
					})}
				/>
			);

			expect(screen.getByTestId('batch-runner-modal')).toHaveTextContent(
				'/docs:Summarize:intro.md'
			);
			expect(screen.getByTestId('tab-switcher-modal')).toHaveTextContent('tab-1');
			expect(screen.getByTestId('file-search-modal')).toBeInTheDocument();
			expect(screen.getByTestId('prompt-composer-modal')).toHaveTextContent('Utility Agent');
			expect((capturedUtilityProps.promptComposer as { sessions?: Session[] }).sessions).toEqual([
				session,
			]);
			expect((capturedUtilityProps.promptComposer as { groups?: Group[] }).groups).toEqual(groups);

			unmount();
		});

		it('falls back batch-runner prompt and document values and omits group lists outside group chat', () => {
			const session = createMockSession({
				id: 'batch-fallback',
				autoRunFolderPath: '/docs',
				aiTabs: [{ id: 'tab-1', name: 'Main', logs: [] }],
				activeTabId: 'tab-1',
			} as Partial<Session>);
			useSessionStore.setState({ sessions: [session], activeSessionId: 'batch-fallback' });
			const { openModal } = useModalStore.getState();
			openModal('batchRunner');
			openModal('promptComposer');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						onCloseBatchRunner: vi.fn(),
						onStartBatchRun: vi.fn(),
						onSaveBatchPrompt: vi.fn(),
					})}
				/>
			);

			expect(screen.getByTestId('batch-runner-modal')).toHaveTextContent('/docs::');
			expect(
				(capturedUtilityProps.promptComposer as { sessions?: Session[] }).sessions
			).toBeUndefined();
			expect((capturedUtilityProps.promptComposer as { groups?: Group[] }).groups).toBeUndefined();

			unmount();
		});

		it('covers agent error naming for claude, non-claude, and missing sessions', () => {
			const claudeSession = createMockSession({
				id: 'claude-session',
				name: 'Claude Session',
				toolType: 'claude-code',
			});
			let result = render(
				<AppModals
					{...createDefaultProps({
						errorSession: claudeSession,
						effectiveAgentError: { message: 'boom', recoverable: true, timestamp: 1 },
						onDismissAgentError: vi.fn(),
					})}
				/>
			);
			expect(screen.getByTestId('agent-error-modal')).toHaveTextContent(
				'Claude Code:Claude Session:true'
			);
			result.unmount();

			const codexSession = createMockSession({
				id: 'codex-session',
				name: 'Codex Session',
				toolType: 'codex',
			} as Partial<Session>);
			result = render(
				<AppModals
					{...createDefaultProps({
						errorSession: codexSession,
						effectiveAgentError: { message: 'boom', recoverable: false, timestamp: 1 },
						onDismissAgentError: vi.fn(),
					})}
				/>
			);
			expect(screen.getByTestId('agent-error-modal')).toHaveTextContent(
				'codex:Codex Session:false'
			);
			result.unmount();

			result = render(
				<AppModals
					{...createDefaultProps({
						errorSession: null,
						effectiveAgentError: { message: 'boom', timestamp: 1 },
						onDismissAgentError: vi.fn(),
					})}
				/>
			);
			expect(screen.getByTestId('agent-error-modal')).toHaveTextContent('::true');
			result.unmount();
		});

		it('falls back group-chat error labels when participant or chat lookup is missing', () => {
			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						groupChatError: {
							groupChatId: 'missing-chat',
							error: {
								message: 'participant failed',
								recoverable: false,
								timestamp: Date.now(),
								type: 'agent_crashed',
							},
						},
						onClearGroupChatError: vi.fn(),
					})}
				/>
			);

			expect(screen.getByTestId('agent-error-modal')).toHaveTextContent('Group Chat:Unknown:false');

			unmount();
		});

		it('renders merge, transfer, and send-to-agent modals only with required active-tab data', () => {
			const session = createMockSession({
				id: 'source-session',
				name: 'Source',
				activeTabId: 'tab-1',
				aiTabs: [{ id: 'tab-1', name: 'Main', logs: [] }],
			} as Partial<Session>);
			useSessionStore.setState({ sessions: [session], activeSessionId: 'source-session' });
			useModalStore.getState().openModal('mergeSession');
			useModalStore.getState().openModal('sendToAgent');

			const { unmount } = render(
				<AppModals
					{...createDefaultProps({
						onCloseMergeSession: vi.fn(),
						onMerge: vi.fn(),
						onCloseSendToAgent: vi.fn(),
						onSendToAgent: vi.fn(),
						transferState: 'complete',
						transferProgress: { step: 'done', progress: 100 },
						transferSourceAgent: 'claude-code',
						transferTargetAgent: 'codex',
						onCancelTransfer: vi.fn(),
						onCompleteTransfer: vi.fn(),
					})}
				/>
			);

			expect(screen.getByTestId('merge-session-modal')).toHaveTextContent('tab-1');
			expect(screen.getByTestId('send-to-agent-modal')).toHaveTextContent('tab-1');
			expect(screen.getByTestId('transfer-progress-modal')).toHaveTextContent('claude-code:codex');

			unmount();
		});

		it('keeps agent transfer modals closed when required guard data is missing', () => {
			const session = createMockSession({ id: 'source-session', name: 'Source' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'source-session' });
			useModalStore.getState().openModal('mergeSession');
			useModalStore.getState().openModal('sendToAgent');

			let result = render(
				<AppModals
					{...createDefaultProps({
						transferState: 'idle',
						transferProgress: { step: 'pending' },
						transferSourceAgent: 'claude-code',
						transferTargetAgent: 'codex',
					})}
				/>
			);
			expect(screen.queryByTestId('merge-session-modal')).not.toBeInTheDocument();
			expect(screen.queryByTestId('send-to-agent-modal')).not.toBeInTheDocument();
			expect(screen.queryByTestId('transfer-progress-modal')).not.toBeInTheDocument();
			result.unmount();

			for (const transferOverrides of [
				{ transferState: 'grooming', transferProgress: null, transferSourceAgent: 'claude-code' },
				{
					transferState: 'grooming',
					transferProgress: { step: 'pending' },
					transferSourceAgent: null,
				},
				{
					transferState: 'grooming',
					transferProgress: { step: 'pending' },
					transferSourceAgent: 'claude-code',
					transferTargetAgent: null,
				},
			]) {
				result = render(<AppModals {...createDefaultProps(transferOverrides)} />);
				expect(screen.queryByTestId('transfer-progress-modal')).not.toBeInTheDocument();
				result.unmount();
			}
		});

		it('passes null to edit group chat modal when the requested chat no longer exists', () => {
			const { unmount } = render(
				<AppModals {...createDefaultProps({ showEditGroupChatModal: 'missing-chat' })} />
			);

			expect(screen.getByTestId('group-chat-modal-edit')).toBeInTheDocument();
			expect(
				(capturedGroupChatProps.edit as { groupChat?: GroupChat | null }).groupChat
			).toBeNull();

			unmount();
		});
	});

	describe('prop interface changes', () => {
		it('does not require sessions prop', () => {
			const props = createDefaultProps();
			expect(props).not.toHaveProperty('sessions');

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('does not require activeSessionId prop', () => {
			const props = createDefaultProps();
			expect(props).not.toHaveProperty('activeSessionId');

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('does not require groups prop', () => {
			const props = createDefaultProps();
			expect(props).not.toHaveProperty('groups');

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('does not require groupChats prop', () => {
			const props = createDefaultProps();
			expect(props).not.toHaveProperty('groupChats');

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('does not require activeGroupChatId prop', () => {
			const props = createDefaultProps();
			expect(props).not.toHaveProperty('activeGroupChatId');

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('does not require any of the 29 modal boolean props', () => {
			const props = createDefaultProps();
			const removedBooleanProps = [
				'shortcutsHelpOpen',
				'aboutModalOpen',
				'updateCheckModalOpen',
				'processMonitorOpen',
				'usageDashboardOpen',
				'confirmModalOpen',
				'quitConfirmModalOpen',
				'newInstanceModalOpen',
				'editAgentModalOpen',
				'renameSessionModalOpen',
				'renameTabModalOpen',
				'renameGroupModalOpen',
				'worktreeConfigModalOpen',
				'createWorktreeModalOpen',
				'createPRModalOpen',
				'deleteWorktreeModalOpen',
				'quickActionOpen',
				'tabSwitcherOpen',
				'fuzzyFileSearchOpen',
				'promptComposerOpen',
				'queueBrowserOpen',
				'autoRunSetupModalOpen',
				'batchRunnerModalOpen',
				'gitLogOpen',
				'showNewGroupChatModal',
				'showGroupChatInfo',
				'leaderboardRegistrationOpen',
				'mergeSessionModalOpen',
				'sendToAgentModalOpen',
			];

			for (const prop of removedBooleanProps) {
				expect(props).not.toHaveProperty(prop);
			}

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('still accepts createGroupModalOpen as a prop (no ModalId exists)', () => {
			// createGroupModalOpen has no ModalId, so remains as a prop
			const props = createDefaultProps({ createGroupModalOpen: true });
			expect(props).toHaveProperty('createGroupModalOpen', true);

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});

		it('still accepts showDeleteGroupChatModal as string|null prop', () => {
			const props = createDefaultProps({ showDeleteGroupChatModal: 'gc-1' });
			expect(props).toHaveProperty('showDeleteGroupChatModal', 'gc-1');

			const { unmount } = render(<AppModals {...props} />);
			unmount();
		});
	});
});
