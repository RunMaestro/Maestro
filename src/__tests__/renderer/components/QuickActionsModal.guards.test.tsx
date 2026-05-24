import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuickActionsModal } from '../../../renderer/components/QuickActionsModal';
import type { Group, Session, Shortcut, Theme } from '../../../renderer/types';

const layerStackMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'quick-actions-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
	latestOptions: undefined as
		| {
				onSelect: (index: number) => void;
		  }
		| undefined,
	setSelectedIndex: vi.fn(),
	handleKeyDown: vi.fn(),
	resetSelection: vi.fn(),
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => layerStackMocks,
}));

vi.mock('../../../renderer/hooks', () => ({
	useListNavigation: vi.fn((options) => {
		navigationMocks.latestOptions = options;

		return {
			selectedIndex: 0,
			setSelectedIndex: navigationMocks.setSelectedIndex,
			handleKeyDown: navigationMocks.handleKeyDown,
			resetSelection: navigationMocks.resetSelection,
		};
	}),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getDiff: vi.fn(),
		getRemoteBrowserUrl: vi.fn(),
	},
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
	isMacOS: vi.fn(() => false),
}));

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(),
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		QUICK_ACTION: 100,
	},
}));

vi.mock('lucide-react', () => ({
	Search: () => <svg data-testid="search-icon" />,
}));

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

const mockShortcuts: Record<string, Shortcut> = {
	newInstance: { id: 'newInstance', keys: ['Cmd', 'N'], enabled: true },
};

const createDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof QuickActionsModal>> = {}
): React.ComponentProps<typeof QuickActionsModal> => ({
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
	setUsageDashboardOpen: vi.fn(),
	setAgentSessionsOpen: vi.fn(),
	setActiveAgentSessionId: vi.fn(),
	setGitDiffPreview: vi.fn(),
	setGitLogOpen: vi.fn(),
	...overrides,
});

describe('QuickActionsModal guard behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		navigationMocks.latestOptions = undefined;
	});

	it('uses the initial escape fallback before the mode effect installs its handler', () => {
		const props = createDefaultProps();
		layerStackMocks.registerLayer.mockImplementationOnce(({ onEscape }) => {
			onEscape();
			return 'quick-actions-layer';
		});

		render(<QuickActionsModal {...props} />);

		expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('ignores stale selection indexes from the navigation hook', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		expect(navigationMocks.latestOptions).toBeDefined();
		act(() => navigationMocks.latestOptions?.onSelect(999));

		expect(props.setActiveSessionId).not.toHaveBeenCalled();
		expect(props.setQuickActionOpen).not.toHaveBeenCalled();
	});

	it('keeps the modal open when keyboard selection enters move-to-group mode', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		fireEvent.change(screen.getByPlaceholderText('Type a command or jump to agent...'), {
			target: { value: 'Move to Group' },
		});
		act(() => navigationMocks.latestOptions?.onSelect(0));

		expect(screen.getByPlaceholderText('Move Test Session to...')).toBeInTheDocument();
		expect(props.setQuickActionOpen).not.toHaveBeenCalled();
	});

	it('uses a generic move-to-group placeholder when the active session is unavailable', () => {
		const props = createDefaultProps({
			initialMode: 'move-to-group',
			activeSessionId: 'missing-session',
			sessions: [],
			groups: [] as Group[],
		});

		render(<QuickActionsModal {...props} />);

		expect(screen.getByPlaceholderText('Move session to...')).toBeInTheDocument();
	});
});
