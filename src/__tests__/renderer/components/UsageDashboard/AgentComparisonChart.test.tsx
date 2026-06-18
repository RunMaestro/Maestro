/**
 * Tests for AgentComparisonChart component
 *
 * Verifies:
 * - Renders horizontal bar chart comparing agent usage
 * - Shows correct agent names and values
 * - Toggle between count and duration modes
 * - Bars sorted by value descending
 * - Distinct colors per agent
 * - Percentage labels on bars
 * - Tooltip shows details on hover
 * - Handles empty data gracefully
 * - Applies theme colors correctly
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

let _sessionIdCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
	_sessionIdCounter++;
	return {
		id: `s${_sessionIdCounter}`,
		name: `Session ${_sessionIdCounter}`,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		createdAt: 0,
		...overrides,
	} as Session;
}

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		'factory-droid': { count: 20, duration: 1600000 },
		terminal: { count: 10, duration: 500000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
	],
};

// Data with single agent
const singleAgentData: StatsAggregation = {
	totalQueries: 20,
	totalDuration: 1000000,
	avgDuration: 50000,
	byAgent: {
		'claude-code': { count: 20, duration: 1000000 },
	},
	bySource: { user: 20, auto: 0 },
	byDay: [],
};

// Data with many agents
const manyAgentsData: StatsAggregation = {
	totalQueries: 100,
	totalDuration: 5000000,
	avgDuration: 50000,
	byAgent: {
		'claude-code': { count: 30, duration: 1500000 },
		'factory-droid': { count: 25, duration: 1200000 },
		terminal: { count: 15, duration: 800000 },
		opencode: { count: 12, duration: 600000 },
		gemini: { count: 10, duration: 500000 },
		codex: { count: 5, duration: 250000 },
		qwen: { count: 3, duration: 150000 },
	},
	bySource: { user: 70, auto: 30 },
	byDay: [],
};

// Empty data for edge case testing
const emptyData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [],
};

describe('AgentComparisonChart', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
		});

		it('renders count and duration labels for each agent', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Component now shows both count and duration for each agent (no toggle)
			// Check that query count labels are present
			expect(screen.getAllByText(/queries/).length).toBeGreaterThan(0);
			// Check that duration is displayed (e.g., "33m 20s" for claude-code)
			expect(screen.getByText('33m 20s')).toBeInTheDocument();
		});

		it('renders agent names', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Without sessions, raw agent type keys are prettified via
			// AGENT_DISPLAY_NAMES (e.g. "claude-code" → "Claude Code").
			// Use getAllByText since names appear in both bar labels and legend.
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Terminal').length).toBeGreaterThanOrEqual(1);
		});

		it('renders with empty data showing message', () => {
			render(<AgentComparisonChart data={emptyData} theme={theme} />);

			expect(screen.getByText('No agent data available')).toBeInTheDocument();
		});

		it('renders single agent correctly', () => {
			render(<AgentComparisonChart data={singleAgentData} theme={theme} />);

			// Use getAllByText since agent name appears in both bar label and legend
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			// Single agent should show 100%
			expect(screen.getByText('100.0%')).toBeInTheDocument();
		});
	});

	describe('Unified Count and Duration Display', () => {
		it('shows both count and duration for each agent', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Should show duration for claude-code: 2000000ms = 33m 20s
			expect(screen.getByText('33m 20s')).toBeInTheDocument();

			// Should show count values - multiple "queries" labels will be present for multiple agents
			expect(screen.getAllByText(/queries/).length).toBeGreaterThan(0);
		});

		it('shows query count label for single query', () => {
			const singleQueryData: StatsAggregation = {
				...singleAgentData,
				byAgent: {
					'claude-code': { count: 1, duration: 1000000 },
				},
			};
			render(<AgentComparisonChart data={singleQueryData} theme={theme} />);

			// Should show "query" for count of 1 (singular form)
			expect(screen.getByText(/1 query$/)).toBeInTheDocument();
		});

		it('shows formatted count with queries label', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// claude-code has 30 queries - should be displayed with "queries" suffix
			// Multiple agents have "queries" label, so use getAllByText
			const queryLabels = screen.getAllByText(/\d+ queries/);
			expect(queryLabels.length).toBeGreaterThan(0);
		});
	});

	describe('Bar Sorting', () => {
		it('sorts bars by value descending', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Get all agent name labels
			const agentLabels = container.querySelectorAll('.w-28.truncate');
			const agentNames = Array.from(agentLabels).map((el) => el.textContent);

			// Bars are sorted by duration: claude-code (2000000) > factory-droid
			// (1600000) > terminal (500000). Labels are prettified by buildNameMap.
			expect(agentNames[0]).toBe('Claude Code');
			expect(agentNames[1]).toBe('Factory Droid');
			expect(agentNames[2]).toBe('Terminal');
		});
	});

	describe('Percentage Labels', () => {
		it('shows percentage labels on bars', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Should have percentage labels for each agent
			// Total duration is 4100000, claude-code is 2000000 = ~48.8%
			// Using regex to find percentage patterns
			const percentages = screen.getAllByText(/\d+\.\d+%/);
			expect(percentages.length).toBeGreaterThan(0);
		});
	});

	describe('Agent Colors', () => {
		it('assigns distinct colors to different agents', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find the bar fill divs (with h-full, rounded, and flex classes - the actual colored bars)
			// These bars now use inline styles for transitions instead of Tailwind classes
			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			const colors = Array.from(bars)
				.map((bar) => (bar as HTMLElement).style.backgroundColor)
				.filter((c) => c !== '');

			// Should have 3 bars with colors
			expect(colors.length).toBe(3);
			// Should have different colors for each agent
			expect(new Set(colors).size).toBe(colors.length);
		});
	});

	describe('Legend', () => {
		it('shows legend with agent colors', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Legend should have color indicators
			const legendItems = container.querySelectorAll('.w-2\\.5.h-2\\.5.rounded-sm');
			expect(legendItems.length).toBeGreaterThan(0);
		});

		it('shows +N more when there are many agents', () => {
			render(<AgentComparisonChart data={manyAgentsData} theme={theme} />);

			// With 7 agents, should show 6 in legend and "+1 more"
			expect(screen.getByText('+1 more')).toBeInTheDocument();
		});

		it('does not show legend with empty data', () => {
			const { container } = render(<AgentComparisonChart data={emptyData} theme={theme} />);

			// No legend items should be present
			const legendItems = container.querySelectorAll('.w-2\\.5.h-2\\.5.rounded-sm');
			expect(legendItems.length).toBe(0);
		});
	});

	describe('Tooltip Functionality', () => {
		it('shows tooltip on bar hover', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find the first bar row
			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				fireEvent.mouseEnter(barRows[0]);

				// Tooltip should appear
				// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
				const tooltip = document.body.querySelector('div.fixed.shadow-lg');
				expect(tooltip).toBeInTheDocument();
			}
		});

		it('hides tooltip on mouse leave', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				fireEvent.mouseEnter(barRows[0]);
				fireEvent.mouseLeave(barRows[0]);

				// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
				const tooltip = document.body.querySelector('div.fixed.shadow-lg');
				expect(tooltip).not.toBeInTheDocument();
			}
		});

		it('tooltip shows query count and duration', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				fireEvent.mouseEnter(barRows[0]);

				// Tooltip should contain queries text and total text
				// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
				const tooltip = document.body.querySelector('div.fixed.shadow-lg');
				expect(tooltip?.textContent).toContain('queries');
				expect(tooltip?.textContent).toContain('total');
			}
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			const title = screen.getByText('Provider Comparison');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<AgentComparisonChart data={mockData} theme={lightTheme} />);

			expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
		});

		it('applies border colors from theme', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Legend container should have border-top
			const legendContainer = container.querySelector('.flex.flex-wrap.gap-3.mt-4.pt-3.border-t');
			expect(legendContainer).toHaveStyle({
				borderColor: theme.colors.border,
			});
		});
	});

	describe('Value Formatting', () => {
		it('formats duration values correctly', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// claude-code duration: 2000000ms = 33m 20s
			expect(screen.getByText('33m 20s')).toBeInTheDocument();
		});

		it('formats large count values with K suffix', () => {
			const largeCountData: StatsAggregation = {
				...mockData,
				byAgent: {
					'claude-code': { count: 1500, duration: 100000 },
				},
			};

			render(<AgentComparisonChart data={largeCountData} theme={theme} />);

			// 1500 should be formatted as 1.5K (now shown alongside duration, no toggle needed)
			expect(screen.getByText(/1\.5K/)).toBeInTheDocument();
		});

		it('formats hours correctly', () => {
			const longDurationData: StatsAggregation = {
				...mockData,
				byAgent: {
					'claude-code': { count: 10, duration: 7200000 }, // 2 hours
				},
			};

			render(<AgentComparisonChart data={longDurationData} theme={theme} />);

			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});
	});

	describe('Bar Width Calculation', () => {
		it('highest value agent has full width bar', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find the first bar (should be claude-code with highest duration)
			// Bars have h-full, rounded, and flex classes with inline transition styles
			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');

			if (bars.length > 0) {
				const firstBar = bars[0] as HTMLElement;
				// Should have close to 100% width
				expect(firstBar.style.width).toBe('100%');
			}
		});
	});

	describe('Hover State', () => {
		it('highlights agent name on hover', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				const agentLabel = barRows[0].querySelector('.w-28');

				// Before hover, should have textDim color
				expect(agentLabel).toHaveStyle({
					color: theme.colors.textDim,
				});

				fireEvent.mouseEnter(barRows[0]);

				// After hover, should have textMain color
				expect(agentLabel).toHaveStyle({
					color: theme.colors.textMain,
				});
			}
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to bars for smooth width changes', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find bar elements - they have h-full, rounded, and flex classes
			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			expect(bars.length).toBeGreaterThan(0);

			const firstBar = bars[0] as HTMLElement;
			expect(firstBar.style.transition).toContain('width');
			expect(firstBar.style.transition).toContain('0.5s');
		});

		it('uses cubic-bezier easing for smooth animation curves', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			expect(bars.length).toBeGreaterThan(0);

			const firstBar = bars[0] as HTMLElement;
			expect(firstBar.style.transition).toContain('cubic-bezier');
		});

		it('applies opacity transition for hover effects', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			expect(bars.length).toBeGreaterThan(0);

			const firstBar = bars[0] as HTMLElement;
			expect(firstBar.style.transition).toContain('opacity');
		});
	});

	describe('Worktree Differentiation', () => {
		it('splits worktree agents into separate bars and tags them with "(Worktree)"', () => {
			const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'wt-1',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});

			const dataWithSessions: StatsAggregation = {
				...mockData,
				bySessionByDay: {
					parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
					'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
				},
			};

			render(
				<AgentComparisonChart data={dataWithSessions} theme={theme} sessions={[parent, worktree]} />
			);

			// Two sessions share toolType "claude-code" so resolveAgentDisplayName
			// falls back to the prettified type name. Labels appear in both the
			// bar row and the legend.
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Claude Code (Worktree)').length).toBeGreaterThanOrEqual(1);
		});

		it('renders the Agent vs Worktree Agent legend when worktrees are present', () => {
			const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'wt-1',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});

			const dataWithSessions: StatsAggregation = {
				...mockData,
				bySessionByDay: {
					parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
					'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
				},
			};

			const { container } = render(
				<AgentComparisonChart data={dataWithSessions} theme={theme} sessions={[parent, worktree]} />
			);

			const legendBlock = container.querySelector('[aria-label="Worktree differentiation legend"]');
			expect(legendBlock).not.toBeNull();
			expect(legendBlock?.textContent).toContain('Agent');
			expect(legendBlock?.textContent).toContain('Worktree Agent');
		});

		it('does not render the worktree legend when no worktree sessions exist', () => {
			const regular = makeSession({ id: 'reg', toolType: 'claude-code' });

			const dataWithSessions: StatsAggregation = {
				...mockData,
				bySessionByDay: {
					reg: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
				},
			};

			const { container } = render(
				<AgentComparisonChart data={dataWithSessions} theme={theme} sessions={[regular]} />
			);

			expect(container.querySelector('[aria-label="Worktree differentiation legend"]')).toBeNull();
		});

		it('falls back to byAgent aggregation when sessions prop is not provided', () => {
			// Without sessions, no worktree info — should render exactly the
			// providers in byAgent without "(Worktree)" suffixes.
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			expect(screen.queryByText(/\(Worktree\)/)).not.toBeInTheDocument();
		});
	});

	describe('Drill-Down Filtering', () => {
		// `[role="listitem"]` targets the outer bar row only — the inner count/
		// duration labels share `.flex.items-center.gap-3` but have no role.
		const BAR_ROW_SELECTOR = '[role="listitem"][aria-label]';

		it('does not set cursor pointer or tabIndex when onAgentClick is not provided', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			expect(barRows.length).toBeGreaterThan(0);
			const firstRow = barRows[0] as HTMLElement;
			expect(firstRow.style.cursor).toBe('');
			expect(firstRow.getAttribute('tabIndex')).toBeNull();
		});

		it('sets cursor pointer and tabIndex when onAgentClick is provided', () => {
			const onAgentClick = vi.fn();
			const { container } = render(
				<AgentComparisonChart data={mockData} theme={theme} onAgentClick={onAgentClick} />
			);

			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			const firstRow = barRows[0] as HTMLElement;
			expect(firstRow.style.cursor).toBe('pointer');
			expect(firstRow.getAttribute('tabIndex')).toBe('0');
		});

		it('fires onAgentClick with the bar key and resolved label on click', () => {
			const onAgentClick = vi.fn();
			const { container } = render(
				<AgentComparisonChart data={mockData} theme={theme} onAgentClick={onAgentClick} />
			);

			// Bars are sorted by duration desc → claude-code is first.
			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			fireEvent.click(barRows[0]);

			expect(onAgentClick).toHaveBeenCalledTimes(1);
			expect(onAgentClick).toHaveBeenCalledWith('claude-code', 'Claude Code');
		});

		it('fires onAgentClick on Enter and Space key activation', () => {
			const onAgentClick = vi.fn();
			const { container } = render(
				<AgentComparisonChart data={mockData} theme={theme} onAgentClick={onAgentClick} />
			);

			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			fireEvent.keyDown(barRows[0], { key: 'Enter' });
			fireEvent.keyDown(barRows[0], { key: ' ' });

			expect(onAgentClick).toHaveBeenCalledTimes(2);
		});

		it('dims non-matching bars to 30% opacity when activeFilterKey is set', () => {
			const { container } = render(
				<AgentComparisonChart
					data={mockData}
					theme={theme}
					onAgentClick={vi.fn()}
					activeFilterKey="claude-code"
				/>
			);

			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			// Sorted: claude-code (selected, opacity 1), factory-droid + terminal (dimmed)
			expect((barRows[0] as HTMLElement).style.opacity).toBe('1');
			expect((barRows[1] as HTMLElement).style.opacity).toBe('0.3');
			expect((barRows[2] as HTMLElement).style.opacity).toBe('0.3');
		});

		it('renders bars at full opacity when no filter is active', () => {
			const { container } = render(
				<AgentComparisonChart
					data={mockData}
					theme={theme}
					onAgentClick={vi.fn()}
					activeFilterKey={null}
				/>
			);

			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			barRows.forEach((row) => {
				expect((row as HTMLElement).style.opacity).toBe('1');
			});
		});

		it('applies an accent-colored outline to the selected bar container', () => {
			const { container } = render(
				<AgentComparisonChart
					data={mockData}
					theme={theme}
					onAgentClick={vi.fn()}
					activeFilterKey="claude-code"
				/>
			);

			const barContainers = container.querySelectorAll(
				'.flex-1.h-full.rounded.overflow-hidden.relative'
			);
			expect(barContainers.length).toBe(3);
			// Selected bar (claude-code, sorted first) gets an inset accent outline.
			const selected = barContainers[0] as HTMLElement;
			expect(selected.style.boxShadow).toContain('inset');
			expect(selected.style.boxShadow).toContain('2px');
			// Non-selected bars do not have the outline.
			expect((barContainers[1] as HTMLElement).style.boxShadow).toBe('');
		});

		it('reflects selection state via aria-pressed', () => {
			const { container } = render(
				<AgentComparisonChart
					data={mockData}
					theme={theme}
					onAgentClick={vi.fn()}
					activeFilterKey="factory-droid"
				/>
			);

			const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
			// Sorted by duration: claude-code (false), factory-droid (true), terminal (false).
			expect(barRows[0].getAttribute('aria-pressed')).toBe('false');
			expect(barRows[1].getAttribute('aria-pressed')).toBe('true');
			expect(barRows[2].getAttribute('aria-pressed')).toBe('false');
		});

		it('passes the worktree key suffix when a worktree bar is clicked', () => {
			const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'wt-1',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});
			const onAgentClick = vi.fn();

			const dataWithSessions: StatsAggregation = {
				...mockData,
				bySessionByDay: {
					parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
					'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
				},
			};

			const { container } = render(
				<AgentComparisonChart
					data={dataWithSessions}
					theme={theme}
					sessions={[parent, worktree]}
					onAgentClick={onAgentClick}
				/>
			);

			// Find the worktree bar by aria-label suffix and click it.
			const barRows = Array.from(container.querySelectorAll(BAR_ROW_SELECTOR)) as HTMLElement[];
			const worktreeRow = barRows.find((row) =>
				row.getAttribute('aria-label')?.startsWith('Claude Code (Worktree)')
			);
			expect(worktreeRow).toBeDefined();

			fireEvent.click(worktreeRow!);

			expect(onAgentClick).toHaveBeenCalledWith('claude-code__worktree', 'Claude Code (Worktree)');
		});
	});

	describe('Session Name Resolution', () => {
		it('uses the user-assigned session name when a single session matches the provider', () => {
			// One session of toolType "claude-code" — buildNameMap should pick
			// the session's name ("Backend API") for the bar label.
			const session = makeSession({
				id: 'backend-api',
				name: 'Backend API',
				toolType: 'claude-code',
			});
			const data: StatsAggregation = {
				...singleAgentData,
				byAgent: {
					'claude-code': { count: 20, duration: 1000000 },
				},
			};

			render(<AgentComparisonChart data={data} theme={theme} sessions={[session]} />);

			expect(screen.getAllByText('Backend API').length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
		});

		it('falls back to prettified type when multiple sessions share the same provider', () => {
			// Two distinct claude-code sessions — buildNameMap can't pick one,
			// so it should use the prettified type name.
			const a = makeSession({ id: 'a', name: 'Frontend', toolType: 'claude-code' });
			const b = makeSession({ id: 'b', name: 'Backend', toolType: 'claude-code' });
			const data: StatsAggregation = {
				...singleAgentData,
				byAgent: {
					'claude-code': { count: 20, duration: 1000000 },
				},
			};

			render(<AgentComparisonChart data={data} theme={theme} sessions={[a, b]} />);

			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
		});

		it('disambiguates colliding display names with " (2)" suffixes', () => {
			// Two providers, single matching session each, both named "Worker".
			// buildNameMap should append " (2)" to the second to avoid collision.
			const a = makeSession({ id: 'a', name: 'Worker', toolType: 'claude-code' });
			const b = makeSession({ id: 'b', name: 'Worker', toolType: 'opencode' });
			const data: StatsAggregation = {
				...mockData,
				byAgent: {
					'claude-code': { count: 30, duration: 2000000 },
					opencode: { count: 20, duration: 1000000 },
				},
			};

			render(<AgentComparisonChart data={data} theme={theme} sessions={[a, b]} />);

			expect(screen.getAllByText('Worker').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Worker (2)').length).toBeGreaterThanOrEqual(1);
		});

		it('uses prettified type for providers with no matching session', () => {
			// Sessions present but none with matching toolType — falls through
			// to prettifyAgentType.
			const session = makeSession({
				id: 'unrelated',
				name: 'Unrelated',
				toolType: 'opencode',
			});
			const data: StatsAggregation = {
				...singleAgentData,
				byAgent: {
					'factory-droid': { count: 10, duration: 500000 },
				},
			};

			render(<AgentComparisonChart data={data} theme={theme} sessions={[session]} />);

			expect(screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
		});

		it('uses resolved name in tooltip', () => {
			const session = makeSession({
				id: 'backend-api',
				name: 'Backend API',
				toolType: 'claude-code',
			});
			const data: StatsAggregation = {
				...singleAgentData,
				byAgent: {
					'claude-code': { count: 20, duration: 1000000 },
				},
			};

			const { container } = render(
				<AgentComparisonChart data={data} theme={theme} sessions={[session]} />
			);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');
			fireEvent.mouseEnter(barRows[0]);

			// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
			const tooltip = document.body.querySelector('div.fixed.shadow-lg');
			expect(tooltip?.textContent).toContain('Backend API');
		});
	});
});
