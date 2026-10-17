/**
 * ModelUsageStats - the body of the Usage Dashboard's Models tab.
 *
 * Answers one question for the selected range: what did every model other than
 * a provider's own do? The Maestro model server, each server the user runs
 * (Ollama, LM Studio, a cloud endpoint), the System One engines, and, beside
 * them for comparison, the providers' own cloud.
 *
 * Self-contained like the Cue and Resilience panels: it loads its own record
 * (`useModelUsage`, the same `readModelUsage()` that `maestro-cli stats models`
 * prints) and takes only `{ timeRange, theme, colorBlindMode }`. That is also
 * why it renders when the stats aggregation holds no query at all: a tab named
 * by a local model is model usage with no agent turn recorded.
 */

import { memo, useCallback, useMemo } from 'react';
import { isModelUsageEmpty } from '../../../../shared/local-models/model-usage';
import { MODELS_SETTINGS_LOCATION } from '../../../../shared/local-models/settings-location';
import type { StatsTimeRange } from '../../../../shared/stats-types';
import { useModelUsage } from '../../../hooks/stats/useModelUsage';
import { getModalActions } from '../../../stores/modalStore';
import type { Theme } from '../../../types';
import { ChartErrorBoundary } from '../ChartErrorBoundary';
import {
	AgentComparisonChartSkeleton,
	DurationTrendsChartSkeleton,
	SummaryCardsSkeleton,
} from '../ChartSkeletons';
import { EmptyState } from '../EmptyState';
import { PanelErrorNote } from '../PanelErrorNote';
import { buildModelsSummary } from '../footerSummary';
import { usePublishFooterSummary } from '../useFooterSummary';
import {
	ModelLatencySection,
	ModelSourcesTable,
	ModelSummaryCards,
	ModelTasksTable,
	ProxySavingsSection,
	RunOnAgentTiles,
	SystemOneSection,
} from './ModelUsageSections';
import { summarizeModelUsage } from './modelUsageView';

export interface ModelUsageStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

const ModelUsageSkeleton = memo(function ModelUsageSkeleton({ theme }: { theme: Theme }) {
	return (
		<div className="space-y-6" data-testid="model-usage-skeleton">
			<SummaryCardsSkeleton theme={theme} columns={4} />
			<AgentComparisonChartSkeleton theme={theme} />
			<DurationTrendsChartSkeleton theme={theme} />
		</div>
	);
});

/** Step between the staggered entrances of the tab's blocks, as on the other tabs. */
const SECTION_STAGGER_MS = 50;

export const ModelUsageStats = memo(function ModelUsageStats({
	timeRange,
	theme,
	colorBlindMode = false,
}: ModelUsageStatsProps) {
	const { usage, loading, error, reload } = useModelUsage(timeRange);

	// Settings is a destination surface, so opening it hands the window over
	// from the dashboard: the user lands on Models, not on two stacked modals.
	const openModelsSettings = useCallback(() => getModalActions().openSettings('models'), []);

	const footerSummary = useMemo(() => {
		if (!usage) return null;
		const summary = summarizeModelUsage(usage);
		return buildModelsSummary({
			requests: summary.requests,
			onDeviceShare: summary.onDeviceShare,
			errors: summary.errors,
			decisions: summary.decisions,
		});
	}, [usage]);
	// Published above the loading, error and empty returns: a hook cannot sit
	// behind an early return, and a range that just went empty is the one that
	// must clear its stale footer line.
	usePublishFooterSummary('models', footerSummary);

	if (loading && !usage) {
		return <ModelUsageSkeleton theme={theme} />;
	}

	if (error) {
		return (
			<PanelErrorNote
				theme={theme}
				title="Failed to load model usage"
				message={error}
				onRetry={reload}
				testId="model-usage-error"
			/>
		);
	}

	if (!usage || isModelUsageEmpty(usage)) {
		return (
			<EmptyState
				theme={theme}
				title="No model usage in this range"
				message={`This tab fills in when work runs on a model other than a provider's own: a housekeeping task on a local model, an agent with a Run on target, a System One decision, or a request through the token proxy. Set them up in ${MODELS_SETTINGS_LOCATION}.`}
				action={{ label: `Open ${MODELS_SETTINGS_LOCATION}`, onClick: openModelsSettings }}
			/>
		);
	}

	const sections = [
		{ name: 'Model Usage Summary', node: <ModelSummaryCards theme={theme} usage={usage} /> },
		{ name: 'Model Sources', node: <ModelSourcesTable theme={theme} sources={usage.sources} /> },
		{
			name: 'Latency by Source',
			node: <ModelLatencySection theme={theme} sources={usage.sources} />,
		},
		{ name: 'Model Tasks', node: <ModelTasksTable theme={theme} tasks={usage.byTask} /> },
		{ name: 'Run On Agents', node: <RunOnAgentTiles theme={theme} agents={usage.byAgent} /> },
		{
			name: 'System One',
			node: (
				<SystemOneSection
					theme={theme}
					systemOne={usage.systemOne}
					colorBlindMode={colorBlindMode}
				/>
			),
		},
		{
			name: 'Token Proxy Savings',
			node: <ProxySavingsSection theme={theme} proxy={usage.proxy} />,
		},
	];

	return (
		<div className="space-y-6" data-testid="model-usage-stats">
			{sections.map((section, index) => (
				<div
					key={section.name}
					className="dashboard-section-enter"
					style={{ animationDelay: `${index * SECTION_STAGGER_MS}ms` }}
				>
					<ChartErrorBoundary theme={theme} chartName={section.name}>
						{section.node}
					</ChartErrorBoundary>
				</div>
			))}
		</div>
	);
});

export default ModelUsageStats;
