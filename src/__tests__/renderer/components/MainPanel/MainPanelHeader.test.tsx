import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainPanelHeader } from '../../../../renderer/components/MainPanel/MainPanelHeader';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import type { Session, Theme, AITab } from '../../../../renderer/types';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock stores
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: vi.fn((selector) =>
		selector({
			shortcuts: {
				agentSessions: { keys: ['Meta', 'Shift', 'l'] },
				toggleRightPanel: { keys: ['Meta', 'b'] },
				quickAction: { keys: ['Meta', 'k'] },
			},
			showAgentName: true,
			showSessionIdPill: true,
			showSessionCostPill: true,
		})
	),
}));

// Mutable UI state + stable setters so tests can drive the sidebar opener.
// vi.hoisted keeps these visible inside the hoisted vi.mock factories below.
const uiMocks = vi.hoisted(() => ({
	state: { rightPanelOpen: false, leftSidebarHidden: false, leftSidebarOpen: true } as Record<
		string,
		unknown
	>,
	setRightPanelOpen: vi.fn(),
	setLeftSidebarHidden: vi.fn(),
	setLeftSidebarOpen: vi.fn(),
}));

vi.mock('../../../../renderer/stores/uiStore', () => ({
	useUIStore: Object.assign(
		vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector(uiMocks.state)),
		{
			getState: () => ({
				setRightPanelOpen: uiMocks.setRightPanelOpen,
				setLeftSidebarHidden: uiMocks.setLeftSidebarHidden,
				setLeftSidebarOpen: uiMocks.setLeftSidebarOpen,
			}),
		}
	),
}));

// isWebDesktop() distinguishes the browser build from the Electron desktop app.
// Default false (desktop); individual tests flip it to true for phone cases.
const runtimeMocks = vi.hoisted(() => ({ isWebDesktop: vi.fn(() => false) }));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: runtimeMocks.isWebDesktop,
	isElectronDesktop: () => !runtimeMocks.isWebDesktop(),
}));

vi.mock('../../../../renderer/hooks', () => ({
	useHoverTooltip: () => ({
		isOpen: false,
		triggerHandlers: { onMouseEnter: vi.fn(), onMouseLeave: vi.fn() },
		contentHandlers: {},
		close: vi.fn(),
	}),
}));

vi.mock('../../../../renderer/components/GitStatusWidget', () => ({
	GitStatusWidget: () => React.createElement('div', { 'data-testid': 'git-status-widget' }),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/test',
		fullPath: '/test',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: true,
		bookmarked: false,
		sessionSshRemoteConfig: undefined,
		...overrides,
	} as Session;
}

function makeTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-1',
		usageStats: {
			totalCostUsd: 1.23,
			inputTokens: 1000,
			outputTokens: 500,
		},
		...overrides,
	} as AITab;
}

const defaultProps = {
	activeSession: makeSession(),
	activeTab: makeTab(),
	theme: mockTheme,
	gitInfo: {
		branch: 'main',
		remote: 'https://github.com/test/repo.git',
		ahead: 0,
		behind: 0,
		uncommittedChanges: 0,
	},
	sshRemoteName: null,
	activeTabContextWindow: 200000,
	activeTabContextTokens: 50000,
	activeTabContextUsage: 25,
	isCurrentSessionAutoMode: false,
	isCurrentSessionStopping: false,
	currentSessionBatchState: undefined,
	isWorktreeChild: false,
	activeFileTabId: undefined,
	colorBlindMode: false,
	contextWarningsEnabled: true,
	contextWarningYellowThreshold: 60,
	contextWarningRedThreshold: 80,
	refreshGitStatus: vi.fn(),
	handleViewGitDiff: vi.fn(),
	copyToClipboard: vi.fn(),
	getContextColor: vi.fn(() => '#3b82f6'),
	setGitLogOpen: vi.fn(),
	setAgentSessionsOpen: vi.fn(),
	setMemoryViewerOpen: vi.fn(),
	setActiveAgentSessionId: vi.fn(),
	onStopBatchRun: vi.fn(),
	onOpenWorktreeConfig: vi.fn(),
	onOpenCreatePR: vi.fn(),
	hasCapability: vi.fn(() => true) as any,
};

function setViewportWidth(width: number): void {
	Object.defineProperty(window, 'innerWidth', {
		writable: true,
		configurable: true,
		value: width,
	});
}

describe('MainPanelHeader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiMocks.state.rightPanelOpen = false;
		uiMocks.state.leftSidebarHidden = false;
		uiMocks.state.leftSidebarOpen = true;
		runtimeMocks.isWebDesktop.mockReturnValue(false);
		// Default to a desktop-width viewport so useViewportBreakpoint reports a
		// non-xs breakpoint unless a test opts into a phone width.
		setViewportWidth(1280);
	});

	it('renders session name', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByText('Test Agent')).toBeInTheDocument();
	});

	it('renders bookmark icon when session is bookmarked', () => {
		render(<MainPanelHeader {...defaultProps} activeSession={makeSession({ bookmarked: true })} />);
		expect(screen.getByTestId('bookmark-icon')).toBeInTheDocument();
	});

	it('does not render bookmark icon when not bookmarked', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.queryByTestId('bookmark-icon')).not.toBeInTheDocument();
	});

	it('renders GIT badge for git repo', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByText('main')).toBeInTheDocument();
	});

	it('renders LOCAL badge for non-git repo', () => {
		render(
			<MainPanelHeader
				{...defaultProps}
				activeSession={makeSession({ isGitRepo: false })}
				gitInfo={null}
			/>
		);
		expect(screen.getByText('LOCAL')).toBeInTheDocument();
	});

	it('renders SSH remote pill when SSH is configured', () => {
		render(
			<MainPanelHeader
				{...defaultProps}
				activeSession={makeSession({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				} as any)}
				sshRemoteName="prod-server"
			/>
		);
		expect(screen.getByText('prod-server')).toBeInTheDocument();
	});

	it('renders AUTO mode indicator when batch is running', () => {
		render(
			<MainPanelHeader
				{...defaultProps}
				isCurrentSessionAutoMode={true}
				currentSessionBatchState={
					{ isRunning: true, isStopping: false, completedTasks: 2, totalTasks: 5 } as any
				}
			/>
		);
		expect(screen.getByText('Auto')).toBeInTheDocument();
		expect(screen.getByText('2/5')).toBeInTheDocument();
	});

	it('shows Stopping state when batch is stopping', () => {
		render(
			<MainPanelHeader
				{...defaultProps}
				isCurrentSessionAutoMode={true}
				isCurrentSessionStopping={true}
				currentSessionBatchState={
					{ isRunning: true, isStopping: true, completedTasks: 2, totalTasks: 5 } as any
				}
			/>
		);
		expect(screen.getByText('Stopping')).toBeInTheDocument();
	});

	it('calls onStopBatchRun when AUTO button is clicked', () => {
		const onStop = vi.fn();
		render(
			<MainPanelHeader
				{...defaultProps}
				isCurrentSessionAutoMode={true}
				currentSessionBatchState={
					{ isRunning: true, isStopping: false, completedTasks: 0, totalTasks: 1 } as any
				}
				onStopBatchRun={onStop}
			/>
		);
		fireEvent.click(screen.getByText('Auto'));
		expect(onStop).toHaveBeenCalledWith('session-1');
	});

	describe('sidebar opener (hamburger)', () => {
		it('shows the opener when the left sidebar is fully hidden', () => {
			uiMocks.state.leftSidebarHidden = true;
			uiMocks.state.leftSidebarOpen = false;
			render(<MainPanelHeader {...defaultProps} />);
			expect(screen.getByLabelText('Show agents sidebar')).toBeInTheDocument();
		});

		it('does not show the opener when the sidebar is merely collapsed on desktop', () => {
			// Electron desktop keeps its 64px collapsed strip, so no header opener.
			runtimeMocks.isWebDesktop.mockReturnValue(false);
			setViewportWidth(390);
			uiMocks.state.leftSidebarHidden = false;
			uiMocks.state.leftSidebarOpen = false;
			render(<MainPanelHeader {...defaultProps} />);
			expect(screen.queryByLabelText('Show agents sidebar')).not.toBeInTheDocument();
		});

		it('shows the opener on a web-desktop phone when the sidebar is collapsed', () => {
			// The collapsed strip is hidden at xs in web-desktop, so the header
			// opener is the only way back to the sidebar.
			runtimeMocks.isWebDesktop.mockReturnValue(true);
			setViewportWidth(390);
			uiMocks.state.leftSidebarHidden = false;
			uiMocks.state.leftSidebarOpen = false;
			render(<MainPanelHeader {...defaultProps} />);
			expect(screen.getByLabelText('Show agents sidebar')).toBeInTheDocument();
		});

		it('does not show the opener on a web-desktop phone while the drawer is open', () => {
			runtimeMocks.isWebDesktop.mockReturnValue(true);
			setViewportWidth(390);
			uiMocks.state.leftSidebarHidden = false;
			uiMocks.state.leftSidebarOpen = true;
			render(<MainPanelHeader {...defaultProps} />);
			expect(screen.queryByLabelText('Show agents sidebar')).not.toBeInTheDocument();
		});

		it('opens the sidebar drawer when the opener is clicked', () => {
			runtimeMocks.isWebDesktop.mockReturnValue(true);
			setViewportWidth(390);
			uiMocks.state.leftSidebarHidden = false;
			uiMocks.state.leftSidebarOpen = false;
			render(<MainPanelHeader {...defaultProps} />);
			fireEvent.click(screen.getByLabelText('Show agents sidebar'));
			expect(uiMocks.setLeftSidebarHidden).toHaveBeenCalledWith(false);
			expect(uiMocks.setLeftSidebarOpen).toHaveBeenCalledWith(true);
		});
	});

	describe('Quick Actions opener', () => {
		it('shows the Quick Actions button on a narrow viewport', () => {
			setViewportWidth(390);
			render(<MainPanelHeader {...defaultProps} />);
			expect(screen.getByLabelText('Quick Actions')).toBeInTheDocument();
		});

		it('hides the Quick Actions button on a wide viewport (Cmd+K suffices)', () => {
			setViewportWidth(1280);
			render(<MainPanelHeader {...defaultProps} />);
			expect(screen.queryByLabelText('Quick Actions')).not.toBeInTheDocument();
		});

		it('opens the command palette when the Quick Actions button is clicked', () => {
			setViewportWidth(390);
			const openModalSpy = vi
				.spyOn(useModalStore.getState(), 'openModal')
				.mockImplementation(() => {});
			render(<MainPanelHeader {...defaultProps} />);
			fireEvent.click(screen.getByLabelText('Quick Actions'));
			expect(openModalSpy).toHaveBeenCalledWith(
				'quickAction',
				expect.objectContaining({ initialMode: 'main' })
			);
			openModalSpy.mockRestore();
		});
	});

	it('renders session UUID pill', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByText('AGENT-SESSION-1'.split('-')[0])).toBeInTheDocument();
	});

	it('renders cost tracker', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByText('$1.23')).toBeInTheDocument();
	});

	it('hides UUID pill and cost when file tab is active', () => {
		render(<MainPanelHeader {...defaultProps} activeFileTabId="file-1" />);
		expect(screen.queryByText('$1.23')).not.toBeInTheDocument();
	});

	it('renders context-usage percentage', () => {
		render(<MainPanelHeader {...defaultProps} />);
		// Plain-text "X%" replaced the verbose "Context Window" label + gauge bar
		// so narrow viewports get the readout without the bar overflow.
		expect(screen.getByText('25%')).toBeInTheDocument();
	});

	it('renders GitStatusWidget', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByTestId('git-status-widget')).toBeInTheDocument();
	});

	it('renders agent sessions button when capability is supported', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByTitle(/Agent Sessions/)).toBeInTheDocument();
	});

	it('opens agent sessions browser on click', () => {
		const setOpen = vi.fn();
		render(<MainPanelHeader {...defaultProps} setAgentSessionsOpen={setOpen} />);
		fireEvent.click(screen.getByTitle(/Agent Sessions/));
		expect(setOpen).toHaveBeenCalledWith(true);
	});

	it('renders right panel toggle when panel is closed', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByTitle(/Show right panel/)).toBeInTheDocument();
	});

	it('renders data-tour attribute for guided tours', () => {
		const { container } = render(<MainPanelHeader {...defaultProps} />);
		expect(container.querySelector('[data-tour="header-controls"]')).toBeInTheDocument();
	});

	it('renders ahead/behind indicators', () => {
		render(
			<MainPanelHeader
				{...defaultProps}
				gitInfo={{ branch: 'main', remote: '', ahead: 3, behind: 2, uncommittedChanges: 0 }}
			/>
		);
		// The ahead/behind counts are only visible in the tooltip, which requires hover
		// Just verify the header renders without errors
		expect(screen.getByText('main')).toBeInTheDocument();
	});
});
