import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MobileApp from '../../web/mobile/App';
import { ThemeProvider } from '../../web/components/ThemeProvider';
import type { Session } from '../../web/hooks/useSessions';
import type { AITabData, AutoRunState } from '../../web/hooks/useWebSocket';

const mocks = vi.hoisted(() => {
	const triggerHaptic = vi.fn();
	const connect = vi.fn();
	const send = vi.fn(() => true);
	const sendRequest = vi.fn(async () => ({}));
	const setSessions = vi.fn();
	const setActiveSessionId = vi.fn();
	const handleSelectSession = vi.fn();
	const handleSelectTab = vi.fn();
	const handleNewTab = vi.fn();
	const handleCloseTab = vi.fn();
	const handleRenameTab = vi.fn();
	const handleStarTab = vi.fn();
	const handleReorderTab = vi.fn();
	const handleToggleBookmark = vi.fn();
	const addUserLogEntry = vi.fn();
	const persistViewState = vi.fn();
	const persistHistoryState = vi.fn();
	const persistSessionSelection = vi.fn();
	const showNotification = vi.fn();
	const addUnread = vi.fn();
	const markAllRead = vi.fn();
	const queueCommand = vi.fn(() => true);
	const removeCommand = vi.fn();
	const clearQueue = vi.fn();
	const processQueue = vi.fn();
	const setDesktopTheme = vi.fn();
	const setDesktopBionifyReadingMode = vi.fn();
	const goToDashboard = vi.fn();
	const keyboardHandler = vi.fn();
	const webLogger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};

	return {
		triggerHaptic,
		connect,
		send,
		sendRequest,
		setSessions,
		setActiveSessionId,
		handleSelectSession,
		handleSelectTab,
		handleNewTab,
		handleCloseTab,
		handleRenameTab,
		handleStarTab,
		handleReorderTab,
		handleToggleBookmark,
		addUserLogEntry,
		persistViewState,
		persistHistoryState,
		persistSessionSelection,
		showNotification,
		addUnread,
		markAllRead,
		queueCommand,
		removeCommand,
		clearQueue,
		processQueue,
		setDesktopTheme,
		setDesktopBionifyReadingMode,
		goToDashboard,
		keyboardHandler,
		webLogger,
		main: {
			isOffline: false,
			isSession: false,
			bionifyReadingMode: false,
		},
		viewState: {
			isSmallScreen: false,
			savedState: {
				showAllSessions: false,
				showHistoryPanel: false,
				showTabSearch: false,
				historyFilter: 'all' as const,
				historySearchQuery: '',
				historySearchOpen: false,
				activeSessionId: null as string | null,
				activeTabId: null as string | null,
			},
			savedScrollState: {},
		},
		webSocket: {
			state: 'authenticated' as const,
			error: null as string | null,
			reconnectAttempts: 0,
		},
		autoReconnect: {
			reconnectCountdown: 0,
		},
		notifications: {
			permission: 'default' as NotificationPermission,
		},
		offlineQueue: {
			queue: [] as Array<{ id: string; sessionId: string; command: string }>,
			queueLength: 0,
			status: 'idle' as const,
		},
		sessionManagement: {} as any,
		lastSessionDeps: null as any,
		lastNotificationOptions: null as any,
		lastUnreadOptions: null as any,
		lastOfflineQueueOptions: null as any,
	};
});

vi.mock('../../web/mobile/constants', async () => {
	const actual = await vi.importActual<typeof import('../../web/mobile/constants')>(
		'../../web/mobile/constants'
	);
	return {
		...actual,
		HAPTIC_PATTERNS: {
			...actual.HAPTIC_PATTERNS,
			tap: 10,
			send: 20,
			success: [10, 20],
		},
		triggerHaptic: mocks.triggerHaptic,
	};
});

vi.mock('../../web/utils/logger', () => ({
	webLogger: mocks.webLogger,
}));

vi.mock('../../web/utils/config', async () => {
	const actual =
		await vi.importActual<typeof import('../../web/utils/config')>('../../web/utils/config');
	return {
		...actual,
		buildApiUrl: (path: string) => `/api${path}`,
	};
});

vi.mock('../../web/main', () => ({
	useOfflineStatus: () => mocks.main.isOffline,
	useMaestroMode: () => ({
		isDashboard: !mocks.main.isSession,
		isSession: mocks.main.isSession,
		sessionId: mocks.sessionManagement.activeSessionId ?? null,
		tabId: mocks.sessionManagement.activeTabId ?? null,
		securityToken: 'token-1',
		goToDashboard: mocks.goToDashboard,
		goToSession: vi.fn(),
		updateUrl: vi.fn(),
	}),
	useDesktopTheme: () => ({
		desktopTheme: null,
		bionifyReadingMode: mocks.main.bionifyReadingMode,
		setDesktopTheme: mocks.setDesktopTheme,
		setDesktopBionifyReadingMode: mocks.setDesktopBionifyReadingMode,
	}),
}));

vi.mock('../../web/hooks/useNotifications', () => ({
	useNotifications: (options: any) => {
		mocks.lastNotificationOptions = options;
		return {
			permission: mocks.notifications.permission,
			showNotification: mocks.showNotification,
		};
	},
}));

vi.mock('../../web/hooks/useUnreadBadge', () => ({
	useUnreadBadge: (options: any) => {
		mocks.lastUnreadOptions = options;
		return {
			addUnread: mocks.addUnread,
			markAllRead: mocks.markAllRead,
			unreadCount: 0,
		};
	},
}));

vi.mock('../../web/hooks/useOfflineQueue', () => ({
	useOfflineQueue: (options: any) => {
		mocks.lastOfflineQueueOptions = options;
		return {
			queue: mocks.offlineQueue.queue,
			queueLength: mocks.offlineQueue.queueLength,
			status: mocks.offlineQueue.status,
			queueCommand: mocks.queueCommand,
			removeCommand: mocks.removeCommand,
			clearQueue: mocks.clearQueue,
			processQueue: mocks.processQueue,
		};
	},
}));

vi.mock('../../web/hooks/useWebSocket', () => ({
	useWebSocket: () => ({
		state: mocks.webSocket.state,
		connect: mocks.connect,
		send: mocks.send,
		sendRequest: mocks.sendRequest,
		error: mocks.webSocket.error,
		reconnectAttempts: mocks.webSocket.reconnectAttempts,
	}),
}));

vi.mock('../../web/hooks/useMobileViewState', () => ({
	useMobileViewState: () => ({
		isSmallScreen: mocks.viewState.isSmallScreen,
		savedState: mocks.viewState.savedState,
		savedScrollState: mocks.viewState.savedScrollState,
		persistViewState: mocks.persistViewState,
		persistHistoryState: mocks.persistHistoryState,
		persistSessionSelection: mocks.persistSessionSelection,
	}),
}));

vi.mock('../../web/hooks/useMobileAutoReconnect', () => ({
	useMobileAutoReconnect: () => mocks.autoReconnect,
}));

vi.mock('../../web/hooks/useMobileKeyboardHandler', () => ({
	useMobileKeyboardHandler: mocks.keyboardHandler,
}));

vi.mock('../../web/hooks/useMobileSessionManagement', () => ({
	useMobileSessionManagement: (deps: any) => {
		mocks.lastSessionDeps = deps;
		return mocks.sessionManagement;
	},
}));

vi.mock('../../web/mobile/SessionPillBar', () => ({
	SessionPillBar: (props: any) => (
		<div data-testid="session-pill-bar">
			<button onClick={() => props.onSelectSession('session-2')}>select session</button>
			<button onClick={props.onOpenAllSessions}>all sessions</button>
			<button onClick={props.onOpenHistory}>history</button>
			<button onClick={() => props.onToggleBookmark('session-1')}>bookmark</button>
		</div>
	),
	default: (props: any) => <div data-testid="session-pill-bar-default" {...props} />,
}));

vi.mock('../../web/mobile/AllSessionsView', () => ({
	AllSessionsView: (props: any) => (
		<div data-testid="all-sessions-view">
			<button onClick={() => props.onSelectSession('session-1')}>select from all</button>
			<button onClick={props.onClose}>close all sessions</button>
		</div>
	),
}));

vi.mock('../../web/mobile/MobileHistoryPanel', () => ({
	MobileHistoryPanel: (props: any) => (
		<div data-testid="history-panel" data-session-id={props.sessionId ?? 'none'}>
			<button onClick={() => props.onFilterChange('AUTO')}>filter auto</button>
			<button onClick={() => props.onSearchChange('deploy', true)}>search history</button>
			<button onClick={props.onClose}>close history</button>
		</div>
	),
}));

vi.mock('../../web/mobile/CommandInputBar', () => ({
	CommandInputBar: (props: any) => (
		<div data-testid="command-input-bar">
			<input
				aria-label="mobile command"
				value={props.value}
				placeholder={props.placeholder}
				disabled={props.disabled}
				onChange={(event) => props.onChange(event.currentTarget.value)}
			/>
			<button onClick={() => props.onChange(props.value)}>repeat change</button>
			<button onClick={() => props.onSubmit(props.value || 'typed command')}>submit</button>
			<button onClick={() => props.onInterrupt?.()}>interrupt</button>
			<div data-testid="slash-commands">
				{props.slashCommands.map((command: any) => command.command).join('|')}
			</div>
		</div>
	),
}));

vi.mock('../../web/mobile/WebTerminal', () => ({
	WebTerminal: (props: any) => (
		<div data-testid="web-terminal">
			<button onClick={() => props.onData('pwd')}>terminal data</button>
		</div>
	),
}));

vi.mock('../../web/mobile/ResponseViewer', () => ({
	ResponseViewer: (props: any) => (
		<div data-testid="response-viewer" data-open={String(props.isOpen)}>
			<div data-testid="response-list">
				{props.allResponses?.map((item: any) => item.sessionName).join('|') || 'single'}
			</div>
			<div data-testid="response-current">{props.response?.text || ''}</div>
			<button onClick={() => props.onNavigate?.(1)}>next response</button>
			<button onClick={() => props.onNavigate?.(-1)}>invalid response</button>
			<button onClick={props.onClose}>close response</button>
		</div>
	),
	default: (props: any) => <div data-testid="response-viewer-default" {...props} />,
}));

vi.mock('../../web/mobile/OfflineQueueBanner', () => ({
	OfflineQueueBanner: (props: any) => (
		<div data-testid="offline-queue-banner">
			<button onClick={props.onClearQueue}>clear queue</button>
			<button onClick={props.onProcessQueue}>process queue</button>
			<button onClick={() => props.onRemoveCommand('queued-1')}>remove queued</button>
		</div>
	),
}));

vi.mock('../../web/mobile/MessageHistory', () => ({
	MessageHistory: (props: any) => (
		<div data-testid="message-history">{props.logs.map((log: any) => log.text).join('|')}</div>
	),
}));

vi.mock('../../web/mobile/AutoRunIndicator', () => ({
	AutoRunIndicator: (props: any) => <div data-testid="autorun-indicator">{props.sessionName}</div>,
}));

vi.mock('../../web/mobile/TabBar', () => ({
	TabBar: (props: any) => (
		<div data-testid="tab-bar">
			<button onClick={() => props.onSelectTab('tab-2')}>select tab</button>
			<button onClick={props.onNewTab}>new tab</button>
			<button onClick={() => props.onCloseTab('tab-2')}>close tab</button>
			<button onClick={props.onOpenTabSearch}>search tabs</button>
			<button onClick={() => props.onRenameTab('tab-1', 'Renamed')}>rename tab</button>
			<button onClick={() => props.onStarTab('tab-1')}>star tab</button>
			<button onClick={() => props.onReorderTab(0, 1)}>reorder tab</button>
		</div>
	),
}));

vi.mock('../../web/mobile/TabSearchModal', () => ({
	TabSearchModal: (props: any) => (
		<div data-testid="tab-search-modal">
			<button onClick={() => props.onSelectTab('tab-1')}>select searched tab</button>
			<button onClick={props.onClose}>close tab search</button>
		</div>
	),
}));

function tab(overrides: Partial<AITabData> = {}): AITabData {
	return {
		id: 'tab-1',
		name: 'Main',
		agentSessionId: 'agent-123456789',
		state: 'busy',
		starred: false,
		inputValue: '',
		createdAt: 1,
		usageStats: {
			inputTokens: 1000,
			outputTokens: 500,
			totalCostUsd: 0.42,
		},
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Mobile Session',
		toolType: 'claude-code',
		state: 'busy',
		inputMode: 'ai',
		cwd: '/workspace/project',
		aiTabs: [tab(), tab({ id: 'tab-2', name: 'Second', state: 'idle' })],
		activeTabId: 'tab-1',
		bookmarked: false,
		lastResponse: {
			text: 'Latest response',
			timestamp: 42,
		},
		...overrides,
	} as Session;
}

function resetMocks() {
	const activeSession = session();
	mocks.main.isOffline = false;
	mocks.main.isSession = true;
	mocks.main.bionifyReadingMode = true;
	mocks.viewState.isSmallScreen = false;
	mocks.viewState.savedState = {
		showAllSessions: false,
		showHistoryPanel: false,
		showTabSearch: false,
		historyFilter: 'all',
		historySearchQuery: '',
		historySearchOpen: false,
		activeSessionId: 'session-1',
		activeTabId: 'tab-1',
	};
	mocks.webSocket.state = 'authenticated';
	mocks.webSocket.error = null;
	mocks.webSocket.reconnectAttempts = 0;
	mocks.autoReconnect.reconnectCountdown = 0;
	mocks.notifications.permission = 'default';
	mocks.offlineQueue.queue = [];
	mocks.offlineQueue.queueLength = 0;
	mocks.offlineQueue.status = 'idle';
	mocks.lastSessionDeps = null;
	mocks.lastNotificationOptions = null;
	mocks.lastUnreadOptions = null;
	mocks.lastOfflineQueueOptions = null;
	mocks.sessionManagement = {
		sessions: [activeSession],
		setSessions: mocks.setSessions,
		activeSessionId: 'session-1',
		setActiveSessionId: mocks.setActiveSessionId,
		activeTabId: 'tab-1',
		activeSession,
		sessionLogs: {
			aiLogs: [{ id: 'ai-1', timestamp: 1, text: 'AI response', source: 'stdout' }],
			shellLogs: [{ id: 'sh-1', timestamp: 2, text: 'shell output', source: 'stdout' }],
		},
		isLoadingLogs: false,
		handleSelectSession: mocks.handleSelectSession,
		handleSelectTab: mocks.handleSelectTab,
		handleNewTab: mocks.handleNewTab,
		handleCloseTab: mocks.handleCloseTab,
		handleRenameTab: mocks.handleRenameTab,
		handleStarTab: mocks.handleStarTab,
		handleReorderTab: mocks.handleReorderTab,
		handleToggleBookmark: mocks.handleToggleBookmark,
		addUserLogEntry: mocks.addUserLogEntry,
		sessionsHandlers: { session_update: vi.fn() },
	};
	for (const fn of [
		mocks.triggerHaptic,
		mocks.connect,
		mocks.send,
		mocks.setSessions,
		mocks.setActiveSessionId,
		mocks.handleSelectSession,
		mocks.handleSelectTab,
		mocks.handleNewTab,
		mocks.handleCloseTab,
		mocks.handleRenameTab,
		mocks.handleStarTab,
		mocks.handleReorderTab,
		mocks.handleToggleBookmark,
		mocks.addUserLogEntry,
		mocks.persistViewState,
		mocks.persistHistoryState,
		mocks.persistSessionSelection,
		mocks.showNotification,
		mocks.addUnread,
		mocks.markAllRead,
		mocks.queueCommand,
		mocks.removeCommand,
		mocks.clearQueue,
		mocks.processQueue,
		mocks.setDesktopTheme,
		mocks.setDesktopBionifyReadingMode,
		mocks.goToDashboard,
		mocks.keyboardHandler,
		mocks.webLogger.debug,
		mocks.webLogger.info,
		mocks.webLogger.warn,
		mocks.webLogger.error,
	]) {
		fn.mockClear();
	}
	mocks.send.mockReturnValue(true);
	mocks.queueCommand.mockReturnValue(true);
}

function renderApp() {
	return render(
		<ThemeProvider>
			<MobileApp />
		</ThemeProvider>
	);
}

describe('MobileApp integration', () => {
	const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
	const originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState');

	beforeEach(() => {
		resetMocks();
		window.__MAESTRO_CONFIG__ = {
			securityToken: 'token-1',
			apiBase: '/token-1/api',
			wsUrl: '/token-1/ws',
			sessionId: 'session-1',
			tabId: 'tab-1',
		};
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ success: true }),
			})
		);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (originalVisibility) {
			Object.defineProperty(document, 'visibilityState', originalVisibility);
		}
		if (originalReadyState) {
			Object.defineProperty(document, 'readyState', originalReadyState);
		}
		delete window.__MAESTRO_CONFIG__;
	});

	it('renders connection states and retries disconnected sessions', () => {
		mocks.webSocket.state = 'disconnected';
		mocks.webSocket.error = 'Lost socket';
		mocks.webSocket.reconnectAttempts = 2;
		mocks.autoReconnect.reconnectCountdown = 7;

		renderApp();

		expect(screen.getByText('Connection Lost')).toBeInTheDocument();
		expect(screen.getByText('Lost socket')).toBeInTheDocument();
		expect(screen.getByText('Reconnecting in 7s... (attempt 2)')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Retry Now' }));
		expect(mocks.connect).toHaveBeenCalledOnce();
		expect(screen.getByText('Make sure Maestro desktop app is running')).toBeInTheDocument();
	});

	it('renders offline, connecting, and empty authenticated states', () => {
		mocks.main.isOffline = true;
		const { rerender } = renderApp();

		expect(screen.getByText("You're Offline")).toBeInTheDocument();

		mocks.main.isOffline = false;
		mocks.webSocket.state = 'connecting';
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByText('Connecting to Maestro...')).toBeInTheDocument();

		mocks.webSocket.state = 'authenticated';
		mocks.sessionManagement.activeSession = null;
		mocks.sessionManagement.activeSessionId = null;
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByText('Select a session above to get started')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Select a session first...')).toBeDisabled();
	});

	it('routes connected session actions through App state and desktop bridges', async () => {
		mocks.offlineQueue.queue = [{ id: 'queued-1', sessionId: 'session-1', command: 'queued' }];
		mocks.offlineQueue.queueLength = 1;
		mocks.sessionManagement.activeSession = {
			...mocks.sessionManagement.activeSession,
			inputMode: 'ai',
		};

		renderApp();

		expect(screen.getAllByText('Mobile Session').length).toBeGreaterThan(0);
		expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
		expect(screen.getByTestId('offline-queue-banner')).toBeInTheDocument();
		expect(screen.getByTestId('message-history')).toHaveTextContent('AI response');

		const keyboardOptions = mocks.keyboardHandler.mock.calls.at(-1)?.[0];
		expect(keyboardOptions).toBeDefined();

		act(() => {
			keyboardOptions.actions.agentSessions();
		});
		expect(screen.getByTestId('all-sessions-view')).toBeInTheDocument();
		fireEvent.click(screen.getByText('select from all'));
		expect(mocks.handleSelectSession).toHaveBeenCalledWith('session-1');
		fireEvent.click(screen.getByText('close all sessions'));
		expect(screen.queryByTestId('all-sessions-view')).not.toBeInTheDocument();

		act(() => {
			keyboardOptions.actions.goToHistory();
		});
		expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				'/api/history?projectPath=%2Fworkspace%2Fproject&sessionId=session-1'
			)
		);
		fireEvent.click(screen.getByLabelText('Close panel'));
		expect(screen.queryByRole('tab', { name: 'History' })).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('search tabs'));
		expect(screen.getByTestId('tab-search-modal')).toBeInTheDocument();
		fireEvent.click(screen.getByText('select searched tab'));
		expect(mocks.handleSelectTab).toHaveBeenCalledWith('tab-1');
		fireEvent.click(screen.getByText('close tab search'));

		fireEvent.click(screen.getByText('select tab'));
		fireEvent.click(screen.getByText('new tab'));
		fireEvent.click(screen.getByText('close tab'));
		fireEvent.click(screen.getByText('rename tab'));
		fireEvent.click(screen.getByText('star tab'));
		fireEvent.click(screen.getByText('reorder tab'));
		expect(mocks.handleSelectTab).toHaveBeenCalledWith('tab-2');
		expect(mocks.handleNewTab).toHaveBeenCalledOnce();
		expect(mocks.handleCloseTab).toHaveBeenCalledWith('tab-2');
		expect(mocks.handleRenameTab).toHaveBeenCalledWith('tab-1', 'Renamed');
		expect(mocks.handleStarTab).toHaveBeenCalledWith('tab-1');
		expect(mocks.handleReorderTab).toHaveBeenCalledWith(0, 1);

		fireEvent.change(screen.getByLabelText('mobile command'), {
			target: { value: 'ship it' },
		});
		fireEvent.click(screen.getByText('submit'));
		expect(mocks.addUserLogEntry).toHaveBeenCalledWith('ship it', 'ai', undefined);
		expect(mocks.send).toHaveBeenCalledWith({
			type: 'send_command',
			sessionId: 'session-1',
			command: 'ship it',
			inputMode: 'ai',
		});

		act(() => {
			keyboardOptions.actions.toggleMode();
		});
		expect(mocks.send).toHaveBeenCalledWith({
			type: 'switch_mode',
			sessionId: 'session-1',
			mode: 'terminal',
		});
		expect(mocks.setSessions).toHaveBeenCalled();
		const updateSessions = mocks.setSessions.mock.calls.at(-1)?.[0];
		expect(updateSessions([mocks.sessionManagement.activeSession])[0].inputMode).toBe('terminal');

		fireEvent.click(screen.getByText('clear queue'));
		fireEvent.click(screen.getByText('process queue'));
		fireEvent.click(screen.getByText('remove queued'));
		expect(mocks.clearQueue).toHaveBeenCalledOnce();
		expect(mocks.processQueue).toHaveBeenCalledOnce();
		expect(mocks.removeCommand).toHaveBeenCalledWith('queued-1');

		fireEvent.click(screen.getByText('interrupt'));
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith('/api/session/session-1/interrupt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			})
		);
	});

	it('wires hook callbacks into notifications, offline queue, autorun, and custom commands', async () => {
		const secondSession = session({
			id: 'session-2',
			name: 'Review Session',
			lastResponse: {
				text: 'Older response',
				timestamp: 12,
			},
		});
		mocks.sessionManagement.sessions = [mocks.sessionManagement.activeSession, secondSession];

		renderApp();

		act(() => {
			mocks.lastNotificationOptions.onGranted();
			mocks.lastNotificationOptions.onDenied();
			mocks.lastUnreadOptions.onCountChange(3);
		});
		expect(mocks.webLogger.debug).toHaveBeenCalledWith('Notification permission granted', 'Mobile');
		expect(mocks.webLogger.debug).toHaveBeenCalledWith('Notification permission denied', 'Mobile');
		expect(mocks.webLogger.debug).toHaveBeenCalledWith('Unread response count: 3', 'Mobile');

		expect(mocks.lastOfflineQueueOptions.sendCommand('session-1', 'queued command')).toBe(true);
		expect(mocks.send).toHaveBeenCalledWith({
			type: 'send_command',
			sessionId: 'session-1',
			command: 'queued command',
		});

		mocks.lastOfflineQueueOptions.onCommandSent({ command: 'sent from queue' });
		mocks.lastOfflineQueueOptions.onCommandFailed(
			{ command: 'failed from queue' },
			new Error('offline')
		);
		mocks.lastOfflineQueueOptions.onProcessingStart();
		mocks.lastOfflineQueueOptions.onProcessingComplete(1, 0);
		expect(mocks.webLogger.debug).toHaveBeenCalledWith(
			'Queued command sent: sent from queue',
			'Mobile'
		);
		expect(mocks.webLogger.error).toHaveBeenCalledWith(
			'Queued command failed: failed from queue',
			'Mobile',
			expect.any(Error)
		);
		expect(mocks.webLogger.debug).toHaveBeenCalledWith('Processing offline queue...', 'Mobile');
		expect(mocks.triggerHaptic).toHaveBeenCalledWith([10, 20]);
		mocks.triggerHaptic.mockClear();
		mocks.lastOfflineQueueOptions.onProcessingComplete(0, 1);
		expect(mocks.triggerHaptic).not.toHaveBeenCalledWith([10, 20]);

		act(() => {
			mocks.lastSessionDeps.onAutoRunStateChange('session-1', {
				isRunning: true,
				totalTasks: 2,
				completedTasks: 1,
			} as AutoRunState);
			mocks.lastSessionDeps.onCustomCommands([
				{ command: 'deploy', description: 'Deploy project' },
				{ command: '/already', description: 'Already prefixed' },
			]);
		});
		expect(await screen.findByTestId('autorun-indicator')).toHaveTextContent('Mobile Session');
		expect(screen.getByTestId('slash-commands')).toHaveTextContent('/deploy');
		expect(screen.getByTestId('slash-commands')).toHaveTextContent('/already');
		expect(screen.getByTestId('response-list')).toHaveTextContent('Mobile Session|Review Session');

		fireEvent.click(screen.getByText('next response'));
		expect(screen.getByTestId('response-current')).toHaveTextContent('Older response');
		fireEvent.click(screen.getByText('invalid response'));
		expect(screen.getByTestId('response-current')).toHaveTextContent('Older response');

		vi.useFakeTimers();
		fireEvent.click(screen.getByText('close response'));
		act(() => {
			vi.advanceTimersByTime(300);
		});
	});

	it('handles visible response completion and notification fallback bodies', () => {
		renderApp();

		act(() => {
			mocks.lastSessionDeps.onResponseComplete(session(), {
				text: 'Visible response',
				timestamp: 999,
			});
		});
		expect(mocks.addUnread).not.toHaveBeenCalledWith('session-1-999');

		cleanup();
		resetMocks();
		mocks.notifications.permission = 'granted';
		mocks.showNotification.mockReturnValue(null);
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			value: 'hidden',
		});
		renderApp();

		act(() => {
			mocks.lastSessionDeps.onResponseComplete(session(), undefined);
		});
		expect(mocks.addUnread).toHaveBeenCalledWith(expect.stringMatching(/^session-1-/));
		expect(mocks.showNotification).toHaveBeenCalledWith(
			'Mobile Session - Response Ready',
			expect.objectContaining({
				body: 'AI response completed',
				tag: 'maestro-response-session-1',
			})
		);
		expect(mocks.setActiveSessionId).not.toHaveBeenCalled();
	});

	it('keeps command drafts stable for repeated values and empty clears', () => {
		const { rerender } = renderApp();
		const input = screen.getByLabelText('mobile command');

		fireEvent.change(input, { target: { value: 'draft once' } });
		fireEvent.click(screen.getByText('repeat change'));
		fireEvent.click(screen.getByText('submit'));
		fireEvent.click(screen.getByText('submit'));
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'draft once',
				inputMode: 'ai',
			})
		);

		mocks.sessionManagement.activeSession = session({
			inputMode: 'terminal',
			state: 'idle',
			aiTabs: [tab({ state: 'idle' })],
		});
		mocks.sessionManagement.sessionLogs = { aiLogs: [], shellLogs: [] };
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);

		expect(screen.getByTestId('web-terminal')).toBeInTheDocument();
		expect(screen.queryByLabelText('mobile command')).not.toBeInTheDocument();
	});

	it('prunes command drafts when sessions or active tabs disappear', () => {
		const { rerender } = renderApp();

		fireEvent.change(screen.getByLabelText('mobile command'), {
			target: { value: 'tab draft' },
		});

		mocks.sessionManagement.activeSession = session({
			aiTabs: [tab({ id: 'tab-2', name: 'Replacement tab' })],
			activeTabId: 'tab-2',
		});
		mocks.sessionManagement.sessions = [mocks.sessionManagement.activeSession];
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByLabelText('mobile command')).toHaveValue('');

		mocks.sessionManagement.sessions = [];
		mocks.sessionManagement.activeSession = null;
		mocks.sessionManagement.activeSessionId = null;
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		fireEvent.click(screen.getByText('repeat change'));
		expect(screen.getByPlaceholderText('Select a session first...')).toBeDisabled();
	});

	it('renders loading, empty, terminal, and header state variants', () => {
		mocks.sessionManagement.isLoadingLogs = true;
		const { rerender } = renderApp();
		expect(screen.getByText('Loading conversation...')).toBeInTheDocument();

		mocks.sessionManagement.isLoadingLogs = false;
		mocks.sessionManagement.sessionLogs = { aiLogs: [], shellLogs: [] };
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByText('Ask your AI assistant anything')).toBeInTheDocument();

		mocks.sessionManagement.activeSession = session({
			inputMode: 'terminal',
			state: 'idle',
			aiTabs: [tab({ state: 'idle' })],
		});
		mocks.sessionManagement.sessionLogs = {
			aiLogs: [],
			shellLogs: [{ id: 'shell-2', timestamp: 3, text: 'pwd output', source: 'stdout' }],
		};
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByTitle('Session idle')).toBeInTheDocument();
		expect(screen.getByTestId('web-terminal')).toBeInTheDocument();
		fireEvent.click(screen.getByText('terminal data'));
		expect(mocks.send).toHaveBeenCalledWith({
			type: 'terminal_write',
			sessionId: 'session-1',
			data: 'pwd',
		});

		mocks.sessionManagement.sessionLogs = { aiLogs: [], shellLogs: [] };
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByTestId('web-terminal')).toBeInTheDocument();

		mocks.sessionManagement.activeSession = session({
			aiTabs: [tab({ state: 'error' })],
			activeTabId: 'tab-1',
		});
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByTitle('Session error')).toBeInTheDocument();

		mocks.sessionManagement.activeSession = session({
			aiTabs: [tab({ state: 'connecting' })],
			activeTabId: 'tab-1',
		});
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByTitle('Session connecting')).toBeInTheDocument();
	});

	it('renders compact and non-Claude AI placeholders', () => {
		mocks.viewState.isSmallScreen = true;
		const { rerender } = renderApp();
		expect(screen.getByPlaceholderText('Ask AI...')).toBeInTheDocument();

		mocks.viewState.isSmallScreen = false;
		mocks.sessionManagement.activeSession = session({
			name: '',
			toolType: 'codex',
		});
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByPlaceholderText('Ask codex about this session...')).toBeInTheDocument();

		mocks.sessionManagement.activeSession = session({
			name: '',
			toolType: '' as Session['toolType'],
		});
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByPlaceholderText('Ask AI about this session...')).toBeInTheDocument();
	});

	it('renders dashboard header state without session metadata chips', () => {
		mocks.main.isSession = false;
		mocks.sessionManagement.activeSession = session({
			agentSessionId: 'session-agent-987654321',
			activeTabId: null,
			aiTabs: [tab({ agentSessionId: null, usageStats: undefined })],
			state: 'idle',
			usageStats: {
				inputTokens: 150,
				outputTokens: 50,
				totalCostUsd: 0.05,
			},
		});

		renderApp();

		expect(screen.getByText('Mobile Session')).toBeInTheDocument();
		expect(screen.getByTitle('Session idle')).toBeInTheDocument();
		expect(screen.queryByTitle('Claude Session: session-agent-987654321')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Session cost: $0.05')).not.toBeInTheDocument();
		expect(mocks.goToDashboard).not.toHaveBeenCalled();
	});

	it('renders missing-tab command input fallbacks without context chips', () => {
		mocks.sessionManagement.activeSession = session({
			activeTabId: 'missing-tab',
			state: 'idle',
			usageStats: {
				inputTokens: 190000,
				totalCostUsd: 0.1,
			},
		});
		const { rerender } = renderApp();

		expect(screen.getByTitle('Session idle')).toBeInTheDocument();
		expect(screen.queryByTitle('Context: 95%')).not.toBeInTheDocument();
		expect(screen.getByLabelText('mobile command')).toHaveValue('');

		mocks.sessionManagement.activeSession = session({
			activeTabId: 'missing-tab',
			state: 'idle',
			usageStats: {
				inputTokens: 150000,
				totalCostUsd: 0.1,
			},
		});
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.queryByTitle('Context: 75%')).not.toBeInTheDocument();
		expect(screen.getByLabelText('mobile command')).toHaveValue('');
	});

	it('uses tab input fallbacks and preserves other sessions during mode switches', () => {
		const untouchedSession = session({ id: 'session-2', name: 'Untouched' });
		mocks.sessionManagement.sessions = [mocks.sessionManagement.activeSession, untouchedSession];
		mocks.sessionManagement.activeSession = session({
			activeTabId: null,
			aiTabs: [tab({ id: 'tab-1', inputValue: 'tab draft fallback' })],
		});
		mocks.sessionManagement.activeTabId = 'tab-1';
		const { rerender } = renderApp();

		expect(screen.getByLabelText('mobile command')).toHaveValue('tab draft fallback');
		const keyboardOptions = mocks.keyboardHandler.mock.calls.at(-1)?.[0];
		expect(keyboardOptions).toBeDefined();
		act(() => {
			keyboardOptions.actions.toggleMode();
		});
		const updateSessions = mocks.setSessions.mock.calls.at(-1)?.[0];
		const updated = updateSessions([mocks.sessionManagement.activeSession, untouchedSession]);
		expect(updated.find((item: Session) => item.id === 'session-2')?.inputMode).toBe(
			untouchedSession.inputMode
		);

		mocks.sessionManagement.activeSession = session({ inputMode: 'terminal' });
		mocks.sessionManagement.activeSessionId = 'missing-session';
		mocks.sessionManagement.sessionLogs = { aiLogs: [], shellLogs: [] };
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByTestId('web-terminal')).toBeInTheDocument();
		fireEvent.click(screen.getByText('terminal data'));
		expect(mocks.send).toHaveBeenCalledWith({
			type: 'terminal_write',
			sessionId: 'missing-session',
			data: 'pwd',
		});
	});

	it('uses session-level AI drafts when no tab is active', () => {
		mocks.sessionManagement.activeSession = session({
			activeTabId: null,
			aiTabs: [tab({ id: 'tab-1', inputValue: 'tab draft' })],
		});
		mocks.sessionManagement.activeTabId = null;
		const { rerender } = renderApp();

		expect(screen.getByLabelText('mobile command')).toHaveValue('');
		fireEvent.change(screen.getByLabelText('mobile command'), {
			target: { value: 'session-level draft' },
		});
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByLabelText('mobile command')).toHaveValue('session-level draft');
	});

	it('prunes tab drafts when a session has no tab list', () => {
		const { rerender } = renderApp();

		fireEvent.change(screen.getByLabelText('mobile command'), {
			target: { value: 'tab draft' },
		});

		mocks.sessionManagement.activeSession = session({
			activeTabId: null,
			aiTabs: undefined as unknown as Session['aiTabs'],
		});
		mocks.sessionManagement.sessions = [mocks.sessionManagement.activeSession];
		mocks.sessionManagement.activeTabId = null;
		rerender(
			<ThemeProvider>
				<MobileApp />
			</ThemeProvider>
		);
		expect(screen.getByLabelText('mobile command')).toHaveValue('');
	});

	it('does not render the right panel without a selected session', () => {
		mocks.sessionManagement.activeSession = null;
		mocks.sessionManagement.activeSessionId = null;

		renderApp();

		const keyboardOptions = mocks.keyboardHandler.mock.calls.at(-1)?.[0];
		expect(keyboardOptions).toBeDefined();
		act(() => {
			keyboardOptions.actions.goToHistory();
		});
		expect(screen.queryByRole('tab', { name: 'History' })).not.toBeInTheDocument();
	});

	it('handles inactive sessions, denied notifications, and interrupt failures', async () => {
		mocks.notifications.permission = 'denied';
		mocks.sessionManagement.activeSession = null;
		mocks.sessionManagement.activeSessionId = null;
		renderApp();

		fireEvent.click(screen.getByText('submit'));
		const keyboardOptions = mocks.keyboardHandler.mock.calls.at(-1)?.[0];
		expect(keyboardOptions).toBeDefined();
		act(() => {
			keyboardOptions.actions.toggleMode();
		});
		expect(mocks.queueCommand).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'switch_mode' }));

		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			value: 'hidden',
		});
		act(() => {
			mocks.lastSessionDeps.onResponseComplete(session(), {
				text: 'Denied body',
				timestamp: 321,
			});
		});
		expect(mocks.addUnread).toHaveBeenCalledWith('session-1-321');
		expect(mocks.showNotification).not.toHaveBeenCalled();

		cleanup();
		resetMocks();
		(fetch as any).mockResolvedValueOnce({
			ok: false,
			json: vi.fn().mockResolvedValue({ success: false, error: 'No session' }),
		});
		renderApp();
		fireEvent.click(screen.getByText('interrupt'));
		await waitFor(() =>
			expect(mocks.webLogger.error).toHaveBeenCalledWith(
				'Failed to interrupt session: No session',
				'Mobile'
			)
		);

		(fetch as any).mockRejectedValueOnce(new Error('network down'));
		fireEvent.click(screen.getByText('interrupt'));
		await waitFor(() =>
			expect(mocks.webLogger.error).toHaveBeenCalledWith(
				'Error interrupting session',
				'Mobile',
				expect.any(Error)
			)
		);
	});

	it('queues commands while disconnected and handles background response notifications', () => {
		mocks.webSocket.state = 'disconnected';
		mocks.notifications.permission = 'granted';
		const notification = {
			close: vi.fn(),
			onclick: null as null | (() => void),
		};
		const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
		mocks.showNotification.mockReturnValue(notification);
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			value: 'hidden',
		});

		renderApp();

		fireEvent.change(screen.getByLabelText('mobile command'), {
			target: { value: 'queue this' },
		});
		fireEvent.click(screen.getByText('submit'));
		expect(mocks.queueCommand).toHaveBeenCalledWith('session-1', 'queue this', 'ai');
		expect(mocks.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'send_command', command: 'queue this' })
		);

		mocks.queueCommand.mockReturnValueOnce(false);
		fireEvent.change(screen.getByLabelText('mobile command'), {
			target: { value: 'queue fails' },
		});
		fireEvent.click(screen.getByText('submit'));
		expect(mocks.webLogger.warn).toHaveBeenCalledWith(
			'Failed to queue command - queue may be full',
			'Mobile'
		);

		act(() => {
			mocks.lastSessionDeps.onResponseComplete(mocks.sessionManagement.activeSession, {
				text: '```\n```\n---\nUseful response line with more detail',
				timestamp: 123,
			});
		});

		expect(mocks.addUnread).toHaveBeenCalledWith('session-1-123');
		expect(mocks.showNotification).toHaveBeenCalledWith(
			'Mobile Session - Response Ready',
			expect.objectContaining({
				body: 'Useful response line with more detail',
				tag: 'maestro-response-session-1',
			})
		);

		mocks.showNotification.mockClear();
		act(() => {
			mocks.lastSessionDeps.onResponseComplete(mocks.sessionManagement.activeSession, {
				text: `${'x'.repeat(120)}\nsecond line`,
				timestamp: 124,
			});
		});
		expect(mocks.showNotification).toHaveBeenCalledWith(
			'Mobile Session - Response Ready',
			expect.objectContaining({
				body: `${'x'.repeat(100)}...`,
			})
		);

		mocks.showNotification.mockClear();
		act(() => {
			mocks.lastSessionDeps.onResponseComplete(mocks.sessionManagement.activeSession, {
				text: '\n```\n---\n',
				timestamp: 125,
			});
		});
		expect(mocks.showNotification).toHaveBeenCalledWith(
			'Mobile Session - Response Ready',
			expect.objectContaining({
				body: 'Response completed',
			})
		);

		notification.onclick?.();
		expect(focus).toHaveBeenCalledOnce();
		expect(mocks.setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(mocks.markAllRead).toHaveBeenCalledOnce();
		expect(notification.close).toHaveBeenCalledOnce();
		focus.mockRestore();
	});

	it('delays initial connect until injected config is available', () => {
		vi.useFakeTimers();
		delete window.__MAESTRO_CONFIG__;

		renderApp();

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(mocks.connect).not.toHaveBeenCalled();
		expect(mocks.webLogger.warn).toHaveBeenCalledWith(
			'Config not ready, retrying connection in 100ms',
			'Mobile'
		);

		window.__MAESTRO_CONFIG__ = {
			securityToken: 'token-1',
			apiBase: '/token-1/api',
			wsUrl: '/token-1/ws',
			sessionId: null,
			tabId: null,
		};
		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(mocks.connect).toHaveBeenCalledOnce();
	});

	it('waits for the window load event before connecting when the document is still loading', () => {
		vi.useFakeTimers();
		Object.defineProperty(document, 'readyState', {
			configurable: true,
			value: 'loading',
		});
		const addEventListener = vi.spyOn(window, 'addEventListener');
		const removeEventListener = vi.spyOn(window, 'removeEventListener');

		const view = renderApp();
		expect(addEventListener).toHaveBeenCalledWith('load', expect.any(Function));
		expect(mocks.connect).not.toHaveBeenCalled();

		act(() => {
			window.dispatchEvent(new Event('load'));
			vi.advanceTimersByTime(50);
		});
		expect(mocks.connect).toHaveBeenCalledOnce();

		view.unmount();
		expect(removeEventListener).toHaveBeenCalledWith('load', expect.any(Function));
	});

	it('removes the load listener when unmounted before scheduling connect', () => {
		vi.useFakeTimers();
		Object.defineProperty(document, 'readyState', {
			configurable: true,
			value: 'loading',
		});
		const removeEventListener = vi.spyOn(window, 'removeEventListener');

		const view = renderApp();
		view.unmount();

		expect(removeEventListener).toHaveBeenCalledWith('load', expect.any(Function));
		expect(mocks.connect).not.toHaveBeenCalled();
	});
});
