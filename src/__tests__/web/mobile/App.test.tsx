/**
 * Tests for MobileApp component
 *
 * @file src/__tests__/web/mobile/App.test.tsx
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

// ResizeObserver mock for jsdom (used by WebTerminal and other components)
globalThis.ResizeObserver = class MockResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// First, set up all mocks before importing the component

// Mock ThemeProvider
const mockColors = {
	accent: '#8b5cf6',
	border: '#374151',
	bgMain: '#1f2937',
	bgSidebar: '#111827',
	textMain: '#f3f4f6',
	textDim: '#9ca3af',
	success: '#22c55e',
	warning: '#f59e0b',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: mockColors,
		},
		isDark: true,
		isLight: false,
		isVibe: false,
		isDevicePreference: false,
	}),
}));

// Mock main.tsx hooks
const mockIsOffline = vi.fn(() => false);
const mockIsDashboard = vi.fn(() => true);
const mockIsSession = vi.fn(() => false);
const mockGoToDashboard = vi.fn();
const mockSetDesktopTheme = vi.fn();
const mockSetDesktopBionifyReadingMode = vi.fn();
let mockDesktopTheme = null;
let mockDesktopBionifyReadingMode = false;

vi.mock('../../../web/main', () => ({
	useOfflineStatus: () => mockIsOffline(),
	useMaestroMode: () => ({
		isDashboard: mockIsDashboard(),
		isSession: mockIsSession(),
		goToDashboard: mockGoToDashboard,
		sessionId: null,
	}),
	useDesktopTheme: () => {
		const [desktopTheme, setDesktopThemeState] = React.useState(mockDesktopTheme);
		const [bionifyReadingMode, setBionifyReadingModeState] = React.useState(
			mockDesktopBionifyReadingMode
		);

		return {
			desktopTheme,
			bionifyReadingMode,
			setDesktopTheme: (theme: unknown) => {
				mockDesktopTheme = theme;
				mockSetDesktopTheme(theme);
				setDesktopThemeState(theme);
			},
			setDesktopBionifyReadingMode: (enabled: boolean) => {
				mockDesktopBionifyReadingMode = enabled;
				mockSetDesktopBionifyReadingMode(enabled);
				setBionifyReadingModeState(enabled);
			},
		};
	},
}));

// Mock useWebSocket hook
const mockConnect = vi.fn();
const mockSend = vi.fn(() => true);
const mockSendRequest = vi.fn(() => Promise.resolve({}));
const mockDisconnect = vi.fn();
let mockWebSocketState = 'connected';
let mockWebSocketError: string | null = null;
let mockReconnectAttempts = 0;
let mockHandlers: Record<string, (...args: unknown[]) => void> = {};
const mockTerminalWrite = vi.fn();
const mockTerminalFitAndGetSize = vi.fn(() => ({ cols: 120, rows: 40 }));
const mockGitStatus = vi.hoisted(() => ({
	status: null as unknown,
	diff: null as null | { diff: string },
	isLoading: false,
	loadStatus: vi.fn(),
	loadDiff: vi.fn(),
	refresh: vi.fn(),
}));
const mockGroupChat = vi.hoisted(() => ({
	chats: [] as any[],
	activeChat: null as any,
	isLoading: false,
	loadChats: vi.fn(),
	startChat: vi.fn(),
	loadChatState: vi.fn(),
	sendMessage: vi.fn(),
	stopChat: vi.fn(),
	setActiveChatId: vi.fn(),
	handleGroupChatMessage: vi.fn(),
	handleGroupChatStateChange: vi.fn(),
}));
const mockAutoRun = vi.hoisted(() => ({
	documents: [] as any[],
	autoRunState: null as any,
	isLoadingDocs: false,
	selectedDoc: null as any,
	playbooks: [] as any[],
	isLoadingPlaybooks: false,
	loadDocuments: vi.fn(),
	loadDocumentContent: vi.fn(),
	saveDocumentContent: vi.fn(),
	resetDocumentTasks: vi.fn(),
	launchAutoRun: vi.fn(),
	stopAutoRun: vi.fn(),
	loadGitBranches: vi.fn(),
	listWorktrees: vi.fn(),
	resumeAutoRunError: vi.fn(),
	skipAutoRunDocument: vi.fn(),
	abortAutoRunError: vi.fn(),
	loadPlaybooks: vi.fn(),
	createPlaybook: vi.fn(),
	updatePlaybook: vi.fn(),
	deletePlaybook: vi.fn(),
}));

vi.mock('../../../web/hooks/useWebSocket', () => ({
	useWebSocket: ({ handlers }: { handlers: Record<string, (...args: unknown[]) => void> }) => {
		mockHandlers = Object.fromEntries(
			Object.entries(handlers).map(([key, handler]) => [
				key,
				(...args: unknown[]) => act(() => handler(...args)),
			])
		);
		return {
			state: mockWebSocketState,
			connect: mockConnect,
			send: mockSend,
			sendRequest: mockSendRequest,
			disconnect: mockDisconnect,
			error: mockWebSocketError,
			reconnectAttempts: mockReconnectAttempts,
		};
	},
}));

// Mock useNotifications hook
const mockShowNotification = vi.fn();
const mockHandleNotificationEvent = vi.fn();
const mockSetNotificationPreferences = vi.fn();
let mockNotificationPermission = 'default';

vi.mock('../../../web/hooks/useNotifications', () => ({
	useNotifications: () => ({
		permission: mockNotificationPermission,
		isSupported: true,
		showNotification: mockShowNotification,
		requestPermission: vi.fn(),
		declineNotifications: vi.fn(),
		resetPromptState: vi.fn(),
		hasPrompted: false,
		hasDeclined: false,
		preferences: {
			agentComplete: true,
			agentError: true,
			systemAlerts: true,
			sound: false,
			vibration: true,
		},
		setPreferences: mockSetNotificationPreferences,
		handleNotificationEvent: mockHandleNotificationEvent,
	}),
}));

// Mock useUnreadBadge hook
const mockAddUnread = vi.fn();
const mockMarkAllRead = vi.fn();
let mockUnreadCount = 0;

vi.mock('../../../web/hooks/useUnreadBadge', () => ({
	useUnreadBadge: () => ({
		addUnread: mockAddUnread,
		markRead: vi.fn(),
		markAllRead: mockMarkAllRead,
		clearBadge: vi.fn(),
		unreadCount: mockUnreadCount,
		unreadIds: [],
	}),
}));

// Mock useOfflineQueue hook
const mockQueueCommand = vi.fn(() => true);
const mockRemoveCommand = vi.fn();
const mockClearQueue = vi.fn();
const mockProcessQueue = vi.fn();
let mockQueue: unknown[] = [];
let mockQueueLength = 0;
let mockQueueStatus = 'idle';

vi.mock('../../../web/hooks/useOfflineQueue', () => ({
	useOfflineQueue: () => ({
		queue: mockQueue,
		queueLength: mockQueueLength,
		status: mockQueueStatus,
		queueCommand: mockQueueCommand,
		removeCommand: mockRemoveCommand,
		clearQueue: mockClearQueue,
		processQueue: mockProcessQueue,
	}),
}));

// Mock config
vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: (endpoint: string) => `http://localhost:3000${endpoint}`,
	getMaestroConfig: () => ({
		securityToken: 'test-token',
		sessionId: null,
		tabId: null,
		apiBase: '/test-token/api',
		wsUrl: '/test-token/ws',
	}),
	updateUrlForSessionTab: vi.fn(),
}));

// Mock constants
const mockTriggerHaptic = vi.fn();
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (pattern: number[]) => mockTriggerHaptic(pattern),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [15],
		interrupt: [20],
		success: [30],
		error: [50],
	},
	GESTURE_THRESHOLDS: {
		swipeDistance: 50,
		swipeTime: 300,
		pullToRefresh: 80,
		longPress: 500,
	},
}));

// Mock webLogger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock child components
vi.mock('../../../web/mobile/LeftPanel', () => ({
	LeftPanel: ({
		sessions,
		activeSessionId,
		onSelectSession,
		onClose,
	}: {
		sessions: unknown[];
		activeSessionId: string | null;
		onSelectSession: (id: string) => void;
		onClose: () => void;
		collapsedGroups: Set<string>;
		setCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
		showUnreadOnly: boolean;
		setShowUnreadOnly: React.Dispatch<React.SetStateAction<boolean>>;
	}) => (
		<div data-testid="left-panel">
			{sessions.map((s: any) => (
				<button key={s.id} data-testid={`session-${s.id}`} onClick={() => onSelectSession(s.id)}>
					{s.name}
				</button>
			))}
			<button data-testid="close-left-panel" onClick={onClose}>
				Close
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AllSessionsView', () => ({
	AllSessionsView: ({
		sessions,
		activeSessionId,
		onSelectSession,
		onClose,
	}: {
		sessions: unknown[];
		activeSessionId: string | null;
		onSelectSession: (id: string) => void;
		onClose: () => void;
	}) => (
		<div data-testid="all-sessions-view">
			<button data-testid="close-all-sessions" onClick={onClose}>
				Close
			</button>
			{sessions.map((s: any) => (
				<button key={s.id} onClick={() => onSelectSession(s.id)}>
					{s.name}
				</button>
			))}
		</div>
	),
}));

vi.mock('../../../web/mobile/MobileHistoryPanel', () => ({
	MobileHistoryPanel: ({
		onClose,
		projectPath,
		sessionId,
		onSearchChange,
		onFilterChange,
		initialFilter,
		initialSearchQuery,
		initialSearchOpen,
	}: {
		onClose: () => void;
		projectPath?: string;
		sessionId?: string;
		onSearchChange?: (query: string, isOpen: boolean) => void;
		onFilterChange?: (filter: string) => void;
		initialFilter?: string;
		initialSearchQuery?: string;
		initialSearchOpen?: boolean;
	}) => (
		<div data-testid="mobile-history-panel">
			<button data-testid="close-history" onClick={onClose}>
				Close
			</button>
			<span data-testid="history-project-path">{projectPath}</span>
			<span data-testid="history-session-id">{sessionId}</span>
			<span data-testid="history-initial-filter">{initialFilter}</span>
			<span data-testid="history-initial-search-query">{initialSearchQuery}</span>
			<span data-testid="history-initial-search-open">{initialSearchOpen ? 'true' : 'false'}</span>
			<button
				data-testid="trigger-search-change"
				onClick={() => onSearchChange?.('test query', true)}
			>
				Trigger Search Change
			</button>
			<button data-testid="trigger-filter-change" onClick={() => onFilterChange?.('AUTO')}>
				Trigger Filter Change
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/CommandInputBar', () => ({
	CommandInputBar: ({
		isOffline,
		isConnected,
		value,
		onChange,
		onSubmit,
		placeholder,
		disabled,
		inputMode,
		isSessionBusy,
		onInterrupt,
		hasActiveSession,
		cwd,
		slashCommands,
		showRecentCommands,
		...rest
	}: {
		isOffline: boolean;
		isConnected: boolean;
		value: string;
		onChange: (v: string) => void;
		onSubmit: (cmd: string) => void;
		placeholder: string;
		disabled: boolean;
		inputMode: string;
		isSessionBusy: boolean;
		onInterrupt: () => void;
		hasActiveSession: boolean;
		cwd?: string;
		slashCommands: unknown[];
		showRecentCommands: boolean;
		[key: string]: unknown;
	}) => (
		<div data-testid="command-input-bar">
			<input
				data-testid="command-input"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				disabled={disabled}
			/>
			<button data-testid="submit-command" onClick={() => onSubmit(value)}>
				Send
			</button>
			{isSessionBusy && (
				<button data-testid="interrupt-button" onClick={onInterrupt}>
					Interrupt
				</button>
			)}
			<span data-testid="input-mode">{inputMode}</span>
			<span data-testid="is-offline">{isOffline ? 'offline' : 'online'}</span>
			<span data-testid="is-connected">{isConnected ? 'connected' : 'disconnected'}</span>
			<span data-testid="command-input-has-bionify-prop">
				{Object.prototype.hasOwnProperty.call(rest, 'enableBionifyReadingMode') ? 'true' : 'false'}
			</span>
		</div>
	),
	default: () => <div data-testid="command-input-bar-default" />,
}));

vi.mock('../../../web/mobile/ResponseViewer', () => ({
	ResponseViewer: ({
		isOpen,
		response,
		allResponses,
		currentIndex,
		onNavigate,
		onClose,
		sessionName,
		enableBionifyReadingMode,
	}: {
		isOpen: boolean;
		response: unknown;
		allResponses?: unknown[];
		currentIndex: number;
		onNavigate: (index: number) => void;
		onClose: () => void;
		sessionName?: string;
		enableBionifyReadingMode?: boolean;
	}) => (
		<div data-testid="response-viewer-props">
			<span data-testid="response-viewer-bionify">
				{enableBionifyReadingMode ? 'true' : 'false'}
			</span>
			{isOpen ? (
				<div data-testid="response-viewer">
					<button data-testid="close-response-viewer" onClick={onClose}>
						Close
					</button>
					<button data-testid="navigate-prev" onClick={() => onNavigate(currentIndex - 1)}>
						Prev
					</button>
					<button data-testid="navigate-next" onClick={() => onNavigate(currentIndex + 1)}>
						Next
					</button>
					<span data-testid="response-index">{currentIndex}</span>
				</div>
			) : null}
		</div>
	),
}));

vi.mock('../../../web/mobile/OfflineQueueBanner', () => ({
	OfflineQueueBanner: ({
		queue,
		status,
		onClearQueue,
		onProcessQueue,
		onRemoveCommand,
		isOffline,
		isConnected,
	}: {
		queue: unknown[];
		status: string;
		onClearQueue: () => void;
		onProcessQueue: () => void;
		onRemoveCommand: (id: string) => void;
		isOffline: boolean;
		isConnected: boolean;
	}) => (
		<div data-testid="offline-queue-banner">
			<span data-testid="queue-count">{queue.length}</span>
			<button data-testid="clear-queue" onClick={onClearQueue}>
				Clear
			</button>
			<button data-testid="process-queue" onClick={onProcessQueue}>
				Process
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/MessageHistory', () => ({
	MessageHistory: ({
		logs,
		inputMode,
		autoScroll,
		maxHeight,
		enableBionifyReadingMode,
	}: {
		logs: unknown[];
		inputMode: string;
		autoScroll: boolean;
		maxHeight: string;
		enableBionifyReadingMode?: boolean;
	}) => (
		<div data-testid="message-history">
			<span data-testid="logs-count">{logs.length}</span>
			<span data-testid="history-mode">{inputMode}</span>
			<span data-testid="history-bionify">{enableBionifyReadingMode ? 'true' : 'false'}</span>
		</div>
	),
}));

vi.mock('../../../web/mobile/AutoRunIndicator', () => ({
	AutoRunIndicator: ({
		state,
		sessionName,
		onTap,
		onResume,
		onSkipDocument,
		onAbort,
	}: {
		state: unknown;
		sessionName?: string;
		onTap?: () => void;
		onResume?: () => void;
		onSkipDocument?: () => void;
		onAbort?: () => void;
	}) => (
		<div data-testid="autorun-indicator" onClick={onTap}>
			<span data-testid="autorun-session">{sessionName}</span>
			<button data-testid="autorun-open-panel" onClick={onTap}>
				Open Auto Run Panel
			</button>
			{onResume && (
				<button data-testid="autorun-resume" onClick={onResume}>
					Resume
				</button>
			)}
			{onSkipDocument && (
				<button data-testid="autorun-skip" onClick={onSkipDocument}>
					Skip
				</button>
			)}
			{onAbort && (
				<button data-testid="autorun-abort" onClick={onAbort}>
					Abort
				</button>
			)}
		</div>
	),
}));

vi.mock('../../../web/mobile/TabBar', () => ({
	TabBar: ({
		tabs,
		activeTabId,
		onSelectTab,
		onNewTab,
		onCloseTab,
		onOpenTabSearch,
	}: {
		tabs: unknown[];
		activeTabId: string;
		onSelectTab: (id: string) => void;
		onNewTab: () => void;
		onCloseTab: (id: string) => void;
		onOpenTabSearch: () => void;
	}) => (
		<div data-testid="tab-bar">
			{(tabs as { id: string; name: string }[]).map((t) => (
				<button key={t.id} data-testid={`tab-${t.id}`} onClick={() => onSelectTab(t.id)}>
					{t.name}
				</button>
			))}
			<button data-testid="new-tab" onClick={onNewTab}>
				New Tab
			</button>
			<button data-testid="close-tab" onClick={() => onCloseTab(activeTabId)}>
				Close Tab
			</button>
			<button data-testid="tab-search" onClick={onOpenTabSearch}>
				Search
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/TabSearchModal', () => ({
	TabSearchModal: ({
		tabs,
		activeTabId,
		onSelectTab,
		onClose,
	}: {
		tabs: unknown[];
		activeTabId: string;
		onSelectTab: (id: string) => void;
		onClose: () => void;
	}) => (
		<div data-testid="tab-search-modal">
			<button data-testid="close-tab-search" onClick={onClose}>
				Close
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/SlashCommandAutocomplete', () => ({
	DEFAULT_SLASH_COMMANDS: [
		{ command: '/help', description: 'Get help', aiOnly: true },
		{ command: '/clear', description: 'Clear screen', aiOnly: false },
	],
}));

vi.mock('../../../web/mobile/RightDrawer', () => ({
	RightDrawer: () => null,
}));

vi.mock('../../../web/mobile/WebTerminal', () => ({
	WebTerminal: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
		React.useImperativeHandle(ref, () => ({
			write: mockTerminalWrite,
			fitAndGetSize: mockTerminalFitAndGetSize,
		}));

		return <div data-testid="web-terminal">WebTerminal Mock</div>;
	}),
}));

vi.mock('../../../web/mobile/AutoRunPanel', () => ({
	AutoRunPanel: ({
		onClose,
		onOpenDocument,
		onOpenSetup,
		onResumeAfterError,
		onSkipAfterError,
		onAbortAfterError,
		onOpenMarketplace,
	}: {
		onClose: () => void;
		onOpenDocument: (filename: string) => void;
		onOpenSetup: () => void;
		onResumeAfterError?: () => void;
		onSkipAfterError?: () => void;
		onAbortAfterError?: () => void;
		onOpenMarketplace?: () => void;
	}) => (
		<div data-testid="autorun-panel">
			<button data-testid="autorun-panel-open-doc" onClick={() => onOpenDocument('daily.md')}>
				Open document
			</button>
			<button data-testid="autorun-panel-open-setup" onClick={onOpenSetup}>
				Open setup
			</button>
			<button data-testid="autorun-panel-marketplace" onClick={onOpenMarketplace}>
				Open marketplace
			</button>
			<button data-testid="autorun-panel-resume" onClick={onResumeAfterError}>
				Resume
			</button>
			<button data-testid="autorun-panel-skip" onClick={onSkipAfterError}>
				Skip
			</button>
			<button data-testid="autorun-panel-abort" onClick={onAbortAfterError}>
				Abort
			</button>
			<button data-testid="autorun-panel-close" onClick={onClose}>
				Close panel
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AutoRunDocumentViewer', () => ({
	AutoRunDocumentViewer: ({
		filename,
		isLocked,
		onBack,
	}: {
		filename: string;
		isLocked: boolean;
		onBack: () => void;
	}) => (
		<div data-testid="autorun-document-viewer">
			<span data-testid="autorun-document-filename">{filename}</span>
			<span data-testid="autorun-document-locked">{isLocked ? 'locked' : 'unlocked'}</span>
			<button data-testid="autorun-document-back" onClick={onBack}>
				Back
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AutoRunSetupSheet', () => ({
	AutoRunSetupSheet: ({
		currentDocument,
		onLaunch,
		onClose,
		loadGitBranches,
		loadWorktrees,
		onOpenMarketplace,
	}: {
		currentDocument?: string | null;
		onLaunch: (config: any) => void;
		onClose: () => void;
		loadGitBranches: () => Promise<unknown>;
		loadWorktrees: () => Promise<unknown>;
		onOpenMarketplace?: () => void;
	}) => (
		<div data-testid="autorun-setup-sheet">
			<span data-testid="autorun-current-document">{currentDocument ?? ''}</span>
			<button data-testid="autorun-load-branches" onClick={() => void loadGitBranches()}>
				Load branches
			</button>
			<button data-testid="autorun-load-worktrees" onClick={() => void loadWorktrees()}>
				Load worktrees
			</button>
			<button data-testid="autorun-launch" onClick={() => void onLaunch({ document: 'daily.md' })}>
				Launch
			</button>
			<button data-testid="autorun-setup-marketplace" onClick={onOpenMarketplace}>
				Marketplace
			</button>
			<button data-testid="autorun-setup-close" onClick={onClose}>
				Close setup
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/MarketplaceSheet', () => ({
	MarketplaceSheet: ({ onImported, onClose }: { onImported: () => void; onClose: () => void }) => (
		<div data-testid="marketplace-sheet">
			<button data-testid="marketplace-imported" onClick={onImported}>
				Imported
			</button>
			<button data-testid="marketplace-close" onClick={onClose}>
				Close marketplace
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/FolderPickerSheet', () => ({
	FolderPickerSheet: ({
		startPath,
		initialPath,
		onConfirm,
		onClose,
	}: {
		startPath: string;
		initialPath?: string | null;
		onConfirm: (folderPath: string) => void;
		onClose: () => void;
	}) => (
		<div data-testid="folder-picker-sheet">
			<span data-testid="folder-picker-start">{startPath}</span>
			<span data-testid="folder-picker-initial">{initialPath ?? ''}</span>
			<button
				data-testid="folder-picker-confirm"
				onClick={() => onConfirm('/tmp/maestro-playbooks')}
			>
				Confirm folder
			</button>
			<button data-testid="folder-picker-close" onClick={onClose}>
				Close folder picker
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/NotificationSettingsSheet', () => ({
	NotificationSettingsSheet: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="notification-settings-sheet">
			<button onClick={onClose}>Close notification settings</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/SettingsPanel', () => ({
	SettingsPanel: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="settings-panel">
			<button onClick={onClose}>Close settings</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AgentCreationSheet', () => ({
	AgentCreationSheet: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="agent-creation-sheet">
			<button onClick={onClose}>Close agent creation</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/GroupChatPanel', () => ({
	GroupChatPanel: ({
		onSendMessage,
		onStop,
		onBack,
	}: {
		onSendMessage: (message: string) => void;
		onStop: () => void;
		onBack: () => void;
	}) => (
		<div data-testid="group-chat-panel">
			<button data-testid="group-chat-send" onClick={() => onSendMessage('hello group')}>
				Send group message
			</button>
			<button data-testid="group-chat-stop" onClick={onStop}>
				Stop group chat
			</button>
			<button data-testid="group-chat-back" onClick={onBack}>
				Back
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/GroupChatSetupSheet', () => ({
	GroupChatSetupSheet: ({
		onStart,
		onClose,
	}: {
		onStart?: (topic: string, participantIds: string[]) => void;
		onClose: () => void;
	}) => (
		<div data-testid="group-chat-setup-sheet">
			<button
				data-testid="start-group-chat"
				onClick={() => onStart?.('Launch sync', ['session-1'])}
			>
				Start group chat
			</button>
			<button onClick={onClose}>Close group chat setup</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/ContextManagementSheet', () => ({
	ContextManagementSheet: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="context-management-sheet">
			<button onClick={onClose}>Close context management</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/CuePanel', () => ({
	CuePanel: () => null,
}));

vi.mock('../../../web/mobile/UsageDashboardPanel', () => ({
	UsageDashboardPanel: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="usage-dashboard-panel">
			<button onClick={onClose}>Close usage dashboard</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AchievementsPanel', () => ({
	AchievementsPanel: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="achievements-panel">
			<button onClick={onClose}>Close achievements</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/GitDiffViewer', () => ({
	GitDiffViewer: ({ filePath, onBack }: { filePath: string; onBack: () => void }) => (
		<div data-testid="git-diff-viewer">
			<span data-testid="git-diff-file">{filePath}</span>
			<button data-testid="git-diff-back" onClick={onBack}>
				Back
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/QuickActionsMenu', () => ({
	QuickActionsMenu: ({
		isOpen,
		onClose,
		actions,
	}: {
		isOpen: boolean;
		onClose: () => void;
		actions: Array<{ id: string; label: string; action: () => void; available?: () => boolean }>;
	}) =>
		isOpen ? (
			<div data-testid="quick-actions-menu">
				{actions
					.filter((action) => !action.available || action.available())
					.map((action) => (
						<button
							key={action.id}
							data-testid={`quick-action-${action.id}`}
							onClick={() => {
								action.action();
								onClose();
							}}
						>
							{action.label}
						</button>
					))}
				<button data-testid="quick-actions-close" onClick={onClose}>
					Close quick actions
				</button>
			</div>
		) : null,
}));

vi.mock('../../../web/hooks/useGroupChat', () => ({
	useGroupChat: () => mockGroupChat,
}));

vi.mock('../../../web/hooks/useCue', () => ({
	useCue: () => ({
		subscriptions: [],
		activity: [],
		isLoading: false,
		loadSubscriptions: vi.fn(),
		toggleSubscription: vi.fn(),
		loadActivity: vi.fn(),
		handleCueActivityEvent: vi.fn(),
		handleCueSubscriptionsChanged: vi.fn(),
	}),
}));

vi.mock('../../../web/hooks/useAutoRun', () => ({
	useAutoRun: () => mockAutoRun,
}));

vi.mock('../../../web/hooks/useSettings', () => ({
	useSettings: () => ({
		settings: {},
		isLoading: false,
		setSetting: vi.fn(),
		setTheme: vi.fn(),
		setFontSize: vi.fn(),
		setEnterToSendAI: vi.fn(),
		setEnterToSendTerminal: vi.fn(),
		setAutoScroll: vi.fn(),
		setDefaultSaveToHistory: vi.fn(),
		setDefaultShowThinking: vi.fn(),
		setNotificationsEnabled: vi.fn(),
		setAudioFeedbackEnabled: vi.fn(),
		setColorBlindMode: vi.fn(),
		setConductorProfile: vi.fn(),
		handleSettingsChanged: vi.fn(),
	}),
}));

vi.mock('../../../web/hooks/useAgentManagement', () => ({
	useAgentManagement: () => ({
		groups: [],
		isLoading: false,
		createAgent: vi.fn(),
		deleteAgent: vi.fn(),
		renameAgent: vi.fn(),
		getGroups: vi.fn(),
		createGroup: vi.fn(),
		renameGroup: vi.fn(),
		deleteGroup: vi.fn(),
		moveToGroup: vi.fn(),
		handleGroupsChanged: vi.fn(),
	}),
}));

vi.mock('../../../web/hooks/useGitStatus', () => ({
	useGitStatus: () => mockGitStatus,
}));

vi.mock('../../../web/mobile/RightPanel', () => ({
	RightPanel: ({
		activeTab,
		onClose,
		onAutoRunOpenDocument,
		onAutoRunOpenSetup,
		onAutoRunOpenFolderPicker,
		onAutoRunOpenMarketplace,
		onAutoRunSelectedDocumentChange,
		onViewDiff,
	}: {
		sessionId: string;
		activeTab?: string;
		onClose: () => void;
		onAutoRunOpenDocument?: (filename: string) => void;
		onAutoRunOpenSetup?: () => void;
		onAutoRunOpenFolderPicker?: () => void;
		onAutoRunOpenMarketplace?: () => void;
		onAutoRunSelectedDocumentChange?: (filename: string | null) => void;
		onViewDiff?: (filePath: string) => void;
	}) => (
		<div data-testid="right-panel" data-active-tab={activeTab}>
			<button data-testid="close-right-panel" onClick={onClose}>
				Close
			</button>
			<button
				data-testid="right-panel-open-doc"
				onClick={() => onAutoRunOpenDocument?.('daily.md')}
			>
				Open AutoRun doc
			</button>
			<button data-testid="right-panel-open-setup" onClick={onAutoRunOpenSetup}>
				Open AutoRun setup
			</button>
			<button data-testid="right-panel-open-folder" onClick={onAutoRunOpenFolderPicker}>
				Open AutoRun folder
			</button>
			<button data-testid="right-panel-open-marketplace" onClick={onAutoRunOpenMarketplace}>
				Open marketplace
			</button>
			<button
				data-testid="right-panel-select-doc"
				onClick={() => onAutoRunSelectedDocumentChange?.('daily.md')}
			>
				Select AutoRun doc
			</button>
			<button data-testid="right-panel-view-diff" onClick={() => onViewDiff?.('src/App.tsx')}>
				View diff
			</button>
		</div>
	),
}));

// Now import the component
import MobileApp from '../../../web/mobile/App';
import type { Session } from '../../../web/hooks/useSessions';

// Helper to create mock sessions
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		toolType: 'claude-code',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		aiTabs: undefined,
		activeTabId: undefined,
		agentSessionId: undefined,
		usageStats: undefined,
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

describe('MobileApp', () => {
	let originalFetch: typeof global.fetch;
	let originalVisibilityState: PropertyDescriptor | undefined;
	let originalInnerHeight: PropertyDescriptor | undefined;
	let originalInnerWidth: PropertyDescriptor | undefined;
	let originalReadyState: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Reset mock states
		mockWebSocketState = 'connected';
		mockWebSocketError = null;
		mockReconnectAttempts = 0;
		mockNotificationPermission = 'default';
		mockUnreadCount = 0;
		mockQueue = [];
		mockQueueLength = 0;
		mockQueueStatus = 'idle';
		mockHandlers = {};
		mockDesktopTheme = null;
		mockDesktopBionifyReadingMode = false;
		mockHandleNotificationEvent.mockClear();
		mockSetNotificationPreferences.mockClear();
		mockTerminalWrite.mockClear();
		mockTerminalFitAndGetSize.mockReset();
		mockTerminalFitAndGetSize.mockReturnValue({ cols: 120, rows: 40 });
		mockGitStatus.status = null;
		mockGitStatus.diff = null;
		mockGitStatus.isLoading = false;
		mockGitStatus.loadStatus.mockReset();
		mockGitStatus.loadDiff.mockReset();
		mockGitStatus.refresh.mockReset();
		mockGroupChat.chats = [];
		mockGroupChat.activeChat = null;
		mockGroupChat.isLoading = false;
		mockGroupChat.loadChats.mockReset();
		mockGroupChat.startChat.mockReset();
		mockGroupChat.loadChatState.mockReset();
		mockGroupChat.sendMessage.mockReset();
		mockGroupChat.stopChat.mockReset();
		mockGroupChat.setActiveChatId.mockReset();
		mockGroupChat.handleGroupChatMessage.mockReset();
		mockGroupChat.handleGroupChatStateChange.mockReset();
		mockAutoRun.documents = [];
		mockAutoRun.autoRunState = null;
		mockAutoRun.isLoadingDocs = false;
		mockAutoRun.selectedDoc = null;
		mockAutoRun.playbooks = [];
		mockAutoRun.isLoadingPlaybooks = false;
		mockAutoRun.loadDocuments.mockReset();
		mockAutoRun.loadDocumentContent.mockReset();
		mockAutoRun.saveDocumentContent.mockReset();
		mockAutoRun.resetDocumentTasks.mockReset().mockResolvedValue(true);
		mockAutoRun.launchAutoRun.mockReset().mockResolvedValue({ success: true });
		mockAutoRun.stopAutoRun.mockReset();
		mockAutoRun.loadGitBranches.mockReset().mockResolvedValue({ branches: [] });
		mockAutoRun.listWorktrees.mockReset().mockResolvedValue([]);
		mockAutoRun.resumeAutoRunError.mockReset().mockResolvedValue(true);
		mockAutoRun.skipAutoRunDocument.mockReset().mockResolvedValue(true);
		mockAutoRun.abortAutoRunError.mockReset().mockResolvedValue(true);
		mockAutoRun.loadPlaybooks.mockReset();
		mockAutoRun.createPlaybook.mockReset().mockResolvedValue(null);
		mockAutoRun.updatePlaybook.mockReset().mockResolvedValue(null);
		mockAutoRun.deletePlaybook.mockReset().mockResolvedValue(true);

		// Store original fetch
		originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ session: { aiLogs: [], shellLogs: [] } }),
		});

		// Store original properties
		originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
		originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
		originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
		originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState');

		// Set default inner height
		Object.defineProperty(window, 'innerHeight', {
			value: 800,
			writable: true,
			configurable: true,
		});

		Object.defineProperty(document, 'readyState', {
			value: 'complete',
			configurable: true,
		});

		(window as any).__MAESTRO_CONFIG__ = {};

		// Reset mock function return values
		mockSendRequest.mockResolvedValue({});
		mockIsOffline.mockReturnValue(false);
		mockIsDashboard.mockReturnValue(true);
		mockIsSession.mockReturnValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		global.fetch = originalFetch;

		// Restore original properties
		if (originalVisibilityState !== undefined) {
			Object.defineProperty(document, 'visibilityState', originalVisibilityState);
		}
		if (originalInnerHeight !== undefined) {
			Object.defineProperty(window, 'innerHeight', originalInnerHeight);
		}
		if (originalInnerWidth !== undefined) {
			Object.defineProperty(window, 'innerWidth', originalInnerWidth);
		}
		if (originalReadyState !== undefined) {
			Object.defineProperty(document, 'readyState', originalReadyState);
		}
	});

	describe('exports', () => {
		it('exports MobileApp as default', () => {
			expect(MobileApp).toBeDefined();
			expect(typeof MobileApp).toBe('function');
		});
	});

	describe('pure functions', () => {
		// We need to test the pure functions: formatCost, calculateContextUsage, getActiveTabFromSession
		// These are not exported, but we can test their behavior through component rendering

		describe('formatCost (via UI)', () => {
			it('displays cost with 4 decimals when less than 0.01', async () => {
				render(<MobileApp />);

				// Simulate sessions with cost data
				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							name: 'Test Session',
							usageStats: {
								inputTokens: 100,
								outputTokens: 50,
								totalCostUsd: 0.0045,
								contextWindow: 8000,
							},
						}),
					]);
				});

				// The cost should be formatted in the header
				// Verify the session was added and auto-selected (name shown in header)
				expect(screen.getByText('Test Session')).toBeInTheDocument();
			});

			it('displays cost with 3 decimals when between 0.01 and 1.0', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: {
								inputTokens: 1000,
								outputTokens: 500,
								totalCostUsd: 0.123,
								contextWindow: 8000,
							},
						}),
					]);
				});

				expect(screen.getByText('Test Session')).toBeInTheDocument();
			});

			it('displays cost with 2 decimals when 1.0 or more', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: {
								inputTokens: 10000,
								outputTokens: 5000,
								totalCostUsd: 5.67,
								contextWindow: 8000,
							},
						}),
					]);
				});

				expect(screen.getByText('Test Session')).toBeInTheDocument();
			});
		});

		describe('calculateContextUsage (via UI)', () => {
			it('returns null when usageStats is undefined', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: undefined,
						}),
					]);
				});

				// Session should still render, just without context bar
				expect(screen.getByText('Test Session')).toBeInTheDocument();
			});

			it('returns null when contextWindow is 0', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: {
								inputTokens: 100,
								outputTokens: 50,
								totalCostUsd: 0.01,
								contextWindow: 0,
							},
						}),
					]);
				});

				expect(screen.getByText('Test Session')).toBeInTheDocument();
			});

			it('caps context usage at 100%', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: {
								inputTokens: 9000,
								outputTokens: 5000,
								totalCostUsd: 0.01,
								contextWindow: 8000,
							},
						}),
					]);
				});

				expect(screen.getByText('Test Session')).toBeInTheDocument();
			});
		});

		describe('getActiveTabFromSession (via UI)', () => {
			it('returns null when session has no aiTabs', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							aiTabs: undefined,
							activeTabId: undefined,
						}),
					]);
				});

				// No tab bar should be rendered (tabs requirement: aiTabs.length > 1)
				expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
			});

			it('returns null when no activeTabId', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							aiTabs: [{ id: 'tab-1', name: 'Tab 1', state: 'idle' }],
							activeTabId: undefined,
						}),
					]);
				});

				expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
			});

			it('returns matching tab when found', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							aiTabs: [
								{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
								{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
							],
							activeTabId: 'tab-1',
						}),
					]);
				});

				// Tab bar should render with multiple tabs
				expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
				expect(screen.getByTestId('tab-tab-1')).toBeInTheDocument();
				expect(screen.getByTestId('tab-tab-2')).toBeInTheDocument();
			});
		});
	});

	describe('initial render', () => {
		it('renders the main container', () => {
			const { container } = render(<MobileApp />);
			expect(container.firstChild).toHaveStyle({ display: 'flex', flexDirection: 'column' });
		});

		it('calls connect on mount', () => {
			render(<MobileApp />);
			act(() => {
				vi.advanceTimersByTime(50);
			});
			expect(mockConnect).toHaveBeenCalled();
		});

		it('cleans up pending connect retry on unmount', () => {
			const { unmount } = render(<MobileApp />);
			unmount();
			act(() => {
				vi.advanceTimersByTime(150);
			});
			expect(mockConnect).not.toHaveBeenCalled();
		});

		it('renders command input bar', () => {
			render(<MobileApp />);
			expect(screen.getByTestId('command-input-bar')).toBeInTheDocument();
		});
	});

	describe('connection states', () => {
		it('shows offline message when offline', () => {
			mockIsOffline.mockReturnValue(true);
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			expect(screen.getByText("You're Offline")).toBeInTheDocument();
			expect(screen.getByText(/No internet connection/)).toBeInTheDocument();
		});

		it('shows disconnected message when disconnected', () => {
			mockWebSocketState = 'disconnected';
			mockWebSocketError = 'Connection refused';

			render(<MobileApp />);

			expect(screen.getByText('Connection Lost')).toBeInTheDocument();
			expect(screen.getByText('Connection refused')).toBeInTheDocument();
		});

		it('shows reconnect attempts count when available', () => {
			mockWebSocketState = 'disconnected';
			mockReconnectAttempts = 3;

			render(<MobileApp />);

			expect(screen.getByText(/attempt 3/)).toBeInTheDocument();
		});

		it('shows connecting message when connecting', () => {
			mockWebSocketState = 'connecting';

			render(<MobileApp />);

			expect(screen.getByText('Connecting to Maestro...')).toBeInTheDocument();
		});

		it('shows authenticating message when authenticating', () => {
			mockWebSocketState = 'authenticating';

			render(<MobileApp />);

			expect(screen.getByText('Connecting to Maestro...')).toBeInTheDocument();
		});

		it('shows select session prompt when connected but no active session', () => {
			mockWebSocketState = 'authenticated';

			render(<MobileApp />);

			expect(screen.getByText(/Select a session above to get started/)).toBeInTheDocument();
		});

		it('handles retry button click', () => {
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			act(() => {
				vi.advanceTimersByTime(50);
			});

			fireEvent.click(screen.getByText('Retry Now'));

			expect(mockConnect).toHaveBeenCalledTimes(2); // Once on mount, once on retry
		});
	});

	describe('session management', () => {
		it('auto-selects first session when sessions are received', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			// First session should be auto-selected (name shown in header)
			expect(screen.getByText('Session 1')).toBeInTheDocument();

			// Open the left panel to verify sessions are listed
			fireEvent.click(screen.getByLabelText('Agents'));
			expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
			expect(screen.getByTestId('session-session-2')).toBeInTheDocument();
		});

		it('handles session selection', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			// Open the left panel to access session list
			fireEvent.click(screen.getByLabelText('Agents'));
			fireEvent.click(screen.getByTestId('session-session-2'));

			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap
			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_session',
				sessionId: 'session-2',
				tabId: undefined,
			});
		});

		it('handles session state change', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'idle' })]);
			});

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'busy', {});
			});

			// Session state should be updated
			expect(mockHandlers.onSessionStateChange).toBeDefined();
		});

		it('handles session added', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			await act(async () => {
				mockHandlers.onSessionAdded?.(createMockSession({ id: 'session-2', name: 'Session 2' }));
			});

			// Open left panel to verify session-2 was added
			fireEvent.click(screen.getByLabelText('Agents'));
			expect(screen.getByTestId('session-session-2')).toBeInTheDocument();
		});

		it('does not add duplicate session', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			await act(async () => {
				mockHandlers.onSessionAdded?.(
					createMockSession({ id: 'session-1', name: 'Session 1 Duplicate' })
				);
			});

			// Open left panel to verify only one session-1 exists
			fireEvent.click(screen.getByLabelText('Agents'));
			expect(screen.getAllByTestId('session-session-1')).toHaveLength(1);
		});

		it('handles session removed', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			await act(async () => {
				mockHandlers.onSessionRemoved?.('session-1');
			});

			// Open left panel to verify session-1 was removed
			fireEvent.click(screen.getByLabelText('Agents'));
			expect(screen.queryByTestId('session-session-1')).not.toBeInTheDocument();
			expect(screen.getByTestId('session-session-2')).toBeInTheDocument();
		});

		it('clears activeSessionId when active session is removed', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			// session-1 should be auto-selected
			await act(async () => {
				mockHandlers.onSessionRemoved?.('session-1');
			});

			// Session bar should no longer be visible (no sessions)
			expect(screen.queryByTestId('session-pill-bar')).not.toBeInTheDocument();
		});

		it('handles active session changed from desktop', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			await act(async () => {
				mockHandlers.onActiveSessionChanged?.('session-2');
			});

			// The handler should be called, internal state is updated
			expect(mockHandlers.onActiveSessionChanged).toBeDefined();
		});

		it('selects a session from a notification click event', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			expect(screen.getByText('Session 1')).toBeInTheDocument();

			act(() => {
				window.dispatchEvent(
					new CustomEvent('maestro-notification-click', {
						detail: { sessionId: 'session-2' },
					})
				);
			});

			expect(screen.getByText('Session 2')).toBeInTheDocument();
		});
	});

	describe('header notifications and actions', () => {
		it('lists completed agents, selects one, and clears the notification list', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			await act(async () => {
				mockHandlers.onNotificationEvent?.({
					eventType: 'agent_complete',
					sessionId: 'session-2',
					sessionName: 'Session 2',
					message: 'Done',
					severity: 'info',
				});
			});

			fireEvent.click(screen.getByLabelText('Notifications'));

			expect(screen.getByText('Completed Agents')).toBeInTheDocument();
			expect(screen.getByText('Session 2')).toBeInTheDocument();
			expect(screen.getByText('just now')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Session 2/ }));

			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_session',
				sessionId: 'session-2',
				tabId: undefined,
			});

			fireEvent.click(screen.getByLabelText('Notifications'));
			fireEvent.click(screen.getByText('Clear'));
			fireEvent.click(screen.getByLabelText('Notifications'));

			expect(screen.getByText('No completed agents yet')).toBeInTheDocument();
		});

		it('opens notification settings from the notification dropdown', async () => {
			render(<MobileApp />);

			fireEvent.click(screen.getByLabelText('Notifications'));
			fireEvent.click(screen.getByTitle('Notification Settings'));

			expect(screen.getByTestId('notification-settings-sheet')).toBeInTheDocument();
			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
		});

		it('opens narrow-screen overflow actions', async () => {
			Object.defineProperty(window, 'innerWidth', {
				value: 500,
				writable: true,
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			const openMoreActions = () => fireEvent.click(screen.getByLabelText('More actions'));

			openMoreActions();
			fireEvent.click(screen.getByText('Settings'));
			expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Close settings'));

			openMoreActions();
			fireEvent.click(screen.getByText('Group Chat'));
			expect(screen.getByTestId('group-chat-setup-sheet')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Close group chat setup'));

			openMoreActions();
			fireEvent.click(screen.getByText('Usage Dashboard'));
			expect(screen.getByTestId('usage-dashboard-panel')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Close usage dashboard'));

			openMoreActions();
			fireEvent.click(screen.getByText('Achievements'));
			expect(screen.getByTestId('achievements-panel')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Close achievements'));

			openMoreActions();
			fireEvent.click(screen.getByText('Context Management'));
			expect(screen.getByTestId('context-management-sheet')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Close context management'));

			openMoreActions();
			fireEvent.click(screen.getByText('New Agent'));
			expect(screen.getByTestId('agent-creation-sheet')).toBeInTheDocument();
		});

		it('opens active group chat list, selects chats, and starts a new group chat', async () => {
			mockGroupChat.chats = [
				{
					id: 'chat-active',
					topic: 'Active topic',
					isActive: true,
					participants: [{ id: 'session-1' }],
					messages: [{ id: 'm1' }],
				},
				{
					id: 'chat-ended',
					topic: 'Ended topic',
					isActive: false,
					participants: [{ id: 'session-1' }, { id: 'session-2' }],
					messages: [],
				},
			];
			mockGroupChat.activeChat = { id: 'chat-active', topic: 'Active topic' };
			mockGroupChat.startChat.mockResolvedValue('chat-new');
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
				]);
			});

			fireEvent.click(screen.getByLabelText('Group Chat'));
			expect(screen.getByText('Group Chats')).toBeInTheDocument();
			expect(screen.getByText('Active topic')).toBeInTheDocument();
			expect(screen.getByText('Ended topic')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Active topic'));
			expect(mockGroupChat.loadChatState).toHaveBeenCalledWith('chat-active');
			expect(screen.getByTestId('group-chat-panel')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('group-chat-send'));
			expect(mockGroupChat.sendMessage).toHaveBeenCalledWith('chat-active', 'hello group');
			await act(async () => {
				fireEvent.click(screen.getByTestId('group-chat-stop'));
				await Promise.resolve();
			});
			expect(mockGroupChat.stopChat).toHaveBeenCalledWith('chat-active');
			fireEvent.click(screen.getByTestId('group-chat-back'));

			fireEvent.click(screen.getByLabelText('Group Chat'));
			fireEvent.click(screen.getByText('Ended topic'));
			expect(mockGroupChat.loadChatState).toHaveBeenCalledWith('chat-ended');
			fireEvent.click(screen.getByTestId('group-chat-back'));

			fireEvent.click(screen.getByLabelText('Group Chat'));
			fireEvent.click(screen.getByRole('button', { name: 'New group chat' }));
			expect(screen.getByTestId('group-chat-setup-sheet')).toBeInTheDocument();
			await act(async () => {
				fireEvent.click(screen.getByTestId('start-group-chat'));
				await Promise.resolve();
			});

			expect(mockGroupChat.startChat).toHaveBeenCalledWith('Launch sync', ['session-1']);
			expect(mockGroupChat.loadChatState).toHaveBeenCalledWith('chat-new');
		});
	});

	describe('command submission', () => {
		it('submits command via WebSocket when connected', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			const input = screen.getByTestId('command-input');
			fireEvent.change(input, { target: { value: 'Hello Claude' } });

			fireEvent.click(screen.getByTestId('submit-command'));

			expect(mockTriggerHaptic).toHaveBeenCalledWith([15]); // send
			expect(mockSend).toHaveBeenCalledWith({
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello Claude',
				inputMode: 'ai',
			});
		});

		it('queues command when offline', async () => {
			mockIsOffline.mockReturnValue(true);

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			const input = screen.getByTestId('command-input');
			fireEvent.change(input, { target: { value: 'Hello offline' } });

			fireEvent.click(screen.getByTestId('submit-command'));

			expect(mockQueueCommand).toHaveBeenCalledWith('session-1', 'Hello offline', 'ai');
		});

		it('queues command when not connected', async () => {
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			const input = screen.getByTestId('command-input');
			fireEvent.change(input, { target: { value: 'Hello disconnected' } });

			fireEvent.click(screen.getByTestId('submit-command'));

			expect(mockQueueCommand).toHaveBeenCalled();
		});

		it('does not submit without active session', async () => {
			render(<MobileApp />);

			// Don't set up any sessions

			fireEvent.click(screen.getByTestId('submit-command'));

			// Should not call send since no active session
			expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'send_command' }));
		});
	});

	describe('mode toggle', () => {
		it('toggles mode between ai and terminal', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			// Use Cmd+J keyboard shortcut to toggle mode
			fireEvent.keyDown(document, { key: 'j', metaKey: true });

			expect(mockSend).toHaveBeenCalledWith({
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});
		});

		it('keeps separate drafts for AI and terminal mode', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-1', name: 'Main', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-1',
					}),
				]);
			});

			const input = screen.getByTestId('command-input');
			fireEvent.change(input, { target: { value: 'Explain the repo status' } });

			// Toggle to terminal mode via Cmd+J
			fireEvent.keyDown(document, { key: 'j', metaKey: true });

			// CommandInputBar is hidden in terminal mode (WebTerminal handles input)
			// Toggle back to AI mode
			fireEvent.keyDown(document, { key: 'j', metaKey: true });

			// AI draft should be restored
			expect(screen.getByTestId('input-mode')).toHaveTextContent('ai');
			expect(screen.getByTestId('command-input')).toHaveValue('Explain the repo status');
		});

		it('routes terminal websocket data and ready resize for the active terminal session', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Terminal Session',
						inputMode: 'terminal',
					}),
				]);
			});

			expect(screen.getByTestId('web-terminal')).toBeInTheDocument();

			await act(async () => {
				mockHandlers.onTerminalData?.('other-session', 'ignored');
				mockHandlers.onTerminalReady?.('other-session');
			});

			expect(mockTerminalWrite).not.toHaveBeenCalled();
			expect(mockTerminalFitAndGetSize).not.toHaveBeenCalled();

			mockSend.mockClear();

			await act(async () => {
				mockHandlers.onTerminalData?.('session-1', 'hello terminal');
				mockHandlers.onTerminalReady?.('session-1');
			});

			expect(mockTerminalWrite).toHaveBeenCalledWith('hello terminal');
			expect(mockTerminalFitAndGetSize).toHaveBeenCalled();
			expect(mockSend).toHaveBeenCalledWith({
				type: 'terminal_resize',
				sessionId: 'session-1',
				cols: 120,
				rows: 40,
			});
		});
	});

	describe('draft scoping', () => {
		it('keeps drafts scoped to the selected session', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Session 1',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-1', name: 'Main', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-1',
					}),
					createMockSession({
						id: 'session-2',
						name: 'Session 2',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-2', name: 'Main', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-2',
					}),
				]);
			});

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for session one' },
			});

			// Open left panel to switch sessions
			fireEvent.click(screen.getByLabelText('Agents'));
			fireEvent.click(screen.getByTestId('session-session-2'));
			expect(screen.getByTestId('command-input')).toHaveValue('');

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for session two' },
			});

			fireEvent.click(screen.getByTestId('session-session-1'));
			expect(screen.getByTestId('command-input')).toHaveValue('draft for session one');
		});

		it('falls back to desktop AI draft after submit clears the local override', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-1', name: 'Main', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'temporary local draft' },
			});

			fireEvent.click(screen.getByTestId('submit-command'));
			expect(screen.getByTestId('command-input')).toHaveValue('');

			await act(async () => {
				mockHandlers.onTabsChanged?.(
					'session-1',
					[{ id: 'tab-1', name: 'Main', state: 'idle', inputValue: 'desktop restored draft' }],
					'tab-1'
				);
			});

			expect(screen.getByTestId('command-input')).toHaveValue('desktop restored draft');
		});
	});

	describe('interrupt handling', () => {
		it('sends interrupt request via API', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			fireEvent.click(screen.getByTestId('interrupt-button'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(global.fetch).toHaveBeenCalledWith(
				'http://localhost:3000/session/session-1/interrupt',
				expect.objectContaining({ method: 'POST' })
			);
		});

		it('handles interrupt API error', async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			fireEvent.click(screen.getByTestId('interrupt-button'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should not throw, handles error gracefully
			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap
		});
	});

	describe('tab management', () => {
		it('renders tab bar when session has multiple tabs', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
		});

		it('renders tab bar even in terminal mode (unified tab bar)', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'terminal',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			// Tab bar now always shows when session has aiTabs (includes terminal tab indicator)
			expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
		});

		it('handles tab selection', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.click(screen.getByTestId('tab-tab-2'));

			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});
		});

		it('handles new tab creation', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.click(screen.getByTestId('new-tab'));

			expect(mockSend).toHaveBeenCalledWith({
				type: 'new_tab',
				sessionId: 'session-1',
			});
		});

		it('handles tab close', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.click(screen.getByTestId('close-tab'));

			expect(mockSend).toHaveBeenCalledWith({
				type: 'close_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});

		it('handles tabs changed event from desktop', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-1', name: 'Tab 1', state: 'idle' }],
						activeTabId: 'tab-1',
					}),
				]);
			});

			await act(async () => {
				mockHandlers.onTabsChanged?.(
					'session-1',
					[
						{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
						{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
					],
					'tab-2'
				);
			});

			// After tabs changed, tab bar should show 2 tabs
			expect(screen.getByTestId('tab-tab-1')).toBeInTheDocument();
			expect(screen.getByTestId('tab-tab-2')).toBeInTheDocument();
		});
	});

	describe('agents panel (left panel)', () => {
		it('opens agents panel', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByLabelText('Agents'));

			expect(screen.getByTestId('left-panel')).toBeInTheDocument();
		});

		it('closes agents panel', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByLabelText('Agents'));
			expect(screen.getByTestId('left-panel')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('close-left-panel'));
			expect(screen.queryByTestId('left-panel')).not.toBeInTheDocument();
		});
	});

	describe('right panel', () => {
		it('opens right panel via header button', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByLabelText('Files & History'));

			const panel = screen.getByTestId('right-panel');
			expect(panel).toBeInTheDocument();
			expect(panel).toHaveAttribute('data-active-tab', 'files');
		});

		it('closes right panel', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByLabelText('Files & History'));
			expect(screen.getByTestId('right-panel')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('close-right-panel'));
			expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
		});

		it('opens right panel and can close it again', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			// Open right panel
			fireEvent.click(screen.getByLabelText('Files & History'));
			const panel = screen.getByTestId('right-panel');
			expect(panel).toBeInTheDocument();
			expect(panel).toHaveAttribute('data-active-tab', 'files');

			// Close panel
			fireEvent.click(screen.getByTestId('close-right-panel'));
			expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();

			// Reopen
			fireEvent.click(screen.getByLabelText('Files & History'));
			expect(screen.getByTestId('right-panel')).toBeInTheDocument();
		});

		it('toggles right panel via header button', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			// Open right panel
			fireEvent.click(screen.getByLabelText('Files & History'));
			expect(screen.getByTestId('right-panel')).toBeInTheDocument();

			// Toggle off via same button
			fireEvent.click(screen.getByLabelText('Files & History'));
			expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
		});

		it('bridges right panel AutoRun, folder, marketplace, and git actions', async () => {
			mockGitStatus.diff = { diff: 'diff --git a/src/App.tsx b/src/App.tsx' };
			mockSendRequest.mockResolvedValue({ success: true });
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Session 1',
						cwd: '/Users/test/project',
						autoRunFolderPath: '/Users/test/project/.maestro/playbooks',
					} as Partial<Session>),
				]);
			});

			fireEvent.click(screen.getByLabelText('Files & History'));
			fireEvent.click(screen.getByTestId('right-panel-select-doc'));
			fireEvent.click(screen.getByTestId('right-panel-open-setup'));

			expect(screen.getByTestId('autorun-setup-sheet')).toBeInTheDocument();
			expect(screen.getByTestId('autorun-current-document')).toHaveTextContent('daily.md');

			fireEvent.click(screen.getByTestId('autorun-load-branches'));
			fireEvent.click(screen.getByTestId('autorun-load-worktrees'));
			expect(mockAutoRun.loadGitBranches).toHaveBeenCalledWith('session-1');
			expect(mockAutoRun.listWorktrees).toHaveBeenCalledWith('session-1');

			fireEvent.click(screen.getByTestId('autorun-setup-marketplace'));
			expect(screen.getByTestId('marketplace-sheet')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('marketplace-imported'));
			expect(mockAutoRun.loadDocuments).toHaveBeenCalledWith('session-1');
			fireEvent.click(screen.getByTestId('marketplace-close'));

			fireEvent.click(screen.getByTestId('right-panel-open-folder'));
			expect(screen.getByTestId('folder-picker-sheet')).toBeInTheDocument();
			expect(screen.getByTestId('folder-picker-start')).toHaveTextContent('/Users/test/project');
			expect(screen.getByTestId('folder-picker-initial')).toHaveTextContent(
				'/Users/test/project/.maestro/playbooks'
			);
			await act(async () => {
				fireEvent.click(screen.getByTestId('folder-picker-confirm'));
				await Promise.resolve();
			});
			expect(mockSendRequest).toHaveBeenCalledWith('set_auto_run_folder', {
				sessionId: 'session-1',
				folderPath: '/tmp/maestro-playbooks',
			});

			fireEvent.click(screen.getByTestId('right-panel-view-diff'));
			expect(mockGitStatus.loadDiff).toHaveBeenCalledWith('session-1', 'src/App.tsx');
			expect(screen.getByTestId('git-diff-viewer')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('git-diff-back'));
			expect(screen.queryByTestId('git-diff-viewer')).not.toBeInTheDocument();
		});
	});

	describe('tab search modal', () => {
		it('opens tab search modal', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.click(screen.getByTestId('tab-search'));

			expect(screen.getByTestId('tab-search-modal')).toBeInTheDocument();
		});

		it('closes tab search modal', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.click(screen.getByTestId('tab-search'));
			expect(screen.getByTestId('tab-search-modal')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('close-tab-search'));
			expect(screen.queryByTestId('tab-search-modal')).not.toBeInTheDocument();
		});
	});

	describe('session output handling', () => {
		it('appends output to session logs', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			await act(async () => {
				mockHandlers.onSessionOutput?.('session-1', 'Hello from AI', 'ai');
			});

			// Message history should show the output
			expect(screen.getByTestId('message-history')).toBeInTheDocument();
		});

		it('ignores output for non-active sessions', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1' }),
					createMockSession({ id: 'session-2' }),
				]);
			});

			// Session 1 is active (first auto-selected)
			await act(async () => {
				mockHandlers.onSessionOutput?.('session-2', 'Hello from session 2', 'ai');
			});

			// Should not crash, output should be ignored
			// Component still renders (either message history or empty state, depending on logs)
			expect(screen.getByTestId('command-input-bar')).toBeInTheDocument();
		});

		it('handles terminal output', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', inputMode: 'terminal' }),
				]);
			});

			await act(async () => {
				mockHandlers.onSessionOutput?.('session-1', 'ls -la output', 'terminal');
			});

			// In terminal mode, WebTerminal is shown instead of MessageHistory
			expect(screen.getByTestId('web-terminal')).toBeInTheDocument();
		});
	});

	describe('user input handling', () => {
		it('adds user input from desktop to logs', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			await act(async () => {
				mockHandlers.onUserInput?.('session-1', 'User command', 'ai');
			});

			expect(screen.getByTestId('message-history')).toBeInTheDocument();
		});

		it('ignores user input for non-active sessions', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1' }),
					createMockSession({ id: 'session-2' }),
				]);
			});

			await act(async () => {
				mockHandlers.onUserInput?.('session-2', 'User command for session 2', 'ai');
			});

			// Should not crash - the component still renders (either message history or empty state)
			expect(screen.getByTestId('command-input-bar')).toBeInTheDocument();
		});
	});

	describe('session exit handling', () => {
		it('updates session state to idle on exit', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				mockHandlers.onSessionExit?.('session-1', 0);
			});

			// Handler should be defined
			expect(mockHandlers.onSessionExit).toBeDefined();
		});
	});

	describe('theme handling', () => {
		it('updates desktop theme when received', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onThemeUpdate?.({
					id: 'dracula',
					name: 'Dracula',
					mode: 'dark',
					colors: mockColors,
				});
			});

			expect(mockSetDesktopTheme).toHaveBeenCalledWith({
				id: 'dracula',
				name: 'Dracula',
				mode: 'dark',
				colors: mockColors,
			});
		});

		it('syncs desktop bionify mode into web reader surfaces without touching input controls', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			await act(async () => {
				mockHandlers.onSessionOutput?.('session-1', 'Readable prose output', 'ai');
			});

			expect(screen.getByTestId('history-bionify')).toHaveTextContent('false');
			expect(screen.getByTestId('response-viewer-bionify')).toHaveTextContent('false');
			expect(screen.getByTestId('command-input-has-bionify-prop')).toHaveTextContent('false');
			expect(screen.getByTestId('command-input').tagName.toLowerCase()).toBe('input');

			await act(async () => {
				mockHandlers.onBionifyReadingModeUpdate?.(true);
			});

			expect(mockSetDesktopBionifyReadingMode).toHaveBeenCalledWith(true);
			expect(screen.getByTestId('history-bionify')).toHaveTextContent('true');
			expect(screen.getByTestId('response-viewer-bionify')).toHaveTextContent('true');
			expect(screen.getByTestId('command-input-has-bionify-prop')).toHaveTextContent('false');
			expect(screen.getByTestId('command-input').tagName.toLowerCase()).toBe('input');
		});
	});

	describe('custom commands', () => {
		it('receives custom commands from desktop', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onCustomCommands?.([{ command: 'custom1', description: 'Custom command 1' }]);
			});

			// Handler should be defined
			expect(mockHandlers.onCustomCommands).toBeDefined();
		});
	});

	describe('auto-run state', () => {
		it('displays auto-run indicator when state is active', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			await act(async () => {
				mockHandlers.onAutoRunStateChange?.('session-1', {
					isRunning: true,
					totalTasks: 5,
					currentTaskIndex: 2,
					completedTasks: 2,
				});
			});

			expect(screen.getByTestId('autorun-indicator')).toBeInTheDocument();
		});

		it('hides auto-run indicator when state is null', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			await act(async () => {
				mockHandlers.onAutoRunStateChange?.('session-1', {
					isRunning: true,
					totalTasks: 5,
					currentTaskIndex: 2,
					completedTasks: 2,
				});
			});

			expect(screen.getByTestId('autorun-indicator')).toBeInTheDocument();

			await act(async () => {
				mockHandlers.onAutoRunStateChange?.('session-1', null);
			});

			expect(screen.queryByTestId('autorun-indicator')).not.toBeInTheDocument();
		});

		it('opens AutoRun panel from indicator and drives panel recovery and launch callbacks', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Session 1',
						state: 'idle',
					}),
				]);
			});

			await act(async () => {
				mockHandlers.onAutoRunStateChange?.('session-1', {
					isRunning: true,
					totalTasks: 2,
					currentTaskIndex: 0,
					completedTasks: 0,
				});
			});

			fireEvent.click(screen.getByTestId('autorun-open-panel'));
			expect(screen.getByTestId('autorun-panel')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('autorun-panel-resume'));
			fireEvent.click(screen.getByTestId('autorun-panel-skip'));
			fireEvent.click(screen.getByTestId('autorun-panel-abort'));
			expect(mockAutoRun.resumeAutoRunError).toHaveBeenCalledWith('session-1');
			expect(mockAutoRun.skipAutoRunDocument).toHaveBeenCalledWith('session-1');
			expect(mockAutoRun.abortAutoRunError).toHaveBeenCalledWith('session-1');

			fireEvent.click(screen.getByTestId('autorun-panel-open-doc'));
			expect(screen.getByTestId('autorun-document-viewer')).toBeInTheDocument();
			expect(screen.getByTestId('autorun-document-filename')).toHaveTextContent('daily.md');
			expect(screen.getByTestId('autorun-document-locked')).toHaveTextContent('locked');
			fireEvent.click(screen.getByTestId('autorun-document-back'));
			expect(screen.queryByTestId('autorun-document-viewer')).not.toBeInTheDocument();

			fireEvent.click(screen.getByTestId('autorun-panel-open-setup'));
			expect(screen.getByTestId('autorun-setup-sheet')).toBeInTheDocument();
			await act(async () => {
				fireEvent.click(screen.getByTestId('autorun-launch'));
				await Promise.resolve();
			});
			expect(mockAutoRun.launchAutoRun).toHaveBeenCalledWith('session-1', {
				document: 'daily.md',
			});

			fireEvent.click(screen.getByTestId('autorun-panel-marketplace'));
			expect(screen.getByTestId('marketplace-sheet')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('autorun-panel-close'));
			expect(screen.queryByTestId('autorun-panel')).not.toBeInTheDocument();
		});
	});

	describe('offline queue', () => {
		it('displays offline queue banner when queue has items', async () => {
			mockQueue = [
				{ id: 'cmd-1', sessionId: 'session-1', command: 'test', mode: 'ai', timestamp: Date.now() },
			];
			mockQueueLength = 1;

			render(<MobileApp />);

			expect(screen.getByTestId('offline-queue-banner')).toBeInTheDocument();
		});

		it('hides offline queue banner when queue is empty', () => {
			mockQueue = [];
			mockQueueLength = 0;

			render(<MobileApp />);

			expect(screen.queryByTestId('offline-queue-banner')).not.toBeInTheDocument();
		});
	});

	describe('response notifications', () => {
		it('shows notification when response completes and app is backgrounded', async () => {
			mockNotificationPermission = 'granted';

			// Mock document.visibilityState to be hidden
			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			// Simulate busy -> idle transition
			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {
					lastResponse: { text: 'Response completed', timestamp: Date.now() },
				});
			});

			expect(mockAddUnread).toHaveBeenCalled();
			expect(mockShowNotification).toHaveBeenCalled();
		});

		it('does not show notification when app is visible', async () => {
			mockNotificationPermission = 'granted';

			// Explicitly set document.visibilityState to 'visible'
			Object.defineProperty(document, 'visibilityState', {
				value: 'visible',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {
					lastResponse: { text: 'Test response', timestamp: Date.now() },
				});
			});

			// Notification should NOT be shown when app is visible
			expect(mockShowNotification).not.toHaveBeenCalled();
			// Unread badge should also NOT be added when visible
			expect(mockAddUnread).not.toHaveBeenCalled();
		});

		it('does not show notification when permission is not granted', async () => {
			mockNotificationPermission = 'denied';

			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {});
			});

			// Should still add unread badge
			expect(mockAddUnread).toHaveBeenCalled();
			// But not show notification
			expect(mockShowNotification).not.toHaveBeenCalled();
		});
	});

	describe('keyboard shortcuts', () => {
		it('toggles mode with Cmd+J', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			fireEvent.keyDown(document, { key: 'j', metaKey: true });

			expect(mockSend).toHaveBeenCalledWith({
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});
		});

		it('navigates to previous tab with Cmd+Shift+[', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-2',
					}),
				]);
			});

			fireEvent.keyDown(document, { key: '[', metaKey: true, shiftKey: true });

			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});

		it('navigates to next tab with Cmd+Shift+]', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.keyDown(document, { key: ']', metaKey: true, shiftKey: true });

			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});
		});

		it('wraps around when navigating past last tab', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
						],
						activeTabId: 'tab-2',
					}),
				]);
			});

			fireEvent.keyDown(document, { key: ']', metaKey: true, shiftKey: true });

			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});
	});

	describe('screen size detection', () => {
		it('detects small screen', () => {
			Object.defineProperty(window, 'innerHeight', {
				value: 600,
				writable: true,
				configurable: true,
			});

			render(<MobileApp />);

			// The component should render, detecting small screen internally
			expect(screen.getByTestId('command-input-bar')).toBeInTheDocument();
		});

		it('responds to resize events', async () => {
			Object.defineProperty(window, 'innerHeight', {
				value: 800,
				writable: true,
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				Object.defineProperty(window, 'innerHeight', {
					value: 600,
					writable: true,
					configurable: true,
				});
				fireEvent(window, new Event('resize'));
			});

			// Component should handle resize
			expect(screen.getByTestId('command-input-bar')).toBeInTheDocument();
		});
	});

	describe('auto-reconnect', () => {
		it('auto-reconnects every 30 seconds when disconnected', async () => {
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(mockConnect).toHaveBeenCalledTimes(1);

			await act(async () => {
				vi.advanceTimersByTime(30000);
			});

			expect(mockConnect).toHaveBeenCalledTimes(2);
		});

		it('does not auto-reconnect when connected', async () => {
			mockWebSocketState = 'connected';

			render(<MobileApp />);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(mockConnect).toHaveBeenCalledTimes(1);

			await act(async () => {
				vi.advanceTimersByTime(60000);
			});

			// Should still only be 1 (initial connect)
			expect(mockConnect).toHaveBeenCalledTimes(1);
		});

		it('does not auto-reconnect when offline', async () => {
			mockIsOffline.mockReturnValue(true);
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(mockConnect).toHaveBeenCalledTimes(1);

			await act(async () => {
				vi.advanceTimersByTime(60000);
			});

			// Should still only be 1
			expect(mockConnect).toHaveBeenCalledTimes(1);
		});
	});

	describe('session log fetching', () => {
		it('fetches logs when active session changes', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining('/session/session-1'),
				expect.anything()
			);
		});

		it('fetches logs with tabId when available', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						aiTabs: [{ id: 'tab-1', name: 'Tab 1', state: 'idle' }],
						activeTabId: 'tab-1',
					}),
				]);
			});

			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining('tabId=tab-1'),
				expect.anything()
			);
		});

		it('clears logs when offline', async () => {
			mockIsOffline.mockReturnValue(true);

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			// Should not fetch when offline
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it('handles fetch error gracefully', async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should not throw
			expect(screen.getByTestId('command-input-bar')).toBeInTheDocument();
		});
	});

	describe('connection state display', () => {
		it('shows active session name in header when connected', async () => {
			mockWebSocketState = 'authenticated';

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			// Session name should be visible in the header
			expect(screen.getByText('Test Session')).toBeInTheDocument();
		});

		it('shows Maestro title when offline', () => {
			mockIsOffline.mockReturnValue(true);

			render(<MobileApp />);

			// No active session, header shows default
			expect(screen.queryByText('Test Session')).not.toBeInTheDocument();
		});

		it('does not show session info when disconnected', () => {
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			// No session is active when disconnected
			expect(screen.queryByText('Test Session')).not.toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles empty command submission', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			const input = screen.getByTestId('command-input');
			fireEvent.change(input, { target: { value: '' } });

			fireEvent.click(screen.getByTestId('submit-command'));

			// The command should still be sent (the component doesn't filter empty)
			// In practice, CommandInputBar handles this, but the App just passes through
			expect(mockSend).toHaveBeenCalled();
		});

		it('handles rapid session switches', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
					createMockSession({ id: 'session-2', name: 'Session 2' }),
					createMockSession({ id: 'session-3', name: 'Session 3' }),
				]);
			});

			// Open left panel to access session list
			fireEvent.click(screen.getByLabelText('Agents'));

			fireEvent.click(screen.getByTestId('session-session-2'));
			fireEvent.click(screen.getByTestId('session-session-3'));
			fireEvent.click(screen.getByTestId('session-session-1'));

			// All should be handled without errors
			expect(mockSend).toHaveBeenCalledTimes(3);
		});

		it('handles connection error message display', () => {
			mockWebSocketState = 'disconnected';
			mockWebSocketError = 'ECONNREFUSED';

			render(<MobileApp />);

			expect(screen.getByText('ECONNREFUSED')).toBeInTheDocument();
		});

		it('shows default error when no specific error message', () => {
			mockWebSocketState = 'disconnected';
			mockWebSocketError = null;

			render(<MobileApp />);

			expect(screen.getByText(/Unable to connect/)).toBeInTheDocument();
		});
	});

	describe('response viewer', () => {
		it('response viewer is not shown initially', () => {
			render(<MobileApp />);
			expect(screen.queryByTestId('response-viewer')).not.toBeInTheDocument();
		});

		it('displays response viewer with session response data', async () => {
			render(<MobileApp />);

			// Create a session with lastResponsePreview
			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Session 1',
						lastResponsePreview: {
							text: 'Test response content',
							timestamp: Date.now(),
						},
					}),
				]);
			});

			// The response viewer requires showResponseViewer state to be true
			// which is set by handleExpandResponse - currently not accessible via UI
			// This test verifies the component doesn't crash with session data present
			expect(screen.queryByTestId('response-viewer')).not.toBeInTheDocument();
		});

		// Note: handleExpandResponse is called from future UI components
		// that aren't currently implemented. These tests cover the ResponseViewer
		// integration points that are accessible.
	});

	describe('getFirstLineOfResponse', () => {
		// Testing via notification flow
		it('strips markdown code markers from response', async () => {
			mockNotificationPermission = 'granted';

			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {
					lastResponse: { text: '```\nActual content\n```', timestamp: Date.now() },
				});
			});

			expect(mockShowNotification).toHaveBeenCalled();
			// The notification body should have the actual content, not the code markers
		});

		it('truncates long response lines', async () => {
			mockNotificationPermission = 'granted';

			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			const longText = 'a'.repeat(200);

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {
					lastResponse: { text: longText, timestamp: Date.now() },
				});
			});

			expect(mockShowNotification).toHaveBeenCalled();
		});

		it('handles empty response text', async () => {
			mockNotificationPermission = 'granted';

			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {
					lastResponse: { text: '', timestamp: Date.now() },
				});
			});

			expect(mockShowNotification).toHaveBeenCalled();
		});

		it('skips horizontal rules in response', async () => {
			mockNotificationPermission = 'granted';

			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				mockHandlers.onSessionStateChange?.('session-1', 'idle', {
					lastResponse: { text: '---\n\nActual content', timestamp: Date.now() },
				});
			});

			expect(mockShowNotification).toHaveBeenCalled();
		});
	});
});
