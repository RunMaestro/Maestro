// Source: src/__tests__/renderer/components/AgentSessionsBrowser/components/SessionSearchBar.test.tsx
// Source: src/__tests__/renderer/components/AgentSessionsBrowser/components/SessionListStatsBar.test.tsx
// Source: src/__tests__/renderer/components/AgentSessionsBrowser/components/SearchModeDropdown.test.tsx
// Source: src/__tests__/renderer/components/AgentSessionsBrowser/components/SessionDetailStatsPanel.test.tsx
// Source: src/__tests__/renderer/components/AgentSessionsBrowser/components/SessionListHeader.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import React from 'react';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { SessionSearchBar } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionSearchBar';
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';
import { mockTheme } from '../../../../helpers/mockTheme';
import { SessionListStatsBar } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionListStatsBar';
import { fireEvent } from '@testing-library/react';
import { SearchModeDropdown } from '../../../../../renderer/components/AgentSessionsBrowser/components/SearchModeDropdown';
import type { SearchMode } from '../../../../../renderer/components/AgentSessionsBrowser/types';
import { SessionDetailStatsPanel } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionDetailStatsPanel';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';
import { SessionListHeader } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionListHeader';
vi.mock('../../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../../renderer/hooks/ui/useViewportBreakpoint')
	>()),
	usePhoneLayout: vi.fn(() => false),
}));
vi.mock('../../../../../renderer/components/SessionActivityGraph', () => ({
	SessionActivityGraph: () => <div data-testid="activity-graph" />,
}));
describeSourceSuite('SessionSearchBar', () => {
	const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

	function renderBar() {
		return render(
			<SessionSearchBar
				showSearchPanel={true}
				search=""
				searchMode="all"
				isSearching={false}
				namedOnly={false}
				showAllSessions={false}
				searchModeDropdownOpen={false}
				searchModeDropdownRef={React.createRef<HTMLDivElement>()}
				inputRef={React.createRef<HTMLInputElement>()}
				activityEntries={[]}
				graphLookbackHours={null}
				theme={mockTheme}
				onSearchChange={vi.fn()}
				onSearchKeyDown={vi.fn()}
				onToggleSearchPanel={vi.fn()}
				onToggleNamedOnly={vi.fn()}
				onToggleShowAll={vi.fn()}
				onSearchModeDropdownToggle={vi.fn()}
				onSearchModeSelect={vi.fn()}
				onGraphBarClick={vi.fn()}
				onLookbackChange={vi.fn()}
			/>
		);
	}

	afterEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
	});

	describe('SessionSearchBar', () => {
		it('keeps the filters inline on desktop', () => {
			renderBar();
			expect(screen.getByTestId('session-search-filters')).toHaveClass('contents');
			expect(screen.getByPlaceholderText('Search all content...')).toHaveClass('min-w-0');
		});

		it('moves the filters to their own row on a phone', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			renderBar();
			const filters = screen.getByTestId('session-search-filters');
			expect(filters).toHaveClass('basis-full');
			expect(filters).not.toHaveClass('contents');
			expect(filters.parentElement).toHaveClass('flex-wrap');
			expect(screen.getByText('Named')).toBeInTheDocument();
			expect(screen.getByText('Show All')).toBeInTheDocument();
		});
	});
});
describeSourceSuite('SessionListStatsBar', () => {
	const theme = {
		colors: {
			textDim: '#888',
			textMain: '#fff',
			accent: '#7C3AED',
			success: '#22c55e',
			warning: '#f59e0b',
			border: '#333',
			bgActivity: '#111',
		},
	} as any;

	function makeStats(overrides: any = {}) {
		return {
			totalSessions: 10,
			totalMessages: 100,
			totalSize: 1024 * 1024,
			totalCost: 2.5,
			totalTokens: 5000,
			oldestSession: null,
			isComplete: true,
			...overrides,
		};
	}

	describe('SessionListStatsBar', () => {
		it('renders nothing when loading', () => {
			const { container } = render(
				<SessionListStatsBar
					loading={true}
					sessionsCount={5}
					stats={makeStats()}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders nothing when sessions is empty', () => {
			const { container } = render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={0}
					stats={makeStats()}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('shows singular "session" when totalSessions is 1', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={1}
					stats={makeStats({ totalSessions: 1 })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(screen.getByText(/1 session\b/)).toBeTruthy();
		});

		it('shows plural "sessions" when totalSessions > 1', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({ totalSessions: 5 })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(screen.getByText(/5 sessions/)).toBeTruthy();
		});

		it('shows messages count', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({ totalMessages: 42 })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(screen.getByText(/42 messages/)).toBeTruthy();
		});

		it('shows cost when totalCost > 0 and isComplete', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({ totalCost: 1.23, isComplete: true })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(screen.getByText(/\$1\.23/)).toBeTruthy();
		});

		it('shows cost when not isComplete (loading)', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({ totalCost: 0, isComplete: false })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(screen.getByText(/\$0\.00/)).toBeTruthy();
		});

		it('hides cost when totalCost is 0 AND isComplete', () => {
			const { container } = render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({ totalCost: 0, isComplete: true })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(container.textContent).not.toContain('$');
		});

		it('shows sessionSinceDate when provided', () => {
			const date = new Date('2024-01-15');
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats()}
					sessionSinceDate={date}
					theme={theme}
				/>
			);
			expect(screen.getByText(new RegExp(date.toLocaleDateString()))).toBeTruthy();
		});

		it('hides sessionSinceDate when null', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats()}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(screen.queryByText(/Since/)).toBeNull();
		});

		it('shows animate-pulse class when not isComplete', () => {
			const { container } = render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({ isComplete: false })}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			expect(container.innerHTML).toContain('animate-pulse');
		});
	});

	describe('SessionListStatsBar layout', () => {
		// The bar is one line that scrolls sideways; on a 390px phone the stats
		// used to wrap mid-stat ("1" above "session").
		it('keeps every stat on one sideways-scrolling line', () => {
			const { container } = render(
				<SessionListStatsBar
					theme={theme}
					loading={false}
					sessionsCount={3}
					stats={{
						totalSessions: 3,
						totalMessages: 30,
						totalSize: 221000,
						totalCost: 2.06,
						totalTokens: 1200,
						isComplete: true,
					}}
					sessionSinceDate={null}
				/>
			);
			expect(container.firstChild).toHaveClass('overflow-x-auto');
			expect(screen.getByText('30 messages').parentElement).toHaveClass('whitespace-nowrap');
		});

		it('breaks the token total down by kind on hover, including tokens with no record of their kind', () => {
			render(
				<SessionListStatsBar
					loading={false}
					sessionsCount={5}
					stats={makeStats({
						totalTokens: 1_300_000,
						tokenSplit: {
							inputTokens: 1_000,
							outputTokens: 2_000,
							cacheReadTokens: 1_000_000,
							cacheCreationTokens: 97_000,
						},
						unsplitTokens: 200_000,
					})}
					sessionSinceDate={null}
					theme={theme}
				/>
			);
			const title = screen.getByTestId('session-stats-tokens').getAttribute('title') ?? '';
			expect(title).toMatch(/Cache reads 1(\.0)?M/);
			expect(title).toContain('Input');
			expect(title).toContain('Cache writes');
			expect(title).toMatch(/Archived sessions, no breakdown 200(\.0)?K/);
		});
	});
});
describeSourceSuite('SearchModeDropdown', () => {
	const theme = {
		colors: {
			textDim: '#888',
			textMain: '#fff',
			accent: '#7C3AED',
			bgSidebar: '#1a1a1a',
			border: '#333',
		},
	} as any;

	function defaultProps(overrides: any = {}) {
		return {
			searchMode: 'all' as SearchMode,
			isOpen: false,
			dropdownRef: { current: null } as any,
			onToggle: vi.fn(),
			onSelect: vi.fn(),
			theme,
			...overrides,
		};
	}

	describe('SearchModeDropdown', () => {
		it('hides options when isOpen is false', () => {
			render(<SearchModeDropdown {...defaultProps({ isOpen: false })} />);
			expect(screen.queryByText('Title Only')).toBeNull();
		});

		it('renders 4 options when open', () => {
			render(<SearchModeDropdown {...defaultProps({ isOpen: true })} />);
			expect(screen.getByText('Title Only')).toBeTruthy();
			expect(screen.getByText('My Messages')).toBeTruthy();
			expect(screen.getByText('AI Responses')).toBeTruthy();
			expect(screen.getByText('All Content')).toBeTruthy();
		});

		it('calls onSelect with mode when option is clicked', () => {
			const onSelect = vi.fn();
			render(<SearchModeDropdown {...defaultProps({ isOpen: true, onSelect })} />);
			fireEvent.click(screen.getByText('Title Only'));
			expect(onSelect).toHaveBeenCalledWith('title');
		});

		it('calls onToggle when trigger button is clicked', () => {
			const onToggle = vi.fn();
			render(<SearchModeDropdown {...defaultProps({ onToggle })} />);
			const trigger = screen.getAllByRole('button')[0];
			fireEvent.click(trigger);
			expect(onToggle).toHaveBeenCalled();
		});

		it('shows bg-white/10 class on active mode option', () => {
			const { container } = render(
				<SearchModeDropdown {...defaultProps({ isOpen: true, searchMode: 'user' as SearchMode })} />
			);
			expect(container.innerHTML).toContain('bg-white/10');
		});

		it('trigger shows "All" label for all mode', () => {
			const { container } = render(
				<SearchModeDropdown {...defaultProps({ searchMode: 'all' as SearchMode })} />
			);
			const trigger = screen.getAllByRole('button')[0];
			expect(trigger.textContent).toContain('All');
		});

		it('trigger shows "title" label for title mode', () => {
			render(<SearchModeDropdown {...defaultProps({ searchMode: 'title' as SearchMode })} />);
			const trigger = screen.getAllByRole('button')[0];
			expect(trigger.textContent?.toLowerCase()).toContain('title');
		});
	});
});
describeSourceSuite('SessionDetailStatsPanel', () => {
	const theme = {
		colors: {
			textDim: '#888',
			textMain: '#fff',
			accent: '#7C3AED',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			border: '#333',
			bgActivity: '#111',
		},
	} as any;

	function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
		return {
			sessionId: 's1',
			projectPath: '/p',
			timestamp: '2024-01-01T00:00:00Z',
			modifiedAt: '2024-01-01T00:00:00Z',
			firstMessage: '',
			messageCount: 10,
			sizeBytes: 2048,
			costUsd: 1.23,
			inputTokens: 500,
			outputTokens: 300,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			durationSeconds: 125,
			...overrides,
		};
	}

	describe('SessionDetailStatsPanel', () => {
		it('displays cost as $X.XX', () => {
			render(
				<SessionDetailStatsPanel viewingSession={makeSession({ costUsd: 1.23 })} theme={theme} />
			);
			expect(screen.getByText('$1.23')).toBeTruthy();
		});

		it('displays $0.00 when costUsd is 0', () => {
			render(
				<SessionDetailStatsPanel viewingSession={makeSession({ costUsd: 0 })} theme={theme} />
			);
			expect(screen.getByText('$0.00')).toBeTruthy();
		});

		it('displays $0.00 when costUsd is null/undefined', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ costUsd: undefined })}
					theme={theme}
				/>
			);
			expect(screen.getByText('$0.00')).toBeTruthy();
		});

		it('formats duration <60s as Ns', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ durationSeconds: 45 })}
					theme={theme}
				/>
			);
			expect(screen.getByText('45s')).toBeTruthy();
		});

		it('formats duration <3600s as Nm Ns', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ durationSeconds: 125 })}
					theme={theme}
				/>
			);
			expect(screen.getByText('2m 5s')).toBeTruthy();
		});

		it('formats duration >=3600s as Nh Nm', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ durationSeconds: 3725 })}
					theme={theme}
				/>
			);
			expect(screen.getByText('1h 2m')).toBeTruthy();
		});

		it('displays messages count', () => {
			render(
				<SessionDetailStatsPanel viewingSession={makeSession({ messageCount: 42 })} theme={theme} />
			);
			expect(screen.getByText('42')).toBeTruthy();
		});

		it('shows cache read row when cacheReadTokens > 0', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ cacheReadTokens: 100 })}
					theme={theme}
				/>
			);
			expect(screen.getByText(/Cache Read:/)).toBeTruthy();
		});

		it('hides cache read row when cacheReadTokens is 0', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ cacheReadTokens: 0 })}
					theme={theme}
				/>
			);
			expect(screen.queryByText(/Cache Read:/)).toBeNull();
		});

		it('shows cache write row when cacheCreationTokens > 0', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ cacheCreationTokens: 50 })}
					theme={theme}
				/>
			);
			expect(screen.getByText(/Cache Write:/)).toBeTruthy();
		});

		it('hides cache write row when cacheCreationTokens is 0', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ cacheCreationTokens: 0 })}
					theme={theme}
				/>
			);
			expect(screen.queryByText(/Cache Write:/)).toBeNull();
		});

		it('shows Input and Output token rows', () => {
			render(
				<SessionDetailStatsPanel
					viewingSession={makeSession({ inputTokens: 500, outputTokens: 300 })}
					theme={theme}
				/>
			);
			expect(screen.getByText(/Input:/)).toBeTruthy();
			expect(screen.getByText(/Output:/)).toBeTruthy();
		});
	});
});
describeSourceSuite('SessionListHeader', () => {
	const theme = {
		colors: {
			textDim: '#888',
			textMain: '#fff',
			accent: '#7C3AED',
			accentForeground: '#000',
		},
	} as any;

	describe('SessionListHeader', () => {
		it('shows "Claude Sessions for..." for claude-code agent', () => {
			render(
				<SessionListHeader
					agentId="claude-code"
					sessionName="MyProject"
					activeAgentSessionId={null}
					theme={theme}
					onNewSession={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText(/Claude Sessions for/)).toBeTruthy();
		});

		it('shows "Agent Sessions for..." for non-claude agent', () => {
			render(
				<SessionListHeader
					agentId="codex"
					sessionName="MyProject"
					activeAgentSessionId={null}
					theme={theme}
					onNewSession={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText(/Agent Sessions for/)).toBeTruthy();
		});

		it('renders active badge with first 8 chars + ellipsis', () => {
			render(
				<SessionListHeader
					agentId="claude-code"
					sessionName="MyProject"
					activeAgentSessionId="abcdef1234567890"
					theme={theme}
					onNewSession={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('Active: abcdef12...')).toBeTruthy();
		});

		it('renders no active badge when activeAgentSessionId is null', () => {
			render(
				<SessionListHeader
					agentId="claude-code"
					sessionName="MyProject"
					activeAgentSessionId={null}
					theme={theme}
					onNewSession={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(screen.queryByText(/Active:/)).toBeNull();
		});

		it('renders no active badge when activeAgentSessionId is empty string', () => {
			render(
				<SessionListHeader
					agentId="claude-code"
					sessionName="MyProject"
					activeAgentSessionId=""
					theme={theme}
					onNewSession={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(screen.queryByText(/Active:/)).toBeNull();
		});

		it('calls onNewSession when New Session button is clicked', () => {
			const onNewSession = vi.fn();
			render(
				<SessionListHeader
					agentId="claude-code"
					sessionName="MyProject"
					activeAgentSessionId={null}
					theme={theme}
					onNewSession={onNewSession}
					onClose={vi.fn()}
				/>
			);
			fireEvent.click(screen.getByText('New Session'));
			expect(onNewSession).toHaveBeenCalled();
		});

		it('calls onClose when X button is clicked', () => {
			const onClose = vi.fn();
			render(
				<SessionListHeader
					agentId="claude-code"
					sessionName="MyProject"
					activeAgentSessionId={null}
					theme={theme}
					onNewSession={vi.fn()}
					onClose={onClose}
				/>
			);
			// The X button is the one that doesn't say "New Session"
			const buttons = screen.getAllByRole('button');
			const closeBtn = buttons.find((b) => !b.textContent?.includes('New Session'))!;
			fireEvent.click(closeBtn);
			expect(onClose).toHaveBeenCalled();
		});
	});
});
