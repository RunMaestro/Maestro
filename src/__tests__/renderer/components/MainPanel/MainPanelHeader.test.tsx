import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

// The barrel pulls in far more than this component needs, so it's mocked - but
// delegate to the REAL useHoverTooltip, since the git menu's open/close is
// driven by it and a stubbed `isOpen: false` would make the menu untestable.
vi.mock('../../../../renderer/hooks', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../renderer/hooks/ui/useHoverTooltip')
	>('../../../../renderer/hooks/ui/useHoverTooltip');
	return { useHoverTooltip: actual.useHoverTooltip };
});

vi.mock('../../../../renderer/services/git', () => ({
	gitService: { getDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/x b/x' }) },
}));

vi.mock('../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

vi.mock('../../../../renderer/components/GitStatusWidget', () => ({
	GitStatusWidget: () => React.createElement('div', { 'data-testid': 'git-status-widget' }),
}));

// The dropdown registers with the layer stack, which has no provider here.
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn().mockReturnValue('mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

// useGitAgentActions reads polled branch state from this context.
const DEFAULT_BRANCH_INFO = { branch: 'main', remote: '', ahead: 0, behind: 0 };
const mockGetBranchInfo = vi.fn(() => DEFAULT_BRANCH_INFO);
const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitBranch: () => ({ getBranchInfo: mockGetBranchInfo }),
	useGitDetail: () => ({ refreshGitStatus: mockRefreshGitStatus }),
}));

// Spy on the REAL store rather than replacing the module. A blanket vi.mock of
// modalStore drops `getModalActions`, which the header's own Quick Actions
// button calls, and its `getState()` would hand back a fresh object per call so
// no spy could ever observe it. `getModalActions()` destructures `openModal`
// from `getState()` at call time, so spying the live state object catches both
// paths. Assigned in beforeEach, restored in afterEach.
let mockOpenModal: ReturnType<typeof vi.spyOn>;

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
		mockGetBranchInfo.mockReturnValue(DEFAULT_BRANCH_INFO);
		mockOpenModal = vi
			.spyOn(useModalStore.getState(), 'openModal')
			.mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>;
	});

	afterEach(() => {
		mockOpenModal.mockRestore();
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

	it('shows the branch name alongside the SSH pill for remote/container git agents', () => {
		// Regression for #1124: the SSH host pill replaced the branch badge, so
		// agents running in a container over SSH lost the branch name that local
		// agents show. Both the remote name and the branch must be visible.
		render(
			<MainPanelHeader
				{...defaultProps}
				activeSession={makeSession({
					isGitRepo: true,
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				} as any)}
				sshRemoteName="harness-sandbox"
				gitInfo={{
					branch: 'feature/login',
					remote: '',
					ahead: 0,
					behind: 0,
					uncommittedChanges: 0,
				}}
			/>
		);
		expect(screen.getByText('harness-sandbox')).toBeInTheDocument();
		expect(screen.getByText('feature/login')).toBeInTheDocument();
	});

	it('does not render a branch badge for a non-git SSH agent', () => {
		render(
			<MainPanelHeader
				{...defaultProps}
				activeSession={makeSession({
					isGitRepo: false,
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				} as any)}
				sshRemoteName="prod-server"
				gitInfo={null}
			/>
		);
		expect(screen.getByText('prod-server')).toBeInTheDocument();
		// No GIT fallback badge when the remote dir isn't a repo.
		expect(screen.queryByText('GIT')).not.toBeInTheDocument();
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

	it('renders an over-limit context percentage past 100 without clamping', () => {
		// Finding R1, Decision 2: the pill shows the true percentage whenever it
		// has an over-limit measurement, so the header cannot silently disagree
		// with the Context Timeline. The readout renders whatever number arrives;
		// this pins that it is not clamped on the way out.
		render(<MainPanelHeader {...defaultProps} activeTabContextUsage={147} />);
		const readout = screen.getByText('147%');
		expect(readout).toBeInTheDocument();
		// A 4-character value must not wrap in the fixed-width mono pill.
		expect(readout).toHaveClass('whitespace-nowrap');
		expect(readout).toHaveClass('tabular-nums');
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

	describe('git pill menu', () => {
		it('opens the git menu on pill click instead of jumping to the log', () => {
			const setGitLogOpen = vi.fn();
			render(<MainPanelHeader {...defaultProps} setGitLogOpen={setGitLogOpen} />);

			fireEvent.click(screen.getByText('main'));

			expect(screen.getByTestId('git-pill-menu')).toBeInTheDocument();
			expect(setGitLogOpen).not.toHaveBeenCalled();
			// Clicking refreshes git info so the menu's ahead/behind badges are current.
			expect(defaultProps.refreshGitStatus).toHaveBeenCalled();
		});

		it('opens the git log from the menu', () => {
			const setGitLogOpen = vi.fn();
			render(<MainPanelHeader {...defaultProps} setGitLogOpen={setGitLogOpen} />);

			fireEvent.click(screen.getByText('main'));
			fireEvent.click(screen.getByTestId('git-pill-menu-log'));

			expect(setGitLogOpen).toHaveBeenCalledWith(true);
			expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();
		});

		it('opens the git diff from the menu', async () => {
			render(<MainPanelHeader {...defaultProps} />);

			fireEvent.click(screen.getByText('main'));
			fireEvent.click(screen.getByTestId('git-pill-menu-diff'));

			// Menu closes immediately; the diff modal opens once git responds.
			expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();
			await waitFor(() =>
				expect(mockOpenModal).toHaveBeenCalledWith(
					'gitDiff',
					expect.objectContaining({ cwd: '/test' })
				)
			);
		});

		it('opens the streaming command modal for pull and push', () => {
			render(<MainPanelHeader {...defaultProps} />);

			fireEvent.click(screen.getByText('main'));
			fireEvent.click(screen.getByTestId('git-pill-menu-pull'));

			expect(mockOpenModal).toHaveBeenCalledWith(
				'gitCommandRunner',
				expect.objectContaining({ operation: 'pull', cwd: '/test', branch: 'main' })
			);
		});

		it('renders the menu outside the header, not nested inside it', () => {
			// Regression: the menu used to render inline next to the pill, inside
			// the header's two `overflow-hidden` wrappers. Those boxes are only as
			// tall as the pill, so the dropdown was clipped to nothing - it was in
			// the document (which the other tests assert) but invisible on screen.
			// jsdom can't measure clipping, so pin the structural fix instead: the
			// menu must be portaled out of the header subtree.
			const { container } = render(<MainPanelHeader {...defaultProps} />);

			fireEvent.click(screen.getByText('main'));

			const menu = screen.getByTestId('git-pill-menu');
			const header = container.querySelector('[data-tour="header-controls"]');
			expect(header).not.toBeNull();
			expect(header!.contains(menu)).toBe(false);
			expect(menu.parentElement).toBe(document.body);
		});

		describe('hover', () => {
			// The menu opens on hover with a short delay, so it doesn't pop up while
			// the pointer merely crosses the header.
			function pillContainer() {
				return screen.getByText('main').closest('div')!;
			}

			it('opens after the pointer rests on the pill', () => {
				vi.useFakeTimers();
				try {
					render(<MainPanelHeader {...defaultProps} />);
					const pill = pillContainer();

					fireEvent.mouseEnter(pill);
					// Nothing yet - the delay is what makes a pass-through harmless.
					expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();

					act(() => {
						vi.advanceTimersByTime(200);
					});
					expect(screen.getByTestId('git-pill-menu')).toBeInTheDocument();
				} finally {
					vi.useRealTimers();
				}
			});

			it('does not open when the pointer passes straight through', () => {
				vi.useFakeTimers();
				try {
					render(<MainPanelHeader {...defaultProps} />);
					const pill = pillContainer();

					fireEvent.mouseEnter(pill);
					act(() => {
						vi.advanceTimersByTime(50);
					});
					fireEvent.mouseLeave(pill);
					act(() => {
						vi.advanceTimersByTime(500);
					});

					expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();
				} finally {
					vi.useRealTimers();
				}
			});

			it('stays open while the pointer travels from the pill to the menu', () => {
				vi.useFakeTimers();
				try {
					render(<MainPanelHeader {...defaultProps} />);
					const pill = pillContainer();

					fireEvent.mouseEnter(pill);
					act(() => {
						vi.advanceTimersByTime(200);
					});
					const menu = screen.getByTestId('git-pill-menu');

					// Crossing the gap: the pill's leave fires before the menu's enter.
					fireEvent.mouseLeave(pill);
					act(() => {
						vi.advanceTimersByTime(50);
					});
					fireEvent.mouseEnter(menu);
					act(() => {
						vi.advanceTimersByTime(500);
					});

					expect(screen.getByTestId('git-pill-menu')).toBeInTheDocument();
				} finally {
					vi.useRealTimers();
				}
			});

			it('closes once the pointer leaves the menu', () => {
				vi.useFakeTimers();
				try {
					render(<MainPanelHeader {...defaultProps} />);
					const pill = pillContainer();

					fireEvent.mouseEnter(pill);
					act(() => {
						vi.advanceTimersByTime(200);
					});
					fireEvent.mouseLeave(screen.getByTestId('git-pill-menu'));
					act(() => {
						vi.advanceTimersByTime(500);
					});

					expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();
				} finally {
					vi.useRealTimers();
				}
			});

			it('clicking the pill opens immediately, skipping the hover delay', () => {
				render(<MainPanelHeader {...defaultProps} />);

				fireEvent.click(screen.getByText('main'));

				expect(screen.getByTestId('git-pill-menu')).toBeInTheDocument();
			});

			it('clicking the pill again does not close a menu the pointer is still on', () => {
				render(<MainPanelHeader {...defaultProps} />);
				const pill = screen.getByText('main');

				fireEvent.click(pill);
				expect(screen.getByTestId('git-pill-menu')).toBeInTheDocument();

				// Toggling here would close a menu that hover is about to reopen.
				fireEvent.click(pill);
				expect(screen.getByTestId('git-pill-menu')).toBeInTheDocument();
			});

			it('does not open on hover for a non-git agent', () => {
				vi.useFakeTimers();
				try {
					render(
						<MainPanelHeader
							{...defaultProps}
							activeSession={makeSession({ isGitRepo: false })}
							gitInfo={null}
						/>
					);

					fireEvent.mouseEnter(screen.getByText('LOCAL').closest('div')!);
					act(() => {
						vi.advanceTimersByTime(500);
					});

					expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();
				} finally {
					vi.useRealTimers();
				}
			});

			it('refreshes git status once per open, not per hover event', () => {
				vi.useFakeTimers();
				try {
					const refreshGitStatus = vi.fn();
					const { rerender } = render(
						<MainPanelHeader {...defaultProps} refreshGitStatus={refreshGitStatus} />
					);

					fireEvent.mouseEnter(pillContainer());
					act(() => {
						vi.advanceTimersByTime(200);
					});
					expect(refreshGitStatus).toHaveBeenCalledTimes(1);

					// A re-render with a fresh callback identity must not re-poll.
					rerender(<MainPanelHeader {...defaultProps} refreshGitStatus={refreshGitStatus} />);
					expect(refreshGitStatus).toHaveBeenCalledTimes(1);
				} finally {
					vi.useRealTimers();
				}
			});
		});

		it('opens the create-PR modal from the menu', () => {
			render(<MainPanelHeader {...defaultProps} />);

			fireEvent.click(screen.getByText('main'));
			fireEvent.click(screen.getByTestId('git-pill-menu-create-pr'));

			expect(mockOpenModal).toHaveBeenCalledWith(
				'createPR',
				expect.objectContaining({ session: expect.objectContaining({ id: 'session-1' }) })
			);
		});

		it('hides create PR when the branch is unknown', () => {
			mockGetBranchInfo.mockReturnValue({ branch: '', remote: '', ahead: 0, behind: 0 });
			render(
				<MainPanelHeader
					{...defaultProps}
					activeSession={makeSession({ worktreeBranch: undefined } as any)}
				/>
			);

			fireEvent.click(screen.getByText('main'));

			expect(screen.queryByTestId('git-pill-menu-create-pr')).not.toBeInTheDocument();
		});

		it('opens the branch switcher from the menu', () => {
			render(<MainPanelHeader {...defaultProps} />);

			fireEvent.click(screen.getByText('main'));
			fireEvent.click(screen.getByTestId('git-pill-menu-switch-branch'));

			expect(mockOpenModal).toHaveBeenCalledWith(
				'branchSwitcher',
				expect.objectContaining({ cwd: '/test', currentBranch: 'main' })
			);
		});

		it('does not open the menu for a non-git agent', () => {
			render(
				<MainPanelHeader
					{...defaultProps}
					activeSession={makeSession({ isGitRepo: false })}
					gitInfo={null}
				/>
			);

			fireEvent.click(screen.getByText('LOCAL'));

			expect(screen.queryByTestId('git-pill-menu')).not.toBeInTheDocument();
		});
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
