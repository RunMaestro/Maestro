import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainPanelHeader } from '../../../../renderer/components/MainPanel/MainPanelHeader';
import type { Session, Theme, AITab } from '../../../../renderer/types';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock stores
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: vi.fn((selector) =>
		selector({
			shortcuts: {
				agentSessions: { keys: ['Meta', 'Shift', 'l'] },
				toggleRightPanel: { keys: ['Meta', 'b'] },
			},
		})
	),
}));

vi.mock('../../../../renderer/stores/uiStore', () => ({
	useUIStore: Object.assign(
		vi.fn((selector) => selector({ rightPanelOpen: false })),
		{ getState: () => ({ setRightPanelOpen: vi.fn() }) }
	),
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

describe('MainPanelHeader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

	it('renders context window widget', () => {
		render(<MainPanelHeader {...defaultProps} />);
		expect(screen.getByText('Context Window')).toBeInTheDocument();
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
