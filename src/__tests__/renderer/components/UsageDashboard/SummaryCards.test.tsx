/**
 * Tests for SummaryCards component
 *
 * Verifies:
 * - Renders all ten metric cards correctly
 * - Displays formatted values (numbers, durations)
 * - Shows correct icons for each metric
 * - Applies theme colors properly
 * - Handles edge cases (empty data, zero values)
 * - Computes derived metrics correctly (most active agent, interactive ratio)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
	AnimatedNumber,
	BouncingDots,
	ContextUsageBar,
	RealtimeMetricsCard,
	SummaryCards,
	TokenCostBadge,
} from '../../../../renderer/components/UsageDashboard/SummaryCards';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 150,
	totalDuration: 7200000, // 2 hours in ms
	avgDuration: 48000, // 48 seconds in ms
	byAgent: {
		'claude-code': { count: 100, duration: 5000000 },
		codex: { count: 50, duration: 2200000 },
	},
	bySource: { user: 120, auto: 30 },
	byLocation: { local: 120, remote: 30 },
	byDay: [
		{ date: '2024-12-20', count: 50, duration: 2400000 },
		{ date: '2024-12-21', count: 100, duration: 4800000 },
	],
	byHour: [],
	totalSessions: 25,
	sessionsByAgent: { 'claude-code': 15, codex: 10 },
	sessionsByDay: [],
	avgSessionDuration: 288000,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Empty data for edge case testing
const emptyData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byLocation: { local: 0, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 0,
	sessionsByAgent: {},
	sessionsByDay: [],
	avgSessionDuration: 0,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Data with large numbers
const largeNumbersData: StatsAggregation = {
	totalQueries: 1500000, // 1.5M
	totalDuration: 360000000, // 100 hours
	avgDuration: 240000, // 4 minutes
	byAgent: {
		'claude-code': { count: 1000000, duration: 200000000 },
		'openai-codex': { count: 500000, duration: 160000000 },
	},
	bySource: { user: 1200000, auto: 300000 },
	byLocation: { local: 1000000, remote: 500000 },
	byDay: [],
	byHour: [],
	totalSessions: 50000,
	sessionsByAgent: { 'claude-code': 30000, 'openai-codex': 20000 },
	sessionsByDay: [],
	avgSessionDuration: 7200000,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Single agent data
const singleAgentData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 1800000, // 30 minutes
	avgDuration: 36000, // 36 seconds
	byAgent: {
		terminal: { count: 50, duration: 1800000 },
	},
	bySource: { user: 50, auto: 0 },
	byLocation: { local: 50, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 5,
	sessionsByAgent: { terminal: 5 },
	sessionsByDay: [],
	avgSessionDuration: 360000,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Mock sessions with tabs for open tab count testing
const mockSessions = [
	{
		id: 's1',
		toolType: 'claude-code',
		aiTabs: [{ id: 'tab1' }, { id: 'tab2' }, { id: 'tab3' }],
		filePreviewTabs: [{ id: 'file1' }],
	},
	{
		id: 's2',
		toolType: 'codex',
		aiTabs: [{ id: 'tab4' }],
		filePreviewTabs: [{ id: 'file2' }, { id: 'file3' }],
	},
	{
		id: 's3',
		toolType: 'terminal',
		aiTabs: [{ id: 'tab5' }],
		filePreviewTabs: [],
	},
] as unknown as Session[];

describe('SummaryCards', () => {
	describe('Rendering', () => {
		it('renders the summary cards container', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
		});

		it('renders all twelve metric cards', () => {
			// Card count grew from 10 to 12: Interactive % + Local % were removed,
			// and Current Streak / Best Day / Active Days / Worktree % were added.
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);

			const cards = screen.getAllByTestId('metric-card');
			expect(cards).toHaveLength(12);
		});

		it('renders Total Queries metric', async () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Total Queries')).toBeInTheDocument();
			expect(await screen.findByText('150')).toBeInTheDocument();
		});

		it('renders Total Time metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Total Time')).toBeInTheDocument();
			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});

		it('renders Avg Duration metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
			expect(screen.getByText('48s')).toBeInTheDocument();
		});

		it('renders Top Agent metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Top Agent')).toBeInTheDocument();
			expect(screen.getByText('claude-code')).toBeInTheDocument();
		});

		// Interactive % / Local % cards were removed in favor of streak,
		// best-day, active-days, and worktree % which surface signal that
		// actually changes day to day. Confirm the new cards render.
		it('renders Current Streak metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Current Streak')).toBeInTheDocument();
		});

		it('renders Best Day metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Best Day')).toBeInTheDocument();
		});

		it('renders Active Days metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Active Days')).toBeInTheDocument();
		});

		it('renders Worktree % metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Worktree %')).toBeInTheDocument();
		});

		it('renders Open Tabs metric with correct count', () => {
			// mockSessions has 3+1+1+2+1+0 = 8 total tabs (AI + file preview across all sessions)
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);

			expect(screen.getByText('Open Tabs')).toBeInTheDocument();
			const tabsCard = screen.getByRole('group', { name: /Open Tabs: 8/i });
			expect(tabsCard).toBeInTheDocument();
		});

		it('renders Open Tabs as 0 when no sessions provided', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Open Tabs')).toBeInTheDocument();
			const tabsCard = screen.getByRole('group', { name: /Open Tabs: 0/i });
			expect(tabsCard).toBeInTheDocument();
		});
	});

	describe('Number Formatting', () => {
		it('formats thousands with K suffix', async () => {
			const dataWithThousands: StatsAggregation = {
				...mockData,
				totalQueries: 1500,
			};
			render(<SummaryCards data={dataWithThousands} theme={theme} />);

			expect(await screen.findByText('1.5K')).toBeInTheDocument();
		});

		it('formats millions with M suffix', async () => {
			render(<SummaryCards data={largeNumbersData} theme={theme} />);

			expect(await screen.findByText('1.5M')).toBeInTheDocument();
		});

		it('displays small numbers without suffix', async () => {
			const dataWithSmallNumbers: StatsAggregation = {
				...mockData,
				totalQueries: 42,
			};
			render(<SummaryCards data={dataWithSmallNumbers} theme={theme} />);

			expect(await screen.findByText('42')).toBeInTheDocument();
		});
	});

	describe('Duration Formatting', () => {
		it('formats hours and minutes correctly', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// 2 hours = "2h 0m"
			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});

		it('formats minutes and seconds correctly', () => {
			const dataWithMinutes: StatsAggregation = {
				...mockData,
				avgDuration: 125000, // 2m 5s
			};
			render(<SummaryCards data={dataWithMinutes} theme={theme} />);

			expect(screen.getByText('2m 5s')).toBeInTheDocument();
		});

		it('formats seconds only correctly', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// 48 seconds
			expect(screen.getByText('48s')).toBeInTheDocument();
		});

		it('displays 0s for zero duration', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Should have multiple 0s values
			const zeroElements = screen.getAllByText('0s');
			expect(zeroElements.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('Most Active Agent Calculation', () => {
		it('identifies the most active agent by count', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// claude-code has 100 queries, codex has 50
			expect(screen.getByText('claude-code')).toBeInTheDocument();
		});

		it('shows N/A when no agents exist', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Both Top Agent and Interactive % will be N/A for empty data
			const naElements = screen.getAllByText('N/A');
			expect(naElements.length).toBeGreaterThanOrEqual(1);

			// Verify Top Agent specifically shows N/A
			expect(screen.getByText('Top Agent')).toBeInTheDocument();
		});

		it('handles single agent correctly', () => {
			render(<SummaryCards data={singleAgentData} theme={theme} />);

			expect(screen.getByText('terminal')).toBeInTheDocument();
		});
	});

	// Interactive Ratio tests removed — the Interactive % card is no longer
	// rendered. Top Agent / Peak Hour still surface N/A when their inputs are
	// empty, which the existing "Most Active Agent Calculation > shows N/A"
	// test already covers.

	describe('Theme Support', () => {
		it('applies theme background color to cards', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			const cards = screen.getAllByTestId('metric-card');
			cards.forEach((card) => {
				expect(card).toHaveStyle({
					backgroundColor: theme.colors.bgActivity,
				});
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];
			render(<SummaryCards data={mockData} theme={lightTheme} />);

			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
			expect(screen.getByText('Total Queries')).toBeInTheDocument();
		});

		it('works with different dark themes', () => {
			const nordTheme = THEMES['nord'];
			render(<SummaryCards data={mockData} theme={nordTheme} />);

			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
			const cards = screen.getAllByTestId('metric-card');
			cards.forEach((card) => {
				expect(card).toHaveStyle({
					backgroundColor: nordTheme.colors.bgActivity,
				});
			});
		});
	});

	describe('Icons', () => {
		it('renders SVG icons for each metric', () => {
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);

			// Scope to the metrics grid so the realtime card's icons don't inflate the count.
			// Subtract sparkline SVGs (rendered for the Total Queries + Total Time cards) so
			// this assertion stays focused on the per-metric lucide icon.
			const grid = screen.getByTestId('summary-cards');
			const svgElements = grid.querySelectorAll('svg');
			const sparklines = grid.querySelectorAll(
				'[data-testid="sparkline"], [data-testid="sparkline-empty"]'
			);
			expect(svgElements.length - sparklines.length).toBe(12);
		});
	});

	describe('Sparklines', () => {
		const dataWithByDay: StatsAggregation = {
			...mockData,
			byDay: [
				{ date: '2024-12-15', count: 10, duration: 600000 },
				{ date: '2024-12-16', count: 20, duration: 1200000 },
				{ date: '2024-12-17', count: 15, duration: 800000 },
				{ date: '2024-12-18', count: 30, duration: 1500000 },
				{ date: '2024-12-19', count: 25, duration: 1300000 },
				{ date: '2024-12-20', count: 50, duration: 2400000 },
				{ date: '2024-12-21', count: 100, duration: 4800000 },
			],
		};

		it('renders sparklines on Total Queries and Total Time cards when byDay has data', () => {
			render(<SummaryCards data={dataWithByDay} theme={theme} />);

			const queriesCard = screen.getByRole('group', { name: /Total Queries: 150/i });
			const totalTimeCard = screen.getByRole('group', { name: /Total Time: 2h 0m/i });

			expect(queriesCard.querySelector('[data-testid="sparkline"]')).not.toBeNull();
			expect(totalTimeCard.querySelector('[data-testid="sparkline"]')).not.toBeNull();
		});

		it('does not render sparklines on cards without trend data', () => {
			render(<SummaryCards data={dataWithByDay} theme={theme} sessions={mockSessions} />);

			const agentsCard = screen.getByRole('group', { name: /^Agents:/i });
			const openTabsCard = screen.getByRole('group', { name: /Open Tabs:/i });

			expect(agentsCard.querySelector('[data-testid="sparkline"]')).toBeNull();
			expect(openTabsCard.querySelector('[data-testid="sparkline"]')).toBeNull();
		});

		it('renders an empty (dashed-baseline) sparkline when byDay is empty', () => {
			// emptyData has byDay: [] — left-padded to seven zeros, the Sparkline
			// collapses to its empty/dashed baseline state.
			render(<SummaryCards data={emptyData} theme={theme} />);

			const queriesCard = screen.getByRole('group', { name: /Total Queries: 0/i });
			expect(queriesCard.querySelector('[data-testid="sparkline-empty"]')).not.toBeNull();
		});
	});

	describe('Grid Layout', () => {
		it('uses 3-column grid layout by default (2 rows × 3 cols)', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			const container = screen.getByTestId('summary-cards');
			expect(container).toHaveClass('grid');
			expect(container).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('supports responsive column configuration', () => {
			render(<SummaryCards data={mockData} theme={theme} columns={3} />);

			const container = screen.getByTestId('summary-cards');
			expect(container).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('supports 2-column layout for narrow screens', () => {
			render(<SummaryCards data={mockData} theme={theme} columns={2} />);

			const container = screen.getByTestId('summary-cards');
			expect(container).toHaveStyle({
				gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
			});
		});
	});

	describe('Edge Cases', () => {
		it('handles all zero values', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Should render without errors
			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
			// Multiple cards show '0' for empty data (Agents, Queries)
			expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1);
		});

		it('handles very large numbers', async () => {
			render(<SummaryCards data={largeNumbersData} theme={theme} />);

			expect(await screen.findByText('1.5M')).toBeInTheDocument();
			expect(screen.getByText('100h 0m')).toBeInTheDocument();
		});

		it('handles long agent names without truncation', () => {
			const dataWithLongName: StatsAggregation = {
				...mockData,
				byAgent: {
					'very-long-agent-name-that-might-overflow': { count: 100, duration: 5000000 },
				},
			};
			render(<SummaryCards data={dataWithLongName} theme={theme} />);

			// Long agent names should now wrap to next line instead of truncating
			const agentValue = screen.getByText('very-long-agent-name-that-might-overflow');
			expect(agentValue).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('has title attribute on value for tooltip', () => {
			const { container } = render(<SummaryCards data={mockData} theme={theme} />);

			// Values should have title for full value on hover
			const valueElements = container.querySelectorAll('[title]');
			expect(valueElements.length).toBeGreaterThan(0);
		});
	});
});

describe('AnimatedNumber', () => {
	it('renders the final numeric value after the count-up animation completes', async () => {
		render(<AnimatedNumber value="150" />);

		expect(await screen.findByText('150')).toBeInTheDocument();
	});

	it('starts numeric values from 0 before the animation runs', () => {
		const { container } = render(<AnimatedNumber value="150" />);

		// Initial state renders the count-up start, not the final value.
		expect(container.textContent).toBe('0');
	});

	it('preserves the K suffix and decimal precision while animating', async () => {
		render(<AnimatedNumber value="1.5K" />);

		expect(await screen.findByText('1.5K')).toBeInTheDocument();
	});

	it('preserves the M suffix and decimal precision while animating', async () => {
		render(<AnimatedNumber value="2.0M" />);

		expect(await screen.findByText('2.0M')).toBeInTheDocument();
	});

	it('preserves the % suffix while animating', async () => {
		render(<AnimatedNumber value="80%" />);

		expect(await screen.findByText('80%')).toBeInTheDocument();
	});

	it('renders duration strings immediately without animation', () => {
		render(<AnimatedNumber value="12h 34m" />);

		// Strings that aren't pure numerics display the final value on the first render.
		expect(screen.getByText('12h 34m')).toBeInTheDocument();
	});

	it('renders peak hour strings immediately without animation', () => {
		render(<AnimatedNumber value="9 AM" />);

		expect(screen.getByText('9 AM')).toBeInTheDocument();
	});

	it('renders agent name strings immediately without animation', () => {
		render(<AnimatedNumber value="claude-code" />);

		expect(screen.getByText('claude-code')).toBeInTheDocument();
	});

	it('renders the N/A placeholder immediately without animation', () => {
		render(<AnimatedNumber value="N/A" />);

		expect(screen.getByText('N/A')).toBeInTheDocument();
	});

	it('renders zero values without breaking', () => {
		const { container } = render(<AnimatedNumber value="0" />);

		// 0 → 0 animation displays 0 throughout, including initial state.
		expect(container.textContent).toBe('0');
	});
});

describe('BouncingDots', () => {
	it('renders three dot spans inside the bounce-dots container', () => {
		const { container } = render(<BouncingDots />);

		const root = container.querySelector('.bounce-dots');
		expect(root).not.toBeNull();
		expect(root?.querySelectorAll('span').length).toBe(3);
	});

	it('has a status role with a default loading label for screen readers', () => {
		render(<BouncingDots />);

		const root = screen.getByTestId('bouncing-dots');
		expect(root).toHaveAttribute('role', 'status');
		expect(root).toHaveAttribute('aria-label', 'Loading');
	});

	it('accepts a custom aria-label', () => {
		render(<BouncingDots label="Agent thinking" />);

		expect(screen.getByTestId('bouncing-dots')).toHaveAttribute('aria-label', 'Agent thinking');
	});

	it('applies the color prop as inline color so dots inherit currentColor', () => {
		render(<BouncingDots color="#ff79c6" />);

		const root = screen.getByTestId('bouncing-dots');
		expect(root).toHaveStyle({ color: '#ff79c6' });
	});

	it('omits inline color when no color prop is provided', () => {
		render(<BouncingDots />);

		const root = screen.getByTestId('bouncing-dots');
		// Without a color prop, the element falls through to currentColor from CSS.
		expect(root.getAttribute('style')).toBeFalsy();
	});
});

// JSDOM normalises CSS hex colors into `rgb(...)` form when they round-trip
// through inline `style`, so we compare the normalised form for theme colors.
function hexToRgb(hex: string): string {
	const value = hex.replace('#', '');
	const r = parseInt(value.slice(0, 2), 16);
	const g = parseInt(value.slice(2, 4), 16);
	const b = parseInt(value.slice(4, 6), 16);
	return `rgb(${r}, ${g}, ${b})`;
}

describe('ContextUsageBar', () => {
	it('renders the percentage rounded to a whole number', () => {
		render(<ContextUsageBar percentage={42.7} theme={theme} />);

		expect(screen.getByText('43%')).toBeInTheDocument();
	});

	it('caps values above 100 at 100% so the bar never overflows', () => {
		render(<ContextUsageBar percentage={150} theme={theme} />);

		expect(screen.getByText('100%')).toBeInTheDocument();
		const bar = screen.getByRole('progressbar');
		expect(bar.getAttribute('aria-valuenow')).toBe('100');
	});

	it('uses the success color for usage below the warning threshold', () => {
		render(<ContextUsageBar percentage={40} theme={theme} />);

		const bar = screen.getByRole('progressbar');
		const fill = bar.firstElementChild as HTMLElement;
		expect(fill.style.backgroundColor).toBe(hexToRgb(theme.colors.success));
		// No critical glow under the warning threshold.
		expect(fill.style.boxShadow).toBe('');
	});

	it('uses the warning color in the 70-89% band', () => {
		render(<ContextUsageBar percentage={75} theme={theme} />);

		const bar = screen.getByRole('progressbar');
		const fill = bar.firstElementChild as HTMLElement;
		expect(fill.style.backgroundColor).toBe(hexToRgb(theme.colors.warning));
	});

	it('uses the error color and adds a glow at or above 90%', () => {
		render(<ContextUsageBar percentage={92} theme={theme} />);

		const bar = screen.getByRole('progressbar');
		const fill = bar.firstElementChild as HTMLElement;
		expect(fill.style.backgroundColor).toBe(hexToRgb(theme.colors.error));
		expect(fill.style.boxShadow).not.toBe('');
	});
});

const buildSession = (overrides: Partial<Session>): Session =>
	({
		id: 'sess-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		contextUsage: 0,
		...overrides,
	}) as Session;

describe('TokenCostBadge', () => {
	it('aggregates currentCycleTokens across busy sessions only', () => {
		const sessions = [
			buildSession({ id: 'a', state: 'busy', currentCycleTokens: 1500, name: 'Alpha' }),
			buildSession({ id: 'b', state: 'busy', currentCycleTokens: 2500, name: 'Beta' }),
			// Idle session is ignored even if it reports a token count.
			buildSession({ id: 'c', state: 'idle', currentCycleTokens: 9999, name: 'Gamma' }),
		];

		render(<TokenCostBadge sessions={sessions} theme={theme} />);

		// 4000 total → "4.0K"
		expect(screen.getByText('4.0K')).toBeInTheDocument();
		expect(screen.getByText(/Alpha/)).toBeInTheDocument();
		expect(screen.getByText(/Beta/)).toBeInTheDocument();
		expect(screen.queryByText(/Gamma/)).not.toBeInTheDocument();
	});

	it('shows $0.00 when there are no busy sessions', () => {
		render(<TokenCostBadge sessions={[]} theme={theme} />);

		expect(screen.getByTestId('token-cost-estimate').textContent).toBe('$0.00');
	});

	it('omits the breakdown when no busy session reports tokens', () => {
		const sessions = [buildSession({ state: 'busy', currentCycleTokens: 0 })];
		render(<TokenCostBadge sessions={sessions} theme={theme} />);

		expect(screen.queryByTestId('token-cost-breakdown')).not.toBeInTheDocument();
	});
});

describe('RealtimeMetricsCard', () => {
	it('uses the highest contextUsage across active sessions for the bar', () => {
		const sessions = [
			buildSession({ id: '1', state: 'idle', contextUsage: 45 }),
			buildSession({ id: '2', state: 'busy', contextUsage: 88 }),
			// Error sessions are excluded from "active" so this 99 must NOT win.
			buildSession({ id: '3', state: 'error', contextUsage: 99 }),
		];

		render(<RealtimeMetricsCard sessions={sessions} theme={theme} />);

		expect(screen.getByText('88%')).toBeInTheDocument();
	});

	it('shows the active agent count with correct singular/plural label', () => {
		const single = [buildSession({ state: 'idle', contextUsage: 10 })];
		const { unmount } = render(<RealtimeMetricsCard sessions={single} theme={theme} />);
		expect(screen.getByText('1 active agent')).toBeInTheDocument();
		unmount();

		const many = [
			buildSession({ id: 'a', state: 'idle' }),
			buildSession({ id: 'b', state: 'busy' }),
		];
		render(<RealtimeMetricsCard sessions={many} theme={theme} />);
		expect(screen.getByText('2 active agents')).toBeInTheDocument();
	});

	it('renders the thinking indicator only when a busy session has thinkingStartTime', () => {
		const now = Date.now();
		const sessions = [
			buildSession({ state: 'busy', thinkingStartTime: now - 5500, contextUsage: 30 }),
		];

		render(<RealtimeMetricsCard sessions={sessions} theme={theme} />);

		const indicator = screen.getByTestId('realtime-thinking-elapsed');
		// 5500ms → 5s elapsed
		expect(indicator.textContent).toContain('5s');
	});

	it('hides the thinking indicator when no session is actively thinking', () => {
		const sessions = [buildSession({ state: 'idle', contextUsage: 20 })];

		render(<RealtimeMetricsCard sessions={sessions} theme={theme} />);

		expect(screen.queryByTestId('realtime-thinking-elapsed')).not.toBeInTheDocument();
	});

	it('applies the animation delay as inline style for staggered entrance', () => {
		render(<RealtimeMetricsCard sessions={[]} theme={theme} animationDelay={320} />);

		const card = screen.getByTestId('realtime-metrics-card');
		expect(card.style.animationDelay).toBe('320ms');
		expect(card.className).toContain('card-enter');
	});
});
