import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuickActionsModal } from '../../../renderer/components/QuickActionsModal';
import type { Session, Group, Theme, Shortcut } from '../../../renderer/types';

// Add missing window.maestro.devtools and debug mocks
beforeAll(() => {
	(window.maestro as any).devtools = {
		toggle: vi.fn(),
	};
	(window.maestro as any).debug = {
		createPackage: vi.fn().mockResolvedValue({ success: true, path: '/tmp/test.zip' }),
		previewPackage: vi.fn().mockResolvedValue({ categories: [] }),
	};

	// Mock localStorage for the test environment
	const localStorageMock = {
		getItem: vi.fn().mockReturnValue(null),
		setItem: vi.fn(),
		removeItem: vi.fn(),
		clear: vi.fn(),
		length: 0,
		key: vi.fn(),
	};
	Object.defineProperty(window, 'localStorage', {
		value: localStorageMock,
		writable: true,
	});
});

// Mock dependencies
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

vi.mock('../../../renderer/contexts/ToastContext', () => ({
	useToast: () => ({
		addToast: vi.fn(),
	}),
}));

vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		QUICK_ACTION: 100,
	},
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getDiff: vi.fn().mockResolvedValue({ diff: 'mock diff content' }),
		getRemoteBrowserUrl: vi.fn().mockResolvedValue('https://github.com/test/repo'),
	},
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Search: () => <svg data-testid="search-icon" />,
}));

// Create mock theme
const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		bgTerminal: '#1a1a2e',
		textMain: '#eaeaea',
		textDim: '#888',
		accent: '#e94560',
		accentForeground: '#ffffff',
		error: '#ff6b6b',
		border: '#333',
		success: '#4ecdc4',
		warning: '#ffd93d',
		terminalCursor: '#e94560',
	},
};

// Create mock shortcuts
const mockShortcuts: Record<string, Shortcut> = {
	newInstance: { id: 'newInstance', keys: ['Cmd', 'N'], enabled: true },
	toggleMode: { id: 'toggleMode', keys: ['Cmd', 'J'], enabled: true },
	toggleSidebar: { id: 'toggleSidebar', keys: ['Cmd', 'B'], enabled: true },
	toggleRightPanel: { id: 'toggleRightPanel', keys: ['Cmd', 'R'], enabled: true },
	killInstance: { id: 'killInstance', keys: ['Cmd', 'W'], enabled: true },
	settings: { id: 'settings', keys: ['Cmd', ','], enabled: true },
	help: { id: 'help', keys: ['Cmd', '/'], enabled: true },
	systemLogs: { id: 'systemLogs', keys: ['Cmd', 'L'], enabled: true },
	processMonitor: { id: 'processMonitor', keys: ['Cmd', 'P'], enabled: true },
	agentSessions: { id: 'agentSessions', keys: ['Cmd', 'Shift', 'A'], enabled: true },
	viewGitDiff: { id: 'viewGitDiff', keys: ['Cmd', 'D'], enabled: true },
	viewGitLog: { id: 'viewGitLog', keys: ['Cmd', 'G'], enabled: true },
	toggleMarkdownMode: { id: 'toggleMarkdownMode', keys: ['Cmd', 'M'], enabled: true },
	createDebugPackage: { id: 'createDebugPackage', keys: ['Alt', 'Cmd', 'D'], enabled: true },
};

// Create mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
	aiPid: 1234,
	terminalPid: 5678,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	...overrides,
});

// Create mock group
const createMockGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Test Group',
	emoji: '📁',
	collapsed: false,
	...overrides,
});

// Default props factory
const createDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof QuickActionsModal>> = {}
) => ({
	theme: mockTheme,
	sessions: [createMockSession()],
	setSessions: vi.fn(),
	activeSessionId: 'session-1',
	groups: [],
	setGroups: vi.fn(),
	shortcuts: mockShortcuts,
	setQuickActionOpen: vi.fn(),
	setActiveSessionId: vi.fn(),
	setRenameInstanceModalOpen: vi.fn(),
	setRenameInstanceValue: vi.fn(),
	setRenameGroupModalOpen: vi.fn(),
	setRenameGroupId: vi.fn(),
	setRenameGroupValue: vi.fn(),
	setRenameGroupEmoji: vi.fn(),
	setCreateGroupModalOpen: vi.fn(),
	setLeftSidebarOpen: vi.fn(),
	setRightPanelOpen: vi.fn(),
	setActiveRightTab: vi.fn(),
	toggleInputMode: vi.fn(),
	deleteSession: vi.fn(),
	addNewSession: vi.fn(),
	setSettingsModalOpen: vi.fn(),
	setSettingsTab: vi.fn(),
	setShortcutsHelpOpen: vi.fn(),
	setAboutModalOpen: vi.fn(),
	setLogViewerOpen: vi.fn(),
	setProcessMonitorOpen: vi.fn(),
	setAgentSessionsOpen: vi.fn(),
	setActiveAgentSessionId: vi.fn(),
	setGitDiffPreview: vi.fn(),
	setGitLogOpen: vi.fn(),
	...overrides,
});

describe('QuickActionsModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Basic rendering', () => {
		it('renders with dialog role and aria attributes', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Quick Actions');
		});

		it('renders search input with correct placeholder', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			expect(input).toBeInTheDocument();
		});

		it('renders search icon', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByTestId('search-icon')).toBeInTheDocument();
		});

		it('renders ESC badge', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('ESC')).toBeInTheDocument();
		});

		it('auto-focuses input on mount', async () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			await waitFor(
				() => {
					const input = screen.getByPlaceholderText('Type a command or jump to agent...');
					expect(input).toHaveFocus();
				},
				{ timeout: 100 }
			);
		});
	});

	describe('Main actions list', () => {
		it('renders jump to session action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Jump to: Test Session')).toBeInTheDocument();
		});

		it('renders Create New Agent action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Create New Agent')).toBeInTheDocument();
		});

		it('renders Rename Agent action when session exists', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Rename Agent: Test Session')).toBeInTheDocument();
		});

		it('does not render Rename Agent when no active session', () => {
			const props = createDefaultProps({
				activeSessionId: '',
				sessions: [],
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText(/Rename Agent:/)).not.toBeInTheDocument();
		});

		it('renders Toggle Sidebar action with shortcut', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Toggle Sidebar')).toBeInTheDocument();
			expect(screen.getByText('Cmd+B')).toBeInTheDocument();
		});

		it('renders Settings action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Settings')).toBeInTheDocument();
		});

		it('renders About Maestro action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('About Maestro')).toBeInTheDocument();
		});

		it('renders subtext for session state', () => {
			const props = createDefaultProps({
				sessions: [createMockSession({ state: 'busy' })],
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('BUSY')).toBeInTheDocument();
		});
	});

	describe('Session actions', () => {
		it('handles Jump to session action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Jump to: Test Session'));

			expect(props.setActiveSessionId).toHaveBeenCalledWith('session-1');
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('auto-expands collapsed group when jumping to session in group', () => {
			const session = createMockSession({ groupId: 'group-1' });
			const group = createMockGroup({ collapsed: true });
			const props = createDefaultProps({
				sessions: [session],
				groups: [group],
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Jump to: Test Session'));

			expect(props.setGroups).toHaveBeenCalled();
			const setGroupsFn = props.setGroups.mock.calls[0][0];
			const result = setGroupsFn([group]);
			expect(result[0].collapsed).toBe(false);
		});

		it('handles Create New Agent action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Create New Agent'));

			expect(props.addNewSession).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Rename Agent action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Rename Agent: Test Session'));

			expect(props.setRenameInstanceValue).toHaveBeenCalledWith('Test Session');
			expect(props.setRenameInstanceModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Remove Agent action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Remove Agent: Test Session'));

			expect(props.deleteSession).toHaveBeenCalledWith('session-1');
		});
	});

	describe('Toggle actions', () => {
		it('handles Toggle Sidebar action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Toggle Sidebar'));

			expect(props.setLeftSidebarOpen).toHaveBeenCalled();
		});

		it('handles Toggle Right Panel action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Toggle Right Panel'));

			expect(props.setRightPanelOpen).toHaveBeenCalled();
		});

		it('handles Switch AI/Shell Mode action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Switch AI/Shell Mode'));

			expect(props.toggleInputMode).toHaveBeenCalled();
		});
	});

	describe('Settings and help actions', () => {
		it('handles Settings action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Settings'));

			expect(props.setSettingsModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Change Theme action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Change Theme'));

			expect(props.setSettingsModalOpen).toHaveBeenCalledWith(true);
			expect(props.setSettingsTab).toHaveBeenCalledWith('theme');
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles View Shortcuts action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View Shortcuts'));

			expect(props.setShortcutsHelpOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles View System Logs action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View System Logs'));

			expect(props.setLogViewerOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles View System Processes action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View System Processes'));

			expect(props.setProcessMonitorOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles About Maestro action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('About Maestro'));

			expect(props.setAboutModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});

	describe('Right panel navigation', () => {
		it('handles Go to Files Tab action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Go to Files Tab'));

			expect(props.setRightPanelOpen).toHaveBeenCalledWith(true);
			expect(props.setActiveRightTab).toHaveBeenCalledWith('files');
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Go to History Tab action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Go to History Tab'));

			expect(props.setRightPanelOpen).toHaveBeenCalledWith(true);
			expect(props.setActiveRightTab).toHaveBeenCalledWith('history');
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Go to Auto Run Tab action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Go to Auto Run Tab'));

			expect(props.setRightPanelOpen).toHaveBeenCalledWith(true);
			expect(props.setActiveRightTab).toHaveBeenCalledWith('autorun');
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});

	describe('Git actions', () => {
		it('renders git actions for git repo', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('View Git Diff')).toBeInTheDocument();
			expect(screen.getByText('View Git Log')).toBeInTheDocument();
			expect(screen.getByText('Open Repository in Browser')).toBeInTheDocument();
		});

		it('does not render git actions for non-git repo', () => {
			const props = createDefaultProps({
				sessions: [createMockSession({ isGitRepo: false })],
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText('View Git Diff')).not.toBeInTheDocument();
			expect(screen.queryByText('View Git Log')).not.toBeInTheDocument();
		});

		it('handles View Git Diff action', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View Git Diff'));

			await waitFor(() => {
				expect(gitService.getDiff).toHaveBeenCalledWith('/home/user/project');
				expect(props.setGitDiffPreview).toHaveBeenCalledWith('mock diff content');
				expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
			});
		});

		it('handles View Git Diff with shell cwd when in terminal mode', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			const props = createDefaultProps({
				sessions: [createMockSession({ inputMode: 'terminal', shellCwd: '/different/path' })],
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View Git Diff'));

			await waitFor(() => {
				expect(gitService.getDiff).toHaveBeenCalledWith('/different/path');
			});
		});

		it('handles View Git Log action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View Git Log'));

			expect(props.setGitLogOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Open Repository in Browser action', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Open Repository in Browser'));

			await waitFor(() => {
				expect(gitService.getRemoteBrowserUrl).toHaveBeenCalledWith('/home/user/project');
				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://github.com/test/repo'
				);
				expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
			});
		});
	});

	describe('Agent sessions action', () => {
		it('handles View Agent Sessions action', () => {
			const props = createDefaultProps({
				hasActiveSessionCapability: (capability: string) => capability === 'supportsSessionStorage',
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View Agent Sessions for Test Session'));

			expect(props.setActiveAgentSessionId).toHaveBeenCalledWith(null);
			expect(props.setAgentSessionsOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});

	describe('DevTools action', () => {
		it('handles Toggle JavaScript Console action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Toggle JavaScript Console'));

			expect(window.maestro.devtools.toggle).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});

	describe('Search filtering', () => {
		it('filters actions by search term', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'settings' } });

			expect(screen.getByText('Settings')).toBeInTheDocument();
			expect(screen.queryByText('About Maestro')).not.toBeInTheDocument();
		});

		it('shows no actions found message when no matches', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'zzzznonexistent' } });

			expect(screen.getByText('No actions found')).toBeInTheDocument();
		});

		it('is case insensitive', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'SETTINGS' } });

			expect(screen.getByText('Settings')).toBeInTheDocument();
		});

		it('resets selected index when search changes', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');

			// Navigate down
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			// Change search
			fireEvent.change(input, { target: { value: 'settings' } });

			// Selected index should be reset to 0 - first button is selected
			const buttons = screen.getAllByRole('button');
			// First button should have accent background (selected)
			expect(buttons[0]).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});
	});

	describe('Debug commands', () => {
		it('hides debug commands by default', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText(/Debug:/)).not.toBeInTheDocument();
		});

		it('shows debug commands when searching for "debug"', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });

			expect(screen.getByText('Debug: Reset Busy State')).toBeInTheDocument();
			expect(screen.getByText('Debug: Log Session State')).toBeInTheDocument();
		});

		it('handles Debug: Reset Busy State action', () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });
			fireEvent.click(screen.getByText('Debug: Reset Busy State'));

			expect(props.setSessions).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith('[Debug] Reset busy state for all sessions');
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);

			consoleSpy.mockRestore();
		});

		it('handles Debug: Reset Current Session action', () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });
			fireEvent.click(screen.getByText('Debug: Reset Current Session'));

			expect(props.setSessions).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith('[Debug] Reset busy state for session:', 'session-1');

			consoleSpy.mockRestore();
		});

		it('handles Debug: Log Session State action', () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });
			fireEvent.click(screen.getByText('Debug: Log Session State'));

			expect(consoleSpy).toHaveBeenCalled();
			const logCall = consoleSpy.mock.calls.find((call) => call[0] === '[Debug] All sessions:');
			expect(logCall).toBeDefined();

			consoleSpy.mockRestore();
		});

		it('shows Debug: Playground when setPlaygroundOpen is provided', () => {
			const props = createDefaultProps({
				setPlaygroundOpen: vi.fn(),
			});
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });

			expect(screen.getByText('Debug: Playground')).toBeInTheDocument();
		});

		it('handles Debug: Playground action', () => {
			const setPlaygroundOpen = vi.fn();
			const props = createDefaultProps({ setPlaygroundOpen });
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });
			fireEvent.click(screen.getByText('Debug: Playground'));

			expect(setPlaygroundOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('shows Debug: Release Next Queued Item when queue has items', () => {
			const onDebugReleaseQueuedItem = vi.fn();
			const props = createDefaultProps({
				onDebugReleaseQueuedItem,
				sessions: [createMockSession({ executionQueue: [{ id: '1' }] as any })],
			});
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'debug' } });

			expect(screen.getByText('Debug: Release Next Queued Item')).toBeInTheDocument();
		});
	});

	describe('Keyboard navigation', () => {
		it('handles ArrowDown to move selection', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			const buttons = screen.getAllByRole('button');
			// Second button should now be selected (first is at index 0)
			expect(buttons[1]).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('handles ArrowUp to move selection', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');

			// Move down first
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			// Move up
			fireEvent.keyDown(input, { key: 'ArrowUp' });

			const buttons = screen.getAllByRole('button');
			expect(buttons[1]).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('does not go below zero index', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');

			// Try to go up from zero
			fireEvent.keyDown(input, { key: 'ArrowUp' });
			fireEvent.keyDown(input, { key: 'ArrowUp' });

			const buttons = screen.getAllByRole('button');
			expect(buttons[0]).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('handles Enter to execute selected action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			// Filter to single action
			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'about' } });

			fireEvent.keyDown(input, { key: 'Enter' });

			expect(props.setAboutModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Cmd+1 through Cmd+9 and Cmd+0 hotkeys', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');

			// Cmd+1 should trigger first visible action (which is 'About Maestro' after alphabetical sort)
			fireEvent.keyDown(input, { key: '1', metaKey: true });

			// First action is 'About Maestro' due to sorting
			expect(props.setAboutModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Cmd+0 for 10th item', () => {
			const props = createDefaultProps({
				sessions: Array(15)
					.fill(null)
					.map((_, i) => createMockSession({ id: `session-${i}`, name: `Session ${i}` })),
			});
			render(<QuickActionsModal {...props} />);

			// Filter to just sessions so we can reliably test Cmd+0
			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'Session' } });
			fireEvent.keyDown(input, { key: '0', metaKey: true });

			// Should trigger the 10th session (Session 9 due to alphabetical sorting)
			expect(props.setActiveSessionId).toHaveBeenCalled();
		});
	});

	describe('Move to group mode', () => {
		it('switches to move-to-group mode', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));

			expect(screen.getByText('← Back to main menu')).toBeInTheDocument();
			expect(screen.getByText('📁 No Group (Root)')).toBeInTheDocument();
		});

		it('shows groups in move-to-group mode', () => {
			const group = createMockGroup({ name: 'My Group', emoji: '🚀' });
			const props = createDefaultProps({ groups: [group] });
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));

			expect(screen.getByText('🚀 My Group')).toBeInTheDocument();
		});

		it('shows create new group option in move mode', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));

			expect(screen.getByText('+ Create New Group')).toBeInTheDocument();
		});

		it('handles back to main menu', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));
			fireEvent.click(screen.getByText('← Back to main menu'));

			expect(screen.getByText('Move to Group...')).toBeInTheDocument();
		});

		it('handles move to group action', () => {
			const group = createMockGroup();
			const props = createDefaultProps({ groups: [group] });
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));
			fireEvent.click(screen.getByText('📁 Test Group'));

			expect(props.setSessions).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles move to no group', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));
			fireEvent.click(screen.getByText('📁 No Group (Root)'));

			expect(props.setSessions).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('changes placeholder when in move-to-group mode', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Move to Group...'));

			expect(screen.getByPlaceholderText('Move Test Session to...')).toBeInTheDocument();
		});

		it('clears search when entering move-to-group mode', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			// Enter some text in main mode
			const input = screen.getByPlaceholderText('Type a command or jump to agent...');
			fireEvent.change(input, { target: { value: 'group' } });

			// Click move to group (should be visible with 'group' search)
			fireEvent.click(screen.getByText('Move to Group...'));

			// Search should be cleared when entering move-to-group mode
			const newInput = screen.getByPlaceholderText('Move Test Session to...');
			expect(newInput).toHaveValue('');
		});
	});

	describe('Group actions', () => {
		it('renders Rename Group action when session is in a group', () => {
			const session = createMockSession({ groupId: 'group-1' });
			const group = createMockGroup();
			const props = createDefaultProps({
				sessions: [session],
				groups: [group],
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Rename Group')).toBeInTheDocument();
		});

		it('does not render Rename Group when session has no group', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText('Rename Group')).not.toBeInTheDocument();
		});

		it('handles Rename Group action', () => {
			const session = createMockSession({ groupId: 'group-1' });
			const group = createMockGroup();
			const props = createDefaultProps({
				sessions: [session],
				groups: [group],
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Rename Group'));

			expect(props.setRenameGroupId).toHaveBeenCalledWith('group-1');
			expect(props.setRenameGroupValue).toHaveBeenCalledWith('Test Group');
			expect(props.setRenameGroupEmoji).toHaveBeenCalledWith('📁');
			expect(props.setRenameGroupModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('handles Create New Group action', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Create New Group'));

			expect(props.setCreateGroupModalOpen).toHaveBeenCalledWith(true);
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});

	describe('Initial mode', () => {
		it('starts in main mode by default', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			expect(screen.getByPlaceholderText('Type a command or jump to agent...')).toBeInTheDocument();
		});

		it('starts in move-to-group mode when initialMode is set', () => {
			const props = createDefaultProps({ initialMode: 'move-to-group' });
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('← Back to main menu')).toBeInTheDocument();
		});
	});

	describe('Tab-related actions (AI mode)', () => {
		it('shows Tab Switcher when in AI mode with handler', () => {
			const onOpenTabSwitcher = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onOpenTabSwitcher,
				tabShortcuts: { tabSwitcher: { id: 'tabSwitcher', keys: ['Cmd', 'K'], enabled: true } },
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Tab Switcher')).toBeInTheDocument();
		});

		it('handles Tab Switcher action', () => {
			const onOpenTabSwitcher = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onOpenTabSwitcher,
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Tab Switcher'));

			expect(onOpenTabSwitcher).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('shows Rename Tab when in AI mode with handler', () => {
			const onRenameTab = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onRenameTab,
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Rename Tab')).toBeInTheDocument();
		});

		it('handles Rename Tab action', () => {
			const onRenameTab = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onRenameTab,
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Rename Tab'));

			expect(onRenameTab).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('shows Toggle Read-Only Mode when in AI mode with handler', () => {
			const onToggleReadOnlyMode = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onToggleReadOnlyMode,
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Toggle Read-Only Mode')).toBeInTheDocument();
		});

		it('handles Toggle Read-Only Mode action', () => {
			const onToggleReadOnlyMode = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onToggleReadOnlyMode,
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Toggle Read-Only Mode'));

			expect(onToggleReadOnlyMode).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('does not show tab actions when not in AI mode', () => {
			const props = createDefaultProps({
				isAiMode: false,
				onOpenTabSwitcher: vi.fn(),
				onRenameTab: vi.fn(),
				onToggleReadOnlyMode: vi.fn(),
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText('Tab Switcher')).not.toBeInTheDocument();
			expect(screen.queryByText('Rename Tab')).not.toBeInTheDocument();
			expect(screen.queryByText('Toggle Read-Only Mode')).not.toBeInTheDocument();
		});
	});

	describe('Markdown toggle (AI mode)', () => {
		it('shows edit mode subtext when in edit mode', () => {
			const onToggleMarkdownEditMode = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				markdownEditMode: true,
				onToggleMarkdownEditMode,
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Toggle Edit/Preview')).toBeInTheDocument();
			expect(screen.getByText('Currently in edit mode')).toBeInTheDocument();
		});

		it('shows preview mode subtext when in preview mode', () => {
			const onToggleMarkdownEditMode = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				markdownEditMode: false,
				onToggleMarkdownEditMode,
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Toggle Edit/Preview')).toBeInTheDocument();
			expect(screen.getByText('Currently in preview mode')).toBeInTheDocument();
		});

		it('handles markdown toggle action', () => {
			const onToggleMarkdownEditMode = vi.fn();
			const props = createDefaultProps({
				isAiMode: true,
				onToggleMarkdownEditMode,
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Toggle Edit/Preview'));

			expect(onToggleMarkdownEditMode).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});

	describe('Refresh git file state', () => {
		it('shows Refresh Files action when handler is provided', () => {
			const onRefreshGitFileState = vi.fn();
			const props = createDefaultProps({ onRefreshGitFileState });
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Refresh Files, Git, History')).toBeInTheDocument();
			expect(screen.getByText('Reload file tree, git status, and history')).toBeInTheDocument();
		});

		it('handles Refresh Files action', async () => {
			const onRefreshGitFileState = vi.fn().mockResolvedValue(undefined);
			const props = createDefaultProps({ onRefreshGitFileState });
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Refresh Files, Git, History'));

			await waitFor(() => {
				expect(onRefreshGitFileState).toHaveBeenCalled();
				expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
			});
		});
	});

	describe('Number badges', () => {
		it('displays number badges 1-9 and 0 for visible items', () => {
			const props = createDefaultProps({
				sessions: Array(15)
					.fill(null)
					.map((_, i) => createMockSession({ id: `session-${i}`, name: `Session ${i}` })),
			});
			render(<QuickActionsModal {...props} />);

			// Should show numbers 1-9 and 0
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('9')).toBeInTheDocument();
			expect(screen.getByText('0')).toBeInTheDocument();
		});
	});

	describe('Scroll behavior', () => {
		it('scrolls selected item into view', async () => {
			const scrollIntoViewMock = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoViewMock;

			const props = createDefaultProps({
				sessions: Array(20)
					.fill(null)
					.map((_, i) => createMockSession({ id: `session-${i}`, name: `Session ${i}` })),
			});
			render(<QuickActionsModal {...props} />);

			const input = screen.getByPlaceholderText('Type a command or jump to agent...');

			// Navigate down multiple times
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(scrollIntoViewMock).toHaveBeenCalled();
			});
		});
	});

	describe('Multiple sessions', () => {
		it('renders all session jump actions', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Session One' }),
				createMockSession({ id: 'session-2', name: 'Session Two' }),
				createMockSession({ id: 'session-3', name: 'Session Three' }),
			];
			const props = createDefaultProps({ sessions });
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Jump to: Session One')).toBeInTheDocument();
			expect(screen.getByText('Jump to: Session Two')).toBeInTheDocument();
			expect(screen.getByText('Jump to: Session Three')).toBeInTheDocument();
		});
	});

	describe('Styling', () => {
		it('applies theme colors to selected item', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const buttons = screen.getAllByRole('button');
			expect(buttons[0]).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('applies different background to non-selected items', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const buttons = screen.getAllByRole('button');
			// Non-selected items should not have accent background
			expect(buttons[1]).not.toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('applies theme colors to modal container', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
		});
	});

	describe('Edge cases', () => {
		it('handles empty sessions array', () => {
			const props = createDefaultProps({ sessions: [], activeSessionId: '' });
			render(<QuickActionsModal {...props} />);

			// Should still show non-session-dependent actions
			expect(screen.getByText('Create New Agent')).toBeInTheDocument();
			expect(screen.getByText('Settings')).toBeInTheDocument();
		});

		it('handles special characters in session name', () => {
			const props = createDefaultProps({
				sessions: [createMockSession({ name: '<script>alert("xss")</script>' })],
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Jump to: <script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles unicode in session name', () => {
			const props = createDefaultProps({
				sessions: [createMockSession({ name: '🚀 Unicode 日本語' })],
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Jump to: 🚀 Unicode 日本語')).toBeInTheDocument();
		});

		it('handles git diff with no diff content', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			vi.mocked(gitService.getDiff).mockResolvedValueOnce({ diff: '' });

			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('View Git Diff'));

			await waitFor(() => {
				expect(props.setGitDiffPreview).not.toHaveBeenCalled();
				expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
			});
		});

		it('handles git remote URL returning null', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			vi.mocked(gitService.getRemoteBrowserUrl).mockResolvedValueOnce(null);

			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Open Repository in Browser'));

			await waitFor(() => {
				expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();
				expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
			});
		});

		it('sorts actions alphabetically', () => {
			const props = createDefaultProps();
			render(<QuickActionsModal {...props} />);

			const buttons = screen.getAllByRole('button');
			// Extract just the action label text (remove number badges and shortcut hints)
			const labels = buttons
				.map((b) => {
					const text = b.textContent || '';
					// Remove leading number badge (single digit)
					const withoutNumber = text.replace(/^[0-9]/, '');
					// Get just the main label (first part before subtext or shortcuts)
					return withoutNumber.split(/Cmd\+|Currently/)[0].trim();
				})
				.filter(Boolean);

			// All labels should be sorted (allowing for the number badge offset which affects visual order)
			// The component sorts actions by localeCompare before rendering
			// We verify that consecutive items in the sorted list are still in order
			for (let i = 1; i < labels.length; i++) {
				const prev = labels[i - 1]!;
				const curr = labels[i]!;
				expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
			}
		});
	});

	describe('Send to agent action', () => {
		it('shows Context: Send to Agent action when capability is supported and callback provided', () => {
			const onOpenSendToAgent = vi.fn();
			const props = createDefaultProps({
				hasActiveSessionCapability: (capability: string) => capability === 'supportsContextMerge',
				onOpenSendToAgent,
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.getByText('Context: Send to Agent')).toBeInTheDocument();
		});

		it('handles Context: Send to Agent action', () => {
			const onOpenSendToAgent = vi.fn();
			const props = createDefaultProps({
				hasActiveSessionCapability: (capability: string) => capability === 'supportsContextMerge',
				onOpenSendToAgent,
			});
			render(<QuickActionsModal {...props} />);

			fireEvent.click(screen.getByText('Context: Send to Agent'));

			expect(onOpenSendToAgent).toHaveBeenCalled();
			expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('does not show Context: Send to Agent when capability is not supported', () => {
			const onOpenSendToAgent = vi.fn();
			const props = createDefaultProps({
				hasActiveSessionCapability: () => false,
				onOpenSendToAgent,
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText('Context: Send to Agent')).not.toBeInTheDocument();
		});

		it('does not show Context: Send to Agent when callback is not provided', () => {
			const props = createDefaultProps({
				hasActiveSessionCapability: (capability: string) => capability === 'supportsContextMerge',
				// onOpenSendToAgent not provided
			});
			render(<QuickActionsModal {...props} />);

			expect(screen.queryByText('Context: Send to Agent')).not.toBeInTheDocument();
		});
	});
});
