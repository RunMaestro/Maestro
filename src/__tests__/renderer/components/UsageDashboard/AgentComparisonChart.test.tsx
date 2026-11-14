/**
 * Tests for AgentComparisonChart ("Provider Comparison")
 *
 * Verifies:
 * - One row per provider, labeled by display name, sorted by the active mode
 * - Queries / Time / Avg Time modes, remembered across mounts
 * - In-bar share label text color is readable on the bar
 * - Worktree rows come from `byAgentWorktree`, with a single stripe note
 * - The tooltip carries all three measures; there is no separate legend
 * - Empty state wording
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES } from '../../../../shared/themes';
import { readableTextOn } from '../../../../shared/colorContrast';

const theme = THEMES['dracula'];

function makeData(overrides: Partial<StatsAggregation> = {}): StatsAggregation {
	return {
		totalQueries: 140,
		totalDuration: 10_000_000,
		avgDuration: 0,
		byAgent: {
			'claude-code': { count: 100, duration: 2_000_000 },
			codex: { count: 30, duration: 6_000_000 },
			opencode: { count: 10, duration: 2_000_000 },
		},
		byAgentWorktree: {},
		...overrides,
	} as StatsAggregation;
}

function rows(): HTMLElement[] {
	const list = screen.getByRole('list', { name: /provider usage data/i });
	return within(list).getAllByRole('listitem');
}

function labels(): string[] {
	return screen.getAllByTestId('bar-chart-label').map((el) => el.textContent ?? '');
}

beforeEach(() => {
	localStorage.clear();
});

describe('AgentComparisonChart', () => {
	it('renders the title, the mode toggle, and one row per provider', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);

		expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /show query count/i })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(rows()).toHaveLength(3);
	});

	it('labels providers by display name and sorts by query count by default', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		expect(labels()).toEqual(['Claude Code', 'Codex', 'OpenCode']);
		expect(screen.getAllByTestId('comparison-value')[0]).toHaveTextContent('100 queries');
	});

	it('re-sorts by total time in Time mode', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
		expect(labels()).toEqual(['Codex', 'Claude Code', 'OpenCode']);
		expect(screen.getAllByTestId('comparison-value')[0]).toHaveTextContent('1h 40m');
	});

	it('plots average time per query in Avg Time mode, without share labels', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		fireEvent.click(screen.getByRole('button', { name: /show average time per query/i }));
		// codex 200s, opencode 200s, claude-code 20s per query
		expect(labels()[2]).toBe('Claude Code');
		expect(screen.getAllByTestId('comparison-value')[2]).toHaveTextContent('20s avg');
		expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
	});

	it('remembers the chosen mode across mounts', () => {
		const { unmount } = render(<AgentComparisonChart data={makeData()} theme={theme} />);
		fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
		unmount();

		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		expect(screen.getByRole('button', { name: /show total duration/i })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('shows the share of the column on each bar', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		// 100 of 140 queries
		expect(screen.getByText('71.4%')).toBeInTheDocument();
	});

	it('colors the in-bar share label for contrast against the bar', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		const bar = screen.getAllByTestId('comparison-bar')[0];
		const label = within(bar).getByText('71.4%');
		const expected = readableTextOn('#ffffff', [theme.colors.accent]);
		const probe = document.createElement('span');
		probe.style.color = expected;
		expect(label.style.color).toBe(probe.style.color);
	});

	it('gives each row an accessible summary of all three measures', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		expect(rows()[0]).toHaveAttribute(
			'aria-label',
			'Claude Code: 100 queries, 33m 20s total, 20s average'
		);
	});

	it('shows all three measures in the hover tooltip and no separate legend', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		expect(screen.queryByRole('list', { name: /chart legend/i })).not.toBeInTheDocument();

		fireEvent.mouseEnter(rows()[1], { clientX: 10, clientY: 10 });
		const tooltip = screen.getByTestId('provider-comparison-tooltip');
		expect(tooltip).toHaveTextContent('30 queries');
		expect(tooltip).toHaveTextContent('1h 40m total');
		expect(tooltip).toHaveTextContent('3m 20s per query');

		fireEvent.mouseLeave(rows()[1]);
		expect(screen.queryByTestId('provider-comparison-tooltip')).not.toBeInTheDocument();
	});

	it('splits worktree queries into a striped row and explains the stripes once', () => {
		render(
			<AgentComparisonChart
				data={makeData({
					byAgentWorktree: {
						'claude-code': {
							worktree: { count: 40, duration: 800_000 },
							parent: { count: 60, duration: 1_200_000 },
						},
					},
				})}
				theme={theme}
			/>
		);

		expect(labels()).toContain('Claude Code (Worktree)');
		expect(screen.getByTestId('worktree-legend')).toHaveTextContent(
			'Striped rows are queries from worktree agents'
		);
	});

	it('omits the worktree note when no query ran in a worktree', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		expect(screen.queryByTestId('worktree-legend')).not.toBeInTheDocument();
	});

	it('shows the shared empty state when the range has no queries', () => {
		render(<AgentComparisonChart data={makeData({ byAgent: {} })} theme={theme} />);
		expect(screen.getByText('No queries in this range')).toBeInTheDocument();
	});

	it('gives the top row a full-width bar', () => {
		render(<AgentComparisonChart data={makeData()} theme={theme} />);
		expect(screen.getAllByTestId('comparison-bar')[0]).toHaveStyle({ width: '100%' });
	});
});
