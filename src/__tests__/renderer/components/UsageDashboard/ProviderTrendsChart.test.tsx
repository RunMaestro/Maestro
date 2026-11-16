/**
 * Tests for ProviderTrendsChart
 *
 * Verifies:
 * - One bar slot per day of the aggregation window, idle days included
 * - Long windows are grouped so bars stay drawable
 * - Today is labeled with a date, not a clock time
 * - Providers use display names and the shared count-ranked color order
 * - Token mode error, persisted metric mode, metricModeNoun aria
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ProviderTrendsChart } from '../../../../renderer/components/UsageDashboard/ProviderTrendsChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES } from '../../../../shared/themes';
import { getSeriesColor } from '../../../../renderer/components/UsageDashboard/chartUtils';

const { mockTokenSeries } = vi.hoisted(() => ({
	mockTokenSeries: {
		value: { series: null as unknown, loading: false, error: null as string | null },
	},
}));

vi.mock('../../../../renderer/components/UsageDashboard/TokenSeriesContext', () => ({
	useTokenSeries: () => mockTokenSeries.value,
}));

const theme = THEMES['dracula'];

function makeData(overrides: Partial<StatsAggregation> = {}): StatsAggregation {
	return {
		byAgent: {
			'claude-code': { count: 3, duration: 3_000 },
			codex: { count: 5, duration: 1_000 },
		},
		byAgentByDay: {
			'claude-code': [{ date: '2026-03-02', count: 3, duration: 3_000 }],
			codex: [
				{ date: '2026-03-01', count: 2, duration: 500 },
				{ date: '2026-03-04', count: 3, duration: 500 },
			],
		},
		window: { startYmd: '2026-03-01', endYmd: '2026-03-07' },
		...overrides,
	} as StatsAggregation;
}

beforeEach(() => {
	installLocalStorageMock();
	mockTokenSeries.value = { series: null, loading: false, error: null };
});

describe('ProviderTrendsChart', () => {
	it('draws one slot per day of the window, idle days included', () => {
		render(<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />);
		// Seven days in the window, only three with queries.
		expect(screen.getAllByTestId('provider-trend-bar')).toHaveLength(7);
	});

	it('groups a long window into at most 120 bars', () => {
		render(
			<ProviderTrendsChart
				data={makeData({ window: { startYmd: '2025-03-08', endYmd: '2026-03-07' } })}
				timeRange="year"
				theme={theme}
			/>
		);
		const bars = screen.getAllByTestId('provider-trend-bar');
		expect(bars.length).toBeLessThanOrEqual(120);
		expect(bars.length).toBeGreaterThan(60);
	});

	it('labels the Today bar with its date rather than a clock time', () => {
		render(
			<ProviderTrendsChart
				data={makeData({
					byAgentByDay: { codex: [{ date: '2026-03-07', count: 4, duration: 10 }] },
					byAgent: { codex: { count: 4, duration: 10 } },
					window: { startYmd: '2026-03-07', endYmd: '2026-03-07' },
				})}
				timeRange="day"
				theme={theme}
			/>
		);
		expect(screen.getByText('Mar 7')).toBeInTheDocument();
		expect(screen.queryByText('00:00')).not.toBeInTheDocument();
	});

	it('names providers by display name and colors them by query-count rank', () => {
		const { container } = render(
			<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />
		);
		const legend = screen.getByRole('list', { name: /chart legend/i });
		// codex (5 queries) ranks above claude-code (3).
		expect(legend).toHaveTextContent(/Codex.*Claude Code/);
		const fills = Array.from(container.querySelectorAll('rect[fill]'))
			.map((r) => r.getAttribute('fill'))
			.filter((f) => f !== 'transparent');
		expect(fills).toContain(getSeriesColor(0, theme));
		expect(fills).toContain(getSeriesColor(1, theme));
	});

	it('shows the tooltip with the day and per-provider values on hover', () => {
		render(<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />);
		fireEvent.mouseEnter(screen.getAllByTestId('provider-trend-bar')[0], {
			clientX: 5,
			clientY: 5,
		});
		expect(screen.getByText('Sunday, Mar 1, 2026')).toBeInTheDocument();
		expect(screen.getByText('2 queries')).toBeInTheDocument();
	});

	it('names the active measure in its accessible labels', () => {
		render(<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />);
		expect(screen.getByRole('img').getAttribute('aria-label')).toContain('queries per provider');
		fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
		expect(screen.getByRole('img').getAttribute('aria-label')).toContain('time per provider');
	});

	it('remembers the chosen mode across mounts', () => {
		const { unmount } = render(
			<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />
		);
		fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
		unmount();
		render(<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />);
		expect(screen.getByRole('button', { name: /show total duration/i })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('shows the token series error instead of an empty chart', () => {
		mockTokenSeries.value = { series: null, loading: false, error: 'boom' };
		localStorage.setItem('usageDashboard.providerTrends.metric', 'tokens');
		render(<ProviderTrendsChart data={makeData()} timeRange="week" theme={theme} />);
		expect(screen.getByTestId('provider-trends-token-error')).toHaveTextContent(
			'Could not load token usage: boom'
		);
	});

	it('shows the shared empty state when the window has no queries', () => {
		render(
			<ProviderTrendsChart
				data={makeData({ byAgent: {}, byAgentByDay: {} })}
				timeRange="week"
				theme={theme}
			/>
		);
		expect(screen.getByText('No queries in this range')).toBeInTheDocument();
	});
});
