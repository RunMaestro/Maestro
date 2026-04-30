/**
 * Tests for CueStats component (Phase 04 — Cue Dashboard)
 *
 * Verifies:
 * - Loading skeleton renders before the IPC resolves
 * - Empty state renders when aggregation has zero occurrences
 * - Populated state renders summary cards, time-series, pipeline table,
 *   agent chart, subscription table, and chain list
 * - Coverage warnings banner renders when warnings are present
 * - 'CueStatsDisabled' IPC error renders the friendly disabled note
 * - Chains with multiple nodes render with correct indentation depth
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const emptyAggregation: CueStatsAggregation = {
	timeRange: 'week',
	windowStartMs: 0,
	windowEndMs: 0,
	totals: zeroTotals,
	byPipeline: [],
	byAgent: [],
	bySubscription: [],
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

		it('renders the By Subscription table with the subscriptions', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-subscription-table')).toBeInTheDocument();
			});

			// "sub-watch-files" also appears as the root subscription name in the
			// chains list, so scope the lookup to the subscription table.
			const subTable = screen.getByTestId('cue-stats-subscription-table');
			expect(within(subTable).getByText('By Subscription')).toBeInTheDocument();
			expect(within(subTable).getByText('sub-watch-files')).toBeInTheDocument();
			expect(within(subTable).getByText('sub-interval')).toBeInTheDocument();
		});

		it('renders the chains list with one chain entry', async () => {
			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-chains')).toBeInTheDocument();
			});

			const chains = screen.getAllByTestId('cue-stats-chain');
			expect(chains).toHaveLength(1);
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

	describe('Chain rendering', () => {
		it('renders one row per node and respects parent-child indentation depth', async () => {
			mockGetAggregation.mockResolvedValue(populatedAggregation);

			render(<CueStats timeRange="week" theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-chains')).toBeInTheDocument();
			});

			// Expand the chain so its body is rendered
			const chainHeader = screen.getByRole('button', { name: /sub-watch-files/i });
			await act(async () => {
				fireEvent.click(chainHeader);
			});

			await waitFor(() => {
				expect(screen.getByTestId('cue-stats-chain-body')).toBeInTheDocument();
			});

			const nodeRows = screen.getAllByTestId('cue-stats-chain-node');
			expect(nodeRows).toHaveLength(3);

			// Verify the depth attribute reflects the parent chain (0 → 1 → 2)
			const depths = nodeRows.map((row) => row.getAttribute('data-depth'));
			expect(depths).toEqual(['0', '1', '2']);

			// Verify the inline padding scales with depth (12 + depth * 16)
			expect(nodeRows[0]).toHaveStyle({ paddingLeft: '12px' });
			expect(nodeRows[1]).toHaveStyle({ paddingLeft: '28px' });
			expect(nodeRows[2]).toHaveStyle({ paddingLeft: '44px' });
		});
	});
});
