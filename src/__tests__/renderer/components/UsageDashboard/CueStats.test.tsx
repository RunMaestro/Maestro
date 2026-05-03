/**
 * Tests for CueStats component (Phase 04 — Cue Dashboard)
 *
 * Verifies:
 * - Loading skeleton renders before the IPC resolves
 * - Empty state renders when aggregation has zero occurrences
 * - Populated state renders summary cards, time-series, pipeline table, and
 *   agent chart (the per-subscription table and per-chain list were dropped
 *   because their content was redundant with the pipeline / agent breakdowns).
 * - Coverage warnings banner renders when warnings are present
 * - 'CueStatsDisabled' IPC error renders the friendly disabled note
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CueStats } from '../../../../renderer/components/UsageDashboard/CueStats';
import { THEMES } from '../../../../shared/themes';
import type { CueStatsAggregation, CueStatsTotals } from '../../../../shared/cue-stats-types';

const theme = THEMES['dracula'];

const zeroTotals: CueStatsTotals = {
	occurrences: 0,
	successCount: 0,
	failureCount: 0,
	totalDurationMs: 0,
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
	byPipeline: [],
	byAgent: [],
	bySubscription: [],
	byTriggerType: [],
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
		totalDurationMs: 600_000, // 10m
		totalInputTokens: 5_000,
		totalOutputTokens: 3_000,
		totalCostUsd: 0.42,
	}),
	byPipeline: [
		{
			key: 'pipeline-alpha',
			label: 'pipeline-alpha',
			totals: makeTotals({
				occurrences: 8,
				successCount: 7,
				failureCount: 1,
				totalDurationMs: 400_000,
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
	byHourOfDay: emptyHourBuckets.map((b, i) => {
		// Seed a couple of busy hours so the chart actually paints — others
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
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...((window as unknown as { maestro: Record<string, unknown> }).maestro ?? {}),
		cueStats: {
			getAggregation: mockGetAggregation,
		},
	};
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

			// Summary cards expose each metric as a role="group" with aria-label
			// "<label>: <value>" — match against those so we don't collide with
			// the same labels used as table column headers below.
			expect(within(summary).getByRole('group', { name: /Occurrences: 12/ })).toBeInTheDocument();
			expect(within(summary).getByRole('group', { name: /Success Rate: 75%/ })).toBeInTheDocument();
			expect(
				within(summary).getByRole('group', { name: /Total Duration: 10m 0s/ })
			).toBeInTheDocument();
			expect(
				within(summary).getByRole('group', { name: /Total Tokens: 8\.0K/ })
			).toBeInTheDocument();
		});

		it('renders trend sparklines on the occurrences, success rate, and tokens cards', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-summary-cards')).toBeInTheDocument();
			});

			const summary = screen.getByTestId('cue-stats-summary-cards');
			// Three of the four cards (Occurrences, Success Rate, Total Tokens) feed
			// the shared MetricCard a sparkline; Total Duration intentionally has
			// none because the per-bucket totals don't track duration.
			expect(within(summary).getAllByTestId('sparkline')).toHaveLength(3);
		});

		it('renders the time-series chart', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-timeseries')).toBeInTheDocument();
			});

			expect(screen.getByText('Occurrences & Tokens Over Time')).toBeInTheDocument();
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

		it('renders the By Agent chart with the agent rows', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-agent-chart')).toBeInTheDocument();
			});

			expect(screen.getByText('Tokens by Agent')).toBeInTheDocument();
		});

		it('renders the failure spotlight with rows for subscriptions that failed', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-failure-spotlight')).toBeInTheDocument();
			});

			const spotlight = screen.getByTestId('cue-stats-failure-spotlight');
			expect(within(spotlight).getByText('Needs attention')).toBeInTheDocument();
			// Both fixture subscriptions had failures (1 and 2) so both should appear,
			// with the worse one (2 failures) ranked first.
			const rows = within(spotlight).getAllByTestId('cue-stats-failure-row');
			expect(rows).toHaveLength(2);
			expect(within(rows[0]).getByText('sub-interval')).toBeInTheDocument();
			expect(within(rows[1]).getByText('sub-watch-files')).toBeInTheDocument();
		});

		it('renders the failure spotlight in its all-clean state when nothing failed', async () => {
			mockGetAggregation.mockResolvedValue({
				...populatedAggregation,
				bySubscription: populatedAggregation.bySubscription.map((row) => ({
					...row,
					totals: { ...row.totals, failureCount: 0, successCount: row.totals.occurrences },
				})),
			});

			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-failure-spotlight')).toBeInTheDocument();
			});

			expect(screen.getByText('No failures')).toBeInTheDocument();
			expect(screen.queryByTestId('cue-stats-failure-row')).not.toBeInTheDocument();
		});

		it('renders the slowest-runs leaderboard sorted by duration', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-slowest-runs')).toBeInTheDocument();
			});

			const slow = screen.getByTestId('cue-stats-slowest-runs');
			const runs = within(slow).getAllByTestId('cue-stats-slow-run');
			// Three nodes in the fixture chain; the 60s root should rank first.
			expect(runs).toHaveLength(3);
			expect(within(runs[0]).getByText('sub-watch-files')).toBeInTheDocument();
			expect(within(runs[0]).getByText('1m 0s')).toBeInTheDocument();
			expect(within(runs[1]).getByText('sub-followup')).toBeInTheDocument();
			expect(within(runs[2]).getByText('sub-leaf')).toBeInTheDocument();
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
		// The coverage-warning banner was removed from the Cue tab — the
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

	describe('Disabled state', () => {
		// Two cases: the bare sentinel (defensive — the main process *could*
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
