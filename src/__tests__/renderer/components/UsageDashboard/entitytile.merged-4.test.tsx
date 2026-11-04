// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/UsageDashboard/EntityTile.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/DurationTrendsChart.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/useQuotaRefresh.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	render as s1_render,
	screen as s1_screen,
	fireEvent as s1_fireEvent,
} from '@testing-library/react';
import { EntityTile } from '../../../../renderer/components/UsageDashboard/EntityTile';
import { mockTheme } from '../../../helpers/mockTheme';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
} from '@testing-library/react';
import React from 'react';
import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES } from '../../../../shared/themes';
import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode, useEffect, useRef } from 'react';
import { useQuotaRefresh } from '../../../../renderer/components/UsageDashboard/quota/useQuotaRefresh';
import { useUIStore } from '../../../../renderer/stores/uiStore';
vi.mock('lucide-react', () => ({}));
// Source: src/__tests__/renderer/components/UsageDashboard/EntityTile.test.tsx
describe('', () => {
	const baseProps = {
		theme: mockTheme,
		testId: 'tile',
		title: 'Alpha',
		stats: [{ label: 'Queries', value: '7', testId: 'tile-queries' }],
		animationIndex: 0,
		ariaLabel: 'Alpha, 7 queries',
	};
	describe('EntityTile', () => {
		it('renders the title, stats, and accessible label', () => {
			s1_render(<EntityTile {...baseProps} />);
			const tile = s1_screen.getByTestId('tile');
			expect(tile).toHaveAttribute('aria-label', 'Alpha, 7 queries');
			expect(s1_screen.getByText('Alpha')).toBeInTheDocument();
			expect(s1_screen.getByTestId('tile-queries')).toHaveTextContent('7');
			expect(s1_screen.getByText('Queries')).toBeInTheDocument();
		});
		it('stays a plain group until a click handler is supplied', () => {
			s1_render(<EntityTile {...baseProps} />);
			const tile = s1_screen.getByTestId('tile');
			expect(tile).toHaveAttribute('role', 'group');
			expect(tile).not.toHaveAttribute('tabindex');
			expect(tile.dataset.clickable).toBeUndefined();
		});
		it('becomes a focusable button and fires on click, Enter, and Space', () => {
			const onClick = vi.fn();
			s1_render(<EntityTile {...baseProps} onClick={onClick} />);
			const tile = s1_screen.getByTestId('tile');
			expect(tile).toHaveAttribute('role', 'button');
			expect(tile).toHaveAttribute('tabindex', '0');
			s1_fireEvent.click(tile);
			s1_fireEvent.keyDown(tile, { key: 'Enter' });
			s1_fireEvent.keyDown(tile, { key: ' ' });
			expect(onClick).toHaveBeenCalledTimes(3);
			// A key the tile does not own must not activate it.
			s1_fireEvent.keyDown(tile, { key: 'a' });
			expect(onClick).toHaveBeenCalledTimes(3);
		});
		describe('border states', () => {
			it('uses a plain border by default and dashes when asked', () => {
				const { rerender } = s1_render(<EntityTile {...baseProps} />);
				expect(s1_screen.getByTestId('tile').style.border).toContain('solid');
				rerender(<EntityTile {...baseProps} isDashed />);
				expect(s1_screen.getByTestId('tile').style.border).toContain('dashed');
			});
			it('promotes to a thick accent border when selected, overriding the dash', () => {
				s1_render(<EntityTile {...baseProps} isDashed isSelected />);
				const tile = s1_screen.getByTestId('tile');
				expect(tile.style.border).toContain('2px');
				expect(tile.style.border).not.toContain('dashed');
				expect(tile.dataset.selected).toBe('true');
			});
			it('promotes on hover only while clickable, and never outranks selection', () => {
				const { rerender } = s1_render(<EntityTile {...baseProps} isDashed onClick={vi.fn()} />);
				const tile = s1_screen.getByTestId('tile');
				s1_fireEvent.mouseEnter(tile);
				expect(tile.style.border).toContain('1px');
				expect(tile.style.border).not.toContain('dashed');
				s1_fireEvent.mouseLeave(tile);
				expect(tile.style.border).toContain('dashed');
				rerender(<EntityTile {...baseProps} isDashed isSelected onClick={vi.fn()} />);
				s1_fireEvent.mouseEnter(s1_screen.getByTestId('tile'));
				expect(s1_screen.getByTestId('tile').style.border).toContain('2px');
			});
		});
		describe('status dot', () => {
			it('is omitted when no color is given', () => {
				s1_render(<EntityTile {...baseProps} />);
				expect(s1_screen.queryByTestId('tile-status-dot')).toBeNull();
			});
			it('animates only when explicitly pulsing', () => {
				const { rerender } = s1_render(<EntityTile {...baseProps} statusColor="#00ff00" />);
				expect(s1_screen.getByTestId('tile-status-dot').style.animation).toBe('');
				rerender(<EntityTile {...baseProps} statusColor="#00ff00" statusPulsing />);
				expect(s1_screen.getByTestId('tile-status-dot').style.animation).toContain('status-pulse');
			});
		});
		it('renders badges and the corner age, highlighting the age on request', () => {
			const { rerender } = s1_render(
				<EntityTile
					{...baseProps}
					badges={[{ label: 'WT', testId: 'tile-wt' }]}
					age="3mo"
					ageTitle="Created yesterday"
				/>
			);
			expect(s1_screen.getByTestId('tile-wt')).toHaveTextContent('WT');
			expect(s1_screen.getByTestId('tile-age')).toHaveTextContent('3mo');
			expect(s1_screen.getByTestId('tile-age')).toHaveAttribute('title', 'Created yesterday');
			expect(s1_screen.getByTestId('tile-age').dataset.highlighted).toBeUndefined();
			rerender(<EntityTile {...baseProps} age="3mo" ageHighlighted />);
			expect(s1_screen.getByTestId('tile-age').dataset.highlighted).toBe('true');
		});
		it('renders the subtitle only when provided', () => {
			const { rerender } = s1_render(<EntityTile {...baseProps} subtitleTestId="tile-branch" />);
			expect(s1_screen.queryByTestId('tile-branch')).toBeNull();
			rerender(<EntityTile {...baseProps} subtitle="feat/thing" subtitleTestId="tile-branch" />);
			expect(s1_screen.getByTestId('tile-branch')).toHaveTextContent('feat/thing');
		});
		it('flags the highlighted stat so the sort key is visible on every tile', () => {
			s1_render(
				<EntityTile
					{...baseProps}
					stats={[
						{ label: 'Queries', value: '7', testId: 'tile-queries', highlighted: true },
						{ label: 'Tabs', value: '2', testId: 'tile-tabs' },
						{ label: 'Auto %', value: '—', testId: 'tile-auto', muted: true },
					]}
				/>
			);
			expect(s1_screen.getByTestId('tile-queries').dataset.highlighted).toBe('true');
			expect(s1_screen.getByTestId('tile-tabs').dataset.highlighted).toBeUndefined();
			// A muted stat renders dim rather than in the main text color, so an
			// absent value never reads as a real zero.
			expect(s1_screen.getByTestId('tile-auto').style.color).toBe(
				hexToRgb(mockTheme.colors.textDim)
			);
			expect(s1_screen.getByTestId('tile-tabs').style.color).toBe(
				hexToRgb(mockTheme.colors.textMain)
			);
		});
		// A highlighted-but-muted stat must stay dim: accenting an absent value
		// would advertise it as the sort key's winner.
		it('keeps a muted stat dim even when it is the highlighted one', () => {
			s1_render(
				<EntityTile
					{...baseProps}
					stats={[
						{ label: 'Auto %', value: '—', testId: 'tile-auto', highlighted: true, muted: true },
					]}
				/>
			);
			expect(s1_screen.getByTestId('tile-auto').style.color).toBe(
				hexToRgb(mockTheme.colors.textDim)
			);
		});
		it('staggers the enter animation by 60ms per tile', () => {
			s1_render(<EntityTile {...baseProps} animationIndex={3} />);
			const tile = s1_screen.getByTestId('tile');
			expect(tile.style.animationDelay).toBe('180ms');
			expect(tile.className).toContain('card-enter');
		});
		// Both grids can render far more tiles than the stagger was designed for.
		// Uncapped, the 100th agent card would sit blank for six seconds and a
		// full tab list for far longer, so the ramp plateaus instead.
		it('caps the stagger so a large grid does not leave late tiles blank', () => {
			const { rerender } = s1_render(<EntityTile {...baseProps} animationIndex={12} />);
			expect(s1_screen.getByTestId('tile').style.animationDelay).toBe('720ms');
			rerender(<EntityTile {...baseProps} animationIndex={375} />);
			expect(s1_screen.getByTestId('tile').style.animationDelay).toBe('720ms');
		});
		describe('layout bands', () => {
			// The name is what the tile is for. Badges and the sparkline used to
			// flank it and squeeze it, so "Maestro Docs" truncated to "Ma..." on a
			// tile with room to spare; they now sit in their own band below.
			it('leaves the title row to the title, the status dot, and the age', () => {
				s1_render(
					<EntityTile
						{...baseProps}
						statusColor="#00ff00"
						age="3mo"
						badges={[{ label: 'WT', testId: 'tile-wt' }]}
						sparkline={[1, 2, 3]}
					/>
				);
				const titleRow = s1_screen.getByText('Alpha').parentElement!;
				expect(titleRow).toContainElement(s1_screen.getByTestId('tile-status-dot'));
				expect(titleRow).toContainElement(s1_screen.getByTestId('tile-age'));
				expect(titleRow).not.toContainElement(s1_screen.getByTestId('tile-wt'));
				expect(titleRow.querySelector('[data-testid="sparkline"]')).toBeNull();
			});
			it('puts the sparkline on the badge row, above the stats', () => {
				s1_render(
					<EntityTile
						{...baseProps}
						badges={[{ label: 'WT', testId: 'tile-wt' }]}
						sparkline={[1, 2, 3]}
					/>
				);
				const metaRow = s1_screen.getByTestId('tile-wt').parentElement!;
				expect(metaRow.querySelector('[data-testid="sparkline"]')).not.toBeNull();
				// ...and the stats own the full width underneath rather than sharing
				// the row with the graph.
				const statRow = s1_screen.getByText('Queries').parentElement!.parentElement!;
				expect(statRow).not.toContainElement(metaRow);
				expect(statRow.querySelector('[data-testid="sparkline"]')).toBeNull();
			});
			it('skips the badge row entirely when there is neither a badge nor a graph', () => {
				const { container } = s1_render(<EntityTile {...baseProps} />);
				// Title row + stats row inside the bottom stack: no empty band in between.
				expect(container.querySelector('[data-testid="sparkline"]')).toBeNull();
				const statRow = s1_screen.getByText('Queries').parentElement!.parentElement!;
				expect(statRow.parentElement!.children).toHaveLength(1);
			});
		});
		describe('size variants', () => {
			const LONG_STATS = [
				{ label: 'Queries', value: '848' },
				{ label: 'Time', value: '142h 5m' },
				{ label: 'Tokens', value: '220.7M' },
				{ label: 'Cost', value: '$187.18' },
			];
			const renderLarge = () =>
				s1_render(<EntityTile {...baseProps} size="lg" stats={LONG_STATS} />);
			it('defaults to the standard size', () => {
				s1_render(<EntityTile {...baseProps} />);
				expect(s1_screen.getByTestId('tile')).toHaveAttribute('data-size', 'default');
			});
			it('marks a large tile so the group grid is distinguishable', () => {
				s1_render(<EntityTile {...baseProps} size="lg" />);
				expect(s1_screen.getByTestId('tile')).toHaveAttribute('data-size', 'lg');
			});
			it("lays a large tile's stats out as a grid rather than one flex row", () => {
				// Four stats in a single flex row is what ran a group's tokens and cost
				// together as "79.5M$65.99". The grid wraps instead of overlapping.
				s1_render(
					<EntityTile
						{...baseProps}
						size="lg"
						stats={[
							{ label: 'Queries', value: '848' },
							{ label: 'Time', value: '96h 57m' },
							{ label: 'Tokens', value: '79.5M' },
							{ label: 'Cost', value: '$65.99' },
						]}
					/>
				);
				const statRow = s1_screen.getByText('Queries').parentElement!.parentElement!;
				expect(statRow.className).toContain('grid');
				expect(statRow.className).not.toContain('flex items-end gap-3');
			});
			it('gives large stat columns enough floor width to not clip a value', () => {
				// The column, not the card, is what a stat value has to fit into: a
				// narrower floor clipped "142h 5m" to "142h 5…" inside a roomy tile.
				renderLarge();
				const statRow = s1_screen.getByText('Queries').parentElement!.parentElement!;
				expect(statRow.className).toContain('minmax(104px,1fr)');
			});
			it('gives the default tile a grid too, with a narrower column floor', () => {
				// Three short stats in a flex row ran their labels together as
				// "QUERIESTABS AUTO %". Equal columns keep each stat in its own lane;
				// the floor is lower than the group tile's because the values are
				// counts rather than "142h 5m".
				s1_render(
					<EntityTile
						{...baseProps}
						stats={[
							{ label: 'Queries', value: '5' },
							{ label: 'Tabs', value: '2' },
							{ label: 'Auto %', value: '7%' },
						]}
					/>
				);
				const statRow = s1_screen.getByText('Queries').parentElement!.parentElement!;
				expect(statRow.className).toContain('grid');
				expect(statRow.className).toContain('minmax(72px,1fr)');
			});
		});
	});
	/** jsdom reports colors as `rgb(r, g, b)`; convert a theme hex for comparison. */
	function hexToRgb(hex: string): string {
		const v = hex.replace('#', '');
		const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
		return `rgb(${r}, ${g}, ${b})`;
	}
});
// Source: src/__tests__/renderer/components/UsageDashboard/DurationTrendsChart.test.tsx
describe('', () => {
	// Test theme
	const theme = THEMES['dracula'];
	// Sample data for testing
	const mockData: StatsAggregation = {
		totalQueries: 50,
		totalDuration: 3600000, // 1 hour
		avgDuration: 72000, // 72 seconds
		byAgent: {
			'claude-code': { count: 30, duration: 2000000 },
			codex: { count: 20, duration: 1600000 },
		},
		bySource: { user: 35, auto: 15 },
		byDay: [
			{ date: '2024-12-20', count: 5, duration: 300000 }, // avg: 60s
			{ date: '2024-12-21', count: 10, duration: 600000 }, // avg: 60s
			{ date: '2024-12-22', count: 3, duration: 180000 }, // avg: 60s
			{ date: '2024-12-23', count: 8, duration: 480000 }, // avg: 60s
			{ date: '2024-12-24', count: 12, duration: 960000 }, // avg: 80s
			{ date: '2024-12-25', count: 4, duration: 120000 }, // avg: 30s
			{ date: '2024-12-26', count: 7, duration: 420000 }, // avg: 60s
			{ date: '2024-12-27', count: 5, duration: 300000 }, // avg: 60s
		],
	};
	// Data with varying durations to test intensity
	const varyingData: StatsAggregation = {
		totalQueries: 100,
		totalDuration: 7200000,
		avgDuration: 72000,
		byAgent: {
			'claude-code': { count: 100, duration: 7200000 },
		},
		bySource: { user: 80, auto: 20 },
		byDay: [
			{ date: '2024-12-20', count: 10, duration: 300000 }, // 30s avg
			{ date: '2024-12-21', count: 10, duration: 600000 }, // 60s avg
			{ date: '2024-12-22', count: 10, duration: 1200000 }, // 120s avg
			{ date: '2024-12-23', count: 10, duration: 1800000 }, // 180s avg
			{ date: '2024-12-24', count: 10, duration: 600000 }, // 60s avg
			{ date: '2024-12-25', count: 10, duration: 900000 }, // 90s avg
			{ date: '2024-12-26', count: 10, duration: 300000 }, // 30s avg
		],
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
	// Data with zero counts (should handle division by zero)
	const zeroCountData: StatsAggregation = {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [
			{ date: '2024-12-20', count: 0, duration: 0 },
			{ date: '2024-12-21', count: 0, duration: 0 },
			{ date: '2024-12-22', count: 0, duration: 0 },
		],
	};
	// Single data point
	const singlePointData: StatsAggregation = {
		totalQueries: 5,
		totalDuration: 300000,
		avgDuration: 60000,
		byAgent: {
			'claude-code': { count: 5, duration: 300000 },
		},
		bySource: { user: 5, auto: 0 },
		byDay: [{ date: '2024-12-27', count: 5, duration: 300000 }],
	};
	describe('DurationTrendsChart', () => {
		describe('Rendering', () => {
			it('renders the component with title', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
			it('renders smoothing toggle', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('Smoothing:')).toBeInTheDocument();
			});
			it('renders SVG chart element', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});
			it('renders data points as circles', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				expect(circles.length).toBe(mockData.byDay.length);
			});
			it('renders line path', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const paths = container.querySelectorAll('path');
				// Should have area path and line path
				expect(paths.length).toBeGreaterThanOrEqual(2);
			});
			it('renders Y-axis label', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('Duration')).toBeInTheDocument();
			});
			it('renders legend', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('Avg Duration')).toBeInTheDocument();
			});
		});
		describe('Empty State', () => {
			it('renders empty state message when no data', () => {
				s2_render(<DurationTrendsChart data={emptyData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('No duration data available')).toBeInTheDocument();
			});
			it('does not render SVG when no data', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={emptyData} timeRange="week" theme={theme} />
				);
				const svg = container.querySelector('svg');
				expect(svg).not.toBeInTheDocument();
			});
		});
		describe('Smoothing Toggle', () => {
			it('defaults to smoothing off', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				// Legend should show "Avg Duration" not "Moving Average"
				expect(s2_screen.getByText('Avg Duration')).toBeInTheDocument();
				expect(s2_screen.queryByText('Moving Average')).not.toBeInTheDocument();
			});
			it('toggles smoothing on when clicked', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				const toggleButton = s2_screen.getByRole('button', { name: /smoothing/i });
				s2_fireEvent.click(toggleButton);
				// Legend should now show "Moving Average"
				expect(s2_screen.getByText('Moving Average')).toBeInTheDocument();
			});
			it('shows window size when smoothing is on', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				const toggleButton = s2_screen.getByRole('button', { name: /smoothing/i });
				s2_fireEvent.click(toggleButton);
				expect(s2_screen.getByText(/Window: \d+ periods/)).toBeInTheDocument();
			});
			it('toggles smoothing off when clicked again', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				const toggleButton = s2_screen.getByRole('button', { name: /smoothing/i });
				// Turn on
				s2_fireEvent.click(toggleButton);
				expect(s2_screen.getByText('Moving Average')).toBeInTheDocument();
				// Turn off
				s2_fireEvent.click(toggleButton);
				expect(s2_screen.getByText('Avg Duration')).toBeInTheDocument();
			});
		});
		describe('Time Range Handling', () => {
			it('renders for day time range', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="day" theme={theme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
			it('renders for week time range', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
			it('renders for month time range', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="month" theme={theme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
			it('renders for year time range', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="year" theme={theme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
			it('renders for all time range', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="all" theme={theme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
		});
		describe('Theme Support', () => {
			it('applies theme background color', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const wrapper = container.firstChild as HTMLElement;
				expect(wrapper).toHaveStyle({
					backgroundColor: theme.colors.bgMain,
				});
			});
			it('applies theme text colors', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				const title = s2_screen.getByText('Duration Trends');
				expect(title).toHaveStyle({
					color: theme.colors.textMain,
				});
			});
			it('uses theme accent color for line', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				// Find the main line path (has stroke and no fill)
				const paths = container.querySelectorAll('path');
				const linePath = Array.from(paths).find(
					(p) => p.getAttribute('fill') === 'none' && p.getAttribute('stroke')
				);
				expect(linePath).toHaveAttribute('stroke', theme.colors.accent);
			});
			it('works with light theme', () => {
				const lightTheme = THEMES['github-light'];
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={lightTheme} />);
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
			});
			it('applies border color to toggle button', () => {
				s2_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
				const toggleButton = s2_screen.getByRole('button', { name: /smoothing/i });
				expect(toggleButton).toHaveStyle({
					backgroundColor: expect.stringMatching(/^(rgb|#)/),
				});
			});
		});
		describe('Tooltip Functionality', () => {
			it('shows tooltip on data point hover', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				if (circles.length > 0) {
					s2_fireEvent.mouseEnter(circles[0]);
					// Tooltip should appear with date
					// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
					const tooltip = document.body.querySelector('div.fixed.pointer-events-none');
					expect(tooltip).toBeInTheDocument();
				}
			});
			it('hides tooltip on mouse leave', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				if (circles.length > 0) {
					s2_fireEvent.mouseEnter(circles[0]);
					s2_fireEvent.mouseLeave(circles[0]);
					// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
					const tooltip = document.body.querySelector('div.fixed.pointer-events-none');
					expect(tooltip).not.toBeInTheDocument();
				}
			});
			it('tooltip shows query count', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				if (circles.length > 0) {
					s2_fireEvent.mouseEnter(circles[0]);
					expect(s2_screen.getByText('Queries:')).toBeInTheDocument();
				}
			});
			it('tooltip shows avg duration label', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				if (circles.length > 0) {
					s2_fireEvent.mouseEnter(circles[0]);
					expect(s2_screen.getByText('Avg Duration:')).toBeInTheDocument();
				}
			});
		});
		describe('Edge Cases', () => {
			it('handles single data point', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={singlePointData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				expect(circles.length).toBe(1);
			});
			it('handles zero count days gracefully', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={zeroCountData} timeRange="week" theme={theme} />
				);
				// Should render without errors
				expect(s2_screen.getByText('Duration Trends')).toBeInTheDocument();
				// Should have 3 data points even with zero counts
				const circles = container.querySelectorAll('circle');
				expect(circles.length).toBe(3);
			});
			it('handles varying duration data', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={varyingData} timeRange="week" theme={theme} />
				);
				// Should render all data points
				const circles = container.querySelectorAll('circle');
				expect(circles.length).toBe(varyingData.byDay.length);
			});
		});
		describe('Grid and Axes', () => {
			it('renders horizontal grid lines', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const gridLines = container.querySelectorAll('line');
				expect(gridLines.length).toBeGreaterThan(0);
			});
			it('renders Y-axis tick labels', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				// Y-axis should have duration labels (0s, etc.)
				const textElements = container.querySelectorAll('text');
				const hasYLabel = Array.from(textElements).some((el) =>
					el.textContent?.match(/^\d+(s|m|h)$/)
				);
				expect(hasYLabel).toBe(true);
			});
			it('renders X-axis date labels', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				// Should have date labels (day abbreviations for week view)
				const textElements = container.querySelectorAll('text');
				const hasDateLabels = Array.from(textElements).some((el) =>
					el.textContent?.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
				);
				expect(hasDateLabels).toBe(true);
			});
		});
		describe('Area Fill', () => {
			it('renders gradient-filled area under line', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				// Should have a linearGradient defined
				const gradient = container.querySelector('linearGradient');
				expect(gradient).toBeInTheDocument();
				// Should have a path using the gradient
				const paths = container.querySelectorAll('path');
				const areaPath = Array.from(paths).find((p) =>
					p.getAttribute('fill')?.includes('url(#duration-gradient')
				);
				expect(areaPath).toBeInTheDocument();
			});
		});
		describe('Data Point Interaction', () => {
			it('enlarges data point on hover', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				if (circles.length > 0) {
					const initialRadius = circles[0].getAttribute('r');
					s2_fireEvent.mouseEnter(circles[0]);
					const hoveredRadius = circles[0].getAttribute('r');
					expect(parseInt(hoveredRadius || '0')).toBeGreaterThan(parseInt(initialRadius || '0'));
				}
			});
		});
		describe('Smooth Animations', () => {
			it('applies CSS transitions to line path for smooth updates', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const paths = container.querySelectorAll('path');
				// Find the main line path (has stroke but no fill)
				const linePath = Array.from(paths).find(
					(p) => p.getAttribute('stroke') && p.getAttribute('fill') === 'none'
				);
				expect(linePath).toBeInTheDocument();
				const style = (linePath as HTMLElement).style;
				expect(style.transition).toContain('d');
				expect(style.transition).toContain('0.5s');
			});
			it('applies CSS transitions to area path for smooth updates', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const paths = container.querySelectorAll('path');
				// Find the area path (has gradient fill)
				const areaPath = Array.from(paths).find((p) =>
					p.getAttribute('fill')?.includes('url(#duration-gradient')
				);
				expect(areaPath).toBeInTheDocument();
				const style = (areaPath as HTMLElement).style;
				expect(style.transition).toContain('d');
				expect(style.transition).toContain('0.5s');
			});
			it('applies CSS transitions to data points for smooth position updates', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const circles = container.querySelectorAll('circle');
				expect(circles.length).toBeGreaterThan(0);
				const style = (circles[0] as unknown as HTMLElement).style;
				expect(style.transition).toContain('cx');
				expect(style.transition).toContain('cy');
				expect(style.transition).toContain('0.5s');
			});
			it('uses cubic-bezier easing for smooth animation curves', () => {
				const { container } = s2_render(
					<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
				);
				const paths = container.querySelectorAll('path');
				const linePath = Array.from(paths).find(
					(p) => p.getAttribute('stroke') && p.getAttribute('fill') === 'none'
				);
				const style = (linePath as HTMLElement).style;
				expect(style.transition).toContain('cubic-bezier');
			});
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/useQuotaRefresh.test.tsx
describe('', () => {
	describe('useQuotaRefresh', () => {
		afterEach(() => {
			vi.useRealTimers();
			useUIStore.setState({ usageRefreshIntervals: {} });
		});
		it('settles an in-flight refresh after unmount without a late state update', async () => {
			vi.useFakeTimers();
			const doRefresh = vi.fn().mockResolvedValue(undefined);
			const { result, unmount } = renderHook(() =>
				useQuotaRefresh({
					providerId: 'claude-code',
					refreshing: false,
					autoRefresh: false,
					accountCount: 0,
					snapshotCount: 0,
					doRefresh,
				})
			);
			let refreshPromise!: Promise<void>;
			act(() => {
				refreshPromise = result.current.handleRefresh();
			});
			expect(result.current.isBusy).toBe(true);
			await Promise.resolve();
			unmount();
			await vi.advanceTimersByTimeAsync(900);
			await expect(refreshPromise).resolves.toBeUndefined();
			expect(doRefresh).toHaveBeenCalledTimes(1);
		});
		it('recovers visual busy state after a StrictMode effect remount', async () => {
			vi.useFakeTimers();
			const doRefresh = vi.fn().mockResolvedValue(undefined);
			const wrapper = ({ children }: { children: ReactNode }) => (
				<StrictMode>{children}</StrictMode>
			);
			let refreshPromise!: Promise<void>;
			const useAutoStartedQuotaRefresh = () => {
				const refresh = useQuotaRefresh({
					providerId: 'claude-code',
					refreshing: false,
					autoRefresh: false,
					accountCount: 0,
					snapshotCount: 0,
					doRefresh,
				});
				const startedRef = useRef(false);
				useEffect(() => {
					if (startedRef.current) return;
					startedRef.current = true;
					refreshPromise = refresh.handleRefresh();
				}, [refresh]);
				return refresh;
			};
			const { result } = renderHook(() => useAutoStartedQuotaRefresh(), { wrapper });
			expect(result.current.isBusy).toBe(true);
			await Promise.resolve();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(900);
				await refreshPromise;
			});
			expect(result.current.isBusy).toBe(false);
			expect(doRefresh).toHaveBeenCalledTimes(1);
		});
	});
});
