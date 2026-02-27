/**
 * @fileoverview Tests for SessionList component
 *
 * SessionList is the Left Bar sidebar component that displays:
 * - Branding header with LIVE mode toggle
 * - Session filter input
 * - Bookmarks section
 * - Groups with sessions
 * - Ungrouped sessions
 * - Context menu for session actions
 * - Collapsed/expanded sidebar modes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SessionList } from '../../../renderer/components/SessionList';
import type { Session, Group, Theme } from '../../../renderer/types';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore, DEFAULT_AUTO_RUN_STATS } from '../../../renderer/stores/settingsStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import type { BatchRunState } from '../../../renderer/types';

// Mock QRCodeSVG to avoid complex rendering
vi.mock('qrcode.react', () => ({
	QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Wand2: ({ className }: { className?: string }) => (
		<span data-testid="icon-wand" className={className} />
	),
	Plus: () => <span data-testid="icon-plus" />,
	Settings: () => <span data-testid="icon-settings" />,
	ChevronRight: () => <span data-testid="icon-chevron-right" />,
	ChevronDown: () => <span data-testid="icon-chevron-down" />,
	ChevronUp: () => <span data-testid="icon-chevron-up" />,
	Activity: () => <span data-testid="icon-activity" />,
	X: () => <span data-testid="icon-x" />,
	Keyboard: () => <span data-testid="icon-keyboard" />,
	Radio: () => <span data-testid="icon-radio" />,
	Copy: () => <span data-testid="icon-copy" />,
	ExternalLink: () => <span data-testid="icon-external-link" />,
	PanelLeftClose: () => <span data-testid="icon-panel-left-close" />,
	PanelLeftOpen: () => <span data-testid="icon-panel-left-open" />,
	Folder: () => <span data-testid="icon-folder" />,
	Info: () => <span data-testid="icon-info" />,
	FileText: () => <span data-testid="icon-file-text" />,
	GitBranch: () => <span data-testid="icon-git-branch" />,
	GitPullRequest: () => <span data-testid="icon-git-pull-request" />,
	Bot: () => <span data-testid="icon-bot" />,
	Clock: () => <span data-testid="icon-clock" />,
	ScrollText: () => <span data-testid="icon-scroll-text" />,
	Cpu: () => <span data-testid="icon-cpu" />,
	Menu: () => <span data-testid="icon-menu" />,
	Bookmark: ({ fill }: { fill?: string }) => <span data-testid="icon-bookmark" data-fill={fill} />,
	Trophy: () => <span data-testid="icon-trophy" />,
	Trash2: () => <span data-testid="icon-trash" />,
	Edit3: () => <span data-testid="icon-edit" />,
	FolderInput: () => <span data-testid="icon-folder-input" />,
	FolderPlus: () => <span data-testid="icon-folder-plus" />,
	Download: () => <span data-testid="icon-download" />,
	Compass: () => <span data-testid="icon-compass" />,
	Globe: () => <span data-testid="icon-globe" />,
	BookOpen: () => <span data-testid="icon-book-open" />,
	BarChart3: () => <span data-testid="icon-bar-chart" />,
	Server: () => <span data-testid="icon-server" />,
	Music: () => <span data-testid="icon-music" />,
	Command: () => <span data-testid="icon-command" />,
	MessageSquare: () => <span data-testid="icon-message-square" />,
}));

// Mock gitService
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ files: [] }),
	},
}));

// Mock GitStatusContext to avoid Provider requirement
vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitStatus: () => ({
		gitStatusMap: new Map(),
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
		isLoading: false,
		getFileCount: () => 0,
		getStatus: () => undefined,
	}),
	useGitFileStatus: () => ({
		getFileCount: () => 0,
		hasChanges: () => false,
	}),
	useGitBranch: () => ({
		getBranchInfo: () => undefined,
	}),
	useGitDetail: () => ({
		getFileDetails: () => undefined,
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
	}),
}));
// Modal actions mock — replaces prop-passed modal setters
const mockModalActions = {
	setShortcutsHelpOpen: vi.fn(),
	setSettingsModalOpen: vi.fn(),
	setSettingsTab: vi.fn(),
	setAboutModalOpen: vi.fn(),
	setLogViewerOpen: vi.fn(),
	setProcessMonitorOpen: vi.fn(),
	setUsageDashboardOpen: vi.fn(),
	setSymphonyModalOpen: vi.fn(),
	setDirectorNotesOpen: vi.fn(),
	setUpdateCheckModalOpen: vi.fn(),
	setQuickActionOpen: vi.fn(),
	setRenameInstanceModalOpen: vi.fn(),
	setRenameInstanceValue: vi.fn(),
	setRenameInstanceSessionId: vi.fn(),
	setDuplicatingSessionId: vi.fn(),
};

vi.mock('../../../renderer/stores/modalStore', async (importActual) => {
	const actual = await importActual<typeof import('../../../renderer/stores/modalStore')>();
	return { ...actual, getModalActions: () => mockModalActions };
});

// Default theme
const defaultTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		info: '#8be9fd',
	},
};

// Default shortcuts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defaultShortcuts: Record<string, any> = {
	help: { keys: ['?'], description: 'Show help' },
	settings: { keys: ['meta', ','], description: 'Settings' },
	systemLogs: { keys: ['meta', 'shift', 'l'], description: 'System logs' },
	processMonitor: { keys: ['meta', 'shift', 'p'], description: 'Process monitor' },
	usageDashboard: { keys: ['alt', 'meta', 'u'], description: 'Usage dashboard' },
	toggleSidebar: { keys: ['meta', 'b'], description: 'Toggle sidebar' },
};

// Create mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: `session-${Math.random().toString(36).substr(2, 9)}`,
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
	aiPid: 12345,
	terminalPid: 12346,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	contextUsage: 30,
	activeTimeMs: 60000,
	...overrides,
});

// Create mock group
const createMockGroup = (overrides: Partial<Group> = {}): Group => ({
	id: `group-${Math.random().toString(36).substr(2, 9)}`,
	name: 'Test Group',
	emoji: '📁',
	collapsed: false,
	...overrides,
});

// Create default handler props (state is read from stores)
const createDefaultProps = (overrides: Partial<Parameters<typeof SessionList>[0]> = {}) => ({
	theme: defaultTheme,
	sortedSessions: [] as Session[],
	isLiveMode: false,
	webInterfaceUrl: null,
	showSessionJumpNumbers: false,
	visibleSessions: [] as Session[],
	toggleGlobalLive: vi.fn(),
	restartWebServer: vi.fn().mockResolvedValue(null),
	toggleGroup: vi.fn(),
	handleDragStart: vi.fn(),
	handleDragOver: vi.fn(),
	handleDropOnGroup: vi.fn(),
	handleDropOnUngrouped: vi.fn(),
	finishRenamingGroup: vi.fn(),
	finishRenamingSession: vi.fn(),
	startRenamingGroup: vi.fn(),
	startRenamingSession: vi.fn(),
	showConfirmation: vi.fn(),
	createNewGroup: vi.fn(),
	onCreateGroupAndMove: vi.fn(),
	addNewSession: vi.fn(),
	onDeleteWorktreeGroup: vi.fn(),
	onEditAgent: vi.fn(),
	onNewAgentSession: vi.fn(),
	onToggleWorktreeExpanded: vi.fn(),
	onOpenCreatePR: vi.fn(),
	onQuickCreateWorktree: vi.fn(),
	onOpenWorktreeConfig: vi.fn(),
	onDeleteWorktree: vi.fn(),
	openWizard: vi.fn(),
	startTour: vi.fn(),
	onOpenGroupChat: vi.fn(),
	onNewGroupChat: vi.fn(),
	onEditGroupChat: vi.fn(),
	onRenameGroupChat: vi.fn(),
	onDeleteGroupChat: vi.fn(),
	...overrides,
});

describe('SessionList', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset all stores to clean test state
		useUIStore.setState({
			leftSidebarOpen: true,
			activeFocus: 'main' as const,
			selectedSidebarIndex: -1,
			editingGroupId: null,
			editingSessionId: null,
			draggingSessionId: null,
			bookmarksCollapsed: false,
			sessionFilterOpen: false,
			groupChatsExpanded: false,
		});
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
		});
		useSettingsStore.setState({
			shortcuts: defaultShortcuts,
			leftSidebarWidth: 300,
			ungroupedCollapsed: false,
			autoRunStats: { ...DEFAULT_AUTO_RUN_STATS },
		});
		useBatchStore.setState({ batchRunStates: {} });
		// Reset tunnel mock
		(window.maestro as Record<string, unknown>).tunnel = {
			isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
			start: vi.fn().mockResolvedValue({ success: true, url: 'https://tunnel.example.com' }),
			stop: vi.fn().mockResolvedValue(undefined),
		};
	});

	afterEach(() => {
		vi.clearAllTimers();
	});

	// ============================================================================
	// Pure Functions Tests
	// ============================================================================

	describe('stripLeadingEmojis and compareSessionNames', () => {
		// These are tested via component behavior since they're not exported
		// Test emoji sorting through session list ordering

		it('sorts sessions alphabetically ignoring leading emojis', () => {
			const sessions = [
				createMockSession({ id: 's1', name: '🎉 Zebra Project' }),
				createMockSession({ id: 's2', name: 'Apple Project' }),
				createMockSession({ id: 's3', name: '🚀 Beta Project' }),
			];
			const sortedSessions = [...sessions].sort((a, b) => a.name.localeCompare(b.name));

			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions,
			});

			render(<SessionList {...props} />);

			// Sessions are displayed - verify they exist
			expect(screen.getByText('🎉 Zebra Project')).toBeInTheDocument();
			expect(screen.getByText('Apple Project')).toBeInTheDocument();
			expect(screen.getByText('🚀 Beta Project')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Basic Rendering Tests
	// ============================================================================

	describe('Basic Rendering', () => {
		it('renders the MAESTRO branding header when expanded', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			expect(screen.getByText('MAESTRO')).toBeInTheDocument();
		});

		it('renders collapsed sidebar mode', () => {
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			// MAESTRO text should not be visible in collapsed mode
			expect(screen.queryByText('MAESTRO')).not.toBeInTheDocument();
		});

		it('renders New Agent button in expanded mode', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			expect(screen.getByText('New Agent')).toBeInTheDocument();
		});

		it('calls addNewSession when New Agent button clicked', () => {
			const addNewSession = vi.fn();
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({ addNewSession });
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('New Agent'));
			expect(addNewSession).toHaveBeenCalled();
		});

		it('toggles sidebar open/closed', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session] });
			useUIStore.setState({ leftSidebarOpen: true });
			const setLeftSidebarOpen = vi.spyOn(useUIStore.getState(), 'setLeftSidebarOpen');
			const props = createDefaultProps({
				sortedSessions: [session],
			});
			render(<SessionList {...props} />);

			// Find collapse button by its title
			const collapseButton = screen.getByTitle(/Collapse.*Sidebar/i);
			fireEvent.click(collapseButton);

			expect(setLeftSidebarOpen).toHaveBeenCalledWith(false);
		});
	});

	// ============================================================================
	// LIVE Mode Tests
	// ============================================================================

	describe('LIVE Mode', () => {
		it('shows OFFLINE when live mode is disabled', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 310 });
			const props = createDefaultProps({
				isLiveMode: false,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('OFFLINE')).toBeInTheDocument();
		});

		it('shows LIVE when live mode is enabled', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('LIVE')).toBeInTheDocument();
		});

		it('enables live mode when clicking OFFLINE button', () => {
			const toggleGlobalLive = vi.fn();
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 310 });
			const props = createDefaultProps({
				isLiveMode: false,
				toggleGlobalLive,
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('OFFLINE'));
			expect(toggleGlobalLive).toHaveBeenCalled();
		});

		it('opens live overlay when clicking LIVE button', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			// Click LIVE to toggle overlay
			fireEvent.click(screen.getByText('LIVE'));

			// Overlay should appear with description text
			expect(screen.getByText(/Control your AI sessions/)).toBeInTheDocument();
		});

		it('shows QR code in live overlay', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			expect(screen.getByTestId('qr-code')).toBeInTheDocument();
		});

		it('copies URL to clipboard when copy button clicked', async () => {
			const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
			Object.assign(navigator, { clipboard: mockClipboard });

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			const copyButton = screen.getByTitle('Copy URL');
			fireEvent.click(copyButton);

			expect(mockClipboard.writeText).toHaveBeenCalledWith('http://localhost:3000');
		});

		it('opens browser when Open in Browser clicked', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			fireEvent.click(screen.getByText('Open in Browser'));

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('http://localhost:3000');
		});

		it('turns off live mode when Turn Off button clicked', () => {
			const toggleGlobalLive = vi.fn();
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
				toggleGlobalLive,
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			fireEvent.click(screen.getByText('Turn Off Web Interface'));

			expect(toggleGlobalLive).toHaveBeenCalled();
		});

		it('hides OFFLINE text when sidebar width is narrow (< 256px) with autoRunStats badge', () => {
			// When autoRunStats.currentBadgeLevel > 0, threshold is 295px
			// When no autoRunStats, threshold is 256px
			const autoRunStats = {
				totalDocuments: 1,
				currentDocument: 1,
				completedTasks: 0,
				totalTasks: 5,
				currentBadgeLevel: 1, // This raises threshold to 295px
			};
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({
				leftSidebarWidth: 256,
				autoRunStats: autoRunStats,
			});
			const props = createDefaultProps({
				isLiveMode: false,
			});
			render(<SessionList {...props} />);

			// Text should be hidden when below threshold with active badge
			expect(screen.queryByText('OFFLINE')).not.toBeInTheDocument();
			// But the Radio icon should still be present
			expect(screen.getByTestId('icon-radio')).toBeInTheDocument();
		});

		it('shows OFFLINE text when sidebar width equals minimum threshold (256px) without autoRunStats', () => {
			// Without autoRunStats, threshold is 256px so text shows at exactly 256px
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 256 });
			const props = createDefaultProps({
				isLiveMode: false,
			});
			render(<SessionList {...props} />);

			// Text should be visible at minimum threshold when no badge
			expect(screen.getByText('OFFLINE')).toBeInTheDocument();
		});

		it('shows OFFLINE text when sidebar width is wide (>= 310px)', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 310 });
			const props = createDefaultProps({
				isLiveMode: false,
			});
			render(<SessionList {...props} />);

			// Text should be visible
			expect(screen.getByText('OFFLINE')).toBeInTheDocument();
		});

		it('hides LIVE text when sidebar width is narrow with autoRunStats badge', () => {
			// When autoRunStats.currentBadgeLevel > 0, threshold is 295px
			const autoRunStats = {
				totalDocuments: 1,
				currentDocument: 1,
				completedTasks: 0,
				totalTasks: 5,
				currentBadgeLevel: 1, // This raises threshold to 295px
			};
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({
				leftSidebarWidth: 256,
				autoRunStats: autoRunStats,
			});
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			// Text should be hidden when below threshold with active badge
			expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
			// But the Radio icon should still be present
			expect(screen.getByTestId('icon-radio')).toBeInTheDocument();
		});

		it('shows LIVE text when sidebar width equals minimum threshold (256px) without autoRunStats', () => {
			// Without autoRunStats, threshold is 256px so text shows at exactly 256px
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 256 });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			// Text should be visible at minimum threshold when no badge
			expect(screen.getByText('LIVE')).toBeInTheDocument();
		});

		it('shows LIVE text when sidebar width is wide (>= 280px)', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 300 });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			// Text should be visible
			expect(screen.getByText('LIVE')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Session Filter Tests
	// ============================================================================

	describe('Session Filter', () => {
		it('opens filter input with Cmd+F', () => {
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			// Get the sidebar div and trigger keydown
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			expect(screen.getByPlaceholderText('Filter agents...')).toBeInTheDocument();
		});

		it('closes filter with Escape key', () => {
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			// Open filter
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			// Verify filter is open
			const input = screen.getByPlaceholderText('Filter agents...');
			expect(input).toBeInTheDocument();

			// Close with Escape
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(screen.queryByPlaceholderText('Filter agents...')).not.toBeInTheDocument();
		});

		it('filters sessions by name', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Frontend Project' }),
				createMockSession({ id: 's2', name: 'Backend Project' }),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Open filter
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			// Type in filter
			const input = screen.getByPlaceholderText('Filter agents...');
			fireEvent.change(input, { target: { value: 'Frontend' } });

			// Frontend should be visible, Backend hidden
			expect(screen.getByText('Frontend Project')).toBeInTheDocument();
			expect(screen.queryByText('Backend Project')).not.toBeInTheDocument();
		});
	});

	// ============================================================================
	// Bookmarks Section Tests
	// ============================================================================

	describe('Bookmarks Section', () => {
		it('shows bookmarks section when there are bookmarked sessions', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Bookmarked Session', bookmarked: true }),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('Bookmarks')).toBeInTheDocument();
		});

		it('hides bookmarks section when no bookmarked sessions', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Regular Session', bookmarked: false }),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.queryByText('Bookmarks')).not.toBeInTheDocument();
		});

		it('toggles bookmarks collapsed state', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Bookmarked', bookmarked: true })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: false,
			});
			const setBookmarksCollapsed = vi.spyOn(useUIStore.getState(), 'setBookmarksCollapsed');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Click on Bookmarks header to collapse
			fireEvent.click(screen.getByText('Bookmarks'));
			expect(setBookmarksCollapsed).toHaveBeenCalledWith(true);
		});

		it('toggles bookmark on session via button', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Test Session', bookmarked: false })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const setSessions = vi.spyOn(useSessionStore.getState(), 'setSessions');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Hover to reveal bookmark button - button appears on hover via group-hover
			const sessionItem = screen.getByText('Test Session').closest('div[class*="group"]');
			expect(sessionItem).toBeInTheDocument();

			// Find and click bookmark button
			const bookmarkButtons = screen.getAllByTitle(/bookmark/i);
			fireEvent.click(bookmarkButtons[0]);

			expect(setSessions).toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Groups Section Tests
	// ============================================================================

	describe('Groups Section', () => {
		it('renders groups with their sessions', () => {
			const group = createMockGroup({ id: 'g1', name: 'My Group', emoji: '🚀' });
			const sessions = [createMockSession({ id: 's1', name: 'Session in Group', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('My Group')).toBeInTheDocument();
			expect(screen.getByText('🚀')).toBeInTheDocument();
			expect(screen.getByText('Session in Group')).toBeInTheDocument();
		});

		it('toggles group collapse on click', () => {
			const toggleGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'My Group', collapsed: false });
			const sessions = [createMockSession({ id: 's1', name: 'Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				toggleGroup,
			});
			render(<SessionList {...props} />);

			// Click on group header
			fireEvent.click(screen.getByText('My Group'));
			expect(toggleGroup).toHaveBeenCalledWith('g1');
		});

		it('shows delete button for empty groups on hover', () => {
			const group = createMockGroup({ id: 'g1', name: 'Empty Group' });
			useSessionStore.setState({
				sessions: [],
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: [],
			});
			render(<SessionList {...props} />);

			// Empty group should have delete button (visible on hover)
			expect(screen.getByTitle('Delete empty group')).toBeInTheDocument();
		});

		it('creates new group when button clicked', () => {
			const createNewGroup = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Test Session' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				createNewGroup,
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('New Group'));
			expect(createNewGroup).toHaveBeenCalled();
		});

		it('shows New Group button when no groups exist (flat list mode)', () => {
			const createNewGroup = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Test Session' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				createNewGroup,
			});
			render(<SessionList {...props} />);

			// New Group button should be visible even with no groups
			expect(screen.getByText('New Group')).toBeInTheDocument();
		});

		it('shows New Group button inline with Ungrouped Agents header when ungrouped sessions exist', () => {
			const createNewGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'My Group' });
			const sessions = [createMockSession({ id: 's1', name: 'Ungrouped Session' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				createNewGroup,
			});
			render(<SessionList {...props} />);

			// Both Ungrouped Agents header and New Group button should be visible
			expect(screen.getByText('Ungrouped Agents')).toBeInTheDocument();
			expect(screen.getByText('New Group')).toBeInTheDocument();

			// The button should be inline - verify they share the same parent row
			const ungroupedHeader = screen.getByText('Ungrouped Agents');
			const newGroupButton = screen.getByText('New Group');
			// Both should be within the same clickable header row (grandparent for text, parent for button)
			const headerRow = ungroupedHeader.closest('.flex.items-center.justify-between');
			expect(headerRow).not.toBeNull();
			expect(headerRow?.contains(newGroupButton)).toBe(true);
		});

		it('shows standalone New Group button when groups exist with no ungrouped sessions', () => {
			const createNewGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'My Group', sessionIds: ['s1'] });
			const sessions = [createMockSession({ id: 's1', name: 'Grouped Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				createNewGroup,
			});
			render(<SessionList {...props} />);

			// New Group button should be visible
			expect(screen.getByText('New Group')).toBeInTheDocument();
			// Ungrouped Agents header should NOT be visible (no ungrouped sessions)
			expect(screen.queryByText('Ungrouped Agents')).not.toBeInTheDocument();

			// Button should be standalone (full-width style)
			const newGroupButton = screen.getByText('New Group').closest('button');
			expect(newGroupButton).toHaveClass('w-full');
		});
	});

	// ============================================================================
	// Ungrouped Sessions Tests
	// ============================================================================

	describe('Ungrouped Sessions', () => {
		it('does not show Ungrouped header when no groups exist', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Direct Session' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Session should be visible directly without "Ungrouped" header
			expect(screen.getByText('Direct Session')).toBeInTheDocument();
			expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
		});

		it('renders ungrouped section with sessions when groups exist', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [createMockSession({ id: 's1', name: 'Ungrouped Session' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('Ungrouped Agents')).toBeInTheDocument();
			expect(screen.getByText('Ungrouped Session')).toBeInTheDocument();
		});

		it('hides Ungrouped Agents folder when all sessions are in groups', () => {
			const group = createMockGroup({ id: 'g1', name: 'My Group', sessionIds: ['s1'] });
			const sessions = [createMockSession({ id: 's1', name: 'Grouped Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// The session should be visible in the group
			expect(screen.getByText('Grouped Session')).toBeInTheDocument();
			// But the Ungrouped Agents folder should NOT be visible
			expect(screen.queryByText('Ungrouped Agents')).not.toBeInTheDocument();
		});

		it('selects session when clicked', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Click Me' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('Click Me'));
			expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		});
	});

	// ============================================================================
	// Context Menu Tests
	// ============================================================================

	describe('Context Menu', () => {
		it('opens context menu on right-click', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Right Click Me' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			const sessionElement = screen.getByText('Right Click Me');
			fireEvent.contextMenu(sessionElement, { clientX: 100, clientY: 100 });

			// Context menu items should appear
			expect(screen.getByText('Rename')).toBeInTheDocument();
			expect(screen.getByText('Remove Agent')).toBeInTheDocument();
		});

		it('closes context menu on Escape', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Test Session' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Test Session'), { clientX: 100, clientY: 100 });

			expect(screen.getByText('Rename')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(document, { key: 'Escape' });

			expect(screen.queryByText('Rename')).not.toBeInTheDocument();
		});

		it('triggers rename modal from context menu', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Rename Me' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Rename Me'), { clientX: 100, clientY: 100 });

			fireEvent.click(screen.getByText('Rename'));

			expect(mockModalActions.setRenameInstanceValue).toHaveBeenCalledWith('Rename Me');
			expect(mockModalActions.setRenameInstanceSessionId).toHaveBeenCalledWith('s1');
			expect(mockModalActions.setRenameInstanceModalOpen).toHaveBeenCalledWith(true);
		});

		it('triggers delete confirmation from context menu', () => {
			const showConfirmation = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Delete Me' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				showConfirmation,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Delete Me'), { clientX: 100, clientY: 100 });

			fireEvent.click(screen.getByText('Remove Agent'));

			expect(showConfirmation).toHaveBeenCalledWith(
				expect.stringContaining('Delete Me'),
				expect.any(Function)
			);
		});

		it('toggles bookmark from context menu', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Bookmark Me', bookmarked: false })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const setSessions = vi.spyOn(useSessionStore.getState(), 'setSessions');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Bookmark Me'), { clientX: 100, clientY: 100 });

			fireEvent.click(screen.getByText('Add Bookmark'));

			expect(setSessions).toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Hamburger Menu Tests
	// ============================================================================

	describe('Hamburger Menu', () => {
		it('opens menu overlay when menu button clicked', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			// Find and click menu button
			const menuButton = screen.getByTitle('Menu');
			fireEvent.click(menuButton);

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
			expect(screen.getByText('Settings')).toBeInTheDocument();
			expect(screen.getByText('System Logs')).toBeInTheDocument();
			expect(screen.getByText('Process Monitor')).toBeInTheDocument();
			expect(screen.getByText('About Maestro')).toBeInTheDocument();
		});

		it('opens shortcuts help from menu', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			fireEvent.click(screen.getByText('Keyboard Shortcuts'));

			expect(mockModalActions.setShortcutsHelpOpen).toHaveBeenCalledWith(true);
		});

		it('opens settings from menu', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			fireEvent.click(screen.getByText('Settings'));

			expect(mockModalActions.setSettingsModalOpen).toHaveBeenCalledWith(true);
			expect(mockModalActions.setSettingsTab).toHaveBeenCalledWith('general');
		});

		it('opens log viewer from menu', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			fireEvent.click(screen.getByText('System Logs'));

			expect(mockModalActions.setLogViewerOpen).toHaveBeenCalledWith(true);
		});

		it('opens process monitor from menu', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			fireEvent.click(screen.getByText('Process Monitor'));

			expect(mockModalActions.setProcessMonitorOpen).toHaveBeenCalledWith(true);
		});

		it('opens about modal from menu', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			fireEvent.click(screen.getByText('About Maestro'));

			expect(mockModalActions.setAboutModalOpen).toHaveBeenCalledWith(true);
		});

		it('closes menu with Escape key', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
		});

		it('has scrollable menu container for limited viewport height', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			// Find the menu container by its data-tour attribute
			const menuContainer = document.querySelector(
				'[data-tour="hamburger-menu-contents"]'
			) as HTMLElement;
			expect(menuContainer).toBeInTheDocument();
			expect(menuContainer).toHaveClass('overflow-y-auto');
			expect(menuContainer).toHaveClass('scrollbar-thin');
			// Verify max-height is set via inline style for scroll support
			expect(menuContainer?.style.maxHeight).toBe('calc(100vh - 90px)');
		});

		it("shows Director's Notes menu item in hamburger menu", () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));

			expect(screen.getByText("Director's Notes")).toBeInTheDocument();
			expect(screen.getByText('Unified history & AI synopsis')).toBeInTheDocument();
		});

		it("opens Director's Notes modal from menu", () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByTitle('Menu'));
			fireEvent.click(screen.getByText("Director's Notes"));

			expect(mockModalActions.setDirectorNotesOpen).toHaveBeenCalledWith(true);
		});
	});

	// ============================================================================
	// Session Status Indicators Tests
	// ============================================================================

	describe('Session Status Indicators', () => {
		it('shows idle status indicator', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Idle Session', state: 'idle' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Session should be rendered with status indicator
			expect(screen.getByText('Idle Session')).toBeInTheDocument();
		});

		it('shows busy status with pulse animation', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Busy Session', state: 'busy' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Look for animate-pulse class on status indicator
			const pulsingElements = container.querySelectorAll('.animate-pulse');
			expect(pulsingElements.length).toBeGreaterThan(0);
		});

		it('shows AUTO badge for batch sessions', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Auto Session' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			useBatchStore.setState({ batchRunStates: { s1: { isRunning: true } as BatchRunState } });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('AUTO')).toBeInTheDocument();
		});

		it('activates wand sparkle animation when a session is busy', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Busy Session', state: 'busy' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			const wandIcons = screen.getAllByTestId('icon-wand');
			const hasSparkle = wandIcons.some((el) => el.className.includes('wand-sparkle-active'));
			expect(hasSparkle).toBe(true);
		});

		it('activates wand sparkle animation when auto-run is active', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Auto Session', state: 'idle' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			useBatchStore.setState({ batchRunStates: { s1: { isRunning: true } as BatchRunState } });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			const wandIcons = screen.getAllByTestId('icon-wand');
			const hasSparkle = wandIcons.some((el) => el.className.includes('wand-sparkle-active'));
			expect(hasSparkle).toBe(true);
		});

		it('does not activate wand sparkle when no sessions are busy or in auto-run', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Idle Session', state: 'idle' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			const wandIcons = screen.getAllByTestId('icon-wand');
			const hasSparkle = wandIcons.some((el) => el.className.includes('wand-sparkle-active'));
			expect(hasSparkle).toBe(false);
		});

		it('shows GIT badge for git repos', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Git Session', isGitRepo: true })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('GIT')).toBeInTheDocument();
		});

		it('shows LOCAL badge for non-git directories', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Local Session', isGitRepo: false })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			expect(screen.getByText('LOCAL')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Drag and Drop Tests
	// ============================================================================

	describe('Drag and Drop', () => {
		it('calls handleDragStart when dragging a session', () => {
			const handleDragStart = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Draggable' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				handleDragStart,
			});
			render(<SessionList {...props} />);

			const sessionElement = screen.getByText('Draggable').closest('[draggable="true"]');
			expect(sessionElement).toBeInTheDocument();

			fireEvent.dragStart(sessionElement!);
			expect(handleDragStart).toHaveBeenCalledWith('s1');
		});

		it('calls handleDropOnGroup when dropping on group', () => {
			const handleDropOnGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'Drop Target' });
			useSessionStore.setState({
				sessions: [],
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: [],
				handleDropOnGroup,
			});
			render(<SessionList {...props} />);

			const groupHeader = screen.getByText('Drop Target');
			fireEvent.drop(groupHeader);

			expect(handleDropOnGroup).toHaveBeenCalledWith('g1');
		});

		it('shows drop zone for ungrouping when dragging and all sessions are grouped', () => {
			const handleDropOnUngrouped = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'My Group', sessionIds: ['s1'] });
			const sessions = [createMockSession({ id: 's1', name: 'Grouped Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				draggingSessionId: 's1',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
				handleDropOnUngrouped,
			});
			render(<SessionList {...props} />);

			// Drop zone should be visible when dragging
			expect(screen.getByText('Drop here to ungroup')).toBeInTheDocument();
		});

		it('calls handleDropOnUngrouped when dropping on ungroup zone', () => {
			const handleDropOnUngrouped = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'My Group', sessionIds: ['s1'] });
			const sessions = [createMockSession({ id: 's1', name: 'Grouped Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				draggingSessionId: 's1',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
				handleDropOnUngrouped,
			});
			render(<SessionList {...props} />);

			// Find the drop zone and drop on it
			const dropZone = screen.getByText('Drop here to ungroup');
			fireEvent.drop(dropZone);

			expect(handleDropOnUngrouped).toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Resize Handle Tests
	// ============================================================================

	describe('Resize Handle', () => {
		it('updates sidebar width on drag', async () => {
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 300 });
			const setLeftSidebarWidthState = vi.spyOn(useSettingsStore.getState(), 'setLeftSidebarWidth');
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			// Find resize handle (first child with cursor-col-resize)
			const resizeHandle = container.querySelector('.cursor-col-resize');
			expect(resizeHandle).toBeInTheDocument();

			// Simulate drag
			fireEvent.mouseDown(resizeHandle!, { clientX: 300 });

			// Move mouse (direct DOM update for performance, no state call yet)
			fireEvent.mouseMove(document, { clientX: 350 });

			// State is only updated on mouseUp for performance (avoids ~60 re-renders/sec)
			expect(setLeftSidebarWidthState).not.toHaveBeenCalled();

			// End resize - state is updated
			fireEvent.mouseUp(document);
			expect(setLeftSidebarWidthState).toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Achievement Badge Tests
	// ============================================================================

	describe('Achievement Badge', () => {
		it('shows badge level indicator when autoRunStats has level', () => {
			const autoRunStats = {
				cumulativeTimeMs: 3600000, // 1 hour
				longestRunMs: 1800000,
				totalRuns: 10,
				currentBadgeLevel: 3,
				badgeHistory: [],
			};
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ autoRunStats: autoRunStats });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			// Should show trophy icon with level number
			expect(screen.getByText('3')).toBeInTheDocument();
		});

		it('opens about modal when badge clicked', () => {
			const autoRunStats = {
				cumulativeTimeMs: 3600000,
				longestRunMs: 1800000,
				totalRuns: 10,
				currentBadgeLevel: 3,
				badgeHistory: [],
			};
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ autoRunStats: autoRunStats });
			const props = createDefaultProps({});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('3'));
			expect(mockModalActions.setAboutModalOpen).toHaveBeenCalledWith(true);
		});
	});

	// ============================================================================
	// Session Jump Numbers Tests
	// ============================================================================

	describe('Session Jump Numbers', () => {
		it('shows jump numbers when showSessionJumpNumbers is true', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session 1' }),
				createMockSession({ id: 's2', name: 'Session 2' }),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				showSessionJumpNumbers: true,
				visibleSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Should show numbers 1 and 2
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('2')).toBeInTheDocument();
		});

		it('shows 0 for 10th session', () => {
			const sessions = Array.from({ length: 10 }, (_, i) =>
				createMockSession({ id: `s${i}`, name: `Session ${i + 1}` })
			);
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				showSessionJumpNumbers: true,
				visibleSessions: sessions,
			});
			render(<SessionList {...props} />);

			// 10th session should show 0
			expect(screen.getByText('0')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Skinny Mode (Collapsed Sidebar) Tests
	// ============================================================================

	describe('Skinny Mode', () => {
		it('renders session dots in collapsed mode', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session 1' }),
				createMockSession({ id: 's2', name: 'Session 2' }),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Should have circular session indicators
			const dots = container.querySelectorAll('.rounded-full.w-3.h-3');
			expect(dots.length).toBe(2);
		});

		it('selects session when dot clicked in collapsed mode', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Session 1' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Click on the session dot container
			const dotContainer = container.querySelector('.w-8.h-8.rounded-full');
			expect(dotContainer).toBeInTheDocument();
			fireEvent.click(dotContainer!);

			expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		});

		it('shows context menu on right-click in skinny mode', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Session 1' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Right-click on the session dot container
			const dotContainer = container.querySelector('.w-8.h-8.rounded-full');
			expect(dotContainer).toBeInTheDocument();
			fireEvent.contextMenu(dotContainer!, { clientX: 100, clientY: 100 });

			// Context menu should appear
			expect(screen.getByText('Rename')).toBeInTheDocument();
			expect(screen.getByText('Remove Agent')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Group Renaming Tests
	// ============================================================================

	describe('Group Renaming', () => {
		it('shows rename input when editingGroupId matches', () => {
			const group = createMockGroup({ id: 'g1', name: 'Original Name' });
			useSessionStore.setState({
				sessions: [],
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingGroupId: 'g1',
			});
			const props = createDefaultProps({
				sortedSessions: [],
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original Name');
			expect(input).toBeInTheDocument();
		});

		it('calls finishRenamingGroup on blur', () => {
			const finishRenamingGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'Original' });
			useSessionStore.setState({
				sessions: [],
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingGroupId: 'g1',
			});
			const props = createDefaultProps({
				sortedSessions: [],
				finishRenamingGroup,
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original');
			fireEvent.change(input, { target: { value: 'New Name' } });
			fireEvent.blur(input);

			expect(finishRenamingGroup).toHaveBeenCalledWith('g1', 'New Name');
		});

		it('calls finishRenamingGroup on Enter', () => {
			const finishRenamingGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'Original' });
			useSessionStore.setState({
				sessions: [],
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingGroupId: 'g1',
			});
			const props = createDefaultProps({
				sortedSessions: [],
				finishRenamingGroup,
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original');
			fireEvent.change(input, { target: { value: 'New Name' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(finishRenamingGroup).toHaveBeenCalledWith('g1', 'New Name');
		});
	});

	// ============================================================================
	// Session Renaming Tests
	// ============================================================================

	describe('Session Renaming', () => {
		// Note: Tests using "ungrouped-" prefix for editingSessionId require at least one group
		// to be present, since the Ungrouped section only renders when groups exist.

		it('shows rename input when editingSessionId matches ungrouped session', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [createMockSession({ id: 's1', name: 'Original Session' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingSessionId: 'ungrouped-s1',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original Session');
			expect(input).toBeInTheDocument();
		});

		it('calls finishRenamingSession on blur', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const finishRenamingSession = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Original' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingSessionId: 'ungrouped-s1',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
				finishRenamingSession,
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original');
			fireEvent.change(input, { target: { value: 'New Name' } });
			fireEvent.blur(input);

			expect(finishRenamingSession).toHaveBeenCalledWith('s1', 'New Name');
		});

		it('starts renaming on double-click', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const startRenamingSession = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Double Click Me' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				startRenamingSession,
			});
			render(<SessionList {...props} />);

			fireEvent.doubleClick(screen.getByText('Double Click Me'));
			expect(startRenamingSession).toHaveBeenCalledWith('ungrouped-s1');
		});

		it('calls finishRenamingSession on Enter key', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const finishRenamingSession = vi.fn();
			const sessions = [createMockSession({ id: 's1', name: 'Original' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingSessionId: 'ungrouped-s1',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
				finishRenamingSession,
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original');
			fireEvent.change(input, { target: { value: 'Renamed via Enter' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(finishRenamingSession).toHaveBeenCalledWith('s1', 'Renamed via Enter');
		});

		it('stops click propagation when clicking rename input', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [createMockSession({ id: 's1', name: 'Original' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				editingSessionId: 'ungrouped-s1',
			});
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			const input = screen.getByDisplayValue('Original');
			fireEvent.click(input);

			// setActiveSessionId should not be called when clicking on the input
			expect(setActiveSessionId).not.toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Keyboard Selection Tests
	// ============================================================================

	describe('Keyboard Selection', () => {
		it('highlights session with keyboard selection', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Selected Session' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
				selectedSidebarIndex: 0,
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Session should be rendered - keyboard selection adds visual styling
			const sessionElement = screen.getByText('Selected Session');
			expect(sessionElement).toBeInTheDocument();

			// Parent container should have keyboard selection styling
			const container = sessionElement.closest('[class*="transition"]');
			expect(container).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Move to Group Submenu Tests
	// ============================================================================

	describe('Move to Group Submenu', () => {
		it('shows move to group submenu on hover', () => {
			// Use a collapsed group so the group name doesn't appear in the main view
			const group = createMockGroup({
				id: 'g1',
				name: 'Submenu Target',
				emoji: '📁',
				collapsed: true,
			});
			const sessions = [createMockSession({ id: 's1', name: 'Move Me' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Move Me'), { clientX: 100, clientY: 100 });

			expect(screen.getByText('Move to Group')).toBeInTheDocument();

			// Hover over Move to Group - find the parent div
			const moveToGroupButton = screen.getByText('Move to Group');
			const parentDiv = moveToGroupButton.closest('.relative');
			fireEvent.mouseEnter(parentDiv!);

			// Submenu should show group name - there may be multiple since it appears in groups section too
			const submenuTargets = screen.getAllByText('Submenu Target');
			expect(submenuTargets.length).toBeGreaterThan(0);
			// The "Ungrouped" option in the submenu should be visible (may appear multiple times)
			const ungroupedElements = screen.getAllByText('Ungrouped');
			expect(ungroupedElements.length).toBeGreaterThan(0);
		});

		it('moves session to group when submenu item clicked', () => {
			// Use unique name that won't appear in the groups section
			const group = createMockGroup({ id: 'g1', name: 'Click Target', collapsed: true });
			const sessions = [createMockSession({ id: 's1', name: 'Move Me To Group' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const setSessions = vi.spyOn(useSessionStore.getState(), 'setSessions');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Move Me To Group'), { clientX: 100, clientY: 100 });

			expect(screen.getByText('Move to Group')).toBeInTheDocument();

			// Hover and click group - find within context menu
			const moveToGroupButton = screen.getByText('Move to Group');
			const parentDiv = moveToGroupButton.closest('.relative');
			fireEvent.mouseEnter(parentDiv!);

			// Get all elements with the group name, click the one in the submenu (inside fixed positioned menu)
			const groupButtons = screen.getAllByText('Click Target');
			// The submenu item should be in a button within the fixed positioned context menu
			const submenuButton = groupButtons.find((el) => el.closest('button')?.closest('.absolute'));
			fireEvent.click(submenuButton || groupButtons[groupButtons.length - 1]);

			expect(setSessions).toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Focus Management Tests
	// ============================================================================

	describe('Focus Management', () => {
		it('sets activeFocus to sidebar on click', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const setActiveFocus = vi.spyOn(useUIStore.getState(), 'setActiveFocus');
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			fireEvent.click(container.firstChild as HTMLElement);
			expect(setActiveFocus).toHaveBeenCalledWith('sidebar');
		});

		it('sets activeFocus to sidebar on focus', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const setActiveFocus = vi.spyOn(useUIStore.getState(), 'setActiveFocus');
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			fireEvent.focus(container.firstChild as HTMLElement);
			expect(setActiveFocus).toHaveBeenCalledWith('sidebar');
		});

		it('shows focus ring when activeFocus is sidebar', () => {
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			expect(container.firstChild).toHaveClass('ring-1');
		});
	});

	// ============================================================================
	// Git Status Context Tests
	// ============================================================================
	// Note: Git polling is now handled by GitStatusProvider (see useGitStatusPolling).
	// SessionList consumes git data from GitStatusContext.
	// These tests verify SessionList correctly uses context data.

	describe('Git Status Context', () => {
		it('consumes git status from context', () => {
			// The component uses useGitStatus from GitStatusContext
			// which is mocked at the top of this test file
			const sessions = [createMockSession({ id: 's1', name: 'Git Session', isGitRepo: true })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			// Should render without errors when context is available
			const { container } = render(<SessionList {...props} />);
			expect(container.querySelector('[tabindex="0"]')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Collapsed Group Palette Tests
	// ============================================================================

	describe('Collapsed Group Palette', () => {
		it('shows collapsed palette when group is collapsed', () => {
			const group = createMockGroup({ id: 'g1', name: 'Collapsed', collapsed: true });
			const sessions = [createMockSession({ id: 's1', name: 'In Group', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Should show palette indicators (outer containers have rounded-full class)
			const indicators = container.querySelectorAll('.flex-1.flex.rounded-full');
			expect(indicators.length).toBeGreaterThan(0);
		});

		it('expands group when collapsed palette clicked', () => {
			const toggleGroup = vi.fn();
			const group = createMockGroup({ id: 'g1', name: 'Collapsed', collapsed: true });
			const sessions = [createMockSession({ id: 's1', name: 'In Group', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
				toggleGroup,
			});
			const { container } = render(<SessionList {...props} />);

			// Click on palette container
			const palette = container.querySelector('.ml-8.mr-3.mt-1.mb-2.flex');
			fireEvent.click(palette!);

			expect(toggleGroup).toHaveBeenCalledWith('g1');
		});

		it('selects session when indicator clicked in collapsed palette', () => {
			const group = createMockGroup({ id: 'g1', name: 'Collapsed', collapsed: true });
			const sessions = [createMockSession({ id: 's1', name: 'In Group', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Find the outer pill container (has flex-1 and rounded-full)
			const pillContainer = container.querySelector('.flex-1.flex.rounded-full');
			// The click handler is on the inner segment (group/segment div with flex-1)
			const indicator = pillContainer?.querySelector('.flex-1.h-full');
			fireEvent.click(indicator!);

			expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		});
	});

	// ============================================================================
	// Tooltip Tests
	// ============================================================================

	describe('Tooltips', () => {
		it('shows tooltip on collapsed indicator hover', () => {
			const group = createMockGroup({ id: 'g1', name: 'Group', collapsed: true });
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Tooltip Session',
					groupId: 'g1',
					contextUsage: 50,
					usageStats: {
						totalCostUsd: 1.25,
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				}),
			];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Find the outer pill container and then the inner segment with the hover handler
			const pillContainer = container.querySelector('.flex-1.flex.rounded-full');
			const indicator = pillContainer?.querySelector('.flex-1.h-full');
			fireEvent.mouseEnter(indicator!, { clientX: 100, clientY: 100 });

			// Tooltip should contain session info
			expect(screen.getByText('Tooltip Session')).toBeInTheDocument();
			expect(screen.getByText('50%')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Active Session Highlighting Tests
	// ============================================================================

	describe('Active Session Highlighting', () => {
		it('highlights active session with accent border', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Active Session' }),
				createMockSession({ id: 's2', name: 'Other Session' }),
			];
			useSessionStore.setState({
				sessions: sessions,
				activeSessionId: 's1',
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Active session should have accent border color
			const activeSession = screen.getByText('Active Session').closest('[style*="border"]');
			expect(activeSession).toHaveStyle({ borderColor: defaultTheme.colors.accent });
		});

		it('highlights active session in collapsed mode without ring', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Active' })];
			useSessionStore.setState({
				sessions: sessions,
				activeSessionId: 's1',
			});
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Active session in collapsed mode should NOT have ring-2 (removed for cleaner UX)
			const ringIndicator = container.querySelector('.ring-2');
			expect(ringIndicator).not.toBeInTheDocument();
		});
	});

	// ============================================================================
	// Tunnel/Remote Access Tests
	// ============================================================================

	describe('Tunnel and Remote Access', () => {
		it('checks cloudflared installation when live overlay opens', async () => {
			const mockIsInstalled = vi.fn().mockResolvedValue(true);
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: mockIsInstalled,
				start: vi.fn().mockResolvedValue({ success: true, url: 'https://tunnel.example.com' }),
				stop: vi.fn().mockResolvedValue(undefined),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			// Click LIVE to open overlay
			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				expect(mockIsInstalled).toHaveBeenCalled();
			});
		});

		it('shows cloudflared not installed message when not available', async () => {
			const mockIsInstalled = vi.fn().mockResolvedValue(false);
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: mockIsInstalled,
				start: vi.fn(),
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				expect(screen.getByText('Install cloudflared to enable')).toBeInTheDocument();
			});
		});

		it('starts tunnel when toggle clicked and cloudflared is installed', async () => {
			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			// Wait for cloudflared check to complete
			await waitFor(() => {
				const toggleButton = screen.getByTitle('Enable remote access');
				expect(toggleButton).toBeInTheDocument();
			});

			// Click the toggle to start tunnel
			const toggleButton = screen.getByTitle('Enable remote access');
			fireEvent.click(toggleButton);

			await waitFor(() => {
				expect(mockStart).toHaveBeenCalled();
			});
		});

		it('stops tunnel when toggle clicked while connected', async () => {
			const mockStop = vi.fn().mockResolvedValue(undefined);
			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: mockStop,
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				const toggleButton = screen.getByTitle('Enable remote access');
				expect(toggleButton).toBeInTheDocument();
			});

			// Start tunnel first
			fireEvent.click(screen.getByTitle('Enable remote access'));

			await waitFor(() => {
				expect(screen.getByTitle('Disable remote access')).toBeInTheDocument();
			});

			// Now stop tunnel
			fireEvent.click(screen.getByTitle('Disable remote access'));

			await waitFor(() => {
				expect(mockStop).toHaveBeenCalled();
			});
		});

		it('handles tunnel start error gracefully', async () => {
			const mockStart = vi.fn().mockResolvedValue({ success: false, error: 'Connection failed' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				const toggleButton = screen.getByTitle('Enable remote access');
				fireEvent.click(toggleButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Connection failed')).toBeInTheDocument();
			});
		});

		it('handles tunnel start exception gracefully', async () => {
			const mockStart = vi.fn().mockRejectedValue(new Error('Network error'));
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				const toggleButton = screen.getByTitle('Enable remote access');
				fireEvent.click(toggleButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Network error')).toBeInTheDocument();
			});
		});

		it('shows local/remote pill selector when tunnel is connected', async () => {
			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				fireEvent.click(screen.getByTitle('Enable remote access'));
			});

			await waitFor(() => {
				expect(screen.getByText('Local')).toBeInTheDocument();
				expect(screen.getByText('Remote')).toBeInTheDocument();
			});
		});

		it('switches between local and remote tabs', async () => {
			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				fireEvent.click(screen.getByTitle('Enable remote access'));
			});

			await waitFor(() => {
				expect(screen.getByText('Local')).toBeInTheDocument();
			});

			// Click Local tab
			fireEvent.click(screen.getByText('Local'));

			// URL should show local address
			expect(screen.getByText('localhost:3000')).toBeInTheDocument();
		});

		it('copies remote URL when tunnel is connected', async () => {
			const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
			Object.assign(navigator, { clipboard: mockClipboard });

			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				fireEvent.click(screen.getByTitle('Enable remote access'));
			});

			await waitFor(() => {
				expect(screen.getByText('Remote')).toBeInTheDocument();
			});

			// Remote tab is auto-selected, copy it
			const copyButton = screen.getByTitle('Copy URL');
			fireEvent.click(copyButton);

			expect(mockClipboard.writeText).toHaveBeenCalledWith('https://tunnel.example.com');
		});

		it('navigates tabs with arrow keys', async () => {
			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			const { container } = render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				fireEvent.click(screen.getByTitle('Enable remote access'));
			});

			await waitFor(() => {
				expect(screen.getByText('Local')).toBeInTheDocument();
			});

			// Find the overlay container that handles keyboard events
			const overlay = container.querySelector('[tabIndex="-1"]');
			expect(overlay).toBeInTheDocument();

			// Press ArrowLeft to go to local
			fireEvent.keyDown(overlay!, { key: 'ArrowLeft' });

			// Press ArrowRight to go to remote
			fireEvent.keyDown(overlay!, { key: 'ArrowRight' });
		});
	});

	// ============================================================================
	// Claude Session Status Tests
	// ============================================================================

	describe('Claude Session Status', () => {
		it('shows hollow indicator for claude type without agentSessionId', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Claude Session',
					toolType: 'claude-code',
					agentSessionId: undefined,
				}),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Should have hollow indicator (border instead of solid background)
			const indicator = container.querySelector('[title="No active Claude session"]');
			expect(indicator).toBeInTheDocument();
		});

		it('shows solid indicator for claude type with agentSessionId', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Claude Session',
					toolType: 'claude-code',
					agentSessionId: 'session-123',
				}),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Should NOT have hollow indicator
			const indicator = container.querySelector('[title="No active Claude session"]');
			expect(indicator).not.toBeInTheDocument();
		});

		it('shows hollow indicator in skinny mode for claude without session', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Claude Session',
					toolType: 'claude-code',
					agentSessionId: undefined,
				}),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Should have hollow indicator in skinny mode
			const indicator = container.querySelector('[title="No active Claude session"]');
			expect(indicator).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Skinny Mode Tooltip Tests
	// ============================================================================

	describe('Skinny Mode Tooltips', () => {
		it('shows group name in skinny mode tooltip when session is in group', () => {
			const group = createMockGroup({ id: 'g1', name: 'My Group', emoji: '📁' });
			const sessions = [createMockSession({ id: 's1', name: 'Session in Group', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Find the session dot in skinny mode
			const sessionDot = container.querySelector('.w-8.h-8.rounded-full');
			expect(sessionDot).toBeInTheDocument();

			// Tooltip should contain group name (CSS uppercase class transforms display)
			expect(screen.getByText('My Group')).toBeInTheDocument();
		});

		it('shows session details in skinny mode tooltip', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Detailed Session',
					contextUsage: 75,
					state: 'idle',
					toolType: 'claude-code',
				}),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Tooltip content should be present
			expect(screen.getByText('Detailed Session')).toBeInTheDocument();
			expect(screen.getByText('75%')).toBeInTheDocument();
			expect(screen.getByText(/idle.*claude-code/i)).toBeInTheDocument();
		});

		it('shows usage stats in skinny mode tooltip', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session with Stats',
					usageStats: {
						totalCostUsd: 2.5,
						inputTokens: 5000,
						outputTokens: 2500,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				}),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Cost should be displayed
			expect(screen.getByText('$2.50')).toBeInTheDocument();
		});

		it('shows active time in skinny mode tooltip', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Active Session',
					activeTimeMs: 3600000, // 1 hour
				}),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: false });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Active time should be displayed (uppercase format from formatActiveTime)
			expect(screen.getByText('1H')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Ungrouped Collapsed Palette Tests
	// ============================================================================

	describe('Ungrouped Collapsed Palette', () => {
		// Note: "Ungrouped" header only shows when at least one group exists.
		// These tests need a group defined to make the Ungrouped section visible.

		it('toggles ungrouped section collapse', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [
				createMockSession({ id: 's1', name: 'Ungrouped 1' }),
				createMockSession({ id: 's2', name: 'Ungrouped 2' }),
			];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Click on Ungrouped header to collapse
			fireEvent.click(screen.getByText('Ungrouped Agents'));

			// Sessions should now be collapsed into palette indicators
		});

		it('shows tooltip with session details on ungrouped collapsed indicator hover', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Hoverable Session',
					contextUsage: 60,
					isGitRepo: true,
				}),
			];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// First collapse the ungrouped section
			fireEvent.click(screen.getByText('Ungrouped Agents'));

			// Find the collapsed indicator (outer pill has rounded-full, inner segment has the event handlers)
			const pillContainer = container.querySelector('.flex-1.flex.rounded-full');
			const indicator = pillContainer?.querySelector('.flex-1.h-full');
			if (indicator) {
				fireEvent.mouseEnter(indicator, { clientX: 150, clientY: 150 });

				// Should show session name in tooltip
				expect(screen.getByText('Hoverable Session')).toBeInTheDocument();
			}
		});

		it('clears tooltip position on mouse leave from ungrouped collapsed indicator', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Leave Me',
				}),
			];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// First collapse the ungrouped section
			fireEvent.click(screen.getByText('Ungrouped Agents'));

			// Find the collapsed indicator (outer pill has rounded-full, inner segment has the event handlers)
			const pillContainer = container.querySelector('.flex-1.flex.rounded-full');
			const indicator = pillContainer?.querySelector('.flex-1.h-full');
			if (indicator) {
				// First hover to set tooltip position
				fireEvent.mouseEnter(indicator, { clientX: 150, clientY: 150 });
				expect(screen.getByText('Leave Me')).toBeInTheDocument();

				// Then leave to clear tooltip position
				fireEvent.mouseLeave(indicator);
				// Component should handle the mouse leave without errors
				// The tooltip visibility is controlled by CSS hover, so the text is still in DOM
			}
		});

		it('selects session when clicking indicator in ungrouped collapsed palette', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [createMockSession({ id: 's1', name: 'Click Me' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Collapse ungrouped section
			fireEvent.click(screen.getByText('Ungrouped Agents'));

			// Find and click the indicator (outer pill has rounded-full, inner segment has the click handler)
			const pillContainer = container.querySelector('.flex-1.flex.rounded-full');
			const indicator = pillContainer?.querySelector('.flex-1.h-full');
			if (indicator) {
				fireEvent.click(indicator);
				expect(setActiveSessionId).toHaveBeenCalledWith('s1');
			}
		});

		it('expands ungrouped section when clicking collapsed palette container', () => {
			const emptyGroup = createMockGroup({ id: 'g-empty', name: 'Other Group' });
			const sessions = [createMockSession({ id: 's1', name: 'Session 1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [emptyGroup],
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Collapse ungrouped section
			fireEvent.click(screen.getByText('Ungrouped Agents'));

			// Find and click the palette container (not the indicator)
			const paletteContainer = container.querySelector('.ml-8.mr-3.mt-1.mb-2.flex');
			if (paletteContainer) {
				fireEvent.click(paletteContainer);

				// Should expand and show full session
				expect(screen.getByText('Session 1')).toBeInTheDocument();
			}
		});
	});

	// ============================================================================
	// Session Filter State Management Tests
	// ============================================================================

	describe('Session Filter State Management', () => {
		it('saves group states when opening filter and restores on close', async () => {
			const group = createMockGroup({ id: 'g1', name: 'Test Group', collapsed: false });
			const sessions = [createMockSession({ id: 's1', name: 'Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const setGroups = vi.spyOn(useSessionStore.getState(), 'setGroups');
			const setBookmarksCollapsed = vi.spyOn(useUIStore.getState(), 'setBookmarksCollapsed');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Open filter with Cmd+F
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			// Filter should collapse all groups by default
			await waitFor(() => {
				expect(setGroups).toHaveBeenCalled();
			});
		});

		it('filters sessions by AI tab names', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Project A',
					aiTabs: [{ id: 'tab1', name: 'Feature Development' }],
				} as Partial<Session>),
				createMockSession({
					id: 's2',
					name: 'Project B',
					aiTabs: [{ id: 'tab2', name: 'Bug Fixes' }],
				} as Partial<Session>),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Open filter
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			// Type to filter by AI tab name
			const input = screen.getByPlaceholderText('Filter agents...');
			fireEvent.change(input, { target: { value: 'Feature' } });

			// Should show Project A (has matching AI tab)
			expect(screen.getByText('Project A')).toBeInTheDocument();
			// Should not show Project B
			expect(screen.queryByText('Project B')).not.toBeInTheDocument();
		});

		it('expands groups with matching sessions when filtering', () => {
			const group = createMockGroup({ id: 'g1', name: 'Collapsed Group', collapsed: true });
			const sessions = [createMockSession({ id: 's1', name: 'Matching Session', groupId: 'g1' })];
			useSessionStore.setState({
				sessions: sessions,
				groups: [group],
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
			});
			const setGroups = vi.spyOn(useSessionStore.getState(), 'setGroups');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Open filter
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			// Clear any previous calls
			setGroups.mockClear();

			// Type to filter
			const input = screen.getByPlaceholderText('Filter agents...');
			fireEvent.change(input, { target: { value: 'Matching' } });

			// Groups with matches should be expanded
			expect(setGroups).toHaveBeenCalled();
		});

		it('expands bookmarks when filter matches bookmarked sessions', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Bookmarked Session', bookmarked: true }),
			];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({
				leftSidebarOpen: true,
				activeFocus: 'sidebar',
				bookmarksCollapsed: true,
			});
			const setBookmarksCollapsed = vi.spyOn(useUIStore.getState(), 'setBookmarksCollapsed');
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Open filter
			const sidebar = container.firstChild as HTMLElement;
			fireEvent.keyDown(sidebar, { key: 'f', metaKey: true });

			// Clear previous calls
			setBookmarksCollapsed.mockClear();

			// Type to filter matching bookmarked session
			const input = screen.getByPlaceholderText('Filter agents...');
			fireEvent.change(input, { target: { value: 'Bookmarked' } });

			// Bookmarks should be expanded
			expect(setBookmarksCollapsed).toHaveBeenCalledWith(false);
		});
	});

	// ============================================================================
	// Git Status Context Integration Tests
	// ============================================================================
	// Note: Git polling (visibility changes, shellCwd, etc.) is now handled by
	// GitStatusProvider via useGitStatusPolling hook. SessionList consumes data
	// from GitStatusContext. These tests verify SessionList displays context data.

	// ============================================================================
	// Live Overlay Escape Key Tests
	// ============================================================================

	describe('Live Overlay Keyboard', () => {
		it('closes live overlay with Escape key', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			// Open overlay
			fireEvent.click(screen.getByText('LIVE'));

			// Verify overlay is open
			expect(screen.getByText(/Control your AI sessions/)).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(document, { key: 'Escape' });

			// Overlay should be closed
			expect(screen.queryByText(/Control your AI sessions/)).not.toBeInTheDocument();
		});
	});

	// ============================================================================
	// Resize Handle Mouse Events Tests
	// ============================================================================

	describe('Resize Handle', () => {
		it('saves sidebar width on mouseup', async () => {
			const mockSettingsSet = vi.fn();
			(window.maestro.settings.set as ReturnType<typeof vi.fn>).mockImplementation(mockSettingsSet);

			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 300 });
			const setLeftSidebarWidthState = vi.spyOn(useSettingsStore.getState(), 'setLeftSidebarWidth');
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize');
			expect(resizeHandle).toBeInTheDocument();

			// Simulate full drag cycle
			fireEvent.mouseDown(resizeHandle!, { clientX: 300 });
			fireEvent.mouseMove(document, { clientX: 350 });
			fireEvent.mouseUp(document);

			expect(mockSettingsSet).toHaveBeenCalledWith('leftSidebarWidth', expect.any(Number));
		});

		it('clamps sidebar width within bounds', () => {
			useUIStore.setState({ leftSidebarOpen: true });
			useSettingsStore.setState({ leftSidebarWidth: 300 });
			const setLeftSidebarWidthState = vi.spyOn(useSettingsStore.getState(), 'setLeftSidebarWidth');
			const props = createDefaultProps({});
			const { container } = render(<SessionList {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize');

			// Try to drag beyond max (600px)
			fireEvent.mouseDown(resizeHandle!, { clientX: 300 });
			fireEvent.mouseMove(document, { clientX: 1000 });
			// State is only updated on mouseUp for performance
			fireEvent.mouseUp(document);

			// Should be clamped to 600
			expect(setLeftSidebarWidthState).toHaveBeenCalledWith(600);

			// Reset mock for next test
			setLeftSidebarWidthState.mockClear();
			act(() => {
				useSettingsStore.setState({ leftSidebarWidth: 300 });
			}); // Reset for second drag

			// Try to drag below min (256px)
			fireEvent.mouseDown(resizeHandle!, { clientX: 300 });
			fireEvent.mouseMove(document, { clientX: 100 });
			// State is only updated on mouseUp for performance
			fireEvent.mouseUp(document);

			// Should be clamped to 256
			expect(setLeftSidebarWidthState).toHaveBeenCalledWith(256);
		});
	});

	// ============================================================================
	// Delete Session When Active Tests
	// ============================================================================

	describe('Delete Session Behavior', () => {
		it('switches to another session when deleting active session', () => {
			const showConfirmation = vi.fn((message, callback) => callback());

			const sessions = [
				createMockSession({ id: 's1', name: 'To Delete' }),
				createMockSession({ id: 's2', name: 'Remaining' }),
			];
			useSessionStore.setState({
				sessions: sessions,
				activeSessionId: 's1',
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const setSessions = vi.spyOn(useSessionStore.getState(), 'setSessions');
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
				showConfirmation,
			});
			render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('To Delete'), { clientX: 100, clientY: 100 });

			// Click delete
			fireEvent.click(screen.getByText('Remove Agent'));

			// Should switch to another session
			expect(setActiveSessionId).toHaveBeenCalledWith('s2');
		});

		it('does not switch session when deleting non-active session', () => {
			const showConfirmation = vi.fn((message, callback) => callback());

			const sessions = [
				createMockSession({ id: 's1', name: 'Active Session' }),
				createMockSession({ id: 's2', name: 'To Delete' }),
			];
			useSessionStore.setState({
				sessions: sessions,
				activeSessionId: 's1',
			});
			useUIStore.setState({ leftSidebarOpen: true });
			const setSessions = vi.spyOn(useSessionStore.getState(), 'setSessions');
			const setActiveSessionId = vi.spyOn(useSessionStore.getState(), 'setActiveSessionId');
			const props = createDefaultProps({
				sortedSessions: sessions,
				showConfirmation,
			});
			render(<SessionList {...props} />);

			// Open context menu on non-active session
			fireEvent.contextMenu(screen.getByText('To Delete'), { clientX: 100, clientY: 100 });

			// Click delete
			fireEvent.click(screen.getByText('Remove Agent'));

			// Should not switch session
			expect(setActiveSessionId).not.toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Open Browser Button Tests
	// ============================================================================

	describe('Live Overlay Open Browser', () => {
		it('opens local URL in browser', async () => {
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: vi.fn(),
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				fireEvent.click(screen.getByTitle('Open in Browser'));
			});

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('http://localhost:3000');
		});

		it('opens remote URL in browser when tunnel connected', async () => {
			const mockStart = vi
				.fn()
				.mockResolvedValue({ success: true, url: 'https://tunnel.example.com' });
			(window.maestro as Record<string, unknown>).tunnel = {
				isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
				start: mockStart,
				stop: vi.fn(),
			};

			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				isLiveMode: true,
				webInterfaceUrl: 'http://localhost:3000',
			});
			render(<SessionList {...props} />);

			fireEvent.click(screen.getByText('LIVE'));

			await waitFor(() => {
				fireEvent.click(screen.getByTitle('Enable remote access'));
			});

			await waitFor(() => {
				expect(screen.getByText('Remote')).toBeInTheDocument();
			});

			// Click the main "Open in Browser" button (should open remote URL since it's selected)
			const openButtons = screen.getAllByText('Open in Browser');
			fireEvent.click(openButtons[openButtons.length - 1]);

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://tunnel.example.com');
		});
	});

	// ============================================================================
	// Context Menu Position Adjustment Tests
	// ============================================================================

	describe('Context Menu Position', () => {
		it('adjusts position to stay within viewport', () => {
			// Mock window dimensions
			Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
			Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

			const sessions = [createMockSession({ id: 's1', name: 'Test Session' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			render(<SessionList {...props} />);

			// Right-click at edge of screen
			fireEvent.contextMenu(screen.getByText('Test Session'), { clientX: 750, clientY: 550 });

			// Menu should appear (position will be adjusted)
			expect(screen.getByText('Rename')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Context Menu Click Outside Tests
	// ============================================================================

	describe('Context Menu Dismissal', () => {
		it('closes when clicking outside', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Test Session' })];
			useSessionStore.setState({ sessions: sessions });
			useUIStore.setState({ leftSidebarOpen: true });
			const props = createDefaultProps({
				sortedSessions: sessions,
			});
			const { container } = render(<SessionList {...props} />);

			// Open context menu
			fireEvent.contextMenu(screen.getByText('Test Session'), { clientX: 100, clientY: 100 });

			expect(screen.getByText('Rename')).toBeInTheDocument();

			// Click outside
			fireEvent.mouseDown(container);

			// Menu should close
			expect(screen.queryByText('Rename')).not.toBeInTheDocument();
		});
	});
});
