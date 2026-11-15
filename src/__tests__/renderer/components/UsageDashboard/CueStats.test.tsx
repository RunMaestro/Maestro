/**
 * Tests for CueStats component (Phase 04 - Cue Dashboard)
 *
 * Verifies:
 * - Loading skeleton renders before the IPC resolves
 * - Empty state renders when aggregation has zero occurrences
 * - Populated state renders summary cards, time-series, pipeline table, and
 *   agent chart (the per-subscription table and per-chain list were dropped
 *   because their content was redundant with the pipeline / agent breakdowns).
 * - Coverage warnings stay hidden even when present
 * - 'CueStatsDisabled' IPC error renders the friendly disabled note
 * - A real failure renders an error, never "no Cue activity"
 * - The retention caption, and its warning when the range outruns it
 * - Slowest Runs comes from main's ranked list, sorts, and shows status
 * - Cue engine activity refreshes the tab
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CueStats } from '../../../../renderer/components/UsageDashboard/CueStats';
import { rangeExceedsRetention } from '../../../../renderer/components/UsageDashboard/CueStats/RetentionNote';
import { averageRunMs } from '../../../../renderer/components/UsageDashboard/CueStats/cueStatsUtils';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { THEMES } from '../../../../shared/themes';
import type { CueStatsAggregation, CueStatsTotals } from '../../../../shared/cue-stats-types';

const theme = THEMES['dracula'];

const zeroTotals: CueStatsTotals = {
	occurrences: 0,
	successCount: 0,
	failureCount: 0,
	totalDurationMs: 0,
	timedRunCount: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: null,
};

function makeTotals(overrides: Partial<CueStatsTotals> = {}): CueStatsTotals {
	return { ...zeroTotals, ...overrides };
}

const emptyHourBuckets = Array.from({ length: 24 }, (_, hour) => ({
	hour,
	occurrences: 0,
	successCount: 0,
	failureCount: 0,
}));

const emptyAggregation: CueStatsAggregation = {
	timeRange: 'week',
	windowStartMs: 0,
	windowEndMs: 0,
	totals: zeroTotals,
	durationPercentiles: { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
	slowestRuns: [],
	byPipeline: [],
	byAgent: [],
	bySubscription: [],
	byTriggerType: [],
	triggerTypeOptions: [],
	excludedTriggerTypes: [],
	byHourOfDay: emptyHourBuckets,
	chains: [],
	timeSeries: [],
	bucketSizeMs: 3_600_000,
	coverageWarnings: [],
};

const populatedAggregation: CueStatsAggregation = {
	timeRange: 'week',
	windowStartMs: 1_700_000_000_000,
	windowEndMs: 1_700_604_800_000,
	totals: makeTotals({
		occurrences: 12,
		successCount: 9,
		failureCount: 3,
		totalDurationMs: 600_000, // 10m over 8 completed runs
		timedRunCount: 8,
		totalInputTokens: 5_000,
		totalOutputTokens: 3_000,
		totalCostUsd: 0.42,
	}),
	durationPercentiles: {
		count: 12,
		min: 5_000,
		p50: 40_000,
		p75: 60_000,
		p90: 90_000,
		p95: 120_000,
		p99: 180_000,
		max: 240_000,
	},
	slowestRuns: [
		{
			eventId: 'evt-1',
			subscriptionName: 'sub-watch-files',
			pipelineId: 'pipeline-alpha',
			agentType: 'claude-code',
			status: 'completed',
			startedAtMs: 1_700_000_000_000,
			durationMs: 60_000,
			tokens: 150,
		},
		{
			eventId: 'evt-9',
			subscriptionName: 'sub-timeout',
			pipelineId: null,
			agentType: 'codex',
			status: 'timeout',
			startedAtMs: 1_700_000_100_000,
			durationMs: 45_000,
			tokens: 0,
		},
		{
			eventId: 'evt-3',
			subscriptionName: 'sub-leaf',
			pipelineId: 'pipeline-alpha',
			agentType: 'codex',
			status: 'completed',
			startedAtMs: 1_700_000_090_000,
			durationMs: 15_000,
			tokens: 60,
		},
	],
	byPipeline: [
		{
			key: 'pipeline-alpha',
			label: 'pipeline-alpha',
			totals: makeTotals({
				occurrences: 8,
				successCount: 7,
				failureCount: 1,
				totalDurationMs: 400_000,
				timedRunCount: 5,
				totalInputTokens: 3_000,
				totalOutputTokens: 2_000,
				totalCostUsd: 0.3,
			}),
		},
		{
			key: 'pipeline-beta',
			label: 'pipeline-beta',
			totals: makeTotals({
				occurrences: 4,
				successCount: 2,
				failureCount: 2,
				totalDurationMs: 200_000,
				totalInputTokens: 2_000,
				totalOutputTokens: 1_000,
				totalCostUsd: 0.12,
			}),
		},
	],
	byAgent: [
		{
			key: 'claude-code',
			label: 'claude-code',
			totals: makeTotals({
				occurrences: 9,
				successCount: 8,
				failureCount: 1,
				totalDurationMs: 450_000,
				totalInputTokens: 3_500,
				totalOutputTokens: 2_500,
			}),
		},
		{
			key: 'codex',
			label: 'codex',
			totals: makeTotals({
				occurrences: 3,
				successCount: 1,
				failureCount: 2,
				totalDurationMs: 150_000,
				totalInputTokens: 1_500,
				totalOutputTokens: 500,
			}),
		},
	],
	bySubscription: [
		{
			key: 'sub-watch-files',
			label: 'sub-watch-files',
			totals: makeTotals({
				occurrences: 7,
				successCount: 6,
				failureCount: 1,
				totalDurationMs: 350_000,
				totalInputTokens: 2_500,
				totalOutputTokens: 1_500,
			}),
		},
		{
			key: 'sub-interval',
			label: 'sub-interval',
			totals: makeTotals({
				occurrences: 5,
				successCount: 3,
				failureCount: 2,
				totalDurationMs: 250_000,
				totalInputTokens: 2_500,
				totalOutputTokens: 1_500,
			}),
		},
	],
	chains: [
		{
			rootId: 'root-1',
			rootSubscriptionName: 'sub-watch-files',
			nodes: [
				{
					eventId: 'evt-1',
					parentEventId: null,
					subscriptionName: 'sub-watch-files',
					pipelineId: 'pipeline-alpha',
					agentType: 'claude-code',
					status: 'completed',
					startedAtMs: 1_700_000_000_000,
					durationMs: 60_000,
					inputTokens: 100,
					outputTokens: 50,
					costUsd: 0.01,
				},
				{
					eventId: 'evt-2',
					parentEventId: 'evt-1',
					subscriptionName: 'sub-followup',
					pipelineId: 'pipeline-alpha',
					agentType: 'claude-code',
					status: 'completed',
					startedAtMs: 1_700_000_060_000,
					durationMs: 30_000,
					inputTokens: 80,
					outputTokens: 40,
					costUsd: 0.005,
				},
				{
					eventId: 'evt-3',
					parentEventId: 'evt-2',
					subscriptionName: 'sub-leaf',
					pipelineId: 'pipeline-alpha',
					agentType: 'codex',
					status: 'completed',
					startedAtMs: 1_700_000_090_000,
					durationMs: 15_000,
					inputTokens: 40,
					outputTokens: 20,
					costUsd: 0.002,
				},
			],
			totals: makeTotals({
				occurrences: 3,
				successCount: 3,
				failureCount: 0,
				totalDurationMs: 105_000,
				totalInputTokens: 220,
				totalOutputTokens: 110,
				totalCostUsd: 0.017,
			}),
		},
	],
	timeSeries: [
		{
			bucketStartMs: 1_700_000_000_000,
			occurrences: 4,
			successCount: 3,
			failureCount: 1,
			inputTokens: 1_500,
			outputTokens: 1_000,
		},
		{
			bucketStartMs: 1_700_003_600_000,
			occurrences: 8,
			successCount: 6,
			failureCount: 2,
			inputTokens: 3_500,
			outputTokens: 2_000,
		},
	],
	byTriggerType: [
		{
			key: 'file.changed',
			label: 'File Change',
			totals: makeTotals({ occurrences: 7, successCount: 6, failureCount: 1 }),
		},
		{
			key: 'time.heartbeat',
			label: 'Heartbeat',
			totals: makeTotals({ occurrences: 5, successCount: 3, failureCount: 2 }),
		},
	],
	triggerTypeOptions: [
		{ key: 'file.changed', label: 'File Change', occurrences: 7 },
		{ key: 'time.heartbeat', label: 'Heartbeat', occurrences: 5 },
	],
	excludedTriggerTypes: [],
	byHourOfDay: emptyHourBuckets.map((b, i) => {
		// Seed a couple of busy hours so the chart actually paints - others
		// stay zero. Hour 9 has a failure to exercise the warning color path.
		if (i === 9) return { hour: 9, occurrences: 7, successCount: 5, failureCount: 2 };
		if (i === 14) return { hour: 14, occurrences: 5, successCount: 5, failureCount: 0 };
		return b;
	}),
	bucketSizeMs: 3_600_000,
	coverageWarnings: [],
};

const aggregationWithWarnings: CueStatsAggregation = {
	...populatedAggregation,
	coverageWarnings: [
		'factory-droid sessions have no token data',
		'opencode sessions are missing cost data',
	],
};

const mockGetAggregation = vi.fn();

beforeEach(() => {
	mockGetAggregation.mockReset();
	// The exclusion set persists to localStorage, so a test that toggles a chip
	// would otherwise leak its filter into the next test. jsdom in this repo can
	// be Storage-less, hence the guard.
	window.localStorage?.clear();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...((window as unknown as { maestro: Record<string, unknown> }).maestro ?? {}),
		cueStats: {
			getAggregation: mockGetAggregation,
		},
	};
	useSettingsStore.setState({ cueHistoryRetentionDays: 14 });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('CueStats', () => {
	describe('Loading state', () => {
		it('renders the skeleton while the aggregation is being fetched', async () => {
			let resolve: (v: CueStatsAggregation) => void = () => {};
			mockGetAggregation.mockImplementation(
				() =>
					new Promise<CueStatsAggregation>((r) => {
						resolve = r;
					})
			);

			render(<CueStats timeRange="week" theme={theme} />);

			expect(screen.getByTestId('cue-stats-skeleton')).toBeInTheDocument();

			// Drain the pending promise so the act() warning does not fire when
			// React processes the eventual setState during teardown.
			await act(async () => {
				resolve(emptyAggregation);
			});
		});
	});

	describe('Empty state', () => {
		it('renders the EmptyState when aggregation has zero occurrences', async () => {
			mockGetAggregation.mockResolvedValue(emptyAggregation);

			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-empty')).toBeInTheDocument();
			});

			expect(
				screen.getByText(
					'No Cue runs in this time range. Trigger a subscription to populate stats.'
				)
			).toBeInTheDocument();
		});
	});

	describe('Populated state', () => {
		beforeEach(() => {
			mockGetAggregation.mockResolvedValue(populatedAggregation);
		});

		it('renders the populated dashboard root', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats')).toBeInTheDocument();
			});
		});

		it('renders the summary cards row with totals', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-summary-cards')).toBeInTheDocument();
			});

			const summary = screen.getByTestId('cue-stats-summary-cards');

			// One StatCard per figure: label, value, caption.
			const card = (label: string) =>
				within(summary).getByText(label).parentElement!.parentElement as HTMLElement;
			expect(card('Runs')).toHaveTextContent(/^Runs12/);
			expect(card('Success Rate')).toHaveTextContent(/75%/);
			// Run time counts completed runs, and its average divides by them.
			expect(card('Run Time')).toHaveTextContent(/10m 0s/);
			expect(card('Run Time')).toHaveTextContent(/1m 15s avg over 8 completed/);
			expect(card('Total Tokens')).toHaveTextContent(/8\.0K/);
		});

		it('renders trend sparklines on the occurrences, success rate, and tokens cards', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-summary-cards')).toBeInTheDocument();
			});

			const summary = screen.getByTestId('cue-stats-summary-cards');
			// Three of the four cards (Runs, Success Rate, Total Tokens) carry a
			// sparkline; Run Time has none because buckets don't track duration.
			expect(within(summary).getAllByTestId('sparkline')).toHaveLength(3);
		});

		it('renders the time-series chart', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-timeseries')).toBeInTheDocument();
			});

			expect(screen.getByText('Runs & Tokens Over Time')).toBeInTheDocument();
		});

		it('renders the By Pipeline table with the pipelines', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-pipeline-table')).toBeInTheDocument();
			});

			expect(screen.getByText('By Pipeline')).toBeInTheDocument();
			expect(screen.getByText('pipeline-alpha')).toBeInTheDocument();
			expect(screen.getByText('pipeline-beta')).toBeInTheDocument();
		});

		it('labels the token rollup by provider, since it is keyed by provider', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-agent-chart')).toBeInTheDocument();
			});

			expect(screen.getByText('Tokens by Provider')).toBeInTheDocument();
		});

		it('does not render the failure spotlight section', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats')).toBeInTheDocument();
			});

			expect(screen.queryByTestId('cue-stats-failure-spotlight')).not.toBeInTheDocument();
			expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
		});

		it('renders the slowest-runs leaderboard sorted by duration', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-slowest-runs')).toBeInTheDocument();
			});

			const slow = screen.getByTestId('cue-stats-slowest-runs');
			const runs = within(slow).getAllByTestId('cue-stats-slow-run');
			// Main's ranked list, any terminal status, with a Status column.
			expect(runs).toHaveLength(3);
			expect(within(runs[0]).getByText('sub-watch-files')).toBeInTheDocument();
			expect(within(runs[0]).getByText('1m 0s')).toBeInTheDocument();
			expect(within(runs[1]).getByText('sub-timeout')).toBeInTheDocument();
			expect(within(runs[1]).getByText('timeout')).toBeInTheDocument();
			expect(within(runs[1]).getByText('Codex')).toBeInTheDocument();
			expect(within(runs[2]).getByText('sub-leaf')).toBeInTheDocument();
		});

		it('re-sorts the slowest runs from a column header', async () => {
			render(<CueStats timeRange="week" theme={theme} />);
			await screen.findByTestId('cue-stats-slowest-runs');

			// SortableTh puts the test id on the <th>; the click target is its button.
			fireEvent.click(
				within(screen.getByTestId('cue-stats-slow-sort-subscription')).getByRole('button')
			);
			const runs = screen.getAllByTestId('cue-stats-slow-run');
			expect(within(runs[0]).getByText('sub-leaf')).toBeInTheDocument();
			expect(within(runs[2]).getByText('sub-watch-files')).toBeInTheDocument();
		});

		it('makes the hour-of-day chart one keyboard stop with a tooltip per hour', async () => {
			render(<CueStats timeRange="week" theme={theme} />);
			const hourChart = await screen.findByTestId('cue-stats-hour-of-day');
			const svg = hourChart.querySelector('svg')!;
			expect(svg).toHaveAttribute('tabindex', '0');

			fireEvent.keyDown(svg, { key: 'Home' });
			for (let i = 0; i < 9; i++) fireEvent.keyDown(svg, { key: 'ArrowRight' });
			expect(await screen.findByTestId('cue-stats-hour-tooltip')).toHaveTextContent(
				'9 AM: 7 runs, 2 failed'
			);
		});

		it('renders the trigger-type breakdown with one row per trigger', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-trigger-types')).toBeInTheDocument();
			});

			const triggers = screen.getByTestId('cue-stats-trigger-types');
			const rows = within(triggers).getAllByTestId('cue-stats-trigger-row');
			expect(rows).toHaveLength(2);
			// File Change has 7 occurrences vs Heartbeat's 5, so it leads.
			expect(within(rows[0]).getByText('File Change')).toBeInTheDocument();
			expect(within(rows[1]).getByText('Heartbeat')).toBeInTheDocument();
		});

		it('renders 24 bars on the hour-of-day chart', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-hour-of-day')).toBeInTheDocument();
			});

			const bars = screen.getAllByTestId('cue-stats-hour-bar');
			expect(bars).toHaveLength(24);
			// Hours 0..23 each have a corresponding bar.
			const hours = bars
				.map((b) => b.getAttribute('data-hour'))
				.sort((a, b) => Number(a) - Number(b));
			expect(hours).toEqual(Array.from({ length: 24 }, (_, i) => String(i)));
		});

		it('does not render the dropped By Subscription / Chains sections', async () => {
			// The per-subscription table and per-chain list were removed from the
			// Cue tab; the underlying aggregation still includes them, so this
			// guards against a regression that re-renders either section.
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats')).toBeInTheDocument();
			});

			expect(screen.queryByTestId('cue-stats-subscription-table')).not.toBeInTheDocument();
			expect(screen.queryByTestId('cue-stats-chains')).not.toBeInTheDocument();
		});

		it('does not render the coverage warnings banner when there are no warnings', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats')).toBeInTheDocument();
			});

			expect(screen.queryByTestId('cue-stats-coverage-warnings')).not.toBeInTheDocument();
		});
	});

	describe('Coverage warnings', () => {
		// The coverage-warning banner was removed from the Cue tab - the
		// upstream payload still includes the warnings, but we no longer
		// surface them to users. Confirm the banner stays hidden even when
		// the aggregation contains warnings.
		it('does not render the coverage warnings banner even when warnings are present', async () => {
			mockGetAggregation.mockResolvedValue(aggregationWithWarnings);

			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats')).toBeInTheDocument();
			});

			expect(screen.queryByTestId('cue-stats-coverage-warnings')).not.toBeInTheDocument();
			expect(screen.queryByText('Coverage warnings')).not.toBeInTheDocument();
		});
	});

	describe('Trigger type filter', () => {
		beforeEach(() => {
			mockGetAggregation.mockResolvedValue(populatedAggregation);
		});

		it('renders a chip per trigger type with its unfiltered occurrence count', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-trigger-filter')).toBeInTheDocument();
			});

			const heartbeat = screen.getByTestId('cue-stats-trigger-chip-time.heartbeat');
			expect(within(heartbeat).getByText('Heartbeat')).toBeInTheDocument();
			expect(within(heartbeat).getByText('5')).toBeInTheDocument();
			expect(heartbeat).toHaveAttribute('data-excluded', 'false');
			expect(screen.getByTestId('cue-stats-trigger-chip-file.changed')).toBeInTheDocument();
		});

		it('refetches the aggregation without the trigger when a chip is toggled off', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-trigger-filter')).toBeInTheDocument();
			});
			expect(mockGetAggregation).toHaveBeenLastCalledWith('week', []);

			fireEvent.click(screen.getByTestId('cue-stats-trigger-chip-time.heartbeat'));

			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenLastCalledWith('week', ['time.heartbeat']);
			});
			expect(screen.getByTestId('cue-stats-trigger-chip-time.heartbeat')).toHaveAttribute(
				'data-excluded',
				'true'
			);
		});

		it('restores every trigger from the reset control', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-trigger-filter')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('cue-stats-trigger-chip-time.heartbeat'));
			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-trigger-filter-reset')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('cue-stats-trigger-filter-reset'));

			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenLastCalledWith('week', []);
			});
			expect(screen.queryByTestId('cue-stats-trigger-filter-reset')).not.toBeInTheDocument();
		});

		it('keeps the filter row visible when the filter empties the window', async () => {
			mockGetAggregation.mockResolvedValue({
				...emptyAggregation,
				triggerTypeOptions: [{ key: 'time.heartbeat', label: 'Heartbeat', occurrences: 5 }],
				excludedTriggerTypes: ['time.heartbeat'],
			});

			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-trigger-filter')).toBeInTheDocument();
			});
			expect(screen.getByText('No Cue activity')).toBeInTheDocument();
		});
	});

	describe('Error state', () => {
		it('renders an error with Retry, not "no Cue activity", when the read fails', async () => {
			mockGetAggregation.mockRejectedValueOnce(new Error('cue.db is locked'));
			render(<CueStats timeRange="week" theme={theme} />);

			expect(await screen.findByTestId('cue-stats-error')).toHaveTextContent(/cue\.db is locked/);
			expect(screen.queryByText('No Cue activity')).not.toBeInTheDocument();

			mockGetAggregation.mockResolvedValue(populatedAggregation);
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
			expect(await screen.findByTestId('cue-stats-summary-cards')).toBeInTheDocument();
		});
	});

	describe('Retention caption', () => {
		beforeEach(() => {
			mockGetAggregation.mockResolvedValue(populatedAggregation);
		});

		it('states the retention and warns when the range reaches past it', async () => {
			render(<CueStats timeRange="quarter" theme={theme} />);
			const note = await screen.findByTestId('cue-stats-retention');
			expect(note).toHaveAttribute('data-exceeds', 'true');
			expect(note).toHaveTextContent('only shows the last 14 days');
		});

		it('only states the retention when the range fits inside it', async () => {
			render(<CueStats timeRange="week" theme={theme} />);
			const note = await screen.findByTestId('cue-stats-retention');
			expect(note).toHaveAttribute('data-exceeds', 'false');
			expect(note).toHaveTextContent('Cue keeps 14 days of run history');
		});

		it('compares the range to the retention setting', () => {
			expect(rangeExceedsRetention('week', 14)).toBe(false);
			expect(rangeExceedsRetention('month', 14)).toBe(true);
			expect(rangeExceedsRetention('month', 30)).toBe(false);
			expect(rangeExceedsRetention('all', 365)).toBe(true);
		});
	});

	describe('Averages', () => {
		it('average run time divides by completed runs, not by every run', () => {
			expect(
				averageRunMs({ ...zeroTotals, occurrences: 10, totalDurationMs: 60_000, timedRunCount: 2 })
			).toBe(30_000);
			expect(averageRunMs({ ...zeroTotals, occurrences: 3 })).toBe(0);
		});
	});

	describe('Refresh', () => {
		it('refetches when the Cue engine reports activity', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let emit: (() => void) | undefined;
			vi.mocked(window.maestro.cue.onActivityUpdate).mockImplementation(((cb: () => void) => {
				emit = cb;
				return () => {};
			}) as never);
			mockGetAggregation.mockResolvedValue(populatedAggregation);

			render(<CueStats timeRange="week" theme={theme} />);
			await screen.findByTestId('cue-stats-summary-cards');
			const before = mockGetAggregation.mock.calls.length;

			act(() => emit?.());
			await act(async () => {
				vi.advanceTimersByTime(1_000);
			});
			await waitFor(() => expect(mockGetAggregation.mock.calls.length).toBe(before + 1));
			vi.useRealTimers();
		});
	});

	describe('Disabled state', () => {
		// Two cases: the bare sentinel (defensive - the main process *could*
		// surface it un-wrapped one day) and the Electron-wrapped form that
		// `ipcRenderer.invoke` actually produces in production. The wrapped
		// form is the one that previously slipped through equality checks.
		it.each([
			['bare sentinel', 'CueStatsDisabled'],
			[
				'Electron-wrapped IPC error',
				"Error invoking remote method 'cue-stats:get-aggregation': Error: CueStatsDisabled",
			],
		])('renders the friendly disabled note for the %s', async (_label, message) => {
			mockGetAggregation.mockRejectedValue(new Error(message));

			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-disabled')).toBeInTheDocument();
			});

			expect(screen.getByText('Cue stats are unavailable.')).toBeInTheDocument();
			// Defense-in-depth copy mentions both Encore features
			expect(screen.getByText(/Maestro Cue/)).toBeInTheDocument();
			expect(screen.getByText(/Usage Dashboard/)).toBeInTheDocument();
			// The retry-style ErrorNote must NOT have rendered.
			expect(screen.queryByTestId('cue-stats-error')).not.toBeInTheDocument();
		});
	});
});
