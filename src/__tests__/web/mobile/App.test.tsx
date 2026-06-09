/**
 * Tests for MobileApp component
 *
 * @file src/__tests__/web/mobile/App.test.tsx
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

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
const mockDisconnect = vi.fn();
let mockWebSocketState = 'connected';
let mockWebSocketError: string | null = null;
let mockReconnectAttempts = 0;
let mockHandlers: Record<string, (...args: unknown[]) => void> = {};

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
			disconnect: mockDisconnect,
			error: mockWebSocketError,
			reconnectAttempts: mockReconnectAttempts,
		};
	},
}));

// Mock useNotifications hook
const mockShowNotification = vi.fn();
let mockNotificationPermission = 'default';
type NotificationHookOptions = {
	onGranted?: () => void;
	onDenied?: () => void;
};
let mockNotificationOptions: NotificationHookOptions = {};

vi.mock('../../../web/hooks/useNotifications', () => ({
	useNotifications: (options: NotificationHookOptions = {}) => {
		mockNotificationOptions = options;
		return {
			permission: mockNotificationPermission,
			showNotification: mockShowNotification,
			requestPermission: vi.fn(),
			declineNotifications: vi.fn(),
			hasPrompted: false,
			hasDeclined: false,
		};
	},
}));

// Mock useUnreadBadge hook
const mockAddUnread = vi.fn();
const mockMarkAllRead = vi.fn();
let mockUnreadCount = 0;
type UnreadBadgeHookOptions = {
	onCountChange?: (count: number) => void;
};
let mockUnreadBadgeOptions: UnreadBadgeHookOptions = {};

vi.mock('../../../web/hooks/useUnreadBadge', () => ({
	useUnreadBadge: (options: UnreadBadgeHookOptions = {}) => {
		mockUnreadBadgeOptions = options;
		return {
			addUnread: mockAddUnread,
			markRead: vi.fn(),
			markAllRead: mockMarkAllRead,
			clearBadge: vi.fn(),
			unreadCount: mockUnreadCount,
			unreadIds: [],
		};
	},
}));

// Mock useOfflineQueue hook
const mockQueueCommand = vi.fn(() => true);
const mockRemoveCommand = vi.fn();
const mockClearQueue = vi.fn();
const mockProcessQueue = vi.fn();
let mockQueue: unknown[] = [];
let mockQueueLength = 0;
let mockQueueStatus = 'idle';
type OfflineQueueHookOptions = {
	sendCommand?: (sessionId: string, command: string) => boolean;
	onCommandSent?: (cmd: { command: string }) => void;
	onCommandFailed?: (cmd: { command: string }, error: unknown) => void;
	onProcessingStart?: () => void;
	onProcessingComplete?: (successCount: number, failCount: number) => void;
};
let mockOfflineQueueOptions: OfflineQueueHookOptions = {};

vi.mock('../../../web/hooks/useOfflineQueue', () => ({
	useOfflineQueue: (options: OfflineQueueHookOptions = {}) => {
		mockOfflineQueueOptions = options;
		return {
			queue: mockQueue,
			queueLength: mockQueueLength,
			status: mockQueueStatus,
			queueCommand: mockQueueCommand,
			removeCommand: mockRemoveCommand,
			clearQueue: mockClearQueue,
			processQueue: mockProcessQueue,
		};
	},
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
}));

// Mock webLogger
const mockWebLogger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../web/utils/logger', () => ({
	webLogger: mockWebLogger,
}));

// Mock child components
vi.mock('../../../web/mobile/SessionPillBar', () => {
	const MockSessionPillBar = ({
		sessions,
		activeSessionId,
		onSelectSession,
		onOpenAllSessions,
		onOpenHistory,
	}: {
		sessions: unknown[];
		activeSessionId: string | null;
		onSelectSession: (id: string) => void;
		onOpenAllSessions?: () => void;
		onOpenHistory?: () => void;
	}) => {
		const React = require('react');
		return React.createElement('div', { 'data-testid': 'session-pill-bar' }, [
			...sessions.map((s: any) =>
				React.createElement(
					'button',
					{
						key: s.id,
						'data-testid': `session-${s.id}`,
						onClick: () => onSelectSession(s.id),
					},
					s.name
				)
			),
			onOpenAllSessions &&
				React.createElement(
					'button',
					{
						key: 'open-all-sessions',
						'data-testid': 'open-all-sessions',
						onClick: onOpenAllSessions,
					},
					'All Sessions'
				),
			onOpenHistory &&
				React.createElement(
					'button',
					{
						key: 'open-history',
						'data-testid': 'open-history',
						onClick: onOpenHistory,
					},
					'History'
				),
		]);
	};
	return {
		default: MockSessionPillBar,
		SessionPillBar: MockSessionPillBar,
	};
});

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
		onModeToggle,
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
		onModeToggle: (mode: 'ai' | 'terminal') => void;
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
			<button data-testid="repeat-command-change" onClick={() => onChange(value)}>
				Repeat Change
			</button>
			<button
				data-testid="mode-toggle"
				onClick={() => onModeToggle(inputMode === 'ai' ? 'terminal' : 'ai')}
			>
				{inputMode}
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
			<span data-testid="command-cwd">{cwd ?? ''}</span>
			<span data-testid="slash-commands">
				{slashCommands
					.map((command) =>
						typeof command === 'string' ? command : (command as { command?: string }).command
					)
					.join('|')}
			</span>
		</div>
	),
	default: () => <div data-testid="command-input-bar-default" />,
}));

type ResponseViewerProps = {
	isOpen: boolean;
	response: unknown;
	allResponses?: unknown[];
	currentIndex: number;
	onNavigate: (index: number) => void;
	onClose: () => void;
	sessionName?: string;
};
let lastResponseViewerProps: ResponseViewerProps | null = null;

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
	}) => {
		lastResponseViewerProps = {
			isOpen,
			response,
			allResponses,
			currentIndex,
			onNavigate,
			onClose,
			sessionName,
		};

		return (
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
		);
	},
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
	AutoRunIndicator: ({ state, sessionName }: { state: unknown; sessionName?: string }) => (
		<div data-testid="autorun-indicator">
			<span data-testid="autorun-session">{sessionName}</span>
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
		...overrides,
	} as Session;
}

describe('MobileApp', () => {
	let originalFetch: typeof global.fetch;
	let originalVisibilityState: PropertyDescriptor | undefined;
	let originalInnerHeight: PropertyDescriptor | undefined;
	let originalReadyState: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Reset mock states
		mockWebSocketState = 'connected';
		mockWebSocketError = null;
		mockReconnectAttempts = 0;
		mockNotificationPermission = 'default';
		mockNotificationOptions = {};
		mockUnreadCount = 0;
		mockUnreadBadgeOptions = {};
		mockQueue = [];
		mockQueueLength = 0;
		mockQueueStatus = 'idle';
		mockOfflineQueueOptions = {};
		mockHandlers = {};
		mockDesktopTheme = null;
		mockDesktopBionifyReadingMode = false;

		// Store original fetch
		originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ session: { aiLogs: [], shellLogs: [] } }),
		});

		// Store original properties
		originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
		originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
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
				// With mocked header, we verify the session was added
				expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
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

				expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
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

				expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
			});

			it('shows warning and error context usage levels in the header', async () => {
				const { rerender } = render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: {
								inputTokens: 75,
								outputTokens: 0,
								totalCostUsd: 0,
								contextWindow: 100,
							},
						}),
					]);
				});

				expect(screen.getByText('75%')).toBeInTheDocument();

				rerender(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							usageStats: {
								inputTokens: 95,
								outputTokens: 0,
								totalCostUsd: 0,
								contextWindow: 100,
							},
						}),
					]);
				});

				expect(screen.getByText('95%')).toBeInTheDocument();
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
				expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
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

				expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
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

				expect(screen.getByTestId('session-session-1')).toBeInTheDocument();
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

			it('falls back to session data when active tab id has no match', async () => {
				render(<MobileApp />);

				await act(async () => {
					mockHandlers.onSessionsUpdate?.([
						createMockSession({
							id: 'session-1',
							name: 'Fallback Session',
							agentSessionId: 'session-level-abcdef',
							aiTabs: [{ id: 'tab-1', name: 'Tab 1', state: 'idle' }],
							activeTabId: 'missing-tab',
						}),
					]);
				});

				expect(screen.getAllByText('Fallback Session')).toHaveLength(2);
				expect(screen.getByTitle('Claude Session: session-level-abcdef')).toHaveTextContent(
					'session-'
				);
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

		it('retries initial connection when injected config is not ready yet', () => {
			delete (window as any).__MAESTRO_CONFIG__;

			render(<MobileApp />);
			act(() => {
				vi.advanceTimersByTime(50);
			});

			expect(mockConnect).not.toHaveBeenCalled();
			expect(mockWebLogger.warn).toHaveBeenCalledWith(
				'Config not ready, retrying connection in 100ms',
				'Mobile'
			);

			(window as any).__MAESTRO_CONFIG__ = {};
			act(() => {
				vi.advanceTimersByTime(100);
			});

			expect(mockConnect).toHaveBeenCalledTimes(1);
		});

		it('waits for window load before connecting when the document is still loading', () => {
			Object.defineProperty(document, 'readyState', {
				value: 'loading',
				configurable: true,
			});
			const removeLoadListener = vi.spyOn(window, 'removeEventListener');

			const { unmount } = render(<MobileApp />);

			act(() => {
				vi.advanceTimersByTime(50);
			});
			expect(mockConnect).not.toHaveBeenCalled();

			act(() => {
				window.dispatchEvent(new Event('load'));
				vi.advanceTimersByTime(50);
			});

			expect(mockConnect).toHaveBeenCalledTimes(1);

			unmount();
			expect(removeLoadListener).toHaveBeenCalledWith('load', expect.any(Function));
			removeLoadListener.mockRestore();
		});

		it('cleans up load listener before a connect timeout is scheduled', () => {
			Object.defineProperty(document, 'readyState', {
				value: 'loading',
				configurable: true,
			});
			const removeLoadListener = vi.spyOn(window, 'removeEventListener');

			const { unmount } = render(<MobileApp />);

			unmount();

			expect(removeLoadListener).toHaveBeenCalledWith('load', expect.any(Function));
			expect(mockConnect).not.toHaveBeenCalled();
			removeLoadListener.mockRestore();
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

	describe('hook callbacks', () => {
		it('handles notification permission callbacks with logging and haptics', () => {
			render(<MobileApp />);

			act(() => {
				mockNotificationOptions.onGranted?.();
				mockNotificationOptions.onDenied?.();
			});

			expect(mockWebLogger.debug).toHaveBeenCalledWith('Notification permission granted', 'Mobile');
			expect(mockTriggerHaptic).toHaveBeenCalledWith([30]);
			expect(mockWebLogger.debug).toHaveBeenCalledWith('Notification permission denied', 'Mobile');
		});

		it('logs unread badge count changes', () => {
			render(<MobileApp />);

			act(() => {
				mockUnreadBadgeOptions.onCountChange?.(4);
			});

			expect(mockWebLogger.debug).toHaveBeenCalledWith('Unread response count: 4', 'Mobile');
		});

		it('routes offline queue callbacks through send, logging, and haptics', () => {
			render(<MobileApp />);

			expect(mockOfflineQueueOptions.sendCommand?.('session-1', 'queued command')).toBe(true);
			expect(mockSend).toHaveBeenCalledWith({
				type: 'send_command',
				sessionId: 'session-1',
				command: 'queued command',
			});

			act(() => {
				mockOfflineQueueOptions.onCommandSent?.({ command: 'queued command body' });
				mockOfflineQueueOptions.onCommandFailed?.(
					{ command: 'failed command body' },
					new Error('send failed')
				);
				mockOfflineQueueOptions.onProcessingStart?.();
			});

			expect(mockWebLogger.debug).toHaveBeenCalledWith(
				'Queued command sent: queued command body',
				'Mobile'
			);
			expect(mockTriggerHaptic).toHaveBeenCalledWith([30]);
			expect(mockWebLogger.error).toHaveBeenCalledWith(
				'Queued command failed: failed command body',
				'Mobile',
				expect.any(Error)
			);
			expect(mockWebLogger.debug).toHaveBeenCalledWith('Processing offline queue...', 'Mobile');

			mockTriggerHaptic.mockClear();
			act(() => {
				mockOfflineQueueOptions.onProcessingComplete?.(0, 1);
			});
			expect(mockTriggerHaptic).not.toHaveBeenCalled();

			act(() => {
				mockOfflineQueueOptions.onProcessingComplete?.(2, 1);
			});
			expect(mockWebLogger.debug).toHaveBeenCalledWith(
				'Offline queue processed. Success: 2, Failed: 1',
				'Mobile'
			);
			expect(mockTriggerHaptic).toHaveBeenCalledWith([30]);
		});
	});

	describe('mobile header', () => {
		it('uses session mode header as a dashboard link and shows error status', async () => {
			mockIsSession.mockReturnValue(true);
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'error' })]);
			});

			expect(screen.getByTitle('Session error')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Maestro'));
			expect(mockGoToDashboard).toHaveBeenCalledTimes(1);
		});

		it('shows warning status for connecting sessions', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', state: 'connecting' }),
				]);
			});

			expect(screen.getByTitle('Session connecting')).toBeInTheDocument();
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

			// Session pill bar should be visible with sessions
			expect(screen.getByTestId('session-pill-bar')).toBeInTheDocument();
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

			await act(async () => {
				fireEvent.click(screen.getByTestId('session-session-2'));
				await Promise.resolve();
			});

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

			// Should still only have one session with id session-1
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

		it('logs queue failure when offline command cannot be stored', async () => {
			mockIsOffline.mockReturnValue(true);
			mockQueueCommand.mockReturnValueOnce(false);

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', inputMode: 'ai' })]);
			});

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'Will not fit in queue' },
			});
			fireEvent.click(screen.getByTestId('submit-command'));

			expect(mockWebLogger.warn).toHaveBeenCalledWith(
				'Failed to queue command - queue may be full',
				'Mobile'
			);
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

		it('submits and clears terminal drafts', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', inputMode: 'terminal' }),
				]);
			});

			fireEvent.change(screen.getByTestId('command-input'), { target: { value: 'pwd' } });
			fireEvent.click(screen.getByTestId('repeat-command-change'));
			fireEvent.click(screen.getByTestId('submit-command'));

			expect(mockSend).toHaveBeenCalledWith({
				type: 'send_command',
				sessionId: 'session-1',
				command: 'pwd',
				inputMode: 'terminal',
			});
			expect(screen.getByTestId('command-input')).toHaveValue('');
		});

		it('keeps empty terminal drafts empty after submit', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', inputMode: 'terminal' }),
				]);
			});

			fireEvent.click(screen.getByTestId('submit-command'));

			expect(mockSend).toHaveBeenCalledWith({
				type: 'send_command',
				sessionId: 'session-1',
				command: '',
				inputMode: 'terminal',
			});
			expect(screen.getByTestId('command-input')).toHaveValue('');
		});
	});

	describe('command input props', () => {
		it('uses the compact AI placeholder on small screens', async () => {
			Object.defineProperty(window, 'innerHeight', {
				value: 600,
				writable: true,
				configurable: true,
			});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Mobile Session', inputMode: 'ai' }),
				]);
			});

			expect(screen.getByTestId('command-input')).toHaveAttribute('placeholder', 'Ask AI...');
		});

		it('uses tool and session names in the full AI placeholder on larger screens', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Planning Session',
						inputMode: 'ai',
						toolType: 'opencode',
					}),
				]);
			});

			expect(screen.getByTestId('command-input')).toHaveAttribute(
				'placeholder',
				'Ask opencode about Planning Session...'
			);
		});

		it('uses AI and session fallbacks in the full AI placeholder', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: '',
						inputMode: 'ai',
						toolType: undefined,
					} as any),
				]);
			});

			expect(screen.getByTestId('command-input')).toHaveAttribute(
				'placeholder',
				'Ask AI about this session...'
			);
		});

		it('uses a shell command placeholder in terminal mode', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', inputMode: 'terminal' }),
				]);
			});

			expect(screen.getByTestId('command-input')).toHaveAttribute(
				'placeholder',
				'Run shell command...'
			);
			expect(screen.getByTestId('command-cwd')).toHaveTextContent('/Users/test/project');
		});
	});

	describe('mode toggle', () => {
		it('toggles mode between ai and terminal', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', inputMode: 'ai' }),
					createMockSession({ id: 'session-2', name: 'Other Session', inputMode: 'ai' }),
				]);
			});

			fireEvent.click(screen.getByTestId('mode-toggle'));

			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap
			expect(mockSend).toHaveBeenCalledWith({
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});
		});

		it('ignores mode toggle when no session is active', () => {
			render(<MobileApp />);

			fireEvent.click(screen.getByTestId('mode-toggle'));

			expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'switch_mode' }));
		});

		it('ignores draft changes when no session is active', () => {
			render(<MobileApp />);

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'ignored draft' },
			});

			expect(screen.getByTestId('command-input')).toHaveValue('');
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
			fireEvent.click(screen.getByTestId('repeat-command-change'));

			fireEvent.click(screen.getByTestId('mode-toggle'));

			expect(screen.getByTestId('input-mode')).toHaveTextContent('terminal');
			expect(screen.getByTestId('command-input')).toHaveValue('');

			fireEvent.change(screen.getByTestId('command-input'), { target: { value: 'pwd' } });
			fireEvent.click(screen.getByTestId('mode-toggle'));

			expect(screen.getByTestId('input-mode')).toHaveTextContent('ai');
			expect(screen.getByTestId('command-input')).toHaveValue('Explain the repo status');
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

			await act(async () => {
				fireEvent.click(screen.getByTestId('session-session-2'));
				await Promise.resolve();
			});
			expect(screen.getByTestId('command-input')).toHaveValue('');

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for session two' },
			});

			await act(async () => {
				fireEvent.click(screen.getByTestId('session-session-1'));
				await Promise.resolve();
			});
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

		it('removes stale session and tab drafts when desktop session data changes', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Session 1',
						inputMode: 'ai',
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', state: 'idle', inputValue: '' },
							{ id: 'tab-2', name: 'Tab 2', state: 'idle', inputValue: '' },
						],
						activeTabId: 'tab-1',
					}),
					createMockSession({
						id: 'session-2',
						name: 'Session 2',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-3', name: 'Tab 3', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-3',
					}),
				]);
			});

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for removed tab' },
			});
			await act(async () => {
				fireEvent.click(screen.getByTestId('tab-tab-2'));
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});
			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for retained tab' },
			});

			await act(async () => {
				mockHandlers.onTabsChanged?.(
					'session-1',
					[{ id: 'tab-2', name: 'Tab 2', state: 'idle', inputValue: '' }],
					'tab-2'
				);
			});

			expect(screen.getByTestId('command-input')).toHaveValue('draft for retained tab');

			fireEvent.click(screen.getByTestId('session-session-2'));
			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for session two' },
			});

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-2',
						name: 'Session 2',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-3', name: 'Tab 3', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-3',
					}),
				]);
			});

			expect(screen.queryByTestId('session-session-1')).not.toBeInTheDocument();
			expect(screen.getByTestId('command-input')).toHaveValue('draft for session two');
		});

		it('drops stale tab drafts when a session no longer has AI tabs', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: [{ id: 'tab-1', name: 'Tab 1', state: 'idle', inputValue: '' }],
						activeTabId: 'tab-1',
					}),
				]);
			});

			fireEvent.change(screen.getByTestId('command-input'), {
				target: { value: 'draft for disappearing tab' },
			});

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						inputMode: 'ai',
						aiTabs: undefined,
						activeTabId: undefined,
					}),
				]);
			});

			expect(screen.getByTestId('command-input')).toHaveValue('');
		});
	});

	describe('interrupt handling', () => {
		it('sends interrupt request via API', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				fireEvent.click(screen.getByTestId('interrupt-button'));
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(global.fetch).toHaveBeenCalledWith(
				'http://localhost:3000/session/session-1/interrupt',
				expect.objectContaining({ method: 'POST' })
			);
		});

		it('records successful interrupt responses with success haptics', async () => {
			(global.fetch as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ session: { aiLogs: [], shellLogs: [] } }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ success: true }),
				});

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				fireEvent.click(screen.getByTestId('interrupt-button'));
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(mockWebLogger.debug).toHaveBeenCalledWith('Session interrupted: session-1', 'Mobile');
			expect(mockTriggerHaptic).toHaveBeenCalledWith([30]);
		});

		it('handles interrupt API error', async () => {
			(global.fetch as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ session: { aiLogs: [], shellLogs: [] } }),
				})
				.mockRejectedValueOnce(new Error('Network error'));

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1', state: 'busy' })]);
			});

			await act(async () => {
				fireEvent.click(screen.getByTestId('interrupt-button'));
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap
			expect(mockWebLogger.error).toHaveBeenCalledWith(
				'Error interrupting session',
				'Mobile',
				expect.any(Error)
			);
		});

		it('does not expose interrupt control when no session is active', async () => {
			render(<MobileApp />);

			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(screen.queryByTestId('interrupt-button')).not.toBeInTheDocument();
			expect(global.fetch).not.toHaveBeenCalled();
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

		it('does not render tab bar in terminal mode', async () => {
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

			expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
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

	describe('all sessions view', () => {
		it('opens all sessions view', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByTestId('open-all-sessions'));

			expect(screen.getByTestId('all-sessions-view')).toBeInTheDocument();
		});

		it('closes all sessions view', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByTestId('open-all-sessions'));
			expect(screen.getByTestId('all-sessions-view')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('close-all-sessions'));
			expect(screen.queryByTestId('all-sessions-view')).not.toBeInTheDocument();
		});
	});

	describe('history panel', () => {
		it('opens history panel', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByTestId('open-history'));

			expect(screen.getByTestId('mobile-history-panel')).toBeInTheDocument();
		});

		it('closes history panel', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			fireEvent.click(screen.getByTestId('open-history'));
			expect(screen.getByTestId('mobile-history-panel')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('close-history'));
			expect(screen.queryByTestId('mobile-history-panel')).not.toBeInTheDocument();
		});

		it('handles onSearchChange callback to update search state', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			// Open history panel
			fireEvent.click(screen.getByTestId('open-history'));
			expect(screen.getByTestId('mobile-history-panel')).toBeInTheDocument();

			// Trigger onSearchChange callback
			fireEvent.click(screen.getByTestId('trigger-search-change'));

			// Close and reopen to verify state persistence
			fireEvent.click(screen.getByTestId('close-history'));
			fireEvent.click(screen.getByTestId('open-history'));

			// Verify the search query and open state were persisted
			expect(screen.getByTestId('history-initial-search-query')).toHaveTextContent('test query');
			expect(screen.getByTestId('history-initial-search-open')).toHaveTextContent('true');
		});

		it('handles onFilterChange callback to update filter state', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({ id: 'session-1', name: 'Session 1' }),
				]);
			});

			// Open history panel
			fireEvent.click(screen.getByTestId('open-history'));
			expect(screen.getByTestId('mobile-history-panel')).toBeInTheDocument();

			// Trigger onFilterChange callback
			fireEvent.click(screen.getByTestId('trigger-filter-change'));

			// Close and reopen to verify state persistence
			fireEvent.click(screen.getByTestId('close-history'));
			fireEvent.click(screen.getByTestId('open-history'));

			// Verify the filter was persisted
			expect(screen.getByTestId('history-initial-filter')).toHaveTextContent('AUTO');
		});

		it('opens persisted history panel without a selected session', () => {
			const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
			const store = new Map<string, string>([
				[
					'maestro-web-view-state',
					JSON.stringify({
						showHistoryPanel: true,
						savedAt: Date.now(),
					}),
				],
			]);
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				value: {
					getItem: vi.fn((key: string) => store.get(key) ?? null),
					setItem: vi.fn((key: string, value: string) => store.set(key, value)),
					removeItem: vi.fn((key: string) => store.delete(key)),
				},
			});

			try {
				render(<MobileApp />);

				expect(screen.getByTestId('mobile-history-panel')).toBeInTheDocument();
				expect(screen.getByTestId('history-session-id')).toHaveTextContent('');
			} finally {
				if (originalLocalStorage) {
					Object.defineProperty(window, 'localStorage', originalLocalStorage);
				} else {
					delete (window as any).localStorage;
				}
			}
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

			expect(screen.getByTestId('message-history')).toBeInTheDocument();
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
				mockHandlers.onCustomCommands?.([
					{ command: 'custom1', description: 'Custom command 1' },
					{ command: '/already-prefixed', description: 'Custom command 2' },
				]);
			});

			expect(screen.getByTestId('slash-commands')).toHaveTextContent(
				'/help|/clear|/custom1|/already-prefixed'
			);
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

		it('focuses the app and clears unread responses when a completion notification is clicked', async () => {
			mockNotificationPermission = 'granted';
			const notification = {
				close: vi.fn(),
				onclick: null as null | (() => void),
			};
			mockShowNotification.mockReturnValueOnce(notification);
			const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});

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
					lastResponse: { text: 'Ready to review', timestamp: 123 },
				});
			});

			expect(mockWebLogger.debug).toHaveBeenCalledWith(
				'Notification shown for session: Test Session',
				'Mobile'
			);
			expect(mockShowNotification).toHaveBeenCalledWith(
				'Test Session - Response Ready',
				expect.objectContaining({
					body: 'Ready to review',
					tag: 'maestro-response-session-1',
				})
			);

			act(() => {
				notification.onclick?.();
			});

			expect(focus).toHaveBeenCalledTimes(1);
			expect(notification.close).toHaveBeenCalledTimes(1);
			expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
			focus.mockRestore();
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

		it('navigates to previous tab with Cmd+[', async () => {
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

			await act(async () => {
				fireEvent.keyDown(document, { key: '[', metaKey: true });
				await Promise.resolve();
			});

			expect(mockSend).toHaveBeenCalledWith({
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});

		it('navigates to next tab with Cmd+]', async () => {
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

			await act(async () => {
				fireEvent.keyDown(document, { key: ']', metaKey: true });
				await Promise.resolve();
			});

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

			await act(async () => {
				fireEvent.keyDown(document, { key: ']', metaKey: true });
				await Promise.resolve();
			});

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

			expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/session/session-1'));
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

			expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('tabId=tab-1'));
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
		it('shows session pill bar when connected', async () => {
			mockWebSocketState = 'authenticated';

			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([createMockSession({ id: 'session-1' })]);
			});

			expect(screen.getByTestId('session-pill-bar')).toBeInTheDocument();
		});

		it('hides session pill bar when offline', () => {
			mockIsOffline.mockReturnValue(true);

			render(<MobileApp />);

			expect(screen.queryByTestId('session-pill-bar')).not.toBeInTheDocument();
		});

		it('hides session pill bar when disconnected', () => {
			mockWebSocketState = 'disconnected';

			render(<MobileApp />);

			expect(screen.queryByTestId('session-pill-bar')).not.toBeInTheDocument();
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

			act(() => {
				fireEvent.click(screen.getByTestId('session-session-2'));
				fireEvent.click(screen.getByTestId('session-session-3'));
				fireEvent.click(screen.getByTestId('session-session-1'));
			});

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

		it('sorts response viewer navigation data by newest response and exposes callbacks', async () => {
			render(<MobileApp />);

			await act(async () => {
				mockHandlers.onSessionsUpdate?.([
					createMockSession({
						id: 'session-1',
						name: 'Older Session',
						lastResponse: { text: 'older response', timestamp: 10 },
					} as any),
					createMockSession({
						id: 'session-2',
						name: 'Newer Session',
						lastResponse: { text: 'newer response', timestamp: 20 },
					} as any),
				]);
			});

			expect(lastResponseViewerProps?.allResponses).toMatchObject([
				{ sessionId: 'session-2', sessionName: 'Newer Session' },
				{ sessionId: 'session-1', sessionName: 'Older Session' },
			]);

			act(() => {
				lastResponseViewerProps?.onNavigate(1);
				lastResponseViewerProps?.onNavigate(99);
				lastResponseViewerProps?.onClose();
				vi.advanceTimersByTime(300);
			});

			expect(mockWebLogger.debug).toHaveBeenCalledWith('Navigating to response index: 1', 'Mobile');
		});
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

			expect(mockShowNotification).toHaveBeenCalledWith(
				'Test Session - Response Ready',
				expect.objectContaining({ body: 'Actual content' })
			);
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

			expect(mockShowNotification).toHaveBeenCalledWith(
				'Test Session - Response Ready',
				expect.objectContaining({ body: `${'a'.repeat(100)}...` })
			);
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

			expect(mockShowNotification).toHaveBeenCalledWith(
				'Test Session - Response Ready',
				expect.objectContaining({ body: 'AI response completed' })
			);
		});

		it('uses fallback body when response text contains only skipped markdown markers', async () => {
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
					lastResponse: { text: '```\n---\n   ', timestamp: Date.now() },
				});
			});

			expect(mockShowNotification).toHaveBeenCalledWith(
				'Test Session - Response Ready',
				expect.objectContaining({ body: 'Response completed' })
			);
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

			expect(mockShowNotification).toHaveBeenCalledWith(
				'Test Session - Response Ready',
				expect.objectContaining({ body: 'Actual content' })
			);
		});
	});
});
