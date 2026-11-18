/**
 * Tests for OverviewView wiring: which props reach the Overview charts.
 *
 * - The Query Source donut gets the real per-source split and Cue gating
 * - The Cue retention caption is requested only when the range outruns Cue's
 *   history retention (a user setting)
 * - The location donut is drawn only when some query ran over SSH
 * - The percentile breakdown is labeled by provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { OverviewView } from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/views';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { DelegationTotals } from '../../../../shared/delegation';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

const captured = vi.hoisted(() => ({
	source: null as Record<string, unknown> | null,
	summary: null as Record<string, unknown> | null,
	percentiles: null as Record<string, unknown> | null,
}));

vi.mock('../../../../renderer/components/UsageDashboard/SourceDistributionChart', () => ({
	SourceDistributionChart: (props: Record<string, unknown>) => {
		captured.source = props;
		return <div>Source mock</div>;
	},
}));
vi.mock('../../../../renderer/components/UsageDashboard/SummaryCards', () => ({
	SummaryCards: (props: Record<string, unknown>) => {
		captured.summary = props;
		return <div>Summary mock</div>;
	},
}));
vi.mock('../../../../renderer/components/UsageDashboard/PercentilesCard', () => ({
	PercentilesCard: (props: Record<string, unknown>) => {
		captured.percentiles = props;
		return <div>Percentiles mock</div>;
	},
}));
vi.mock('../../../../renderer/components/UsageDashboard/LocationDistributionChart', () => ({
	LocationDistributionChart: () => <div>Location mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/YearInPixelsStrip', () => ({
	YearInPixelsStrip: () => null,
}));
vi.mock('../../../../renderer/components/UsageDashboard/TokenSpeedCards', () => ({
	OverviewTokenSpeed: () => null,
}));
vi.mock('../../../../renderer/components/UsageDashboard/DelegationScoreCard', () => ({
	DelegationScoreCard: () => null,
}));
vi.mock('../../../../renderer/components/UsageDashboard/AgentComparisonChart', () => ({
	AgentComparisonChart: () => null,
}));
vi.mock('../../../../renderer/components/UsageDashboard/ProviderTrendsChart', () => ({
	ProviderTrendsChart: () => null,
}));
vi.mock('../../../../renderer/components/UsageDashboard/RadialActivityChart', () => ({
	RadialActivityChart: () => null,
}));

const theme = THEMES['dracula'];

function makeData(days: number, remote = 0): StatsAggregation {
	return {
		byDay: Array.from({ length: days }, (_, i) => ({
			date: `2026-01-${String(i + 1).padStart(2, '0')}`,
			count: 1,
			duration: 1,
		})),
		byLocation: { local: 5, remote },
		queryDurationPercentiles: { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
		queryDurationPercentilesByAgent: {
			codex: { count: 1, min: 1, p50: 1, p75: 1, p90: 1, p95: 1, p99: 1, max: 1 },
		},
	} as unknown as StatsAggregation;
}

const delegation: DelegationTotals = {
	interactive: { count: 1, durationMs: 1 },
	autoRun: { count: 1, durationMs: 1 },
	cue: { count: 1, durationMs: 1 },
};

function renderOverview(data: StatsAggregation) {
	return render(
		<OverviewView
			data={data}
			timeRange="month"
			theme={theme}
			colorBlindMode={false}
			sessions={[] as Session[]}
			layout={{ chartGridCols: 2, summaryCardsCols: 3, autoRunStatsCols: 3 } as never}
			cueSourceTotals={{ occurrences: 3, totalDurationMs: 10, tokens: 777 }}
			delegationTotals={delegation}
			lifetimeDelegation={null}
			focusedSection={null}
			setSectionRef={() => () => {}}
			handleSectionKeyDown={() => {}}
		/>
	);
}

function setCue(enabled: boolean, retentionDays: number) {
	const state = useSettingsStore.getState();
	useSettingsStore.setState({
		encoreFeatures: { ...state.encoreFeatures, maestroCue: enabled },
		cueHistoryRetentionDays: retentionDays,
	});
}

beforeEach(() => {
	captured.source = null;
	captured.summary = null;
	captured.percentiles = null;
});

describe('OverviewView', () => {
	it('feeds the Query Source donut the real split and Cue tokens', () => {
		setCue(true, 14);
		renderOverview(makeData(7));
		expect(captured.source).toMatchObject({
			delegation,
			includeCue: true,
			cueTokens: 777,
			cueRetentionDays: null,
		});
		expect(captured.summary).toMatchObject({ delegation, cueRetentionDays: null });
	});

	it('asks for the Cue retention caption when the range outruns retention', () => {
		setCue(true, 14);
		renderOverview(makeData(30));
		expect(captured.source).toMatchObject({ cueRetentionDays: 14 });
		expect(captured.summary).toMatchObject({ cueRetentionDays: 14 });
	});

	it('reads the retention from the user setting', () => {
		setCue(true, 60);
		renderOverview(makeData(30));
		expect(captured.source).toMatchObject({ cueRetentionDays: null });
	});

	it('drops Cue from the donut and the caption when Cue is off', () => {
		setCue(false, 14);
		renderOverview(makeData(30));
		expect(captured.source).toMatchObject({ includeCue: false, cueRetentionDays: null });
	});

	it('draws the location donut only when a query ran over SSH', () => {
		setCue(false, 14);
		const { unmount } = renderOverview(makeData(7, 0));
		expect(screen.queryByText('Location mock')).not.toBeInTheDocument();
		expect(screen.queryByTestId('section-location-distribution')).not.toBeInTheDocument();
		expect(screen.getByTestId('section-source-distribution')).toBeInTheDocument();
		unmount();

		renderOverview(makeData(7, 2));
		expect(screen.getByText('Location mock')).toBeInTheDocument();
		expect(screen.getByTestId('section-location-distribution')).toBeInTheDocument();
	});

	it('labels the percentile breakdown by provider display name', () => {
		renderOverview(makeData(7));
		expect(captured.percentiles).toMatchObject({
			breakdownLabel: 'By Provider',
			breakdown: [{ label: 'Codex' }],
		});
	});
});
