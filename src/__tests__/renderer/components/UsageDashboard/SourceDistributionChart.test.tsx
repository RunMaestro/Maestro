/**
 * Tests for SourceDistributionChart ("Query Source")
 *
 * Verifies:
 * - Queries and Time read the real per-source split (DelegationTotals), not
 *   the total duration divided by query count
 * - Cue is drawn only when the feature is on, from the same split
 * - Without the split, Queries falls back to the aggregation and Time is not offered
 * - Tokens mode reads the token series, shows its error, and labels the center
 * - Stable title, metricModeNoun aria/center caption, persisted mode
 * - Cue retention caption
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { DelegationTotals } from '../../../../shared/delegation';
import { THEMES } from '../../../../shared/themes';
import { COLORBLIND_BINARY_PALETTE } from '../../../../renderer/constants/colorblindPalettes';

const { mockTokenSeries } = vi.hoisted(() => ({
	mockTokenSeries: {
		value: {
			series: null as null | { bySource: { user: number; auto: number } },
			loading: false,
			error: null as string | null,
		},
	},
}));

vi.mock('../../../../renderer/components/UsageDashboard/TokenSeriesContext', () => ({
	useTokenSeries: () => mockTokenSeries.value,
}));

const theme = THEMES['dracula'];

const data = {
	totalQueries: 50,
	totalDuration: 3_600_000,
	bySource: { user: 40, auto: 10 },
} as StatsAggregation;

// Ten Auto Run turns that ran far longer than forty interactive ones.
const delegation: DelegationTotals = {
	interactive: { count: 40, durationMs: 600_000 },
	autoRun: { count: 10, durationMs: 1_800_000 },
	cue: { count: 5, durationMs: 600_000 },
};

function legendText(): string[] {
	const legend = screen.getByRole('list', { name: /chart legend/i });
	return within(legend)
		.getAllByRole('listitem')
		.map((item) => item.getAttribute('aria-label') ?? '');
}

beforeEach(() => {
	localStorage.clear();
	mockTokenSeries.value = { series: null, loading: false, error: null };
});

describe('SourceDistributionChart', () => {
	it('titles itself Query Source whatever the slices are', () => {
		const { rerender } = render(<SourceDistributionChart data={data} theme={theme} />);
		expect(screen.getByRole('heading', { name: 'Query Source' })).toBeInTheDocument();
		rerender(
			<SourceDistributionChart data={data} theme={theme} delegation={delegation} includeCue />
		);
		expect(screen.getByRole('heading', { name: 'Query Source' })).toBeInTheDocument();
	});

	it('counts queries per source from the delegation split, with Cue when enabled', () => {
		render(
			<SourceDistributionChart data={data} theme={theme} delegation={delegation} includeCue />
		);
		expect(legendText()).toEqual(['Interactive: 72.7%, 40', 'Auto Run: 18.2%, 10', 'Cue: 9.1%, 5']);
		const svg = screen.getByRole('img');
		expect(svg.getAttribute('aria-label')).toContain('Query source');
	});

	it('uses each source real recorded time in Time mode', () => {
		render(
			<SourceDistributionChart data={data} theme={theme} delegation={delegation} includeCue />
		);
		fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
		// 600,000 + 1,800,000 + 600,000 ms. Splitting the total by query count would
		// have given Interactive 80% of the time.
		expect(legendText()).toEqual([
			'Interactive: 20.0%, 10m 0s',
			'Auto Run: 60.0%, 30m 0s',
			'Cue: 20.0%, 10m 0s',
		]);
		expect(screen.getByText('time')).toBeInTheDocument();
	});

	it('draws no Cue slice when the Cue feature is off', () => {
		render(<SourceDistributionChart data={data} theme={theme} delegation={delegation} />);
		expect(legendText().some((label) => label.startsWith('Cue'))).toBe(false);
	});

	it('falls back to the aggregation counts and drops Time when the split failed to load', () => {
		render(<SourceDistributionChart data={data} theme={theme} delegation={null} includeCue />);
		expect(legendText()).toEqual(['Interactive: 80.0%, 40', 'Auto Run: 20.0%, 10']);
		expect(screen.queryByRole('button', { name: /show total duration/i })).not.toBeInTheDocument();
	});

	it('ignores a remembered Time mode while Time is not offered', () => {
		localStorage.setItem('usageDashboard.querySource.metric', 'duration');
		render(<SourceDistributionChart data={data} theme={theme} delegation={null} />);
		expect(screen.getByRole('button', { name: /show query count/i })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('remembers the chosen mode across mounts', () => {
		const { unmount } = render(
			<SourceDistributionChart data={data} theme={theme} delegation={delegation} />
		);
		fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
		unmount();
		render(<SourceDistributionChart data={data} theme={theme} delegation={delegation} />);
		expect(screen.getByRole('button', { name: /show total duration/i })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('labels the center and the figure with the active measure', () => {
		render(<SourceDistributionChart data={data} theme={theme} delegation={delegation} />);
		expect(screen.getByText('queries')).toBeInTheDocument();
		expect(screen.getByRole('figure').getAttribute('aria-label')).toContain('queries by source');

		mockTokenSeries.value = {
			series: { bySource: { user: 3_000, auto: 1_000 } },
			loading: false,
			error: null,
		};
		fireEvent.click(screen.getByRole('button', { name: /show token usage/i }));
		expect(screen.getByRole('figure').getAttribute('aria-label')).toContain('tokens by source');
		expect(screen.getByText('4.0K')).toBeInTheDocument();
		expect(screen.getByText('tokens')).toBeInTheDocument();
	});

	it('adds Cue tokens to the Cue slice in Tokens mode', () => {
		mockTokenSeries.value = {
			series: { bySource: { user: 3_000, auto: 1_000 } },
			loading: false,
			error: null,
		};
		localStorage.setItem('usageDashboard.querySource.metric', 'tokens');
		render(
			<SourceDistributionChart
				data={data}
				theme={theme}
				delegation={delegation}
				includeCue
				cueTokens={1_000}
			/>
		);
		expect(legendText()).toEqual([
			'Interactive: 60.0%, 3.0K',
			'Auto Run: 20.0%, 1.0K',
			'Cue: 20.0%, 1.0K',
		]);
	});

	it('shows the token series error instead of an empty donut', () => {
		mockTokenSeries.value = { series: null, loading: false, error: 'transcripts unreadable' };
		localStorage.setItem('usageDashboard.querySource.metric', 'tokens');
		render(<SourceDistributionChart data={data} theme={theme} delegation={delegation} />);
		expect(screen.getByTestId('source-token-error')).toHaveTextContent(
			'Could not load token usage: transcripts unreadable'
		);
		expect(screen.queryByText('No queries in this range')).not.toBeInTheDocument();
	});

	it('shows the shared empty state when nothing ran in range', () => {
		render(
			<SourceDistributionChart
				data={{ ...data, bySource: { user: 0, auto: 0 } } as StatsAggregation}
				theme={theme}
			/>
		);
		expect(screen.getByText('No queries in this range')).toBeInTheDocument();
	});

	it('uses the delegation colors, colorblind palette included', () => {
		render(
			<SourceDistributionChart data={data} theme={theme} delegation={delegation} colorBlindMode />
		);
		expect(screen.getByTestId('donut-slice-interactive')).toHaveAttribute(
			'fill',
			COLORBLIND_BINARY_PALETTE.primary
		);
		expect(screen.getByTestId('donut-slice-auto')).toHaveAttribute(
			'fill',
			COLORBLIND_BINARY_PALETTE.secondary
		);
	});

	it('notes Cue retention only when the Cue slice is drawn and the range outruns it', () => {
		const { rerender } = render(
			<SourceDistributionChart
				data={data}
				theme={theme}
				delegation={delegation}
				cueRetentionDays={14}
			/>
		);
		expect(screen.queryByTestId('source-cue-retention')).not.toBeInTheDocument();

		rerender(
			<SourceDistributionChart
				data={data}
				theme={theme}
				delegation={delegation}
				includeCue
				cueRetentionDays={14}
			/>
		);
		expect(screen.getByTestId('source-cue-retention')).toHaveTextContent(
			'Cue keeps 14 days of run history'
		);
	});
});
